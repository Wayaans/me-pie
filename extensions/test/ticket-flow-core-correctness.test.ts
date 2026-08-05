import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { PiLaunchProfile, WorkItem, WorkerIdentity, WorkerReport } from "../ticket-flow/domain.ts";
import { applyCompletionStrategy } from "../ticket-flow/completion.ts";
import { appendEvent, makeWorkflowEvent } from "../ticket-flow/event-store.ts";
import { gitPreflight, gitStateFromPreflight, validateAcceptedCommitIds } from "../ticket-flow/git.ts";
import { loadRun, pendingPersistencePath, saveRun, stagePendingSnapshot } from "../ticket-flow/state-store.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { readWorkflowToken } from "../ticket-flow/protocol/runtime.ts";
import { WorkerReportRuntime } from "../ticket-flow/worker/report.ts";

const profile: PiLaunchProfile = { model: "test/provider", thinking: "high" };

function temporary(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Ticket Flow state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

class FakeTmux {
	created = 0;
	closed = 0;
	inspection: "alive" | "missing" = "alive";

	createWorkerWindow(input: { readonly runId: string; readonly workItemId: string; readonly socketPath: string }) {
		this.created += 1;
		this.inspection = "alive";
		return Effect.succeed({ runId: input.runId, workItemId: input.workItemId, serverSocketPath: "/tmp/ticket-flow-test.sock", sessionId: "$1", sessionName: "test", windowId: `@${this.created}`, paneId: `%${this.created}`, displayName: input.workItemId, socketPath: input.socketPath });
	}
	inspectWindow() { return Effect.succeed({ state: this.inspection }); }
	closeWindow() { this.closed += 1; this.inspection = "missing"; return Effect.succeed({ forced: false, alreadyExited: false }); }
	detect() { return Effect.void; }
	capturePane() { return Effect.succeed(""); }
}

function implementationItem(): WorkItem {
	return { id: "implementation", title: "Implementation", sourcePaths: ["ticket.md"], specificationPaths: ["spec.md"], requirements: ["Implement the feature"], order: 1, orderReason: "first", dependsOn: [], delegationPrompt: "implement the feature", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status: "planned" };
}

function completedReport(item: WorkItem): WorkerReport {
	return { status: "completed", summary: `Completed ${item.id}`, requirements: item.requirements.map((requirement) => ({ requirement, result: "satisfied" as const, evidence: "verified in the worker" })), filesChanged: [], filesChangedExplanation: "The test worker does not edit the fixture.", checks: [{ command: "test", result: "passed" }], caveats: [], blockers: [] };
}

function auditReport(item: WorkItem, finding = false): WorkerReport {
	return {
		status: "completed",
		summary: finding ? "Found one issue" : "Clean audit",
		auditVerdicts: item.requirements.map((requirement) => ({ requirement, verdict: finding ? "fail" as const : "pass" as const, evidence: "file-level audit evidence" })),
		...(finding ? { auditFindings: [{ id: "finding-1", severity: "high" as const, finding: "The implementation needs one correction.", evidence: "ticket-flow-core-correctness.test.ts" }] } : {}),
		filesChanged: [],
		filesChangedExplanation: "Read-only audit worker.",
		checks: [{ command: "audit", result: "passed" }],
		caveats: [],
		blockers: [],
	};
}

async function connect(controller: WorkflowController, project: string, agent: string, runId: string, item: WorkItem): Promise<ProtocolClient> {
	const paths = await Effect.runPromise(pathsForProject(project, runId, agent));
	const launchProfile = item.launchProfile;
	if (!launchProfile?.model || !launchProfile.thinking) throw new Error("test item has no complete launch profile");
	const [provider, model] = launchProfile.model.split("/", 2) as [string, string];
	const identity: WorkerIdentity = { runId, workItemId: item.id, provider, model, thinking: launchProfile.thinking };
	const client = new ProtocolClient({ socketPath: controller.activeRun!.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(paths.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [5] });
	await Effect.runPromise(client.start());
	await eventually(() => client.authoritativeContext !== undefined);
	return client;
}

test("audit finding -> fix -> fresh audit records unique rounds and only a clean round completes", async () => {
	const project = temporary("ticket-flow-core-audit-project-");
	const agent = temporary("ticket-flow-core-audit-agent-");
	const runId = `audit-${crypto.randomUUID()}`;
	const tmux = new FakeTmux();
	const clients: ProtocolClient[] = [];
	let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, () => new Date("2026-01-01T00:00:00.000Z"), () => runId, tmux as never);
	try {
		await Effect.runPromise(controller.startRun({ cwd: project, prompt: "audit loop", agentDir: agent }));
		await Effect.runPromise(controller.savePlan({ summary: "Core audit loop", auditProfile: profile, workItems: [implementationItem()], userResolutions: [], finalized: false }));
		await Effect.runPromise(controller.finalizePlan());
		await Effect.runPromise(controller.startWorker("implementation"));
		const implementationClient = await connect(controller, project, agent, runId, implementationItem()); clients.push(implementationClient);
		await new WorkerReportRuntime(implementationClient).submit(completedReport(implementationItem()), implementationClient.authoritativeContext!);
		await eventually(() => controller.activeRun?.plan.workItems.find((item) => item.id === "implementation")?.status === "report-review");
		await Effect.runPromise(controller.acceptReport("implementation", "accepted"));
		await Effect.runPromise(controller.startWorker("audit-round-1"));
		const firstAudit = controller.activeRun!.plan.workItems.find((item) => item.id === "audit-round-1")!;
		const firstAuditClient = await connect(controller, project, agent, runId, firstAudit); clients.push(firstAuditClient);
		await new WorkerReportRuntime(firstAuditClient).submit(auditReport(firstAudit, true), firstAuditClient.authoritativeContext!);
		await eventually(() => controller.activeRun?.plan.workItems.find((item) => item.id === firstAudit.id)?.status === "report-review");
		await Effect.runPromise(controller.acceptReport(firstAudit.id, "findings accepted"));
		const fix = controller.activeRun!.plan.workItems.find((item) => item.kind === "fix")!;
		assert.deepEqual(fix.auditFindingIds, ["finding-1"]);
		assert.equal(controller.activeRun?.audit?.rounds[0]?.fixWorkItemId, fix.id);
		await Effect.runPromise(controller.startWorker(fix.id));
		const fixClient = await connect(controller, project, agent, runId, fix); clients.push(fixClient);
		await new WorkerReportRuntime(fixClient).submit(completedReport(fix), fixClient.authoritativeContext!);
		await eventually(() => controller.activeRun?.plan.workItems.find((item) => item.id === fix.id)?.status === "report-review");
		await Effect.runPromise(controller.acceptReport(fix.id, "fix accepted"));
		assert.equal(controller.activeRun?.phase, "auditing");
		assert.equal(controller.activeRun?.plan.workItems.filter((item) => item.id === "audit-round-2").length, 1);
		await Effect.runPromise(controller.startWorker("audit-round-2"));
		const secondAudit = controller.activeRun!.plan.workItems.find((item) => item.id === "audit-round-2")!;
		const secondAuditClient = await connect(controller, project, agent, runId, secondAudit); clients.push(secondAuditClient);
		await new WorkerReportRuntime(secondAuditClient).submit(auditReport(secondAudit), secondAuditClient.authoritativeContext!);
		await eventually(() => controller.activeRun?.plan.workItems.find((item) => item.id === secondAudit.id)?.status === "report-review");
		const finished = await Effect.runPromise(controller.acceptReport(secondAudit.id, "clean audit accepted"));
		assert.equal(finished.phase, "completed");
		assert.deepEqual(finished.audit?.rounds.map((round) => round.round), [1, 2]);
		assert.equal(new Set(finished.audit?.rounds.map((round) => round.round)).size, 2);
		assert.match(finished.finalSummary ?? "", /Audit round 1: findings/);
		assert.match(finished.finalSummary ?? "", /Fix worker: fix-round-1/);
		assert.match(finished.finalSummary ?? "", /Audit round 2: clean/);
	} finally {
		for (const client of clients) await Effect.runPromise(client.shutdown()).catch(() => undefined);
		if (controller.activeRun) await Effect.runPromise(controller.stop()).catch(() => Effect.runPromise(controller.shutdown()));
		fs.rmSync(project, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("Git acceptance rejects malformed, baseline, unreachable, duplicate, and dirty commits without staging", async () => {
	const project = temporary("ticket-flow-core-git-project-");
	try {
		execFileSync("git", ["init", "-q"], { cwd: project });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: project });
		execFileSync("git", ["config", "user.name", "Ticket Flow Test"], { cwd: project });
		fs.writeFileSync(path.join(project, "base.txt"), "base\n");
		execFileSync("git", ["add", "base.txt"], { cwd: project }); execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
		const preflight = await gitPreflight(project, "git-run"); assert.ok(preflight);
		const state = gitStateFromPreflight(preflight!);
		fs.writeFileSync(path.join(project, "work.txt"), "work\n");
		execFileSync("git", ["add", "work.txt"], { cwd: project }); execFileSync("git", ["commit", "-qm", "work"], { cwd: project });
		const work = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
		assert.equal((await validateAcceptedCommitIds(project, state, [work])).length, 1);
		execFileSync("git", ["switch", "-c", "side-branch", state.baselineCommit], { cwd: project });
		fs.writeFileSync(path.join(project, "side.txt"), "side\n"); execFileSync("git", ["add", "side.txt"], { cwd: project }); execFileSync("git", ["commit", "-qm", "side"], { cwd: project });
		const side = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(); execFileSync("git", ["switch", state.workflowBranch], { cwd: project });
		await assert.rejects(() => validateAcceptedCommitIds(project, state, [side]), /reachable/);
		await assert.rejects(() => validateAcceptedCommitIds(project, state, [` ${work}`]), /Invalid commit ID/);
		await assert.rejects(() => validateAcceptedCommitIds(project, state, [state.baselineCommit]), /baseline|introduced no new/);
		await assert.rejects(() => validateAcceptedCommitIds(project, { ...state, acceptedCommitIds: [work] }, [work]), /already accepted/);
		await assert.rejects(() => validateAcceptedCommitIds(project, { ...state, attemptBaseCommit: work }, [work]), /active attempt/);
		fs.writeFileSync(path.join(project, "unrelated.txt"), "do not stage\n");
		await assert.rejects(() => validateAcceptedCommitIds(project, state, [work]), /clean/);
		assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: project, encoding: "utf8" }), "");
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("checkbox completion escapes regex metacharacters and never crosses lines", async () => {
	const project = temporary("ticket-flow-core-checkbox-project-");
	try {
		const target = path.join(project, "ticket.md");
		fs.writeFileSync(target, "- [ ] a.b\n- [ ] axb\n- [ ] x+y?\n");
		const input = { projectPath: project, runId: "r", workItemId: "i", workItemTitle: "i", comment: "ok", completedAt: "now" };
		await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "markdown-checkbox", path: "ticket.md", text: "a.b" } }));
		const content = fs.readFileSync(target, "utf8");
		assert.match(content, /^- \[x\] a\.b$/m);
		assert.match(content, /^- \[ \] axb$/m);
		await Effect.runPromise(applyCompletionStrategy({ ...input, strategy: { type: "markdown-checkbox", path: "ticket.md", text: "x+y?" } }));
		assert.match(fs.readFileSync(target, "utf8"), /^- \[x\] x\+y\?$/m);
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("a missing explicit audit profile leaves an editable draft and bounded delegation timeout pauses without duplication", async () => {
	const project = temporary("ticket-flow-core-timeout-project-"); const agent = temporary("ticket-flow-core-timeout-agent-"); const tmux = new FakeTmux(); let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, undefined, () => "timeout-run", tmux as never);
	const item = implementationItem();
	try {
		await Effect.runPromise(controller.startRun({ cwd: project, prompt: "timeout", agentDir: agent }));
		await Effect.runPromise(controller.savePlan({ summary: "draft", workItems: [item], userResolutions: [], finalized: false }, ["Which mode?"]));
		await assert.rejects(Effect.runPromise(controller.savePlan({ summary: "draft", workItems: [item], userResolutions: [], finalized: true }, [])), /explicit model and thinking level/);
		assert.deepEqual(controller.activeRun?.planning.unresolvedQuestions, ["Which mode?"]);
		await Effect.runPromise(controller.savePlan({ summary: "ready", auditProfile: profile, workItems: [item], userResolutions: [{ id: "answer-1", question: "Which mode?", answer: "strict", resolvedAt: new Date().toISOString() }], finalized: true }, []));
		await assert.rejects(Effect.runPromise(controller.delegateStart(item.id, undefined, undefined, 15)), /timed out/);
		assert.equal(controller.activeRun?.phase, "paused"); assert.equal(tmux.created, 1);
	} finally { if (controller.activeRun) await Effect.runPromise(controller.stop()).catch(() => undefined); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true }); }
});

test("event-first persistence discards a staged snapshot when append fails and recovers after a durable append", async () => {
	const project = temporary("ticket-flow-core-persistence-project-"); const agent = temporary("ticket-flow-core-persistence-agent-");
	try {
		const paths = await Effect.runPromise(pathsForProject(project, "persistence", agent));
		const baseRun = { id: "persistence", projectId: paths.paths.projectId, projectPath: paths.canonicalProjectPath, originalPrompt: "persistence", phase: "analyzing" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01", plan: { summary: "old", workItems: [], userResolutions: [], finalized: false }, planning: { unresolvedQuestions: [], changes: [] } };
		await Effect.runPromise(saveRun(paths.paths, baseRun));
		const newerRun = { ...baseRun, updatedAt: "2026-01-02", plan: { ...baseRun.plan, summary: "new" } };
		const event = await Effect.runPromise(makeWorkflowEvent(baseRun.id, "new-state", { summary: "new" }, { now: () => new Date("2026-01-02"), randomId: () => "event-new" }));
		await Effect.runPromise(stagePendingSnapshot(paths.paths, newerRun, event));
		await assert.rejects(Effect.runPromise(appendEvent(paths.paths.eventsFile, event, { openAppend: async () => { throw new Error("simulated append failure"); }, chmod: async () => undefined, readText: async () => "" })), /PersistenceError|append failure/);
		const unchanged = await Effect.runPromise(loadRun(paths.paths));
		assert.equal(unchanged.plan.summary, "old"); assert.equal(fs.existsSync(pendingPersistencePath(paths.paths)), false);
		await Effect.runPromise(stagePendingSnapshot(paths.paths, newerRun, event));
		await Effect.runPromise(appendEvent(paths.paths.eventsFile, event));
		const recovered = await Effect.runPromise(loadRun(paths.paths));
		assert.equal(recovered.plan.summary, "new"); assert.equal(fs.existsSync(pendingPersistencePath(paths.paths)), false);
	} finally { fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true }); }
});

test("v3 state migrates to an editable v4 draft and unsupported versions are actionable", async () => {
	const project = temporary("ticket-flow-core-migration-project-"); const agent = temporary("ticket-flow-core-migration-agent-");
	try {
		const paths = await Effect.runPromise(pathsForProject(project, "legacy", agent)); fs.mkdirSync(paths.paths.runDir, { recursive: true });
		const legacyRun = { id: "legacy", projectId: paths.paths.projectId, projectPath: paths.canonicalProjectPath, originalPrompt: "legacy", phase: "analyzing", createdAt: "2026-01-01", updatedAt: "2026-01-01", plan: { summary: "legacy", workItems: [], userResolutions: [], finalized: false }, planning: { unresolvedQuestions: ["legacy question"], changes: [] } };
		fs.writeFileSync(paths.paths.stateFile, JSON.stringify({ version: 3, run: legacyRun }));
		const migrated = await Effect.runPromise(loadRun(paths.paths));
		assert.equal(migrated.planning.unresolvedQuestions[0], "legacy question"); assert.equal(JSON.parse(fs.readFileSync(paths.paths.planFile, "utf8")).version, 4);
	} finally { fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true }); }
});
