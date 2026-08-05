import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { AppendFile, EventFileSystem } from "../ticket-flow/event-store.ts";
import { appendEvent, makeWorkflowEvent } from "../ticket-flow/event-store.ts";
import { applyAcceptedCompletion } from "../ticket-flow/completion-acceptance.ts";
import { WorkflowController } from "../ticket-flow/controller.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { readWorkflowToken } from "../ticket-flow/protocol/runtime.ts";
import { WorkerReportRuntime } from "../ticket-flow/worker/report.ts";
import type { WorkerIdentity, WorkerReport } from "../ticket-flow/domain.ts";
import { applyCompletionStrategy } from "../ticket-flow/completion.ts";
import type { PiLaunchProfile, WorkItem, WorkflowRun } from "../ticket-flow/domain.ts";
import type { WorkflowPaths } from "../ticket-flow/paths.ts";
import { validatePlan } from "../ticket-flow/state-machine.ts";
import { markPendingSnapshotStarted, loadRun, pendingPersistencePath, saveRun, stagePendingSnapshot } from "../ticket-flow/state-store.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";

const profile: PiLaunchProfile = { model: "test/provider", thinking: "high" };
const temporary = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function item(id: string, strategy: WorkItem["completionStrategy"] = { type: "ledger-only" }): WorkItem {
	return { id, title: id, sourcePaths: [`${id}.md`], specificationPaths: ["spec.md"], requirements: [`Implement ${id}`], order: id === "one" ? 1 : 2, orderReason: "ordered", dependsOn: id === "one" ? [] : ["one"], delegationPrompt: `implement ${id}`, launchProfile: profile, completionStrategy: strategy, status: "planned" };
}

function gitInit(project: string): void {
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: project });
	execFileSync("git", ["config", "user.name", "Ticket Flow Test"], { cwd: project });
}

function commit(project: string, message: string, ...files: string[]): string {
	execFileSync("git", ["add", "--", ...files], { cwd: project });
	execFileSync("git", ["commit", "-qm", message], { cwd: project });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
}

function runFor(paths: WorkflowPaths, summary: string): WorkflowRun {
	return { id: "run", projectId: paths.projectId, projectPath: paths.canonicalProjectPath, originalPrompt: summary, phase: "analyzing", createdAt: "2026-01-01", updatedAt: "2026-01-01", plan: { summary, workItems: [], userResolutions: [], finalized: false }, planning: { unresolvedQuestions: [], changes: [] } };
}

test("audit/readOnly and finalized-plan forgery boundaries are enforced", async () => {
	const audit = { ...item("audit"), kind: "audit" as const, readOnly: false, dependsOn: [] };
	await assert.rejects(Effect.runPromise(validatePlan({ summary: "x", auditProfile: profile, workItems: [audit], userResolutions: [], finalized: false })), /read-only/);
	const generated = { ...item("generated"), kind: "fix" as const, dependsOn: [], status: "completed" as const, completion: { acceptedAttempt: 1, acceptedReportPath: "reports/x", comment: "x", completedAt: "now", strategy: { type: "ledger-only" as const } } };
	await assert.rejects(Effect.runPromise(validatePlan({ summary: "x", auditProfile: profile, workItems: [generated], userResolutions: [], finalized: true })), /controller-generated|initial planned/);
	const arbitrary = { ...item("one", { type: "text-replacement", path: "unapproved.md", oldText: "a", newText: "b" }) };
	await assert.rejects(Effect.runPromise(validatePlan({ summary: "x", auditProfile: profile, workItems: [arbitrary], userResolutions: [], finalized: true })), /approved/);
});

test("completion refuses repository control paths, symlinks, and hardlinks", async () => {
	const project = temporary("ticket-flow-security-paths-");
	const outside = temporary("ticket-flow-security-outside-");
	try {
		fs.writeFileSync(path.join(project, "ticket.md"), "old\n");
		fs.writeFileSync(path.join(outside, "outside.md"), "old\n");
		fs.symlinkSync(path.join(outside, "outside.md"), path.join(project, "link.md"));
		const base = { projectPath: project, runId: "r", workItemId: "one", workItemTitle: "one", comment: "ok", completedAt: "now" };
		await assert.rejects(Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "text-replacement", path: ".git/HEAD", oldText: "x", newText: "y" } })), /trusted project|repository control/);
		await assert.rejects(Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "text-replacement", path: "link.md", oldText: "old", newText: "new" } })), /outside|symlink/);
		fs.linkSync(path.join(project, "ticket.md"), path.join(project, "hard.md"));
		await assert.rejects(Effect.runPromise(applyCompletionStrategy({ ...base, strategy: { type: "text-replacement", path: "ticket.md", oldText: "old", newText: "new" } })), /hard link|hardlink/);
	} finally {
		fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("two sequential Git completion commits stay clean, exact, and idempotently recover rename", async () => {
	const project = temporary("ticket-flow-security-git-");
	try {
		gitInit(project);
		fs.writeFileSync(path.join(project, "one.md"), "one\n"); fs.writeFileSync(path.join(project, "two.md"), "two\n"); fs.writeFileSync(path.join(project, "spec.md"), "spec\n");
		commit(project, "base", "one.md", "two.md", "spec.md");
		const first = { ...item("one", { type: "text-replacement", path: "one.md", oldText: "one", newText: "ONE" }) };
		fs.writeFileSync(path.join(project, "one.md"), "one worker\n"); commit(project, "worker one", "one.md");
		const firstResult = await Effect.runPromise(applyAcceptedCompletion({ projectPath: project, runId: "run", workItemId: first.id, workItem: first, comment: "one", completedAt: "now", strategy: first.completionStrategy! }));
		assert.ok(firstResult.commit.commitId); assert.equal(firstResult.commit.paths.length, 1);
		const second = { ...item("two", { type: "rename-file", from: "two.md", to: "two-done.md" }) };
		// Rename destinations are explicit completion targets in the plan.
		const renameItem = { ...second, completionTargets: ["two.md", "two-done.md"] };
		fs.writeFileSync(path.join(project, "two.md"), "two worker\n"); commit(project, "worker two", "two.md");
		const secondResult = await Effect.runPromise(applyAcceptedCompletion({ projectPath: project, runId: "run", workItemId: renameItem.id, workItem: renameItem, comment: "two", completedAt: "now", strategy: renameItem.completionStrategy! }));
		assert.ok(secondResult.commit.commitId); assert.deepEqual(new Set(secondResult.commit.paths), new Set(["two.md", "two-done.md"]));
		const recovered = await Effect.runPromise(applyAcceptedCompletion({ projectPath: project, runId: "run", workItemId: renameItem.id, workItem: renameItem, comment: "two", completedAt: "now", strategy: renameItem.completionStrategy! }));
		assert.equal(recovered.commit.commitId, secondResult.commit.commitId); assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }), "");
		assert.equal(execFileSync("git", ["log", "--format=%s"], { cwd: project, encoding: "utf8" }).split("\n").filter((line) => line.includes("record completion")).length, 2);
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

class GitFakeTmux {
	private nextWindow = 0;
	created = 0;
	closed = 0;
	createWorkerWindow(input: { readonly runId: string; readonly workItemId: string; readonly socketPath: string }) {
		this.created += 1; this.nextWindow += 1;
		return Effect.succeed({ runId: input.runId, workItemId: input.workItemId, serverSocketPath: "/tmp/ticket-flow-security.sock", sessionId: "$1", sessionName: "main", windowId: `@${this.nextWindow}`, paneId: `%${this.nextWindow}`, displayName: input.workItemId, socketPath: input.socketPath });
	}
	inspectWindow() { return Effect.succeed({ state: "alive" as const }); }
	closeWindow() { this.closed += 1; return Effect.succeed({ forced: false, alreadyExited: false }); }
	detect() { return Effect.void; }
	capturePane() { return Effect.succeed(""); }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) { if (Date.now() > deadline) throw new Error("security integration timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

async function gitWorkerClient(controller: WorkflowController, project: string, agent: string, runId: string, workItem: WorkItem): Promise<ProtocolClient> {
	const resolved = (await Effect.runPromise(pathsForProject(project, runId, agent))).paths;
	const launchProfile = workItem.launchProfile;
	if (!launchProfile?.model || !launchProfile.thinking) throw new Error("test work item has no complete launch profile");
	const [provider, model] = launchProfile.model.split("/", 2) as [string, string];
	const identity: WorkerIdentity = { runId, workItemId: workItem.id, provider, model, thinking: launchProfile.thinking };
	const client = new ProtocolClient({ socketPath: controller.activeRun!.workflowSocketPath!, identity, token: await Effect.runPromise(readWorkflowToken(resolved.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [5] });
	await Effect.runPromise(client.start()); await waitUntil(() => client.authoritativeContext !== undefined);
	return client;
}

function completedGitReport(workItem: WorkItem, commitId: string): WorkerReport {
	return { status: "completed", summary: `completed ${workItem.id}`, commitIds: [commitId], requirements: workItem.requirements.map((requirement) => ({ requirement, result: "satisfied" as const, evidence: "worker evidence" })), filesChanged: [`${workItem.id}.md`], checks: [{ command: "inspection", result: "passed" }], caveats: [], blockers: [] };
}

test("controller accepts two Git items with clean dedicated completion commits", async () => {
	const project = temporary("ticket-flow-security-controller-git-"); const agent = temporary("ticket-flow-security-controller-agent-"); const runId = "security-git-run"; const tmux = new GitFakeTmux(); const clients: ProtocolClient[] = [];
	let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, undefined, () => runId, tmux as never);
	try {
		gitInit(project); fs.writeFileSync(path.join(project, "one.md"), "one\n"); fs.writeFileSync(path.join(project, "two.md"), "two\n"); fs.writeFileSync(path.join(project, "spec.md"), "spec\n"); commit(project, "base", "one.md", "two.md", "spec.md");
		const one = item("one", { type: "text-replacement", path: "one.md", oldText: "worker one", newText: "done one" });
		const two = item("two", { type: "text-replacement", path: "two.md", oldText: "worker two", newText: "done two" });
		await Effect.runPromise(controller.startRun({ cwd: project, prompt: "two git items", agentDir: agent }));
		await Effect.runPromise(controller.savePlan({ summary: "two git items", auditProfile: profile, workItems: [one, two], userResolutions: [], finalized: false })); await Effect.runPromise(controller.finalizePlan());
		for (const workItem of [one, two]) {
			await Effect.runPromise(controller.startWorker(workItem.id));
			fs.writeFileSync(path.join(project, `${workItem.id}.md`), `worker ${workItem.id}\n`);
			const workerCommit = commit(project, `worker ${workItem.id}`, `${workItem.id}.md`);
			const client = await gitWorkerClient(controller, project, agent, runId, workItem); clients.push(client);
			await new WorkerReportRuntime(client).submit(completedGitReport(workItem, workerCommit), client.authoritativeContext!);
			await waitUntil(() => controller.activeRun?.plan.workItems.find((candidate) => candidate.id === workItem.id)?.status === "report-review");
			await Effect.runPromise(controller.acceptReport(workItem.id, `accept ${workItem.id}`));
			assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }), "");
			assert.equal(controller.activeRun?.plan.workItems.find((candidate) => candidate.id === workItem.id)?.completion?.commitIds?.length, 2);
		}
		assert.equal(controller.activeRun?.phase, "auditing"); assert.equal(controller.activeRun?.plan.workItems.find((candidate) => candidate.kind === "audit")?.status, "ready");
		assert.equal(controller.activeRun?.git?.acceptedCommitIds.length, 4);
	} finally {
		for (const client of clients) await Effect.runPromise(client.shutdown()).catch(() => undefined);
		if (controller.activeRun) await Effect.runPromise(controller.stop()).catch(() => Effect.runPromise(controller.shutdown()));
		fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("ambiguous append failures reconcile by event ID instead of dropping pending state", async () => {
	const project = temporary("ticket-flow-security-events-project-"); const agent = temporary("ticket-flow-security-events-agent-");
	try {
		const paths = (await Effect.runPromise(pathsForProject(project, "run", agent))).paths;
		const base = runFor(paths, "old"); await Effect.runPromise(saveRun(paths, base));
		for (const mode of ["write", "sync", "close"] as const) {
			const newer = { ...base, updatedAt: `2026-01-01T00:00:0${mode === "write" ? 1 : mode === "sync" ? 2 : 3}Z`, plan: { ...base.plan, summary: mode } };
			const event = await Effect.runPromise(makeWorkflowEvent(base.id, `new-${mode}`, { mode }, { now: () => new Date(), randomId: () => `event-${mode}` }));
			await Effect.runPromise(stagePendingSnapshot(paths, newer, event)); await Effect.runPromise(markPendingSnapshotStarted(paths));
			let handle: AppendFile | undefined;
			const failureFs: EventFileSystem = {
				openAppend: async () => {
					handle = {
						writeFile: async (content) => { fs.appendFileSync(paths.eventsFile, content); if (mode === "write") throw new Error("write failed after write"); },
						sync: async () => { if (mode === "sync") { fs.appendFileSync(paths.eventsFile, ""); throw new Error("sync failed"); } },
						close: async () => { if (mode === "close") throw new Error("close failed"); },
					};
					return handle;
				},
				chmod: async () => undefined,
				readText: async (filePath) => fs.readFileSync(filePath, "utf8"),
			};
			await assert.rejects(Effect.runPromise(appendEvent(paths.eventsFile, event, failureFs)), /PersistenceError|failed/);
			const recovered = await Effect.runPromise(loadRun(paths));
			assert.equal(recovered.plan.summary, mode); assert.equal(fs.existsSync(pendingPersistencePath(paths)), false);
		}
	} finally { fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(agent, { recursive: true, force: true }); }
});
