import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkerReport } from "../domain.ts";
import type { ReportValidationResult } from "./report.ts";

export function workflowContextLabel(action: "get" | "wait-for-feedback"): string {
	return `workflow-context · ${action}`;
}

export function workflowReportLabel(
	status: WorkerReport["status"],
	matchedRequirements?: number,
	plannedRequirements?: number,
): string {
	const requirements = status === "completed" && matchedRequirements !== undefined && plannedRequirements !== undefined
		? ` · ${matchedRequirements}/${plannedRequirements} requirements`
		: "";
	return `workflow-report · ${status}${requirements}`;
}

export function renderContextCall(args: { readonly action: "get" | "wait-for-feedback" }, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(workflowContextLabel(args.action))), 0, 0);
}

export function renderReportCall(args: WorkerReport, theme: Theme): Text {
	const count = args.status === "completed" ? args.requirements?.length : undefined;
	return new Text(theme.fg("toolTitle", theme.bold(workflowReportLabel(args.status, count, count))), 0, 0);
}

export function renderReportResult(
	result: { readonly details?: { readonly report?: WorkerReport; readonly validation?: ReportValidationResult } },
	theme: Theme,
): Text {
	const report = result.details?.report;
	const validation = result.details?.validation;
	if (!report) return new Text("", 0, 0);
	const label = workflowReportLabel(report.status, validation?.matchedRequirements, validation?.plannedRequirements);
	return new Text(theme.fg(report.status === "failed" || report.status === "blocked" ? "warning" : "success", label), 0, 0);
}
