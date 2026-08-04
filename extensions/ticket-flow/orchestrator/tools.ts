import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Effect } from "effect";
import type { WorkflowPlan, WorkflowRun } from "../domain.ts";
import { THINKING_LEVELS, WORK_ITEM_STATUSES } from "../domain.ts";
import type { WorkflowController } from "../controller.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const ThinkingSchema = StringEnum(THINKING_LEVELS);
const WorkItemStatusSchema = StringEnum(WORK_ITEM_STATUSES);
const LaunchProfileSchema = StrictObject({
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(ThinkingSchema),
});
const CompletionStrategySchema = Type.Union([
	StrictObject({ type: Type.Literal("ledger-only") }),
	StrictObject({ type: Type.Literal("append-markdown"), path: Type.String() }),
	StrictObject({ type: Type.Literal("frontmatter"), path: Type.String(), field: Type.String(), value: Type.Unknown() }),
	StrictObject({ type: Type.Literal("rename-file"), from: Type.String(), to: Type.String() }),
	StrictObject({ type: Type.Literal("move-file"), from: Type.String(), to: Type.String() }),
]);
const UserResolutionSchema = StrictObject({
	id: Type.String(),
	question: Type.String(),
	answer: Type.String(),
	resolvedAt: Type.String(),
});
const WorkItemSchema = StrictObject({
	id: Type.String(),
	title: Type.String(),
	sourcePaths: Type.Array(Type.String()),
	specificationPaths: Type.Array(Type.String()),
	requirements: Type.Array(Type.String()),
	order: Type.Integer({ minimum: 0 }),
	orderReason: Type.String(),
	dependsOn: Type.Array(Type.String()),
	delegationPrompt: Type.String(),
	launchProfile: Type.Optional(LaunchProfileSchema),
	completionStrategy: Type.Optional(CompletionStrategySchema),
	status: WorkItemStatusSchema,
});
const WorkflowPlanSchema = StrictObject({
	summary: Type.String(),
	workItems: Type.Array(WorkItemSchema),
	userResolutions: Type.Array(UserResolutionSchema),
	finalized: Type.Boolean(),
});
const PlanChangeSchema = Type.Union([
	StrictObject({ type: Type.Literal("set-summary"), summary: Type.String() }),
	StrictObject({ type: Type.Literal("upsert-work-item"), workItem: WorkItemSchema }),
	StrictObject({ type: Type.Literal("remove-work-item"), workItemId: Type.String() }),
	StrictObject({ type: Type.Literal("set-user-resolutions"), userResolutions: Type.Array(UserResolutionSchema) }),
	StrictObject({ type: Type.Literal("set-unresolved-questions"), questions: Type.Array(Type.String()) }),
]);

export const WorkflowPlanParameters = StrictObject({
	action: StringEnum(["save", "update", "finalize"] as const),
	plan: Type.Optional(WorkflowPlanSchema),
	changes: Type.Optional(Type.Array(PlanChangeSchema, { minItems: 1 })),
	unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
});

export const WorkflowWorkerParameters = StrictObject({
	action: StringEnum(["delegate", "wait", "read", "send", "close"] as const),
	workItemId: Type.String(),
	message: Type.Optional(Type.String()),
	until: Type.Optional(StringEnum(["connected", "ready", "progress", "report", "blocked", "idle", "exit", "any"] as const)),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
});

export const WorkflowReviewReportParameters = StrictObject({
	action: StringEnum(["inspect", "accept", "revise", "block"] as const),
	workItemId: Type.String(),
	comment: Type.Optional(Type.String()),
	feedback: Type.Optional(Type.String()),
	missingRequirements: Type.Optional(Type.Array(Type.String())),
	questions: Type.Optional(Type.Array(Type.String())),
});

export const WorkflowControlParameters = StrictObject({
	action: StringEnum(["status", "pause", "resume", "stop", "recover"] as const),
});

export type WorkflowPlanInput = Static<typeof WorkflowPlanParameters>;
export type WorkflowWorkerInput = Static<typeof WorkflowWorkerParameters>;
export type WorkflowReviewReportInput = Static<typeof WorkflowReviewReportParameters>;
export type WorkflowControlInput = Static<typeof WorkflowControlParameters>;

function result(text: string, run?: WorkflowRun) {
	return {
		content: [{ type: "text" as const, text }],
		details: run === undefined ? {} : { run },
	};
}

function runController<A, E>(operation: Effect.Effect<A, E>, signal: AbortSignal | undefined): Promise<A> {
	return Effect.runPromise(operation, { signal });
}

function requireOnly<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`workflow_plan ${name} is required for this action.`);
	return value;
}

export function registerOrchestratorTools(pi: ExtensionAPI, controller: WorkflowController): void {
	pi.registerTool({
		name: "workflow_plan",
		label: "Workflow Plan",
		description: "Save, update, or finalize the normalized Ticket Flow plan. Output is bounded; complete branch state is persisted in details.",
		parameters: WorkflowPlanParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			switch (params.action) {
				case "save": {
					if (params.changes !== undefined) throw new Error("workflow_plan save does not accept changes.");
					const run = await runController(controller.savePlan(
						requireOnly(params.plan, "plan") as WorkflowPlan,
						params.unresolvedQuestions ?? [],
					), signal);
					return result(`Saved ${run.plan.workItems.length} work item(s).`, run);
				}
				case "update": {
					if (params.plan !== undefined || params.unresolvedQuestions !== undefined) {
						throw new Error("workflow_plan update accepts only typed changes.");
					}
					const changes = requireOnly(params.changes, "changes");
					const run = await runController(controller.updatePlan(changes), signal);
					return result(`Applied ${changes.length} plan change(s).`, run);
				}
				case "finalize": {
					if (params.plan !== undefined || params.changes !== undefined || params.unresolvedQuestions !== undefined) {
						throw new Error("workflow_plan finalize does not accept plan data or changes.");
					}
					const ready = await runController(controller.finalizePlan(), signal);
					const first = ready.plan.workItems.find((item) =>
						(item.status === "planned" || item.status === "ready" || item.status === "interrupted")
						&& item.dependsOn.every((dependencyId) => ready.plan.workItems.find((candidate) => candidate.id === dependencyId)?.status === "completed")
					);
					const run = first === undefined
						? ready
						: await runController(controller.startWorker(first.id), signal);
					return result(`Plan finalized with ${run.plan.workItems.length} item(s) and the first eligible Pi worker started.`, run);
				}
			}
		},
	});

	pi.registerTool({
		name: "workflow_worker",
		label: "Workflow Worker",
		description: "Start, wait for, inspect, send feedback to, or close the authenticated workflow-owned Pi worker.",
		parameters: WorkflowWorkerParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			switch (params.action) {
				case "delegate": {
					if (params.message !== undefined) throw new Error("workflow_worker delegate uses the planned delegation prompt; use send for feedback.");
					const run = await runController(controller.startWorker(params.workItemId), signal);
					return result(`Started Pi for ${params.workItemId}; its planned delegation is delivered natively only after exact profile verification.`, run);
				}
				case "read": {
					const output = await runController(controller.readWorker(params.workItemId, params.lines), signal);
					return result(output, controller.activeRun);
				}
				case "close": {
					const closed = await runController(controller.closeWorker(params.workItemId), signal);
					return result(`Closed the workflow-owned worker${closed.closeResult.forced ? " forcibly" : " gracefully"}.`, closed.run);
				}
				case "wait": {
					if (params.message !== undefined || params.lines !== undefined) throw new Error("workflow_worker wait does not accept message or lines.");
					const output = await runController(controller.waitWorker(params.workItemId, params.until, signal, params.timeoutMs), signal);
					return result(output, controller.activeRun);
				}
				case "send": {
					if (params.until !== undefined || params.lines !== undefined) throw new Error("workflow_worker send accepts only feedback text.");
					const run = await runController(controller.sendWorkerFeedback(params.workItemId, requireOnly(params.message, "message"), signal), signal);
					return result("Sent native feedback to the verified worker Pi session.", run);
				}
			}
		},
	});

	pi.registerTool({
		name: "workflow_review_report",
		label: "Workflow Review Report",
		description: "Inspect or review a worker report. Native reports become available in Stage 5.",
		parameters: WorkflowReviewReportParameters,
		executionMode: "sequential",
		async execute() {
			throw new Error("No worker report exists before Stage 5 native reporting.");
		},
	});

	pi.registerTool({
		name: "workflow_control",
		label: "Workflow Control",
		description: "Show bounded run status, pause planning, or stop the current Ticket Flow run.",
		parameters: WorkflowControlParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			switch (params.action) {
				case "status":
					return result(await runController(controller.status(), signal), controller.activeRun);
				case "pause": {
					const run = await runController(controller.pause(), signal);
					return result("Ticket Flow paused.", run);
				}
				case "stop": {
					const run = await runController(controller.stop(), signal);
					return result("Ticket Flow stopped; the project lock and orchestrator tool restriction were released.", run);
				}
				case "resume":
					throw new Error("workflow_control resume is reserved for Stage 7 recovery.");
				case "recover":
					throw new Error("workflow_control recover is reserved for Stage 7 recovery.");
			}
		},
	});
}
