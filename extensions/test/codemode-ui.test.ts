import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderers,
	type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parseArgsPreview, registerCodemodeUi } from "../mepie-tool-ui/codemode.ts";
import { registerMepieToolUi } from "../mepie-tool-ui/tools.ts";
import { registerNestedToolView } from "../mepie-tool-ui/nested-views.ts";

initTheme();
const cwd = "/repo";
const tui = { requestRender() {} } as unknown as TUI;
const plain = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd();

function codemodeRenderers(): ToolRenderers {
	let resolver: ToolRendererResolver | undefined;
	const pi = {
		registerTool() {},
		registerToolRenderer(value: ToolRendererResolver) { resolver = value; },
	} as unknown as ExtensionAPI;
	registerMepieToolUi(pi, cwd, "compact");
	registerNestedToolView("rg", {
		icon: "R",
		label: "Rg",
		target: (args: { pattern?: string }) => `/${args.pattern ?? ""}/`,
	});
	registerCodemodeUi(pi, cwd, "compact");
	assert.ok(resolver);
	const renderers = resolver("codemode", () => undefined);
	assert.ok(renderers);
	assert.equal(resolver("read", () => undefined), undefined);
	return renderers;
}

function render(result: AgentToolResult<unknown> & { isError: boolean }, expanded = false, code = "return 1"): string[] {
	const tool = {
		name: "codemode",
		label: "codemode",
		description: "",
		parameters: Type.Object({ code: Type.String() }),
		execute: async () => ({ content: [], details: undefined }),
		...codemodeRenderers(),
	} as unknown as ToolDefinition;
	const row = new ToolExecutionComponent("codemode", "row", { code }, {}, tool, tui, cwd);
	row.setExpanded(expanded);
	row.updateResult({ ...result, durationMs: 400 }, false);
	return row.render(100).map(plain).filter(Boolean);
}

const header = (outcome: "completed" | "failed") => ({ type: "text" as const, text: `Script ${outcome}\nWall time 0.4 seconds\nOutput:\n` });

test("collapsed codemode rows label nested calls like direct Mepie rows and hide output", () => {
	const lines = render({
		content: [header("completed"), { type: "text", text: "secret output" }],
		details: { calls: [
			{ name: "read", args: JSON.stringify({ path: "/repo/src/index.ts" }), status: "ok", durationMs: 4 },
			{ name: "bash", args: JSON.stringify({ purpose: "Run checks", command: "bun run check" }), status: "ok", durationMs: 1200 },
			{ name: "bash", args: JSON.stringify({ command: "git status\ngit diff" }), status: "ok", durationMs: 30 },
			{ name: "rg", args: JSON.stringify({ pattern: "renderCall" }), status: "running" },
			{ name: "webweb", args: "{\"q\":\"pi\"}", status: "ok" },
		] },
		isError: false,
	});
	assert.match(lines[0] ?? "", /Codemode · 5 calls · 400ms$/);
	assert.match(lines[1] ?? "", /^ ├─ 󰈙 Read src\/index\.ts +4ms$/);
	assert.match(lines[2] ?? "", /├─ \S+ Bash · Run checks +1\.2s$/);
	assert.match(lines[3] ?? "", /├─ \S+ Bash · git status +30ms$/);
	assert.match(lines[4] ?? "", /├─ R Rg \/renderCall\/$/);
	assert.match(lines[5] ?? "", /╰─ 󰒓 webweb \{"q":"pi"\}$/);
	assert.equal(lines.length, 6);
	assert.ok(!lines.join("\n").includes("secret output"));
});

test("collapsed rows keep the latest calls and count the hidden ones", () => {
	const calls = Array.from({ length: 10 }, (_, index) => ({ name: "read", args: JSON.stringify({ path: `f${index}` }), status: "ok" }));
	const lines = render({ content: [header("completed")], details: { calls }, isError: false });
	assert.match(lines[1] ?? "", /├─ … 2 earlier calls/);
	assert.match(lines[2] ?? "", /Read f2$/);
	assert.match(lines.at(-1) ?? "", /╰─ 󰈙 Read f9$/);
});

test("failures show a failed call's error once and a script-only error as the last item", () => {
	const callError = render({
		content: [header("failed"), { type: "text", text: "Script error:\nError: output\n    at main\n\nCalls: bash" }],
		details: { calls: [{ name: "bash", args: JSON.stringify({ command: "false" }), status: "error", error: "output\nexit 1" }] },
		isError: true,
	});
	assert.match(callError[0] ?? "", /Codemode · failed$/);
	assert.match(callError[1] ?? "", /╰─ \S+ Bash · false$/);
	assert.match(callError[2] ?? "", /^ +╰─ exit 1$/);
	assert.equal(callError.length, 3);

	const scriptError = render({
		content: [header("failed"), { type: "text", text: "Script error:\nReferenceError: x is not defined\n\nCalls: read" }],
		details: { calls: [{ name: "read", args: JSON.stringify({ path: "a.ts" }), status: "ok" }] },
		isError: true,
	});
	assert.match(scriptError[1] ?? "", /├─ 󰈙 Read a\.ts$/);
	assert.match(scriptError[2] ?? "", /╰─ ReferenceError: x is not defined$/);
});

test("script errors stay visible unless a visible call shows the same error", () => {
	const hiddenFailure = { name: "bash", args: JSON.stringify({ command: "false" }), status: "error", error: "Error" };
	const okCalls = Array.from({ length: 8 }, () => ({ name: "read", args: JSON.stringify({ path: "a.ts" }), status: "ok" }));
	const lines = render({
		content: [header("failed"), { type: "text", text: "Script error:\nError: Error\n\nCalls: bash" }],
		details: { calls: [hiddenFailure, ...okCalls] },
		isError: true,
	});
	assert.match(lines.at(-1) ?? "", /╰─ Error: Error$/);

	const unrelated = render({
		content: [header("failed"), { type: "text", text: "Script error:\nTypeError: output is not iterable" }],
		details: { calls: [{ name: "bash", args: JSON.stringify({ command: "false" }), status: "error", error: "output" }] },
		isError: true,
	});
	assert.match(unrelated.at(-1) ?? "", /╰─ TypeError: output is not iterable$/);
});

test("cancelled calls say so in place of a duration", () => {
	const lines = render({
		content: [header("failed"), { type: "text", text: "Script error:\nScript timed out: 1000 ms" }],
		details: { calls: [{ name: "read", args: JSON.stringify({ path: "a.ts" }), status: "cancelled", durationMs: 5 }] },
		isError: true,
	});
	assert.match(lines[1] ?? "", /├─ 󰈙 Read a\.ts +cancelled$/);
	assert.match(lines[2] ?? "", /╰─ Script timed out: 1000 ms$/);
});

test("expanded rows show full call arguments, the script, and output without codemode's header", () => {
	const lines = render({
		content: [header("completed"), { type: "text", text: "done" }],
		details: { calls: [{ name: "read", args: JSON.stringify({ path: "a.ts", limit: 5 }), status: "ok" }] },
		isError: false,
	}, true, "const x = 1;\nreturn x");
	const text = lines.join("\n");
	assert.match(text, /╰─ \{"path":"a\.ts","limit":5\}/);
	assert.match(text, /const x = 1;\n return x/);
	assert.match(text, /done/);
	assert.ok(!text.includes("Wall time"));

	const failed = render({
		content: [header("failed"), { type: "text", text: "Script error:\nError: boom\n    at main\n\nTool calls made before the failure: read" }],
		details: { calls: [{ name: "read", args: JSON.stringify({ path: "a.ts" }), status: "ok" }] },
		isError: true,
	}, true).join("\n");
	assert.match(failed, /Error: boom\n +at main/);
	assert.ok(!failed.includes("Tool calls made before the failure"));
});

test("argument previews cut by codemode still parse when they can be closed", () => {
	assert.deepEqual(parseArgsPreview('{"purpose":"Run checks","command":"bun run ch...'), { purpose: "Run checks", command: "bun run ch" });
	assert.deepEqual(parseArgsPreview('{"command":"echo \\...'), { command: "echo " });
	assert.equal(parseArgsPreview('{"path":"a","off...'), undefined);
	assert.equal(parseArgsPreview("[1,2]"), undefined);
});
