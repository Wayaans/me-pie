export const ORCHESTRATOR_TOOL_NAMES = ["workflow_plan", "workflow_delegate"] as const;
export const WORKER_TOOL_NAMES = ["workflow_worker"] as const;

export type WorkflowRole = "orchestrator" | "worker";

const TOOL_NAMES_BY_ROLE: Readonly<Record<WorkflowRole, ReadonlySet<string>>> = {
	orchestrator: new Set(ORCHESTRATOR_TOOL_NAMES),
	worker: new Set(WORKER_TOOL_NAMES),
};

/** Ticket Flow owns the workflow_* namespace. Unknown names are retired tools. */
export function isWorkflowToolName(name: string): boolean {
	return name.startsWith("workflow_");
}

export function isWorkflowToolAllowed(name: string, role: WorkflowRole): boolean {
	return TOOL_NAMES_BY_ROLE[role].has(name);
}

/** Remove current and retired Ticket Flow tools before installing one role's surface. */
export function withoutWorkflowTools(names: readonly string[]): string[] {
	return [...new Set(names.filter((name) => !isWorkflowToolName(name)))];
}

export function toolsForWorkflowRole(names: readonly string[], role: WorkflowRole): string[] {
	return [...withoutWorkflowTools(names), ...TOOL_NAMES_BY_ROLE[role]];
}

/** Remove stale tool calls/results from resumed context so Main cannot imitate retired APIs. */
export function filterWorkflowToolContext<T>(messages: readonly T[], role: WorkflowRole): T[] {
	return messages.flatMap((message) => {
		if (message === null || typeof message !== "object") return [message];
		const record = message as { readonly role?: unknown; readonly toolName?: unknown; readonly content?: unknown };
		if (record.role === "toolResult" && typeof record.toolName === "string" && isWorkflowToolName(record.toolName) && !isWorkflowToolAllowed(record.toolName, role)) {
			return [];
		}
		if (record.role !== "assistant" || !Array.isArray(record.content)) return [message];
		const content = record.content.filter((block) => {
			if (block === null || typeof block !== "object") return true;
			const candidate = block as { readonly type?: unknown; readonly name?: unknown; readonly toolName?: unknown };
			if (candidate.type !== "toolCall") return true;
			const name = typeof candidate.name === "string" ? candidate.name : candidate.toolName;
			return typeof name !== "string" || !isWorkflowToolName(name) || isWorkflowToolAllowed(name, role);
		});
		return [{ ...record, content } as T];
	});
}
