import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import terminalEnvironment, {
	SignalStore,
	TmuxAdapter,
	Workspace,
	buildAgentInvocation,
	normalizeWorkspaceParameters,
} from "../terminal-environment/index.ts";
import { environmentError, type TerminalEnvironmentError } from "../terminal-environment/errors.ts";
import type {
	SpawnRequest,
	TerminalAdapter,
	TerminalTarget,
} from "../terminal-environment/model.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../terminal-environment/process.ts";

const socketPath = "/tmp/mepie-test-tmux.sock";

function target(overrides: Partial<TerminalTarget> = {}): TerminalTarget {
	return {
		environment: "tmux",
		sessionId: "$1",
		sessionName: "main",
		windowId: "@1",
		windowName: "main",
		paneId: "%1",
		cwd: process.cwd(),
		currentCommand: "zsh",
		dead: false,
		...overrides,
	};
}

function record(value = target()): string {
	return [
		socketPath,
		"4822",
		value.sessionId,
		value.sessionName,
		value.windowId,
		value.paneId,
		value.windowName,
		value.cwd,
		value.currentCommand,
		value.dead ? "1" : "0",
	].join("\u001f") + "\n";
}

class FakeTmuxRunner implements CommandRunner {
	readonly calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
	loadedText: string | undefined;
	resolved = target();
	readonly resolvedTargets = new Map<string, TerminalTarget>();
	failCommand: string | undefined;

	async run(executable: string, args: readonly string[], _options?: CommandOptions): Promise<CommandResult> {
		this.calls.push({ executable, args: [...args] });
		const commandIndex = args[0] === "-S" ? 2 : 0;
		const command = args[commandIndex];
		if (command === this.failCommand) return { stdout: "", stderr: `${command} failed`, code: 1 };
		if (command === "display-message") {
			const targetIndex = args.indexOf("-t");
			const targetId = targetIndex < 0 ? undefined : args[targetIndex + 1];
			return { stdout: record(targetId ? (this.resolvedTargets.get(targetId) ?? this.resolved) : this.resolved), stderr: "", code: 0 };
		}
		if (command === "new-window") {
			return { stdout: record(target({ windowId: "@2", windowName: "agent", paneId: "%2" })), stderr: "", code: 0 };
		}
		if (command === "split-window") {
			return { stdout: record(target({ paneId: "%3" })), stderr: "", code: 0 };
		}
		if (command === "new-session") {
			return { stdout: record(target({ sessionId: "$2", sessionName: "other", windowId: "@4", paneId: "%4" })), stderr: "", code: 0 };
		}
		if (command === "load-buffer") {
			this.loadedText = await readFile(args.at(-1)!, "utf8");
		}
		return { stdout: "", stderr: "", code: 0 };
	}
}

class FakeTerminalAdapter implements TerminalAdapter {
	readonly environment = "tmux" as const;
	readonly socketPath = socketPath;
	readonly instanceId = `${socketPath}:4822`;
	readonly currentTarget: TerminalTarget;
	alive = true;
	dead = false;
	launchFails = false;
	launched = false;
	launchedAt: number | undefined;
	lastLauncherPath: string | undefined;
	lastReplace: boolean | undefined;
	closedWindows = 0;
	readonly closedTargetIds: string[] = [];
	readonly sent: string[] = [];

	constructor(currentTarget: TerminalTarget = target()) {
		this.currentTarget = currentTarget;
	}

	spawn(_request: SpawnRequest, _defaultCwd: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		return Effect.succeed({ ...this.currentTarget, windowId: "@2", windowName: "worker", paneId: "%2" });
	}
	resolve(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		if (!this.alive) return Effect.fail(environmentError("resolve tmux target", `can't find target: ${targetId}`));
		const identity = targetId.startsWith("$") ? { sessionId: targetId }
			: targetId.startsWith("@") ? { windowId: targetId }
				: { paneId: targetId };
		return Effect.succeed({ ...this.currentTarget, ...identity, ...(this.launched ? { currentCommand: "node" } : {}), dead: this.dead });
	}
	launch(_target: TerminalTarget, launcherPath: string, _cwd: string, replace: boolean, _ownedByOperation: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		this.launchedAt = Date.now();
		this.lastLauncherPath = launcherPath;
		this.lastReplace = replace;
		if (this.launchFails) return Effect.fail(environmentError("launch coding agent", "launch failed"));
		this.launched = true;
		return Effect.void;
	}
	closeSpawnedWindow(_target: TerminalTarget): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.closedWindows += 1; });
	}
	close(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		return this.resolve(targetId).pipe(Effect.tap(() => Effect.sync(() => { this.closedTargetIds.push(targetId); })));
	}
	send(_target: TerminalTarget, text: string, _submit: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.sent.push(text); });
	}
}

test("workspace parameters require exactly one payload matching the action", () => {
	assert.deepEqual(normalizeWorkspaceParameters({ action: "spawn", spawn: {} }), { action: "spawn", request: {} });
	assert.deepEqual(normalizeWorkspaceParameters({ action: "close", close: { targetId: "%2" } }), {
		action: "close",
		request: { targetId: "%2" },
	});
	assert.throws(
		() => normalizeWorkspaceParameters({ action: "close", close: { targetId: "$2" } } as never),
		/close payload is invalid/,
	);
	assert.throws(
		() => normalizeWorkspaceParameters({ action: "spawn", run: {} }),
		/requires exactly one matching spawn payload/,
	);
});

test("coding-agent adapters start fresh agents with only managed model and thinking options", () => {
	assert.deepEqual(buildAgentInvocation({}), { agent: "pi", executableName: "pi", args: [] });
	assert.deepEqual(buildAgentInvocation({ agent: "pi", model: "openai/gpt", thinking: "high" }).args,
		["--model", "openai/gpt", "--thinking", "high"]);
	assert.deepEqual(buildAgentInvocation({ agent: "codex", thinking: "xhigh" }).args,
		["-c", "model_reasoning_effort=\"xhigh\""]);
	assert.deepEqual(buildAgentInvocation({ agent: "claude", thinking: "max" }).args,
		["--effort", "max"]);
	assert.deepEqual(buildAgentInvocation({ agent: "opencode", thinking: "minimal" }).args,
		["--variant", "minimal"]);
	assert.throws(() => buildAgentInvocation({ agent: "claude", thinking: "minimal" }), /does not support/);
	assert.throws(
		() => normalizeWorkspaceParameters({ action: "run", run: { prompt: "do it" } } as never),
		/run payload is invalid/,
	);
	assert.throws(
		() => normalizeWorkspaceParameters({ action: "run", run: { extraArgs: ["do it"] } } as never),
		/run payload is invalid/,
	);
});

test("tmux detection, spawning, and literal multiline delivery use the current server", async () => {
	const runner = new FakeTmuxRunner();
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, TMUX_PANE: "%1", PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	}));
	assert.ok(adapter);
	const spawned = await Effect.runPromise(adapter.spawn({}, process.cwd()));
	assert.equal(spawned.windowId, "@2");
	const newWindow = runner.calls.find((call) => call.args.includes("new-window"));
	assert.ok(newWindow?.args.includes("-d"));
	assert.ok(newWindow?.args.includes("$1"));
	await Effect.runPromise(adapter.spawn({ kind: "pane", title: "logs" }, process.cwd()));
	assert.ok(runner.calls.some((call) => call.args.includes("select-pane") && call.args.includes("-T") && call.args.includes("logs")));

	const markdown = "# Task\n\nUse `$HOME` literally; don't interpolate.";
	await Effect.runPromise(adapter.send(target(), markdown, true));
	assert.equal(runner.loadedText, markdown);
	const paste = runner.calls.find((call) => call.args.includes("paste-buffer") && call.args.includes("%1"));
	assert.ok(paste?.args.includes("-p"), "multiline input must use tmux bracketed paste");
	assert.equal(runner.calls.filter((call) => call.args.includes("send-keys") && call.args.at(-1) === "Enter").length, 1);

	await Effect.runPromise(adapter.send(target(), "draft", false));
	assert.equal(runner.calls.filter((call) => call.args.includes("send-keys") && call.args.at(-1) === "Enter").length, 1,
		"paste-only delivery must not submit another prompt");
	assert.ok(runner.calls.filter((call) => call.args[0] === "-S").every((call) => call.args[1] === socketPath));
});

test("tmux rolls back a pane when post-spawn title setup fails", async () => {
	const runner = new FakeTmuxRunner();
	runner.failCommand = "select-pane";
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, TMUX_PANE: "%1", PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	}));
	assert.ok(adapter);
	await assert.rejects(Effect.runPromise(adapter.spawn({ kind: "pane", title: "logs" }, process.cwd())), /select-pane failed/);
	assert.ok(runner.calls.some((call) => call.args.includes("kill-pane") && call.args.includes("%3")));
});

test("tmux launch rejects a busy pane unless replacement is explicit", async () => {
	const runner = new FakeTmuxRunner();
	runner.resolved = target({ currentCommand: "node" });
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, TMUX_PANE: "%1", PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	}));
	assert.ok(adapter);
	await assert.rejects(Effect.runPromise(adapter.launch(runner.resolved, "/tmp/launch.sh", process.cwd(), false, false)), /busy with node/);
	await Effect.runPromise(adapter.launch(runner.resolved, "/tmp/launch.sh", process.cwd(), true, false));
	assert.ok(runner.calls.some((call) => call.args.includes("respawn-pane") && call.args.includes("-k")));
});

test("tmux close uses exact target kinds and protects the calling hierarchy", async () => {
	const runner = new FakeTmuxRunner();
	runner.resolvedTargets.set("%2", target({ paneId: "%2", windowId: "@2", windowName: "worker" }));
	runner.resolvedTargets.set("@2", target({ paneId: "%2", windowId: "@2", windowName: "worker" }));
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, TMUX_PANE: "%1", PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	}));
	assert.ok(adapter);

	assert.equal((await Effect.runPromise(adapter.close("%2"))).paneId, "%2");
	assert.equal((await Effect.runPromise(adapter.close("@2"))).windowId, "@2");
	for (const [command, targetId] of [["kill-pane", "%2"], ["kill-window", "@2"]] as const) {
		assert.ok(runner.calls.some((call) => call.args.includes(command) && call.args.includes(targetId)));
	}

	await assert.rejects(Effect.runPromise(adapter.close("%1")), /contains the calling pane %1/);
	await assert.rejects(Effect.runPromise(adapter.close("@1")), /contains the calling pane %1/);
	await assert.rejects(Effect.runPromise(adapter.close("$2")), /requires a pane or window ID/);
	assert.ok(runner.calls.every((call) => !call.args.includes("kill-session")));
});

test("workspace close reports the closed target kind and snapshot", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-coordination-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter(target({ paneId: "%1" }));
	const workspace = new Workspace(adapter, { coordinationRoot: directory });
	try {
		const result = await Effect.runPromise(workspace.execute({
			action: "close",
			request: { targetId: "%2" },
		}, process.cwd()));
		assert.deepEqual(adapter.closedTargetIds, ["%2"]);
		assert.equal(result.action, "close");
		if (result.action === "close") {
			assert.equal(result.kind, "pane");
			assert.equal(result.target.paneId, "%2");
		}
		await assert.rejects(
			Effect.runPromise(workspace.execute({ action: "close", request: { targetId: "$2" } }, process.cwd())),
			/requires a pane or window ID/,
		);
		assert.deepEqual(adapter.closedTargetIds, ["%2"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("signal store serializes concurrent inbox signals and preserves source order", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const store = new SignalStore(`${socketPath}:4822`, { rootDirectory: directory });
	try {
		const sequences = await Effect.runPromise(Effect.all(
			Array.from({ length: 20 }, () => store.signal("%1", "%2")),
			{ concurrency: "unbounded" },
		));
		assert.deepEqual([...sequences].sort((left, right) => left - right), Array.from({ length: 20 }, (_, index) => index + 1));
		assert.equal(await Effect.runPromise(store.currentSequence("%1")), 20);
		assert.deepEqual(await Effect.runPromise(store.currentSignal("%1")), {
			sequence: 20,
			sourcePaneId: "%2",
		});
		assert.equal(await Effect.runPromise(store.signal("%1", "%3")), 21);
		const twentieth = await Effect.runPromise(store.poll("%1", 19));
		assert.equal(twentieth.currentSequence, 21);
		assert.deepEqual({ sequence: twentieth.signal?.sequence, sourcePaneId: twentieth.signal?.sourcePaneId }, { sequence: 20, sourcePaneId: "%2" });
		assert.ok(twentieth.signal?.deliveryId);
		const twentyFirst = await Effect.runPromise(store.poll("%1", 20));
		assert.equal(twentyFirst.currentSequence, 21);
		assert.deepEqual({ sequence: twentyFirst.signal?.sequence, sourcePaneId: twentyFirst.signal?.sourcePaneId }, { sequence: 21, sourcePaneId: "%3" });
		assert.ok(twentyFirst.signal?.deliveryId);
		assert.equal(await Effect.runPromise(store.currentSequence("%2")), 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("two-phase raw deliveries wake wait only after commit and remain idempotent", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const store = new SignalStore(`${socketPath}:4822`, { rootDirectory: directory });
	try {
		const deliveryId = crypto.randomUUID();
		await Effect.runPromise(store.reserve("%1", "%2", deliveryId));
		assert.equal((await Effect.runPromise(store.poll("%1", 0))).signal, undefined);
		await Effect.runPromise(store.markUncertain("%1", deliveryId));
		assert.equal((await Effect.runPromise(store.poll("%1", 0))).signal, undefined);
		const committedId = crypto.randomUUID();
		await Effect.runPromise(store.reserve("%1", "%2", committedId));
		const first = await Effect.runPromise(store.commit("%1", committedId));
		const duplicate = await Effect.runPromise(store.commit("%1", committedId));
		assert.deepEqual(duplicate, first);
		const poll = await Effect.runPromise(store.poll("%1", 0));
		assert.equal(poll.signal?.deliveryId, committedId);
		assert.equal(poll.signal?.sequence, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("legacy v1 inbox signals remain readable", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const serverId = createHash("sha256").update(`${socketPath}:4822`).digest("hex").slice(0, 24);
	try {
		const inboxDirectory = path.join(directory, serverId);
		await mkdir(inboxDirectory, { recursive: true });
		await writeFile(path.join(inboxDirectory, "to-1.json"), JSON.stringify({ version: 1, sequence: 1, signals: [{ sequence: 1, sourcePaneId: "%2" }] }));
		const store = new SignalStore(`${socketPath}:4822`, { rootDirectory: directory });
		assert.deepEqual(await Effect.runPromise(store.poll("%1", 0)), {
			currentSequence: 1,
			signal: { sequence: 1, sourcePaneId: "%2" },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("raw send reserves before paste and reports uncertain commit failures without retrying", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	const workspace = new Workspace(adapter, { signalStoreRoot: directory });
	const signalStore = (workspace as unknown as { signalStore: SignalStore }).signalStore;
	const commit = signalStore.commit.bind(signalStore);
	try {
		signalStore.commit = (_paneId, deliveryId) => Effect.fail(environmentError("commit signal", `forced commit failure ${deliveryId}`));
		await assert.rejects(Effect.runPromise(workspace.execute({ action: "send", request: { targetId: "%2", input: "prompt", text: "once" } }, process.cwd())), /delivery_uncertain.*do not retry/);
		assert.deepEqual(adapter.sent, ["once"]);
		assert.equal((await Effect.runPromise(signalStore.poll("%2", 0))).signal, undefined);
		signalStore.commit = commit;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("raw delivery failures before or during paste never create committed wakeups", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	try {
		const reserveAdapter = new FakeTerminalAdapter();
		const reserveWorkspace = new Workspace(reserveAdapter, { signalStoreRoot: directory });
		const reserveStore = (reserveWorkspace as unknown as { signalStore: SignalStore }).signalStore;
		reserveStore.reserve = () => Effect.fail(environmentError("reserve signal", "reservation failed"));
		await assert.rejects(Effect.runPromise(reserveWorkspace.execute({ action: "send", request: { targetId: "%2", input: "prompt", text: "never pasted" } }, process.cwd())), /reservation failed/);
		assert.deepEqual(reserveAdapter.sent, []);

		const pasteAdapter = new FakeTerminalAdapter();
		pasteAdapter.send = () => Effect.fail(environmentError("paste input", "paste failed"));
		const pasteWorkspace = new Workspace(pasteAdapter, { signalStoreRoot: directory });
		await assert.rejects(Effect.runPromise(pasteWorkspace.execute({ action: "send", request: { targetId: "%3", input: "prompt", text: "attempted once" } }, process.cwd())), /delivery_uncertain/);
		const pasteStore = (pasteWorkspace as unknown as { signalStore: SignalStore }).signalStore;
		assert.equal((await Effect.runPromise(pasteStore.poll("%3", 0))).signal, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("raw delivery cancellation before and after paste begins never commits a wakeup", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	try {
		const beforeAdapter = new FakeTerminalAdapter();
		const beforeWorkspace = new Workspace(beforeAdapter, { signalStoreRoot: directory });
		const beforeStore = (beforeWorkspace as unknown as { signalStore: SignalStore }).signalStore;
		const reserve = beforeStore.reserve.bind(beforeStore);
		beforeStore.reserve = (paneId, sourcePaneId, deliveryId) => Effect.sleep(1_000).pipe(Effect.flatMap(() => reserve(paneId, sourcePaneId, deliveryId)));
		const beforeController = new AbortController();
		const before = Effect.runPromise(beforeWorkspace.execute({ action: "send", request: { targetId: "%2", input: "prompt", text: "cancel before" } }, process.cwd()), { signal: beforeController.signal });
		beforeController.abort();
		await assert.rejects(before);
		assert.deepEqual(beforeAdapter.sent, []);

		const afterAdapter = new FakeTerminalAdapter();
		let pasteStarted = false;
		afterAdapter.send = () => Effect.sync(() => { pasteStarted = true; }).pipe(Effect.flatMap(() => Effect.never));
		const afterWorkspace = new Workspace(afterAdapter, { signalStoreRoot: directory });
		const afterController = new AbortController();
		const after = Effect.runPromise(afterWorkspace.execute({ action: "send", request: { targetId: "%3", input: "prompt", text: "cancel after" } }, process.cwd()), { signal: afterController.signal });
		for (let attempt = 0; attempt < 50 && !pasteStarted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(pasteStarted, true);
		afterController.abort();
		await assert.rejects(after);
		const afterStore = (afterWorkspace as unknown as { signalStore: SignalStore }).signalStore;
		assert.equal((await Effect.runPromise(afterStore.poll("%3", 0))).signal, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace wait observes only sends delivered to the selected inbox and reports their source", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const main = new Workspace(new FakeTerminalAdapter(target({ paneId: "%1" })), { signalStoreRoot: directory, waitPollMs: 5 });
	const workerAdapter = new FakeTerminalAdapter(target({ paneId: "%2" }));
	const worker = new Workspace(workerAdapter, { signalStoreRoot: directory, waitPollMs: 5 });
	try {
		const taskDelivery = await Effect.runPromise(main.execute({
			action: "send",
			request: { targetId: "%2", input: "prompt", text: "scan" },
		}, process.cwd()));
		assert.equal(taskDelivery.action, "send");
		if (taskDelivery.action !== "send") return;
		assert.equal(taskDelivery.sourcePaneId, "%1");
		if (!("replyAfterSequence" in taskDelivery)) return;
		assert.equal(taskDelivery.replyAfterSequence, 0);

		const waiting = Effect.runPromise(main.execute({
			action: "wait",
			request: { targetId: "%1", afterSequence: taskDelivery.replyAfterSequence, timeoutMs: 150 },
		}, process.cwd()));

		await Effect.runPromise(worker.execute({
			action: "send",
			request: { targetId: "%3", input: "prompt", text: "not for main" },
		}, process.cwd()));
		const unrelatedDelivery = await Promise.race([
			waiting.then(() => "settled" as const),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
		]);
		assert.equal(unrelatedDelivery, "pending", "a send to another pane must not wake the main pane");

		await Effect.runPromise(worker.execute({
			action: "send",
			request: { targetId: "%1", input: "prompt", text: "scan complete" },
		}, process.cwd()));
		const waited = await waiting;
		assert.equal(waited.action, "wait");
		if (waited.action === "wait") {
			assert.equal(waited.reason, "signaled");
			if (waited.reason === "signaled") assert.equal(waited.sourcePaneId, "%2");
			assert.equal(waited.target.paneId, "%1");
			assert.equal(waited.sequence, 1);
		}

		const nextTask = await Effect.runPromise(main.execute({
			action: "send",
			request: { targetId: "%2", input: "prompt", text: "scan again" },
		}, process.cwd()));
		assert.equal(nextTask.action, "send");
		if (nextTask.action === "send" && "replyAfterSequence" in nextTask) assert.equal(nextTask.replyAfterSequence, 1);
		assert.deepEqual(workerAdapter.sent, ["not for main", "scan complete"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace run waits for bounded Pi readiness instead of assuming startup", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-coordination-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	const workspace = new Workspace(adapter, {
		signalStoreRoot: directory,
		coordinationRoot: directory,
		agentExecutables: { pi: process.execPath },
		readinessTimeoutMs: 20,
	});
	try {
		const result = await Effect.runPromise(workspace.execute({
			action: "run",
			request: { targetId: "%2" },
		}, process.cwd()));
		assert.equal(result.action, "run");
		assert.ok(adapter.launchedAt !== undefined);
		assert.ok(Date.now() - adapter.launchedAt >= 15, "run must wait for its readiness deadline");
		if (result.action === "run") assert.equal(result.readiness, "process_started");
	} finally {
		if (adapter.lastLauncherPath) await rm(adapter.lastLauncherPath, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace run refuses to replace the calling pane", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-coordination-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	const workspace = new Workspace(adapter, {
		coordinationRoot: directory,
		agentExecutables: { pi: process.execPath },
	});
	try {
		await assert.rejects(
			Effect.runPromise(workspace.execute({ action: "run", request: { targetId: "%1", replace: true } }, process.cwd())),
			/Refusing to replace the calling pane %1/,
		);
		assert.equal(adapter.launchedAt, undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed runs roll back windows spawned by that invocation", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	adapter.launchFails = true;
	const workspace = new Workspace(adapter, {
		signalStoreRoot: directory,
		coordinationRoot: directory,
		agentExecutables: { pi: process.execPath },
	});
	try {
		await assert.rejects(
			Effect.runPromise(workspace.execute({ action: "run", request: {} }, process.cwd())),
			/launch failed/,
		);
		assert.equal(adapter.lastReplace, true, "a window spawned by run is safe to replace");
		assert.equal(adapter.closedWindows, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace wait ends only for an inbox signal or its finite timeout", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	try {
		const strictTimeoutWorkspace = new Workspace(adapter, { signalStoreRoot: directory, waitPollMs: 100 });
		const timeoutStarted = Date.now();
		const timeout = await Effect.runPromise(strictTimeoutWorkspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 5 } }, process.cwd()));
		assert.equal(timeout.action, "wait");
		if (timeout.action === "wait") {
			assert.equal(timeout.reason, "timeout");
			assert.equal(timeout.target.paneId, "%1");
		}
		assert.ok(Date.now() - timeoutStarted < 75, "wait should not sleep for the full poll interval after its deadline");

		const workspace = new Workspace(adapter, { signalStoreRoot: directory, waitPollMs: 5 });
		const workerExitDoesNotComplete = Effect.runPromise(workspace.execute({
			action: "wait",
			request: { targetId: "%1", timeoutMs: 30 },
		}, process.cwd()));
		setTimeout(() => { adapter.dead = true; }, 5);
		const afterWorkerExit = await workerExitDoesNotComplete;
		assert.equal(afterWorkerExit.action, "wait");
		if (afterWorkerExit.action === "wait") assert.equal(afterWorkerExit.reason, "timeout");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the extension registers workspace only after validated tmux detection", async () => {
	type SessionStart = (event: unknown, ctx: { readonly cwd: string; readonly hasUI: boolean }) => Promise<void>;
	interface RegisteredTool {
		readonly name: string;
		readonly executionMode?: string;
		readonly description: string;
		readonly promptGuidelines?: readonly string[];
		readonly renderCall?: unknown;
		readonly renderResult?: unknown;
	}
	const makeHarness = () => {
		let sessionStart: SessionStart | undefined;
		const tools: RegisteredTool[] = [];
		const pi = {
			on(event: string, handler: unknown) { if (event === "session_start") sessionStart = handler as SessionStart; },
			registerTool(tool: RegisteredTool) { tools.push(tool); },
		} as unknown as ExtensionAPI;
		return { pi, tools, start: () => sessionStart!({}, { cwd: process.cwd(), hasUI: false }) };
	};

	const outside = makeHarness();
	terminalEnvironment(outside.pi, { environment: { PATH: "/bin" } });
	await outside.start();
	assert.deepEqual(outside.tools, []);

	const runner = new FakeTmuxRunner();
	const inside = makeHarness();
	terminalEnvironment(inside.pi, {
		environment: { TMUX: `${socketPath},1,0`, TMUX_PANE: "%1", PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	});
	await inside.start();
	assert.deepEqual(inside.tools.map((tool) => tool.name), ["workspace"]);
	assert.equal(inside.tools[0]?.executionMode, "sequential");
	assert.match(inside.tools[0]!.description, /fresh Pi agent with no initial prompt/);
	assert.match(inside.tools[0]!.description, /Wait listens on the target inbox/);
	assert.match(inside.tools[0]!.description, /sessions cannot be closed/);
	assert.ok(inside.tools[0]!.promptGuidelines?.some((guideline) => /worker should not call workspace wait/.test(guideline)));
	assert.ok(inside.tools[0]!.promptGuidelines?.some((guideline) => /wait with targetId %1/.test(guideline)));
	assert.ok(inside.tools[0]!.promptGuidelines?.some((guideline) => /wait on %1 times out.*wait again/.test(guideline)));
	assert.equal(typeof inside.tools[0]?.renderCall, "function");
	assert.equal(typeof inside.tools[0]?.renderResult, "function");
});
