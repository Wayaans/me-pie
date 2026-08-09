import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
	CoordinationLedger,
	Workspace,
	boundManagedText,
	createManagedLaunchContext,
	managedLaunchEnvironment,
	normalizeWorkspaceParameters,
	validateManagedSnapshot,
} from "../terminal-environment/index.ts";
import { environmentError, type TerminalEnvironmentError } from "../terminal-environment/errors.ts";
import type { SpawnRequest, TargetIdentity, TerminalAdapter, TerminalTarget } from "../terminal-environment/model.ts";

const instanceId = "/tmp/mepie-managed-test.sock:99";

function target(paneId: string, overrides: Partial<TerminalTarget> = {}): TerminalTarget {
	return {
		environment: "tmux",
		sessionId: "$1",
		sessionName: "main",
		windowId: "@1",
		windowName: "worker",
		paneId,
		cwd: process.cwd(),
		currentCommand: "zsh",
		dead: false,
		...overrides,
	};
}

function identity(targetValue: TerminalTarget): TargetIdentity {
	return { instanceId, sessionId: targetValue.sessionId, windowId: targetValue.windowId, paneId: targetValue.paneId };
}

class ManagedFakeAdapter implements TerminalAdapter {
	readonly environment = "tmux" as const;
	readonly socketPath = "/tmp/mepie-managed-test.sock";
	readonly instanceId = instanceId;
	readonly sent: Array<{ readonly target: string; readonly text: string }> = [];
	readonly closed: string[] = [];
	readonly targets = new Map<string, TerminalTarget>();
	currentTarget: TerminalTarget;
	stale = false;
	runtimeStale = false;
	closeFails = false;
	closeStarted = false;
	closeGate: Promise<void> | undefined;
	sendGate: Promise<void> | undefined;
	sendStarted = false;
	launched = false;
	launchPath: string | undefined;

	constructor(paneId: string) {
		this.currentTarget = target(paneId);
	}

	spawn(_request: SpawnRequest, _defaultCwd: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		const created = target("%2", { windowName: "managed" });
		this.targets.set(created.paneId, created);
		return Effect.succeed(created);
	}

	resolve(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		if (this.stale && targetId === "%2") return Effect.succeed(target("%9", { windowId: "@9" }));
		if (this.runtimeStale && targetId === "%2") return Effect.succeed(target("%2", { currentCommand: "replacement" }));
		if (targetId === this.currentTarget.paneId) return Effect.succeed(this.currentTarget);
		const resolved = this.targets.get(targetId);
		if (resolved) return Effect.succeed(this.launched ? { ...resolved, currentCommand: "node" } : resolved);
		return Effect.succeed(target(targetId));
	}

	launch(_target: TerminalTarget, launcherPath: string, _cwd: string, _replace: boolean, _ownedByOperation: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.launchPath = launcherPath; this.launched = true; });
	}

	closeSpawnedWindow(targetValue: TerminalTarget): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.closed.push(targetValue.windowId); });
	}

	close(targetId: string, _expected?: TerminalTarget): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		if (this.closeFails) return Effect.fail(environmentError("close target", "close failed"));
		const wait = this.closeGate === undefined ? Effect.void : Effect.promise(() => this.closeGate!);
		return Effect.sync(() => { this.closeStarted = true; }).pipe(
			Effect.flatMap(() => wait),
			Effect.flatMap(() => this.resolve(targetId)),
			Effect.tap(() => Effect.sync(() => { this.closed.push(targetId); })),
		);
	}

	send(targetValue: TerminalTarget, text: string, _submit: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		const wait = this.sendGate === undefined ? Effect.void : Effect.promise(() => this.sendGate!);
		return Effect.sync(() => { this.sendStarted = true; }).pipe(
			Effect.flatMap(() => wait),
			Effect.tap(() => Effect.sync(() => { this.sent.push({ target: targetValue.paneId, text }); })),
		);
	}
}

async function withRoot<A>(run: (root: string) => Promise<A>): Promise<A> {
	const root = path.join(os.tmpdir(), `mepie-managed-${crypto.randomUUID()}`);
	try { return await run(root); }
	finally { await rm(root, { recursive: true, force: true }); }
}

async function setupManaged(root: string): Promise<{
	readonly runId: string;
	readonly token: string;
	readonly target: TerminalTarget;
	readonly parentAdapter: ManagedFakeAdapter;
	readonly workerAdapter: ManagedFakeAdapter;
	readonly parent: Workspace;
	readonly worker: Workspace;
}> {
	const targetValue = target("%2");
	const runId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	await Effect.runPromise(ledger.createRun({ runId, token, agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await Effect.runPromise(ledger.markLaunched(runId));
	const parentAdapter = new ManagedFakeAdapter("%1");
	parentAdapter.targets.set("%2", targetValue);
	const workerAdapter = new ManagedFakeAdapter("%2");
	const launchContext = createManagedLaunchContext({ runId, token, agent: "pi", instanceId, controllerPaneId: "%1", target: targetValue });
	const worker = new Workspace(workerAdapter, {
		coordinationRoot: root,
		signalStoreRoot: root,
		environment: managedLaunchEnvironment(launchContext),
		waitPollMs: 2,
	});
	assert.equal(await Effect.runPromise(worker.initializeManagedWorker({
		effectiveModel: { provider: "test", id: "model" },
		sessionId: "worker-session",
	})), true);
	const parent = new Workspace(parentAdapter, { coordinationRoot: root, signalStoreRoot: root, waitPollMs: 2 });
	return { runId, token, target: targetValue, parentAdapter, workerAdapter, parent, worker };
}

test("managed schema maps task/result/wait/close while raw target calls remain valid", () => {
	const runId = crypto.randomUUID();
	assert.deepEqual(normalizeWorkspaceParameters({ action: "send", send: { kind: "task", runId, input: "prompt", text: "literal" } }), {
		action: "send", request: { kind: "task", runId, input: "prompt", text: "literal" },
	});
	assert.deepEqual(normalizeWorkspaceParameters({ action: "send", send: { kind: "result", outcome: "blocked", text: "needs input" } }), {
		action: "send", request: { kind: "result", outcome: "blocked", text: "needs input" },
	});
	assert.deepEqual(normalizeWorkspaceParameters({ action: "wait", wait: { runId, workId: crypto.randomUUID() } }).action, "wait");
	assert.deepEqual(normalizeWorkspaceParameters({ action: "close", close: { runId } }), { action: "close", request: { runId } });
	assert.deepEqual(normalizeWorkspaceParameters({ action: "send", send: { targetId: "%2", input: "prompt", text: "raw" } }), {
		action: "send", request: { targetId: "%2", input: "prompt", text: "raw" },
	});
	assert.throws(() => normalizeWorkspaceParameters({ action: "send", send: { kind: "result", outcome: "completed", text: "x", targetId: "%2" } } as never), /send payload is invalid/);
	assert.throws(() => normalizeWorkspaceParameters({ action: "send", send: { targetId: "%2", input: "prompt", runId, text: "not raw" } } as never), /send payload is invalid/);
	assert.throws(() => normalizeWorkspaceParameters({ action: "send", send: { kind: "task", runId, input: "prompt", text: "paste", submit: false } } as never), /send payload is invalid/);
});

test("managed task/result correlation is durable, ordered, fast, and reusable without auto-close", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const firstTask = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "/implement literal task" } }, process.cwd()));
	assert.equal(firstTask.action, "send");
	if (firstTask.action !== "send") return;
	assert.equal(firstTask.kind, "task");
	if (firstTask.kind !== "task") return;
	const firstTransport = setup.parentAdapter.sent[0]?.text;
	assert.ok(firstTransport && !firstTransport.includes("/implement literal task"), "managed transport must hide its correlation envelope from Pi command preflight");
	const firstWorkId = firstTask.workId;
	const firstRoute = await Effect.runPromise(setup.worker.routeManagedInput(firstTransport!, undefined));
	assert.deepEqual(firstRoute, { kind: "accepted", text: "/implement literal task" }, "raw input must unwrap before prompt-template expansion");
	assert.ok(await Effect.runPromise(setup.worker.managedPromptGuidance()), "expanded before_agent_start prompts must retain the raw-input Work Cycle binding");
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /active Work Cycle/, "close must not race an active task reservation");

	const result = await Effect.runPromise(setup.worker.execute({ action: "send", request: { kind: "result", outcome: "completed", text: "fast result" } }, process.cwd()));
	assert.equal(result.action, "send");
	if (result.action !== "send") return;
	assert.equal(result.kind, "result");
	assert.equal(result.workFinished, false, "Result Received must precede Work Finished");
	const pending = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, workId: firstWorkId, timeoutMs: 5 } }, process.cwd()));
	assert.equal(pending.action, "wait");
	if (pending.action === "wait" && "mode" in pending) {
		assert.equal(pending.reason, "timeout");
		assert.equal(pending.resultReceived, true);
		assert.equal(pending.workFinished, false);
	}
	await Effect.runPromise(setup.worker.finishManagedWork());
	const finished = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId }, }, process.cwd()));
	assert.equal(finished.action, "wait");
	if (finished.action === "wait" && "mode" in finished) {
		assert.equal(finished.reason, "work_finished");
		assert.equal(finished.text, "fast result");
		assert.equal(finished.workId, firstWorkId);
		assert.equal(finished.metadata?.sessionId, "worker-session");
	}
	assert.deepEqual(setup.parentAdapter.closed, [], "managed wait must never close Pi or tmux");

	const secondTask = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "second" } }, process.cwd()));
	assert.equal(secondTask.action, "send");
	if (secondTask.action !== "send") return;
	if (secondTask.kind !== "task") return;
	const secondWorkId = secondTask.workId;
	assert.notEqual(secondWorkId, firstWorkId, "a reused run receives a new Work Cycle");
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	await assert.rejects(Effect.runPromise(ledger.recordResult({ runId: setup.runId, workId: firstWorkId, token: setup.token, worker: identity(setup.target), outcome: "failed", text: "late first result" })), /is stale/);
	await assert.rejects(Effect.runPromise(setup.worker.execute({ action: "send", request: { kind: "result", outcome: "failed", text: "late first result" } }, process.cwd())), /No managed Work Cycle is bound/, "a late result cannot stamp the newer Work Cycle before its turn is bound");
	const secondTransport = setup.parentAdapter.sent.at(-1)?.text;
	assert.ok(secondTransport);
	assert.deepEqual(await Effect.runPromise(setup.worker.routeManagedInput(secondTransport!, undefined)), { kind: "accepted", text: "second" }, "the second envelope binds only its new Work Cycle");
	assert.ok(await Effect.runPromise(setup.worker.managedPromptGuidance()));
	await Effect.runPromise(setup.worker.execute({ action: "send", request: { kind: "result", outcome: "failed", text: "second failed" } }, process.cwd()));
	await Effect.runPromise(setup.worker.finishManagedWork());
	const secondFinished = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, timeoutMs: 100 } }, process.cwd()));
	assert.equal(secondFinished.action, "wait");
	if (secondFinished.action === "wait" && "mode" in secondFinished) {
		assert.equal(secondFinished.workId, secondWorkId);
		assert.equal(secondFinished.outcome, "failed");
	}
	await Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd()));
	assert.deepEqual(setup.parentAdapter.closed, ["%2"], "only explicit managed close may close the run target");
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /possibly reused target/);
	assert.deepEqual(setup.parentAdapter.closed, ["%2"]);
}));

test("managed waits ignore unrelated raw sends and wrong result source/token", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const task = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "task" } }, process.cwd()));
	assert.equal(task.action, "send");
	if (task.action !== "send" || task.kind !== "task") return;
	const waiting = Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, workId: task.workId, timeoutMs: 25 } }, process.cwd()));
	await Effect.runPromise(setup.worker.execute({ action: "send", request: { targetId: "%1", input: "prompt", text: "unrelated raw send" } }, process.cwd()));
	const timed = await waiting;
	assert.equal(timed.action, "wait");
	if (timed.action === "wait" && "mode" in timed) assert.equal(timed.reason, "timeout");

	const wrongToken = crypto.randomUUID();
	const badLedger = new CoordinationLedger(instanceId, { rootDirectory: root });
	await assert.rejects(Effect.runPromise(badLedger.recordResult({
		runId: setup.runId,
		workId: task.workId,
		token: wrongToken,
		worker: identity(setup.target),
		outcome: "completed",
		text: "wrong",
	})), /token is invalid/);
	await assert.rejects(Effect.runPromise(badLedger.recordResult({
		runId: crypto.randomUUID(),
		workId: crypto.randomUUID(),
		token: setup.token,
		worker: identity(setup.target),
		outcome: "completed",
		text: "wrong run",
	})), /Unknown Agent Run/);
	await assert.rejects(Effect.runPromise(badLedger.recordResult({
		runId: setup.runId,
		workId: task.workId,
		token: setup.token,
		worker: { ...identity(setup.target), paneId: "%9" },
		outcome: "completed",
		text: "wrong source",
	})), /source target is stale/);
	await assert.rejects(Effect.runPromise(badLedger.recordResult({
		runId: setup.runId,
		workId: crypto.randomUUID(),
		token: setup.token,
		worker: identity(setup.target),
		outcome: "completed",
		text: "stale work",
	})), /does not belong/);
}));

test("Work Finished without Result Received returns an explicit protocol failure", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const task = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "no result" } }, process.cwd()));
	assert.equal(task.action, "send");
	if (task.action !== "send" || task.kind !== "task") return;
	const transport = setup.parentAdapter.sent.at(-1)?.text;
	assert.ok(transport);
	assert.deepEqual(await Effect.runPromise(setup.worker.routeManagedInput(transport!, undefined)), { kind: "accepted", text: "no result" });
	assert.ok(await Effect.runPromise(setup.worker.managedPromptGuidance()));
	await Effect.runPromise(setup.worker.finishManagedWork());
	const waited = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, workId: task.workId, timeoutMs: 100 } }, process.cwd()));
	assert.equal(waited.action, "wait");
	if (waited.action === "wait" && "mode" in waited) {
		assert.equal(waited.reason, "protocol_failure");
		assert.equal(waited.protocolFailure, true);
		assert.equal(waited.resultReceived, false);
		assert.equal(waited.workFinished, true);
	}
}));

test("a transient Work Finished write failure retains the exact binding for retry", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "retry finish" } }, process.cwd()));
	const transport = setup.parentAdapter.sent.at(-1)?.text;
	assert.ok(transport);
	assert.deepEqual(await Effect.runPromise(setup.worker.routeManagedInput(transport!, undefined)), { kind: "accepted", text: "retry finish" });
	const serverId = createHash("sha256").update(instanceId).digest("hex").slice(0, 24);
	const lock = path.join(root, serverId, "ledger.lock");
	await mkdir(lock, { recursive: true });
	await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }));
	await assert.rejects(Effect.runPromise(setup.worker.finishManagedWork()), /Timed out acquiring/);
	await rm(lock, { recursive: true, force: true });
	assert.equal(await Effect.runPromise(setup.worker.finishManagedWork()), true);
}));

test("managed input rejects delivery into a busy Pi turn without hanging or closing", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const task = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "queued while busy" } }, process.cwd()));
	assert.equal(task.action, "send");
	if (task.action !== "send" || task.kind !== "task") return;
	const transport = setup.parentAdapter.sent.at(-1)?.text;
	assert.ok(transport);
	assert.deepEqual(await Effect.runPromise(setup.worker.routeManagedInput(transport!, "steer")), { kind: "rejected" });
	const waited = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, workId: task.workId, timeoutMs: 100 } }, process.cwd()));
	assert.equal(waited.action, "wait");
	if (waited.action === "wait" && "mode" in waited) {
		assert.equal(waited.reason, "protocol_failure");
		assert.match(waited.text ?? "", /already processing steer input/);
	}
	assert.deepEqual(setup.parentAdapter.closed, []);
}));

test("managed task sends reject unverified and non-Pi runs", async () => withRoot(async (root) => {
	const targetValue = target("%2");
	const runId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	await Effect.runPromise(ledger.createRun({ runId, token, agent: "codex", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await Effect.runPromise(ledger.markLaunched(runId));
	const adapter = new ManagedFakeAdapter("%1");
	adapter.targets.set("%2", targetValue);
	const workspace = new Workspace(adapter, { coordinationRoot: root, signalStoreRoot: root });
	await assert.rejects(Effect.runPromise(workspace.execute({ action: "send", request: { kind: "task", runId, input: "prompt", text: "nope" } }, process.cwd())), /verified Pi Agent Run/);
}));

test("worker restart abandons an unbound active Work Cycle before re-verifying", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const task = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "interrupted" } }, process.cwd()));
	assert.equal(task.action, "send");
	if (task.action !== "send" || task.kind !== "task") return;
	const replacementAdapter = new ManagedFakeAdapter("%2");
	const launchContext = createManagedLaunchContext({ runId: setup.runId, token: setup.token, agent: "pi", instanceId, controllerPaneId: "%1", target: setup.target });
	const replacement = new Workspace(replacementAdapter, {
		coordinationRoot: root,
		signalStoreRoot: root,
		environment: managedLaunchEnvironment(launchContext),
	});
	assert.equal(await Effect.runPromise(replacement.initializeManagedWorker({ effectiveModel: { provider: "test", id: "model" } })), true);
	const waited = await Effect.runPromise(setup.parent.execute({ action: "wait", request: { runId: setup.runId, workId: task.workId, timeoutMs: 100 } }, process.cwd()));
	assert.equal(waited.action, "wait");
	if (waited.action === "wait" && "mode" in waited) {
		assert.equal(waited.reason, "protocol_failure");
		assert.match(waited.text ?? "", /session restarted/);
	}
}));

test("readiness revocation ends active work and blocks later managed tasks", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const task = await Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "auth changes" } }, process.cwd()));
	assert.equal(task.action, "send");
	if (task.action !== "send" || task.kind !== "task") return;
	await Effect.runPromise(setup.worker.revokeManagedReadiness("provider authentication is no longer configured"));
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	const run = await Effect.runPromise(ledger.getRun(setup.runId));
	assert.equal(run?.readiness, "unverified");
	assert.equal(run?.verifiedWorkFinished, false);
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "retry" } }, process.cwd())), /not a verified Pi Agent Run/);
	assert.match((await Effect.runPromise(ledger.getWork(setup.runId, task.workId)))?.protocolFailure ?? "", /authentication/);
}));

test("run target ownership is reserved without retiring a live run", async () => withRoot(async (root) => {
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	const first = { runId: crypto.randomUUID(), token: crypto.randomUUID() };
	const targetValue = target("%2");
	await Effect.runPromise(ledger.createRun({ ...first, agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await assert.rejects(Effect.runPromise(ledger.beginWork({ runId: first.runId, controllerPaneId: "%1", controllerTarget: identity(target("%1")), workerPaneId: "%2", input: "prompt", text: "not ready" })), /verified Pi Agent Run/);
	await assert.rejects(Effect.runPromise(ledger.createRun({ runId: crypto.randomUUID(), token: crypto.randomUUID(), agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId })), /already owned/);
	assert.equal((await Effect.runPromise(ledger.getRun(first.runId)))?.state, "starting");
	await Effect.runPromise(ledger.markLost(first.runId));
	await Effect.runPromise(ledger.createRun({ runId: crypto.randomUUID(), token: crypto.randomUUID(), agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
}));

test("verified child target diagnostics win the launch-readiness race", async () => withRoot(async (root) => {
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	const runId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const launchTarget = target("%2", { currentCommand: "launch.sh" });
	const readyTarget = target("%2", { currentCommand: "pi" });
	await Effect.runPromise(ledger.createRun({ runId, token, agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: launchTarget, instanceId }));
	await Effect.runPromise(ledger.recordReadiness({ runId, token, target: identity(readyTarget), targetSnapshot: readyTarget }));
	await Effect.runPromise(ledger.updateTarget({ runId, token, target: launchTarget }));
	assert.equal((await Effect.runPromise(ledger.getRun(runId)))?.target.currentCommand, "pi");
}));

test("completed Work Cycles are pruned while the latest cycle remains addressable", async () => withRoot(async (root) => {
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	const runId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const targetValue = target("%2");
	await Effect.runPromise(ledger.createRun({ runId, token, agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await Effect.runPromise(ledger.markLaunched(runId));
	await Effect.runPromise(ledger.recordReadiness({ runId, token, target: identity(targetValue) }));
	let firstWorkId = "";
	for (let index = 0; index < 80; index += 1) {
		const work = await Effect.runPromise(ledger.beginWork({ runId, controllerPaneId: "%1", controllerTarget: identity(target("%1")), workerPaneId: "%2", input: "prompt", text: `cycle ${index}` }));
		if (index === 0) firstWorkId = work.workId;
		await Effect.runPromise(ledger.recordResult({ runId, workId: work.workId, token, worker: identity(targetValue), outcome: "completed", text: `done ${index}` }));
		await Effect.runPromise(ledger.markWorkFinished({ runId, workId: work.workId, token, worker: identity(targetValue) }));
	}
	assert.equal(await Effect.runPromise(ledger.getWork(runId, firstWorkId)), undefined);
	assert.equal((await Effect.runPromise(ledger.getWork(runId)))?.text, "done 79");
	await Effect.runPromise(ledger.markLost(runId));
	const firstRunId = crypto.randomUUID();
	await Effect.runPromise(ledger.createRun({ runId: firstRunId, token: crypto.randomUUID(), agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await Effect.runPromise(ledger.markLost(firstRunId));
	let latestRunId = firstRunId;
	for (let index = 0; index < 80; index += 1) {
		latestRunId = crypto.randomUUID();
		await Effect.runPromise(ledger.createRun({ runId: latestRunId, token: crypto.randomUUID(), agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
		await Effect.runPromise(ledger.markLost(latestRunId));
	}
	assert.equal(await Effect.runPromise(ledger.getRun(firstRunId)), undefined);
	assert.equal((await Effect.runPromise(ledger.getRun(latestRunId)))?.state, "lost");
}));

test("cancellation after a durable task reservation cleans up atomically", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const coordination = (setup.parent as unknown as { coordination: CoordinationLedger }).coordination;
	const beginWork = coordination.beginWork.bind(coordination);
	let reportReserved!: () => void;
	let releaseReservation!: () => void;
	const reserved = new Promise<void>((resolve) => { reportReserved = resolve; });
	const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
	// Force cancellation after the ledger write but before beginWork returns to Workspace.
	coordination.beginWork = (input) => beginWork(input).pipe(
		Effect.tap(() => Effect.sync(reportReserved)),
		Effect.tap(() => Effect.promise(() => reservationGate)),
	);
	const controller = new AbortController();
	const sending = Effect.runPromise(
		setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "abort reservation" } }, process.cwd()),
		{ signal: controller.signal },
	);
	await reserved;
	controller.abort();
	releaseReservation();
	await assert.rejects(sending);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "idle");
	assert.equal(await Effect.runPromise(ledger.getActiveWork(setup.runId)), undefined);
}));

test("aborting an attempted managed task delivery marks its run lost", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	let release!: () => void;
	setup.parentAdapter.sendGate = new Promise<void>((resolve) => { release = resolve; });
	const controller = new AbortController();
	const sending = Effect.runPromise(
		setup.parent.execute({ action: "send", request: { kind: "task", runId: setup.runId, input: "prompt", text: "abort delivery" } }, process.cwd()),
		{ signal: controller.signal },
	);
	for (let attempt = 0; attempt < 50 && !setup.parentAdapter.sendStarted; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.equal(setup.parentAdapter.sendStarted, true);
	controller.abort();
	await assert.rejects(sending);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "lost");
	assert.equal(await Effect.runPromise(ledger.getActiveWork(setup.runId)), undefined);
	release();
}));

test("aborting workspace run rolls back its newly spawned target", async () => withRoot(async (root) => {
	const adapter = new ManagedFakeAdapter("%1");
	const workspace = new Workspace(adapter, {
		coordinationRoot: root,
		signalStoreRoot: root,
		agentExecutables: { pi: process.execPath },
		readinessTimeoutMs: 30_000,
	});
	const controller = new AbortController();
	const running = Effect.runPromise(workspace.execute({ action: "run", request: { agent: "pi" } }, process.cwd()), { signal: controller.signal });
	for (let attempt = 0; attempt < 50 && !adapter.launched; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
	controller.abort();
	await assert.rejects(running);
	assert.deepEqual(adapter.closed, ["@1"]);
}));

test("canceling a failed delivery preserves a lost or closed run state", async () => withRoot(async (root) => {
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	const runId = crypto.randomUUID();
	const token = crypto.randomUUID();
	const targetValue = target("%2");
	await Effect.runPromise(ledger.createRun({ runId, token, agent: "pi", controllerPaneId: "%1", controllerTarget: identity(target("%1")), target: targetValue, instanceId }));
	await Effect.runPromise(ledger.markLaunched(runId));
	await Effect.runPromise(ledger.recordReadiness({ runId, token, target: identity(targetValue) }));
	const work = await Effect.runPromise(ledger.beginWork({ runId, controllerPaneId: "%1", controllerTarget: identity(target("%1")), workerPaneId: "%2", input: "prompt", text: "cancel" }));
	await Effect.runPromise(ledger.markLost(runId));
	await Effect.runPromise(ledger.cancelWork(runId, work.workId));
	assert.equal((await Effect.runPromise(ledger.getRun(runId)))?.state, "lost");
}));

test("raw close cannot bypass managed Agent Run ownership", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { targetId: "%2" } }, process.cwd())), /close it by runId/);
	assert.deepEqual(setup.parentAdapter.closed, []);
	await Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd()));
	assert.deepEqual(setup.parentAdapter.closed, ["%2"]);
}));

test("managed close validates target identity, marks stale runs lost, and only closes explicitly", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	setup.parentAdapter.stale = true;
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /stale or was reused/);
	assert.deepEqual(setup.parentAdapter.closed, []);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "lost");
}));

test("managed close marks ownership lost when the adapter close outcome is uncertain", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	setup.parentAdapter.closeFails = true;
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /close failed/);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "lost");
	setup.parentAdapter.closeFails = false;
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /possibly reused target/);
	assert.deepEqual(setup.parentAdapter.closed, []);
}));

test("cancellation after a durable close reservation restores the run atomically", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const coordination = (setup.parent as unknown as { coordination: CoordinationLedger }).coordination;
	const markClosing = coordination.markClosing.bind(coordination);
	let reportReserved!: () => void;
	let releaseReservation!: () => void;
	const reserved = new Promise<void>((resolve) => { reportReserved = resolve; });
	const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
	// Force cancellation after the ledger write but before markClosing returns to Workspace.
	coordination.markClosing = (input) => markClosing(input).pipe(
		Effect.tap(() => Effect.sync(reportReserved)),
		Effect.tap(() => Effect.promise(() => reservationGate)),
	);
	const controller = new AbortController();
	const closing = Effect.runPromise(
		setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd()),
		{ signal: controller.signal },
	);
	await reserved;
	controller.abort();
	releaseReservation();
	await assert.rejects(closing);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "idle");
}));

test("aborting an attempted managed close marks its run lost", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	let release!: () => void;
	setup.parentAdapter.closeGate = new Promise<void>((resolve) => { release = resolve; });
	const controller = new AbortController();
	const closing = Effect.runPromise(
		setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd()),
		{ signal: controller.signal },
	);
	for (let attempt = 0; attempt < 50 && !setup.parentAdapter.closeStarted; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.equal(setup.parentAdapter.closeStarted, true);
	controller.abort();
	await assert.rejects(closing);
	const ledger = new CoordinationLedger(instanceId, { rootDirectory: root });
	assert.equal((await Effect.runPromise(ledger.getRun(setup.runId)))?.state, "lost");
	release();
}));

test("managed close rejects a same-pane runtime replacement", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	setup.parentAdapter.runtimeStale = true;
	await assert.rejects(Effect.runPromise(setup.parent.execute({ action: "close", request: { runId: setup.runId } }, process.cwd())), /stale or was reused/);
	assert.deepEqual(setup.parentAdapter.closed, []);
}));

test("Pi launch context, branch snapshots, non-Pi capability, and result bounds are safe", async () => withRoot(async (root) => {
	const setup = await setupManaged(root);
	const snapshot = await Effect.runPromise(setup.worker.managedSnapshot());
	assert.ok(snapshot);
	assert.ok(!JSON.stringify(snapshot).includes(setup.token), "Pi session snapshots must not contain launch tokens");
	assert.equal(validateManagedSnapshot(snapshot)?.runId, setup.runId);
	assert.equal(validateManagedSnapshot({ ...snapshot, workId: "not-a-uuid" }), undefined);
	assert.equal(validateManagedSnapshot({ ...snapshot, resultReceived: true }), undefined);
	assert.equal(validateManagedSnapshot({ ...snapshot, secret: "token" }), undefined);
	const bounded = boundManagedText(`${"x".repeat(60 * 1_024)}\n${"y\n".repeat(2_100)}`);
	assert.ok(bounded.truncated);
	assert.ok(bounded.bytes <= 48 * 1_024);

	const adapter = new ManagedFakeAdapter("%1");
	const nonPiRoot = path.join(root, "non-pi");
	const workspace = new Workspace(adapter, { coordinationRoot: nonPiRoot, signalStoreRoot: nonPiRoot, agentExecutables: { codex: process.execPath } });
	const run = await Effect.runPromise(workspace.execute({ action: "run", request: { agent: "codex" } }, process.cwd()));
	assert.equal(run.action, "run");
	if (run.action === "run") {
		assert.match(run.runId ?? "", /^[0-9a-f-]{36}$/);
		assert.equal(run.capability, "unverified");
		assert.equal(run.capabilities?.verifiedWorkFinished, false);
	}
	if (adapter.launchPath) await rm(path.dirname(adapter.launchPath), { recursive: true, force: true });
}));
