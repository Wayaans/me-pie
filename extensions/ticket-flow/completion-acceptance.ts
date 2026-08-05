import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Result } from "effect";
import type { CompletionRecord, CompletionStrategy, ProgressionCheckpoint, WorkerReport, WorkflowRun, WorkItem } from "./domain.ts";
import { applyCompletionStrategy, type CompletionApplicationResult } from "./completion.ts";
import { canonicalCommitIds, commitCompletionMutation, gitHead, mergeAcceptedCommitIds, validateAcceptedCommitHistory, validateAcceptedCommitIds, validateAttemptCommitIds, assertGitReadyForAudit, type CompletionCommitResult, type GitCommandRunner } from "./git.ts";
import { deterministicJson } from "./state-store.ts";
import { persistAcceptedReport, readLatestReportAttempt, readReportAttempt, safeReportItemId, validateWorkerReport, type WorkerReportAttempt as StoredWorkerReportAttempt } from "./worker/report.ts";
import type { WorkflowPaths } from "./paths.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { transitionRun, transitionWorkItem } from "./state-machine.ts";
import { validateAuditReport } from "./audit.ts";

export interface AcceptedCompletionInput {
	readonly projectPath: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly workItem: WorkItem;
	readonly comment: string;
	readonly completedAt: string;
	readonly strategy: CompletionStrategy;
	readonly expectedParentCommitIds?: readonly string[];
	readonly git?: GitCommandRunner;
	readonly signal?: AbortSignal;
}

export interface AcceptedCompletionResult {
	readonly mutation: CompletionApplicationResult;
	readonly commit: CompletionCommitResult;
}

export interface AuthenticatedCompletionInput {
	readonly run: WorkflowRun;
	readonly workItem: WorkItem;
	readonly completion: CompletionRecord;
	readonly paths: WorkflowPaths;
	readonly git?: GitCommandRunner;
}

/**
 * Revalidate the immutable report and history before any post-completion
 * progression. A status/completion pair loaded from plan.json is not trusted
 * on its own, including during recovery.
 */
export function validateAuthenticatedCompletion(input: AuthenticatedCompletionInput): Effect.Effect<StoredWorkerReportAttempt, Error> {
	return Effect.gen(function* () {
		const expectedAcceptedPath = path.join(input.paths.reportsDir, `${safeReportItemId(input.workItem.id)}-accepted.json`);
		if (path.resolve(input.completion.acceptedReportPath) !== path.resolve(expectedAcceptedPath)) {
			return yield* Effect.fail(new Error("Completion record does not point to the canonical immutable accepted report."));
		}
		const attempt = yield* readReportAttempt(input.paths, input.workItem.id, input.completion.acceptedAttempt);
		if (attempt.report.status !== "completed") return yield* Effect.fail(new Error("Authenticated completion requires a completed worker report."));
		if (attempt.runId !== input.run.id || attempt.workItemId !== input.workItem.id) return yield* Effect.fail(new Error("Accepted report identity does not match the workflow run and item."));
		if (attempt.requestedLaunchProfile.model !== input.workItem.launchProfile?.model || attempt.requestedLaunchProfile.thinking !== input.workItem.launchProfile?.thinking) return yield* Effect.fail(new Error("Accepted report launch profile does not match the planned item."));
		if (!input.completion.worker || !input.completion.requestedLaunchProfile) return yield* Effect.fail(new Error("Completion record lacks authenticated worker identity and requested profile."));
		if (input.completion.worker.runId !== input.run.id || input.completion.worker.workItemId !== input.workItem.id || input.completion.worker.provider !== attempt.actualLaunchProfile.provider || input.completion.worker.model !== attempt.actualLaunchProfile.model || input.completion.worker.thinking !== attempt.actualLaunchProfile.thinking) {
			return yield* Effect.fail(new Error("Completion worker identity does not match the authenticated report."));
		}
		if (input.completion.requestedLaunchProfile.model !== attempt.requestedLaunchProfile.model || input.completion.requestedLaunchProfile.thinking !== attempt.requestedLaunchProfile.thinking) return yield* Effect.fail(new Error("Completion requested profile does not match the immutable report."));
		const requirements = input.workItem.requirements.map((requirement, index) => ({ id: `requirement-${index + 1}`, requirement }));
		yield* Effect.try({ try: () => validateWorkerReport(attempt.report, requirements), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
		const acceptedValue = yield* Effect.tryPromise({
			try: async () => JSON.parse(await readFile(expectedAcceptedPath, "utf8")) as unknown,
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		});
		const expectedAccepted = { ...attempt, acceptedAt: input.completion.completedAt };
		if (deterministicJson(acceptedValue) !== deterministicJson(expectedAccepted)) return yield* Effect.fail(new Error("Accepted report content is not the immutable report recorded at acceptance."));
		const reportCommitIds = [...(attempt.report.commitIds ?? [])].map((commit) => commit.toLowerCase());
		const completionCommitIds = [...(input.completion.commitIds ?? [])].map((commit) => commit.toLowerCase());
		if (reportCommitIds.some((commit) => !completionCommitIds.includes(commit))) return yield* Effect.fail(new Error("Completion history does not include every commit claimed by the accepted report."));
		if (input.run.git === undefined) {
			if (completionCommitIds.length > 0) return yield* Effect.fail(new Error("A non-Git run cannot have completion commits."));
		} else {
			if (input.workItem.kind !== "audit" && reportCommitIds.length === 0) return yield* Effect.fail(new Error("A completed implementation/fix item requires authenticated report commits."));
			yield* Effect.tryPromise({
				try: (signal) => validateAcceptedCommitHistory(input.run.projectPath, input.run.git!, completionCommitIds, input.git ?? undefined, signal),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
		}
		return attempt;
	});
}

/**
 * Applies one authenticated completion strategy and, when it changed a Git
 * checkout, accepts only the exact mutation paths in a dedicated commit.
 * Controller persistence checkpoints surround this service call.
 */
export function applyAcceptedCompletion(input: AcceptedCompletionInput): Effect.Effect<AcceptedCompletionResult, Error> {
	return Effect.gen(function* () {
		const approvedPaths = [...new Set([
			...input.workItem.sourcePaths,
			...input.workItem.specificationPaths,
			...(input.workItem.completionTargets ?? []),
		])];
		const mutation = yield* applyCompletionStrategy({
			projectPath: input.projectPath,
			runId: input.runId,
			workItemId: input.workItemId,
			workItemTitle: input.workItem.title,
			comment: input.comment,
			completedAt: input.completedAt,
			strategy: input.strategy,
			allowedPaths: approvedPaths,
		}, undefined, input.signal);
		const commit = yield* Effect.tryPromise({
			try: (signal) => commitCompletionMutation({
				projectPath: input.projectPath,
				runId: input.runId,
				workItemId: input.workItemId,
				paths: mutation.paths,
				...(input.expectedParentCommitIds === undefined ? {} : { expectedParentCommitIds: input.expectedParentCommitIds }),
				...(input.git === undefined ? {} : { runner: input.git }),
				...(input.signal === undefined ? { signal } : { signal: input.signal }),
			}),
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		});
		return { mutation, commit };
	});
}

export interface CompletionCoordinatorState {
	readonly run: WorkflowRun;
	readonly paths: WorkflowPaths;
}

export type CompletionPersist = (
	next: WorkflowRun,
	eventType: string,
	data: unknown,
) => Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError>;

export interface CompletionCloseResult {
	readonly run: WorkflowRun;
}

export interface CompletionAcceptanceDependencies {
	readonly now: () => Date;
	readonly getState: () => CompletionCoordinatorState | undefined;
	readonly persist: CompletionPersist;
	readonly closeWorker: (workItemId: string, force: boolean, retainCompleted: boolean) => Effect.Effect<CompletionCloseResult, Error | PersistenceError | ValidationError>;
	readonly nextReadyWorkItem: () => WorkItem | undefined;
	readonly advanceAudit: (run: WorkflowRun, itemId: string, report: WorkerReport, reportPath: string) => Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError>;
	readonly scheduleAudit: (run: WorkflowRun, completedWorkItemId: string) => Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError>;
	readonly gitRunner?: GitCommandRunner;
}

function nonEmptyAcceptanceComment(value: string): string {
	if (!value.trim()) throw new Error("Acceptance comment must be non-empty.");
	return value.trim();
}

function requireCoordinatorState(dependencies: CompletionAcceptanceDependencies): CompletionCoordinatorState {
	const state = dependencies.getState();
	if (!state) throw new Error("No active Ticket Flow run.");
	return state;
}

export function continueAfterCompletedProgression(
	workItemId: string,
	deferAuditAdvance: boolean,
	dependencies: CompletionAcceptanceDependencies,
): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		let state = requireCoordinatorState(dependencies);
		let active = state.run;
		if (active.activeWorkItemId !== undefined && active.activeWorkItemId !== workItemId) return active;
		const preCloseItem = active.plan.workItems.find((candidate) => candidate.id === workItemId);
		if (preCloseItem?.status === "completed" && preCloseItem.completion) {
			yield* validateAuthenticatedCompletion({ run: active, workItem: preCloseItem, completion: preCloseItem.completion, paths: state.paths, ...(dependencies.gitRunner === undefined ? {} : { git: dependencies.gitRunner }) });
		}
		if (active.activeWorkItemId === workItemId) {
			if (!active.tmux) return yield* Effect.fail(new Error(`Completed work item ${workItemId} still has no persisted tmux handle.`));
			yield* dependencies.closeWorker(workItemId, false, true);
		}
		state = requireCoordinatorState(dependencies);
		active = state.run;
		const closedItem = active.plan.workItems.find((candidate) => candidate.id === workItemId);
		if (!closedItem?.completion || closedItem.status !== "completed") return yield* Effect.fail(new Error(`Completed progression for ${workItemId} has no authenticated terminal completion.`));
		const authenticatedCompletion = yield* validateAuthenticatedCompletion({ run: active, workItem: closedItem, completion: closedItem.completion, paths: state.paths, ...(dependencies.gitRunner === undefined ? {} : { git: dependencies.gitRunner }) });
		if (closedItem.kind === "audit") {
			if (deferAuditAdvance) {
				const updatedAt = dependencies.now().toISOString();
				return yield* dependencies.persist({ ...active, progression: { operation: "accept", stage: "audit-round-pending-record", workItemId, updatedAt }, updatedAt }, "audit-round-pending-record", { workItemId });
			}
			return yield* dependencies.advanceAudit(active, workItemId, authenticatedCompletion.report, closedItem.completion.acceptedReportPath);
		}
		// Acceptance never starts the next worker. It only records the explicit
		// delegation checkpoint, leaving workflow_delegate start to the caller.
		const incomplete = active.plan.workItems.filter((item) => item.kind !== "audit" && item.kind !== "fix" && item.status !== "completed");
		if (incomplete.length > 0) {
			const failedItems = incomplete.filter((item) => item.status === "failed");
			const nextReady = dependencies.nextReadyWorkItem();
			const preparedPlan = nextReady?.status === "planned"
				? { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === nextReady.id ? { ...candidate, status: "ready" as const } : candidate) }
			: active.plan;
			const preparedRun = preparedPlan === active.plan ? active : { ...active, plan: preparedPlan, updatedAt: dependencies.now().toISOString() };
			const phase = failedItems.length > 0
				? yield* transitionRun(active.phase, "failed")
				: active.phase === "paused" ? "paused" : yield* transitionRun(active.phase, "ready");
			const checkpoint: ProgressionCheckpoint = {
				operation: "accept",
				stage: failedItems.length > 0 ? "progression-failed" : "awaiting-explicit-delegation",
				workItemId,
				updatedAt: dependencies.now().toISOString(),
			};
			return yield* dependencies.persist({ ...preparedRun, phase, updatedAt: checkpoint.updatedAt, progression: checkpoint }, failedItems.length > 0 ? "progression-failed" : "awaiting-explicit-delegation", {
				completedWorkItemId: workItemId,
				incompleteWorkItemIds: incomplete.map((item) => item.id),
				failedWorkItemIds: failedItems.map((item) => item.id),
				...(nextReady === undefined ? {} : { nextWorkItemId: nextReady.id }),
			});
		}
		const { progression: _completedProgression, ...withoutProgression } = active;
		return yield* dependencies.scheduleAudit({ ...withoutProgression, updatedAt: dependencies.now().toISOString() }, workItemId);
	});
}

/** Authenticate a report, checkpoint its completion mutation, and progress it. */
export function acceptReport(
	workItemId: string,
	comment: string,
	signal: AbortSignal | undefined,
	dependencies: CompletionAcceptanceDependencies,
): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		let state = requireCoordinatorState(dependencies);
		let active = state.run;
		const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
		if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
		if (item.status === "completed" && item.completion) return yield* continueAfterCompletedProgression(workItemId, false, dependencies);
		if (item.status !== "report-review") return yield* Effect.fail(new Error(`Work item ${workItemId} is not in report-review.`));
		const acceptedComment = yield* Effect.try({ try: () => nonEmptyAcceptanceComment(comment), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
		const capturedAttempt = active.progression?.operation === "accept" && active.progression.workItemId === workItemId ? active.progression.reportAttempt : undefined;
		const attempt = capturedAttempt === undefined
			? yield* readLatestReportAttempt(state.paths, workItemId, signal)
			: yield* readReportAttempt(state.paths, workItemId, capturedAttempt, signal);
		if (!attempt) return yield* Effect.fail(new Error(`No worker report exists for ${workItemId}.`));
		if (attempt.report.status !== "completed") return yield* Effect.fail(new Error("Only a completed worker report can be accepted."));
		const requirements = item.requirements.map((requirement, index) => ({ id: `requirement-${index + 1}`, requirement }));
		yield* Effect.try({ try: () => validateWorkerReport(attempt.report, requirements), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
		let acceptedCommitIdsForItem: readonly string[] = attempt.report.commitIds ?? [];
		if (active.git === undefined && acceptedCommitIdsForItem.length > 0) return yield* Effect.fail(new Error("A report cannot claim Git commits when the run has no Git repository."));
		if (active.git !== undefined && item.kind !== "audit") {
			if (acceptedCommitIdsForItem.length === 0) return yield* Effect.fail(new Error("Implementation and fix reports must identify the commits that implement the active work item."));
			const completionRecovery = active.progression?.operation === "accept" && active.progression.workItemId === workItemId && ["completion-applying", "completion-applied", "completion-failed", "completion-committed", "worker-closing"].includes(active.progression.stage);
			acceptedCommitIdsForItem = yield* Effect.tryPromise({
				try: (commitSignal) => completionRecovery
					? validateAttemptCommitIds(active.projectPath, active.git!, acceptedCommitIdsForItem, dependencies.gitRunner, commitSignal)
					: validateAcceptedCommitIds(active.projectPath, active.git!, acceptedCommitIdsForItem, dependencies.gitRunner, commitSignal),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
		}
		if (item.kind === "audit") {
			if (active.git !== undefined) {
				acceptedCommitIdsForItem = yield* Effect.tryPromise({ try: (commitSignal) => canonicalCommitIds(active.projectPath, acceptedCommitIdsForItem, dependencies.gitRunner, commitSignal), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
				const accepted = [...(active.git.acceptedCommitIds ?? [])].map((commit) => commit.toLowerCase()).sort();
				const reported = [...acceptedCommitIdsForItem].sort();
				if (reported.length !== accepted.length || reported.some((commit, index) => commit !== accepted[index])) return yield* Effect.fail(new Error("Audit report commit IDs must exactly equal the persisted accepted commit set."));
				yield* Effect.tryPromise({ try: (commitSignal) => assertGitReadyForAudit(active.projectPath, active.git!, dependencies.gitRunner, commitSignal), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
			}
			yield* Effect.try({ try: () => validateAuditReport(attempt.report, item.requirements), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
		}
		const acceptingAt = dependencies.now().toISOString();
		const acceptingCheckpoint: ProgressionCheckpoint = { operation: "accept", stage: "accepting", workItemId, updatedAt: acceptingAt, reportAttempt: attempt.attempt, comment: acceptedComment };
		yield* dependencies.persist({ ...active, updatedAt: acceptingAt, progression: acceptingCheckpoint }, "report-accepting", { workItemId, reportAttempt: attempt.attempt });
		const completedAt = dependencies.now().toISOString();
		const acceptedReportPath = yield* persistAcceptedReport(state.paths, attempt, completedAt, signal);
		const completion: CompletionRecord = {
			acceptedAttempt: attempt.attempt,
			acceptedReportPath,
			...(acceptedCommitIdsForItem.length === 0 ? {} : { commitIds: acceptedCommitIdsForItem }),
			comment: acceptedComment,
			completedAt,
			strategy: item.completionStrategy ?? { type: "ledger-only" },
			...(active.worker === undefined ? {} : { worker: active.worker }),
			...(active.requestedLaunchProfile === undefined ? {} : { requestedLaunchProfile: active.requestedLaunchProfile }),
		};
		const acceptedCheckpoint: ProgressionCheckpoint = { operation: "accept", stage: "report-accepted", workItemId, updatedAt: completedAt, reportAttempt: attempt.attempt, comment: acceptedComment, completion };
		state = requireCoordinatorState(dependencies);
		yield* dependencies.persist({ ...state.run, updatedAt: completedAt, progression: acceptedCheckpoint }, "report-accepted", { workItemId, reportAttempt: attempt.attempt, acceptedReportPath, comment: acceptedComment });
		const withCompletion: WorkflowRun = {
			...requireCoordinatorState(dependencies).run,
			updatedAt: dependencies.now().toISOString(),
			progression: { ...acceptedCheckpoint, stage: "completion-recorded", updatedAt: dependencies.now().toISOString() },
			plan: { ...requireCoordinatorState(dependencies).run.plan, workItems: requireCoordinatorState(dependencies).run.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, completion } : candidate) },
		};
		yield* dependencies.persist(withCompletion, "completion-recorded", { workItemId, reportAttempt: attempt.attempt });
		const applying: WorkflowRun = { ...requireCoordinatorState(dependencies).run, updatedAt: dependencies.now().toISOString(), progression: { ...acceptedCheckpoint, stage: "completion-applying", updatedAt: dependencies.now().toISOString() } };
		yield* dependencies.persist(applying, "completion-applying", { workItemId, strategy: completion.strategy.type });
		const applied = yield* Effect.result(applyAcceptedCompletion({
			projectPath: active.projectPath,
			runId: active.id,
			workItemId,
			workItem: item,
			comment: acceptedComment,
			completedAt,
			strategy: completion.strategy,
			...(acceptedCommitIdsForItem.length === 0 ? {} : { expectedParentCommitIds: acceptedCommitIdsForItem }),
			...(dependencies.gitRunner === undefined ? {} : { git: dependencies.gitRunner }),
			...(signal === undefined ? {} : { signal }),
		}));
		if (Result.isFailure(applied)) {
			const failed: WorkflowRun = { ...requireCoordinatorState(dependencies).run, updatedAt: dependencies.now().toISOString(), progression: { ...acceptedCheckpoint, stage: "completion-failed", updatedAt: dependencies.now().toISOString() } };
			yield* dependencies.persist(failed, "completion-failed", { workItemId, message: applied.failure instanceof Error ? applied.failure.message : String(applied.failure) });
			return yield* Effect.fail(applied.failure instanceof Error ? applied.failure : new Error(String(applied.failure)));
		}
		const completionResult = applied.success.mutation;
		yield* dependencies.persist({ ...requireCoordinatorState(dependencies).run, updatedAt: dependencies.now().toISOString(), progression: { ...acceptedCheckpoint, stage: "completion-applied", updatedAt: dependencies.now().toISOString() } }, "completion-applied", { workItemId, changed: completionResult.changed, paths: completionResult.paths });
		const completionCommitId = applied.success.commit.commitId;
		const completionCommitIds = completionCommitId === undefined ? acceptedCommitIdsForItem : [...new Set([...acceptedCommitIdsForItem, completionCommitId])];
		const completionWithCommit: CompletionRecord = completionCommitId === undefined ? completion : { ...completion, commitIds: completionCommitIds };
		const current = requireCoordinatorState(dependencies).run;
		let currentGit = current.git;
		if (currentGit !== undefined && item.kind !== "audit") {
			const pendingCommitIds = completionCommitIds.filter((commit) => !currentGit!.acceptedCommitIds.includes(commit));
			if (pendingCommitIds.length > 0) {
				const currentHeadResult = yield* Effect.result(Effect.tryPromise({ try: (headSignal) => gitHead(current.projectPath, dependencies.gitRunner, headSignal), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) }));
				const currentHead = Result.isSuccess(currentHeadResult) ? currentHeadResult.success : undefined;
				currentGit = mergeAcceptedCommitIds(currentGit, pendingCommitIds, currentHead);
			}
		}
		const committedCheckpoint: ProgressionCheckpoint = { ...acceptedCheckpoint, stage: "completion-committed", completion: completionWithCommit, updatedAt: dependencies.now().toISOString() };
		const committedRun: WorkflowRun = { ...current, ...(currentGit === undefined ? {} : { git: currentGit }), updatedAt: committedCheckpoint.updatedAt, progression: committedCheckpoint, plan: { ...current.plan, workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, completion: completionWithCommit } : candidate) } };
		yield* dependencies.persist(committedRun, "completion-committed", { workItemId, commitIds: completionCommitIds, ...(completionCommitId === undefined ? {} : { completionCommitId }) });
		const committedState = requireCoordinatorState(dependencies).run;
		const committedItem = committedState.plan.workItems.find((candidate) => candidate.id === workItemId);
		if (!committedItem?.completion) return yield* Effect.fail(new Error("Completion checkpoint lost its authenticated record."));
		yield* validateAuthenticatedCompletion({ run: committedState, workItem: committedItem, completion: committedItem.completion, paths: requireCoordinatorState(dependencies).paths, ...(dependencies.gitRunner === undefined ? {} : { git: dependencies.gitRunner }) });
		const completedStatus = yield* transitionWorkItem(committedItem.status, "completed");
		const completedItemRun: WorkflowRun = { ...requireCoordinatorState(dependencies).run, updatedAt: dependencies.now().toISOString(), progression: { ...committedCheckpoint, stage: "worker-closing", updatedAt: dependencies.now().toISOString() }, plan: { ...requireCoordinatorState(dependencies).run.plan, workItems: requireCoordinatorState(dependencies).run.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: completedStatus, completion: completionWithCommit } : candidate) } };
		yield* dependencies.persist(completedItemRun, "work-item-completed", { workItemId, reportAttempt: attempt.attempt, commitIds: completionCommitIds });
		const progressed = yield* continueAfterCompletedProgression(workItemId, item.kind === "audit", dependencies);
		return item.kind === "audit" ? yield* dependencies.advanceAudit(progressed, workItemId, attempt.report, acceptedReportPath) : progressed;
	});
}
