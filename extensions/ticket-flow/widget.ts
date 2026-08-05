import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkItem, WorkflowRun } from "./domain.ts";

export const WORKFLOW_WIDGET_KEY = "ticket-flow-workflow";
export const WORKFLOW_SPINNER_FRAMES = ["·", "•", "●", "•"] as const;

export interface WorkflowWidgetOptions {
	readonly now?: number;
	readonly frame?: number;
	readonly theme?: Theme;
	readonly activity?: string | undefined;
}

function color(theme: Theme | undefined, name: ThemeColor, text: string): string {
	return theme ? theme.fg(name, text) : text;
}

function status(item: WorkItem): { readonly mark: string; readonly label: string; readonly tone: ThemeColor } {
	switch (item.status) {
		case "completed": return { mark: "✓", label: "done", tone: "success" };
		case "running": return { mark: "▶", label: "running", tone: "accent" };
		case "spawning": return { mark: "…", label: "starting", tone: "accent" };
		case "verifying-worker": return { mark: "≈", label: "verifying", tone: "accent" };
		case "report-review": return { mark: "?", label: "review", tone: "warning" };
		case "report-pending": return { mark: "…", label: "report", tone: "accent" };
		case "report-revision": return { mark: "↻", label: "revise", tone: "warning" };
		case "blocked": return { mark: "!", label: "blocked", tone: "warning" };
		case "failed": return { mark: "✗", label: "failed", tone: "error" };
		case "interrupted": return { mark: "Ⅱ", label: "paused", tone: "warning" };
		case "ready": return { mark: "○", label: "ready", tone: "muted" };
		default: return { mark: "·", label: "planned", tone: "dim" };
	}
}

export function workflowPhaseActivity(run: WorkflowRun): string {
	if (run.planning.unresolvedQuestions.length > 0) return "Awaiting clarification";
	if (run.pauseReason === "user") return "Paused by user";
	if (run.pauseReason === "blocker") return "Waiting for answer";
	if (run.pauseReason === "recovery") return "Recovery paused";
	const item = currentItem(run);
	if (run.phase === "analyzing") return "Planning";
	if (run.phase === "awaiting-user") return "Awaiting clarification";
	if (run.phase === "ready") return "Ready to delegate";
	if (run.phase === "auditing") {
		if (item?.status === "report-review") return "Reviewing audit";
		if (item?.status === "spawning" || item?.status === "verifying-worker") return "Delegating audit";
		return "Auditing";
	}
	if (run.phase === "fixing") return item?.status === "report-review" ? "Reviewing audit fix" : "Fixing audit";
	if (run.phase === "executing") {
		switch (item?.status) {
			case "spawning": return "Creating worker";
			case "verifying-worker": return "Verifying worker";
			case "running": return "Implementing";
			case "report-pending": return "Receiving report";
			case "report-review": return "Reviewing ticket";
			case "report-revision": return "Updating ticket";
			default: return "Executing";
		}
	}
	if (run.phase === "completed") return "Finished";
	if (run.phase === "failed") return "Failed";
	if (run.phase === "stopped") return "Stopped";
	return "Paused";
}

function toolArgs(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function workflowActivityForTool(toolName: string, args: unknown, run: WorkflowRun): string {
	const input = toolArgs(args);
	if (toolName === "workflow_plan") {
		if (input.action === "update") return "Updating plan";
		if (input.action === "save" && toolArgs(input.plan).finalized === true) return "Finalizing plan";
		if (input.action === "get" && run.plan.finalized) return "Reviewing plan";
		return "Planning";
	}
	if (toolName === "workflow_delegate") {
		const itemId = typeof input.workItemId === "string" ? input.workItemId : run.activeWorkItemId;
		const item = itemId === undefined ? undefined : run.plan.workItems.find((candidate) => candidate.id === itemId);
		if (input.action === "start") return item?.kind === "audit" ? "Delegating audit" : item?.kind === "fix" ? "Delegating audit fix" : "Delegating ticket";
		if (input.action === "wait") return item?.kind === "audit" ? "Auditing" : item?.kind === "fix" ? "Fixing audit" : "Waiting for worker";
		if (input.action === "accept") return item?.kind === "audit" || run.phase === "auditing" ? "Finalizing audit" : item?.kind === "fix" || run.phase === "fixing" ? "Finalizing audit fix" : "Finalizing ticket";
		if (input.action === "revise") return item?.kind === "audit" ? "Updating audit" : "Updating ticket";
		if (input.action === "send") return "Updating worker";
		if (input.action === "close") return "Closing worker";
	}
	if (!run.plan.finalized && ["read", "rg", "fd", "grep", "find", "ls"].includes(toolName)) return "Analyzing tickets";
	return workflowPhaseActivity(run);
}

export function workflowActivityFromProgress(message: string, run: WorkflowRun): string {
	const normalized = message.toLowerCase();
	if (normalized.includes("tmux window creation")) return "Creating worker";
	if (normalized.includes("tmux window created")) return "Launching worker";
	if (normalized.includes("profile verified") || normalized.includes("profile verification")) return "Verifying worker";
	if (normalized.includes("prompt delivered") || normalized.includes("connection ready")) return run.phase === "auditing" ? "Delegating audit" : run.phase === "fixing" ? "Delegating audit fix" : "Delegating ticket";
	if (normalized.startsWith("waiting")) return workflowActivityForTool("workflow_delegate", { action: "wait" }, run);
	return workflowPhaseActivity(run);
}

function currentItem(run: WorkflowRun): WorkItem | undefined {
	return run.activeWorkItemId === undefined ? undefined : run.plan.workItems.find((item) => item.id === run.activeWorkItemId);
}

/** Fit the inside of a border. Borders are kept on both sides whenever the
 * terminal has at least two columns; content is clipped rather than making the
 * widget wider than its viewport. */
function bordered(content: string, width: number, theme: Theme | undefined, accent = false): string {
	if (width < 2) return color(theme, "border", "│");
	const innerWidth = width - 2;
	const clipped = truncateToWidth(content, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const borderColor = accent ? "borderAccent" : "border";
	return `${color(theme, borderColor, "│")}${clipped}${padding}${color(theme, borderColor, "│")}`;
}

function topBorder(content: string, width: number, theme: Theme | undefined): string {
	if (width <= 1) return color(theme, "borderAccent", "╭");
	if (width === 2) return color(theme, "borderAccent", "╭╮");
	const innerWidth = width - 2;
	const clipped = truncateToWidth(content, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${color(theme, "borderAccent", "╭")}${clipped}${padding}${color(theme, "borderAccent", "╮")}`;
}

export function renderWorkflowWidget(run: WorkflowRun, width: number, options: WorkflowWidgetOptions = {}): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const theme = options.theme;
	const item = currentItem(run);
	const frame = options.frame ?? Math.floor((options.now ?? Date.now()) / 160);
	const spinner = WORKFLOW_SPINNER_FRAMES[((frame % WORKFLOW_SPINNER_FRAMES.length) + WORKFLOW_SPINNER_FRAMES.length) % WORKFLOW_SPINNER_FRAMES.length] ?? "·";
	const title = ` Ticket Flow · ${options.activity ?? workflowPhaseActivity(run)} `;
	const lines: string[] = [topBorder(title, safeWidth, theme)];
	for (const candidate of run.plan.workItems) {
		const state = status(candidate);
		const mark = candidate.id === item?.id && candidate.status !== "completed" ? spinner : state.mark;
		const label = `${String(candidate.order).padStart(2, "0")} ${candidate.title} · ${state.label}`;
		lines.push(bordered(` ${color(theme, state.tone, mark)} ${color(theme, candidate.id === item?.id ? "text" : "muted", label)}`, safeWidth, theme));
	}
	if (run.planning.unresolvedQuestions.length > 0) {
		lines.push(bordered(` ${color(theme, "warning", "?")} ${color(theme, "warning", `${run.planning.unresolvedQuestions.length} clarification${run.planning.unresolvedQuestions.length === 1 ? "" : "s"} pending`)}`, safeWidth, theme));
	}
	if (run.audit) {
		const round = run.audit.activeRound ?? run.audit.rounds.length;
		lines.push(bordered(` ${color(theme, "accent", "◎")} ${color(theme, "muted", `audit round ${round || 1} · ${run.audit.model} · ${run.audit.thinking}`)}`, safeWidth, theme));
	}
	if (item?.launchProfile || run.worker || run.tmux) {
		const profile = run.worker ? `${run.worker.provider}/${run.worker.model} · ${run.worker.thinking}` : run.requestedLaunchProfile ? `${run.requestedLaunchProfile.model} · ${run.requestedLaunchProfile.thinking}` : "model pending";
		const tmux = run.tmux ? `tmux ${run.tmux.displayName} ${run.tmux.windowId}/${run.tmux.paneId}` : "tmux pending";
		lines.push(bordered(` ${color(theme, "dim", `${profile} · ${tmux}`)}`, safeWidth, theme));
	}
	lines.push(safeWidth < 2 ? color(theme, "borderAccent", "│") : color(theme, "borderAccent", `╰${"─".repeat(safeWidth - 2)}╯`));
	return lines;
}

/** A stateful component suitable for ctx.ui.setWidget(). */
export class WorkflowTaskListWidget {
	private run: WorkflowRun | undefined;
	private activity: string | undefined;
	private frame = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(run?: WorkflowRun) { this.run = run; }
	setRun(run: WorkflowRun | undefined): void { this.run = run; this.invalidate(); }
	setActivity(activity: string | undefined): void { this.activity = activity; this.invalidate(); }
	advance(): void { this.frame = (this.frame + 1) % WORKFLOW_SPINNER_FRAMES.length; this.invalidate(); }
	render(width: number, options: Omit<WorkflowWidgetOptions, "frame"> = {}): string[] {
		if (!this.run) return [];
		if (this.cachedLines && this.cachedWidth === width && options.theme === undefined) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = renderWorkflowWidget(this.run, width, { ...options, frame: this.frame, activity: this.activity });
		return this.cachedLines;
	}
	invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
}

export function workflowWidgetLines(run: WorkflowRun, width: number, theme?: Theme): string[] {
	return renderWorkflowWidget(run, width, theme === undefined ? {} : { theme });
}
