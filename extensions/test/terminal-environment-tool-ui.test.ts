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
			run: { targetId: "%13", agent, model: `${agent}-latest`, thinking: "high", extraArgs: ["SECRET-NOISE"] },
		}, plainTheme as never));
		assert.match(output, new RegExp(agent, "i"));
		assert.match(output, /%13/);
		assert.match(output, /high/);
		assert.doesNotMatch(output, /SECRET-NOISE|extraArgs/);
	}
	assert.match(rendered(renderWorkspaceCall({ action: "send", send: { targetId: "%13", input: "command", text: "pwd", submit: false } }, plainTheme as never)), /Command · %13 · paste only/);
	assert.match(rendered(renderWorkspaceCall({ action: "wait", wait: { targetId: "%13", afterSequence: 4 } }, plainTheme as never)), /Send signal · %13 · after 4/);
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
			run: { agent, model: `${agent}-latest`, thinking: "medium", extraArgs: ["SECRET-NOISE"] },
		};
		const created = resultOutput(args, {
			action: "run",
			target: { ...target, currentCommand: agent },
			agent,
			executable: `/usr/local/bin/${agent}`,
			spawnedTarget: true,
		}, { expanded: true, isPartial: false });
		assert.match(created, new RegExp(`✓ ${agent[0]!.toUpperCase()}${agent.slice(1)} launched`));
		assert.match(created, /new target/);
		assert.match(created, new RegExp(`model ${agent}-latest · thinking medium`));
		assert.doesNotMatch(created, /SECRET-NOISE|\/usr\/local\/bin/);
	}

	const existing = resultOutput({ action: "run", run: { targetId: "%13", agent: "codex" } }, {
		action: "run", target, agent: "codex", executable: "codex", spawnedTarget: false,
	}, { expanded: false, isPartial: false });
	assert.match(existing, /existing target/);
});

test("send results render Markdown previews, submission mode, and delivery sequence", () => {
	const markdown = "# Review auth\n\n- Keep **tests** green\n- Check `session.ts`";
	const promptArgs: WorkspaceParameters = { action: "send", send: { targetId: "%13", input: "prompt", text: markdown } };
	const promptResult: WorkspaceResult = {
		action: "send", target, deliveryId: "delivery-42", sequence: 42, bytes: 61, input: "prompt",
	};
	const collapsed = resultOutput(promptArgs, promptResult, { expanded: false, isPartial: false });
	assert.match(collapsed, /✓ Prompt sent · %13 · sequence 42 · 61 B/);
	assert.match(collapsed, /# Review auth/);
	assert.doesNotMatch(collapsed, /Keep tests green/);

	const expanded = resultOutput(promptArgs, promptResult, { expanded: true, isPartial: false });
	assert.match(expanded, /Review auth/);
	assert.match(expanded, /Keep tests green/);
	assert.match(expanded, /delivery delivery-42/);

	const pasted = resultOutput(
		{ action: "send", send: { targetId: "%13", input: "command", text: "bun test", submit: false } },
		{ action: "send", target, deliveryId: "delivery-43", sequence: 43, bytes: 8, input: "command" },
		{ expanded: false, isPartial: false },
	);
	assert.match(pasted, /✓ Command pasted · %13 · sequence 43/);
});

test("wait rendering covers progress, send signals, timeout, target exit, and cancellation", () => {
	const args: WorkspaceParameters = { action: "wait", wait: { targetId: "%13", afterSequence: 42, timeoutMs: 120_000 } };
	const pending = resultOutput(args, {
		workspaceUi: { action: "wait", elapsedMs: 12_400, frame: 2 },
	}, { expanded: true, isPartial: true });
	assert.match(pending, /Waiting for send signal · %13 · 12\.4s/);
	assert.match(pending, /workspace send events only; agent status unknown/);
	assert.doesNotMatch(pending, /agent completion/);

	const cases = [
		["signaled", "✓ Send signal received"],
		["timeout", "! No send signal before timeout"],
		["target-exited", "✕ Target exited while waiting"],
	] as const;
	for (const [reason, expected] of cases) {
		const output = resultOutput(args, {
			action: "wait",
			target: { ...target, dead: reason === "target-exited" },
			reason,
			sequence: reason === "signaled" ? 43 : 42,
			elapsedMs: reason === "timeout" ? 120_000 : 3_400,
		}, { expanded: true, isPartial: false });
		assert.match(output, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(output, /workspace send events only; agent status unknown/);
	}

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
