import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	Theme,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import mepieToolUi from "../mepie-tool-ui/index.ts";
import { registerThinkingTextStyle } from "../mepie-tool-ui/thinking-text.ts";
import { registerMepieToolSpacing } from "../mepie-tool-ui/tool-renderer.ts";

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
	theme = plainTheme as unknown as Theme,
): { readonly call: string; readonly result: string } {
	const state: Record<string, unknown> = {};
	const context = renderContext(args, state, { expanded });
	const call = tool.renderCall(args, theme, context);
	const renderedResult = tool.renderResult(
		result,
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return {
		call: call.render(width).join("\n").trim(),
		result: renderedResult.render(width).join("\n").trim(),
	};
}

test("thinking text includes the Nerd Font icon and preserves its theme color, italic style, and trailing spacing", async () => {
	type EventHandler = (event: unknown, context: { readonly mode: string }) => unknown;
	const handlers = new Map<string, EventHandler>();
	const originalForeground = Theme.prototype.fg;
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
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
		assert.deepEqual(observedColors, ["thinkingText"]);
		assert.equal(Theme.prototype.bold, originalBold);
		assert.equal(Theme.prototype.italic, originalItalic);

		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "**Inspecting** the files\n\nPlanning the change" },
				{ type: "thinking", thinking: "Implementing the change" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } },
			],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const markdownTheme = {
			...getMarkdownTheme(),
			bold: (text: string) => `<bold>${text}</bold>`,
			italic: (text: string) => `<italic>${text}</italic>`,
		};
		const lines = new AssistantMessageComponent(message, false, markdownTheme).render(80);
		const renderedThinking = lines.join("\n");
		assert.match(renderedThinking, /󰧑/);
		assert.match(renderedThinking, /<italic>Inspecting<\/italic>/);
		assert.doesNotMatch(renderedThinking, /<bold>Inspecting<\/bold>/);
		const inspectingLine = lines.findIndex((line) => line.includes("Inspecting"));
		const planningLine = lines.findIndex((line) => line.includes("Planning the change"));
		const implementingLine = lines.findIndex((line) => line.includes("Implementing the change"));
		assert.ok(inspectingLine >= 0);
		assert.ok(planningLine > inspectingLine);
		assert.ok(implementingLine > planningLine);
		assert.equal(lines.slice(inspectingLine, implementingLine).some((line) => line.trim() === ""), false);
		assert.equal(lines.at(-1), "");
		assert.equal(lines.filter((line) => line === "").length, 2);

		const assistantMessage: AssistantMessage = {
			...message,
			content: [{ type: "text", text: "**Final** answer" }],
			stopReason: "stop",
		};
		const assistantLines = new AssistantMessageComponent(assistantMessage, false, markdownTheme).render(80);
		assert.match(assistantLines.join("\n"), /<bold>Final<\/bold>/);
		assert.notEqual(assistantLines.at(-1), "");

		const commentaryMessage: AssistantMessage = {
			...message,
			content: [
				{ type: "text", text: "Explaining the next edit" },
				{ type: "toolCall", id: "tool-2", name: "edit", arguments: { path: "src/index.ts" } },
			],
		};
		const commentaryLines = new AssistantMessageComponent(commentaryMessage, false, markdownTheme).render(80);
		assert.equal(commentaryLines.at(-1), "");
		assert.equal(commentaryLines.filter((line) => line === "").length, 2);

		await shutdown({}, { mode: "tui" });
		assert.equal(Theme.prototype.fg, foregroundSpy);
		assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdateContent);
	} finally {
		Theme.prototype.fg = originalForeground;
		AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
	}
});

test("thinking rendering remains single and restores cleanly across extension reload", async () => {
	type EventHandler = (event: unknown, context: { readonly mode: string }) => unknown;
	const originalForeground = Theme.prototype.fg;
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const extensionHandlers: Array<Map<string, EventHandler>> = [];

	try {
		for (let instance = 0; instance < 2; instance += 1) {
			const handlers = new Map<string, EventHandler>();
			registerThinkingTextStyle({
				on(event: string, handler: EventHandler) {
					handlers.set(event, handler);
				},
			} as unknown as ExtensionAPI);
			extensionHandlers.push(handlers);
		}

		const firstStart = extensionHandlers[0]?.get("session_start");
		const firstShutdown = extensionHandlers[0]?.get("session_shutdown");
		const secondStart = extensionHandlers[1]?.get("session_start");
		const secondShutdown = extensionHandlers[1]?.get("session_shutdown");
		assert.ok(firstStart);
		assert.ok(firstShutdown);
		assert.ok(secondStart);
		assert.ok(secondShutdown);

		await firstStart({}, { mode: "tui" });
		await secondStart({}, { mode: "tui" });
		await firstShutdown({}, { mode: "tui" });

		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Inspecting the files" }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.4-mini",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const rendered = new AssistantMessageComponent(message).render(80).join("\n");
		assert.equal(rendered.match(/󰧑/gu)?.length, 1);

		await secondShutdown({}, { mode: "tui" });
		assert.equal(Theme.prototype.fg, originalForeground);
		assert.equal(AssistantMessageComponent.prototype.updateContent, originalUpdateContent);
	} finally {
		Theme.prototype.fg = originalForeground;
		AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
	}
});

test("mepie-tool-ui overrides every built-in tool with a self-rendered shell", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	for (const tool of tools.values()) assert.equal(tool.renderShell, "self");
});

test("Mepie tool rows omit Pi's leading spacer without affecting other tools", async () => {
	type EventHandler = (event: unknown, context: { readonly mode: string }) => unknown;
	const handlers = new Map<string, EventHandler>();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
	};
	registerMepieToolSpacing(pi as unknown as ExtensionAPI);

	const start = handlers.get("session_start");
	const shutdown = handlers.get("session_shutdown");
	assert.ok(start);
	assert.ok(shutdown);
	await start({}, { mode: "tui" });

	try {
		const bash = registeredTools().get("bash");
		assert.ok(bash);
		const ui = { requestRender() {} } as unknown as TUI;
		const compact = new ToolExecutionComponent(
			"bash",
			"tool-1",
			{ command: "echo done" },
			{},
			bash as unknown as ToolDefinition,
			ui,
			process.cwd(),
		);
		assert.notEqual(compact.render(120)[0], "");

		const unrelated = new ToolExecutionComponent(
			"custom_tool",
			"tool-2",
			{},
			{},
			undefined,
			ui,
			process.cwd(),
		);
		assert.equal(unrelated.render(120)[0], "");
	} finally {
		await shutdown({}, { mode: "tui" });
	}
});

test("collapsed successful tools render one summary line and no result row", () => {
	const tools = registeredTools();
	const cases: readonly [string, unknown, AgentToolResult<unknown>, RegExp][] = [
		["read", { path: "src/index.ts" }, { content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined }, /^󰈙 Read src\/index\.ts · 3 lines$/],
		["bash", { command: "bun run check" }, { content: [{ type: "text", text: "(no output)" }], details: undefined }, /^ Bash bun run check · no output$/],
		["edit", { path: "src/index.ts", edits: [] }, { content: [{ type: "text", text: "Updated" }], details: { diff: " context\n-old\n+new", patch: "" } }, /^󰏫 Edit src\/index\.ts · \+1 −1$/],
		["write", { path: "README.md", content: "a\nb" }, { content: [{ type: "text", text: "Wrote README.md" }], details: undefined }, /^󰆓 Write README\.md · 2 lines · 3 B$/],
		["grep", { pattern: "renderCall", path: "src" }, { content: [{ type: "text", text: "a.ts:1: renderCall\nb.ts:2: renderCall" }], details: undefined }, /^󰍉 Grep \/renderCall\/ in src · 2 results$/],
		["find", { pattern: "*.ts", path: "src" }, { content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }], details: undefined }, /^󰈞 Find \*\.ts in src · 2 files$/],
		["ls", { path: "src" }, { content: [{ type: "text", text: "a.ts\nb.ts" }], details: undefined }, /^󰉋 List src · 2 entries$/],
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

test("collapsed skill reads use the Nerd Font skill label and semantic text colors", () => {
	const read = registeredTools().get("read");
	assert.ok(read);
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	} as unknown as Theme;
	const context = renderContext({ path: "/tmp/unslop/SKILL.md" }, {});
	const line = read.renderCall(context.args, theme, context).render(200)[0];
	assert.ok(line);
	assert.ok(line.startsWith(" "));
	assert.ok(line.endsWith(" "));
	const rendered = line.trim();

	assert.match(rendered, /^<muted>\[<\/muted><toolTitle><\/toolTitle><muted>\]<\/muted> /);
	assert.match(rendered, /<text>unslop<\/text>/);
	assert.match(rendered, /<muted> \(.*to expand\)<\/muted>$/);
	assert.doesNotMatch(rendered, /Read|lines/);
});

test("collapsed Bash rows show only the first physical script line", () => {
	const bash = registeredTools().get("bash");
	assert.ok(bash);
	const rendered = renderCompleted(
		bash,
		{ command: "set -e\nbun test\nbun run check" },
		{ content: [{ type: "text", text: "(no output)" }], details: undefined },
	);
	assert.equal(rendered.call, " Bash set -e · no output");
});

test("bash summaries do not count a trailing line terminator as output", () => {
	const bash = registeredTools().get("bash");
	assert.ok(bash);
	assert.equal(
		renderCompleted(bash, { command: "printf 'done\\n'" }, {
			content: [{ type: "text", text: "done\n" }],
			details: undefined,
		}).call,
		" Bash printf 'done\\n' · 1 line",
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
		"󰈞 Find *.ts in . · 0 files",
	);
	assert.equal(
		renderCompleted(list, { path: "." }, {
			content: [{ type: "text", text: "(empty directory)" }],
			details: undefined,
		}).call,
		"󰉋 List . · 0 entries",
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
	assert.equal(call.render(120).join("\n").trim(), "󰏫 Edit src/index.ts · failed");
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

test("tool icons use text color while labels communicate execution state", () => {
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
		assert.match(output, /^ <text><\/text> /);
		assert.match(output, new RegExp(`<${color}><b>Bash<\\/b><\\/${color}>`));
	}
});

test("completed rows use muted targets, success results, dim separators, and warning exceptions", () => {
	const read = registeredTools().get("read");
	assert.ok(read);
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
	const rendered = renderCompleted(
		read,
		{ path: "src/index.ts" },
		{
			content: [{ type: "text", text: "one\ntwo\nthree" }],
			details: { truncation: { truncated: true, outputLines: 3 } },
		},
		false,
		200,
		theme,
	);
	assert.equal(
		rendered.call,
		"<text>󰈙</text> <toolTitle><b>Read</b></toolTitle> <muted>src/index.ts</muted>" +
			"<dim> · </dim><success>3 lines</success><dim> · </dim><warning>truncated</warning>",
	);
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
