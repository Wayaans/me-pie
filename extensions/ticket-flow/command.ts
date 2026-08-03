export interface TicketFlowCommand {
	readonly backend: "tmux";
	readonly prompt: string;
}

export interface CommandPrerequisites {
	readonly mode: string;
	readonly tmux: string | undefined;
}

export function parseTicketFlowCommand(args: string): TicketFlowCommand {
	const input = args.trim();
	const tokenEnd = input.search(/\s/);
	const backend = tokenEnd === -1 ? input : input.slice(0, tokenEnd);
	if (backend !== "tmux") {
		if (!backend) throw new Error("Usage: /ticket-flow tmux <prompt>");
		throw new Error(`Unsupported Ticket Flow backend: ${backend}. Only tmux is supported.`);
	}
	const prompt = input.slice(backend.length).trim();
	if (!prompt) throw new Error("Ticket Flow requires a non-empty prompt after 'tmux'.");
	return { backend: "tmux", prompt };
}

export function assertCommandPrerequisites(input: CommandPrerequisites): void {
	if (input.mode !== "tui") throw new Error("Ticket Flow requires Pi TUI mode.");
	if (!input.tmux?.trim()) throw new Error("Ticket Flow requires an active tmux environment (TMUX is not set).");
}

export const ORCHESTRATOR_KICKOFF = "Begin Ticket Flow analysis. Interpret the original workflow prompt, read all referenced ticket and specification material, resolve known user questions, save a normalized plan, and finalize it only when every invariant is satisfied.";
