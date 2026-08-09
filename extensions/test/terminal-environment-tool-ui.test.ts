import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { TerminalTarget, WorkspaceResult } from "../terminal-environment/model.ts";
import type { WorkspaceParameters } from "../terminal-environment/schema.ts";
import {
	renderWorkspaceCall,
	renderWorkspaceResult,
	runWithWorkspaceWaitProgress,
	type WorkspaceToolDetails,
} from "../terminal-environment/tool-ui.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const target: TerminalTarget = {
	environment: "tmux",
	sessionId: "$2",
	sessionName: "dev",
	windowId: "@7",
	windowName: "api",
	paneId: "%13",
	cwd: "/repo/services/auth",
	currentCommand: "zsh",
	dead: false,
};

function toolResult(details: WorkspaceToolDetails, text = "ok"): AgentToolResult<WorkspaceToolDetails> {
	return { content: [{ type: "text", text }], details };
}

function context(args: WorkspaceParameters, isError = false) {
	return { args, isError };
}

function rendered(component: Component, width = 100): string {
	return component.render(width).join("\n");
}

function resultOutput(
	args: WorkspaceParameters,
	details: WorkspaceToolDetails,
	options: { readonly expanded: boolean; readonly isPartial: boolean },
	isError = false,
	text = "ok",
	width = 100,
): string {
	return rendered(renderWorkspaceResult(toolResult(details, text), options, plainTheme as never, context(args, isError) as never), width);
}

initTheme();

test("workspace call rows distinguish actions, targets, agents, and send intent without noisy arguments", () => {
	for (const kind of ["session", "window", "pane"] as const) {
		const output = rendered(renderWorkspaceCall({ action: "spawn", spawn: { kind } }, plainTheme as never));
		assert.match(output, new RegExp(kind, "i"));
	}
	for (const agent of ["pi", "codex", "claude", "opencode"] as const) {
		const output = rendered(renderWorkspaceCall({
			action: "run",
			run: { targetId: "%13", agent, model: `${agent}-latest`, thinking: "high" },
		}, plainTheme as never));
		assert.match(output, new RegExp(agent, "i"));
		assert.match(output, /%13/);
		assert.match(output, /high/);
	}
	assert.match(rendered(renderWorkspaceCall({ action: "send", send: { targetId: "%13", input: "command", text: "pwd", submit: false } }, plainTheme as never)), /Command · %13 · paste only/);
	assert.match(rendered(renderWorkspaceCall({ action: "wait", wait: { targetId: "%13", afterSequence: 4 } }, plainTheme as never)), /Inbox · %13 · after 4/);
	assert.match(rendered(renderWorkspaceCall({ action: "close", close: { targetId: "%13" } }, plainTheme as never)), /Close · Pane · %13/);
});

test("spawn results stay compact until expanded", () => {
	const args: WorkspaceParameters = { action: "spawn", spawn: { kind: "pane" } };
	const details: WorkspaceResult = { action: "spawn", target };
	const collapsed = resultOutput(args, details, { expanded: false, isPartial: false });
	assert.match(collapsed, /✓ Pane ready · %13 · @7\/api · \$2\/dev/);
	assert.doesNotMatch(collapsed, /command zsh|cwd/);

	const expanded = resultOutput(args, details, { expanded: true, isPartial: false });
	assert.match(expanded, /pane %13 · window @7\/api/);
	assert.match(expanded, /session \$2\/dev/);
	assert.match(expanded, /cwd \/repo\/services\/auth/);
	assert.match(expanded, /command zsh · alive/);
});

test("run results distinguish created and existing targets and show only selected launch metadata", () => {
	for (const agent of ["pi", "codex", "claude", "opencode"] as const) {
		const args: WorkspaceParameters = {
			action: "run",
			run: { agent, model: `${agent}-latest`, thinking: "medium" },
		};
		const created = resultOutput(args, {
			action: "run",
			target: { ...target, currentCommand: agent },
			agent,
			runId: `4f6f0f37-6a7d-4d08-8a6e-1de9cc5a16f0`,
			executable: `/usr/local/bin/${agent}`,
			spawnedTarget: true,
		}, { expanded: true, isPartial: false });
		assert.match(created, new RegExp(`✓ ${agent[0]!.toUpperCase()}${agent.slice(1)} launched`));
		assert.match(created, /new target/);
		assert.match(created, new RegExp(`model ${agent}-latest · thinking medium`));
		assert.doesNotMatch(created, /\/usr\/local\/bin/);
	}

	const existing = resultOutput({ action: "run", run: { targetId: "%13", agent: "codex" } }, {
		action: "run", target, agent: "codex", runId: "4f6f0f37-6a7d-4d08-8a6e-1de9cc5a16f0", executable: "codex", spawnedTarget: false,
	}, { expanded: false, isPartial: false });
	assert.match(existing, /existing target/);
});

test("close results identify the exact target kind and preserve the pre-close snapshot", () => {
	for (const [kind, targetId] of [["pane", "%13"], ["window", "@7"]] as const) {
		const args: WorkspaceParameters = { action: "close", close: { targetId } };
		const details: WorkspaceResult = { action: "close", kind, target };
		const collapsed = resultOutput(args, details, { expanded: false, isPartial: false });
		assert.match(collapsed, new RegExp(`✓ ${kind[0]!.toUpperCase()}${kind.slice(1)} closed`));
		assert.match(collapsed, /%13 · @7\/api · \$2\/dev/);
		assert.doesNotMatch(collapsed, /before close/);

		const expanded = resultOutput(args, details, { expanded: true, isPartial: false });
		assert.ok(expanded.includes(`closed ${targetId}`));
		assert.match(expanded, /command zsh before close/);
	}
});

test("send results render Markdown previews, submission mode, and delivery sequence", () => {
	const markdown = "# Review auth\n\n- Keep **tests** green\n- Check `session.ts`";
	const promptArgs: WorkspaceParameters = { action: "send", send: { targetId: "%13", input: "prompt", text: markdown } };
	const promptResult: WorkspaceResult = {
		action: "send", target, sourcePaneId: "%5", deliveryId: "delivery-42", sequence: 42,
		replyAfterSequence: 7, bytes: 61, input: "prompt",
	};
	const collapsed = resultOutput(promptArgs, promptResult, { expanded: false, isPartial: false });
	assert.match(collapsed, /✓ Prompt sent · %5 → %13 · recipient sequence 42 · 61 B/);
	assert.match(collapsed, /# Review auth/);
	assert.doesNotMatch(collapsed, /Keep tests green/);

	const expanded = resultOutput(promptArgs, promptResult, { expanded: true, isPartial: false });
	assert.match(expanded, /Review auth/);
	assert.match(expanded, /Keep tests green/);
	assert.match(expanded, /wait on %5 for reply from %13 after sequence 7/);
	assert.match(expanded, /delivery delivery-42/);

	const pasted = resultOutput(
		{ action: "send", send: { targetId: "%13", input: "command", text: "bun test", submit: false } },
		{ action: "send", target, sourcePaneId: "%5", deliveryId: "delivery-43", sequence: 43, replyAfterSequence: 8, bytes: 8, input: "command" },
		{ expanded: false, isPartial: false },
	);
	assert.match(pasted, /✓ Command pasted · %5 → %13 · recipient sequence 43/);
});

test("managed task, result, and wait rows distinguish correlation and separate lifecycle facts", () => {
	const runId = "4f6f0f37-6a7d-4d08-8a6e-1de9cc5a16f0";
	const workId = "b0b4b2f7-1f72-4c85-bc88-f9d7d88c5a0c";
	const taskArgs: WorkspaceParameters = { action: "send", send: { kind: "task", runId, input: "prompt", text: "Review" } };
	const task: WorkspaceResult = {
		action: "send", target, sourcePaneId: "%5", deliveryId: "delivery-task",
		bytes: 6, input: "prompt", kind: "task", runId, workId,
	};
	assert.match(resultOutput(taskArgs, task, { expanded: true, isPartial: false }), /Work Cycle queued/);
	assert.match(resultOutput(taskArgs, task, { expanded: true, isPartial: false }), new RegExp(workId));
	const resultArgs: WorkspaceParameters = { action: "send", send: { kind: "result", outcome: "completed", text: "Done" } };
	const result: WorkspaceResult = {
		action: "send", target, sourcePaneId: "%13", deliveryId: "delivery-result", bytes: 4, input: "prompt",
		kind: "result", runId, workId, outcome: "completed", resultReceived: true, workFinished: false, text: "Done",
	};
	assert.match(resultOutput(resultArgs, result, { expanded: true, isPartial: false }), /Result Received/);
	assert.match(resultOutput(resultArgs, result, { expanded: true, isPartial: false }), /Awaiting Work Finished/);
	const waitArgs: WorkspaceParameters = { action: "wait", wait: { runId, workId } };
	const waited: WorkspaceResult = {
		action: "wait", mode: "managed", target, runId, workId, reason: "work_finished", outcome: "completed", text: "Done",
		resultReceived: true, workFinished: true, sequence: 0, elapsedMs: 120,
	};
	assert.match(resultOutput(waitArgs, waited, { expanded: true, isPartial: false }), /Work Finished/);
	assert.match(resultOutput(waitArgs, waited, { expanded: true, isPartial: false }), /Result Received/);
	const protocolFailure: WorkspaceResult = {
		action: "wait", mode: "managed", target, runId, workId, reason: "protocol_failure",
		text: "Work Finished was observed, but Result Received was missing.", protocolFailure: true,
		resultReceived: false, workFinished: true, sequence: 0, elapsedMs: 80,
	};
	assert.match(resultOutput(waitArgs, protocolFailure, { expanded: true, isPartial: false }), /Work Finished without Result Received/);
	assert.match(resultOutput(waitArgs, protocolFailure, { expanded: true, isPartial: false }), /protocol failure/);
});

test("wait rendering covers inbox progress, source attribution, timeout, and cancellation", () => {
	const args: WorkspaceParameters = { action: "wait", wait: { targetId: "%13", afterSequence: 42, timeoutMs: 120_000 } };
	const pending = resultOutput(args, {
		workspaceUi: { action: "wait", elapsedMs: 12_400, frame: 2 },
	}, { expanded: true, isPartial: true });
	assert.match(pending, /Waiting for inbox signal · %13 · 12\.4s/);
	assert.match(pending, /selected target inbox/);
	assert.match(pending, /After a timeout, call workspace wait again/);

	const signaled = resultOutput(args, {
		action: "wait",
		target,
		reason: "signaled",
		sourcePaneId: "%5",
		sequence: 43,
		elapsedMs: 3_400,
	}, { expanded: true, isPartial: false });
	assert.match(signaled, /✓ Inbox signal received · %5 → %13 · sequence 43/);
	assert.match(signaled, /signal reports its source pane/);
	assert.doesNotMatch(signaled, /After a timeout/);

	const timeout = resultOutput(args, {
		action: "wait",
		target,
		reason: "timeout",
		sequence: 42,
		elapsedMs: 120_000,
	}, { expanded: true, isPartial: false });
	assert.match(timeout, /! No inbox signal before timeout · inbox %13 · sequence 42/);
	assert.match(timeout, /After a timeout, call workspace wait again/);

	const cancelled = resultOutput(args, undefined, { expanded: false, isPartial: false }, true, "Operation aborted by user");
	assert.match(cancelled, /✕ Wait cancelled · Operation aborted by user/);
});

test("errors, hostile controls, and narrow widths remain safe and readable", () => {
	const hostileTarget: TerminalTarget = {
		...target,
		sessionName: "dev\u001b[2J",
		windowName: "api\u0000\r\nspoof",
		cwd: "/repo\twith-tab",
		currentCommand: "zsh\u001fhidden",
	};
	const args: WorkspaceParameters = { action: "spawn", spawn: { kind: "pane", title: "logs\u001b[31m" } };
	const component = renderWorkspaceResult(
		toolResult({ action: "spawn", target: hostileTarget }),
		{ expanded: true, isPartial: false },
		plainTheme as never,
		context(args) as never,
	);
	for (const width of [1, 16, 24, 40, 80]) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
	const output = rendered(component);
	assert.doesNotMatch(output, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
	assert.match(output, /api� ↵ spoof/);

	const genericError = resultOutput(args, undefined, { expanded: false, isPartial: false }, true, "tmux failed\u001b[2J\u0000");
	assert.match(genericError, /✕ Spawn failed · tmux failed�\[2J�/);

	const malformed = resultOutput(
		args,
		{ action: "spawn" } as unknown as WorkspaceToolDetails,
		{ expanded: false, isPartial: false },
	);
	assert.match(malformed, /! Spawn returned no details/);
});

test("wait progress updates animate and advance elapsed time", async () => {
	const updates: AgentToolResult<WorkspaceToolDetails>[] = [];
	await runWithWorkspaceWaitProgress((update) => updates.push(update), async () => {
		await new Promise((resolve) => setTimeout(resolve, 190));
	});
	assert.ok(updates.length >= 2);
	const first = updates[0]!.details;
	const last = updates.at(-1)!.details;
	assert.ok(first && "workspaceUi" in first);
	assert.ok(last && "workspaceUi" in last);
	if (first && "workspaceUi" in first && last && "workspaceUi" in last) {
		assert.ok(last.workspaceUi.elapsedMs >= 100);
		assert.notEqual(first.workspaceUi.frame, last.workspaceUi.frame);
	}
});
