export const MAIN_TICKETFLOW_TOOLS = [
	"ticketflow_delegate",
	"ticketflow_send",
	"ticketflow_wait",
	"ticketflow_close",
	"ticketflow_resume",
	"ticketflow_abort",
] as const;
export const WORKER_TICKETFLOW_TOOLS = ["ticketflow_report"] as const;
export type TicketflowRole = "main" | "worker";

const roleTools: Readonly<Record<TicketflowRole, ReadonlySet<string>>> = {
	main: new Set(MAIN_TICKETFLOW_TOOLS),
	worker: new Set(WORKER_TICKETFLOW_TOOLS),
};

export function isTicketflowTool(name: string): boolean {
	return name.startsWith("ticketflow_") || name.startsWith("workflow_");
}

export function isAllowedTicketflowTool(name: string, role: TicketflowRole): boolean {
	return roleTools[role].has(name);
}

export function withoutTicketflowTools(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) => !isTicketflowTool(name)))];
}

export function filterTicketflowContext<T>(messages: readonly T[], role: TicketflowRole): T[] {
	return messages.flatMap((message) => {
		if (!message || typeof message !== "object") return [message];
		const record = message as { readonly role?: unknown; readonly toolName?: unknown; readonly content?: unknown };
		if (record.role === "toolResult" && typeof record.toolName === "string" && isTicketflowTool(record.toolName) && !isAllowedTicketflowTool(record.toolName, role)) return [];
		if (record.role !== "assistant" || !Array.isArray(record.content)) return [message];
		const content = record.content.filter((block) => {
			if (!block || typeof block !== "object") return true;
			const candidate = block as { readonly type?: unknown; readonly name?: unknown; readonly toolName?: unknown };
			if (candidate.type !== "toolCall") return true;
			const name = typeof candidate.name === "string" ? candidate.name : candidate.toolName;
			return typeof name !== "string" || !isTicketflowTool(name) || isAllowedTicketflowTool(name, role);
		});
		return [{ ...record, content } as T];
	});
}
