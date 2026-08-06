import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ThinkingLevel, WorkerProfile } from "./model.ts";
import { THINKING_LEVELS } from "./model.ts";
import { prepareSetup, type PreparedSetup } from "./tickets.ts";

export type TicketflowCommand =
	| { readonly action: "tmux" | "herdr" | "cmux" }
	| { readonly action: "status" | "pause" | "resume" | "stop" | "cancel" };

const COMPLETIONS: readonly AutocompleteItem[] = [
	{ value: "tmux", label: "tmux", description: "Configure a sequential tmux Ticket Flow run" },
	{ value: "herdr", label: "herdr", description: "Not supported yet" },
	{ value: "cmux", label: "cmux", description: "Not supported yet" },
	{ value: "status", label: "status", description: "Show the current durable run" },
	{ value: "pause", label: "pause", description: "Pause after the current worker turn" },
	{ value: "resume", label: "resume", description: "Resume progression and reopen a persisted worker if needed" },
	{ value: "stop", label: "stop", description: "Confirm and terminally stop the run" },
	{ value: "cancel", label: "cancel", description: "Alias for confirmed stop" },
];

export function ticketflowArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const value = prefix.trim();
	if (/\s/.test(value)) return null;
	const matches = COMPLETIONS.filter((item) => item.value.startsWith(value));
	return matches.length > 0 ? [...matches] : null;
}

export function parseTicketflowCommand(args: string): TicketflowCommand {
	const input = args.trim();
	if (!input) throw new Error("Usage: /ticketflow tmux|herdr|cmux|status|pause|resume|stop|cancel");
	if (/\s/.test(input)) throw new Error("/ticketflow subcommands do not accept inline arguments; tmux setup uses a native Pi form.");
	if (["tmux", "herdr", "cmux", "status", "pause", "resume", "stop", "cancel"].includes(input)) return { action: input as TicketflowCommand["action"] };
	throw new Error(`Unsupported Ticket Flow command: ${input}.`);
}

export function assertTmuxSetupContext(ctx: Pick<ExtensionCommandContext, "mode">, environment: NodeJS.ProcessEnv = process.env): void {
	if (ctx.mode !== "tui") throw new Error("/ticketflow tmux requires Pi TUI mode.");
	if (!environment.TMUX?.trim()) throw new Error("/ticketflow tmux requires the current Pi client to be inside tmux.");
}

function lines(value: string | undefined): string[] {
	return (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function defaultModel(ctx: ExtensionCommandContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
}

export async function runSetupWizard(ctx: ExtensionCommandContext): Promise<PreparedSetup | undefined> {
	const ticketsDirectory = await ctx.ui.input("Tickets", "Directory containing numbered Markdown implementation tickets");
	if (ticketsDirectory === undefined) return undefined;
	const referenceText = await ctx.ui.editor("Other Reference", "");
	if (referenceText === undefined) return undefined;
	const model = await ctx.ui.input("Model worker", defaultModel(ctx) || "Exact provider/model");
	if (model === undefined) return undefined;
	const thinking = await ctx.ui.select("Thinking worker", [...THINKING_LEVELS]);
	if (thinking === undefined) return undefined;
	const defaultTemplate = "Implement the ticket at {ticketPath} ({ticketIndex}/{ticketCount}). Use these references: {referencePaths}";
	const delegationTemplate = await ctx.ui.editor("Delegation prompt", defaultTemplate);
	if (delegationTemplate === undefined) return undefined;
	const workerProfile: WorkerProfile = {
		model: model.trim() || defaultModel(ctx),
		thinking: thinking as ThinkingLevel,
	};
	const prepared = await prepareSetup({
		projectPath: ctx.cwd,
		ticketsDirectory,
		referencePaths: lines(referenceText),
		workerProfile,
		delegationTemplate,
	});
	const ordered = prepared.tickets.map((ticket) => `${String(ticket.order).padStart(2, "0")}. ${ticket.name}\n   ${ticket.path}`).join("\n");
	const confirmed = await ctx.ui.confirm(
		"Start Ticket Flow?",
		`Ordered tickets:\n${ordered}\n\nCompletion: every Markdown checkbox in each ticket must be checked.\nWorker: ${workerProfile.model} · ${workerProfile.thinking}`,
	);
	return confirmed ? prepared : undefined;
}
