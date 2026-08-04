import { Effect, Exit, Result, Scope, Semaphore } from "effect";
import type {
	CompletionRecord,
	PlanChange,
	PlanningDetails,
	ProgressionCheckpoint,
	WorkflowBlocker,
	WorkflowPlan,
	WorkflowRun,
	WorkItem,
} from "./domain.ts";
import { createRunId } from "./domain.ts";
import { appendEvent, makeWorkflowEvent, replayEvents } from "./event-store.ts";
import { acquireProjectLock, recoverProjectLock, type ProjectLock } from "./lock.ts";
import { pathsForProject, type WorkflowPaths } from "./paths.ts";
import { normalizePlan, transitionRun, transitionWorkItem, validatePlan } from "./state-machine.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { loadRun, saveRun } from "./state-store.ts";
import { TmuxController } from "./tmux/controller.ts";
import { readWorkflowToken, removeWorkflowToken, workflowSocketPath, writeWorkflowToken } from "./protocol/runtime.ts";
import { ProtocolServer, type ProtocolRejection } from "./protocol/server.ts";
import type { WorkflowProtocolEvent } from "./protocol/messages.ts";
import { makeAuthoritativeWorkerContext, requirementId } from "./worker/context.ts";
import { persistReportAttempt, persistAcceptedReport, readLatestReportAttempt, readReportAttempt, validateWorkerReport } from "./worker/report.ts";
import { applyCompletionStrategy, type CompletionApplicationResult } from "./completion.ts";
import { discoverUnfinishedRuns, reconcileRecovery, type RecoveryDiscovery, type RecoveryReconciliation } from "./recovery.ts";

export const WORKFLOW_TOOL_NAMES = [
	"workflow_plan",
	"workflow_worker",
	"workflow_review_report",
	"workflow_control",
] as const;

const READ_ONLY_TOOL_NAMES = new Set([
	"read", "grep", "find", "ls", "rg", "fd", "find_docs", "github_get", "github_comments",
	"web_search", "source_check", "fetch_content", "get_search_content", "ask_me",
]);
const MAX_STATUS_BYTES = 50 * 1024;
const MAX_STATUS_LINES = 2_000;

export interface WorkflowControllerPi {
	readonly getActiveTools: () => string[];
	readonly setActiveTools: (names: string[]) => void;
}

export interface StartRunInput {
	readonly cwd: string;
	readonly prompt: string;
	readonly sessionId?: string;
	readonly agentDir?: string;
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

function applyPlanChange(plan: WorkflowPlan, planning: PlanningDetails, change: PlanChange): {
	readonly plan: WorkflowPlan;
	readonly unresolvedQuestions: readonly string[];
} {
	switch (change.type) {
		case "set-summary":
			return { plan: { ...plan, summary: change.summary, finalized: false }, unresolvedQuestions: planning.unresolvedQuestions };
		case "upsert-work-item": {
			const workItems = plan.workItems.some((item) => item.id === change.workItem.id)
				? plan.workItems.map((item) => item.id === change.workItem.id ? change.workItem : item)
				: [...plan.workItems, change.workItem];
			return { plan: { ...plan, workItems, finalized: false }, unresolvedQuestions: planning.unresolvedQuestions };
		}
		case "remove-work-item":
			return {
				plan: { ...plan, workItems: plan.workItems.filter((item) => item.id !== change.workItemId), finalized: false },
				unresolvedQuestions: planning.unresolvedQuestions,
			};
		case "set-user-resolutions":
			return { plan: { ...plan, userResolutions: change.userResolutions, finalized: false }, unresolvedQuestions: planning.unresolvedQuestions };
		case "set-unresolved-questions":
			return { plan: { ...plan, finalized: false }, unresolvedQuestions: unique(change.questions.map((question) => question.trim())) };
	}
}

export class WorkflowController {
	private active: ActiveRun | undefined;
	private lastStopped: WorkflowRun | undefined;
	/** All progression decisions and transport callbacks share this permit. */
	private readonly coordinator = Semaphore.makeUnsafe(1);

	constructor(
		private readonly pi: WorkflowControllerPi,
		private readonly now: () => Date = () => new Date(),
		private readonly newRunId: () => string = createRunId,
		private readonly tmux = new TmuxController(),
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

	/** Select the first dependency-ready item in finalized order. */
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

	/** Backwards-friendly short name used by orchestration callers. */
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
		return Effect.gen(function* () {
			yield* saveRun(active.paths, next);
			const event = yield* makeWorkflowEvent(next.id, eventType, data);
			yield* appendEvent(active.paths.eventsFile, event);
			active.run = next;
			return next;
		});
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
				const timestamp = this.now().toISOString();
				const run: WorkflowRun = {
					id: runId,
					projectId: resolved.paths.projectId,
					projectPath: resolved.canonicalProjectPath,
					originalPrompt: input.prompt,
					...(input.sessionId === undefined ? {} : { orchestratorSessionId: input.sessionId }),
					phase: "analyzing",
					createdAt: timestamp,
					updatedAt: timestamp,
					plan: emptyPlan(),
					planning: { unresolvedQuestions: [], changes: [], previousActiveTools, restrictedActiveTools },
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
			const normalized = normalizePlan({ ...plan, finalized: false });
			yield* validatePlan(normalized);
			const unresolvedQuestions = unique(questions.map((question) => question.trim()));
			if (unresolvedQuestions.some((question) => !question)) {
				return yield* Effect.fail(new Error("Unresolved questions must not be empty."));
			}
			const phase = unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing";
			const next: WorkflowRun = {
				...active,
				phase,
				updatedAt: this.now().toISOString(),
				plan: normalized,
				planning: { ...active.planning, unresolvedQuestions },
			};
			return yield* this.persist(next, "plan-saved", {
				workItemCount: normalized.workItems.length,
				unresolvedQuestionCount: unresolvedQuestions.length,
			});
		});
	}

	updatePlan(changes: readonly PlanChange[]) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requirePlanningRun();
			if (changes.length === 0) return yield* Effect.fail(new Error("workflow_plan update requires at least one change."));
			let nextPlan = active.plan;
			let unresolvedQuestions = active.planning.unresolvedQuestions;
			for (const change of changes) {
				const applied = applyPlanChange(nextPlan, { ...active.planning, unresolvedQuestions }, change);
				nextPlan = applied.plan;
				unresolvedQuestions = applied.unresolvedQuestions;
			}
			nextPlan = normalizePlan(nextPlan);
			yield* validatePlan(nextPlan);
			const timestamp = this.now().toISOString();
			const next: WorkflowRun = {
				...active,
				phase: unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing",
				updatedAt: timestamp,
				plan: nextPlan,
				planning: {
					...active.planning,
					unresolvedQuestions,
					changes: [...active.planning.changes, ...changes.map((change) => ({ timestamp, change }))],
				},
			};
			return yield* this.persist(next, "plan-updated", { changes });
		});
	}

	startWorker(workItemId: string) {
		return this.serialize(this.startWorkerInternal(workItemId));
	}

	private startWorkerInternal(workItemId: string) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (!active.plan.finalized || (active.phase !== "ready" && active.phase !== "executing")) {
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
			let status = item.status;
			if (status === "planned" || status === "interrupted") status = yield* transitionWorkItem(status, "ready");
			if (status !== "ready") return yield* Effect.fail(new Error(`Work item ${workItemId} cannot start while ${status}.`));
			status = yield* transitionWorkItem(status, "spawning");
			const phase = active.phase === "ready" ? yield* transitionRun(active.phase, "executing") : active.phase;
			const spawningItem = { ...item, status };
			const spawning: WorkflowRun = {
				...active,
				phase,
				updatedAt: this.now().toISOString(),
				activeWorkItemId: workItemId,
				requestedLaunchProfile: { model: item.launchProfile.model, thinking: item.launchProfile.thinking },
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === workItemId ? spawningItem : candidate) },
			};
			yield* this.persist(spawning, "worker-spawning", { workItemId, requestedLaunchProfile: spawning.requestedLaunchProfile });
			const activeState = this.active!;
			const socketPath = workflowSocketPath(active.id);
			const socketRun: WorkflowRun = { ...spawning, workflowSocketPath: socketPath };
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
			const server = new ProtocolServer({
				socketPath,
				runId: active.id,
				workItemId,
				token,
				profile: socketRun.requestedLaunchProfile!,
				onEvent: (event) => Effect.runPromise(this.receiveProtocolEvent(event)),
				onAcknowledgement: (receipt) => Effect.runPromise(this.acknowledgeProtocolCommand(receipt.requestId)),
				onRejected: (rejection) => Effect.runPromise(this.rejectProtocolWorker(rejection)),
			});
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
				updatedAt: this.now().toISOString(),
				tmux: handle,
				plan: { ...socketRun.plan, workItems: socketRun.plan.workItems.map((candidate) => candidate.id === workItemId ? verifyingItem : candidate) },
			};
			return yield* this.persist(verifying, "worker-window-created", { workItemId, handle }).pipe(
				Effect.onError(() => this.tmux.closeWindow(handle, true).pipe(Effect.catch(() => Effect.void))),
			);
		});
	}

	private startRecoveredProtocol(activeState: ActiveRun) {
		return Effect.gen({ self: this }, function* () {
			const run = activeState.run;
			if (activeState.protocol || !run.activeWorkItemId || !run.requestedLaunchProfile || !run.workflowSocketPath) return;
			const token = yield* readWorkflowToken(activeState.paths.runDir);
			activeState.workerToken = token;
			const server = new ProtocolServer({
				socketPath: run.workflowSocketPath,
				runId: run.id,
				workItemId: run.activeWorkItemId,
				token,
				profile: run.requestedLaunchProfile,
				onEvent: (event) => Effect.runPromise(this.receiveProtocolEvent(event)),
				onAcknowledgement: (receipt) => Effect.runPromise(this.acknowledgeProtocolCommand(receipt.requestId)),
				onRejected: (rejection) => Effect.runPromise(this.rejectProtocolWorker(rejection)),
			});
			yield* server.start();
			yield* Scope.addFinalizer(activeState.scope, server.shutdown());
			activeState.protocol = server;
		});
	}

	private rejectProtocolWorker(rejection: ProtocolRejection) {
		return this.serialize(this.rejectProtocolWorkerInternal(rejection));
	}

	private rejectProtocolWorkerInternal(rejection: ProtocolRejection) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const workItemId = active.activeWorkItemId;
			const item = workItemId === undefined ? undefined : active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item || item.status !== "verifying-worker") {
				const event = yield* makeWorkflowEvent(active.id, "worker-profile-rejected", { reason: rejection.reason });
				yield* appendEvent(this.active!.paths.eventsFile, event);
				return;
			}
			const next: WorkflowRun = {
				...active,
				phase: yield* transitionRun(active.phase, "paused"),
				updatedAt: this.now().toISOString(),
			};
			yield* this.persist(next, "worker-profile-rejected", {
				reason: rejection.reason,
				...(rejection.actual === undefined ? {} : {
					actual: {
						provider: rejection.actual.provider,
						model: rejection.actual.model,
						thinking: rejection.actual.thinking,
						runId: rejection.actual.runId,
						workItemId: rejection.actual.workItemId,
					},
				}),
			});
		});
	}

	private acknowledgeProtocolCommand(requestId: string) {
		return this.serialize(this.acknowledgeProtocolCommandInternal(requestId));
	}

	private acknowledgeProtocolCommandInternal(requestId: string) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const commands = active.protocolCommands ?? [];
			const command = commands.find((candidate) => candidate.requestId === requestId);
			if (!command || command.acknowledged) return;
			const next: WorkflowRun = {
				...active,
				updatedAt: this.now().toISOString(),
				protocolCommands: commands.map((candidate) => candidate.requestId === requestId ? { ...candidate, acknowledged: true } : candidate),
			};
			yield* this.persist(next, "worker-command-acknowledged", { requestId, type: command.type, messageId: command.messageId });
		});
	}

	/** Single adapter from validated transport messages to persisted workflow events. */
	private receiveProtocolEvent(event: WorkflowProtocolEvent) {
		return this.serialize(this.receiveProtocolEventInternal(event));
	}

	private receiveProtocolEventInternal(event: WorkflowProtocolEvent) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
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
					yield* this.persist({ ...active, phase: pausedPhase, updatedAt: this.now().toISOString() }, "worker-session-rejected", {
						workItemId: event.identity.workItemId,
						expectedSessionId: active.worker.sessionId,
						actualSessionId: event.identity.sessionId,
					});
					return yield* Effect.fail(new Error("Reconnecting worker Pi session identity does not match the persisted worker."));
				}
				if (!item || !["verifying-worker", "running", "report-pending", "report-review", "report-revision", "blocked"].includes(item.status)) {
					return yield* Effect.fail(new Error("Worker connection arrived in an invalid workflow state."));
				}
				const server = this.active?.protocol;
				if (!server) return yield* Effect.fail(new Error("Native protocol server disappeared before delegation."));
				if (item.status === "running" || item.status === "report-review" || item.status === "report-pending" || item.status === "report-revision" || item.status === "blocked") {
					const reconnectedPhase = item.status === "blocked"
						? "paused" as const
						: active.phase === "paused" ? yield* transitionRun(active.phase, "executing") : active.phase;
					yield* this.persist({ ...active, phase: reconnectedPhase, worker: event.identity, updatedAt: this.now().toISOString() }, "worker-reconnected", {
						workItemId: item.id, messageId: event.messageId, sessionId: event.identity.sessionId,
					});
					const pendingDelegate = (active.protocolCommands ?? []).find((command) => command.type === "delegate" && !command.acknowledged);
					if (pendingDelegate && item.status === "running") {
						const context = makeAuthoritativeWorkerContext(active, item, event.identity);
						server.send("delegate", { prompt: item.delegationPrompt, context, requestId: pendingDelegate.requestId }, pendingDelegate.messageId);
					}
					return;
				}
				const delegate = { type: "delegate" as const, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), acknowledged: false };
				const running = { ...item, status: yield* transitionWorkItem(item.status, "running") };
				const next: WorkflowRun = {
					...active,
					phase: active.phase === "paused" ? yield* transitionRun(active.phase, "executing") : active.phase,
					updatedAt: this.now().toISOString(),
					worker: event.identity,
					protocolCommands: [...(active.protocolCommands ?? []), delegate],
					plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === item.id ? running : candidate) },
				};
				yield* this.persist(next, "worker-profile-verified", {
					workItemId: item.id, requestedLaunchProfile: active.requestedLaunchProfile,
					actualLaunchProfile: { provider: event.identity.provider, model: event.identity.model, thinking: event.identity.thinking },
				});
				const context = makeAuthoritativeWorkerContext(next, item, event.identity);
				server.send("delegate", { prompt: item.delegationPrompt, context, requestId: delegate.requestId }, delegate.messageId);
				return;
			}
			const state = this.active;
			if (!state || active.activeWorkItemId !== event.workItemId) return yield* Effect.fail(new Error("Worker event does not match the active work item."));
			const item = active.plan.workItems.find((candidate) => candidate.id === event.workItemId);
			if (!item) return yield* Effect.fail(new Error("Worker event references an unknown work item."));
			if (event.type === "worker-ready" || event.type === "worker-shutdown") {
				const workflowEvent = yield* makeWorkflowEvent(active.id, event.type, { workItemId: event.workItemId, messageId: event.messageId });
				yield* appendEvent(state.paths.eventsFile, workflowEvent);
				return;
			}
			const report = event.payload.report;
			const requirements = item.requirements.map((requirement, index) => ({ id: requirementId(index), requirement }));
			const validation = validateWorkerReport(report, requirements);
			if (event.type === "worker-progress") {
				const workflowEvent = yield* makeWorkflowEvent(active.id, event.type, { workItemId: event.workItemId, payload: event.payload, messageId: event.messageId });
				yield* appendEvent(state.paths.eventsFile, workflowEvent);
				return;
			}
			if (!active.worker || !active.requestedLaunchProfile) return yield* Effect.fail(new Error("Final report arrived without authenticated worker launch metadata."));
			const persisted = yield* persistReportAttempt({
				paths: state.paths,
				runId: active.id,
				workItemId: item.id,
				submittedAt: this.now().toISOString(),
				identity: active.worker,
				requestedLaunchProfile: active.requestedLaunchProfile,
				report,
			});
			let status = item.status;
			if (event.type === "worker-report") {
				// A worker may submit a newer attempt before the orchestrator has
				// reviewed the previous one. Keep the item reviewable and retain both
				// immutable attempts on disk.
				if (status === "running" || status === "report-revision") {
					if (status === "report-revision") status = yield* transitionWorkItem(status, "running");
					status = yield* transitionWorkItem(status, "report-pending");
					status = yield* transitionWorkItem(status, "report-review");
				}
			} else if (event.type === "worker-blocked") {
				if (status !== "blocked") status = yield* transitionWorkItem(status, "blocked");
			} else if (event.type === "worker-failed") {
				// Keep the owned worker metadata until an explicit close/stop. This
				// makes the failure report observable and still allows its transport
				// acknowledgement to be delivered safely.
				if (status !== "failed") status = yield* transitionWorkItem(status, "failed");
			}
			const blockerQuestions = report.questions ?? [];
			const blockerMessage = report.blockers?.join("; ") ?? report.summary;
			const blocker: WorkflowBlocker | undefined = event.type === "worker-blocked"
				? { workItemId: item.id, message: blockerMessage, questions: blockerQuestions, reportedAt: this.now().toISOString() }
				: undefined;
			const phase = event.type === "worker-blocked"
				? yield* transitionRun(active.phase, "paused")
				: event.type === "worker-failed"
					? yield* transitionRun(active.phase, "failed")
					: active.phase;
			const next: WorkflowRun = {
				...active,
				phase,
				updatedAt: this.now().toISOString(),
				...(blocker === undefined ? {} : { blockers: [...(active.blockers ?? []), blocker] }),
				plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === item.id ? { ...candidate, status } : candidate) },
			};
			yield* this.persist(next, event.type, {
				workItemId: event.workItemId,
				messageId: event.messageId,
				reportAttempt: persisted.attempt.attempt,
				reportFile: persisted.path,
				validation,
			});
		});
	}

	waitWorker(workItemId: string, until: "connected" | "ready" | "progress" | "report" | "blocked" | "idle" | "exit" | "any" = "any", signal?: AbortSignal, timeoutMs?: number) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (until === "idle") return yield* Effect.fail(new Error("workflow_worker wait until idle is not available in the native protocol; use a worker event."));
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

	private continueAfterCompletedInternal(workItemId: string) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.activeWorkItemId !== undefined && active.activeWorkItemId !== workItemId) return active;
			if (active.activeWorkItemId === workItemId) {
				if (!active.tmux) return yield* Effect.fail(new Error(`Completed work item ${workItemId} still has no persisted tmux handle.`));
				yield* this.closeWorkerInternal(workItemId, false, true);
			}
			const afterClose = yield* this.requireRun();
			// A user pause is an explicit request not to start the next worker.
			const next = afterClose.phase === "paused" ? undefined : this.nextReadyWorkItem();
			if (next) {
				const nextCheckpoint: ProgressionCheckpoint = {
					operation: "accept",
					stage: "next-delegating",
					workItemId: next.id,
					updatedAt: this.now().toISOString(),
				};
				yield* this.persist({ ...afterClose, updatedAt: nextCheckpoint.updatedAt, progression: nextCheckpoint }, "next-worker-delegating", { completedWorkItemId: workItemId, nextWorkItemId: next.id });
				const delegation = yield* Effect.result(this.startWorkerInternal(next.id));
				if (Result.isFailure(delegation)) {
					const currentAfterFailure = yield* this.requireRun();
					const failedRun: WorkflowRun = {
						...currentAfterFailure,
						phase: yield* transitionRun(currentAfterFailure.phase, "failed"),
						updatedAt: this.now().toISOString(),
					};
					yield* this.persist(failedRun, "next-worker-failed", { workItemId: next.id, message: errorMessage(delegation.failure) });
					return yield* Effect.fail(delegation.failure);
				}
				return delegation.success;
			}

			const incomplete = afterClose.plan.workItems.filter((item) => item.status !== "completed");
			if (incomplete.length > 0) {
				const failedItems = incomplete.filter((item) => item.status === "failed");
				const phase = failedItems.length > 0
					? yield* transitionRun(afterClose.phase, "failed")
					: yield* transitionRun(afterClose.phase, "paused");
				const checkpoint: ProgressionCheckpoint = {
					operation: "accept",
					stage: failedItems.length > 0 ? "progression-failed" : "progression-paused",
					workItemId,
					updatedAt: this.now().toISOString(),
				};
				return yield* this.persist({ ...afterClose, phase, updatedAt: checkpoint.updatedAt, progression: checkpoint }, failedItems.length > 0 ? "progression-failed" : "progression-paused", {
					completedWorkItemId: workItemId,
					incompleteWorkItemIds: incomplete.map((item) => item.id),
					failedWorkItemIds: failedItems.map((item) => item.id),
				});
			}

			const { progression: _completedProgression, ...withoutProgression } = afterClose;
			const completedRun: WorkflowRun = {
				...withoutProgression,
				phase: yield* transitionRun(afterClose.phase, "completed"),
				updatedAt: this.now().toISOString(),
			};
			const finished = yield* this.persist(completedRun, "run-completed", { completedWorkItemId: workItemId });
			this.lastStopped = finished;
			const state = this.active;
			if (state) yield* this.release(state);
			return finished;
		});
	}

	acceptReport(workItemId: string, comment: string, signal?: AbortSignal) {
		return this.serialize(this.acceptReportInternal(workItemId, comment, signal));
	}

	private acceptReportInternal(workItemId: string, comment: string, signal?: AbortSignal) {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const item = active.plan.workItems.find((candidate) => candidate.id === workItemId);
			if (!item) return yield* Effect.fail(new Error(`Unknown work item: ${workItemId}`));
			// Repeating acceptance after the checkpoint has completed is safe and
			// resumes any interrupted close/advance step without applying a second
			// project mutation.
			if (item.status === "completed" && item.completion) return yield* this.continueAfterCompletedInternal(workItemId);
			if (item.status !== "report-review") return yield* Effect.fail(new Error(`Work item ${workItemId} is not in report-review.`));
			const acceptedComment = nonEmptyText(comment, "Acceptance comment");
			const capturedAttempt = active.progression?.operation === "accept" && active.progression.workItemId === workItemId
				? active.progression.reportAttempt
				: undefined;
			const attempt = capturedAttempt === undefined
				? yield* readLatestReportAttempt(this.active!.paths, workItemId, signal)
				: yield* readReportAttempt(this.active!.paths, workItemId, capturedAttempt, signal);
			if (!attempt) return yield* Effect.fail(new Error(`No worker report exists for ${workItemId}.`));
			if (attempt.report.status !== "completed") return yield* Effect.fail(new Error("Only a completed worker report can be accepted."));
			const requirements = item.requirements.map((requirement, index) => ({ id: requirementId(index), requirement }));
			yield* Effect.try({
				try: () => validateWorkerReport(attempt.report, requirements),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
			const acceptingAt = this.now().toISOString();
			const acceptingCheckpoint: ProgressionCheckpoint = { operation: "accept", stage: "accepting", workItemId, updatedAt: acceptingAt, reportAttempt: attempt.attempt, comment: acceptedComment };
			yield* this.persist({ ...active, updatedAt: acceptingAt, progression: acceptingCheckpoint }, "report-accepting", { workItemId, reportAttempt: attempt.attempt });
			const completedAt = this.now().toISOString();
			const acceptedReportPath = yield* persistAcceptedReport(this.active!.paths, attempt, completedAt, signal);
			const completion: CompletionRecord = {
				acceptedAttempt: attempt.attempt,
				acceptedReportPath,
				comment: acceptedComment,
				completedAt,
				strategy: item.completionStrategy ?? { type: "ledger-only" },
				...(active.worker === undefined ? {} : { worker: active.worker }),
				...(active.requestedLaunchProfile === undefined ? {} : { requestedLaunchProfile: active.requestedLaunchProfile }),
			};
			const acceptedCheckpoint: ProgressionCheckpoint = {
				operation: "accept",
				stage: "report-accepted",
				workItemId,
				updatedAt: completedAt,
				reportAttempt: attempt.attempt,
				comment: acceptedComment,
				completion,
			};
			yield* this.persist({ ...this.active!.run, updatedAt: completedAt, progression: acceptedCheckpoint }, "report-accepted", {
				workItemId, reportAttempt: attempt.attempt, acceptedReportPath, comment: acceptedComment,
			});

			const withCompletion: WorkflowRun = {
				...this.active!.run,
				updatedAt: this.now().toISOString(),
				progression: { ...acceptedCheckpoint, stage: "completion-recorded", updatedAt: this.now().toISOString() },
				plan: {
					...this.active!.run.plan,
					workItems: this.active!.run.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, completion } : candidate),
				},
			};
			yield* this.persist(withCompletion, "completion-recorded", { workItemId, reportAttempt: attempt.attempt });
			const applying: WorkflowRun = {
				...this.active!.run,
				updatedAt: this.now().toISOString(),
				progression: { ...acceptedCheckpoint, stage: "completion-applying", updatedAt: this.now().toISOString() },
			};
			yield* this.persist(applying, "completion-applying", { workItemId, strategy: completion.strategy.type });

			const mutation = yield* Effect.result(applyCompletionStrategy({
				projectPath: active.projectPath,
				runId: active.id,
				workItemId,
				workItemTitle: item.title,
				comment: acceptedComment,
				completedAt,
				strategy: completion.strategy,
			}, undefined, signal));
			if (Result.isFailure(mutation)) {
				const failed: WorkflowRun = {
					...this.active!.run,
					updatedAt: this.now().toISOString(),
					progression: { ...acceptedCheckpoint, stage: "completion-failed", updatedAt: this.now().toISOString() },
				};
				yield* this.persist(failed, "completion-failed", { workItemId, message: errorMessage(mutation.failure) });
				return yield* Effect.fail(mutation.failure);
			}
			const completionResult: CompletionApplicationResult = mutation.success;
			yield* this.persist({
				...this.active!.run,
				updatedAt: this.now().toISOString(),
				progression: { ...acceptedCheckpoint, stage: "completion-applied", updatedAt: this.now().toISOString() },
			}, "completion-applied", { workItemId, changed: completionResult.changed, paths: completionResult.paths });

			const current = this.active!.run;
			const completedStatus = yield* transitionWorkItem(
				current.plan.workItems.find((candidate) => candidate.id === workItemId)!.status,
				"completed",
			);
			const completedItemRun: WorkflowRun = {
				...current,
				updatedAt: this.now().toISOString(),
				progression: { ...acceptedCheckpoint, stage: "worker-closing", updatedAt: this.now().toISOString() },
				plan: {
					...current.plan,
					workItems: current.plan.workItems.map((candidate) => candidate.id === workItemId ? { ...candidate, status: completedStatus, completion } : candidate),
				},
			};
			yield* this.persist(completedItemRun, "work-item-completed", { workItemId, reportAttempt: attempt.attempt });
			return yield* this.continueAfterCompletedInternal(workItemId);
		});
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
			const blocker: WorkflowBlocker = { workItemId, message, questions, reportedAt: this.now().toISOString() };
			const existingBlocker = (active.blockers ?? []).find((candidate) => candidate.workItemId === workItemId && candidate.resolvedAt === undefined && candidate.message === message);
			const blockers = existingBlocker === undefined ? [...(active.blockers ?? []), blocker] : active.blockers;
			const checkpoint: ProgressionCheckpoint = { operation: "block", stage: "blocker-recorded", workItemId, updatedAt: blocker.reportedAt };
			return yield* this.persist({
				...active,
				phase,
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
			const resolutions = questions.map((question, index) => ({ id: `blocker-${workItemId}-${crypto.randomUUID()}`, question: question.trim(), answer: answers[index]!.trim(), resolvedAt }));
			const answerMessage = resolutions.map((resolution) => `Question: ${resolution.question}\nAnswer: ${resolution.answer}`).join("\n\n");
			const checkpoint: ProgressionCheckpoint = { operation: "block", stage: "answers-recorded", workItemId, updatedAt: resolvedAt };
			const resolvedPlan = { ...active.plan, userResolutions: [...active.plan.userResolutions, ...resolutions] };
			const resolutionChange: PlanChange = { type: "set-user-resolutions", userResolutions: resolvedPlan.userResolutions };
			yield* this.persist({
				...active,
				updatedAt: resolvedAt,
				progression: checkpoint,
				planning: { ...active.planning, changes: [...active.planning.changes, { timestamp: resolvedAt, change: resolutionChange }] },
				plan: resolvedPlan,
				blockers: (active.blockers ?? []).map((blocker) => blocker.workItemId === workItemId && blocker.resolvedAt === undefined ? { ...blocker, resolvedAt } : blocker),
			}, "worker-blocker-answers-recorded", { workItemId, questions: questions.map((question) => question.trim()) });
			yield* this.sendWorkerFeedbackInternal(workItemId, answerMessage, "user-answer", undefined, questions, signal);
			const current = yield* this.requireRun();
			const running = yield* transitionWorkItem(item.status, "running");
			const phase = current.phase === "paused" ? yield* transitionRun(current.phase, "executing") : current.phase;
			const { progression: _progression, ...withoutProgression } = current;
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
		if (activeItem?.status === "blocked") return "paused";
		if (run.activeWorkItemId) return "executing";
		if (run.plan.finalized) return "ready";
		return run.planning.unresolvedQuestions.length > 0 ? "awaiting-user" : "analyzing";
	}

	private continueRecoveryInternal(reconciliation: RecoveryReconciliation) {
		return Effect.gen({ self: this }, function* () {
			let active = yield* this.requireRun();
			const activeState = this.active!;
			if (active.activeWorkItemId && reconciliation.tmux?.state === "alive" && !activeState.protocol) {
				yield* this.startRecoveredProtocol(activeState);
			}
			if (reconciliation.kind === "worker-alive-disconnected") {
				const pausedPhase = active.phase === "paused" ? active.phase : yield* transitionRun(active.phase, "paused");
				return yield* this.persist({ ...active, phase: pausedPhase, updatedAt: this.now().toISOString() }, "recovery-awaiting-worker", {
					message: reconciliation.message,
				});
			}
			const target = this.recoveryTargetPhase(active);
			const resumed: WorkflowRun = { ...active, phase: yield* transitionRun(active.phase, target), updatedAt: this.now().toISOString() };
			active = yield* this.persist(resumed, "run-resumed", { reconciliation: reconciliation.kind, targetPhase: target });
			const activeItem = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
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
			if (active.progression?.operation === "accept" && active.progression.comment && currentItem?.status === "report-review") {
				return yield* this.acceptReportInternal(currentItem.id, active.progression.comment);
			}
			if (currentItem?.status === "completed") return yield* this.continueAfterCompletedInternal(currentItem.id);
			if (active.progression?.operation === "close" && active.activeWorkItemId && active.tmux) {
				return (yield* this.closeWorkerInternal(active.activeWorkItemId, false, false)).run;
			}
			if (!active.activeWorkItemId) {
				const next = this.nextReadyWorkItem();
				if (next && active.phase === "ready") return yield* this.startWorkerInternal(next.id);
			}
			return active;
		});
	}

	recover(input: RecoverRunInput) {
		return this.serialize(Effect.gen({ self: this }, function* () {
			if (this.active) return yield* Effect.fail(new Error(`Ticket Flow run ${this.active.run.id} is already active.`));
			const discovery = yield* this.discover(input.cwd, input.agentDir, input.sessionId);
			const candidates = input.runId === undefined ? discovery.runs : discovery.runs.filter((candidate) => candidate.run.id === input.runId);
			if (candidates.length === 0) return yield* Effect.fail(new Error("No recoverable Ticket Flow run exists for this project."));
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
				const reconciliation = yield* reconcileRecovery(recoveredRun, this.tmux, false);
				if (!reconciliation.safe) {
					const pausedPhase = recoveredRun.phase === "paused" || recoveredRun.phase === "failed"
						? recoveredRun.phase
						: yield* transitionRun(recoveredRun.phase, "paused");
					return yield* this.persist({ ...recoveredRun, phase: pausedPhase, updatedAt: this.now().toISOString() }, "recovery-paused", {
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
			if (active.phase !== "paused") return yield* Effect.fail(new Error("workflow_control resume requires an owned paused run."));
			const activeItem = active.activeWorkItemId === undefined ? undefined : active.plan.workItems.find((item) => item.id === active.activeWorkItemId);
			if (activeItem?.status === "blocked") return yield* Effect.fail(new Error("Resolve the active worker blocker before resuming Ticket Flow."));
			const reconciliation = yield* reconcileRecovery(active, this.tmux, this.active?.protocol?.isVerified ?? false);
			if (!reconciliation.safe) return yield* Effect.fail(new Error(`Recovery is ${reconciliation.kind}: ${reconciliation.message}`));
			return yield* this.continueRecoveryInternal(reconciliation);
		}));
	}

	pause() {
		return this.serialize(Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const phase = yield* transitionRun(active.phase, "paused");
			return yield* this.persist(
				{ ...active, phase, updatedAt: this.now().toISOString() },
				"run-paused",
				{ from: active.phase },
			);
		}));
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
				yield* this.closeWorkerInternal(activeState.run.activeWorkItemId, false, false).pipe(
					Effect.catch(() => this.closeWorkerInternal(activeState.run.activeWorkItemId!, true, false)),
				);
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
			// A session reload or orchestrator exit detaches only local resources.
			// The worker, token, tmux window, durable state, and lock remain intact
			// for authenticated recovery by this session or a proven stale takeover.
			yield* activeState.protocol?.shutdown() ?? Effect.void;
			delete activeState.protocol;
			delete activeState.workerToken;
			this.detach(activeState);
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
