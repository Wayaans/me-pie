import path from "node:path";
import { Effect } from "effect";
import type { CompletionStrategy, RunPhase, WorkflowPlan, WorkflowRun, WorkItem, WorkItemStatus } from "./domain.ts";
import { THINKING_LEVELS } from "./domain.ts";
import { hasDurableResolution, normalizeQuestion } from "./planning.ts";
import { IllegalTransitionError, ValidationError } from "./errors.ts";

const RUN_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
	analyzing: ["awaiting-user", "ready", "paused", "failed", "stopped"],
	"awaiting-user": ["analyzing", "ready", "paused", "failed", "stopped"],
	ready: ["executing", "auditing", "fixing", "paused", "failed", "stopped"],
	executing: ["ready", "auditing", "fixing", "completed", "paused", "failed", "stopped"],
	auditing: ["ready", "fixing", "completed", "paused", "failed", "stopped"],
	fixing: ["ready", "executing", "auditing", "paused", "failed", "stopped"],
	paused: ["analyzing", "awaiting-user", "ready", "executing", "auditing", "fixing", "completed", "failed", "stopped"],
	completed: [],
	failed: ["stopped"],
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

function declaredPath(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes("\0") || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return undefined;
	const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.split("/").some((part) => part === ".git" || part.startsWith(".git"))) return undefined;
	return normalized;
}

function completionPaths(strategy: CompletionStrategy): readonly string[] {
	switch (strategy.type) {
		case "ledger-only": return [];
		case "append-markdown":
		case "append":
		case "text-replacement":
		case "markdown-checkbox":
		case "frontmatter": return [strategy.path];
		case "rename-file":
		case "move-file": return [strategy.from, strategy.to];
	}
}

function validateCompletionDeclarations(item: WorkItem): Effect.Effect<void, ValidationError> {
	const approved = new Set<string>();
	for (const [index, value] of [...item.sourcePaths, ...item.specificationPaths, ...(item.completionTargets ?? [])].entries()) {
		const normalized = declaredPath(value);
		if (normalized === undefined) return fail("declared completion paths must be relative, control-free, and outside repository control paths", item.id);
		approved.add(normalized);
	}
	if (item.completionTargets !== undefined && new Set(item.completionTargets.map((value) => value.trim())).size !== item.completionTargets.length) {
		return fail("completion target paths must be unique", item.id);
	}
	const strategy = item.completionStrategy;
	if (strategy === undefined || strategy.type === "ledger-only") return Effect.void;
	for (const [index, value] of completionPaths(strategy).entries()) {
		const normalized = declaredPath(value);
		if (normalized === undefined) return fail("completion strategy paths must be relative and outside repository control paths", item.id);
		if (!approved.has(normalized)) return fail(`completion strategy path is not an approved ticket, source, specification, or explicit completion target: ${value}`, item.id);
	}
	return Effect.void;
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
	if ((strategy.type === "append-markdown" || strategy.type === "append" || strategy.type === "frontmatter" || strategy.type === "text-replacement" || strategy.type === "markdown-checkbox") && !strategy.path.trim()) {
		return fail("completion strategy target path must not be empty", item.id);
	}
	if (strategy.type === "text-replacement" && (!strategy.oldText || !strategy.newText)) return fail("text replacement requires exact oldText and newText", item.id);
	if (strategy.type === "markdown-checkbox" && !strategy.text.trim()) return fail("markdown checkbox requires target text", item.id);
	if (strategy.type === "frontmatter" && !strategy.field.trim()) return fail("frontmatter completion field must not be empty", item.id);
	if ((strategy.type === "rename-file" || strategy.type === "move-file") && (!strategy.from.trim() || !strategy.to.trim())) {
		return fail("file completion source and destination must not be empty", item.id);
	}
	return validateCompletionDeclarations(item);
}

export interface PlanValidationOptions {
	/** Internal controller-generated audit/fix items are not accepted from Main. */
	readonly allowGeneratedItems?: boolean;
}

export function validatePlan(plan: WorkflowPlan, options: PlanValidationOptions = {}): Effect.Effect<void, ValidationError> {
	const allowGeneratedItems = options.allowGeneratedItems === true;
	return Effect.gen(function* () {
		if (plan.auditProfile !== undefined) {
			if (!plan.auditProfile.model.trim() || !plan.auditProfile.thinking) return yield* fail("audit profile requires an exact model and thinking level", "auditProfile");
			if (!/^[^/\s]+\/[^/\s]+$/.test(plan.auditProfile.model) || plan.auditProfile.model !== plan.auditProfile.model.trim()) return yield* fail("audit profile model must be an exact provider/model identifier", "auditProfile.model");
			if (!THINKING_LEVELS.includes(plan.auditProfile.thinking)) return yield* fail("unsupported audit thinking level", "auditProfile.thinking");
		}
		const ids = plan.workItems.map((item) => item.id);
		if (new Set(ids).size !== ids.length) return yield* fail("work-item IDs must be unique", "workItems");
		const orders = plan.workItems.map((item) => item.order);
		if (new Set(orders).size !== orders.length) return yield* fail("work-item order values must be unique", "workItems");
		const idSet = new Set(ids);
		for (const item of plan.workItems) yield* validateItem(item, idSet);
		const cycle = findDependencyCycle(plan.workItems);
		if (cycle) return yield* fail(`dependency cycle: ${cycle.join(" -> ")}`, "workItems");

		for (const item of plan.workItems) {
			const kind = item.kind ?? "implementation";
			if (kind === "audit" && item.readOnly !== true) return yield* fail("audit work items must be explicitly read-only", item.id);
			if (kind !== "audit" && item.readOnly === true) return yield* fail("only audit work items may be read-only", item.id);
			if (!allowGeneratedItems && kind !== "implementation") return yield* fail("audit and fix work items are controller-generated and cannot be supplied by Main", item.id);
			if (!allowGeneratedItems && item.completion !== undefined) return yield* fail("completion records are controller-authenticated and cannot be supplied by Main", item.id);
			if (!allowGeneratedItems && item.auditFindingIds !== undefined) return yield* fail("audit finding links are controller-generated and cannot be supplied by Main", item.id);
			if (item.completionTargets !== undefined && item.completionTargets.some((target) => declaredPath(target) === undefined)) return yield* fail("completion target paths must be relative and outside repository control paths", item.id);
			yield* validateCompletionDeclarations(item);
		}
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
			if (!plan.auditProfile?.model || !plan.auditProfile.thinking) {
				return yield* fail("finalized plan requires an explicit audit model and thinking level", "auditProfile");
			}
			for (const item of plan.workItems) {
				if (!allowGeneratedItems && ((item.kind ?? "implementation") !== "implementation" || item.status !== "planned" || item.completion !== undefined)) {
					return yield* fail("a Main-saved finalized plan may contain only implementation items in initial planned state", item.id);
				}
				yield* validateFinalizedItem(item);
			}
		}
		const active = plan.workItems.filter((item) => ACTIVE_WORKER_STATUSES.has(item.status));
		if (active.length > 1) return yield* fail("only one work item may have an active worker", "workItems");
	});
}

export function validateRun(run: WorkflowRun): Effect.Effect<void, ValidationError> {
	return Effect.gen(function* () {
		yield* validatePlan(run.plan, { allowGeneratedItems: true });
		if (run.orchestratorSessionId !== undefined && !run.orchestratorSessionId.trim()) {
			return yield* fail("orchestrator session ID must not be empty", "orchestratorSessionId");
		}
		if (["ready", "executing", "auditing", "fixing", "completed"].includes(run.phase) && !run.plan.finalized) {
			return yield* fail(`${run.phase} run must have a finalized plan`, "plan.finalized");
		}
		if (run.planning.unresolvedQuestions.some((question) => !question.trim())) {
			return yield* fail("unresolved questions must not be empty", "planning.unresolvedQuestions");
		}
		if (new Set(run.planning.unresolvedQuestions.map(normalizeQuestion)).size !== run.planning.unresolvedQuestions.length) {
			return yield* fail("unresolved questions must be unique", "planning.unresolvedQuestions");
		}
		if (run.planning.questionLedger !== undefined) {
			const questionIds = new Set<string>();
			const questionTexts = new Set<string>();
			for (const question of run.planning.questionLedger) {
				if (!question.id.trim() || !question.question.trim() || !question.askedAt.trim()) return yield* fail("question ledger entries require an ID, question, and timestamp", "planning.questionLedger");
				if (questionIds.has(question.id)) return yield* fail("question ledger IDs must be unique", "planning.questionLedger");
				const normalized = normalizeQuestion(question.question);
				if (questionTexts.has(normalized)) return yield* fail("question ledger questions must be unique", "planning.questionLedger");
				questionIds.add(question.id);
				questionTexts.add(normalized);
			}
			for (const question of run.planning.unresolvedQuestions) {
				if (!questionTexts.has(normalizeQuestion(question))) return yield* fail("unresolved question is missing from the durable question ledger", "planning.unresolvedQuestions");
			}
			for (const resolution of run.plan.userResolutions) {
				if (!resolution.id.trim() || !resolution.question.trim() || !resolution.answer.trim()) return yield* fail("user resolutions require a durable question and non-empty answer", "plan.userResolutions");
			}
			if (run.plan.finalized) {
				const unanswered = run.planning.questionLedger.filter((question) => !hasDurableResolution(question.question, run.plan.userResolutions));
				if (unanswered.length > 0) return yield* fail("finalized plan cannot have unanswered durable planning questions", "planning.questionLedger");
			}
		}
		if (run.plan.finalized && run.planning.unresolvedQuestions.length > 0) {
			return yield* fail("finalized plan cannot have unresolved questions", "planning.unresolvedQuestions");
		}
		const byId = new Map(run.plan.workItems.map((item) => [item.id, item] as const));
		for (const item of run.plan.workItems) {
			if (item.status === "completed" && item.completion === undefined) return yield* fail("completed work items require a durable completion record", item.id);
			if (item.completion !== undefined && item.status !== "completed" && (run.progression?.operation !== "accept" || run.progression.workItemId !== item.id)) return yield* fail("in-progress completion records require an active acceptance checkpoint", item.id);
		}
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
		for (const item of run.plan.workItems) {
			if (item.kind === "audit") {
				if (!/^audit-round-\d+$/.test(item.id) || !item.readOnly) return yield* fail("audit items must be controller-generated immutable read-only rounds", item.id);
				if (run.audit === undefined) return yield* fail("an audit work item requires durable audit state", item.id);
			}
			if (item.kind === "fix") {
				if (!/^fix-round-\d+$/.test(item.id) || !item.auditFindingIds || item.auditFindingIds.length === 0) return yield* fail("fix items must be controller-generated from audit findings", item.id);
				if (run.audit === undefined || !run.audit.rounds.some((round) => round.fixWorkItemId === item.id)) return yield* fail("a fix item must link to a durable audit round", item.id);
			}
		}
		if (run.audit !== undefined) {
			if (!run.audit.template.trim()) return yield* fail("audit template must be immutable and non-empty", "audit.template");
			if (!run.audit.model.trim() || !run.audit.thinking) return yield* fail("audit requires an explicit model and thinking level", "audit");
			if (!run.plan.auditProfile) return yield* fail("audit state requires the plan's explicit audit profile", "plan.auditProfile");
			if (run.audit.model !== run.plan.auditProfile.model || run.audit.thinking !== run.plan.auditProfile.thinking) return yield* fail("audit profile must match the finalized plan profile", "audit");
			if (run.audit.activeRound !== undefined && (!Number.isSafeInteger(run.audit.activeRound) || run.audit.activeRound < 1)) return yield* fail("audit active round must be positive", "audit.activeRound");
			const rounds = new Set<number>();
			for (const round of run.audit.rounds) {
				if (!Number.isSafeInteger(round.round) || round.round < 1 || rounds.has(round.round)) return yield* fail("audit round numbers must be unique positive integers", "audit.rounds");
				rounds.add(round.round);
			}
		}
		if (run.phase === "completed") {
			if (run.audit === undefined || run.audit.rounds.at(-1)?.status !== "clean") return yield* fail("a run can complete only after a clean audit round", "audit.rounds");
			if (run.plan.workItems.some((item) => item.status !== "completed")) return yield* fail("a run can complete only after every work item is completed", "plan.workItems");
		}
		if (run.git !== undefined) {
			if (!run.git.baselineCommit.trim() || !run.git.workflowBranch.trim()) return yield* fail("git baseline and workflow branch are required", "git");
			if (run.git.attemptBaseCommit !== undefined && !run.git.attemptBaseCommit.trim()) return yield* fail("active Git attempt base commit must not be empty", "git.attemptBaseCommit");
			if (!run.git.cleanPreflight) return yield* fail("git preflight must be clean", "git.cleanPreflight");
			if (new Set(run.git.acceptedCommitIds.map((commit) => commit.toLowerCase())).size !== run.git.acceptedCommitIds.length) return yield* fail("accepted Git commit IDs must be unique", "git.acceptedCommitIds");
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
