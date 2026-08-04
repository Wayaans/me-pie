import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { WorkItem, WorkerIdentity, WorkflowRun } from "../ticket-flow/domain.ts";
import { replayEvents } from "../ticket-flow/event-store.ts";
import { inspectProjectLock } from "../ticket-flow/lock.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { readWorkflowToken, workflowTokenPath } from "../ticket-flow/protocol/runtime.ts";
import { reconcileRecovery } from "../ticket-flow/recovery.ts";
import { WorkerReportRuntime } from "../ticket-flow/worker/report.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
function item(status: WorkItem["status"] = "planned"): WorkItem {
	return { id: "one", title: "One", sourcePaths: ["ticket.md"], specificationPaths: ["spec.md"], requirements: ["Do one"], order: 1, orderReason: "first", dependsOn: [], delegationPrompt: "/implement one", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status };
}
function temporary(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for condition"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

class FakeTmux {
	created = 0;
	closed = 0;
	inspection: "alive" | "exited" | "missing" | "foreign" | "ambiguous" = "alive";
	createWorkerWindow(input: { runId: string; workItemId: string; socketPath: string }) {
		this.created += 1;
		return Effect.succeed({ runId: input.runId, workItemId: input.workItemId, serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "tf-01-one", socketPath: input.socketPath });
	}
	inspectWindow() { return Effect.succeed({ state: this.inspection }); }
	closeWindow() { this.closed += 1; return Effect.succeed({ forced: false, alreadyExited: this.inspection !== "alive" }); }
	detect() { return Effect.void; }
	capturePane() { return Effect.succeed(""); }
}
function tools() {
	let active = ["read", "bash"];
	return { pi: { getActiveTools: () => [...active], setActiveTools: (next: string[]) => { active = [...next]; } }, active: () => active };
}
async function startExecuting(project: string, agent: string, runId: string, tmux: FakeTmux, sessionId = "session-one") {
	const toolState = tools();
	const controller = new WorkflowController(toolState.pi, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "recover me", agentDir: agent, sessionId }));
	await Effect.runPromise(controller.savePlan({ summary: "one", workItems: [item()], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const run = await Effect.runPromise(controller.startWorker("one"));
	return { controller, run, toolState };
}

function reconciliationRun(status: WorkItem["status"], overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	const runId = "run";
	return {
		id: runId, projectId: "a".repeat(64), projectPath: "/project", originalPrompt: "prompt", phase: "paused", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		plan: { summary: "one", workItems: [item(status)], userResolutions: [], finalized: true }, planning: { unresolvedQuestions: [], changes: [] }, activeWorkItemId: "one", requestedLaunchProfile: profile, workflowSocketPath: "/tmp/run.sock",
		tmux: { runId, workItemId: "one", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main", windowId: "@1", paneId: "%1", displayName: "one", socketPath: "/tmp/run.sock" },
		worker: { runId, workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", sessionId: "worker-session" },
		...overrides,
	};
}

test("recovery reconciliation classifies disconnected, pending-report, profile, foreign, missing, and ambiguous states", async () => {
	const inspect = (state: FakeTmux["inspection"]) => ({ inspectWindow: () => Effect.succeed({ state }) });
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("running"), inspect("alive") as never))).kind, "worker-alive-disconnected");
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("report-review"), inspect("missing") as never))).kind, "worker-exited-pending-report");
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("running"), inspect("foreign") as never))).kind, "foreign-tmux-id");
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("running"), inspect("missing") as never))).kind, "window-missing");
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("running", { worker: { runId: "run", workItemId: "one", provider: "openai-codex", model: "other", thinking: "high" } }), inspect("alive") as never))).kind, "profile-mismatch");
	assert.equal((await Effect.runPromise(reconcileRecovery(reconciliationRun("running", { protocolCommands: [{ type: "feedback", requestId: "r", messageId: "m", acknowledged: false }] }), inspect("alive") as never))).kind, "ambiguous");
});

test("orchestrator reload preserves the worker and recovers the same socket without duplicate creation", async () => {
	const project = temporary("ticket-flow-stage7-reload-project-"); const agent = temporary("ticket-flow-stage7-reload-agent-"); const tmux = new FakeTmux();
	const { controller, run } = await startExecuting(project, agent, "reload-run", tmux);
	const resolved = await Effect.runPromise(pathsForProject(project, "reload-run", agent));
	const identity: WorkerIdentity = { runId: "reload-run", workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", sessionId: "worker-session" };
	const prompts: string[] = [];
	const client = new ProtocolClient({ socketPath: run.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: (prompt) => { prompts.push(prompt); }, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start()); await eventually(() => client.authoritativeContext !== undefined);
	await Effect.runPromise(controller.shutdown()); await Effect.runPromise(controller.shutdown());
	assert.equal(tmux.closed, 0); assert.equal(fs.existsSync(workflowTokenPath(resolved.paths.runDir)), true); assert.equal(fs.existsSync(path.join(resolved.paths.rootDir, `${resolved.paths.projectId}.lock`)), true);
	const replacement = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
	const recovered = await Effect.runPromise(replacement.recover({ cwd: project, agentDir: agent, runId: "reload-run", sessionId: "session-one" }));
	await eventually(() => client.isVerified);
	assert.equal(recovered.activeWorkItemId, "one"); assert.equal(tmux.created, 1); assert.equal(prompts.length, 1);
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(replacement.stop());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("pause and resume preserve a connected worker and never spawn a second window", async () => {
	const project = temporary("ticket-flow-stage7-pause-project-"); const agent = temporary("ticket-flow-stage7-pause-agent-"); const tmux = new FakeTmux();
	const { controller, run } = await startExecuting(project, agent, "pause-run", tmux);
	const resolved = await Effect.runPromise(pathsForProject(project, "pause-run", agent));
	const client = new ProtocolClient({ socketPath: run.workflowSocketPath!, identity: { runId: "pause-run", workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined });
	await Effect.runPromise(client.start()); await eventually(() => client.authoritativeContext !== undefined);
	assert.equal((await Effect.runPromise(controller.pause())).phase, "paused");
	assert.equal((await Effect.runPromise(controller.resume())).phase, "executing");
	assert.equal(tmux.created, 1); assert.equal(controller.activeRun?.plan.workItems[0]?.status, "running");
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(controller.stop());
	fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("a worker exit after report submission preserves report review across later recovery", async () => {
	const project = temporary("ticket-flow-stage7-report-project-"); const agent = temporary("ticket-flow-stage7-report-agent-"); const tmux = new FakeTmux();
	const { controller, run } = await startExecuting(project, agent, "report-run", tmux);
	const resolved = await Effect.runPromise(pathsForProject(project, "report-run", agent));
	const client = new ProtocolClient({ socketPath: run.workflowSocketPath!, identity: { runId: "report-run", workItemId: "one", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined });
	await Effect.runPromise(client.start()); await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit({ status: "completed", summary: "Done", requirements: [{ requirementId: "requirement-1", result: "satisfied", evidence: "Implemented" }], filesChanged: [], filesChangedExplanation: "No files", checks: [{ command: "bun test", result: "passed" }], caveats: [], blockers: [] }, client.authoritativeContext!);
	await eventually(() => controller.activeRun?.plan.workItems[0]?.status === "report-review");
	await Effect.runPromise(client.shutdown()); await Effect.runPromise(controller.shutdown()); tmux.inspection = "missing";
	const replacement = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
	const recovered = await Effect.runPromise(replacement.recover({ cwd: project, agentDir: agent, runId: "report-run", sessionId: "session-one" }));
	assert.equal(recovered.phase, "executing"); assert.equal(recovered.plan.workItems[0]?.status, "report-review"); assert.equal(tmux.created, 1);
	await Effect.runPromise(replacement.stop()); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("dead matching owners are taken over and every takeover is recorded", async () => {
	const project = temporary("ticket-flow-stage7-stale-project-"); const agent = temporary("ticket-flow-stage7-stale-agent-"); const tmux = new FakeTmux();
	const { controller } = await startExecuting(project, agent, "stale-run", tmux);
	await Effect.runPromise(controller.shutdown());
	const resolved = await Effect.runPromise(pathsForProject(project, "stale-run", agent));
	const ownerFile = path.join(resolved.paths.rootDir, `${resolved.paths.projectId}.lock`, "owner.json");
	const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 999_999_999 }));
	const status = await Effect.runPromise(inspectProjectLock(resolved.paths.rootDir, resolved.paths.projectId, { runId: "stale-run", liveness: { isAlive: () => false } }));
	assert.equal(status.state, "stale");
	const replacement = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
	await Effect.runPromise(replacement.recover({ cwd: project, agentDir: agent, runId: "stale-run", sessionId: "session-two" }));
	const events = await Effect.runPromise(replayEvents(resolved.paths.eventsFile));
	assert.equal(events.some((event) => event.type === "lock-taken-over"), true);
	await Effect.runPromise(replacement.stop()); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("ambiguous lock ownership requires explicit takeover approval", async () => {
	const project = temporary("ticket-flow-stage7-ambiguous-project-"); const agent = temporary("ticket-flow-stage7-ambiguous-agent-"); const tmux = new FakeTmux();
	const { controller } = await startExecuting(project, agent, "ambiguous-run", tmux); await Effect.runPromise(controller.shutdown());
	const resolved = await Effect.runPromise(pathsForProject(project, "ambiguous-run", agent));
	fs.writeFileSync(path.join(resolved.paths.rootDir, `${resolved.paths.projectId}.lock`, "owner.json"), "{}");
	const denied = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
	await assert.rejects(Effect.runPromise(denied.recover({ cwd: project, agentDir: agent, runId: "ambiguous-run" })), /LockContention|lock/i);
	const approved = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
	await Effect.runPromise(approved.recover({ cwd: project, agentDir: agent, runId: "ambiguous-run", allowAmbiguousTakeover: true }));
	await Effect.runPromise(approved.stop()); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
});

test("missing and reused windows pause recovery and are never closed", async () => {
	for (const state of ["missing", "foreign"] as const) {
		const project = temporary(`ticket-flow-stage7-${state}-project-`); const agent = temporary(`ticket-flow-stage7-${state}-agent-`); const tmux = new FakeTmux();
		const { controller } = await startExecuting(project, agent, `${state}-run`, tmux); await Effect.runPromise(controller.shutdown()); tmux.inspection = state;
		const replacement = new WorkflowController(tools().pi, undefined, undefined, tmux as never);
		const recovered = await Effect.runPromise(replacement.recover({ cwd: project, agentDir: agent, runId: `${state}-run`, sessionId: "session-one" }));
		assert.equal(recovered.phase, "paused"); assert.equal(tmux.created, 1); assert.equal(tmux.closed, 0);
		await Effect.runPromise(replacement.shutdown()); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
	}
});
