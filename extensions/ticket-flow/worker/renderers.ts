import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkerReport } from "../domain.ts";
import type { ReportValidationResult } from "./report.ts";

export function workflowWorkerLabel(action: "get" | "send" | "submit"): string {
	return `workflow-worker · ${action}`;
}

export function workflowReportLabel(status: WorkerReport["status"], matchedRequirements?: number, plannedRequirements?: number): string {
	const requirements = status === "completed" && matchedRequirements !== undefined && plannedRequirements !== undefined
		? ` · ${matchedRequirements}/${plannedRequirements} requirements`
		: "";
	return `workflow-worker · submit · ${status}${requirements}`;
}

function compactText(value: unknown, limit = 80): string {
	if (typeof value !== "string") return "";
	const oneLine = value.replace(/[\r\n]+/g, " ").trim();
	return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

export function renderWorkerCall(args: { readonly action: "get" | "send" | "submit"; readonly message?: string; readonly status?: WorkerReport["status"] }, theme: Theme): Text {
	let label = theme.fg("toolTitle", theme.bold(workflowWorkerLabel(args.action)));
	if (args.action === "send") label += ` ${theme.fg("accent", "⏳")}`;
	if (args.status) label += ` ${theme.fg("muted", args.status)}`;
	if (args.message) label += ` ${theme.fg("dim", JSON.stringify(compactText(args.message)))}`;
	return new Text(label, 0, 0);
}

export function renderWorkerResult(
	result: { readonly details?: { readonly [key: string]: unknown } },
	_options: { readonly expanded?: boolean; readonly isPartial?: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	const report = details?.report as WorkerReport | undefined;
	if (report) {
		const validation = details?.validation as ReportValidationResult | undefined;
		const label = workflowReportLabel(report.status, validation?.matchedRequirements, validation?.plannedRequirements);
		return new Text(theme.fg(report.status === "failed" || report.status === "blocked" ? "warning" : "success", report.status === "completed" ? `✓ ${label}` : label), 0, 0);
	}
	const feedback = details?.feedback as { readonly type?: string; readonly message?: string } | undefined;
	if (feedback) return new Text(theme.fg("success", `✓ Main: ${compactText(feedback.message ?? feedback.type ?? "feedback")}`), 0, 0);
	const question = details?.question;
	if (typeof question === "string") return new Text(theme.fg("success", `✓ question sent: ${compactText(question, 56)}`), 0, 0);
	if (details?.context) return new Text(theme.fg("success", "✓ context received"), 0, 0);
	return new Text(theme.fg("success", "✓ workflow-worker"), 0, 0);
}
