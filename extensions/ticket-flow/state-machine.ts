import { Effect } from "effect";
import type { RunPhase, WorkflowPlan, WorkflowRun, WorkItem, WorkItemStatus } from "./domain.ts";
import { THINKING_LEVELS } from "./domain.ts";
import { IllegalTransitionError, ValidationError } from "./errors.ts";

const RUN_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
	analyzing: ["awaiting-user", "ready", "paused", "failed", "stopped"],
	"awaiting-user": ["analyzing", "ready", "paused", "failed", "stopped"],
	ready: ["executing", "paused", "failed", "stopped"],
	executing: ["completed", "paused", "failed", "stopped"],
	paused: ["analyzing", "awaiting-user", "ready", "executing", "completed", "failed", "stopped"],
	completed: [],
	failed: [],
	stopped: [],
};

const ITEM_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
	planned: ["ready"],
	ready: ["spawning"],
	spawning: ["verifying-worker", "failed", "interrupted"],
	"verifying-worker": ["running", "failed", "interrupted"],
	running: ["report-pending", "blocked", "failed", "interrupted"],
	"report-pending": ["report-review", "failed", "interrupted"],
	"report-review": ["completed", "report-revision", "failed", "interrupted"],
	"report-revision": ["running", "failed", "interrupted"],
	blocked: ["running", "failed", "interrupted"],
	completed: [],
	failed: [],
	interrupted: ["ready"],
};

export function transitionRun(from: RunPhase, to: RunPhase) {
	if (from === to) return Effect.succeed(to);
	return RUN_TRANSITIONS[from].includes(to)
		? Effect.succeed(to)
		: Effect.fail(new IllegalTransitionError({ entity: "run", from, to }));
}

export function transitionWorkItem(from: WorkItemStatus, to: WorkItemStatus) {
	if (from === to) return Effect.succeed(to);
	return ITEM_TRANSITIONS[from].includes(to)
		? Effect.succeed(to)
		: Effect.fail(new IllegalTransitionError({ entity: "work-item", from, to }));
}

const ACTIVE_WORKER_STATUSES = new Set<WorkItemStatus>([
	"spawning",
	"verifying-worker",
	"running",
	"report-pending",
	"report-review",
	"report-revision",
	"blocked",
]);

function fail(message: string, path?: string): Effect.Effect<never, ValidationError> {
	return Effect.fail(new ValidationError(path === undefined ? { message } : { message, path }));
}

function validateItem(item: WorkItem, ids: ReadonlySet<string>): Effect.Effect<void, ValidationError> {
	if (!item.id.trim()) return fail("work-item ID must not be empty", "id");
	if (!Number.isSafeInteger(item.order) || item.order < 0) return fail("order must be a non-negative integer", item.id);
	if (new Set(item.dependsOn).size !== item.dependsOn.length) return fail("dependency IDs must be unique", item.id);
	for (const dependency of item.dependsOn) {
		if (!ids.has(dependency)) return fail(`missing dependency: ${dependency}`, item.id);
		if (dependency === item.id) return fail("work item cannot depend on itself", item.id);
	}
	return Effect.void;
}

function findDependencyCycle(items: readonly WorkItem[]): readonly string[] | undefined {
	const dependencies = new Map(items.map((item) => [item.id, item.dependsOn] as const));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string, trail: readonly string[]): readonly string[] | undefined => {
		if (visiting.has(id)) return [...trail, id];
		if (visited.has(id)) return undefined;
		visiting.add(id);
		for (const dependency of dependencies.get(id) ?? []) {
			const cycle = visit(dependency, [...trail, id]);
			if (cycle) return cycle;
		}
		visiting.delete(id);
		visited.add(id);
		return undefined;
	};
	for (const item of items) {
		const cycle = visit(item.id, []);
		if (cycle) return cycle;
	}
	return undefined;
}

function validateFinalizedItem(item: WorkItem): Effect.Effect<void, ValidationError> {
	if (!item.id.trim() || !item.title.trim()) return fail("finalized item must have an identity", item.id);
	if (!item.orderReason.trim()) return fail("finalized item must explain its order", item.id);
	if (item.requirements.length === 0 || item.requirements.some((requirement) => !requirement.trim())) {
		return fail("finalized item must have requirements", item.id);
	}
	if (!item.delegationPrompt.trim()) return fail("finalized item must have a delegation prompt", item.id);
	if (!item.launchProfile?.model || !item.launchProfile.thinking) {
		return fail("finalized item must have an explicit model and thinking level", item.id);
	}
	const model = item.launchProfile.model.trim();
	if (!/^[^/\s]+\/[^/\s]+$/.test(model) || model !== item.launchProfile.model) {
		return fail("model must be an exact provider/model identifier", item.id);
	}
	if (!THINKING_LEVELS.includes(item.launchProfile.thinking)) return fail("unsupported thinking level", item.id);
	if (!item.completionStrategy) return fail("finalized item must have a completion strategy", item.id);
	const strategy = item.completionStrategy;
	if ((strategy.type === "append-markdown" || strategy.type === "frontmatter") && !strategy.path.trim()) {
		return fail("completion strategy target path must not be empty", item.id);
	}
	if (strategy.type === "frontmatter" && !strategy.field.trim()) return fail("frontmatter completion field must not be empty", item.id);
	if ((strategy.type === "rename-file" || strategy.type === "move-file") && (!strategy.from.trim() || !strategy.to.trim())) {
		return fail("file completion source and destination must not be empty", item.id);
	}
	return Effect.void;
}

export function validatePlan(plan: WorkflowPlan): Effect.Effect<void, ValidationError> {
	return Effect.gen(function* () {
		const ids = plan.workItems.map((item) => item.id);
		if (new Set(ids).size !== ids.length) return yield* fail("work-item IDs must be unique", "workItems");
		const orders = plan.workItems.map((item) => item.order);
		if (new Set(orders).size !== orders.length) return yield* fail("work-item order values must be unique", "workItems");
		const idSet = new Set(ids);
		for (const item of plan.workItems) yield* validateItem(item, idSet);
		const cycle = findDependencyCycle(plan.workItems);
		if (cycle) return yield* fail(`dependency cycle: ${cycle.join(" -> ")}`, "workItems");

		const byId = new Map(plan.workItems.map((item) => [item.id, item] as const));
		for (const item of plan.workItems) {
			for (const dependencyId of item.dependsOn) {
				const dependency = byId.get(dependencyId);
				if (dependency && dependency.order >= item.order) {
					return yield* fail(`dependency ${dependencyId} must precede ${item.id}`, item.id);
				}
				if (item.status === "ready" && dependency?.status !== "completed") {
					return yield* fail(`ready item requires completed dependency: ${dependencyId}`, item.id);
				}
			}
		}
		if (plan.finalized) {
			if (plan.workItems.length === 0) return yield* fail("finalized plan must contain at least one work item", "workItems");
			for (const item of plan.workItems) yield* validateFinalizedItem(item);
		}
		const active = plan.workItems.filter((item) => ACTIVE_WORKER_STATUSES.has(item.status));
		if (active.length > 1) return yield* fail("only one work item may have an active worker", "workItems");
	});
}

export function validateRun(run: WorkflowRun): Effect.Effect<void, ValidationError> {
	return Effect.gen(function* () {
		yield* validatePlan(run.plan);
		if (["ready", "executing", "completed"].includes(run.phase) && !run.plan.finalized) {
			return yield* fail(`${run.phase} run must have a finalized plan`, "plan.finalized");
		}
		if (run.plan.finalized && run.planning.unresolvedQuestions.length > 0) {
			return yield* fail("finalized plan cannot have unresolved questions", "planning.unresolvedQuestions");
		}
		if (run.planning.unresolvedQuestions.some((question) => !question.trim())) {
			return yield* fail("unresolved questions must not be empty", "planning.unresolvedQuestions");
		}
		if (new Set(run.planning.unresolvedQuestions).size !== run.planning.unresolvedQuestions.length) {
			return yield* fail("unresolved questions must be unique", "planning.unresolvedQuestions");
		}
		const byId = new Map(run.plan.workItems.map((item) => [item.id, item] as const));
		if (run.activeWorkItemId !== undefined && !byId.has(run.activeWorkItemId)) {
			return yield* fail("active work-item ID must reference an existing item", "activeWorkItemId");
		}
		if (run.requestedLaunchProfile !== undefined) {
			if (run.activeWorkItemId === undefined) return yield* fail("requested launch profile requires an active work item", "requestedLaunchProfile");
			const activeItem = byId.get(run.activeWorkItemId);
			if (activeItem?.launchProfile?.model !== run.requestedLaunchProfile.model
				|| activeItem.launchProfile.thinking !== run.requestedLaunchProfile.thinking) {
				return yield* fail("requested launch profile must match the active work item", "requestedLaunchProfile");
			}
		}
		if (run.workflowSocketPath !== undefined) {
			if (!run.workflowSocketPath.startsWith("/") || run.workflowSocketPath.startsWith(`${run.projectPath}/`)) {
				return yield* fail("workflow socket path must be absolute and outside the project", "workflowSocketPath");
			}
			if (run.activeWorkItemId === undefined) return yield* fail("workflow socket path requires an active work item", "workflowSocketPath");
		}
		if (run.tmux !== undefined) {
			if (run.tmux.runId !== run.id) return yield* fail("tmux run ID does not match the run", "tmux.runId");
			if (run.tmux.workItemId !== run.activeWorkItemId) return yield* fail("tmux handle must match the active work item", "tmux.workItemId");
			if (!run.tmux.serverSocketPath.startsWith("/") || !/^\$\d+$/.test(run.tmux.sessionId) || !/^@\d+$/.test(run.tmux.windowId) || !/^%\d+$/.test(run.tmux.paneId)) {
				return yield* fail("tmux handle contains invalid stable IDs", "tmux");
			}
		}
		if (run.worker !== undefined) {
			if (run.worker.runId !== run.id) return yield* fail("worker run ID does not match the run", "worker.runId");
			if (!byId.has(run.worker.workItemId)) return yield* fail("worker work-item ID must reference an existing item", "worker.workItemId");
			if (run.activeWorkItemId !== run.worker.workItemId) {
				return yield* fail("worker must match the active work item", "worker.workItemId");
			}
		}
		const activeItems = run.plan.workItems.filter((item) => ACTIVE_WORKER_STATUSES.has(item.status));
		if (activeItems.length === 1 && run.activeWorkItemId !== activeItems[0]?.id) {
			return yield* fail("active worker state must match the run's active work item", "activeWorkItemId");
		}
		const ownedTerminalItem = run.activeWorkItemId !== undefined && (byId.get(run.activeWorkItemId)?.status === "completed" || byId.get(run.activeWorkItemId)?.status === "failed");
		if (activeItems.length === 0 && !ownedTerminalItem && (run.requestedLaunchProfile !== undefined || run.workflowSocketPath !== undefined || run.tmux !== undefined)) {
			return yield* fail("worker launch metadata requires an active work-item state", "activeWorkItemId");
		}
	});
}

export function normalizePlan(plan: WorkflowPlan): WorkflowPlan {
	return {
		...plan,
		workItems: [...plan.workItems]
			.map((item) => item.completionStrategy === undefined
				? { ...item, completionStrategy: { type: "ledger-only" as const } }
				: item)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
	};
}
