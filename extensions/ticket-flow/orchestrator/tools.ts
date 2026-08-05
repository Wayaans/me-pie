import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Effect } from "effect";
import type { PlanChange, WorkflowPlan, WorkflowRun } from "../domain.ts";
import { formatFinalSummary } from "../audit.ts";
import { THINKING_LEVELS, WORK_ITEM_STATUSES } from "../domain.ts";
import type { WorkflowController } from "../controller.ts";
import { renderDelegateCall, renderDelegateResult, renderPlanCall, renderPlanResult } from "./renderers.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const ThinkingSchema = StringEnum(THINKING_LEVELS);
const WorkItemStatusSchema = StringEnum(WORK_ITEM_STATUSES);
const LaunchProfileSchema = StrictObject({ model: Type.Optional(Type.String()), thinking: Type.Optional(ThinkingSchema) });
const CompletionStrategySchema = Type.Union([
	StrictObject({ type: Type.Literal("ledger-only") }),
	StrictObject({ type: Type.Literal("append-markdown"), path: Type.String() }),
	StrictObject({ type: Type.Literal("append"), path: Type.String() }),
	StrictObject({ type: Type.Literal("text-replacement"), path: Type.String(), oldText: Type.String(), newText: Type.String() }),
	StrictObject({ type: Type.Literal("markdown-checkbox"), path: Type.String(), text: Type.String(), checked: Type.Optional(Type.Boolean()) }),
	StrictObject({ type: Type.Literal("frontmatter"), path: Type.String(), field: Type.String(), value: Type.Unknown() }),
	StrictObject({ type: Type.Literal("rename-file"), from: Type.String(), to: Type.String() }),
	StrictObject({ type: Type.Literal("move-file"), from: Type.String(), to: Type.String() }),
]);
const UserResolutionSchema = StrictObject({ id: Type.String(), question: Type.String(), answer: Type.String(), resolvedAt: Type.String() });
const WorkItemSchema = StrictObject({
	id: Type.String(), kind: Type.Optional(StringEnum(["implementation", "audit", "fix"] as const)), title: Type.String(),
	sourcePaths: Type.Array(Type.String()), specificationPaths: Type.Array(Type.String()), requirements: Type.Array(Type.String()),
	order: Type.Integer({ minimum: 0 }), orderReason: Type.String(), dependsOn: Type.Array(Type.String()), delegationPrompt: Type.String(),
	launchProfile: Type.Optional(LaunchProfileSchema), readOnly: Type.Optional(Type.Boolean()), completionStrategy: Type.Optional(CompletionStrategySchema), auditFindingIds: Type.Optional(Type.Array(Type.String())),
	completion: Type.Optional(StrictObject({
		acceptedAttempt: Type.Integer({ minimum: 1 }), acceptedReportPath: Type.String(), commitIds: Type.Optional(Type.Array(Type.String())), comment: Type.String(), completedAt: Type.String(), strategy: CompletionStrategySchema,
		worker: Type.Optional(StrictObject({ runId: Type.String(), workItemId: Type.String(), provider: Type.String(), model: Type.String(), thinking: ThinkingSchema, sessionId: Type.Optional(Type.String()), sessionFile: Type.Optional(Type.String()) })),
		requestedLaunchProfile: Type.Optional(StrictObject({ model: Type.String(), thinking: ThinkingSchema })),
	})),
	status: WorkItemStatusSchema,
});
const WorkflowPlanSchema = StrictObject({ summary: Type.String(), auditProfile: Type.Optional(StrictObject({ model: Type.String(), thinking: ThinkingSchema })), workItems: Type.Array(WorkItemSchema), userResolutions: Type.Array(UserResolutionSchema), finalized: Type.Boolean() });
const PlanChangeSchema = Type.Union([
	StrictObject({ type: Type.Literal("set-summary"), summary: Type.String() }),
	StrictObject({ type: Type.Literal("upsert-work-item"), workItem: WorkItemSchema }),
	StrictObject({ type: Type.Literal("remove-work-item"), workItemId: Type.String() }),
	StrictObject({ type: Type.Literal("set-user-resolutions"), userResolutions: Type.Array(UserResolutionSchema) }),
	StrictObject({ type: Type.Literal("set-unresolved-questions"), questions: Type.Array(Type.String()) }),
]);

export const WorkflowPlanParameters = StrictObject({
	action: StringEnum(["get", "save", "update"] as const),
	plan: Type.Optional(WorkflowPlanSchema),
	changes: Type.Optional(Type.Array(PlanChangeSchema, { minItems: 1 })),
	unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
});

export const WorkflowDelegateParameters = StrictObject({
	action: StringEnum(["start", "wait", "send", "accept", "revise", "close"] as const),
	workItemId: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	comment: Type.Optional(Type.String()),
	feedback: Type.Optional(Type.String()),
	missingRequirements: Type.Optional(Type.Array(Type.String())),
	until: Type.Optional(StringEnum(["progress", "report", "blocked", "exit", "any"] as const)),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	force: Type.Optional(Type.Boolean()),
});

export type WorkflowPlanInput = Static<typeof WorkflowPlanParameters>;
export type WorkflowDelegateInput = Static<typeof WorkflowDelegateParameters>;


function result(text: string, run?: WorkflowRun, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details: run === undefined ? details : { ...details, run } };
}
function runController<A, E>(operation: Effect.Effect<A, E>, signal: AbortSignal | undefined): Promise<A> { return Effect.runPromise(operation, { signal }); }
function required<T>(value: T | undefined, name: string): T { if (value === undefined) throw new Error(`${name} is required for this action.`); return value; }
function requireActive(controller: WorkflowController): WorkflowRun {
	if (!controller.activeRun) throw new Error("Ticket Flow workflow tools are inactive outside an active owned run.");
	return controller.activeRun;
}

export function registerOrchestratorTools(pi: ExtensionAPI, controller: WorkflowController): void {
	pi.registerTool({
		name: "workflow_plan",
		label: "Workflow Plan",
		description: "Get, save, or update the durable Ticket Flow plan. Full structured runtime state is returned in details; default output is compact.",
		promptSnippet: "Get or persist the Ticket Flow plan and its typed changes",
		parameters: WorkflowPlanParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			requireActive(controller);
			switch (params.action) {
				case "get": {
					if (params.plan !== undefined || params.changes !== undefined || params.unresolvedQuestions !== undefined) throw new Error("workflow_plan get accepts no plan data.");
					const run = requireActive(controller);
					return result(`Ticket Flow plan · ${run.phase} · ${run.plan.workItems.length} item(s)`, run);
				}
				case "save": {
					if (params.changes !== undefined) throw new Error("workflow_plan save does not accept changes.");
					const run = await runController(controller.savePlan(required(params.plan, "plan"), params.unresolvedQuestions ?? []), signal);
					return result(`Saved plan · ${run.plan.workItems.length} item(s)${run.plan.finalized ? " · ready" : ""}`, run);
				}
				case "update": {
					if (params.plan !== undefined) throw new Error("workflow_plan update accepts only typed changes.");
					const changes = required(params.changes, "changes");
					const run = await runController(controller.updatePlan(changes as readonly PlanChange[]), signal);
					return result(`Updated plan · ${changes.length} change(s)`, run);
				}
			}
		},
		renderCall: renderPlanCall,
		renderResult: renderPlanResult,
	});

	pi.registerTool({
		name: "workflow_delegate",
		label: "Workflow Delegate",
		description: "Explicitly start, wait for, send feedback to, review, accept, or close one authenticated Ticket Flow worker. No automatic next-worker progression occurs.",
		promptSnippet: "Explicitly delegate and review exactly one Ticket Flow worker",
		parameters: WorkflowDelegateParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
			requireActive(controller);
			const workItemId = params.workItemId ?? controller.activeRun?.activeWorkItemId;
			switch (params.action) {
				case "start": {
					const id = required(workItemId, "workItemId");
					const run = await runController(controller.delegateStart(id, (message) => onUpdate?.(result(message, controller.activeRun)), signal, params.timeoutMs), signal);
					return result(`Started and verified ${id}; exact planned prompt delivered.`, run);
				}
				case "wait": {
					const id = required(workItemId, "workItemId");
					if (params.message !== undefined || params.comment !== undefined || params.feedback !== undefined || params.force !== undefined) throw new Error("workflow_delegate wait accepts only workItemId, until, and timeoutMs.");
					onUpdate?.(result(`Waiting · ${id} · ${params.until ?? "any"}`, controller.activeRun));
					const output = await runController(controller.waitWorker(id, params.until ?? "any", signal, params.timeoutMs), signal);
					return result(`Worker event · ${output}`, controller.activeRun);
				}
				case "send": {
					const id = required(workItemId, "workItemId");
					if (params.comment !== undefined || params.feedback !== undefined || params.missingRequirements !== undefined || params.until !== undefined || params.force !== undefined) throw new Error("workflow_delegate send accepts only workItemId and message.");
					const run = await runController(controller.sendWorkerFeedback(id, required(params.message, "message"), signal), signal);
					return result("✓ Sent Main feedback; worker connection preserved.", run, { sent: true, message: params.message });
				}
				case "accept": {
					const id = required(workItemId, "workItemId");
					const run = await runController(controller.acceptReport(id, required(params.comment, "comment"), signal), signal);
					return result(run.phase === "completed" ? formatFinalSummary(run) : `✓ Accepted ${id}; next operation remains explicit.`, run, run.phase === "completed" ? { finalSummary: formatFinalSummary(run) } : {});
				}
				case "revise": {
					const id = required(workItemId, "workItemId");
					const run = await runController(controller.reviseReport(id, required(params.feedback, "feedback"), params.missingRequirements ?? [], signal), signal);
					return result("↻ Revision feedback sent to the same authenticated worker.", run);
				}
				case "close": {
					const id = required(workItemId, "workItemId");
					const closed = await runController(controller.closeWorker(id, params.force ?? false), signal);
					return result(`✓ Closed ${id}${closed.closeResult.forced ? " forcibly" : " gracefully"}.`, closed.run);
				}
			}
		},
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
	});
}
