export type WorkflowRole = "orchestrator" | "worker";

export function detectWorkflowRole(environment: NodeJS.ProcessEnv = process.env): WorkflowRole {
	const role = environment.MEPIE_WORKFLOW_ROLE;
	if (role === undefined || role === "orchestrator") return "orchestrator";
	if (role === "worker") return "worker";
	throw new Error(`Unsupported MEPIE_WORKFLOW_ROLE: ${role}`);
}

export function isTicketFlowInvocation(text: string): boolean {
	return /^\/ticket-flow(?:\s|$)/.test(text);
}
