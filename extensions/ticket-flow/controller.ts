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
import { normalizePlan, transitionRun, validatePlan } from "./state-machine.ts";
import type { PersistenceError, ValidationError } from "./errors.ts";
import { saveRun } from "./state-store.ts";

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
	) {}

	get activeRun(): WorkflowRun | undefined {
		return this.active?.run;
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
		return activeState ? this.release(activeState) : Effect.void;
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
