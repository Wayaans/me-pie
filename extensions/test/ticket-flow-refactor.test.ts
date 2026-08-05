import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { Effect } from "effect";
import type { WorkItem } from "../ticket-flow/domain.ts";
import { AUDIT_PROMPT_TEMPLATE, assertExactAuditPrompt, buildAuditPrompt, reduceAuditRound } from "../ticket-flow/audit.ts";
import { ORCHESTRATOR_KICKOFF, parseTicketFlowCommand, ticketFlowArgumentCompletions } from "../ticket-flow/command.ts";
import { applyCompletionStrategy } from "../ticket-flow/completion.ts";
import { WorkflowDelegateParameters, WorkflowPlanParameters, registerOrchestratorTools } from "../ticket-flow/orchestrator/tools.ts";
import { delegateToolLabel, planToolLabel } from "../ticket-flow/orchestrator/renderers.ts";
import { shouldAutoContinueWorkflow, workflowContinuationKey } from "../ticket-flow/orchestrator/continuation.ts";
import { WorkflowWorkerParameters } from "../ticket-flow/worker/tools.ts";
import { WORKER_TOOL_NAMES, filterWorkflowToolContext, toolsForWorkflowRole, withoutWorkflowTools } from "../ticket-flow/tool-names.ts";
import { renderWorkflowWidget, workflowActivityForTool, workflowPhaseActivity } from "../ticket-flow/widget.ts";

function project(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-refactor-")); }
const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return { id: "one", title: "One", sourcePaths: ["ticket.md"], specificationPaths: ["spec.md"], requirements: ["Do one"], order: 1, orderReason: "first", dependsOn: [], delegationPrompt: "implement one", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status: "running", ...overrides };
}

const run = { id: "run", projectId: "p", projectPath: "/project", originalPrompt: "prompt", phase: "executing" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01", plan: { summary: "Feature", workItems: [item()], userResolutions: [], finalized: true }, planning: { unresolvedQuestions: ["Which API?"] , changes: [] }, activeWorkItemId: "one", requestedLaunchProfile: profile, tmux: { runId: "run", workItemId: "one", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "tf-one", socketPath: "/tmp/run.sock" } };

test("public command and tool surfaces are explicit and strict", () => {
	assert.deepEqual(parseTicketFlowCommand("status"), { action: "status" });
	assert.deepEqual(parseTicketFlowCommand("tmux implement tickets"), { backend: "tmux", prompt: "implement tickets" });
	assert.throws(() => parseTicketFlowCommand("pause now"), /does not accept arguments/);
	assert.deepEqual(ticketFlowArgumentCompletions("st")?.map((item) => item.value), ["status", "stop"]);
	assert.deepEqual(ticketFlowArgumentCompletions("")?.map((item) => item.value), ["status", "pause", "resume", "stop", "tmux"]);
	assert.equal(ticketFlowArgumentCompletions("tmux implement tickets"), null);
	assert.equal(ticketFlowArgumentCompletions("unknown"), null);
	for (const action of ["get", "save", "update"]) assert.equal(Check(WorkflowPlanParameters, { action }), true);
	assert.equal(Check(WorkflowPlanParameters, { action: "finalize" }), false);
	for (const action of ["start", "wait", "send", "accept", "revise", "close"]) assert.equal(Check(WorkflowDelegateParameters, { action }), true);
	for (const action of ["get", "send", "submit"]) assert.equal(Check(WorkflowWorkerParameters, { action }), true);
	assert.equal(Check(WorkflowWorkerParameters, { action: "send", message: "progress", blocking: false }), false);
	assert.deepEqual(WORKER_TOOL_NAMES, ["workflow_worker"]);
	const names: string[] = [];
	registerOrchestratorTools({ registerTool: (definition: { readonly name: string }) => names.push(definition.name) } as never, { activeRun: run } as never);
	assert.deepEqual(names, ["workflow_plan", "workflow_delegate"]);
});

test("orchestrator tools use the worker tool-plus-command interface", () => {
	assert.equal(planToolLabel("save"), "workflow-plan · save");
	assert.equal(planToolLabel("update"), "workflow-plan · update");
	assert.equal(delegateToolLabel("start"), "workflow-delegate · start");
	assert.equal(delegateToolLabel("accept"), "workflow-delegate · accept");
});

test("a finalized plan remains actionable and explicitly continues into delegation", () => {
	const { activeWorkItemId: _active, requestedLaunchProfile: _profile, tmux: _tmux, ...idleRun } = run;
	const ready = { ...idleRun, phase: "ready" as const, planning: { unresolvedQuestions: [], changes: [] } };
	assert.equal(shouldAutoContinueWorkflow(ready), true);
	assert.match(ORCHESTRATOR_KICKOFF, /continue.*delegat/i);
	assert.notEqual(workflowContinuationKey(ready), workflowContinuationKey({ ...ready, updatedAt: "2026-01-02" }));
	assert.equal(shouldAutoContinueWorkflow({ ...ready, phase: "awaiting-user", planning: { unresolvedQuestions: ["Which API?"], changes: [] } }), false);
	assert.equal(shouldAutoContinueWorkflow({ ...ready, phase: "paused" }), false);
	assert.equal(shouldAutoContinueWorkflow({ ...ready, phase: "completed" }), false);
});

test("retired workflow surfaces are removed from tools and resumed context", () => {
	assert.deepEqual(withoutWorkflowTools(["read", "workflow_obsolete", "bash"]), ["read", "bash"]);
	assert.deepEqual(toolsForWorkflowRole(["read", "workflow_obsolete"], "orchestrator"), ["read", "workflow_plan", "workflow_delegate"]);
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "keep" }, { type: "toolCall", name: "workflow_obsolete" }] },
		{ role: "toolResult", toolName: "workflow_obsolete", content: [] },
		{ role: "toolResult", toolName: "workflow_plan", content: [] },
	];
	assert.deepEqual(filterWorkflowToolContext(messages, "orchestrator"), [
		{ role: "assistant", content: [{ type: "text", text: "keep" }] },
		{ role: "toolResult", toolName: "workflow_plan", content: [] },
	]);
});

test("audit round reducer links findings and ignores at-least-once duplicates", () => {
	const auditItem = item({ id: "audit-round-1", kind: "audit", status: "completed" });
	const auditRun = {
		...run,
		phase: "auditing" as const,
		activeWorkItemId: auditItem.id,
		plan: { ...run.plan, workItems: [auditItem] },
		audit: { featureName: "Feature", ticketPath: "ticket.md", specPath: "spec.md", template: AUDIT_PROMPT_TEMPLATE, model: profile.model, thinking: profile.thinking, rounds: [], activeRound: 1 },
	};
	const report = {
		status: "completed" as const,
		summary: "finding",
		auditVerdicts: [{ requirement: "Do one", verdict: "fail" as const, evidence: "file.ts" }],
		auditFindings: [{ id: "finding-1", severity: "high" as const, finding: "Needs a fix", evidence: "file.ts" }],
	};
	const reduced = reduceAuditRound(auditRun, auditItem.id, report, "audit-report.json", "2026-01-01T00:00:00.000Z");
	assert.ok(reduced);
	assert.equal(reduced.fixWorkItemId, "fix-round-1");
	assert.equal(reduced.auditRound.findings?.[0]?.fixLink, "fix-round-1");
	assert.equal(reduceAuditRound({ ...auditRun, audit: reduced.auditState }, auditItem.id, report, "audit-report.json", "2026-01-01T00:00:01.000Z"), undefined);
});

test("approved audit prompt is immutable and exact", () => {
	const input = { featureName: "Feature", acceptedCommitIds: ["abc", "def"], ticketPath: "tickets/feature.md", specPath: "specs/feature.md" };
	const prompt = buildAuditPrompt(input);
	assert.equal(AUDIT_PROMPT_TEMPLATE.includes("zero-trust mindset"), true);
	assertExactAuditPrompt(prompt, input);
	assert.equal(prompt.startsWith("Audit the implementation"), true);
	assert.equal(prompt.endsWith("file-level evidence and fixes."), true);
	assert.throws(() => assertExactAuditPrompt(`${prompt}!`, input));
});

test("widget reports planning, plan updates, audit, audit fixes, and finalization steps", () => {
	const { activeWorkItemId: _active, requestedLaunchProfile: _profile, tmux: _tmux, ...idleRun } = run;
	const planning = { ...idleRun, phase: "analyzing" as const, planning: { unresolvedQuestions: [], changes: [] }, plan: { ...run.plan, finalized: false } };
	assert.equal(workflowPhaseActivity(planning), "Planning");
	assert.equal(workflowActivityForTool("workflow_plan", { action: "update" }, planning), "Updating plan");
	assert.equal(workflowActivityForTool("workflow_plan", { action: "save", plan: { finalized: true } }, planning), "Finalizing plan");
	const auditing = { ...idleRun, phase: "auditing" as const, planning: { unresolvedQuestions: [], changes: [] } };
	assert.equal(workflowPhaseActivity(auditing), "Auditing");
	assert.equal(workflowPhaseActivity({ ...auditing, phase: "fixing" }), "Fixing audit");
	assert.equal(workflowActivityForTool("workflow_delegate", { action: "accept" }, auditing), "Finalizing audit");
	assert.match(renderWorkflowWidget(planning, 80).join("\n"), /Planning/);
	assert.match(renderWorkflowWidget(planning, 80, { activity: "Finalizing plan" }).join("\n"), /Finalizing plan/);
});

test("widget is bordered, compact, animated, and width-safe", () => {
	for (const width of [1, 8, 24, 80, 120]) {
		const lines = renderWorkflowWidget(run, width, { frame: 2 });
		assert.ok(lines.length >= 3);
		for (const line of lines) {
			const withoutAnsi = line.replace(/\u001b\[[0-9;]*m/g, "");
			assert.ok([...withoutAnsi].length <= width, `${width}: ${withoutAnsi}`);
		}
	}
	assert.match(renderWorkflowWidget(run, 80).join("\n"), /clarification|tmux|running/);
});

test("completion text replacement and markdown checkbox are idempotent", async () => {
	const cwd = project();
	fs.writeFileSync(path.join(cwd, "ticket.md"), "- [ ] Do one\nold\n");
	const input = { projectPath: cwd, runId: "run", workItemId: "one", workItemTitle: "One", comment: "accepted", completedAt: "2026-01-01" };
	assert.equal((await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "text-replacement", path: "ticket.md", oldText: "old", newText: "new" } }))).changed, true);
	assert.equal((await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "text-replacement", path: "ticket.md", oldText: "old", newText: "new" } }))).changed, false);
	assert.equal((await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "markdown-checkbox", path: "ticket.md", text: "Do one" } }))).changed, true);
	assert.match(fs.readFileSync(path.join(cwd, "ticket.md"), "utf8"), /- \[x\] Do one/);
	assert.equal((await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "markdown-checkbox", path: "ticket.md", text: "Do one" } }))).changed, false);
	fs.rmSync(cwd, { recursive: true, force: true });
});
