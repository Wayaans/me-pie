import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PreparedSetup } from "./tickets.ts";

type Tone = "accent" | "success" | "warning" | "muted" | "dim" | "text" | "borderAccent" | "borderMuted";

export interface TicketflowConfirmationRenderOptions {
	readonly selected?: "start" | "cancel";
	readonly theme?: Theme;
}

function paint(theme: Theme | undefined, tone: Tone, text: string): string {
	return theme ? theme.fg(tone, text) : text;
}

function strong(theme: Theme | undefined, text: string): string {
	return theme ? theme.bold(text) : text;
}

function safeLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function fit(value: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(value, width, width > 1 ? "…" : "");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function renderTicketflowConfirmation(
	prepared: PreparedSetup,
	width: number,
	options: TicketflowConfirmationRenderOptions = {},
): string[] {
	if (width <= 0) return [];
	const theme = options.theme;
	const selected = options.selected ?? "start";
	if (width < 12) return [fit(strong(theme, "Start flow?"), width)];

	const innerWidth = width - 2;
	const contentWidth = Math.max(1, innerWidth - 2);
	const border = (text: string): string => paint(theme, "borderAccent", text);
	const row = (content = ""): string => {
		const fitted = fit(` ${content}`, innerWidth);
		return `${border("│")}${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))}${border("│")}`;
	};
	const separator = `${border("├")}${paint(theme, "borderMuted", "─".repeat(innerWidth))}${border("┤")}`;
	const lines: string[] = [
		`${border("╭")}${border("─".repeat(innerWidth))}${border("╮")}`,
		row(`${paint(theme, "accent", "◆")} ${paint(theme, "accent", strong(theme, "TICKET FLOW"))}  ${paint(theme, "success", strong(theme, "READY TO START"))}`),
		row(paint(theme, "muted", "A sequential implementation run with an audit gate")),
		separator,
	];

	const queued = prepared.tickets.length;
	const skipped = prepared.skippedTickets.length;
	if (contentWidth >= 54) {
		lines.push(row(`${paint(theme, "accent", strong(theme, String(queued)))} ${paint(theme, "text", queued === 1 ? "ticket queued" : "tickets queued")}   ${paint(theme, "success", "✓")} ${paint(theme, "muted", `${skipped} already complete`)}`));
	} else {
		lines.push(row(`${paint(theme, "accent", strong(theme, plural(queued, "ticket")))} ${paint(theme, "muted", "queued")}`));
		lines.push(row(`${paint(theme, "success", "✓")} ${paint(theme, "muted", `${plural(skipped, "ticket")} already complete`)}`));
	}
	lines.push(row(`${paint(theme, "accent", "◆")} Implement  ${paint(theme, "dim", "→")}  ${paint(theme, "warning", "◎")} Audit  ${paint(theme, "dim", "→")}  ${paint(theme, "warning", "↻")} Fix if needed`));
	lines.push(separator, row(paint(theme, "muted", strong(theme, "QUEUE"))));

	const visibleTickets = prepared.tickets.slice(0, 6);
	for (const [index, ticket] of visibleTickets.entries()) {
		const order = String(ticket.order).padStart(2, "0");
		const checks = plural(ticket.requirements?.length ?? 0, "check");
		const prefix = `${paint(theme, "accent", index === 0 ? "›" : "○")} ${paint(theme, "dim", order)}  `;
		const suffix = `  ${paint(theme, "dim", checks)}`;
		const nameWidth = Math.max(1, contentWidth - visibleWidth(prefix) - visibleWidth(suffix));
		lines.push(row(`${prefix}${strong(theme, fit(safeLabel(ticket.name), nameWidth))}${suffix}`));
	}
	if (queued > visibleTickets.length) lines.push(row(paint(theme, "dim", `⋮ ${queued - visibleTickets.length} more queued tickets`)));

	if (skipped > 0) {
		const names = prepared.skippedTickets.slice(0, 3).map((ticket) => safeLabel(ticket.name)).join(", ");
		const remaining = skipped - Math.min(skipped, 3);
		const summary = `${paint(theme, "success", "✓")} ${paint(theme, "dim", `Skipped: ${names}${remaining > 0 ? ` +${remaining} more` : ""}`)}`;
		lines.push(...wrapTextWithAnsi(summary, contentWidth).map((line) => row(line)));
	}

	lines.push(separator, row(paint(theme, "muted", strong(theme, "RUN SETTINGS"))));
	const settings: readonly [string, string, Tone][] = [
		["Worker", safeLabel(prepared.setup.workerProfile.model), "text"],
		["Thinking", prepared.setup.workerProfile.thinking, "warning"],
		["Tickets", safeLabel(prepared.setup.ticketsDirectory), "muted"],
		["References", plural(prepared.setup.referencePaths.length, "file"), "muted"],
	];
	const labelWidth = 12;
	for (const [label, value, tone] of settings) {
		const available = Math.max(1, contentWidth - labelWidth);
		lines.push(row(`${paint(theme, "dim", label.padEnd(labelWidth))}${paint(theme, tone, fit(value, available))}`));
	}
	lines.push(row(`${paint(theme, "dim", "Completion".padEnd(labelWidth))}${paint(theme, "success", "✓ every Markdown checkbox checked")}`));
	lines.push(separator);

	const start = selected === "start"
		? paint(theme, "accent", strong(theme, "[ Start Ticket Flow ]"))
		: paint(theme, "muted", "  Start Ticket Flow  ");
	const cancel = selected === "cancel"
		? paint(theme, "warning", strong(theme, "[ Cancel ]"))
		: paint(theme, "muted", "  Cancel  ");
	lines.push(row(`${start}    ${cancel}`));
	lines.push(row(paint(theme, "dim", "←→ choose  ·  enter confirm  ·  esc cancel")));
	lines.push(`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
	return lines.map((line) => fit(line, width));
}

class TicketflowConfirmation implements Component {
	private selected: "start" | "cancel" = "start";

	constructor(
		private readonly prepared: PreparedSetup,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (confirmed: boolean) => void,
	) {}

	render(width: number): string[] {
		return renderTicketflowConfirmation(this.prepared, width, { selected: this.selected, theme: this.theme });
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.done(this.selected === "start");
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
			this.done(false);
			return;
		}
		if (data.toLowerCase() === "y") {
			this.done(true);
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) this.selected = "start";
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) this.selected = "cancel";
		else return;
		this.requestRender();
	}

	invalidate(): void {}
}

export function confirmTicketflowSetup(ctx: ExtensionCommandContext, prepared: PreparedSetup): Promise<boolean> {
	return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) =>
		new TicketflowConfirmation(prepared, theme, () => tui.requestRender(), done));
}
