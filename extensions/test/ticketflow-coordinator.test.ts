import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { SerializedWorkerHandle, WorkerProfile, WorkerReport } from "../ticket-flow/model.ts";
import { prepareSetup } from "../ticket-flow/tickets.ts";
import { TicketflowCoordinator } from "../ticket-flow/coordinator.ts";
import { nodeGitRunner } from "../ticket-flow/git.ts";
import type { SpawnInput, WorkerBackend, WorkerInspection } from "../ticket-flow/backends/backend.ts";
import { WorkerChannel } from "../ticket-flow/worker.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

async function temp(prefix: string): Promise<string> {
	return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}
async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await nodeGitRunner.run(args, cwd);
	assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}
async function repository(): Promise<string> {
	const project = await temp("ticketflow-coordinator-project-");
	await git(project, "init", "-b", "main");
	await git(project, "config", "user.email", "ticketflow-tests@example.invalid");
	await git(project, "config", "user.name", "Ticket Flow Tests");
	await mkdir(path.join(project, "tickets"));
	await writeFile(path.join(project, "tickets", "1-core.md"), "# Core\n\n- [ ] Implement the core\n");
	await git(project, "add", ".");
	await git(project, "commit", "-m", "baseline");
	return project;
}

const profile: WorkerProfile = { model: "provider/model", thinking: "medium" };

class FakeWorkerBackend implements WorkerBackend {
	readonly bridges = new Map<string, WorkerChannel>();
	readonly sentMessages: string[] = [];
	readonly handles = new Map<string, SerializedWorkerHandle>();
	readonly turns = new Map<string, number>();
	readonly ticketPath: string;
	auditCommitIds: string[] = [];
	auditReports: WorkerReport[] = [];
	closeFailure: Error | undefined;
	private commitSequence = 0;

	constructor(ticketPath: string) { this.ticketPath = ticketPath; }
	async validate(): Promise<void> {}

	async spawn(input: SpawnInput): Promise<SerializedWorkerHandle> {
		const handle: SerializedWorkerHandle = {
			backend: "tmux", serverSocketPath: "/tmp/fake-ticketflow-tmux.sock", sessionId: "$0", sessionName: "fake",
			windowId: `@${this.handles.size + 1}`, paneId: `%${this.handles.size + 1}`, runId: input.runId, assignmentId: input.assignmentId,
			operationId: input.operationId, displayName: input.title,
		};
		let bridge: WorkerChannel;
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			registerTool() {},
			on: (name: string, callback: (event: any, ctx: any) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
			sendUserMessage: async (message: string) => {
				this.sentMessages.push(message);
				const turn = (this.turns.get(input.assignmentId) ?? 0) + 1;
				this.turns.set(input.assignmentId, turn);
				if (input.kind === "implementation") {
					await writeFile(this.ticketPath, "# Core\n\n- [x] Implement the core\n");
					await writeFile(path.join(input.cwd, "core.ts"), `export const sequence = ${++this.commitSequence};\n`);
					await git(input.cwd, "add", ".");
					await git(input.cwd, "commit", "-m", "implement core");
					const head = await git(input.cwd, "rev-parse", "HEAD");
					bridge.submitReport({ status: "completed", summary: "implemented", commitIds: [head] }, turn);
					bridge.notifySettled(turn);
				} else if (input.kind === "audit") {
					bridge.submitReport(this.auditReports.shift() ?? {
						status: "audit", summary: "clean audit", verdicts: [{ requirement: "Implement the core", verdict: "pass", evidence: "core.ts:1" }], findings: [], auditedCommitIds: [...this.auditCommitIds],
					}, turn);
					bridge.notifySettled(turn);
				} else if (input.kind === "fix") {
					await writeFile(path.join(input.cwd, "core.ts"), `export const sequence = ${++this.commitSequence};\n`);
					await git(input.cwd, "add", ".");
					await git(input.cwd, "commit", "-m", "fix audit finding");
					const head = await git(input.cwd, "rev-parse", "HEAD");
					bridge.submitReport({ status: "completed", summary: "fixed", commitIds: [head] }, turn);
					bridge.notifySettled(turn);
				}
			},
		};
		const ctx = {
			model: { provider: "provider", id: "model" }, thinkingLevel: "medium",
			sessionManager: { getSessionId: () => "worker-session", getSessionFile: () => "/tmp/fake-worker-session.jsonl" },
			abort() {}, shutdown() {},
		} as unknown as ExtensionContext;
		bridge = new WorkerChannel({ pi: pi as never, ctx, socketPath: input.socketPath, runId: input.runId, assignmentId: input.assignmentId, token: input.token, requestedProfile: input.profile, retryDelaysMs: [10, 10, 10] });
		this.bridges.set(input.assignmentId, bridge);
		this.handles.set(input.assignmentId, handle);
		bridge.start();
		return handle;
	}

	async inspect(handle: SerializedWorkerHandle): Promise<WorkerInspection> {
		return this.bridges.has(handle.assignmentId) ? { state: "alive" } : { state: "missing" };
	}
	async reopen(input: SpawnInput & { readonly sessionFile: string }): Promise<SerializedWorkerHandle> { return this.spawn(input); }
	async abort(handle: SerializedWorkerHandle): Promise<void> { this.bridges.get(handle.assignmentId)?.notifySettled(1); }
	async close(handle: SerializedWorkerHandle): Promise<void> {
		if (this.closeFailure) throw this.closeFailure;
		const bridge = this.bridges.get(handle.assignmentId);
		if (bridge) await bridge.close();
		this.bridges.delete(handle.assignmentId);
	}
}

test("coordinator deterministically delegates exact task, persists report/settlement, commits Git, and reaches clean terminal audit", async () => {
	const project = await repository();
	const agentDir = await temp("ticketflow-coordinator-agent-");
	const prepared = await prepareSetup({
		projectPath: project, ticketsDirectory: "tickets", referencePaths: [], workerProfile: profile,
		delegationTemplate: "Implement exactly {ticketPath} ({ticketIndex}/{ticketCount})",
	});
	const backend = new FakeWorkerBackend(prepared.tickets[0]!.path);
	let sequence = 0;
	const coordinator = new TicketflowCoordinator({
		backend, agentDir, newId: () => `id-${++sequence}`,
		now: (() => { let second = 0; return () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + second++); })(),
	});
	const created = await Effect.runPromise(coordinator.createRun({ projectPath: project, orchestratorSessionId: "main-session", setup: prepared.setup, tickets: prepared.tickets }));
	assert.equal(created.currentTicket, 0);

	const delegated = await Effect.runPromise(coordinator.delegate());
	assert.equal(delegated.assignmentKind, "implementation");
	assert.equal(delegated.initialTask, prepared.tickets[0]!.delegationPrompt);
	await assert.rejects(Effect.runPromise(coordinator.send({ workerId: delegated.workerId, delivery: "task", message: "x".repeat(31 * 1024) })), /transport bounds/);
	assert.equal(coordinator.activeRun?.checkpoint, undefined, "oversized delivery must fail before durable send intent");
	const afterSend = await Effect.runPromise(coordinator.send({ workerId: delegated.workerId, delivery: "task", message: delegated.initialTask }));
	assert.equal(afterSend.assignment?.turn, 1);
	assert.deepEqual(backend.sentMessages, [delegated.initialTask], "the coordinator must send the exact substituted task with no wrapper");

	const waited = await Effect.runPromise(coordinator.wait(delegated.workerId));
	assert.equal(waited.status, "reported");
	assert.deepEqual(waited.report?.status, "completed");
	assert.equal(waited.turn, 1);
	const closedImplementation = await Effect.runPromise(coordinator.close(delegated.workerId));
	assert.equal(closedImplementation.phase, "audit");
	assert.equal(closedImplementation.currentTicket, 1);
	assert.deepEqual(closedImplementation.git.acceptedCommitIds.length, 1);
	backend.auditCommitIds = [...closedImplementation.git.acceptedCommitIds];

	const auditWorker = await Effect.runPromise(coordinator.delegate());
	assert.equal(auditWorker.assignmentKind, "audit");
	await Effect.runPromise(coordinator.send({ workerId: auditWorker.workerId, delivery: "task", message: auditWorker.initialTask }));
	const auditWait = await Effect.runPromise(coordinator.wait(auditWorker.workerId));
	assert.equal(auditWait.report?.status, "audit");
	const completed = await Effect.runPromise(coordinator.close(auditWorker.workerId));
	assert.equal(completed.phase, "completed");
	assert.equal(completed.assignment, undefined);
	assert.equal(completed.worker, undefined);
	assert.equal(completed.findings.length, 0);
	await Effect.runPromise(coordinator.shutdown());
});

test("audit findings always create a fixer and a fresh audit before clean completion", async () => {
	const project = await repository();
	const agentDir = await temp("ticketflow-coordinator-fix-agent-");
	const prepared = await prepareSetup({ projectPath: project, ticketsDirectory: "tickets", referencePaths: [], workerProfile: profile, delegationTemplate: "Implement {ticketPath}" });
	const backend = new FakeWorkerBackend(prepared.tickets[0]!.path);
	let sequence = 0;
	const coordinator = new TicketflowCoordinator({ backend, agentDir, newId: () => `fix-id-${++sequence}` });
	await Effect.runPromise(coordinator.createRun({ projectPath: project, orchestratorSessionId: "main-session", setup: prepared.setup, tickets: prepared.tickets }));
	const implementation = await Effect.runPromise(coordinator.delegate());
	await Effect.runPromise(coordinator.send({ workerId: implementation.workerId, delivery: "task", message: implementation.initialTask }));
	await Effect.runPromise(coordinator.wait(implementation.workerId));
	let run = await Effect.runPromise(coordinator.close(implementation.workerId));
	backend.auditCommitIds = [...run.git.acceptedCommitIds];
	backend.auditReports.push({
		status: "audit", summary: "finding", auditedCommitIds: [...backend.auditCommitIds],
		verdicts: [{ requirement: "Implement the core", verdict: "fail", evidence: "core.ts:1", fixes: ["Correct value"] }],
		findings: [{ id: "F1", severity: "high", finding: "Wrong value", evidence: "core.ts:1", requirement: "Implement the core", fix: "Correct value" }],
	});
	const auditOne = await Effect.runPromise(coordinator.delegate());
	await Effect.runPromise(coordinator.send({ workerId: auditOne.workerId, delivery: "task", message: auditOne.initialTask }));
	await Effect.runPromise(coordinator.wait(auditOne.workerId));
	run = await Effect.runPromise(coordinator.close(auditOne.workerId));
	assert.equal(run.phase, "fix");
	assert.deepEqual(run.findings.map((finding) => finding.id), ["F1"]);
	const fixer = await Effect.runPromise(coordinator.delegate());
	assert.equal(fixer.assignmentKind, "fix");
	await Effect.runPromise(coordinator.send({ workerId: fixer.workerId, delivery: "task", message: fixer.initialTask }));
	await Effect.runPromise(coordinator.wait(fixer.workerId));
	run = await Effect.runPromise(coordinator.close(fixer.workerId));
	assert.equal(run.phase, "audit");
	backend.auditCommitIds = [...run.git.acceptedCommitIds];
	const auditTwo = await Effect.runPromise(coordinator.delegate());
	assert.equal(auditTwo.assignmentKind, "audit");
	await Effect.runPromise(coordinator.send({ workerId: auditTwo.workerId, delivery: "task", message: auditTwo.initialTask }));
	await Effect.runPromise(coordinator.wait(auditTwo.workerId));
	run = await Effect.runPromise(coordinator.close(auditTwo.workerId));
	assert.equal(run.phase, "completed");
	assert.equal(run.auditRounds.length, 2);
	assert.deepEqual(run.auditRounds.map((round) => round.status), ["findings", "clean"]);
	await Effect.runPromise(coordinator.shutdown());
});

test("a rejected audit report can be replaced by a follow-up turn from the same Worker", async () => {
	const project = await repository();
	const agentDir = await temp("ticketflow-coordinator-audit-recovery-agent-");
	const prepared = await prepareSetup({ projectPath: project, ticketsDirectory: "tickets", referencePaths: [], workerProfile: profile, delegationTemplate: "Implement {ticketPath}" });
	const backend = new FakeWorkerBackend(prepared.tickets[0]!.path);
	let sequence = 0;
	const coordinator = new TicketflowCoordinator({ backend, agentDir, newId: () => `audit-recovery-id-${++sequence}` });
	await Effect.runPromise(coordinator.createRun({ projectPath: project, orchestratorSessionId: "main-session", setup: prepared.setup, tickets: prepared.tickets }));
	const implementation = await Effect.runPromise(coordinator.delegate());
	await Effect.runPromise(coordinator.send({ workerId: implementation.workerId, delivery: "task", message: implementation.initialTask }));
	await Effect.runPromise(coordinator.wait(implementation.workerId));
	const auditRun = await Effect.runPromise(coordinator.close(implementation.workerId));
	backend.auditCommitIds = [...auditRun.git.acceptedCommitIds];
	backend.auditReports.push(
		{
			status: "audit", summary: "structurally inadequate", auditedCommitIds: [...backend.auditCommitIds],
			verdicts: [{ requirement: "Implement the core", verdict: "pass", evidence: "core.ts" }], findings: [],
		},
		{
			status: "audit", summary: "corrected", auditedCommitIds: [...backend.auditCommitIds],
			verdicts: [{ requirement: "Implement the core", verdict: "pass", evidence: "core.ts:1" }], findings: [],
		},
	);
	const auditor = await Effect.runPromise(coordinator.delegate());
	await Effect.runPromise(coordinator.send({ workerId: auditor.workerId, delivery: "task", message: auditor.initialTask }));
	await Effect.runPromise(coordinator.wait(auditor.workerId));
	await assert.rejects(Effect.runPromise(coordinator.close(auditor.workerId)), /path:line file-level evidence/);

	await Effect.runPromise(coordinator.send({
		workerId: auditor.workerId,
		delivery: "follow-up",
		message: "Replace the audit report with requirement text and path:line evidence for every verdict.",
	}));
	const corrected = await Effect.runPromise(coordinator.wait(auditor.workerId));
	assert.equal(corrected.turn, 2);
	assert.equal(corrected.report?.status, "audit");
	assert.equal((await Effect.runPromise(coordinator.close(auditor.workerId))).phase, "completed");
	await Effect.runPromise(coordinator.shutdown());
});

test("stop never claims cancellation or releases ownership when Worker close is foreign or ambiguous", async () => {
	const project = await repository();
	const agentDir = await temp("ticketflow-coordinator-stop-agent-");
	const prepared = await prepareSetup({ projectPath: project, ticketsDirectory: "tickets", referencePaths: [], workerProfile: profile, delegationTemplate: "Implement {ticketPath}" });
	const backend = new FakeWorkerBackend(prepared.tickets[0]!.path);
	let sequence = 0;
	const coordinator = new TicketflowCoordinator({ backend, agentDir, newId: () => `stop-id-${++sequence}` });
	await Effect.runPromise(coordinator.createRun({ projectPath: project, orchestratorSessionId: "main-session", setup: prepared.setup, tickets: prepared.tickets }));
	await Effect.runPromise(coordinator.delegate());
	backend.closeFailure = new Error("foreign tmux ownership");
	await assert.rejects(Effect.runPromise(coordinator.stop()), /foreign tmux ownership/);
	assert.notEqual(coordinator.activeRun?.phase, "cancelled");
	backend.closeFailure = undefined;
	assert.equal((await Effect.runPromise(coordinator.stop())).phase, "cancelled");
	await Effect.runPromise(coordinator.shutdown());
});
