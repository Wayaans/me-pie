import { Effect, Exit, Scope } from "effect";
import type {
	PlanChange,
	PlanningDetails,
	WorkflowPlan,
	WorkflowRun,
} from "./domain.ts";
import { createRunId } from "./domain.ts";
import { appendEvent, makeWorkflowEvent, replayEvents } from "./event-store.ts";
import { acquireProjectLock, type ProjectLock } from "./lock.ts";
import { pathsForProject, type WorkflowPaths } from "./paths.ts";
import { normalizePlan, transitionRun, transitionWorkItem, validatePlan } from "./state-machine.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { saveRun } from "./state-store.ts";
import { TmuxController } from "./tmux/controller.ts";
import { readWorkflowToken, removeWorkflowToken, workflowSocketPath, writeWorkflowToken } from "./protocol/runtime.ts";
import { ProtocolServer, type ProtocolRejection } from "./protocol/server.ts";
import type { WorkflowProtocolEvent } from "./protocol/messages.ts";

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

	private release(activeState: ActiveRun) {
		return Effect.gen({ self: this }, function* () {
			if (this.active === activeState) this.active = undefined;
			const previous = activeState.run.planning.previousActiveTools;
			const restricted = activeState.run.planning.restrictedActiveTools;
			if (previous && restricted) restoreToolsConservatively(this.pi, previous, restricted);
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
			if (item.dependsOn.some((dependencyId) => active.plan.workItems.find((candidate) => candidate.id === dependencyId)?.status !== "completed")) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} has incomplete dependencies.`));
			}
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

	private rejectProtocolWorker(rejection: ProtocolRejection) {
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
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (event.type === "worker-connected") {
				if (active.activeWorkItemId !== event.identity.workItemId || !active.requestedLaunchProfile) {
					return yield* Effect.fail(new Error("Authenticated worker does not match the active work item."));
				}
				const item = active.plan.workItems.find((candidate) => candidate.id === event.identity.workItemId);
				if (!item || (item.status !== "verifying-worker" && item.status !== "running")) {
					return yield* Effect.fail(new Error("Worker connection arrived in an invalid workflow state."));
				}
				const server = this.active?.protocol;
				if (!server) return yield* Effect.fail(new Error("Native protocol server disappeared before delegation."));
				if (item.status === "running") {
					const reconnected = yield* makeWorkflowEvent(active.id, "worker-reconnected", { workItemId: item.id, messageId: event.messageId });
					yield* appendEvent(this.active!.paths.eventsFile, reconnected);
					return;
				}
				const delegate = { type: "delegate" as const, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), acknowledged: false };
				const running = { ...item, status: yield* transitionWorkItem(item.status, "running") };
				const next: WorkflowRun = {
					...active,
					updatedAt: this.now().toISOString(),
					worker: event.identity,
					protocolCommands: [...(active.protocolCommands ?? []), delegate],
					plan: { ...active.plan, workItems: active.plan.workItems.map((candidate) => candidate.id === item.id ? running : candidate) },
				};
				yield* this.persist(next, "worker-profile-verified", {
					workItemId: item.id, requestedLaunchProfile: active.requestedLaunchProfile,
					actualLaunchProfile: { provider: event.identity.provider, model: event.identity.model, thinking: event.identity.thinking },
				});
				server.send("delegate", { prompt: item.delegationPrompt, requestId: delegate.requestId }, delegate.messageId);
				return;
			}
			const state = this.active;
			if (!state || active.activeWorkItemId !== event.workItemId) return yield* Effect.fail(new Error("Worker event does not match the active work item."));
			const workflowEvent = yield* makeWorkflowEvent(active.id, event.type, { workItemId: event.workItemId, payload: event.payload, messageId: event.messageId });
			yield* appendEvent(state.paths.eventsFile, workflowEvent);
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
				try: () => waitWithTimeout((waitSignal) => server.wait((candidate) => until === "any" || (until === "connected" && candidate.type === "worker-connected") || (until === "ready" && candidate.type === "worker-ready") || (until === "progress" && candidate.type === "worker-progress") || (until === "report" && candidate.type === "worker-report") || (until === "blocked" && candidate.type === "worker-blocked") || (until === "exit" && candidate.type === "worker-shutdown"), waitSignal), signal, timeoutMs),
				catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
			});
			return boundStatusOutput(JSON.stringify(event));
		});
	}

	sendWorkerFeedback(workItemId: string, message: string, signal?: AbortSignal) {
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
			}, "worker-feedback-sending", { workItemId, requestId: command.requestId, messageId: command.messageId });
			server.send("feedback", { message, requestId: command.requestId }, command.messageId);
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
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			if (active.activeWorkItemId !== workItemId || active.tmux?.workItemId !== workItemId) {
				return yield* Effect.fail(new Error(`Work item ${workItemId} does not own the active tmux window.`));
			}
			const protocol = this.active?.protocol;
			if (protocol?.isVerified) {
				const receipt = protocol.send("shutdown", { requestId: crypto.randomUUID() });
				if (receipt) yield* Effect.tryPromise({
					try: () => waitWithTimeout((waitSignal) => protocol.waitForAcknowledgement(receipt.requestId, waitSignal), undefined, 2_000),
					catch: () => undefined,
				});
			}
			const closeResult = yield* this.tmux.closeWindow(active.tmux, force);
			const currentItem = active.plan.workItems.find((item) => item.id === workItemId)!;
			const status = currentItem.status === "interrupted" ? currentItem.status : yield* transitionWorkItem(currentItem.status, "interrupted");
			const {
				activeWorkItemId: _activeWorkItemId,
				requestedLaunchProfile: _requestedLaunchProfile,
				tmux: _tmux,
				worker: _worker,
				protocolCommands: _protocolCommands,
				...nextBase
			} = active;
			const next: WorkflowRun = {
				...nextBase,
				updatedAt: this.now().toISOString(),
				plan: { ...active.plan, workItems: active.plan.workItems.map((item) => item.id === workItemId ? { ...item, status } : item) },
			};
			if (this.active) {
				delete this.active.workerToken;
				yield* removeWorkflowToken(this.active.paths.runDir);
				yield* this.active.protocol?.shutdown() ?? Effect.void;
				delete this.active.protocol;
			}
			const { workflowSocketPath: _workflowSocketPath, ...withoutSocket } = next;
			const run = yield* this.persist(withoutSocket, "worker-window-closed", { workItemId, ...closeResult });
			return { run, closeResult };
		});
	}

	finalizePlan() {
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

	pause() {
		return Effect.gen({ self: this }, function* () {
			const active = yield* this.requireRun();
			const phase = yield* transitionRun(active.phase, "paused");
			return yield* this.persist(
				{ ...active, phase, updatedAt: this.now().toISOString() },
				"run-paused",
				{ from: active.phase },
			);
		});
	}

	stop() {
		const activeState = this.active;
		if (!activeState) {
			return this.lastStopped
				? Effect.succeed(this.lastStopped)
				: Effect.fail(new Error("No active Ticket Flow run."));
		}
		return Effect.gen({ self: this }, function* () {
			if (activeState.run.tmux && activeState.run.activeWorkItemId) {
				yield* this.closeWorker(activeState.run.activeWorkItemId).pipe(Effect.catch(() => this.closeWorker(activeState.run.activeWorkItemId!, true)));
			}
			const phase = yield* transitionRun(activeState.run.phase, "stopped");
			const stopped = yield* this.persist(
				{ ...activeState.run, phase, updatedAt: this.now().toISOString() },
				"run-stopped",
				{ from: activeState.run.phase },
			);
			this.lastStopped = stopped;
			return stopped;
		}).pipe(Effect.ensuring(this.release(activeState)));
	}

	shutdown() {
		const activeState = this.active;
		if (!activeState) return Effect.void;
		const close = activeState.run.tmux && activeState.run.activeWorkItemId
			? this.tmux.closeWindow(activeState.run.tmux).pipe(
				Effect.catch(() => this.tmux.closeWindow(activeState.run.tmux!, true)),
				Effect.catch(() => Effect.void),
			)
			: Effect.void;
		return close.pipe(Effect.ensuring(activeState.protocol?.shutdown() ?? Effect.void), Effect.ensuring(removeWorkflowToken(activeState.paths.runDir)), Effect.ensuring(this.release(activeState)));
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
