import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { RunPhase, Ticket, TicketflowRun } from "./model.ts";

export const TICKETFLOW_WIDGET_KEY = "ticketflow" as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 100;
const MAX_VISIBLE_TICKETS = 6;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

type Tone = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

export interface TicketflowWidgetRenderOptions {
	readonly frame?: number;
	readonly theme?: Theme;
}

interface WorkflowVisual {
	readonly icon: string;
	readonly label: "RUNNING" | "PAUSING" | "PAUSED" | "FAILED";
	readonly tone: Tone;
	readonly animated: boolean;
}

interface TicketVisual {
	readonly icon: string;
	readonly tone: Tone;
}

function paint(theme: Theme | undefined, tone: Tone, text: string): string {
	return theme ? theme.fg(tone, text) : text;
}

function bold(theme: Theme | undefined, text: string): string {
	return theme ? theme.bold(text) : text;
}

function fit(value: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(value, width, width > 1 ? "…" : "");
}

function terminalLabel(value: string): string {
	return value
		.replace(OSC_PATTERN, "")
		.replace(CSI_PATTERN, "")
		.replace(ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function spinner(frame: number): string {
	return SPINNER_FRAMES[Math.abs(frame) % SPINNER_FRAMES.length]!;
}

function workflowVisual(run: TicketflowRun, frame: number): WorkflowVisual {
	if (run.phase === "paused") {
		const workerStillRunning = run.pause?.reason === "user"
			&& run.pause.afterCurrentWorker
			&& run.assignment?.stage === "running";
		if (workerStillRunning) return { icon: spinner(frame), label: "PAUSING", tone: "warning", animated: true };
		return { icon: "⏸", label: "PAUSED", tone: "warning", animated: false };
	}
	if (run.phase === "failed") return { icon: "×", label: "FAILED", tone: "error", animated: false };
	return { icon: spinner(frame), label: "RUNNING", tone: "accent", animated: true };
}

function phaseVisual(phase: RunPhase): { readonly icon: string; readonly label: string; readonly tone: Tone } {
	if (phase === "implementation") return { icon: "◆", label: "Implementation", tone: "accent" };
	if (phase === "audit") return { icon: "◎", label: "Audit", tone: "warning" };
	if (phase === "fix") return { icon: "↻", label: "Fix", tone: "warning" };
	if (phase === "paused") return { icon: "⏸", label: "Paused", tone: "warning" };
	if (phase === "failed") return { icon: "×", label: "Failed", tone: "error" };
	if (phase === "completed") return { icon: "✓", label: "Completed", tone: "success" };
	return { icon: "■", label: "Cancelled", tone: "muted" };
}

function ticketVisual(ticket: Ticket, frame: number): TicketVisual {
	if (ticket.status === "completed") return { icon: "✓", tone: "success" };
	if (ticket.status === "running") return { icon: spinner(frame), tone: "accent" };
	if (ticket.status === "blocked") return { icon: "!", tone: "warning" };
	if (ticket.status === "failed") return { icon: "×", tone: "error" };
	return { icon: "○", tone: "dim" };
}

function phaseProgress(run: TicketflowRun): string {
	if (run.phase === "implementation") return `Ticket ${Math.min(run.currentTicket + 1, run.tickets.length)} of ${run.tickets.length}`;
	if (run.phase === "audit") return `Round ${Math.max(1, run.auditRounds.at(-1)?.round ?? 1)}`;
	if (run.phase === "fix") return `Round ${Math.max(1, run.auditRounds.at(-1)?.round ?? 1)}`;
	if (run.phase === "paused" && run.pause) return `${phaseVisual(run.pause.previousPhase).label} paused`;
	return "";
}

function assignmentStatus(run: TicketflowRun, frame: number, theme: Theme | undefined): string {
	const assignment = run.assignment;
	if (!assignment) {
		if (run.phase === "paused") return paint(theme, "warning", "No new work will start until resumed");
		if (run.phase === "audit") return paint(theme, "dim", "Ready to delegate the audit");
		if (run.phase === "fix") return paint(theme, "dim", "Ready to delegate fixes");
		return paint(theme, "dim", "Ready to delegate the next ticket");
	}
	if (assignment.stage === "launching") return `${paint(theme, "accent", spinner(frame))} Launching Worker`;
	if (assignment.stage === "ready") return `${paint(theme, "success", "●")} Worker ready · awaiting task`;
	if (assignment.stage === "running") return `${paint(theme, "accent", spinner(frame))} Worker running · turn ${assignment.turn}`;
	if (assignment.stage === "settled") return `${paint(theme, "success", "✓")} Worker settled · turn ${assignment.turn}`;
	return `${paint(theme, "warning", "!")} Worker interrupted · resume required`;
}

function progressBar(completed: number, total: number): string {
	const cells = 12;
	const filled = total === 0 ? 0 : Math.round((completed / total) * cells);
	return `${"━".repeat(filled)}${"─".repeat(cells - filled)}`;
}

function ticketWindow(run: TicketflowRun): readonly Ticket[] {
	if (run.tickets.length <= MAX_VISIBLE_TICKETS) return run.tickets;
	const focus = Math.min(run.currentTicket, run.tickets.length - 1);
	const start = Math.max(0, Math.min(focus - 2, run.tickets.length - MAX_VISIBLE_TICKETS));
	return run.tickets.slice(start, start + MAX_VISIBLE_TICKETS);
}

function auditStatus(run: TicketflowRun, theme: Theme | undefined): string | undefined {
	const audit = run.auditRounds.at(-1);
	if (!audit && run.phase !== "audit" && run.phase !== "fix") return undefined;
	const status = audit?.status ?? "pending";
	const visual = status === "clean"
		? { icon: "✓", tone: "success" as const }
		: status === "findings"
			? { icon: "!", tone: "warning" as const }
			: { icon: "○", tone: "dim" as const };
	return `${paint(theme, visual.tone, visual.icon)} Audit ${status}${audit ? ` · round ${audit.round}` : ""}`;
}

function controls(run: TicketflowRun): string {
	return run.phase === "paused"
		? "/ticketflow resume  ·  /ticketflow stop"
		: "/ticketflow pause  ·  /ticketflow stop";
}

export function renderTicketflowWidget(
	run: TicketflowRun,
	width: number,
	options: TicketflowWidgetRenderOptions = {},
): string[] {
	if (width <= 0) return [];
	const frame = options.frame ?? 0;
	const theme = options.theme;
	const workflow = workflowVisual(run, frame);
	const compactStatus = `${paint(theme, workflow.tone, workflow.icon)} ${bold(theme, "TF")} ${paint(theme, workflow.tone, workflow.label)} · ${run.tickets.filter((ticket) => ticket.status === "completed").length}/${run.tickets.length}`;
	if (width < 24) return [fit(compactStatus, width)];

	const innerWidth = width - 2;
	const borderTone = run.phase === "paused" ? "warning" : run.phase === "failed" ? "error" : "borderAccent";
	const border = (value: string): string => theme ? theme.fg(borderTone, value) : value;
	const row = (content = ""): string => {
		const fitted = fit(` ${content}`, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
		return `${border("│")}${fitted}${padding}${border("│")}`;
	};
	const separator = `${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`;
	const lines: string[] = [
		`${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`,
		row(`${paint(theme, workflow.tone, workflow.icon)} ${bold(theme, "TICKET FLOW")}  ${paint(theme, workflow.tone, bold(theme, workflow.label))}`),
		separator,
	];

	const phase = phaseVisual(run.phase);
	const phaseMeta = phaseProgress(run);
	lines.push(row(`${paint(theme, phase.tone, phase.icon)} ${bold(theme, phase.label)}${phaseMeta ? `  ·  ${phaseMeta}` : ""}`));
	lines.push(row(assignmentStatus(run, frame, theme)));

	const completed = run.tickets.filter((ticket) => ticket.status === "completed").length;
	const percent = run.tickets.length === 0 ? 0 : Math.round((completed / run.tickets.length) * 100);
	lines.push(row(`${paint(theme, "accent", progressBar(completed, run.tickets.length))}  ${bold(theme, `${completed}/${run.tickets.length}`)}  ${paint(theme, "muted", `${percent}%`)}`));
	lines.push(separator);

	const visibleTickets = ticketWindow(run);
	const firstVisibleIndex = visibleTickets[0]?.index ?? 0;
	if (firstVisibleIndex > 0) lines.push(row(paint(theme, "dim", `⋮ ${firstVisibleIndex} earlier ticket${firstVisibleIndex === 1 ? "" : "s"}`)));
	for (const ticket of visibleTickets) {
		const visual = ticketVisual(ticket, frame);
		const active = ticket.index === run.currentTicket;
		const marker = active ? paint(theme, "accent", "›") : " ";
		const safeName = terminalLabel(ticket.name);
		const name = active ? bold(theme, safeName) : safeName;
		lines.push(row(`${marker} ${paint(theme, visual.tone, visual.icon)} ${paint(theme, active ? "text" : "muted", name)}`));
	}
	const remaining = run.tickets.length - firstVisibleIndex - visibleTickets.length;
	if (remaining > 0) lines.push(row(paint(theme, "dim", `⋮ ${remaining} later ticket${remaining === 1 ? "" : "s"}`)));

	const audit = auditStatus(run, theme);
	if (run.worker || audit || run.pause) lines.push(separator);
	if (run.worker) {
		const profile = terminalLabel(`${run.setup.workerProfile.model} · ${run.setup.workerProfile.thinking}`);
		const pane = terminalLabel(`${run.worker.handle.windowId}/${run.worker.handle.paneId}`);
		lines.push(row(`${paint(theme, "accent", "●")} Worker  ${paint(theme, "muted", profile)}`));
		lines.push(row(paint(theme, "dim", `tmux ${pane}`)));
	}
	if (audit) lines.push(row(audit));
	if (run.pause) lines.push(row(`${paint(theme, "warning", "!")} ${paint(theme, "warning", terminalLabel(run.pause.message))}`));

	lines.push(separator, row(paint(theme, "dim", controls(run))), `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
	return lines.map((line) => fit(line, width));
}

export function footerStatus(run: TicketflowRun): string {
	const visual = workflowVisual(run, 0);
	const phase = run.phase === "paused" && run.pause ? run.pause.previousPhase : run.phase;
	const phaseText = phase === "implementation"
		? `implementation ${Math.min(run.currentTicket + 1, run.tickets.length)}/${run.tickets.length}`
		: phase === "audit"
			? `audit ${Math.max(1, run.auditRounds.at(-1)?.round ?? 1)}`
			: phase === "fix"
				? `fix ${Math.max(1, run.auditRounds.at(-1)?.round ?? 1)}`
				: phase;
	return `ticketflow · ${visual.label.toLowerCase()} · ${phaseText}`;
}

export function createTicketflowWidget(run: TicketflowRun, tui: TUI, theme: Theme): Component & { dispose(): void } {
	let frame = 0;
	const timer = workflowVisual(run, frame).animated
		? setInterval(() => {
			frame = (frame + 1) % SPINNER_FRAMES.length;
			tui.requestRender();
		}, SPINNER_INTERVAL_MS)
		: undefined;
	timer?.unref();
	return {
		render: (width) => renderTicketflowWidget(run, width, { frame, theme }),
		invalidate: () => undefined,
		dispose: () => { if (timer) clearInterval(timer); },
	};
}
