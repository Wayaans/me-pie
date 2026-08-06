import { visibleWidth } from "@earendil-works/pi-tui";
import type { TicketflowRun } from "./model.ts";

export const TICKETFLOW_WIDGET_KEY = "ticketflow" as const;

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	if (width === 1) return "…";
	let result = "";
	for (const character of value) {
		if (visibleWidth(`${result}${character}`) > width - 1) break;
		result += character;
	}
	return `${result}…`;
}

function ticketMark(run: TicketflowRun, index: number): string {
	const ticket = run.tickets[index]!;
	if (ticket.status === "completed") return "✓";
	if (ticket.status === "running") return "▶";
	if (ticket.status === "blocked") return "!";
	if (ticket.status === "failed") return "×";
	return "○";
}

function phaseLabel(run: TicketflowRun): string {
	if (run.phase === "implementation") return `Implementation ${Math.min(run.currentTicket + 1, run.tickets.length)}/${run.tickets.length}`;
	if (run.phase === "audit") return `Audit round ${Math.max(1, run.auditRounds.length || 1)}`;
	if (run.phase === "fix") return `Fix round ${run.auditRounds.at(-1)?.round ?? 1}`;
	if (run.phase === "paused" && run.pause?.afterCurrentWorker) return "Pausing after current worker";
	return run.phase[0]!.toUpperCase() + run.phase.slice(1);
}

export function renderTicketflowWidget(run: TicketflowRun, width: number): string[] {
	if (width < 4) return [truncate("TF", width)];
	const inner = Math.max(1, width - 2);
	const border = `+${"-".repeat(inner)}+`;
	const row = (text: string): string => {
		const content = truncate(` ${text}`, inner);
		return `|${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}|`;
	};
	const lines = [border, row(`Ticket Flow · ${phaseLabel(run)}`)];
	for (const ticket of run.tickets) lines.push(row(`${ticketMark(run, ticket.index)} ${ticket.name}${ticket.index === run.currentTicket && run.worker ? ` · ${run.assignment?.stage}` : ""}`));
	if (run.worker) lines.push(row(`Active: ${run.assignment?.kind} · ${run.assignment?.stage} · ${run.worker.handle.windowId}/${run.worker.handle.paneId}`));
	const audit = run.auditRounds.at(-1);
	lines.push(row(`Audit: ${audit?.status ?? "pending"}${audit ? ` · round ${audit.round}` : ""}`));
	lines.push(row(`Worker: ${run.setup.workerProfile.model} · ${run.setup.workerProfile.thinking}`));
	if (run.pause) lines.push(row(run.pause.message));
	lines.push(row("pause · resume · stop/cancel"), border);
	return lines.map((line) => truncate(line, width));
}

export function footerStatus(run: TicketflowRun): string {
	return `ticketflow · ${phaseLabel(run).toLowerCase()}`;
}
