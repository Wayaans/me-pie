import { Effect } from "effect";
import type { WorkflowBlocker, WorkflowRun } from "../domain.ts";
import type { WorkflowProtocolEvent } from "./messages.ts";
import type { PersistenceError, ValidationError } from "../errors.ts";
import { appendEvent, makeWorkflowEvent } from "../event-store.ts";
import { transitionRun, transitionWorkItem } from "../state-machine.ts";
import type { WorkflowPaths } from "../paths.ts";
import { makeAuthoritativeWorkerContext, requirementId } from "../worker/context.ts";
import { persistReportAttempt, validateWorkerReport } from "../worker/report.ts";
import type { ProtocolRejection, ProtocolServer } from "./server.ts";

/** The controller supplies the one serialized persistence boundary. */
export type ProtocolPersist = (
	next: WorkflowRun,
	eventType: string,
	data: unknown,
) => Effect.Effect<WorkflowRun, Error | PersistenceError | ValidationError>;

export interface ProtocolIngestionState {
	readonly run: WorkflowRun;
	readonly paths: WorkflowPaths;
	readonly server: ProtocolServer;
}

export interface ProtocolIngestionDependencies {
	readonly now: () => Date;
	readonly persist: ProtocolPersist;
}

function timestamp(dependencies: ProtocolIngestionDependencies): string {
	return dependencies.now().toISOString();
}

function appendTransportEvent(state: ProtocolIngestionState, event: WorkflowProtocolEvent): Effect.Effect<void, Error | PersistenceError> {
	return Effect.gen(function* () {
		const workflowEvent = yield* makeWorkflowEvent(state.run.id, event.type, {
			workItemId: event.type === "worker-connected" ? event.identity.workItemId : event.workItemId,
			...(event.type === "worker-connected" ? {} : { ...(event.type === "worker-ready" || event.type === "worker-shutdown" ? {} : { payload: event.payload }) }),
			messageId: event.messageId,
		});
		yield* appendEvent(state.paths.eventsFile, workflowEvent);
	});
}

/**
 * Adapt already authenticated native protocol events into durable workflow
 * state. Transport authentication remains in ProtocolServer; this service is
 * only the protocol-to-domain boundary and never owns serialization.
 */
export function ingestProtocolEvent(
	state: ProtocolIngestionState,
	event: WorkflowProtocolEvent,
	dependencies: ProtocolIngestionDependencies,
): Effect.Effect<void, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const active = state.run;
		if (event.type === "worker-connected") {
			if (active.activeWorkItemId !== event.identity.workItemId || !active.requestedLaunchProfile) {
				return yield* Effect.fail(new Error("Authenticated worker does not match the active work item."));
			}
			const item = active.plan.workItems.find((candidate) => candidate.id === event.identity.workItemId);
			if (active.worker && (
				(active.worker.sessionId !== undefined && active.worker.sessionId !== event.identity.sessionId)
				|| (active.worker.sessionFile !== undefined && active.worker.sessionFile !== event.identity.sessionFile)
			)) {
				const pausedPhase = active.phase === "paused" ? active.phase : yield* transitionRun(active.phase, "paused");
				yield* dependencies.persist({
					...active,
					phase: pausedPhase,
					pauseReason: "recovery",
					recoveryIssue: { kind: "worker-session", message: "Reconnecting worker Pi session identity does not match persisted state." },
					updatedAt: timestamp(dependencies),
				}, "worker-session-rejected", {
					workItemId: event.identity.workItemId,
					expectedSessionId: active.worker.sessionId,
					actualSessionId: event.identity.sessionId,
				});
				return yield* Effect.fail(new Error("Reconnecting worker Pi session identity does not match the persisted worker."));
			}
			if (!item || !["verifying-worker", "running", "report-pending", "report-review", "report-revision", "blocked"].includes(item.status)) {
				return yield* Effect.fail(new Error("Worker connection arrived in an invalid workflow state."));
			}
			if (item.status === "running" || item.status === "report-review" || item.status === "report-pending" || item.status === "report-revision" || item.status === "blocked") {
				const shouldResumeRecovery = active.phase === "paused" && active.pauseReason === "recovery";
				const reconnectedPhase = item.status === "blocked" || (active.phase === "paused" && !shouldResumeRecovery)
					? "paused" as const
					: shouldResumeRecovery ? yield* transitionRun(active.phase, "executing") : active.phase;
				const pauseReason = reconnectedPhase === "paused" ? active.pauseReason : undefined;
				const { pauseReason: _pauseReason, recoveryIssue: _recoveryIssue, ...activeWithoutPauseReason } = active;
				const reconnected = yield* dependencies.persist({
					...activeWithoutPauseReason,
					phase: reconnectedPhase,
					...(pauseReason === undefined ? {} : { pauseReason }),
					worker: event.identity,
					updatedAt: timestamp(dependencies),
				}, "worker-reconnected", { workItemId: item.id, messageId: event.messageId, sessionId: event.identity.sessionId });
				const pendingDelegate = (reconnected.protocolCommands ?? []).find((command) => command.type === "delegate" && !command.acknowledged);
				if (pendingDelegate && item.status === "running" && reconnected.phase !== "paused") {
					const context = makeAuthoritativeWorkerContext(reconnected, item, event.identity);
					state.server.send("delegate", { prompt: item.delegationPrompt, context, requestId: pendingDelegate.requestId }, pendingDelegate.messageId);
				}
				return;
			}
			if (active.phase === "paused" && active.pauseReason === "user") {
				yield* dependencies.persist({ ...active, worker: event.identity, updatedAt: timestamp(dependencies) }, "worker-verified-while-paused", {
					workItemId: item.id,
					sessionId: event.identity.sessionId,
				});
				return;
			}
			const delegate = { type: "delegate" as const, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), acknowledged: false };
			const running = { ...item, status: yield* transitionWorkItem(item.status, "running") };
			const { pauseReason: _pauseReason, ...activeWithoutPauseReason } = active;
			const next: WorkflowRun = {
				...activeWithoutPauseReason,
				phase: active.phase === "paused" ? yield* transitionRun(active.phase, "executing") : active.phase,
				updatedAt: timestamp(dependencies),
				progression: { operation: "delegate", stage: "exact-prompt-delivery", workItemId: item.id, updatedAt: timestamp(dependencies) },
				worker: event.identity,
				protocolCommands: [...(active.protocolCommands ?? []), delegate],
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === item.id ? running : candidate) },
			};
			const persisted = yield* dependencies.persist(next, "worker-profile-verified", {
				workItemId: item.id,
				requestedLaunchProfile: active.requestedLaunchProfile,
				actualLaunchProfile: { provider: event.identity.provider, model: event.identity.model, thinking: event.identity.thinking },
			});
			const context = makeAuthoritativeWorkerContext(persisted, item, event.identity);
			state.server.send("delegate", { prompt: item.delegationPrompt, context, requestId: delegate.requestId }, delegate.messageId);
			return;
		}

		if (active.activeWorkItemId !== event.workItemId) return yield* Effect.fail(new Error("Worker event does not match the active work item."));
		const item = active.plan.workItems.find((candidate) => candidate.id === event.workItemId);
		if (!item) return yield* Effect.fail(new Error("Worker event references an unknown work item."));
		if (event.type === "worker-ready" || event.type === "worker-shutdown") {
			yield* appendTransportEvent(state, event);
			return;
		}
		const report = event.payload.report;
		const requirements = item.requirements.map((requirement, index) => ({ id: requirementId(index), requirement }));
		const validation = validateWorkerReport(report, requirements);
		if (event.type === "worker-progress") {
			yield* appendTransportEvent(state, event);
			return;
		}
		if (!active.worker || !active.requestedLaunchProfile) return yield* Effect.fail(new Error("Final report arrived without authenticated worker launch metadata."));
		const persisted = yield* persistReportAttempt({
			paths: state.paths,
			runId: active.id,
			workItemId: item.id,
			submittedAt: timestamp(dependencies),
			identity: active.worker,
			requestedLaunchProfile: active.requestedLaunchProfile,
			report,
		});
		let status = item.status;
		if (event.type === "worker-report") {
			// A newer attempt remains reviewable while retaining earlier immutable attempts.
			if (status === "running" || status === "report-revision") {
				if (status === "report-revision") status = yield* transitionWorkItem(status, "running");
				status = yield* transitionWorkItem(status, "report-pending");
				status = yield* transitionWorkItem(status, "report-review");
			}
		} else if (event.type === "worker-blocked") {
			if (status !== "blocked") status = yield* transitionWorkItem(status, "blocked");
		} else if (event.type === "worker-failed") {
			// Keep worker ownership until explicit close/stop so the failure is observable.
			if (status !== "failed") status = yield* transitionWorkItem(status, "failed");
		}
		const blockerQuestions = report.questions ?? [];
		const blockerMessage = report.blockers?.join("; ") ?? report.summary;
		const blockerAt = timestamp(dependencies);
		const blocker: WorkflowBlocker | undefined = event.type === "worker-blocked"
			? { workItemId: item.id, message: blockerMessage, questions: blockerQuestions, ...(report.userInterventionRequired === undefined ? {} : { userInterventionRequired: report.userInterventionRequired }), reportedAt: blockerAt }
			: undefined;
		const phase = event.type === "worker-blocked"
			? yield* transitionRun(active.phase, "paused")
			: event.type === "worker-failed"
				? yield* transitionRun(active.phase, "failed")
				: active.phase;
		const reportReferences = [...(active.reportReferences ?? []), {
			workItemId: item.id,
			attempt: persisted.attempt.attempt,
			path: persisted.path,
			submittedAt: persisted.attempt.submittedAt,
		}];
		const next: WorkflowRun = {
			...active,
			phase,
			...(event.type === "worker-blocked" ? { pauseReason: "blocker" as const } : {}),
			updatedAt: timestamp(dependencies),
			...(blocker === undefined ? {} : { blockers: [...(active.blockers ?? []), blocker] }),
			reportReferences,
			plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === item.id ? { ...candidate, status } : candidate) },
		};
		yield* dependencies.persist(next, event.type, {
			workItemId: event.workItemId,
			messageId: event.messageId,
			reportAttempt: persisted.attempt.attempt,
			reportFile: persisted.path,
			validation,
		});
	});
}

export function acknowledgeProtocolCommand(
	run: WorkflowRun,
	requestId: string,
	dependencies: ProtocolIngestionDependencies,
): Effect.Effect<void, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const commands = run.protocolCommands ?? [];
		const command = commands.find((candidate) => candidate.requestId === requestId);
		if (!command || command.acknowledged) return;
		const updatedAt = timestamp(dependencies);
		const next: WorkflowRun = {
			...run,
			updatedAt,
			...(command.type === "delegate" && run.progression?.operation === "delegate" ? { progression: { ...run.progression, stage: "delegation-delivered", updatedAt } } : {}),
			protocolCommands: commands.map((candidate) => candidate.requestId === requestId ? { ...candidate, acknowledged: true } : candidate),
		};
		yield* dependencies.persist(next, "worker-command-acknowledged", { requestId, type: command.type, messageId: command.messageId });
	});
}

export function rejectProtocolWorker(
	state: ProtocolIngestionState,
	rejection: ProtocolRejection,
	dependencies: ProtocolIngestionDependencies,
): Effect.Effect<void, Error | PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const active = state.run;
		const workItemId = active.activeWorkItemId;
		const item = workItemId === undefined ? undefined : active.plan.workItems.find((candidate) => candidate.id === workItemId);
		if (!item || item.status !== "verifying-worker") {
			const event = yield* makeWorkflowEvent(active.id, "worker-profile-rejected", { reason: rejection.reason });
			yield* appendEvent(state.paths.eventsFile, event);
			return;
		}
		const next: WorkflowRun = {
			...active,
			phase: yield* transitionRun(active.phase, "paused"),
			pauseReason: "recovery",
			recoveryIssue: { kind: `profile-${rejection.reason}`, message: `Worker profile reconciliation failed: ${rejection.reason}.` },
			updatedAt: timestamp(dependencies),
		};
		yield* dependencies.persist(next, "worker-profile-rejected", {
			reason: rejection.reason,
			...(rejection.actual === undefined ? {} : { actual: {
				provider: rejection.actual.provider,
				model: rejection.actual.model,
				thinking: rejection.actual.thinking,
				runId: rejection.actual.runId,
				workItemId: rejection.actual.workItemId,
			} }),
		});
	});
}
