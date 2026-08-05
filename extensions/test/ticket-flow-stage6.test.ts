import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { WorkflowController } from "../ticket-flow/controller.ts";
import { applyCompletionStrategy, type CompletionApplicationInput } from "../ticket-flow/completion.ts";
import type { WorkItem, WorkerIdentity, WorkerReport } from "../ticket-flow/domain.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { readWorkflowToken } from "../ticket-flow/protocol/runtime.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { loadRun, saveRun } from "../ticket-flow/state-store.ts";
import { readReportAttempt, WorkerReportRuntime } from "../ticket-flow/worker/report.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "one", title: "One", sourcePaths: ["ticket.md"], specificationPaths: ["spec.md"], requirements: ["Do one"], order: 1,
		orderReason: "first", dependsOn: [], delegationPrompt: "/implement one", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status: "planned", ...overrides,
	};
}
function report(): WorkerReport {
	return { status: "completed", summary: "Done enough", requirements: [{ requirementId: "requirement-1", result: "satisfied", evidence: "implemented" }], filesChanged: [], filesChangedExplanation: "No files changed", checks: [{ command: "bun run typecheck", result: "passed" }], caveats: [], blockers: [] };
}
async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test("completion strategies mutate only explicit trusted project targets and are idempotent", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-completion-project-"));
	fs.writeFileSync(path.join(project, "ticket.md"), "---\nstatus: open\n---\nTicket\n");
	fs.writeFileSync(path.join(project, "log.md"), "Log\n");
	const base: Omit<CompletionApplicationInput, "strategy"> = {
		projectPath: project, runId: "run", workItemId: "item", workItemTitle: "Item", comment: "Accepted", completedAt: "2026-01-01T00:00:00.000Z",
	};
	await Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "append-markdown", path: "log.md" } }));
	const before = fs.readFileSync(path.join(project, "log.md"), "utf8");
	const second = await Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "append-markdown", path: "log.md" } }));
	assert.equal(second.changed, false);
	assert.equal(fs.readFileSync(path.join(project, "log.md"), "utf8"), before);
	await Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "frontmatter", path: "ticket.md", field: "status", value: "done" } }));
	assert.match(fs.readFileSync(path.join(project, "ticket.md"), "utf8"), /status: done/);
	await assert.rejects(Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "append-markdown", path: "../outside.md" } })), /escapes|outside/);
	await Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "rename-file", from: "ticket.md", to: "done.md" } }));
	const repeated = await Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "rename-file", from: "ticket.md", to: "done.md" } }));
	assert.equal(repeated.changed, false);
	assert.equal(fs.existsSync(path.join(project, "done.md")), true);
	fs.rmSync(project, { recursive: true, force: true });
});

test("stage6 smoke accepts a ledger report and completes the run", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-smoke-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-smoke-agent-"));
	const runId = "stage6-smoke";
	const identity: WorkerIdentity = { runId, workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({ runId, workItemId: "one", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "tf-01-one", socketPath: input.socketPath }),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }),
		detect: () => Effect.void,
		capturePane: () => Effect.succeed(""),
	};
	const controller = new WorkflowController({ getActiveTools: () => ["read"], setActiveTools: () => undefined }, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "smoke", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "smoke", auditProfile: profile, workItems: [item()], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("one"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [5] });
	await Effect.runPromise(client.start());
	await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit(report(), client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "report-review");
	const accepted = await Effect.runPromise(controller.acceptReport("one", "Reviewed and accepted"));
	assert.equal(accepted.phase, "auditing");
	assert.equal(accepted.plan.workItems[0]?.status, "completed");
	assert.equal(accepted.plan.workItems.find((candidate) => candidate.kind === "audit")?.status, "ready");
	assert.equal(accepted.plan.workItems[0]?.completion?.comment, "Reviewed and accepted");
	const persisted = await Effect.runPromise(loadRun(resolved.paths));
	assert.equal(persisted.plan.workItems[0]?.completion?.acceptedAttempt, 1);
	assert.equal(controller.activeRun?.phase, "auditing");
	await Effect.runPromise(client.shutdown());
	await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("acceptance leaves the next dependency-ready item for explicit delegation", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-sequence-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-sequence-agent-"));
	const runId = "stage6-sequence";
	let windowNumber = 0;
	const tmux = {
		createWorkerWindow: (input: { runId: string; workItemId: string; socketPath: string }) => {
			windowNumber += 1;
			return Effect.succeed({ runId: input.runId, workItemId: input.workItemId, serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: `@${windowNumber}`, paneId: `%${windowNumber}`, displayName: `tf-${input.workItemId}`, socketPath: input.socketPath });
		},
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }), detect: () => Effect.void, capturePane: () => Effect.succeed(""),
	};
	const controller = new WorkflowController({ getActiveTools: () => ["read"], setActiveTools: () => undefined }, undefined, () => runId, tmux as never);
	const first = item();
	const second = item({ id: "two", title: "Two", order: 2, dependsOn: ["one"], delegationPrompt: "/implement two" });
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "sequence", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "sequence", auditProfile: profile, workItems: [first, second], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("one"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const connect = async (workItemId: string, workflowSocketPath: string) => {
		const workerIdentity: WorkerIdentity = { runId, workItemId, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
		const client = new ProtocolClient({ socketPath: workflowSocketPath, identity: workerIdentity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [5] });
		await Effect.runPromise(client.start());
		await eventually(() => client.authoritativeContext !== undefined);
		return client;
	};
	const firstClient = await connect("one", started.workflowSocketPath!);
	await new WorkerReportRuntime(firstClient).submit(report(), firstClient.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems.find((candidate) => candidate.id === "one")?.status === "report-review");
	const afterFirst = await Effect.runPromise(controller.acceptReport("one", "Accepted first"));
	assert.equal(afterFirst.activeWorkItemId, undefined);
	assert.equal(afterFirst.plan.workItems.find((candidate) => candidate.id === "one")?.status, "completed");
	assert.equal(afterFirst.plan.workItems.find((candidate) => candidate.id === "two")?.status, "ready");
	await Effect.runPromise(firstClient.shutdown());
	const explicitlyStarted = await Effect.runPromise(controller.startWorker("two"));
	assert.equal(explicitlyStarted.plan.workItems.find((candidate) => candidate.id === "two")?.status, "verifying-worker");
	const secondClient = await connect("two", explicitlyStarted.workflowSocketPath!);
	await new WorkerReportRuntime(secondClient).submit(report(), secondClient.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems.find((candidate) => candidate.id === "two")?.status === "report-review");
	const finished = await Effect.runPromise(controller.acceptReport("two", "Accepted second"));
	assert.equal(finished.phase, "auditing");
	assert.equal(finished.plan.workItems.filter((candidate) => candidate.kind !== "audit").every((candidate) => candidate.status === "completed"), true);
	assert.equal(finished.plan.workItems.find((candidate) => candidate.kind === "audit")?.status, "ready");
	await Effect.runPromise(secondClient.shutdown());
	await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("finalized plans reject forged active or terminal work-item states", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-paused-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-paused-agent-"));
	const runId = "stage6-paused";
	const tmux = { detect: () => Effect.void };
	const controller = new WorkflowController({ getActiveTools: () => ["read"], setActiveTools: () => undefined }, undefined, () => runId, tmux as never);
	try {
		await Effect.runPromise(controller.startRun({ cwd: project, prompt: "paused", agentDir: agent }));
		await Effect.runPromise(controller.savePlan({ summary: "paused", auditProfile: profile, workItems: [item(), item({ id: "two", title: "Two", order: 2, status: "failed" })], userResolutions: [], finalized: false }));
		await assert.rejects(Effect.runPromise(controller.finalizePlan()), /initial planned state/);
	} finally {
		if (controller.activeRun) await Effect.runPromise(controller.stop()).catch(() => undefined);
		fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("revision feedback returns the same worker to running and preserves repeated attempts", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-revision-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-revision-agent-"));
	const runId = "stage6-revision";
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({ runId, workItemId: "one", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "tf-01-one", socketPath: input.socketPath }),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }), detect: () => Effect.void, capturePane: () => Effect.succeed(""),
	};
	const feedback: string[] = [];
	const controller = new WorkflowController({ getActiveTools: () => ["read"], setActiveTools: () => undefined }, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "revision", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "revision", auditProfile: profile, workItems: [item()], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("one"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const identity: WorkerIdentity = { runId, workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: (message) => { feedback.push(message); }, onShutdown: () => undefined, retryDelaysMs: [5] });
	await Effect.runPromise(client.start()); await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit(report(), client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "report-review");
	const revised = await Effect.runPromise(controller.reviseReport("one", "Please add concrete evidence", ["requirement-1"]));
	assert.equal(revised.plan.workItems[0]?.status, "running");
	assert.deepEqual(feedback, ["Please add concrete evidence"]);
	await eventually(() => {
		const commands = controller.activeRun?.protocolCommands ?? [];
		return commands.length > 0 && commands.every((command) => command.acknowledged);
	});
	const checkpointed = await Effect.runPromise(loadRun(resolved.paths));
	const recoveryCheckpoint = { operation: "accept" as const, stage: "accepting", workItemId: "one", updatedAt: new Date().toISOString(), reportAttempt: 1 };
	const recovering = { ...checkpointed, progression: recoveryCheckpoint };
	await Effect.runPromise(saveRun(resolved.paths, recovering));
	const activeState = (controller as unknown as { active?: { run: typeof recovering } }).active;
	assert.notEqual(activeState, undefined);
	activeState!.run = recovering;
	assert.equal(controller.activeRun?.progression?.reportAttempt, 1);
	await new WorkerReportRuntime(client).submit({ ...report(), summary: "Done with evidence" }, client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "report-review");
	const inspection = JSON.parse(await Effect.runPromise(controller.inspectReport("one"))) as { latestAttempt: { attempt: number; report: WorkerReport } };
	assert.equal(inspection.latestAttempt.attempt, 2);
	assert.equal(inspection.latestAttempt.report.summary, "Done with evidence");
	assert.equal(controller.activeRun?.progression?.reportAttempt, 1);
	const firstAttempt = await Effect.runPromise(readReportAttempt(resolved.paths, "one", 1));
	assert.equal(firstAttempt.report.summary, "Done enough");
	const finished = await Effect.runPromise(controller.acceptReport("one", "Evidence reviewed"));
	assert.equal(finished.phase, "auditing");
	assert.equal(finished.plan.workItems[0]?.completion?.acceptedAttempt, 1);
	const acceptedReport = JSON.parse(fs.readFileSync(finished.plan.workItems[0]!.completion!.acceptedReportPath, "utf8")) as { report: WorkerReport };
	assert.equal(acceptedReport.report.summary, "Done enough");
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("blocked workers resume through persisted answers and native same-session feedback", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-block-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage6-block-agent-"));
	const runId = "stage6-block";
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({ runId, workItemId: "one", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "tf-01-one", socketPath: input.socketPath }),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }), detect: () => Effect.void, capturePane: () => Effect.succeed(""),
	};
	const feedback: string[] = [];
	const controller = new WorkflowController({ getActiveTools: () => ["read"], setActiveTools: () => undefined }, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "block", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "block", auditProfile: profile, workItems: [item()], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("one"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const identity: WorkerIdentity = { runId, workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" };
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: (message) => { feedback.push(message); }, onShutdown: () => undefined, retryDelaysMs: [5] });
	await Effect.runPromise(client.start()); await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit({ status: "blocked", summary: "Need a product answer", blockers: ["Choose behavior"], questions: ["Which behavior should be used?"], userInterventionRequired: true }, client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "blocked");
	assert.equal(controller.activeRun?.phase, "paused");
	await Effect.runPromise(controller.blockReport("one", { message: "Choose behavior", questions: ["Which behavior should be used?"] }));
	const resumed = await Effect.runPromise(controller.resumeBlockedWorker("one", ["Which behavior should be used?"], ["Use strict behavior"]));
	assert.equal(resumed.phase, "executing");
	assert.equal(resumed.plan.workItems[0]?.status, "running");
	assert.match(feedback.at(-1) ?? "", /Use strict behavior/);
	await new WorkerReportRuntime(client).submit(report(), client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "report-review");
	const finished = await Effect.runPromise(controller.acceptReport("one", "Accepted after blocker resolution"));
	assert.equal(finished.phase, "auditing");
	assert.equal(finished.plan.userResolutions[0]?.answer, "Use strict behavior");
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});
