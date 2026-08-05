import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type, type Static } from "typebox";
import type { AuthoritativeWorkerContext, WorkerFeedback, WorkerReport } from "../domain.ts";
import type { WorkerLifecycle } from "./lifecycle.ts";
import { renderWorkerCall, renderWorkerResult } from "./renderers.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const RequirementResultParameters = StrictObject({
	requirementId: Type.Optional(Type.String()),
	requirement: Type.Optional(Type.String()),
	result: StringEnum(["satisfied", "not-satisfied", "not-applicable"] as const),
	evidence: Type.String(),
});
const CheckResultParameters = StrictObject({
	command: Type.String(),
	result: StringEnum(["passed", "failed", "not-run"] as const),
	output: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
});
const AuditVerdictParameters = StrictObject({
	requirement: Type.String(),
	verdict: StringEnum(["pass", "fail", "not-applicable"] as const),
	evidence: Type.String(),
	fixes: Type.Optional(Type.Array(Type.String())),
});
const AuditFindingParameters = StrictObject({
	id: Type.String(),
	severity: StringEnum(["critical", "high", "medium", "low"] as const),
	finding: Type.String(),
	evidence: Type.String(),
	fixLink: Type.Optional(Type.String()),
	resolved: Type.Optional(Type.Boolean()),
});

/** The worker process has exactly one workflow tool. */
export const WORKER_TOOL_NAMES = ["workflow_worker"] as const;
export const WorkflowWorkerParameters = StrictObject({
	action: StringEnum(["get", "send", "submit"] as const),
	message: Type.Optional(Type.String()),
	questions: Type.Optional(Type.Array(Type.String())),
	blocking: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	status: Type.Optional(StringEnum(["progress", "completed", "blocked", "failed"] as const)),
	summary: Type.Optional(Type.String()),
	requirements: Type.Optional(Type.Array(RequirementResultParameters)),
	filesChanged: Type.Optional(Type.Array(Type.String())),
	filesChangedExplanation: Type.Optional(Type.String()),
	checks: Type.Optional(Type.Array(CheckResultParameters)),
	caveats: Type.Optional(Type.Array(Type.String())),
	blockers: Type.Optional(Type.Array(Type.String())),
	userInterventionRequired: Type.Optional(Type.Boolean()),
	commitIds: Type.Optional(Type.Array(Type.String())),
	auditVerdicts: Type.Optional(Type.Array(AuditVerdictParameters)),
	auditFindings: Type.Optional(Type.Array(AuditFindingParameters)),
});

export type WorkflowWorkerInput = Static<typeof WorkflowWorkerParameters>;
/** Legacy schemas are exported for decoding old session entries; only workflow_worker is registered. */
export const WorkflowContextParameters = StrictObject({ action: StringEnum(["get", "wait-for-feedback"] as const), timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })) });
export const WorkflowSubmitReportParameters = StrictObject({ status: StringEnum(["progress", "completed", "blocked", "failed"] as const), summary: Type.String(), requirements: Type.Optional(Type.Array(RequirementResultParameters)), filesChanged: Type.Optional(Type.Array(Type.String())), filesChangedExplanation: Type.Optional(Type.String()), checks: Type.Optional(Type.Array(CheckResultParameters)), caveats: Type.Optional(Type.Array(Type.String())), blockers: Type.Optional(Type.Array(Type.String())), questions: Type.Optional(Type.Array(Type.String())), userInterventionRequired: Type.Optional(Type.Boolean()) });

export interface WorkerToolLifecycle {
	readonly getContext: WorkerLifecycle["getContext"];
	readonly waitForFeedback: WorkerLifecycle["waitForFeedback"];
	readonly submitReport: WorkerLifecycle["submitReport"];
	readonly sendQuestion?: WorkerLifecycle["sendQuestion"];
}

function lifecycleOrThrow(getLifecycle: () => WorkerToolLifecycle | undefined): WorkerToolLifecycle {
	const lifecycle = getLifecycle();
	if (!lifecycle) throw new Error("Ticket Flow worker is inactive: no authenticated orchestrator connection.");
	return lifecycle;
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function runToolEffect<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
	return Effect.runPromise(effect, { signal });
}

export function boundWorkerToolOutput(text: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) return truncation.content;
	const notice = "\n[Workflow tool output truncated]";
	const bounded = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
		maxLines: DEFAULT_MAX_LINES - 1,
	});
	return `${bounded.content}${notice}`;
}

export function registerWorkerTools(pi: ExtensionAPI, getLifecycle: () => WorkerToolLifecycle | undefined): void {
	pi.registerTool({
		name: "workflow_worker",
		label: "Workflow Worker",
		description: "Get authoritative delegated context, send a blocking question, or submit a structured progress/completion report to Main.",
		promptSnippet: "Get context, ask Main a blocking question, or submit a structured report",
		parameters: WorkflowWorkerParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const lifecycle = await runToolEffect(Effect.try({ try: () => lifecycleOrThrow(getLifecycle), catch: errorFrom }), signal);
			switch (params.action) {
				case "get": {
					if (params.message !== undefined || params.status !== undefined || params.summary !== undefined || params.timeoutMs !== undefined) throw new Error("workflow_worker get accepts no message, report, or timeout fields.");
					const context = await runToolEffect(Effect.try({ try: () => lifecycle.getContext(), catch: errorFrom }), signal);
					return { content: [{ type: "text" as const, text: boundWorkerToolOutput(JSON.stringify(context)) }], details: { context } as { readonly context: AuthoritativeWorkerContext } };
				}
				case "send": {
					if (params.status !== undefined || params.summary !== undefined || params.requirements !== undefined || params.timeoutMs !== undefined && params.blocking === false) throw new Error("workflow_worker send accepts a question message, questions, and optional blocking flag.");
					const message = params.message?.trim();
					if (!message) throw new Error("workflow_worker send requires a non-empty message.");
					const questions = params.questions ?? [message];
					if (params.blocking === false) {
						await lifecycle.submitReport({ status: "blocked", summary: message, blockers: [message], questions, userInterventionRequired: false }, signal);
						return { content: [{ type: "text" as const, text: "Question sent to Main; worker remains connected." }], details: { question: message, questions, blocking: false } };
					}
					const feedback = lifecycle.sendQuestion
						? await lifecycle.sendQuestion(message, questions, signal, params.timeoutMs)
						: await lifecycle.waitForFeedback(signal, params.timeoutMs);
					const text = `Main feedback received: ${feedback.type === "feedback" ? feedback.message : feedback.type}`;
					return { content: [{ type: "text" as const, text: boundWorkerToolOutput(text) }], details: { question: message, questions, feedback } };
				}
				case "submit": {
					if (!params.status || !params.summary) throw new Error("workflow_worker submit requires status and summary.");
					const report: WorkerReport = {
						status: params.status,
						summary: params.summary,
						...(params.requirements === undefined ? {} : { requirements: params.requirements }),
						...(params.filesChanged === undefined ? {} : { filesChanged: params.filesChanged }),
						...(params.filesChangedExplanation === undefined ? {} : { filesChangedExplanation: params.filesChangedExplanation }),
						...(params.checks === undefined ? {} : { checks: params.checks }),
						...(params.caveats === undefined ? {} : { caveats: params.caveats }),
						...(params.blockers === undefined ? {} : { blockers: params.blockers }),
						...(params.questions === undefined ? {} : { questions: params.questions }),
						...(params.userInterventionRequired === undefined ? {} : { userInterventionRequired: params.userInterventionRequired }),
						...(params.commitIds === undefined ? {} : { commitIds: params.commitIds }),
						...(params.auditVerdicts === undefined ? {} : { auditVerdicts: params.auditVerdicts }),
						...(params.auditFindings === undefined ? {} : { auditFindings: params.auditFindings }),
					};
					const validation = await lifecycle.submitReport(report, signal);
					return {
						content: [{ type: "text" as const, text: report.status === "completed" ? `Submitted completed report (${validation.matchedRequirements}/${validation.plannedRequirements} requirements).` : `Submitted ${report.status} report.` }],
						details: { report, validation },
					};
				}
			}
		},
		renderCall: renderWorkerCall,
		renderResult: renderWorkerResult,
	});
}
