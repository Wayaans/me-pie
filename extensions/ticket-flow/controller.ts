import { Effect, Exit, Result, Scope, Semaphore } from "effect";
import type {
	PlanChange,
	PlanningDetails,
	PiLaunchProfile,
	ProgressionCheckpoint,
	WorkerReport,
	WorkflowBlocker,
	WorkflowPlan,
	UserResolution,
	WorkflowRun,
	WorkItem,
} from "./domain.ts";
import { createRunId } from "./domain.ts";
import { replayEvents } from "./event-store.ts";
import { acquireProjectLock, recoverProjectLock, type ProjectLock } from "./lock.ts";
import { pathsForProject, type WorkflowPaths } from "./paths.ts";
import { normalizePlan, transitionRun, transitionWorkItem, validatePlan } from "./state-machine.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { loadRun } from "./state-store.ts";
import { persistWorkflowTransaction } from "./persistence.ts";
import { TmuxController } from "./tmux/controller.ts";
import { readWorkflowToken, removeWorkflowToken, workflowSocketPath, writeWorkflowToken } from "./protocol/runtime.ts";
import { ProtocolServer, type ProtocolRejection } from "./protocol/server.ts";
import type { WorkflowProtocolEvent } from "./protocol/messages.ts";
import { ingestProtocolEvent, acknowledgeProtocolCommand as acknowledgeProtocolCommandIngestion, rejectProtocolWorker as rejectProtocolWorkerIngestion, type ProtocolIngestionDependencies } from "./protocol/ingestion.ts";
import { makeAuthoritativeWorkerContext, requirementId } from "./worker/context.ts";
import { readLatestReportAttempt, readReportAttempt } from "./worker/report.ts";
import { acceptReport as acceptReportProgression, continueAfterCompletedProgression, type CompletionAcceptanceDependencies } from "./completion-acceptance.ts";
import { discoverUnfinishedRuns, reconcileRecovery, type RecoveryDiscovery, type RecoveryReconciliation } from "./recovery.ts";
import { advanceAuditAfterAcceptance as advanceAuditProgression, auditProfile, scheduleAuditAfterAcceptance, type AuditProgressionDependencies } from "./audit.ts";
import { gitHead, gitPreflight, gitStateFromPreflight, type GitCommandRunner } from "./git.ts";
import { questionIdFor, reconcilePlanningQuestions } from "./planning.ts";

export const WORKFLOW_TOOL_NAMES = ["workflow_plan", "workflow_delegate"] as const;

const READ_ONLY_TOOL_NAMES = new Set([
	"read", "grep", "find", "ls", "rg", "fd", "find_docs", "github_get", "github_comments",
	"web_search", "source_check", "fetch_content", "get_search_content", "ask_me",
]);
const MAX_STATUS_BYTES = 50 * 1024;
const MAX_STATUS_LINES = 2_000;
export const DELEGATION_START_TIMEOUT_MS = 30_000;

export interface WorkflowControllerPi {
	readonly getActiveTools: () => string[];
	readonly setActiveTools: (names: string[]) => void;
}

export type WorkflowProgressUpdate = (message: string) => void;

export interface StartRunInput {
	readonly cwd: string;
	readonly prompt: string;
	readonly sessionId?: string;
	readonly agentDir?: string;
	readonly auditProfile?: PiLaunchProfile;
}

export interface RecoverRunInput {
	readonly cwd: string;
	readonly sessionId?: string;
	readonly agentDir?: string;
	readonly runId?: string;
	readonly allowAmbiguousTakeover?: boolean;
}

export interface BlockReportOptions {
	readonly message?: string;
	readonly questions?: readonly string[];
}

interface ActiveRun {
	run: WorkflowRun;
	readonly paths: WorkflowPaths;
	readonly lock: ProjectLock;
	readonly scope: Scope.Closeable;
	workerToken?: string;
	protocol?: ProtocolServer;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name) => right.includes(name));
}

function dependenciesCompleted(run: WorkflowRun, item: WorkItem): boolean {
	return item.dependsOn.every((dependencyId) => run.plan.workItems.find((candidate) => candidate.id === dependencyId)?.status === "completed");
}

function isDelegableStatus(status: WorkItem["status"]): boolean {
	return status === "planned" || status === "ready" || status === "interrupted";
}

function nonEmptyText(value: string | undefined, field: string): string {
	if (value === undefined || !value.trim()) throw new Error(`${field} must be non-empty.`);
	return value.trim();
}

export function restrictedToolList(previous: readonly string[]): string[] {
	return unique([
		...previous.filter((name) => READ_ONLY_TOOL_NAMES.has(name)),
		...WORKFLOW_TOOL_NAMES,
	]);
}

export function restoreToolsConservatively(
	pi: WorkflowControllerPi,
	previous: readonly string[],
	restricted: readonly string[],
): boolean {
	const current = pi.getActiveTools();
	if (!sameToolSet(current, restricted)) return false;
	pi.setActiveTools([...previous]);
	return true;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

export function boundStatusOutput(text: string): string {
	const lines = text.split("\n");
	const byLines = lines.length > MAX_STATUS_LINES
		? `${lines.slice(0, MAX_STATUS_LINES).join("\n")}\n[Status truncated by line limit]`
		: text;
	if (Buffer.byteLength(byLines) <= MAX_STATUS_BYTES) return byLines;
	const notice = "\n[Status truncated by byte limit]";
	return `${truncateUtf8(byLines, MAX_STATUS_BYTES - Buffer.byteLength(notice))}${notice}`;
}

function emptyPlan(): WorkflowPlan {
	return { summary: "", workItems: [], userResolutions: [], finalized: false };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return String(error);
}

function waitWithTimeout<T>(wait: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
	if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error(`Worker wait timed out after ${timeoutMs}ms`)), timeoutMs);
	return wait(controller.signal).finally(() => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); });
}

async function waitForProtocolEvent(
	server: ProtocolServer,
	predicate: (event: WorkflowProtocolEvent) => boolean,
	isPaused: () => string | undefined,
	signal: AbortSignal,
): Promise<WorkflowProtocolEvent> {
	const local = new AbortController();
	const abort = () => local.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
	if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	const waiting = server.wait(predicate, local.signal);
	void waiting.catch(() => undefined);
	try {
		while (true) {
			const result = await Promise.race([
				waiting.then((event) => ({ event } as const)),
				new Promise<{ readonly event?: undefined }>((resolve) => setTimeout(() => resolve({}), 10)),
			]);
			if (result.event) return result.event;
			const issue = isPaused();
			if (issue) throw new Error(issue);
		}
	} finally {
		local.abort();
		signal.removeEventListener("abort", abort);
	}
}

function applyPlanChange(plan: WorkflowPlan, planning: PlanningDetails, change: PlanChange, now: string): {
	readonly plan: WorkflowPlan;
	readonly unresolvedQuestions: readonly string[];
	readonly questionLedger: PlanningDetails["questionLedger"];
} {
	const reconcile = (requestedQuestions: readonly string[], incomingResolutions: readonly UserResolution[]): Pick<ReturnType<typeof reconcilePlanningQuestions>, "questionLedger" | "unresolvedQuestions" | "userResolutions"> => reconcilePlanningQuestions({
		existingLedger: planning.questionLedger,
		existingUnresolved: planning.unresolvedQuestions,
		existingResolutions: plan.userResolutions,
		incomingResolutions,
		requestedQuestions,
		now,
	});
	switch (change.type) {
		case "set-summary":
			return { plan: { ...plan, summary: change.summary, finalized: false }, unresolvedQuestions: planning.unresolvedQuestions, questionLedger: planning.questionLedger };
		case "upsert-work-item": {
			const workItems = plan.workItems.some((item) => item.id === change.workItem.id)
				? plan.workItems.map((item) => item.id === change.workItem.id ? change.workItem : item)
				: [...plan.workItems, change.workItem];
			return { plan: { ...plan, workItems, finalized: false }, unresolvedQuestions: planning.unresolvedQuestions, questionLedger: planning.questionLedger };
		}
		case "remove-work-item":
			return {
				plan: { ...plan, workItems: plan.workItems.filter((item) => item.id !== change.workItemId), finalized: false },
				unresolvedQuestions: planning.unresolvedQuestions,
				questionLedger: planning.questionLedger,
			};
		case "set-user-resolutions": {
			const result = reconcile([], change.userResolutions);
			return { plan: { ...plan, userResolutions: result.userResolutions, finalized: false }, unresolvedQuestions: result.unresolvedQuestions, questionLedger: result.questionLedger };
		}
		case "set-unresolved-questions": {
			const result = reconcile(change.questions, []);
			return { plan: { ...plan, userResolutions: result.userResolutions, finalized: false }, unresolvedQuestions: result.unresolvedQuestions, questionLedger: result.questionLedger };
		}
	}
}

export class WorkflowController {
	private active: ActiveRun | undefined;
	private lastStopped: WorkflowRun | undefined;
	private readonly coordinator = Semaphore.makeUnsafe(1);

	constructor(
		private readonly pi: WorkflowControllerPi,
		private readonly now: () => Date = () => new Date(),
		private readonly newRunId: () => string = createRunId,
		private readonly tmux = new TmuxController(),
		private readonly gitRunner?: GitCommandRunner,
	) {}

	get activeRun(): WorkflowRun | undefined {
		return this.active?.run;
	}

	verifyTmux() {
		return this.tmux.detect();
	}

	discover(cwd: string, agentDir?: string, sessionId?: string): Effect.Effect<RecoveryDiscovery, Error> {
		return discoverUnfinishedRuns(cwd, {
			...(agentDir === undefined ? {} : { agentDir }),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}

	private serialize<A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
		return this.coordinator.withPermits(1)(operation);
	}

	nextReadyWorkItem(): WorkItem | undefined {
		const run = this.active?.run;
		if (!run || !run.plan.finalized) return undefined;
		for (const item of run.plan.workItems) {
			if (item.status === "completed") continue;
			if (item.status === "blocked" || item.status === "failed" || item.status === "report-review" || item.status === "report-pending" || item.status === "report-revision" || item.status === "running" || item.status === "spawning" || item.status === "verifying-worker") return undefined;
			if (isDelegableStatus(item.status) && dependenciesCompleted(run, item)) return item;
		}
		return undefined;
	}

	nextReadyItem(): WorkItem | undefined {
		return this.nextReadyWorkItem();
	}

	private persist(
		next: WorkflowRun,
		eventType: string,
		data: unknown,
	): Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError> {
		const active = this.active;
		if (!active) return Effect.fail(new Error("No active Ticket Flow run."));
		return persistWorkflowTransaction(active.paths, next, eventType, data).pipe(
			Effect.tap((normalized) => Effect.sync(() => { active.run = normalized; })),
		);
	}

	private detach(activeState: ActiveRun): void {
		if (this.active === activeState) this.active = undefined;
		const previous = activeState.run.planning.previousActiveTools;
		const restricted = activeState.run.planning.restrictedActiveTools;
		if (previous && restricted) restoreToolsConservatively(this.pi, previous, restricted);
	}

	private release(activeState: ActiveRun) {
		return Effect.gen({ self: this }, function* () {
			this.detach(activeState);
			yield* Scope.close(activeState.scope, Exit.void);
		});
	}

	startRun(input: StartRunInput) {
		if (this.active) return Effect.fail(new Error(`Ticket Flow run ${this.active.run.id} is already active.`));
		this.lastStopped = undefined;
		const runId = this.newRunId();
		return Effect.gen({ self: this }, function* () {
			const resolved = yield* pathsForProject(input.cwd, runId, input.agentDir);
			const scope = yield* Scope.make();
			return yield* Effect.gen({ self: this }, function* () {
				const lock = yield* Scope.provide(scope)(acquireProjectLock(
					resolved.paths.rootDir,
					resolved.paths.projectId,
					runId,
					input.sessionId === undefined ? {} : { sessionId: input.sessionId },
				)).pipe(Effect.mapError((error) => new Error(`Could not acquire the Ticket Flow project lock: ${errorMessage(error)}`)));
				const previousActiveTools = this.pi.getActiveTools();
				const restrictedActiveTools = restrictedToolList(previousActiveTools);
				const git = yield* Effect.tryPromise({
					try: (signal) => gitPreflight(input.cwd, runId, this.gitRunner, signal),
					catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
				});
				const timestamp = this.now().toISOString();
				const run: WorkflowRun = {
					id: runId,
					projectId: resolved.paths.projectId,
					projectPath: resolved.canonicalProjectPath,
					originalPrompt: input.prompt,
					...(input.sessionId === undefined ? {} : { orchestratorSessionId: input.sessionId }),
					...(input.auditProfile === undefined ? {} : { auditProfile: auditProfile(input.auditProfile) }),
					phase: "analyzing",
					createdAt: timestamp,
					updatedAt: timestamp,
					plan: emptyPlan(),
					planning: { unresolvedQuestions: [], changes: [], previousActiveTools, restrictedActiveTools },
					...(git === undefined ? {} : { git: gitStateFromPreflight(git) }),
				};
				const activeState = { run, paths: resolved.paths, lock, scope };
				this.active = activeState;
				return yield* this.persist(run, "run-created", { backend: "tmux" }).pipe(
					Effect.tap(() => Effect.sync(() => this.pi.setActiveTools(restrictedActiveTools))),
					Effect.onError(() => this.release(activeState)),
				);
			}).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
		});
	}

	savePlan(plan: WorkflowPlan, questions: readonly string[] = []) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requirePlanningRun();
			const requestedFinalized = plan.finalized;
			const timestamp = this.now().toISOString();
			const requestedAuditProfile = plan.auditProfile;
			if (requestedFinalized && requestedAuditProfile === undefined) {
				return yield* Effect.fail(new Error("Cannot finalize: an explicit model and thinking level audit profile must be set in plan.auditProfile; no fallback is permitted."));
			}
			const reconciled = reconcilePlanningQuestions({
				existingLedger: active.planning.questionLedger,
				existingUnresolved: active.planning.unresolvedQuestions,
				existingResolutions: active.plan.userResolutions,
				incomingResolutions: plan.userResolutions,
				requestedQuestions: questions,
				now: timestamp,
			});
			const normalizedDraft = normalizePlan({
				...plan,
				userResolutions: reconciled.userResolutions,
				finalized: false,
			});
			yield* validatePlan(normalizedDraft);
			if (requestedFinalized && reconciled.unresolvedQuestions.length > 0) return yield* Effect.fail(new Error("Cannot save a finalized plan while clarification questions remain; durable question answers are required."));
			const normalized = requestedFinalized ? normalizePlan({ ...normalizedDraft, finalized: true }) : normalizedDraft;
			yield* validatePlan(normalized);
			const phase = requestedFinalized ? yield* transitionRun(active.phase, "ready") : reconciled.unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing";
			const next: WorkflowRun = {
				...active,
				...(requestedAuditProfile === undefined ? {} : { auditProfile: auditProfile(requestedAuditProfile) }),
				phase,
				updatedAt: timestamp,
				plan: normalized,
				planning: { ...active.planning, unresolvedQuestions: reconciled.unresolvedQuestions, questionLedger: reconciled.questionLedger },
			};
			return yield* this.persist(next, requestedFinalized ? "plan-finalized" : "plan-saved", {
				workItemCount: normalized.workItems.length,
				unresolvedQuestionCount: reconciled.unresolvedQuestions.length,
				finalized: requestedFinalized,
			});
		});
	}

	updatePlan(changes: readonly PlanChange[]) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requirePlanningRun();
			if (changes.length === 0) return yield* Effect.fail(new Error("workflow_plan update requires at least one change."));
			let nextPlan = active.plan;
			let unresolvedQuestions = active.planning.unresolvedQuestions;
			let questionLedger = active.planning.questionLedger;
			const timestamp = this.now().toISOString();
			for (const change of changes) {
				const planningState: PlanningDetails = questionLedger === undefined
					? { ...active.planning, unresolvedQuestions }
					: { ...active.planning, unresolvedQuestions, questionLedger };
				const applied = applyPlanChange(nextPlan, planningState, change, timestamp);
				nextPlan = applied.plan;
				unresolvedQuestions = applied.unresolvedQuestions;
				questionLedger = applied.questionLedger;
			}
			nextPlan = normalizePlan(nextPlan);
			yield* validatePlan(nextPlan);
			const next: WorkflowRun = {
				...active,
				phase: unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing",
				updatedAt: timestamp,
				plan: nextPlan,
				planning: {
					...active.planning,
					unresolvedQuestions,
					...(questionLedger === undefined ? {} : { questionLedger }),
					changes: [...active.planning.changes, ...changes.map((change) => ({ timestamp, change }))],
				},
			};
			return yield* this.persist(next, "plan-updated", { changes });
		});
	}

	startWorker(workItemId: string) {
		return this.serialize(this.startWorkerInternal(workItemId));
	}

	private pauseDelegationStart(workItemId: string, stage: string, cause: unknown) {
		return Effect.uninterruptible(Effect.gen({ self: this }, function* () {
			const current = this.active?.run;
			if (!current || current.activeWorkItemId !== workItemId) return;
			const phase = current.phase === "paused" ? current.phase : yield* transitionRun(current.phase, "paused");
			const timestamp = this.now().toISOString();
			const next: WorkflowRun = {
				...current,
				phase,
				pauseReason: "recovery",
				recoveryIssue: { kind: `delegation-${stage}`, message: `Worker delegation ${stage} did not complete: ${errorMessage(cause)}. Resume only after inspecting the durable checkpoint.` },
				progression: { operation: "delegate", stage: `${stage}-paused`, workItemId, updatedAt: timestamp },
				updatedAt: timestamp,
			};
			yield* this.persist(next, `delegation-${stage}-paused`, { workItemId, message: errorMessage(cause) });
		}));
	}

	delegateStart(workItemId: string, onUpdate?: WorkflowProgressUpdate, signal?: AbortSignal, timeoutMs = DELEGATION_START_TIMEOUT_MS) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			if (active.phase === "paused") return yield* Effect.fail(new Error("Ticket Flow is paused; resume before starting a worker."));
			onUpdate?.("tmux window creation · pending");
			yield* this.startWorker(workItemId);
			onUpdate?.("tmux window created · stable ownership recorded");
			const protocol = this.active?.protocol;
			if (!protocol) return yield* Effect.fail(new Error("Delegation protocol was not started."));
			const connected = yield* Effect.result(Effect.tryPromise({
				try: (waitSignal) => waitWithTimeout((innerSignal) => waitForProtocolEvent(protocol, (event) => event.type === "worker-connected", () => this.active?.run.phase === "paused" ? this.active.run.recoveryIssue?.message ?? "Delegation was paused during connection." : undefined, innerSignal), waitSignal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			}));
			if (Result.isFailure(connected)) {
				yield* this.pauseDelegationStart(workItemId, "connection", connected.failure);
				onUpdate?.("connection/profile verification · paused for recovery");
				return yield* Effect.fail(connected.failure);
			}
			onUpdate?.(`exact profile verified · ${item.launchProfile?.model} · ${item.launchProfile?.thinking}`);
			const ready = yield* Effect.result(Effect.tryPromise({
				try: (waitSignal) => waitWithTimeout((innerSignal) => waitForProtocolEvent(protocol, (event) => event.type === "worker-ready", () => this.active?.run.phase === "paused" ? this.active.run.recoveryIssue?.message ?? "Delegation was paused before prompt delivery." : undefined, innerSignal), waitSignal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			}));
			if (Result.isFailure(ready)) {
				yield* this.pauseDelegationStart(workItemId, "ready", ready.failure);
				return yield* Effect.fail(ready.failure);
			}
			const delegateResult = yield* Effect.result(Effect.tryPromise({
				try: (waitSignal) => waitWithTimeout(async (innerSignal) => {
					while (true) {
						const candidate = this.active?.run.protocolCommands?.find((command) => command.type === "delegate" && !command.acknowledged);
						if (candidate) return candidate;
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(resolve, 10);
							const abort = () => { clearTimeout(timer); reject(innerSignal.reason ?? new DOMException("Aborted", "AbortError")); };
							innerSignal.addEventListener("abort", abort, { once: true });
						});
					}
				}, waitSignal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			}));
			if (Result.isFailure(delegateResult)) {
				yield* this.pauseDelegationStart(workItemId, "prompt", delegateResult.failure);
				return yield* Effect.fail(delegateResult.failure);
			}
			const delegate = delegateResult.success;
			const acknowledgement = yield* Effect.result(Effect.tryPromise({
				try: (waitSignal) => waitWithTimeout((innerSignal) => protocol.waitForAcknowledgement(delegate.requestId, innerSignal), waitSignal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			}));
			if (Result.isFailure(acknowledgement)) {
				yield* this.pauseDelegationStart(workItemId, "acknowledgement", acknowledgement.failure);
				return yield* Effect.fail(acknowledgement.failure);
			}
			onUpdate?.("authenticated connection ready · exact planned prompt delivered");
			return yield* this.requireRun();
		}).pipe(Effect.onInterrupt(() => this.pauseDelegationStart(workItemId, "cancelled", new Error("delegation start was cancelled")).pipe(Effect.catch(() => Effect.void))));
	}

	private startWorkerInternal(workItemId: string) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (!active.plan.finalized || (active.phase !== "ready" && active.phase !== "executing" && active.phase !== "auditing" && active.phase !== "fixing")) {
				return yield* Effect.fail(new Error("A worker can start only after the Ticket Flow plan is finalized."));
			}
			if (active.tmux !== undefined) {
				if (active.tmux.workItemId === workItemId) return active;
				return yield* Effect.fail(new Error(`Work item ${active.activeWorkItemId} already owns the active worker.`));
			}
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			const next = this.nextReadyWorkItem();
			if (!next) return yield* Effect.fail(new Error("There is no dependency-ready work item to delegate."));
			if (next.id !== workItemId) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} is not the next dependency-ready item; delegate ${next.id} first.`));
			}
			if (!dependenciesCompleted(active, item)) return yield* Effect.fail(new Error(`Work item ${workItemId} has incomplete dependencies.`));
			if (!item.launchProfile?.model || !item.launchProfile.thinking) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} has no complete launch profile.`));
			}
			const attemptBaseCommit = active.git === undefined ? undefined : yield* Effect.tryPromise({
				try: (headSignal) => gitHead(active.projectPath, this.gitRunner, headSignal),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
			if (active.git !== undefined && attemptBaseCommit === undefined) return yield* Effect.fail(new Error("Git state exists but the active attempt has no reachable HEAD."));
		let status = item.status;
			if (status === "planned" || status === "interrupted") status = yield* transitionWorkItem(status, "ready");
			if (status !== "ready") return yield* Effect.fail(new Error(`Work item ${workItemId} cannot start while ${status}.`));
			status = yield* transitionWorkItem(status, "spawning");
			const phase = active.phase === "ready" ? yield* transitionRun(active.phase, "executing") : active.phase;
			const spawningItem = { ...item, status };
			const spawning: WorkflowRun = {
				...active,
				...(active.git === undefined || attemptBaseCommit === undefined ? {} : { git: { ...active.git, attemptBaseCommit } }),
				phase,
				progression: { operation: "delegate", stage: "tmux-window-pending", workItemId, updatedAt: this.now().toISOString() },
				updatedAt: this.now().toISOString(),
				activeWorkItemId: workItemId,
				requestedLaunchProfile: { model: item.launchProfile.model, thinking: item.launchProfile.thinking },
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === workItemId ? spawningItem : candidate) },
			};
			yield* this.persist(spawning, "worker-spawning", { workItemId, requestedLaunchProfile: spawning.requestedLaunchProfile });
			const activeState = this.active!;
			const socketPath = workflowSocketPath(active.id);
			const socketRun: WorkflowRun = { ...spawning, workflowSocketPath: socketPath, progression: { operation: "delegate", stage: "authenticated-socket-pending", workItemId, updatedAt: this.now().toISOString() } };
			yield* this.persist(socketRun, "worker-protocol-starting", { workItemId, socketPath });
			const failProtocolStart = (cause: unknown) => Effect.gen({ self: this }, function* () {
				const failedItem = { ...spawningItem, status: yield* transitionWorkItem("spawning", "failed") };
				const { activeWorkItemId: _activeWorkItemId, requestedLaunchProfile: _requestedLaunchProfile, ...failedBase } = spawning;
				delete activeState.workerToken;
				yield* removeWorkflowToken(activeState.paths.runDir);
				const failed: WorkflowRun = { ...failedBase, updatedAt: this.now().toISOString(), plan: { ...spawning.plan, workItems: spawning.plan.workItems.map((candidate) => candidate.id === workItemId ? failedItem : candidate) } };
				yield* this.persist(failed, "worker-protocol-start-failed", { workItemId, message: errorMessage(cause) });
				return yield* Effect.fail(cause);
			});
			activeState.workerToken = crypto.randomUUID();
			yield* writeWorkflowToken(activeState.paths.runDir, activeState.workerToken).pipe(Effect.catch(failProtocolStart));
			const token = yield* readWorkflowToken(activeState.paths.runDir).pipe(Effect.catch(failProtocolStart));
			activeState.workerToken = token;
			const server = this.makeProtocolServer(socketPath, active.id, workItemId, token, socketRun.requestedLaunchProfile!);
			yield* server.start().pipe(Effect.catch(failProtocolStart));
			yield* Scope.addFinalizer(activeState.scope, server.shutdown());
			activeState.protocol = server;
			const handle = yield* this.tmux.createWorkerWindow({
				runId: active.id,
				workItemId,
				title: item.title,
				order: item.order,
				cwd: active.projectPath,
				profile: spawning.requestedLaunchProfile!,
				// The durable kind is authoritative. Never let a model-supplied
				// readOnly field downgrade an audit worker (or upgrade another kind).
				readOnly: item.kind === "audit",
				kind: item.kind === "audit" ? "audit" : item.kind === "fix" ? "fix" : "implementation",
				socketPath,
				token: activeState.workerToken,
			}).pipe(Effect.catch((cause) => Effect.gen({ self: this }, function* () {
				const failedItem = { ...spawningItem, status: yield* transitionWorkItem("spawning", "failed") };
				const { activeWorkItemId: _activeWorkItemId, requestedLaunchProfile: _requestedLaunchProfile, ...failedBase } = spawning;
				const { workflowSocketPath: _workflowSocketPath, ...failedWithoutSocket } = failedBase;
				const failed: WorkflowRun = {
					...failedWithoutSocket,
					updatedAt: this.now().toISOString(),
					plan: { ...spawning.plan, workItems: spawning.plan.workItems.map((candidate) => candidate.id === workItemId ? failedItem : candidate) },
				};
				delete activeState.workerToken;
				yield* removeWorkflowToken(activeState.paths.runDir);
				yield* activeState.protocol?.shutdown() ?? Effect.void;
				delete activeState.protocol;
				yield* this.persist(failed, "worker-start-failed", { workItemId, message: errorMessage(cause) });
				return yield* Effect.fail(cause);
			})));
			const verifyingItem = { ...spawningItem, status: yield* transitionWorkItem("spawning", "verifying-worker") };
			const verifying: WorkflowRun = {
				...socketRun,
				progression: { operation: "delegate", stage: "profile-verification-pending", workItemId, updatedAt: this.now().toISOString() },
				updatedAt: this.now().toISOString(),
				tmux: handle,
				plan: { ...socketRun.plan, workItems: socketRun.plan.workItems.map((candidate) => candidate.id === workItemId ? verifyingItem : candidate) },
			};
			return yield* this.persist(verifying, "worker-window-created", { workItemId, handle }).pipe(
				Effect.onError(() => this.tmux.closeWindow(handle, true).pipe(Effect.catch(() => Effect.void))),
			);
		});
	}

	private makeProtocolServer(socketPath: string, runId: string, workItemId: string, token: string, profile: PiLaunchProfile): ProtocolServer {
		return new ProtocolServer({
			socketPath,
			runId,
			workItemId,
			token,
			profile,
			onEvent: (event) => Effect.runPromise(this.receiveProtocolEvent(event)),
			onAcknowledgement: (receipt) => Effect.runPromise(this.acknowledgeProtocolCommand(receipt.requestId)),
			onRejected: (rejection) => Effect.runPromise(this.rejectProtocolWorker(rejection)),
		});
	}

	private startRecoveredProtocol(activeState: ActiveRun) {
		return Effect.gen({ self: this }, function* () {
			const run = activeState.run;
			if (activeState.protocol || !run.activeWorkItemId || !run.requestedLaunchProfile || !run.workflowSocketPath) return;
			const token = yield* readWorkflowToken(activeState.paths.runDir);
			activeState.workerToken = token;
			const server = this.makeProtocolServer(run.workflowSocketPath, run.id, run.activeWorkItemId, token, run.requestedLaunchProfile);
			yield* server.start();
			yield* Scope.addFinalizer(activeState.scope, server.shutdown());
			activeState.protocol = server;
		});
	}

	private protocolIngestionDependencies(): ProtocolIngestionDependencies {
		return { now: this.now, persist: (next, eventType, data) => this.persist(next, eventType, data) };
	}

	private protocolState(): { readonly run: WorkflowRun; readonly paths: WorkflowPaths; readonly server: ProtocolServer } | undefined {
		const active = this.active;
		return active?.protocol === undefined ? undefined : { run: active.run, paths: active.paths, server: active.protocol };
	}

	private rejectProtocolWorker(rejection: ProtocolRejection) {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const state = this.protocolState();
			if (!state) return yield* Effect.fail(new Error("No active native worker protocol."));
			yield* rejectProtocolWorkerIngestion(state, rejection, this.protocolIngestionDependencies());
		}));
	}

	private acknowledgeProtocolCommand(requestId: string) {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			yield* acknowledgeProtocolCommandIngestion(active, requestId, this.protocolIngestionDependencies());
		}));
	}

	private receiveProtocolEvent(event: WorkflowProtocolEvent) {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const state = this.protocolState();
			if (!state) return yield* Effect.fail(new Error("No active native worker protocol."));
			yield* ingestProtocolEvent(state, event, this.protocolIngestionDependencies());
		}));
	}
	waitWorker(workItemId: string, until: "connected" | "ready" | "progress" | "report" | "blocked" | "idle" | "exit" | "any" = "any", signal?: AbortSignal, timeoutMs?: number) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (until === "idle") return yield* Effect.fail(new Error("workflow_delegate wait until idle is not available in the native protocol; use a worker event."));
			if (active.activeWorkItemId !== workItemId) return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active worker.`));
			const server = this.active?.protocol;
			if (!server) return yield* Effect.fail(new Error("Native worker protocol is not running."));
			const event = yield* Effect.tryPromise({
				try: () => waitWithTimeout((waitSignal) => server.wait((candidate) => until === "any" || (until === "connected" && candidate.type === "worker-connected") || (until === "ready" && candidate.type === "worker-ready") || (until === "progress" && candidate.type === "worker-progress") || (until === "report" && (candidate.type === "worker-report" || candidate.type === "worker-failed")) || (until === "blocked" && candidate.type === "worker-blocked") || (until === "exit" && candidate.type === "worker-shutdown"), waitSignal), signal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
			return boundStatusOutput(JSON.stringify(event));
		});
	}
	sendWorkerFeedback(workItemId: string, message: string, signal?: AbortSignal) {
		return this.serialize(this.sendWorkerFeedbackInternal(workItemId, message, "message", undefined, undefined, signal));
	}

	private sendWorkerFeedbackInternal(
		workItemId: string,
		message: string,
		kind: "message" | "revision" | "user-answer",
		missingRequirements: readonly string[] | undefined,
		questions: readonly string[] | undefined,
		signal?: AbortSignal,
	) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.activeWorkItemId !== workItemId) return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active worker.`));
			if (!message.trim()) return yield* Effect.fail(new Error("Worker feedback must not be empty."));
			const server = this.active?.protocol;
			if (!server?.isVerified) return yield* Effect.fail(new Error("Cannot send feedback before native worker verification."));
			const command = {
				type: "feedback" as const,
				requestId: crypto.randomUUID(),
				messageId: crypto.randomUUID(),
				acknowledged: false,
			};
			yield* this.persist({
				...active,
				updatedAt: this.now().toISOString(),
				protocolCommands: [...(active.protocolCommands ?? []), command],
			}, "worker-feedback-sending", { workItemId, kind, requestId: command.requestId, messageId: command.messageId });
			server.send("feedback", {
				kind,
				message,
				requestId: command.requestId,
				...(missingRequirements === undefined ? {} : { missingRequirements }),
				...(questions === undefined ? {} : { questions }),
			}, command.messageId);
			yield* Effect.tryPromise({
				try: () => waitWithTimeout((waitSignal) => server.waitForAcknowledgement(command.requestId, waitSignal), signal, 2_000),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
			if (kind === "message") {
				const current = yield* this.requireRun();
				const blockedItem = current.plan.workItems.find((candidate) => candidate.id === workItemId);
				if (blockedItem?.status === "blocked") {
					const running = yield* transitionWorkItem(blockedItem.status, "running");
					const phase = current.phase === "paused" ? yield* transitionRun(current.phase, "executing") : current.phase;
					const { pauseReason: _pauseReason, recoveryIssue: _recoveryIssue, progression: _progression, ...withoutPause } = current;
					return yield* this.persist({ ...withoutPause, phase, updatedAt: this.now().toISOString(), plan: { ...current.plan, workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: running } : candidate), }, blockers: (current.blockers ?? []).map((blocker) => blocker.workItemId === workItemId && blocker.resolvedAt === undefined ? { ...blocker, resolvedAt: this.now().toISOString() } : blocker) }, "worker-feedback-resumed", { workItemId, kind });
				}
			}
			return yield* this.requireRun();
		});
	}
	readWorker(workItemId: string, lines = 200) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.activeWorkItemId !== workItemId || active.tmux?.workItemId !== workItemId) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active tmux window.`));
			}
			return boundStatusOutput(yield* this.tmux.capturePane(active.tmux, lines));
		});
	}

	closeWorker(workItemId: string, force = false) {
		return this.serialize(this.closeWorkerInternal(workItemId, force, false));
	}

	private closeWorkerInternal(workItemId: string, force: boolean, retainCompleted: boolean) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.activeWorkItemId !== workItemId || active.tmux?.workItemId !== workItemId) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active tmux window.`));
			}
			const protocol = this.active?.protocol;
			const closeUpdatedAt = this.now().toISOString();
			const requestId = protocol?.isVerified ? crypto.randomUUID() : undefined;
			const messageId = protocol?.isVerified ? crypto.randomUUID() : undefined;
			const command = requestId === undefined || messageId === undefined
				? undefined
				: { type: "shutdown" as const, requestId, messageId, acknowledged: false };
			const closeCheckpoint: ProgressionCheckpoint = {
				operation: "close",
				stage: retainCompleted ? "accepted-worker-shutdown-sending" : "worker-shutdown-sending",
				workItemId,
				updatedAt: closeUpdatedAt,
			};
			yield* this.persist({
				...active,
				updatedAt: closeUpdatedAt,
				progression: closeCheckpoint,
				...(command === undefined ? {} : { protocolCommands: [...(active.protocolCommands ?? []), command] }),
			}, "worker-shutdown-sending", {
				workItemId,
				...(requestId === undefined ? {} : { requestId }),
				...(messageId === undefined ? {} : { messageId }),
			});
			if (protocol?.isVerified && command !== undefined) {
				const receipt = yield* Effect.try({
					try: () => protocol.send("shutdown", { requestId: command.requestId }, command.messageId),
					catch: () => undefined,
				});
				if (receipt) yield* Effect.tryPromise({
					try: () => waitWithTimeout((waitSignal) => protocol.waitForAcknowledgement(receipt.requestId, waitSignal), undefined, 2_000),
					catch: () => undefined,
				});
			}
			const current = yield* this.requireRun();
			const currentItem = current.plan.workItems.find((item) => item.id === workItemId);
			if (!currentItem) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			const status = retainCompleted
				? currentItem.status
				: currentItem.status === "interrupted" || currentItem.status === "failed"
					? currentItem.status
					: yield* transitionWorkItem(currentItem.status, "interrupted");
			const {
				activeWorkItemId: _activeWorkItemId,
				requestedLaunchProfile: _requestedLaunchProfile,
				tmux: _tmux,
				worker: _worker,
				protocolCommands: _protocolCommands,
				workflowSocketPath: _workflowSocketPath,
				progression: _progression,
				...nextBase
			} = current;
			const next: WorkflowRun = {
				...nextBase,
				updatedAt: this.now().toISOString(),
				plan: { ...current.plan, workItems: current.plan.workItems.map((item) => item.id === workItemId ? { ...item, status } : item) },
			};
			const closeResult = yield* this.tmux.closeWindow(current.tmux!, force);
			if (this.active) {
				delete this.active.workerToken;
				yield* removeWorkflowToken(this.active.paths.runDir);
				yield* this.active.protocol?.shutdown() ?? Effect.void;
				delete this.active.protocol;
			}
			const run = yield* this.persist(next, "worker-window-closed", { workItemId, ...closeResult, retainedCompleted: retainCompleted });
			return { run, closeResult };
		});
	}
	inspectReport(workItemId: string, signal?: AbortSignal) {
		return this.serialize(this.inspectReportInternal(workItemId, signal));
	}

	private inspectReportInternal(workItemId: string, signal?: AbortSignal) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			const attempt = yield* readLatestReportAttempt(this.active!.paths, workItemId, signal);
			if (!attempt) return yield* Effect.fail(new Error(`No worker report exists for ${workItemId}.`));
			const requirements = item.requirements.map((requirement, index) => ({ id: requirementId(index), requirement }));
			return boundStatusOutput(JSON.stringify({
				workItemId,
				workItemTitle: item.title,
				requirements,
				latestAttempt: attempt,
			}, null, 2));
		});
	}

	private auditProgressionDependencies(): AuditProgressionDependencies {
		return {
			now: this.now,
			persist: (next, eventType, data) => this.persist(next, eventType, data),
			...(this.gitRunner === undefined ? {} : { gitRunner: this.gitRunner }),
		};
	}

	private advanceAuditAfterAcceptance(run: WorkflowRun, itemId: string, report: WorkerReport, reportPath: string) {
		return Effect.gen({ self: this }, function* () {
			const result = yield* advanceAuditProgression(run, itemId, report, reportPath, this.auditProgressionDependencies());
			if (result.terminal) {
				this.lastStopped = result.run;
				const state = this.active;
				if (state) yield* this.release(state);
			}
			return result.run;
		});
	}

	private completionAcceptanceDependencies(): CompletionAcceptanceDependencies {
		return {
			now: this.now,
			getState: () => this.active === undefined ? undefined : { run: this.active.run, paths: this.active.paths },
			persist: (next, eventType, data) => this.persist(next, eventType, data),
			closeWorker: (workItemId, force, retainCompleted) => this.closeWorkerInternal(workItemId, force, retainCompleted).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause)))),
			nextReadyWorkItem: () => this.nextReadyWorkItem(),
			advanceAudit: (run, itemId, report, reportPath) => this.advanceAuditAfterAcceptance(run, itemId, report, reportPath),
			scheduleAudit: (run, completedWorkItemId) => scheduleAuditAfterAcceptance(run, completedWorkItemId, this.auditProgressionDependencies()),
			...(this.gitRunner === undefined ? {} : { gitRunner: this.gitRunner }),
		};
	}

	private continueAfterCompletedInternal(workItemId: string, deferAuditAdvance = false) {
		return continueAfterCompletedProgression(workItemId, deferAuditAdvance, this.completionAcceptanceDependencies());
	}

	acceptReport(workItemId: string, comment: string, signal?: AbortSignal) {
		return this.serialize(this.acceptReportInternal(workItemId, comment, signal));
	}

	private acceptReportInternal(workItemId: string, comment: string, signal?: AbortSignal) {
		return acceptReportProgression(workItemId, comment, signal, this.completionAcceptanceDependencies());
	}
	reviseReport(workItemId: string, feedback: string, missingRequirements: readonly string[] = [], signal?: AbortSignal) {
		return this.serialize(this.reviseReportInternal(workItemId, feedback, missingRequirements, signal));
	}

	private reviseReportInternal(workItemId: string, feedback: string, missingRequirements: readonly string[], signal?: AbortSignal) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			if (item.status !== "report-review" && item.status !== "report-revision") return yield* Effect.fail(new Error(`Work item ${workItemId} is not awaiting report review.`));
			const message = nonEmptyText(feedback, "Report revision feedback");
			const missing = [...new Set(missingRequirements.map((requirement) => requirement.trim()).filter(Boolean))];
			const checkpoint: ProgressionCheckpoint = { operation: "revision", stage: "feedback-pending", workItemId, updatedAt: this.now().toISOString() };
			const revisionStatus = item.status === "report-review" ? yield* transitionWorkItem(item.status, "report-revision") : item.status;
			yield* this.persist({
				...active,
				updatedAt: checkpoint.updatedAt,
				progression: checkpoint,
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: revisionStatus } : candidate) },
			}, "report-revision-requested", { workItemId, feedback: message, missingRequirements: missing });
			yield* this.sendWorkerFeedbackInternal(workItemId, message, "revision", missing, undefined, signal);
			const current = yield* this.requireRun();
			const running = yield* transitionWorkItem(current.plan.workItems.find((candidate) => candidate.id === workItemId)!.status, "running");
			const { progression: _progression, ...withoutProgression } = current;
			return yield* this.persist({
				...withoutProgression,
				updatedAt: this.now().toISOString(),
				plan: { ...current.plan, workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: running } : candidate) },
			}, "report-revision-sent", { workItemId, missingRequirements: missing });
		});
	}

	blockReport(workItemId: string, options: BlockReportOptions = {}, signal?: AbortSignal) {
		return this.serialize(this.blockReportInternal(workItemId, options, signal));
	}

	private blockReportInternal(workItemId: string, options: BlockReportOptions, signal?: AbortSignal) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			if (active.activeWorkItemId !== workItemId) return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active worker.`));
			const latest = yield* readLatestReportAttempt(this.active!.paths, workItemId, signal);
			const message = (options.message ?? latest?.report.blockers?.join("; ") ?? latest?.report.summary ?? "Worker is blocked.").trim() || "Worker is blocked.";
			const questions = [...(options.questions ?? latest?.report.questions ?? [])].map((question) => question.trim()).filter(Boolean);
			const status = item.status === "blocked" ? item.status : yield* transitionWorkItem(item.status, "blocked");
			const phase = active.phase === "paused" ? active.phase : yield* transitionRun(active.phase, "paused");
			const blocker: WorkflowBlocker = { workItemId, message, questions, userInterventionRequired: latest?.report.userInterventionRequired ?? questions.length > 0, reportedAt: this.now().toISOString() };
			const existingBlocker = (active.blockers ?? []).find((candidate) => candidate.workItemId === workItemId && candidate.resolvedAt === undefined && candidate.message === message);
			const blockers = existingBlocker === undefined ? [...(active.blockers ?? []), blocker] : active.blockers;
			const checkpoint: ProgressionCheckpoint = { operation: "block", stage: "blocker-recorded", workItemId, updatedAt: blocker.reportedAt };
			return yield* this.persist({
				...active,
				phase,
				pauseReason: "blocker",
				updatedAt: blocker.reportedAt,
				progression: checkpoint,
				...(blockers === undefined ? {} : { blockers }),
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status } : candidate) },
			}, "worker-blocker-recorded", { workItemId, message, questions });
		});
	}

	resumeBlockedWorker(workItemId: string, questions: readonly string[], answers: readonly string[], signal?: AbortSignal) {
		return this.serialize(this.resumeBlockedWorkerInternal(workItemId, questions, answers, signal));
	}

	private resumeBlockedWorkerInternal(workItemId: string, questions: readonly string[], answers: readonly string[], signal?: AbortSignal) {
		return Effect.gen({ self: this }, function* () {
			if (questions.length !== answers.length || questions.length === 0) return yield* Effect.fail(new Error("Blocker answers must match at least one question."));
			if (questions.some((question) => !question.trim()) || answers.some((answer) => !answer.trim())) return yield* Effect.fail(new Error("Blocker questions and answers must be non-empty."));
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item || item.status !== "blocked" || active.activeWorkItemId !== workItemId) return yield* Effect.fail(new Error(`Work item ${workItemId} is not a resumable blocked worker.`));
			const resolvedAt = this.now().toISOString();
			const resolutions = questions.map((question, index) => ({ id: questionIdFor(question), question: question.trim(), answer: answers[index]!.trim(), resolvedAt }));
			const reconciled = reconcilePlanningQuestions({ existingLedger: active.planning.questionLedger, existingUnresolved: active.planning.unresolvedQuestions, existingResolutions: active.plan.userResolutions, incomingResolutions: resolutions, requestedQuestions: [], now: resolvedAt });
			const answerMessage = resolutions.map((resolution) => `Question: ${resolution.question}\nAnswer: ${resolution.answer}`).join("\n\n");
			const checkpoint: ProgressionCheckpoint = { operation: "block", stage: "answers-recorded", workItemId, updatedAt: resolvedAt };
			const resolvedPlan = { ...active.plan, userResolutions: reconciled.userResolutions };
			const resolutionChange: PlanChange = { type: "set-user-resolutions", userResolutions: resolvedPlan.userResolutions };
			yield* this.persist({
				...active,
				updatedAt: resolvedAt,
				progression: checkpoint,
				planning: { ...active.planning, unresolvedQuestions: reconciled.unresolvedQuestions, questionLedger: reconciled.questionLedger, changes: [...active.planning.changes, { timestamp: resolvedAt, change: resolutionChange }] },
				plan: resolvedPlan,
				blockers: (active.blockers ?? []).map((blocker) => blocker.workItemId === workItemId && blocker.resolvedAt === undefined ? { ...blocker, resolvedAt } : blocker),
			}, "worker-blocker-answers-recorded", { workItemId, questions: questions.map((question) => question.trim()) });
			yield* this.sendWorkerFeedbackInternal(workItemId, answerMessage, "user-answer", undefined, questions, signal);
			const current = yield* this.requireRun();
			const running = yield* transitionWorkItem(item.status, "running");
			const phase = current.phase === "paused" ? yield* transitionRun(current.phase, "executing") : current.phase;
			const { progression: _progression, pauseReason: _pauseReason, ...withoutProgression } = current;
			return yield* this.persist({
				...withoutProgression,
				phase,
				updatedAt: this.now().toISOString(),
				plan: { ...current.plan, workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: running } : candidate) },
			}, "worker-blocker-resumed", { workItemId });
		});
	}

	finalizePlan() {
		return this.serialize(this.finalizePlanInternal());
	}

	private finalizePlanInternal() {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requirePlanningRun();
			if (active.planning.unresolvedQuestions.length > 0) {
				return yield* Effect.fail(new Error(
					`Cannot finalize: ${active.planning.unresolvedQuestions.length} unresolved user question(s) remain.`,
				));
			}
			if (!active.plan.auditProfile?.model || !active.plan.auditProfile.thinking) {
				return yield* Effect.fail(new Error("Cannot finalize: an explicit model and thinking level audit profile must be set in plan.auditProfile; no fallback is permitted."));
			}
			const plan = normalizePlan({ ...active.plan, finalized: true });
			yield* validatePlan(plan);
			const phase = yield* transitionRun(active.phase, "ready");
			return yield* this.persist(
				{ ...active, phase, plan, updatedAt: this.now().toISOString() },
				"plan-finalized",
				{ workItemCount: plan.workItems.length },
			);
		});
	}

	private recoveryTargetPhase(run: WorkflowRun): WorkflowRun["phase"] {
		const activeItem = run.activeWorkItemId === undefined ? undefined : run.plan.workItems.find((item) => item.id === run.activeWorkItemId);
		if (run.pauseReason === "user" || activeItem?.status === "blocked") return "paused";
		if (run.activeWorkItemId) return run.audit?.activeRound === undefined ? (run.phase === "fixing" ? "fixing" : "executing") : "auditing";
		if (run.phase === "auditing" || run.phase === "fixing") return run.phase;
		if (run.plan.finalized) return "ready";
		return run.planning.unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing";
	}

	private continueRecoveryInternal(reconciliation: RecoveryReconciliation) {
		return Effect.gen({ self: this }, function* () {
			let active = yield* this.requireRun();
			const activeState = this.active!;
			const itemBeforeReconnect = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
			if (active.activeWorkItemId && itemBeforeReconnect?.status !== "completed" && reconciliation.tmux?.state === "alive" && !activeState.protocol) {
				yield* this.startRecoveredProtocol(activeState);
			}
			if (reconciliation.kind === "worker-alive-disconnected") {
				const pausedPhase = active.phase === "paused" ? active.phase : yield* transitionRun(active.phase, "paused");
				return yield* this.persist({ ...active, phase: pausedPhase, pauseReason: active.pauseReason ?? "recovery", updatedAt: this.now().toISOString() }, "recovery-awaiting-worker", {
					message: reconciliation.message,
				});
			}
			const target = this.recoveryTargetPhase(active);
			const { pauseReason: _pauseReason, recoveryIssue: _recoveryIssue, ...activeWithoutPauseReason } = active;
			const resumed: WorkflowRun = {
				...activeWithoutPauseReason,
				phase: yield* transitionRun(active.phase, target),
				...(target === "paused" && active.pauseReason !== undefined ? { pauseReason: active.pauseReason } : {}),
				updatedAt: this.now().toISOString(),
			};
			active = yield* this.persist(resumed, "run-resumed", { reconciliation: reconciliation.kind, targetPhase: target });
			let activeItem = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
			if (activeItem?.status === "verifying-worker" && activeState.protocol?.isVerified && activeState.protocol.identity && active.phase !== "paused") {
				const delegate = { type: "delegate" as const, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), acknowledged: false };
				const running = { ...activeItem, status: yield* transitionWorkItem(activeItem.status, "running") };
				active = yield* this.persist({
					...active,
					updatedAt: this.now().toISOString(),
					protocolCommands: [...(active.protocolCommands ?? []), delegate],
					plan: { ...active.plan, workItems: active.plan.workItems.map((item) => item.id === activeItem!.id ? running : item) },
				}, "worker-delegated-after-resume", { workItemId: activeItem.id, requestId: delegate.requestId });
				const context = makeAuthoritativeWorkerContext(active, activeItem, activeState.protocol.identity);
				activeState.protocol.send("delegate", { prompt: activeItem.delegationPrompt, context, requestId: delegate.requestId }, delegate.messageId);
				activeItem = running;
			}
			if (activeItem?.status === "report-pending") {
				const report = yield* readLatestReportAttempt(activeState.paths, activeItem.id);
				if (report) {
					const reviewStatus = yield* transitionWorkItem(activeItem.status, "report-review");
					active = yield* this.persist({
						...active,
						updatedAt: this.now().toISOString(),
						plan: { ...active.plan, workItems: active.plan.workItems.map((item) => item.id === activeItem.id ? { ...item, status: reviewStatus } : item) },
					}, "pending-report-recovered", { workItemId: activeItem.id, attempt: report.attempt });
				}
			}
			const currentItem = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
			if (active.progression?.operation === "accept" && active.progression.stage === "audit-round-pending-record") {
				const pendingAudit = active.plan.workItems.find((item) => item.id === active.progression?.workItemId);
				if (!pendingAudit?.completion) return yield* Effect.fail(new Error("Audit completion checkpoint has no durable completion record."));
				const accepted = yield* readReportAttempt(activeState.paths, pendingAudit.id, pendingAudit.completion.acceptedAttempt);
				return yield* this.advanceAuditAfterAcceptance(active, pendingAudit.id, accepted.report, pendingAudit.completion.acceptedReportPath);
			}
			if (active.progression?.operation === "accept" && active.progression.comment && currentItem?.status === "report-review") {
				return yield* this.acceptReportInternal(currentItem.id, active.progression.comment);
			}
			if (currentItem?.status === "completed") return yield* this.continueAfterCompletedInternal(currentItem.id);
			if (active.progression?.operation === "close" && active.activeWorkItemId && active.tmux) {
				return (yield* this.closeWorkerInternal(active.activeWorkItemId, false, false)).run;
			}
			return active;
		});
	}

	recover(input: RecoverRunInput) {
		return this.serialize(Effect.gen({ self: this }, function* () {
			if (this.active) return yield* Effect.fail(new Error(`Ticket Flow run ${this.active.run.id} is already active.`));
			const discovery = yield* this.discover(input.cwd, input.agentDir, input.sessionId);
			const candidates = input.runId === undefined ? discovery.runs : discovery.runs.filter((candidate) => candidate.run.id === input.runId);
			if (candidates.length === 0) {
				const invalid = input.runId === undefined ? undefined : discovery.invalidRunIssues?.find((issue) => issue.runId === input.runId);
				return yield* Effect.fail(new Error(invalid === undefined ? "No recoverable Ticket Flow run exists for this project." : `Run ${input.runId} cannot be recovered: ${invalid.message}. Inspect or migrate the durable state before retrying.`));
			}
			if (candidates.length > 1 && input.runId === undefined) return yield* Effect.fail(new Error("Multiple unfinished runs exist; recovery requires an explicit run ID."));
			const candidate = candidates[0]!;
			const scope = yield* Scope.make();
			return yield* Effect.gen({ self: this }, function* () {
				const recovered = yield* Scope.provide(scope)(recoverProjectLock(candidate.paths.rootDir, candidate.paths.projectId, candidate.run.id, {
					...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
					...(candidate.run.orchestratorSessionId === undefined ? {} : { expectedOwnerSessionId: candidate.run.orchestratorSessionId }),
					...(input.allowAmbiguousTakeover === undefined ? {} : { allowAmbiguousTakeover: input.allowAmbiguousTakeover }),
				}));
				const loaded = yield* loadRun(candidate.paths);
				const previousActiveTools = this.pi.getActiveTools();
				const restrictedActiveTools = restrictedToolList(previousActiveTools);
				const recoveredRun: WorkflowRun = {
					...loaded,
					...(input.sessionId === undefined ? {} : { orchestratorSessionId: input.sessionId }),
					planning: { ...loaded.planning, previousActiveTools, restrictedActiveTools },
					updatedAt: this.now().toISOString(),
				};
				const activeState: ActiveRun = { run: recoveredRun, paths: candidate.paths, lock: recovered.lock, scope };
				this.active = activeState;
				this.pi.setActiveTools(restrictedActiveTools);
				yield* this.persist(recoveredRun, recovered.takeover === "none" ? "run-recovery-started" : "lock-taken-over", {
					takeover: recovered.takeover,
					previousOwnerState: candidate.lock.state,
				});
				const reconciliation = yield* reconcileRecovery(recoveredRun, this.tmux);
				if (!reconciliation.safe) {
					const pausedPhase = recoveredRun.phase === "paused" || recoveredRun.phase === "failed"
						? recoveredRun.phase
						: yield* transitionRun(recoveredRun.phase, "paused");
					return yield* this.persist({ ...recoveredRun, phase: pausedPhase, pauseReason: recoveredRun.pauseReason ?? "recovery", recoveryIssue: { kind: reconciliation.kind, message: reconciliation.message }, updatedAt: this.now().toISOString() }, "recovery-paused", {
						kind: reconciliation.kind, message: reconciliation.message,
					});
				}
				return yield* this.continueRecoveryInternal(reconciliation);
			}).pipe(Effect.onError(() => this.active ? this.release(this.active) : Scope.close(scope, Exit.void)));
		}));
	}

	resume() {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.phase !== "paused") return yield* Effect.fail(new Error("/ticket-flow resume requires an owned paused run."));
			const activeItem = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
			if (activeItem?.status === "blocked") return yield* Effect.fail(new Error("Resolve the active worker blocker before resuming Ticket Flow."));
			const { pauseReason: _pauseReason, recoveryIssue: _recoveryIssue, ...withoutPauseReason } = active;
			const explicitlyResuming = yield* this.persist({ ...withoutPauseReason, updatedAt: this.now().toISOString() }, "run-resume-requested", { previousPauseReason: active.pauseReason });
			const protocol = this.active?.protocol;
			const reconciliation = yield* reconcileRecovery(explicitlyResuming, this.tmux, protocol?.isVerified ? protocol.identity : undefined);
			if (!reconciliation.safe) {
				return yield* this.persist({
					...explicitlyResuming,
					phase: "paused",
					pauseReason: "recovery",
					recoveryIssue: { kind: reconciliation.kind, message: reconciliation.message },
					updatedAt: this.now().toISOString(),
				}, "resume-reconciliation-paused", { kind: reconciliation.kind, message: reconciliation.message });
			}
			return yield* this.continueRecoveryInternal(reconciliation);
		}));
	}

	pause() {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const phase = yield* transitionRun(active.phase, "paused");
			return yield* this.persist(
				{ ...active, phase, pauseReason: "user", updatedAt: this.now().toISOString() },
				"run-paused",
				{ from: active.phase },
			);
		}));
	}

	private detachUnverifiedWorkerInternal(workItemId: string, reason: string) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const protocol = this.active?.protocol;
			if (protocol?.isVerified) {
				const requestId = crypto.randomUUID();
				const messageId = crypto.randomUUID();
				yield* this.persist({
					...active,
					updatedAt: this.now().toISOString(),
					protocolCommands: [...(active.protocolCommands ?? []), { type: "shutdown", requestId, messageId, acknowledged: false }],
				}, "worker-shutdown-sending", { workItemId, requestId, messageId, reason });
				const receipt = yield* Effect.try({ try: () => protocol.send("shutdown", { requestId }, messageId), catch: () => undefined });
				if (receipt) yield* Effect.tryPromise({
					try: () => waitWithTimeout((signal) => protocol.waitForAcknowledgement(receipt.requestId, signal), undefined, 2_000),
					catch: () => undefined,
				});
			}
			const current = yield* this.requireRun();
			const item = current.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			const status = item.status === "completed" || item.status === "failed" || item.status === "interrupted"
				? item.status
				: yield* transitionWorkItem(item.status, "interrupted");
			const {
				activeWorkItemId: _activeWorkItemId,
				requestedLaunchProfile: _requestedLaunchProfile,
				tmux: _tmux,
				worker: _worker,
				protocolCommands: _protocolCommands,
				workflowSocketPath: _workflowSocketPath,
				progression: _progression,
				...base
			} = current;
			yield* protocol?.shutdown() ?? Effect.void;
			if (this.active) {
				delete this.active.protocol;
				delete this.active.workerToken;
				yield* removeWorkflowToken(this.active.paths.runDir);
			}
			return yield* this.persist({
				...base,
				updatedAt: this.now().toISOString(),
				plan: { ...current.plan, workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status } : candidate) },
			}, "worker-window-unverified-skipped", { workItemId, reason });
		});
	}

	stop() {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const activeState = this.active;
			if (!activeState) {
				return this.lastStopped
					? yield* Effect.succeed(this.lastStopped)
					: yield* Effect.fail(new Error("No active Ticket Flow run."));
			}
			if (activeState.run.tmux && activeState.run.activeWorkItemId) {
				const inspection = yield* this.tmux.inspectWindow(activeState.run.tmux);
				if (inspection.state === "alive" || inspection.state === "exited") {
					yield* this.closeWorkerInternal(activeState.run.activeWorkItemId, false, false).pipe(
						Effect.catch(() => this.closeWorkerInternal(activeState.run.activeWorkItemId!, true, false)),
					);
				} else {
					yield* this.detachUnverifiedWorkerInternal(activeState.run.activeWorkItemId, inspection.message ?? inspection.state);
				}
			}
			const current = yield* this.requireRun();
			const phase = current.phase === "failed" ? "stopped" as const : yield* transitionRun(current.phase, "stopped");
			const stopped = yield* this.persist(
				{ ...current, phase, updatedAt: this.now().toISOString() },
				"run-stopped",
				{ from: current.phase },
			);
			this.lastStopped = stopped;
			return stopped;
		}).pipe(Effect.ensuring(Effect.sync(() => {
			const state = this.active;
			if (state) return this.release(state);
			return Effect.void;
		}).pipe(Effect.flatten))));
	}

	shutdown() {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const activeState = this.active;
			if (!activeState) return;
			yield* activeState.protocol?.shutdown() ?? Effect.void;
			delete activeState.protocol;
			delete activeState.workerToken;
			yield* this.release(activeState);
		}));
	}

	status() {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const activeState = this.active!;
			const events = yield* replayEvents(activeState.paths.eventsFile).pipe(Effect.catch(() => Effect.succeed([])));
			return boundStatusOutput(JSON.stringify({ run: active, recentEvents: events.slice(-20) }, null, 2));
		});
	}

	private requireRun() {
		return this.active
			? Effect.succeed(this.active.run)
			: Effect.fail(new Error("No active Ticket Flow run."));
	}

	private requirePlanningRun() {
		return Effect.gen({ self: this }, function* () {
			const run = yield* this.requireRun();
			if (run.phase === "paused") return yield* Effect.fail(new Error("Ticket Flow is paused."));
			if (run.phase === "ready") return yield* Effect.fail(new Error("The Ticket Flow plan is already finalized."));
			if (run.phase !== "analyzing" && run.phase !== "awaiting-user") {
				return yield* Effect.fail(new Error(`Cannot modify a plan while the run is ${run.phase}.`));
			}
			return run;
		});
	}
}
