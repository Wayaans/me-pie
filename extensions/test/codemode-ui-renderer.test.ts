import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type Theme, type ToolDefinition, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import codemodeUi from "../codemode-ui/index.ts";
import { describeCall, lastCommand } from "../codemode-ui/activity.ts";
import { codemodeRenderers, type CodemodeRowState, type NestedCall } from "../codemode-ui/render.ts";

initTheme();
const cwd = "/repo";
const tui = { requestRender() {} } as unknown as TUI;
// Strip ANSI styles and the one-column padding of Pi's tool row box.
const plain = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();

interface Row {
	readonly component: ToolExecutionComponent;
	lines(width?: number): string[];
}

function codemodeRow(code = "return 1"): Row {
	let resolver: ToolRendererResolver | undefined;
	codemodeUi({ registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as unknown as ExtensionAPI);
	assert.ok(resolver);
	assert.equal(resolver("read", () => undefined), undefined);
	const tool = {
		name: "codemode",
		label: "codemode",
		description: "",
		parameters: Type.Object({ code: Type.String() }),
		execute: async () => ({ content: [], details: undefined }),
		...resolver("codemode", () => undefined),
	} as unknown as ToolDefinition;
	const component = new ToolExecutionComponent("codemode", "row", { code }, {}, tool, tui, cwd);
	return { component, lines: (width = 100) => component.render(width).map(plain).filter(Boolean) };
}

const read: NestedCall = { name: "read", args: '{"path":"/repo/src/index.ts"}', status: "ok", durationMs: 12 };
const check: NestedCall = { name: "bash", args: '{"command":"cd /repo && bun run check 2>&1 | tail -5"}', status: "running" };

function final(row: Row, calls: readonly NestedCall[], isError = false, text = "Script completed\nWall time 0.4 seconds\nOutput:\n") {
	row.component.updateResult({ content: [{ type: "text", text }], details: { calls }, isError, durationMs: 400 }, false);
}

test("bash calls show only the command the chain ends with", () => {
	assert.equal(lastCommand("cd /repo && FOO=1 bun run check 2>&1 | tail -5"), "bun run check 2>&1");
	assert.equal(lastCommand("git status; git diff --stat;"), "git diff --stat");
	assert.equal(lastCommand('echo "a && b; c" | wc -l'), 'echo "a && b; c"');
	assert.equal(lastCommand("python3 -c 'print(1)'\nsed -n 1,5p file.txt"), "sed -n 1,5p file.txt");
});

test("nested calls describe their activity from truncated argument previews", () => {
	assert.equal(describeCall("read", '{"path":"/repo/src/index.ts"}', cwd).status, "Reading src/index.ts");
	assert.equal(describeCall("rg", '{"pattern":"registerTool","path":"extensions"}', cwd).status, 'Searching "registerTool"');
	assert.equal(describeCall("bash", '{"command":"cd x && sed -n 1,9p a.ts","timeout":5', cwd).status, "Running sed -n 1,9p a.ts");
	assert.equal(describeCall("ww_fetch", '{"urls":["https://example.com/a","https://b.co"]}', cwd).status, "Fetching https://example.com/a");
	assert.equal(describeCall("write", '{"path":"/repo/notes.md","content":"long text cut by codem...', cwd).status, "Writing notes.md");
	assert.deepEqual(describeCall("mystery", '{"x":1}', cwd), { status: "Calling mystery", target: '{"x":1}' });
});

test("a running row shows the current call as one line", () => {
	const row = codemodeRow();
	row.component.markExecutionStarted();
	assert.deepEqual(row.lines(), ["Executing script · 0ms"]);
	row.component.updateResult({ content: [], details: { calls: [read, check] }, isError: false }, true);
	const lines = row.lines();
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /^Running bun run check 2>&1 · 2 tools · \d+ms$/);
	final(row, [read, { ...check, status: "ok", durationMs: 300 }]);
});

test("a finished row collapses to a summary, adding one line for a failure", () => {
	const success = codemodeRow();
	final(success, [read]);
	assert.deepEqual(success.lines(), ["Ran 1 tool · 400ms"]);

	const failed = codemodeRow();
	final(failed, [read, { ...check, status: "error", durationMs: 900, error: "tsc exited with code 2\nat stack" }], true);
	assert.deepEqual(failed.lines(), ["Ran 2 tools · 1 failed · 400ms", "╰─ bash: tsc exited with code 2"]);

	const scriptError = codemodeRow();
	final(scriptError, [], true, "Script failed\nWall time 0.1 seconds\nOutput:\nScript error:\nReferenceError: x is not defined\n\nNo tool calls were made.");
	assert.deepEqual(scriptError.lines(), ["Script failed · 400ms", "╰─ ReferenceError: x is not defined"]);
});

test("an expanded row lists every call and nothing else", () => {
	const row = codemodeRow("const hidden = await tools.read({ path: 'SCRIPT CODE' });");
	const calls = Array.from({ length: 12 }, (_, index): NestedCall => ({ ...read, args: `{"path":"/repo/file${index}.ts"}` }));
	final(row, calls, false, "Script completed\nWall time 0.4 seconds\nOutput:\nSCRIPT OUTPUT");
	row.component.setExpanded(true);
	const lines = row.lines(160);
	assert.equal(lines[0], "Ran 12 tools · 400ms");
	assert.equal(lines.filter((line) => /^(├─|╰─) ✓ read {2}file\d+\.ts/.test(line)).length, 12);
	assert.match(lines[12] ?? "", /^╰─ ✓ read {2}file11\.ts +12ms$/);
	assert.equal(lines.length, 13);
	assert.ok(!lines.some((line) => line.includes("SCRIPT OUTPUT") || line.includes("SCRIPT CODE")));
});

test("the elapsed-time timer runs only while the script runs", () => {
	const state: CodemodeRowState = {};
	const invalidations: number[] = [];
	const context = (isPartial: boolean, executionStarted = true) => ({
		args: { code: "" }, toolCallId: "row", invalidate: () => invalidations.push(1), lastComponent: undefined, state, cwd,
		executionStarted, argsComplete: true, isPartial, expanded: false, showImages: false, isError: false,
		durationMs: isPartial ? undefined : 10, outputPad: 1, keyText: () => "", keyHint: () => "",
	});
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const result = { content: [], details: { calls: [] } };
	const renderResult = codemodeRenderers.renderResult;
	assert.ok(renderResult);

	renderResult(result, { expanded: false, isPartial: true }, theme, context(true, false));
	assert.equal(state.timer, undefined);
	renderResult(result, { expanded: false, isPartial: true }, theme, context(true));
	assert.notEqual(state.timer, undefined);
	renderResult(result, { expanded: false, isPartial: false }, theme, context(false));
	assert.equal(state.timer, undefined);
});
