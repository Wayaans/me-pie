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
import { workflowRuntimeDirectory } from "./tmux/command.ts";
import { TmuxController } from "./tmux/controller.ts";

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
			activeState.workerToken = crypto.randomUUID();
			const socketPath = `${workflowRuntimeDirectory(active.id)}/workflow.sock`;
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
				const failed: WorkflowRun = {
					...failedBase,
					updatedAt: this.now().toISOString(),
					plan: { ...spawning.plan, workItems: spawning.plan.workItems.map((candidate) => candidate.id === workItemId ? failedItem : candidate) },
				};
				delete activeState.workerToken;
				yield* this.persist(failed, "worker-start-failed", { workItemId, message: errorMessage(cause) });
				return yield* Effect.fail(cause);
			})));
			const verifyingItem = { ...spawningItem, status: yield* transitionWorkItem("spawning", "verifying-worker") };
			const verifying: WorkflowRun = {
				...spawning,
				updatedAt: this.now().toISOString(),
				tmux: handle,
				plan: { ...spawning.plan, workItems: spawning.plan.workItems.map((candidate) => candidate.id === workItemId ? verifyingItem : candidate) },
			};
			return yield* this.persist(verifying, "worker-window-created", { workItemId, handle }).pipe(
				Effect.onError(() => this.tmux.closeWindow(handle, true).pipe(Effect.catch(() => Effect.void))),
			);
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
			const closeResult = yield* this.tmux.closeWindow(active.tmux, force);
			const currentItem = active.plan.workItems.find((item) => item.id === workItemId)!;
			const status = currentItem.status === "interrupted" ? currentItem.status : yield* transitionWorkItem(currentItem.status, "interrupted");
			const {
				activeWorkItemId: _activeWorkItemId,
				requestedLaunchProfile: _requestedLaunchProfile,
				tmux: _tmux,
				...nextBase
			} = active;
			const next: WorkflowRun = {
				...nextBase,
				updatedAt: this.now().toISOString(),
				plan: { ...active.plan, workItems: active.plan.workItems.map((item) => item.id === workItemId ? { ...item, status } : item) },
			};
			if (this.active) delete this.active.workerToken;
			const run = yield* this.persist(next, "worker-window-closed", { workItemId, ...closeResult });
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
		return close.pipe(Effect.ensuring(this.release(activeState)));
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
