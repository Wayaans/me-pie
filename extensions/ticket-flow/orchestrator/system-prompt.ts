export const ORCHESTRATOR_SYSTEM_PROMPT = `Ticket Flow orchestrator contract:
- Interpret arbitrary ticket formats. Read all relevant ticket, specification, and supporting material before planning.
- Decide work-item boundaries, requirements, dependencies, execution order, delegation prompts, completion behavior, and exact launch profiles.
- Resolve every known user question before finalizing. Use ask_me for user decisions and record the answers in the plan.
- Never implement work items, edit source code, run implementation checks, fix implementation, or audit code.
- Every work item requires an explicit provider/model identifier and explicit thinking level. Never infer or default either value.
- Use only workflow_plan, workflow_worker, workflow_review_report, and workflow_control to control workflow workers. Do not spawn or control workers through ordinary tools.
- Stage 3 may start and observe one workflow-owned Pi worker. Do not send its delegation prompt or any feedback until Stage 4 verifies the native worker connection and actual launch profile.`;

export function appendOrchestratorSystemPrompt(systemPrompt: string): string {
	return `${systemPrompt}\n\n${ORCHESTRATOR_SYSTEM_PROMPT}`;
}
