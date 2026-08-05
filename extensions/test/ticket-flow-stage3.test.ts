import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
	buildLauncherScript,
	buildPiArguments,
	buildWorkerEnvironment,
	quotePosixArgument,
	workflowRuntimeDirectory,
	writeOwnerOnlyLauncher,
} from "../ticket-flow/tmux/command.ts";
import { parseCreatedWindow, sanitizeWindowName, TmuxController } from "../ticket-flow/tmux/controller.ts";
import type { TmuxCommandResult, TmuxCommandRunner } from "../ticket-flow/tmux/types.ts";
import { prepareWorkerLifecycle, readWorkerEnvironment } from "../ticket-flow/worker/lifecycle.ts";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { WorkflowPlan, WorkItem } from "../ticket-flow/domain.ts";

function result(stdout = "", code = 0, stderr = ""): TmuxCommandResult {
	return { stdout, stderr, code };
}

function queuedRunner(responses: TmuxCommandResult[]) {
	const calls: Array<{ executable: string; args: readonly string[] }> = [];
	const runner: TmuxCommandRunner = {
		async run(executable, args) {
			calls.push({ executable, args });
			const response = responses.shift();
			if (!response) throw new Error(`Unexpected command: ${args.join(" ")}`);
			return response;
		},
	};
	return { runner, calls };
}

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };

function workerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		MEPIE_WORKFLOW_ROLE: "worker",
		MEPIE_WORKFLOW_RUN_ID: "run-1",
		MEPIE_WORKFLOW_ITEM_ID: "auth",
		MEPIE_WORKFLOW_REQUESTED_MODEL: profile.model,
		MEPIE_WORKFLOW_REQUESTED_THINKING: profile.thinking,
		MEPIE_WORKFLOW_SOCKET: "/tmp/mepie-ticket-flow/run-1.sock",
		MEPIE_WORKFLOW_TOKEN: "owner-only-token",
		...overrides,
	};
}

function item(): WorkItem {
	return {
		id: "auth",
		title: "Authentication",
		sourcePaths: ["ticket.md"],
		specificationPaths: ["spec.md"],
		requirements: ["Start worker"],
		order: 3,
		orderReason: "Dependencies are complete",
		dependsOn: [],
		delegationPrompt: "/implement secret delegation text",
		launchProfile: profile,
		completionStrategy: { type: "ledger-only" },
		status: "planned",
	};
}

function plan(): WorkflowPlan {
	return { summary: "Stage 3", auditProfile: profile, workItems: [item()], userResolutions: [], finalized: false };
}

test("tmux format parsing and display-name sanitization are deterministic", () => {
	assert.deepEqual(parseCreatedWindow("/tmp/tmux.sock\t$14\tmain session\t@31\t%42\n"), {
		serverSocketPath: "/tmp/tmux.sock",
		sessionId: "$14",
		sessionName: "main session",
		windowId: "@31",
		paneId: "%42",
	});
	assert.equal(parseCreatedWindow("main:@31:%42"), undefined);
	assert.equal(sanitizeWindowName(3, " Auth / unsafe ; $(x) "), "tf-03-auth-unsafe-x");
	assert.ok(sanitizeWindowName(123, "a".repeat(100)).length <= 48);
});

test("Pi launch data contains exact profile and secrets only in an owner launcher environment", () => {
	const args = buildPiArguments(profile, "/repo with ' quote");
	assert.deepEqual(args, ["--model", profile.model, "--thinking", "high", "--extension", "/repo with ' quote"]);
	const environment = buildWorkerEnvironment({
		runId: "run-1",
		workItemId: "auth",
		profile,
		socketPath: "/tmp/workflow.sock",
		token: "secret-token",
	});
	assert.deepEqual(environment, workerEnvironment({ MEPIE_WORKFLOW_SOCKET: "/tmp/workflow.sock", MEPIE_WORKFLOW_TOKEN: "secret-token" }));
	const launcher = buildLauncherScript("/bin/pi", args, environment);
	assert.match(launcher, /export MEPIE_WORKFLOW_TOKEN='secret-token'/);
	assert.match(launcher, /exec '\/bin\/pi' '--model' 'openai-codex\/gpt-5\.6-sol' '--thinking' 'high'/);
	assert.ok(!launcher.includes("/implement secret delegation text"));
	assert.equal(quotePosixArgument("a'b"), "'a'\"'\"'b'");
});

test("owner-only launchers use executable 0700 permissions", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-launcher-"));
	const launcher = await writeOwnerOnlyLauncher(directory, "#!/bin/sh\nexit 0\n");
	assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
	assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);
	fs.rmSync(directory, { recursive: true, force: true });
});

test("tmux detection rejects missing clients, timeouts, vanished sessions, and malformed format output", async () => {
	const never = queuedRunner([]);
	await assert.rejects(Effect.runPromise(new TmuxController({
		runner: never.runner,
		environment: {},
		tmuxExecutable: "/bin/tmux",
	}).detect()), (error: unknown) => (error as { _tag?: string })._tag === "MissingTmuxError");

	const timeout = queuedRunner([{ ...result(), timedOut: true }]);
	await assert.rejects(Effect.runPromise(new TmuxController({
		runner: timeout.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
	}).detect()), (error: unknown) => (error as { _tag?: string })._tag === "TmuxCommandTimeoutError");

	const vanished = queuedRunner([result("tmux 3.7\n"), result("", 1, "can't find session")]);
	await assert.rejects(Effect.runPromise(new TmuxController({
		runner: vanished.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
	}).detect()), (error: unknown) => (error as { _tag?: string })._tag === "VanishedTmuxSessionError");

	const malformed = queuedRunner([result("tmux 3.7\n"), result("not-machine-output\n")]);
	await assert.rejects(Effect.runPromise(new TmuxController({
		runner: malformed.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
	}).detect()), (error: unknown) => (error as { _tag?: string })._tag === "UnexpectedTmuxOutputError");
});

test("window creation returns stable IDs, tags ownership, and never puts delegation or token in tmux commands", async () => {
	const fake = queuedRunner([
		result("tmux 3.7\n"),
		result("/tmp/tmux.sock\t$14\tmain\t%1\n"),
		result("/tmp/tmux.sock\t$14\tmain\t@31\t%42\n"),
		result(),
		result(),
		result("/tmp/tmux.sock\t$14\t@31\t%42\t0\trun-stage3-test\tauth\n"),
	]);
	const tmux = new TmuxController({
		runner: fake.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		piExecutable: "/bin/pi",
		packageRoot: "/repo",
	});
	const handle = await Effect.runPromise(tmux.createWorkerWindow({
		runId: "run-stage3-test",
		workItemId: "auth",
		title: "Authentication",
		order: 3,
		cwd: "/repo",
		profile,
		socketPath: "/tmp/workflow.sock",
		token: "secret-token",
	}));
	assert.deepEqual(handle, {
		runId: "run-stage3-test",
		workItemId: "auth",
		serverSocketPath: "/tmp/tmux.sock",
		sessionId: "$14",
		sessionName: "main",
		windowId: "@31",
		paneId: "%42",
		displayName: "tf-03-auth",
		socketPath: "/tmp/workflow.sock",
	});
	const commands = fake.calls.map((call) => call.args.join(" ")).join("\n");
	assert.ok(!commands.includes("secret-token"));
	assert.ok(!commands.includes("/implement"));
	assert.deepEqual(fake.calls.filter((call) => call.args[0] === "set-option").map((call) => call.args.at(-2)), [
		"@mepie_workflow_run_id",
		"@mepie_workflow_item_id",
	]);
	fs.rmSync(workflowRuntimeDirectory("run-stage3-test"), { recursive: true, force: true });
});

test("an exited startup pane is observed, rejected, and cleaned up", async () => {
	const fake = queuedRunner([
		result("tmux 3.7\n"),
		result("/tmp/tmux.sock\t$14\tmain\t%1\n"),
		result("/tmp/tmux.sock\t$14\tmain\t@31\t%42\n"),
		result(), result(),
		result("/tmp/tmux.sock\t$14\t@31\t%42\t1\trun-dead\tauth\n"),
		result(),
	]);
	const tmux = new TmuxController({
		runner: fake.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		piExecutable: "/bin/pi",
		packageRoot: "/repo",
	});
	await assert.rejects(Effect.runPromise(tmux.createWorkerWindow({
		runId: "run-dead", workItemId: "auth", title: "Authentication", order: 3, cwd: "/repo",
		profile, socketPath: "/tmp/workflow.sock", token: "secret-token",
	})), (error: unknown) => (error as { _tag?: string })._tag === "WorkerLaunchError");
	assert.equal(fake.calls.at(-1)?.args[0], "kill-window");
	fs.rmSync(workflowRuntimeDirectory("run-dead"), { recursive: true, force: true });
});

test("malformed new-window output cleans the uniquely identified unpersisted window", async () => {
	const calls: string[][] = [];
	let launcherCommand = "";
	const runner: TmuxCommandRunner = {
		async run(_executable, args) {
			calls.push([...args]);
			switch (args[0]) {
				case "-V": return result("tmux 3.7\n");
				case "display-message": return result("/tmp/tmux.sock\t$14\tmain\t%1\n");
				case "new-window":
					launcherCommand = args.at(-1) ?? "";
					return result("malformed\n");
				case "list-panes": return result(`/tmp/tmux.sock\t$14\t@31\t%42\t${launcherCommand}\n`);
				case "kill-window": return result();
				default: throw new Error(`Unexpected command: ${args.join(" ")}`);
			}
		},
	};
	const tmux = new TmuxController({
		runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		piExecutable: "/bin/pi",
		packageRoot: "/repo",
	});
	await assert.rejects(Effect.runPromise(tmux.createWorkerWindow({
		runId: "run-malformed",
		workItemId: "auth",
		title: "Authentication",
		order: 3,
		cwd: "/repo",
		profile,
		socketPath: "/tmp/workflow.sock",
		token: "secret-token",
	})), (error: unknown) => (error as { _tag?: string })._tag === "UnexpectedTmuxOutputError");
	assert.equal(calls.at(-1)?.[0], "kill-window");
	assert.equal(calls.at(-1)?.at(-1), "@31");
	fs.rmSync(workflowRuntimeDirectory("run-malformed"), { recursive: true, force: true });
});

const owned = "/tmp/tmux.sock\t$14\t@31\t%42\t0\trun-1\tauth\n";
const handle = {
	runId: "run-1",
	workItemId: "auth",
	serverSocketPath: "/tmp/tmux.sock",
	sessionId: "$14",
	sessionName: "main",
	windowId: "@31",
	paneId: "%42",
	displayName: "tf-03-auth",
	socketPath: "/tmp/workflow.sock",
};

test("close rejects foreign handles before destructive commands", async () => {
	const fake = queuedRunner([result("/tmp/tmux.sock\t$14\t@31\t%42\t0\tforeign\tauth\n")]);
	const tmux = new TmuxController({ runner: fake.runner, environment: { TMUX: "present" }, tmuxExecutable: "/bin/tmux" });
	await assert.rejects(Effect.runPromise(tmux.closeWindow(handle, true)), (error: unknown) => (error as { _tag?: string })._tag === "ForeignTmuxHandleError");
	assert.equal(fake.calls.some((call) => call.args[0] === "kill-window"), false);
});

test("close rejects a stale pane identity before destructive commands", async () => {
	const fake = queuedRunner([result("/tmp/tmux.sock\t$14\t@31\t%99\t0\trun-1\tauth\n")]);
	const tmux = new TmuxController({ runner: fake.runner, environment: { TMUX: "present" }, tmuxExecutable: "/bin/tmux" });
	await assert.rejects(Effect.runPromise(tmux.closeWindow(handle, true)), (error: unknown) => (error as { _tag?: string })._tag === "ForeignTmuxHandleError");
	assert.equal(fake.calls.some((call) => call.args[0] === "kill-window"), false);
});

test("close uses graceful exit first and force-kills only after its bounded wait", async () => {
	const graceful = queuedRunner([result(owned), result(), result("", 1, "pane gone")]);
	const gracefulController = new TmuxController({
		runner: graceful.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		sleep: async () => undefined,
	});
	assert.deepEqual(await Effect.runPromise(gracefulController.closeWindow(handle)), { forced: false, alreadyExited: false });
	assert.equal(graceful.calls.some((call) => call.args[0] === "kill-window"), false);

	const forced = queuedRunner([result(owned), result(), result(owned), result()]);
	const forcedController = new TmuxController({
		runner: forced.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		closeTimeoutMs: 0,
	});
	assert.deepEqual(await Effect.runPromise(forcedController.closeWindow(handle)), { forced: true, alreadyExited: false });
	assert.equal(forced.calls.at(-1)?.args[0], "kill-window");
	assert.equal(forced.calls.at(-1)?.args.at(-1), "@31");
});

test("worker environment validation is complete and lifecycle shutdown is idempotent", async () => {
	assert.deepEqual(readWorkerEnvironment(workerEnvironment()), {
		runId: "run-1",
		workItemId: "auth",
		requestedProfile: profile,
		socketPath: "/tmp/mepie-ticket-flow/run-1.sock",
		token: "owner-only-token",
	});
	for (const variable of [
		"MEPIE_WORKFLOW_RUN_ID",
		"MEPIE_WORKFLOW_ITEM_ID",
		"MEPIE_WORKFLOW_REQUESTED_MODEL",
		"MEPIE_WORKFLOW_REQUESTED_THINKING",
		"MEPIE_WORKFLOW_SOCKET",
		"MEPIE_WORKFLOW_TOKEN",
	]) {
		const environment = workerEnvironment();
		delete environment[variable];
		assert.throws(() => readWorkerEnvironment(environment), (error: unknown) => (error as { variable?: string }).variable === variable);
	}
	assert.throws(() => readWorkerEnvironment(workerEnvironment({ MEPIE_WORKFLOW_SOCKET: "relative.sock" })), /must be absolute/);
	assert.throws(() => readWorkerEnvironment(workerEnvironment({ MEPIE_WORKFLOW_REQUESTED_THINKING: "extreme" })), /Unsupported/);
	const lifecycle = await Effect.runPromise(prepareWorkerLifecycle(workerEnvironment()));
	await Effect.runPromise(lifecycle.start());
	assert.equal(lifecycle.isStarted, true);
	await Effect.runPromise(lifecycle.shutdown());
	await Effect.runPromise(lifecycle.shutdown());
	assert.equal(lifecycle.isReleased, true);
});

test("workflow controller persists requested profile and returned tmux IDs exactly once", async () => {
	const fake = queuedRunner([
		result("tmux 3.7\n"), result("/tmp/tmux.sock\t$14\tmain\t%1\n"), result("/tmp/tmux.sock\t$14\tmain\t@31\t%42\n"), result(), result(), result(owned),
		result(owned), result(), result("", 1, "pane gone"),
	]);
	const tmux = new TmuxController({
		runner: fake.runner,
		environment: { TMUX: "present" },
		tmuxExecutable: "/bin/tmux",
		piExecutable: "/bin/pi",
		packageRoot: "/repo",
		sleep: async () => undefined,
	});
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage3-project-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage3-agent-"));
	let tools = ["read", "bash"];
	const controller = new WorkflowController({
		getActiveTools: () => [...tools],
		setActiveTools: (names) => { tools = [...names]; },
	}, () => new Date("2026-01-01T00:00:00.000Z"), () => "run-1", tmux);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "stage 3", agentDir }));
	await Effect.runPromise(controller.savePlan(plan()));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("auth"));
	assert.equal(started.phase, "executing");
	assert.deepEqual(started.requestedLaunchProfile, profile);
	assert.equal(started.tmux?.windowId, "@31");
	assert.equal(started.plan.workItems[0]?.status, "verifying-worker");
	const retried = await Effect.runPromise(controller.startWorker("auth"));
	assert.equal(retried.tmux?.windowId, "@31");
	assert.equal(fake.calls.filter((call) => call.args[0] === "new-window").length, 1);
	await Effect.runPromise(controller.closeWorker("auth"));
	await Effect.runPromise(controller.stop());
	fs.rmSync(workflowRuntimeDirectory("run-1"), { recursive: true, force: true });
});
