import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	Theme,
	type AgentToolResult,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import mepieToolUi from "../mepie-tool-ui/index.ts";

interface RegisteredTool {
	readonly name: string;
	readonly renderShell?: "default" | "self";
	renderCall(args: unknown, theme: Theme, context: unknown): Component;
	renderResult(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown,
	): Component;
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

initTheme();

function registeredTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as unknown as RegisteredTool);
		},
		on() {},
	};
	mepieToolUi(pi as unknown as ExtensionAPI);
	return tools;
}

function renderContext(
	args: unknown,
	state: Record<string, unknown>,
	overrides: Partial<{
		readonly executionStarted: boolean;
		readonly argsComplete: boolean;
		readonly isPartial: boolean;
		readonly expanded: boolean;
		readonly isError: boolean;
	}> = {},
): Record<string, unknown> {
	return {
		args,
		toolCallId: "tool-1",
		invalidate() {},
		lastComponent: undefined,
		state,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	};
}

function renderCompleted(
	tool: RegisteredTool,
	args: unknown,
	result: AgentToolResult<unknown>,
	expanded = false,
	width = 120,
): { readonly call: string; readonly result: string } {
	const state: Record<string, unknown> = {};
	const context = renderContext(args, state, { expanded });
	const call = tool.renderCall(args, plainTheme as unknown as Theme, context);
	const renderedResult = tool.renderResult(
		result,
		{ expanded, isPartial: false },
		plainTheme as unknown as Theme,
		context,
	);
	return {
		call: call.render(width).join("\n").trim(),
		result: renderedResult.render(width).join("\n").trim(),
	};
}

test("thinking text uses the dim theme color without changing font styles", async () => {
	type EventHandler = (event: unknown, context: { readonly mode: string }) => unknown;
	const handlers = new Map<string, EventHandler>();
	const originalForeground = Theme.prototype.fg;
	const originalBold = Theme.prototype.bold;
	const originalItalic = Theme.prototype.italic;
	const observedColors: string[] = [];
	const foregroundSpy = (color: string, text: string) => {
		observedColors.push(color);
		return text;
	};
	Theme.prototype.fg = foregroundSpy;

	try {
		const pi = {
			registerTool() {},
			on(event: string, handler: EventHandler) {
				handlers.set(event, handler);
			},
		};
		mepieToolUi(pi as unknown as ExtensionAPI);

		const start = handlers.get("session_start");
		const shutdown = handlers.get("session_shutdown");
		assert.ok(start);
		assert.ok(shutdown);
		await start({}, { mode: "tui" });
		Theme.prototype.fg("thinkingText", "thinking");
		assert.deepEqual(observedColors, ["dim"]);
		assert.equal(Theme.prototype.bold, originalBold);
		assert.equal(Theme.prototype.italic, originalItalic);

		await shutdown({}, { mode: "tui" });
		assert.equal(Theme.prototype.fg, foregroundSpy);
	} finally {
		Theme.prototype.fg = originalForeground;
	}
});

test("mepie-tool-ui overrides every built-in tool with a self-rendered shell", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	for (const tool of tools.values()) assert.equal(tool.renderShell, "self");
});

test("collapsed successful tools render one summary line and no result row", () => {
	const tools = registeredTools();
	const cases: readonly [string, unknown, AgentToolResult<unknown>, RegExp][] = [
		["read", { path: "src/index.ts" }, { content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined }, /^Read src\/index\.ts · 3 lines$/],
		["bash", { command: "bun run check" }, { content: [{ type: "text", text: "(no output)" }], details: undefined }, /^Bash bun run check · no output$/],
		["edit", { path: "src/index.ts", edits: [] }, { content: [{ type: "text", text: "Updated" }], details: { diff: " context\n-old\n+new", patch: "" } }, /^Edit src\/index\.ts · \+1 −1$/],
		["write", { path: "README.md", content: "a\nb" }, { content: [{ type: "text", text: "Wrote README.md" }], details: undefined }, /^Write README\.md · 2 lines · 3 B$/],
		["grep", { pattern: "renderCall", path: "src" }, { content: [{ type: "text", text: "a.ts:1: renderCall\nb.ts:2: renderCall" }], details: undefined }, /^Grep \/renderCall\/ in src · 2 results$/],
		["find", { pattern: "*.ts", path: "src" }, { content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }], details: undefined }, /^Find \*\.ts in src · 2 files$/],
		["ls", { path: "src" }, { content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined }, /^List src · 2 entries$/],
	];

	for (const [name, args, result, expected] of cases) {
		const tool = tools.get(name);
		assert.ok(tool);
		const rendered = renderCompleted(tool, args, result);
		assert.match(rendered.call, expected);
		assert.equal(rendered.call.split("\n").length, 1);
		assert.equal(rendered.result, "");
	}
});

test("bash summaries do not count a trailing line terminator as output", () => {
	const bash = registeredTools().get("bash");
	assert.ok(bash);
	assert.equal(
		renderCompleted(bash, { command: "printf 'done\\n'" }, {
			content: [{ type: "text", text: "done\n" }],
			details: undefined,
		}).call,
		"Bash printf 'done\\n' · 1 line",
	);
});

test("empty find and list results report zero instead of counting status prose", () => {
	const tools = registeredTools();
	const find = tools.get("find");
	const list = tools.get("ls");
	assert.ok(find);
	assert.ok(list);
	assert.equal(
		renderCompleted(find, { pattern: "*.ts" }, {
			content: [{ type: "text", text: "No files found matching pattern" }],
			details: undefined,
		}).call,
		"Find *.ts in . · 0 files",
	);
	assert.equal(
		renderCompleted(list, { path: "." }, {
			content: [{ type: "text", text: "(empty directory)" }],
			details: undefined,
		}).call,
		"List . · 0 entries",
	);
});

test("failed tools add one rounded error line while expanded failures show all returned text", () => {
	const tool = registeredTools().get("edit");
	assert.ok(tool);
	const args = { path: "src/index.ts", edits: [{ oldText: "old", newText: "new" }] };
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Edit failed\noldText did not match exactly. Re-read the file and retry." }],
		details: undefined,
	};
	const state: Record<string, unknown> = {};
	const collapsedContext = renderContext(args, state, { isError: true });
	const call = tool.renderCall(args, plainTheme as unknown as Theme, collapsedContext);
	const collapsed = tool.renderResult(
		result,
		{ expanded: false, isPartial: false },
		plainTheme as unknown as Theme,
		collapsedContext,
	);
	assert.equal(call.render(120).join("\n").trim(), "Edit src/index.ts · failed");
	assert.equal(collapsed.render(120).join("\n").trim(), "╰─ oldText did not match exactly. Re-read the file and retry.");

	const expandedContext = renderContext(args, {}, { expanded: true, isError: true });
	const expanded = tool.renderResult(
		result,
		{ expanded: true, isPartial: false },
		plainTheme as unknown as Theme,
		expandedContext,
	).render(120).join("\n");
	assert.match(expanded, /╰─ Edit failed/);
	assert.match(expanded, /oldText did not match exactly/);
});

test("tool label color uses the themed tool title for live and restored success states", () => {
	const tool = registeredTools().get("bash");
	assert.ok(tool);
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
	const args = { command: "bun test" };
	const states = [
		[{ executionStarted: false, isPartial: true }, "dim"],
		[{ executionStarted: true, isPartial: true }, "accent"],
		[{ executionStarted: true, isPartial: false }, "toolTitle"],
		[{ executionStarted: false, isPartial: false }, "toolTitle"],
		[{ executionStarted: true, isPartial: false, isError: true }, "error"],
	] as const;
	for (const [overrides, color] of states) {
		const context = renderContext(args, {}, overrides);
		const output = tool.renderCall(args, theme, context).render(200).join("\n");
		assert.match(output, new RegExp(`<${color}><b>Bash<\\/b><\\/${color}>`));
	}
});

test("expanded tools show all returned or submitted content", () => {
	const tools = registeredTools();
	const bash = tools.get("bash");
	const write = tools.get("write");
	assert.ok(bash);
	assert.ok(write);

	const bashOutput = renderCompleted(
		bash,
		{ command: "printf 'one\\ntwo\\nthree'" },
		{ content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined },
		true,
	).result;
	assert.match(bashOutput, /one/);
	assert.match(bashOutput, /two/);
	assert.match(bashOutput, /three/);

	const writeOutput = renderCompleted(
		write,
		{ path: "notes.txt", content: "first\nsecond\nthird" },
		{ content: [{ type: "text", text: "Wrote notes.txt" }], details: undefined },
		true,
	).result;
	assert.match(writeOutput, /^1  /);
	assert.match(writeOutput, /first/);
	assert.match(writeOutput, /third/);
});

test("tool rows use matching left and right conversation insets", () => {
	const tool = registeredTools().get("edit");
	assert.ok(tool);
	const args = { path: "src/index.ts", edits: [] };
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "Updated" }],
		details: { diff: "-old\n+new", patch: "" },
	};
	const state: Record<string, unknown> = {};
	const context = renderContext(args, state);
	const call = tool.renderCall(args, plainTheme as unknown as Theme, context);
	tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme as unknown as Theme, context);
	const line = call.render(40)[0];
	assert.ok(line?.startsWith(" "));
	assert.ok(line?.endsWith(" "));
	assert.ok(visibleWidth(line ?? "") <= 40);

	const errorContext = renderContext(args, {}, { isError: true });
	const error = tool.renderResult(
		{ content: [{ type: "text", text: "oldText did not match" }], details: undefined },
		{ expanded: false, isPartial: false },
		plainTheme as unknown as Theme,
		errorContext,
	).render(40)[0];
	assert.ok(error?.startsWith(" ╰─ "));
	assert.ok(error?.endsWith(" "));
	assert.ok(visibleWidth(error ?? "") <= 40);
});

test("collapsed summaries sanitize controls, truncate to width, and never wrap", () => {
	const tool = registeredTools().get("bash");
	assert.ok(tool);
	const args = { command: `printf '\u001b[2J' && ${"very-long-command ".repeat(20)}` };
	const rendered = renderCompleted(
		tool,
		args,
		{ content: [{ type: "text", text: "done" }], details: undefined },
		false,
		48,
	).call;
	assert.equal(rendered.split("\n").length, 1);
	assert.ok(visibleWidth(rendered) <= 48);
	assert.doesNotMatch(rendered, /\[2J/);
});
