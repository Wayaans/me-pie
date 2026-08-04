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
import { renderContextCall, renderReportCall, renderReportResult } from "./renderers.ts";

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

export const WorkflowContextParameters = StrictObject({
	action: StringEnum(["get", "wait-for-feedback"] as const),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const WorkflowSubmitReportParameters = StrictObject({
	status: StringEnum(["progress", "completed", "blocked", "failed"] as const),
	summary: Type.String(),
	requirements: Type.Optional(Type.Array(RequirementResultParameters)),
	filesChanged: Type.Optional(Type.Array(Type.String())),
	filesChangedExplanation: Type.Optional(Type.String()),
	checks: Type.Optional(Type.Array(CheckResultParameters)),
	caveats: Type.Optional(Type.Array(Type.String())),
	blockers: Type.Optional(Type.Array(Type.String())),
	questions: Type.Optional(Type.Array(Type.String())),
	userInterventionRequired: Type.Optional(Type.Boolean()),
});

export type WorkflowContextInput = Static<typeof WorkflowContextParameters>;
export type WorkflowSubmitReportInput = Static<typeof WorkflowSubmitReportParameters>;

export interface WorkerToolLifecycle {
	readonly getContext: WorkerLifecycle["getContext"];
	readonly waitForFeedback: WorkerLifecycle["waitForFeedback"];
	readonly submitReport: WorkerLifecycle["submitReport"];
}

function lifecycleOrThrow(getLifecycle: () => WorkerToolLifecycle | undefined): WorkerToolLifecycle {
	const lifecycle = getLifecycle();
	if (!lifecycle) throw new Error("Ticket Flow worker lifecycle is not connected to an authenticated orchestrator.");
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
		name: "workflow_context",
		label: "Workflow Context",
		description: "Get bounded authoritative context from the authenticated orchestrator connection, or wait for feedback. Output is bounded and waits respect cancellation.",
		promptSnippet: "Get authoritative delegated-item context or wait for orchestrator feedback",
		parameters: WorkflowContextParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const lifecycle = await runToolEffect(Effect.try({ try: () => lifecycleOrThrow(getLifecycle), catch: errorFrom }), signal);
			if (params.action === "get") {
				if (params.timeoutMs !== undefined) throw new Error("workflow_context get does not accept timeoutMs.");
				const context = await runToolEffect(Effect.try({ try: () => lifecycle.getContext(), catch: errorFrom }), signal);
				const details: { readonly context?: AuthoritativeWorkerContext; readonly feedback?: WorkerFeedback } = { context };
				return { content: [{ type: "text" as const, text: boundWorkerToolOutput(JSON.stringify(context)) }], details };
			}
			const feedback = await runToolEffect(Effect.tryPromise({
				try: () => lifecycle.waitForFeedback(signal, params.timeoutMs),
				catch: errorFrom,
			}), signal);
			const details: { readonly context?: AuthoritativeWorkerContext; readonly feedback?: WorkerFeedback } = { feedback };
			return { content: [{ type: "text" as const, text: boundWorkerToolOutput(JSON.stringify(feedback)) }], details };
		},
		renderCall: renderContextCall,
	});

	pi.registerTool({
		name: "workflow_submit_report",
		label: "Workflow Report",
		description: "Submit progress, completion, blocker, or failure through the authenticated native protocol. Completed reports require every planned requirement, files, checks, caveats, and blockers.",
		promptSnippet: "Submit progress, blockers, failure, or a final structured completion report",
		parameters: WorkflowSubmitReportParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const report = params as WorkerReport;
			const lifecycle = await runToolEffect(Effect.try({ try: () => lifecycleOrThrow(getLifecycle), catch: errorFrom }), signal);
			const validation = await runToolEffect(Effect.tryPromise({
				try: () => lifecycle.submitReport(report, signal),
				catch: errorFrom,
			}), signal);
			const text = report.status === "completed"
				? `Submitted completed report with ${validation.matchedRequirements}/${validation.plannedRequirements} requirements.`
				: `Submitted ${report.status} report.`;
			return { content: [{ type: "text" as const, text }], details: { report, validation } };
		},
		renderCall: renderReportCall,
		renderResult: (result, _options, theme) => renderReportResult(result, theme),
	});
}
