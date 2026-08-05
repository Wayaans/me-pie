import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type TicketFlowCommand =
	| { readonly backend: "tmux"; readonly prompt: string }
	| { readonly action: "status" | "pause" | "resume" | "stop"; };

export interface CommandPrerequisites {
	readonly mode: string;
	readonly tmux: string | undefined;
}

const TICKET_FLOW_ARGUMENT_COMPLETIONS: readonly AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Toggle the Ticket Flow widget in this session" },
	{ value: "pause", label: "pause", description: "Pause the active Ticket Flow run" },
	{ value: "resume", label: "resume", description: "Resume a paused Ticket Flow run" },
	{ value: "stop", label: "stop", description: "Stop the active Ticket Flow run" },
	{ value: "tmux", label: "tmux", description: "Start or recover a Ticket Flow run" },
];

export function ticketFlowArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const commandPrefix = prefix.trimStart();
	if (/\s/.test(commandPrefix)) return null;
	const matches = TICKET_FLOW_ARGUMENT_COMPLETIONS.filter((item) => item.value.startsWith(commandPrefix));
	return matches.length > 0 ? [...matches] : null;
}

export function parseTicketFlowCommand(args: string): TicketFlowCommand {
	const input = args.trim();
	const tokenEnd = input.search(/\s/);
	const command = tokenEnd === -1 ? input : input.slice(0, tokenEnd);
	const remainder = tokenEnd === -1 ? "" : input.slice(tokenEnd).trim();
	if (command === "status" || command === "pause" || command === "resume" || command === "stop") {
		if (remainder) throw new Error(`/${command} does not accept arguments.`);
		return { action: command };
	}
	if (command !== "tmux") {
		if (!command) throw new Error("Usage: /ticket-flow status|pause|resume|stop or /ticket-flow tmux <prompt>");
		throw new Error(`Unsupported Ticket Flow command: ${command}. Use status, pause, resume, stop, or tmux.`);
	}
	const prompt = input.slice(command.length).trim();
	if (!prompt) throw new Error("Ticket Flow requires a non-empty prompt after 'tmux'.");
	return { backend: "tmux", prompt };
}

export function assertCommandPrerequisites(input: CommandPrerequisites): void {
	if (input.mode !== "tui") throw new Error("Ticket Flow requires Pi TUI mode.");
	if (!input.tmux?.trim()) throw new Error("Ticket Flow requires an active tmux environment (TMUX is not set).");
}

export const ORCHESTRATOR_KICKOFF = "Begin and continue the full Ticket Flow workflow. Interpret the original workflow prompt, read all referenced ticket and specification material, resolve known user questions, save and finalize a normalized plan only when every invariant is satisfied, then immediately continue into explicit ticket delegation, report review, audit, audit fixes, and final audit until completion or a genuine user decision is required. Do not stop after creating the plan.";

export const RECOVERY_KICKOFF = "Ticket Flow recovery is attached. Call workflow_plan get, preserve any explicit user pause, and continue only from the reported durable checkpoint using workflow_delegate.";
