import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TmuxHandle, Ticket, TicketflowRun } from "../ticket-flow/model.ts";
import {
	TICKETFLOW_ASSIGNMENT_TAG,
	TICKETFLOW_OPERATION_TAG,
	TICKETFLOW_RUN_TAG,
	TmuxWorkerBackend,
	type TmuxCommandResult,
	type TmuxCommandRunner,
} from "../ticket-flow/backends/tmux.ts";
import { footerStatus, renderTicketflowWidget } from "../ticket-flow/widget.ts";

const socket = "/tmp/fake-tmux-server.sock";
const input = {
	cwd: "/project",
	runId: "run-1",
	assignmentId: "assignment-1",
	operationId: "operation-1",
	title: "Ticket Flow worker",
	profile: { model: "provider/model", thinking: "medium" as const },
	kind: "implementation" as const,
	socketPath: "/tmp/ticketflow-bridge.sock",
	token: "secret-token",
};

function inspection(runId = input.runId, assignmentId = input.assignmentId, operationId = input.operationId, paneDead = "0"): string {
	return `${socket}\t$0\tmain\t@1\t%1\t${paneDead}\t${runId}\t${assignmentId}\t${operationId}\n`;
}

class FakeTmuxRunner implements TmuxCommandRunner {
	readonly calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
	launcherPath: string | undefined;
	foreign = false;
	listOutput = "";
	async run(executable: string, args: readonly string[], _options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<TmuxCommandResult> {
		this.calls.push({ executable, args });
		const operation = args[0] === "-S" ? args[2] : args[0];
		if (operation === "display-message" && args.includes("-t") && args.some((value) => value.includes("#{window_name}")) && this.listOutput) return { stdout: this.listOutput, stderr: "", code: 0 };
		if (operation === "display-message" && args.includes("-t")) return { stdout: inspection(this.foreign ? "other-run" : undefined), stderr: "", code: 0 };
		if (operation === "display-message") return { stdout: `${socket}\t$0\tmain\t%0\n`, stderr: "", code: 0 };
		if (operation === "list-windows") return { stdout: this.listOutput, stderr: "", code: 0 };
		if (operation === "new-window") {
			this.launcherPath = args.at(-1);
			return { stdout: `${socket}\t$0\tmain\t@1\t%1\ttf-launch-operation-1\n`, stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "", code: 0 };
	}
}

test("tmux launcher is a pure owner-only script and worker ownership tags are all applied", async () => {
	const runner = new FakeTmuxRunner();
	const backend = new TmuxWorkerBackend({
		runner,
		environment: { TMUX: "1", PATH: "/bin" },
		tmuxExecutable: "/fake/tmux",
		piExecutable: "/fake/pi",
		packageRoot: "/package/root",
	});
	const handle = await backend.spawn(input);
	assert.equal(handle.backend, "tmux");
	assert.equal(handle.runId, input.runId);
	assert.equal(handle.assignmentId, input.assignmentId);
	assert.equal(handle.operationId, input.operationId);
	assert.deepEqual(
		runner.calls.filter((call) => call.args.includes("set-option")).map((call) => call.args.slice(-2)),
		[[TICKETFLOW_RUN_TAG, input.runId], [TICKETFLOW_ASSIGNMENT_TAG, input.assignmentId], [TICKETFLOW_OPERATION_TAG, input.operationId]],
	);
	assert.ok(runner.launcherPath);
	const launcher = await readFile(runner.launcherPath!, "utf8");
	assert.match(launcher, /^#!\/bin\/sh\nset -eu\n/);
	assert.match(launcher, /export TICKETFLOW_ROLE='worker'/);
	assert.match(launcher, /export TICKETFLOW_TOKEN='secret-token'/);
	assert.match(launcher, /exec '\/fake\/pi' '--model' 'provider\/model' '--thinking' 'medium' '--no-extensions' '-e' '\/package\/root' '--no-skills' '--no-prompt-templates'/);
	assert.doesNotMatch(launcher, /sh -c|eval/);
	await rm(path.dirname(runner.launcherPath!), { recursive: true, force: true });
});

test("launch recovery adopts and finishes tagging a crash-created partial window without duplicating it", async () => {
	const runner = new FakeTmuxRunner();
	runner.listOutput = `${socket}\t$0\tmain\t@1\t%1\ttf-launch-operation-1\t0\t${input.runId}\t\t\n`;
	const backend = new TmuxWorkerBackend({ runner, environment: { TMUX: "1", PATH: "/bin" }, tmuxExecutable: "/fake/tmux", piExecutable: "/fake/pi" });
	const handle = await backend.spawn(input);
	assert.equal(handle.windowId, "@1");
	assert.equal(runner.calls.some((call) => call.args.includes("new-window")), false, "durable launch intent must adopt rather than duplicate");
	assert.equal(runner.calls.filter((call) => call.args.includes("set-option")).length, 3);
});

test("tmux close refuses foreign ownership and only kills after an adjacent re-verification", async () => {
	const runner = new FakeTmuxRunner();
	const backend = new TmuxWorkerBackend({ runner, environment: { TMUX: "1", PATH: "/bin" }, tmuxExecutable: "/fake/tmux", piExecutable: "/fake/pi", closeTimeoutMs: 0 });
	const handle: TmuxHandle = {
		backend: "tmux", serverSocketPath: socket, sessionId: "$0", sessionName: "main", windowId: "@1", paneId: "%1",
		runId: input.runId, assignmentId: input.assignmentId, operationId: input.operationId, displayName: input.title,
	};
	runner.foreign = true;
	await assert.rejects(backend.close(handle), /tags|IDs|ownership/);
	assert.equal(runner.calls.some((call) => call.args.includes("kill-window")), false);
	assert.equal(runner.calls.some((call) => call.args.includes("send-keys")), false);

	runner.foreign = false;
	await backend.close(handle);
	assert.equal(runner.calls.some((call) => call.args.includes("send-keys")), true);
	assert.equal(runner.calls.filter((call) => call.args.includes("kill-window")).length, 1);
	assert.equal(runner.calls.filter((call) => call.args.includes("display-message") || call.args.includes("send-keys") || call.args.includes("kill-window")).every((call) => call.args[0] === "-S" && call.args[1] === socket), true);
});

function widgetRun(): TicketflowRun {
	const tickets: Ticket[] = [
		{ index: 0, order: 1, name: "1-界面修復-a-ticket-with-a-very-long-name.md", path: "/project/1.md", delegationPrompt: "prompt", status: "running", acceptedCommitIds: [] },
		{ index: 1, order: 2, name: "2-completed.md", path: "/project/2.md", delegationPrompt: "prompt", status: "completed", acceptedCommitIds: ["commit"] },
	];
	return {
		version: 1, revision: 1, id: "run-1", projectId: "project", projectPath: "/project", backend: "tmux", orchestratorSessionId: "main",
		phase: "implementation", setup: { ticketsDirectory: "/project/tickets", referencePaths: [], workerProfile: { model: "provider/a-very-long-model-name", thinking: "xhigh" }, delegationTemplate: "prompt", completionConvention: "all-markdown-checkboxes" },
		tickets, currentTicket: 0, worker: { id: "worker", handle: { backend: "tmux", serverSocketPath: socket, sessionId: "$0", sessionName: "main", windowId: "@1", paneId: "%1", runId: "run-1", assignmentId: "assignment", operationId: "operation", displayName: "worker" }, requestedProfile: { model: "provider/model", thinking: "medium" } },
		assignment: { id: "assignment", kind: "implementation", title: "ticket", prompt: "prompt", promptHash: "hash", promptSubstitutions: {}, ticketIndex: 0, attemptBaseCommit: "base", stage: "running", turn: 1, createdAt: "2026-01-01T00:00:00.000Z" },
		git: { baselineCommit: "base", branch: "main", acceptedCommitIds: ["commit"], acceptedHead: "commit" }, auditRounds: [], findings: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("Ticket Flow widget limits animation to active work and never exceeds the terminal width", () => {
	const run = widgetRun();
	for (let width = 0; width <= 120; width += 1) {
		for (const line of renderTicketflowWidget(run, width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
	}

	const firstFrame = renderTicketflowWidget(run, 100, { frame: 0 }).join("\n");
	const nextFrame = renderTicketflowWidget(run, 100, { frame: 1 }).join("\n");
	assert.match(firstFrame, /TICKET FLOW  RUNNING/);
	assert.match(firstFrame, /◆ Implementation  ·  Ticket 1 of 2/);
	assert.match(firstFrame, /Worker running · turn 1/);
	assert.doesNotMatch(firstFrame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (?:TICKET FLOW|Worker running)/);
	assert.match(firstFrame, /› ⠋ 1-界面/);
	assert.match(nextFrame, /› ⠙ 1-界面/);
	assert.match(firstFrame, /✓ 2-completed\.md/);
	assert.notEqual(firstFrame, nextFrame, "the active ticket indicator should advance between frames");
	assert.equal(footerStatus(run), "ticketflow · running · implementation 1/2");
});

test("Ticket Flow widget clearly distinguishes paused and pausing workflows", () => {
	const running = widgetRun();
	const { assignment: _assignment, worker: _worker, ...inactive } = running;
	const paused: TicketflowRun = {
		...inactive,
		phase: "paused",
		pause: { previousPhase: "implementation", reason: "user", message: "Ticket Flow is paused.", afterCurrentWorker: false },
	};
	const pausing: TicketflowRun = {
		...running,
		phase: "paused",
		pause: { previousPhase: "implementation", reason: "user", message: "Pausing after current worker.", afterCurrentWorker: true },
	};

	assert.match(renderTicketflowWidget(paused, 100).join("\n"), /⏸ TICKET FLOW  PAUSED/);
	assert.match(renderTicketflowWidget(paused, 100).join("\n"), /\/ticketflow resume/);
	assert.equal(footerStatus(paused), "ticketflow · paused · implementation 1/2");
	assert.match(renderTicketflowWidget(pausing, 100).join("\n"), /TICKET FLOW  PAUSING/);
	assert.equal(footerStatus(pausing), "ticketflow · pausing · implementation 1/2");

	const settled: TicketflowRun = { ...pausing, assignment: { ...pausing.assignment!, stage: "settled" } };
	assert.match(renderTicketflowWidget(settled, 100).join("\n"), /TICKET FLOW  PAUSED/);
	assert.equal(footerStatus(settled), "ticketflow · paused · implementation 1/2");
});

test("Ticket Flow widget removes terminal controls from persisted labels", () => {
	const run = widgetRun();
	const unsafe: TicketflowRun = {
		...run,
		setup: {
			...run.setup,
			workerProfile: { ...run.setup.workerProfile, model: "provider/model\u001b]0;owned\u0007" },
		},
		tickets: run.tickets.map((ticket, index) => index === 0
			? { ...ticket, name: "unsafe\nname\u001b[31m-red\u001b[0m" }
			: ticket),
	};
	const lines = renderTicketflowWidget(unsafe, 100);
	for (const line of lines) assert.doesNotMatch(line, /[\n\r\u001b]/);
	assert.match(lines.join("\n"), /unsafename-red/);
});
