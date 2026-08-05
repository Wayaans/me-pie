import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkflowDelegateInput, WorkflowPlanInput } from "./tools.ts";

function compact(value: unknown, limit = 72): string {
	if (typeof value !== "string") return "";
	const oneLine = value.replace(/[\r\n]+/g, " ").trim();
	return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

export function planToolLabel(action: WorkflowPlanInput["action"]): string {
	return `workflow-plan · ${action}`;
}

export function delegateToolLabel(action: WorkflowDelegateInput["action"]): string {
	return `workflow-delegate · ${action}`;
}

export function renderPlanCall(args: WorkflowPlanInput, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold(planToolLabel(args.action)));
	if (args.plan) text += ` ${theme.fg("muted", `${args.plan.workItems.length} item(s)`)}`;
	if (args.changes) text += ` ${theme.fg("muted", `${args.changes.length} change(s)`)}`;
	return new Text(text, 0, 0);
}

export function renderPlanResult(
	result: { readonly details?: { readonly run?: { readonly phase?: string; readonly plan?: { readonly workItems?: readonly unknown[]; readonly finalized?: boolean } } } },
	_options: { readonly expanded?: boolean; readonly isPartial?: boolean },
	theme: Theme,
	context?: { readonly args?: WorkflowPlanInput },
): Text {
	const run = result.details?.run;
	const label = planToolLabel(context?.args?.action ?? "get");
	if (!run) return new Text(theme.fg("success", `✓ ${label}`), 0, 0);
	const count = run.plan?.workItems?.length ?? 0;
	return new Text(theme.fg("success", `✓ ${label} · ${run.phase ?? "saved"} · ${count} item(s)${run.plan?.finalized ? " · finalized" : ""}`), 0, 0);
}

export function renderDelegateCall(args: WorkflowDelegateInput, theme: Theme): Text {
	let text = theme.fg("toolTitle", theme.bold(delegateToolLabel(args.action)));
	if (args.action === "wait") text += ` ${theme.fg("accent", "⏳")}`;
	if (args.workItemId) text += ` ${theme.fg("muted", args.workItemId)}`;
	if (args.message) text += ` ${theme.fg("dim", JSON.stringify(compact(args.message)))}`;
	if (args.feedback) text += ` ${theme.fg("dim", JSON.stringify(compact(args.feedback)))}`;
	return new Text(text, 0, 0);
}

export function renderDelegateResult(
	result: {
		readonly content?: readonly { readonly type?: string; readonly text?: string }[];
		readonly details?: { readonly run?: { readonly activeWorkItemId?: string; readonly phase?: string }; readonly sent?: boolean; readonly message?: string };
	},
	options: { readonly expanded?: boolean; readonly isPartial?: boolean },
	theme: Theme,
	context?: { readonly args?: WorkflowDelegateInput },
): Text {
	const action = context?.args?.action ?? "wait";
	const label = delegateToolLabel(action);
	if (options.isPartial) {
		const progress = compact(result.content?.find((part) => part.type === "text")?.text, 72);
		return new Text(theme.fg("toolTitle", progress ? `${label} ${theme.fg("muted", progress)}` : label), 0, 0);
	}
	const details = result.details;
	if (details?.sent) return new Text(theme.fg("success", `✓ ${label} · ${compact(details.message, 56)}`), 0, 0);
	const run = details?.run;
	return new Text(theme.fg("success", `✓ ${label}${run?.activeWorkItemId ? ` · ${run.activeWorkItemId}` : ""}${run?.phase ? ` · ${run.phase}` : ""}`), 0, 0);
}
