import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { AUDIT_PROMPT_TEMPLATE, assertAuditWorkItemPrompt, auditEvidenceHash, buildAuditPrompt, validateAuditReport } from "../ticket-flow/audit.ts";
import { applyAcceptedCompletion } from "../ticket-flow/completion-acceptance.ts";
import { WorkflowController } from "../ticket-flow/controller.ts";
import { applyCompletionStrategy, completionMarker } from "../ticket-flow/completion.ts";
import type { GitCommandRunner } from "../ticket-flow/git.ts";
import { gitPreflight, gitStateFromPreflight, nodeGitRunner, validateAcceptedCommitIds } from "../ticket-flow/git.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { makeWorkflowEvent } from "../ticket-flow/event-store.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import type { WorkflowProtocolEvent } from "../ticket-flow/protocol/messages.ts";
import { ProtocolServer } from "../ticket-flow/protocol/server.ts";
import { workflowTokenPath } from "../ticket-flow/protocol/runtime.ts";
import { PersistenceError } from "../ticket-flow/errors.ts";
import { loadRun, markPendingSnapshotStarted, saveRun, stagePendingSnapshot } from "../ticket-flow/state-store.ts";
import type { AuditFinding, WorkflowRun, WorkItem } from "../ticket-flow/domain.ts";

const temporary = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };

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

function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) { resolve(); return; }
			if (Date.now() >= deadline) { reject(new Error("Timed out waiting for condition")); return; }
			setTimeout(check, 5);
		};
		check();
	});
}

test("audit prompt substitution is one-pass and finding evidence is set-stable", () => {
	const prompt = buildAuditPrompt({
		featureName: "Feature {path to spec}",
		acceptedCommitIds: ["abc"],
		ticketPath: "tickets/feature.md",
		specPath: "specs/feature.md",
	});
	assert.match(prompt, /Feature \{path to spec\}/);
	assert.equal(prompt.includes("Feature specs/feature.md"), false);
	const left: AuditFinding[] = [
		{ id: "b", severity: "low", finding: "Second", evidence: "b.ts" },
		{ id: "a", severity: "high", finding: "First", evidence: "a.ts" },
	];
	assert.equal(auditEvidenceHash(left), auditEvidenceHash([...left].reverse()));
	assert.throws(() => validateAuditReport({
		status: "completed",
		summary: "duplicate IDs",
		auditVerdicts: [{ requirement: "requirement", verdict: "fail", evidence: "a.ts" }],
		auditFindings: [left[0]!, { ...left[1]!, id: left[0]!.id }],
	}, ["requirement"]), /Duplicate audit finding/);
	const item: WorkItem = {
		id: "audit-round-1", kind: "audit", title: "Audit", sourcePaths: ["tickets/feature.md"], specificationPaths: ["specs/feature.md"],
		requirements: ["requirement"], order: 1, orderReason: "audit", dependsOn: [], delegationPrompt: prompt, launchProfile: profile,
		readOnly: true, completionStrategy: { type: "ledger-only" }, status: "ready",
	};
	const run = {
		id: "run", projectId: "project", projectPath: "/tmp/project", originalPrompt: "Feature", phase: "auditing" as const,
		createdAt: "now", updatedAt: "now", plan: { summary: "Feature", auditProfile: profile, workItems: [item], userResolutions: [], finalized: true },
		planning: { unresolvedQuestions: [], changes: [] }, git: { repository: "/tmp/project", baselineCommit: "base", baselineBranch: "main", workflowBranch: "workflow", acceptedCommitIds: ["abc"], cleanPreflight: true },
		audit: { featureName: "Feature {path to spec}", ticketPath: "tickets/feature.md", specPath: "specs/feature.md", template: AUDIT_PROMPT_TEMPLATE, model: profile.model, thinking: profile.thinking, activeRound: 1, rounds: [{ round: 1, workerItemId: item.id, prompt, acceptedCommitIds: ["abc"], status: "pending" as const, createdAt: "now" }] },
	} satisfies WorkflowRun;
	assertAuditWorkItemPrompt(run, item);
	assert.throws(() => assertAuditWorkItemPrompt({ ...run, git: { ...run.git, acceptedCommitIds: ["def"] } }, item), /commit set/);
	assert.throws(() => assertAuditWorkItemPrompt(run, { ...item, delegationPrompt: `${prompt}!` }), /does not match/);
});

test("completion markers bind raw IDs and cannot be forged by acceptance prose", async () => {
	const project = temporary("ticket-flow-marker-");
	try {
		const target = path.join(project, "ticket.md");
		fs.writeFileSync(target, "ticket\n");
		assert.notEqual(completionMarker("run", "a@b"), completionMarker("run", "a#b"));
		const base = { projectPath: project, runId: "run", workItemTitle: "One", completedAt: "now", strategy: { type: "append-markdown" as const, path: "ticket.md" } };
		const forgedMarker = completionMarker("run", "second");
		await Effect.runPromise(applyCompletionStrategy({ ...base, workItemId: "first", comment: `Looks good ${forgedMarker}` }));
		assert.equal(fs.readFileSync(target, "utf8").includes(forgedMarker), false);
		const second = await Effect.runPromise(applyCompletionStrategy({ ...base, workItemId: "second", comment: "accepted" }));
		assert.equal(second.changed, true);
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("accepted worker commits must include the exact workflow branch tip", async () => {
	const project = temporary("ticket-flow-exact-tip-");
	try {
		gitInit(project);
		fs.writeFileSync(path.join(project, "base.txt"), "base\n");
		commit(project, "base", "base.txt");
		const preflight = await gitPreflight(project, "run");
		assert.ok(preflight);
		const state = gitStateFromPreflight(preflight);
		fs.writeFileSync(path.join(project, "reported.txt"), "reported\n");
		const reported = commit(project, "reported", "reported.txt");
		fs.writeFileSync(path.join(project, "unreported.txt"), "unreported\n");
		commit(project, "unreported", "unreported.txt");
		await assert.rejects(() => validateAcceptedCommitIds(project, state, [reported]), /current HEAD|branch tip/);
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("completion commit rejects content changed between mutation validation and staging", async () => {
	const project = temporary("ticket-flow-stage-race-");
	try {
		gitInit(project);
		fs.writeFileSync(path.join(project, "ticket.md"), "old\n");
		commit(project, "base", "ticket.md");
		const item: WorkItem = {
			id: "one", title: "One", sourcePaths: ["ticket.md"], specificationPaths: ["ticket.md"], requirements: ["done"], order: 1,
			orderReason: "first", dependsOn: [], delegationPrompt: "do it", launchProfile: profile,
			completionStrategy: { type: "text-replacement", path: "ticket.md", oldText: "old", newText: "done" }, status: "report-review",
		};
		let mutated = false;
		const runner: GitCommandRunner = {
			run: async (args, cwd, signal) => {
				if (!mutated && args[0] === "add") {
					mutated = true;
					fs.writeFileSync(path.join(project, "ticket.md"), "attacker content\n");
				}
				return nodeGitRunner.run(args, cwd, signal);
			},
		};
		await assert.rejects(Effect.runPromise(applyAcceptedCompletion({
			projectPath: project, runId: "run", workItemId: item.id, workItem: item, comment: "accepted", completedAt: "now",
			strategy: item.completionStrategy!, git: runner,
		})), /changed.*staging|content.*staging|mutation.*staging/i);
		assert.equal(execFileSync("git", ["log", "--format=%s", "-1"], { cwd: project, encoding: "utf8" }).trim(), "base");
	} finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("pending recovery rejects malformed journal data after the matching event", async () => {
	const project = temporary("ticket-flow-journal-project-");
	const agent = temporary("ticket-flow-journal-agent-");
	try {
		const paths = (await Effect.runPromise(pathsForProject(project, "run", agent))).paths;
		const run: WorkflowRun = {
			id: "run", projectId: paths.projectId, projectPath: paths.canonicalProjectPath, originalPrompt: "x", phase: "analyzing",
			createdAt: "2026-01-01", updatedAt: "2026-01-01", plan: { summary: "x", workItems: [], userResolutions: [], finalized: false },
			planning: { unresolvedQuestions: [], changes: [] },
		};
		await Effect.runPromise(saveRun(paths, run));
		const event = await Effect.runPromise(makeWorkflowEvent(run.id, "updated", {}, { now: () => new Date(0), randomId: () => "event-1" }));
		await Effect.runPromise(stagePendingSnapshot(paths, { ...run, updatedAt: "2026-01-02" }, event));
		await Effect.runPromise(markPendingSnapshotStarted(paths));
		fs.writeFileSync(paths.eventsFile, `${JSON.stringify(event)}\n{malformed\n`);
		await assert.rejects(Effect.runPromise(loadRun(paths)), /malformed JSON/);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("acknowledged protocol commands do not exhaust the pending queue", async () => {
	const directory = temporary("ticket-flow-command-bound-");
	const socket = path.join(directory, "worker.sock");
	const worker = { runId: "run", workItemId: "item", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" as const };
	const server = new ProtocolServer({ socketPath: socket, runId: worker.runId, workItemId: worker.workItemId, token: "secret", profile });
	const client = new ProtocolClient({ socketPath: socket, identity: worker, token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [1] });
	try {
		await Effect.runPromise(server.start());
		await Effect.runPromise(client.start());
		await eventually(() => server.isVerified && client.isVerified);
		for (let index = 0; index < 257; index += 1) {
			const requestId = `feedback-${index}`;
			server.send("feedback", { kind: "message", message: "continue", requestId }, `message-${index}`);
			await server.waitForAcknowledgement(requestId);
		}
	} finally {
		await Effect.runPromise(client.shutdown());
		await Effect.runPromise(server.shutdown());
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("worker window checkpoint failure releases tmux, protocol, and token resources", async () => {
	const project = temporary("ticket-flow-window-failure-project-");
	const agent = temporary("ticket-flow-window-failure-agent-");
	let closed = 0;
	const tmux = {
		createWorkerWindow: (input: { readonly runId: string; readonly workItemId: string; readonly socketPath: string }) => Effect.succeed({
			runId: input.runId, workItemId: input.workItemId, serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main",
			windowId: "@1", paneId: "%1", displayName: "worker", socketPath: input.socketPath,
		}),
		closeWindow: () => { closed += 1; return Effect.succeed({ forced: true, alreadyExited: false }); },
		detect: () => Effect.void,
		inspectWindow: () => Effect.succeed({ state: "alive" as const }),
		capturePane: () => Effect.succeed(""),
	};
	let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, undefined, () => "window-failure", tmux as never);
	try {
		await Effect.runPromise(controller.startRun({ cwd: project, prompt: "test", agentDir: agent }));
		const workItem: WorkItem = {
			id: "one", title: "One", sourcePaths: ["ticket.md"], specificationPaths: ["spec.md"], requirements: ["done"], order: 1,
			orderReason: "first", dependsOn: [], delegationPrompt: "do it", launchProfile: profile, completionStrategy: { type: "ledger-only" }, status: "planned",
		};
		await Effect.runPromise(controller.savePlan({ summary: "test", auditProfile: profile, workItems: [workItem], userResolutions: [], finalized: true }));
		const internals = controller as unknown as { persist: (next: WorkflowRun, eventType: string, data: unknown) => Effect.Effect<WorkflowRun, Error> };
		const persist = internals.persist.bind(controller);
		internals.persist = (next, eventType, data) => eventType === "worker-window-created" ? Effect.fail(new Error("checkpoint failed")) : persist(next, eventType, data);
		await assert.rejects(Effect.runPromise(controller.startWorker(workItem.id)), /checkpoint failed/);
		const paths = (await Effect.runPromise(pathsForProject(project, "window-failure", agent))).paths;
		assert.equal(closed, 1);
		assert.equal(fs.existsSync(workflowTokenPath(paths.runDir)), false);
		assert.equal(fs.existsSync(controller.activeRun?.workflowSocketPath ?? "missing"), false);
		assert.equal((controller as unknown as { active?: { protocol?: unknown } }).active?.protocol, undefined);
	} finally {
		await Effect.runPromise(controller.shutdown()).catch(() => undefined);
		fs.rmSync(project, { recursive: true, force: true });
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

test("transient handshake persistence failure reconnects instead of rejecting identity", async () => {
	const directory = temporary("ticket-flow-handshake-retry-");
	const socket = path.join(directory, "worker.sock");
	const worker = { runId: "run", workItemId: "item", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" as const };
	let connectedAttempts = 0;
	const onEvent = (event: WorkflowProtocolEvent) => {
		if (event.type !== "worker-connected") return;
		connectedAttempts += 1;
		if (connectedAttempts === 1) throw new PersistenceError({ operation: "append", path: "events.jsonl", cause: new Error("transient") });
	};
	const server = new ProtocolServer({ socketPath: socket, runId: worker.runId, workItemId: worker.workItemId, token: "secret", profile, onEvent });
	const client = new ProtocolClient({ socketPath: socket, identity: worker, token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [1, 2] });
	try {
		await Effect.runPromise(server.start());
		await Effect.runPromise(client.start());
		await eventually(() => connectedAttempts >= 2 && server.isVerified && client.isVerified);
		assert.equal(client.isStopped, false);
	} finally {
		await Effect.runPromise(client.shutdown());
		await Effect.runPromise(server.shutdown());
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
