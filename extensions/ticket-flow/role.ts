export type WorkflowRole = "orchestrator" | "worker";

export function detectWorkflowRole(environment: NodeJS.ProcessEnv = process.env): WorkflowRole {
	return environment.MEPIE_WORKFLOW_ROLE === "worker" ? "worker" : "orchestrator";
}

export function isTicketFlowInvocation(text: string): boolean {
	return /^\/ticket-flow(?:\s|$)/.test(text);
}
