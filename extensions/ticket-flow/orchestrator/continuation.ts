import type { WorkflowRun } from "../domain.ts";

export const WORKFLOW_CONTINUATION_KICKOFF = "Continue the active Ticket Flow now. Inspect the durable state, perform the next explicit workflow operation with workflow_plan or workflow_delegate, and keep progressing through implementation, audit, audit fixes, and final audit until completion or a genuine user decision is required. Do not stop merely because planning or one intermediate step finished.";

/** A run remains agent-actionable until it reaches a terminal, failed, paused,
 * or user-blocked state. This is used only to schedule another Main turn; every
 * durable workflow mutation remains explicit through the workflow tools. */
export function shouldAutoContinueWorkflow(run: WorkflowRun): boolean {
	if (run.planning.unresolvedQuestions.length > 0) return false;
	return run.phase !== "awaiting-user"
		&& run.phase !== "paused"
		&& run.phase !== "completed"
		&& run.phase !== "failed"
		&& run.phase !== "stopped";
}

/** Prevent an unproductive agent from being re-prompted forever. A continuation
 * is scheduled at most once for each durable workflow state. */
export function workflowContinuationKey(run: WorkflowRun): string {
	return JSON.stringify({
		id: run.id,
		phase: run.phase,
		updatedAt: run.updatedAt,
		activeWorkItemId: run.activeWorkItemId,
		progression: run.progression && [run.progression.operation, run.progression.stage, run.progression.workItemId, run.progression.updatedAt],
		items: run.plan.workItems.map((item) => [item.id, item.kind, item.status, item.completion?.acceptedAttempt]),
		audit: run.audit && [run.audit.activeRound, run.audit.rounds.length, run.audit.rounds.at(-1)?.status],
		reports: run.reportReferences?.length ?? 0,
	});
}
