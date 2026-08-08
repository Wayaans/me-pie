import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
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
	failCommand: string | undefined;

	async run(executable: string, args: readonly string[], _options?: CommandOptions): Promise<CommandResult> {
		this.calls.push({ executable, args: [...args] });
		const commandIndex = args[0] === "-S" ? 2 : 0;
		const command = args[commandIndex];
		if (command === this.failCommand) return { stdout: "", stderr: `${command} failed`, code: 1 };
		if (command === "display-message") return { stdout: record(this.resolved), stderr: "", code: 0 };
		if (command === "new-window") {
			return { stdout: record(target({ windowId: "@2", windowName: "worker", paneId: "%2" })), stderr: "", code: 0 };
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
	readonly currentTarget = target();
	alive = true;
	dead = false;
	launchFails = false;
	lastReplace: boolean | undefined;
	closedWindows = 0;
	readonly sent: string[] = [];

	spawn(_request: SpawnRequest, _defaultCwd: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		return Effect.succeed(this.currentTarget);
	}
	resolve(_targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		return this.alive
			? Effect.succeed({ ...this.currentTarget, dead: this.dead })
			: Effect.fail(environmentError("resolve tmux target", "can't find pane: %1"));
	}
	launch(_target: TerminalTarget, _launcherPath: string, _cwd: string, replace: boolean, _ownedByOperation: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		this.lastReplace = replace;
		return this.launchFails ? Effect.fail(environmentError("launch coding agent", "launch failed")) : Effect.void;
	}
	closeSpawnedWindow(_target: TerminalTarget): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.closedWindows += 1; });
	}
	send(_target: TerminalTarget, text: string, _submit: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		return Effect.sync(() => { this.sent.push(text); });
	}
}

test("workspace parameters require exactly one payload matching the action", () => {
	assert.deepEqual(normalizeWorkspaceParameters({ action: "spawn", spawn: {} }), { action: "spawn", request: {} });
	assert.throws(
		() => normalizeWorkspaceParameters({ action: "spawn", run: {} }),
		/requires exactly one matching spawn payload/,
	);
});

test("coding-agent adapters map model and thinking without shell command strings", () => {
	assert.deepEqual(buildAgentInvocation({ agent: "pi", model: "openai/gpt", thinking: "high", prompt: "do it" }).args,
		["--model", "openai/gpt", "--thinking", "high", "do it"]);
	assert.deepEqual(buildAgentInvocation({ agent: "codex", thinking: "xhigh" }).args,
		["-c", "model_reasoning_effort=\"xhigh\""]);
	assert.deepEqual(buildAgentInvocation({ agent: "claude", thinking: "max" }).args,
		["--effort", "max"]);
	assert.deepEqual(buildAgentInvocation({ agent: "opencode", thinking: "minimal", prompt: "review" }).args,
		["--variant", "minimal", "--prompt", "review"]);
	assert.deepEqual(buildAgentInvocation({ agent: "claude", prompt: "--dangerously-skip-permissions" }).args,
		["--", "--dangerously-skip-permissions"]);
	assert.throws(() => buildAgentInvocation({ agent: "pi", prompt: "--version" }), /cannot safely accept/);
	assert.throws(() => buildAgentInvocation({ agent: "pi", prompt: "@\/etc\/passwd" }), /cannot safely accept/);
	assert.throws(() => buildAgentInvocation({ agent: "claude", thinking: "minimal" }), /does not support/);
	assert.throws(() => buildAgentInvocation({ agent: "codex", extraArgs: ["--model", "other"] }), /cannot override/);
	assert.throws(() => buildAgentInvocation({ agent: "codex", extraArgs: ["-c", "model=other"] }), /cannot override/);
	assert.throws(() => buildAgentInvocation({ agent: "codex", extraArgs: ["-mother"] }), /cannot override/);
});

test("tmux detection, spawning, and literal multiline delivery use the current server", async () => {
	const runner = new FakeTmuxRunner();
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, PATH: "/bin" },
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
	assert.ok(runner.calls.some((call) => call.args.includes("paste-buffer") && call.args.includes("%1")));
	assert.ok(runner.calls.some((call) => call.args.includes("send-keys") && call.args.at(-1) === "Enter"));
	assert.ok(runner.calls.filter((call) => call.args[0] === "-S").every((call) => call.args[1] === socketPath));
});

test("tmux rolls back a pane when post-spawn title setup fails", async () => {
	const runner = new FakeTmuxRunner();
	runner.failCommand = "select-pane";
	const adapter = await Effect.runPromise(TmuxAdapter.detect({
		environment: { TMUX: `${socketPath},1,0`, PATH: "/bin" },
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
		environment: { TMUX: `${socketPath},1,0`, PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	}));
	assert.ok(adapter);
	await assert.rejects(Effect.runPromise(adapter.launch(runner.resolved, "/tmp/launch.sh", process.cwd(), false, false)), /busy with node/);
	await Effect.runPromise(adapter.launch(runner.resolved, "/tmp/launch.sh", process.cwd(), true, false));
	assert.ok(runner.calls.some((call) => call.args.includes("respawn-pane") && call.args.includes("-k")));
});

test("signal store serializes concurrent send sequences", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const store = new SignalStore(`${socketPath}:4822`, { rootDirectory: directory });
	try {
		const sequences = await Effect.runPromise(Effect.all(
			Array.from({ length: 20 }, () => store.signal("%1")),
			{ concurrency: "unbounded" },
		));
		assert.deepEqual([...sequences].sort((left, right) => left - right), Array.from({ length: 20 }, (_, index) => index + 1));
		assert.equal(await Effect.runPromise(store.currentSequence("%1")), 20);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("workspace wait returns when a successful send advances the target sequence", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	const workspace = new Workspace(adapter, { signalStoreRoot: directory, waitPollMs: 5 });
	try {
		const waiting = Effect.runPromise(workspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 1_000 } }, process.cwd()));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const sent = await Effect.runPromise(workspace.execute({ action: "send", request: { targetId: "%1", input: "prompt", text: "hello" } }, process.cwd()));
		const waited = await waiting;
		assert.equal(sent.action, "send");
		assert.equal(waited.action, "wait");
		if (sent.action === "send" && waited.action === "wait") {
			assert.equal(waited.reason, "signaled");
			assert.equal(waited.sequence, sent.sequence);
		}
		assert.deepEqual(adapter.sent, ["hello"]);
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

test("workspace wait has finite timeout and notices dead or vanished targets", async () => {
	const directory = path.join(os.tmpdir(), `mepie-terminal-signals-${crypto.randomUUID()}`);
	const adapter = new FakeTerminalAdapter();
	const workspace = new Workspace(adapter, { signalStoreRoot: directory, waitPollMs: 5 });
	try {
		const strictTimeoutWorkspace = new Workspace(adapter, { signalStoreRoot: directory, waitPollMs: 100 });
		const timeoutStarted = Date.now();
		const timeout = await Effect.runPromise(strictTimeoutWorkspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 5 } }, process.cwd()));
		assert.equal(timeout.action, "wait");
		if (timeout.action === "wait") assert.equal(timeout.reason, "timeout");
		assert.ok(Date.now() - timeoutStarted < 75, "wait should not sleep for the full poll interval after its deadline");

		adapter.dead = true;
		const alreadyDead = await Effect.runPromise(workspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 1 } }, process.cwd()));
		assert.equal(alreadyDead.action, "wait");
		if (alreadyDead.action === "wait") assert.equal(alreadyDead.reason, "target-exited");
		adapter.dead = false;

		const deadWait = Effect.runPromise(workspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 1_000 } }, process.cwd()));
		setTimeout(() => { adapter.dead = true; }, 10);
		const dead = await deadWait;
		assert.equal(dead.action, "wait");
		if (dead.action === "wait") assert.equal(dead.reason, "target-exited");

		adapter.dead = false;
		const vanishedWait = Effect.runPromise(workspace.execute({ action: "wait", request: { targetId: "%1", timeoutMs: 1_000 } }, process.cwd()));
		setTimeout(() => { adapter.alive = false; }, 10);
		const vanished = await vanishedWait;
		assert.equal(vanished.action, "wait");
		if (vanished.action === "wait") assert.equal(vanished.reason, "target-exited");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("the extension registers workspace only after validated tmux detection", async () => {
	type SessionStart = (event: unknown, ctx: { readonly cwd: string; readonly hasUI: boolean }) => Promise<void>;
	interface RegisteredTool {
		readonly name: string;
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
		environment: { TMUX: `${socketPath},1,0`, PATH: "/bin" },
		runner,
		tmuxExecutable: "/fake/tmux",
	});
	await inside.start();
	assert.deepEqual(inside.tools.map((tool) => tool.name), ["workspace"]);
	assert.equal(typeof inside.tools[0]?.renderCall, "function");
	assert.equal(typeof inside.tools[0]?.renderResult, "function");
});
