import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEditToolDefinition, createWriteToolDefinition, initTheme, ToolExecutionComponent,
	type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { registerMepieToolUi } from "../mepie-tool-ui/tools.ts";
import { registerMepieToolSpacing } from "../mepie-tool-ui/tool-renderer.ts";
import type { ToolRenderMode } from "../mepie/tool-mode.ts";

initTheme();
const tui = { requestRender() {} } as unknown as TUI;
const plain = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function toolsFor(mode: ToolRenderMode, cwd: string): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	registerMepieToolUi({ registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI, cwd, mode);
	return tools;
}

function rowFor(tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>, cwd: string, id = name) {
	const tool = tools.get(name);
	assert.ok(tool);
	return new ToolExecutionComponent(name, id, args, {}, tool, tui, cwd);
}

function previewLines(row: ToolExecutionComponent): string[] {
	// Keep ANSI, padding, blank lines, and every preview line. Only the header differs.
	return row.render(100).filter((line) => !plain(line).includes("preview.txt"));
}

test("custom edit/write retain native previews, errors, expansion, and Box padding with Mepie summaries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mepie-custom-preview-"));
	try {
		await writeFile(join(dir, "preview.txt"), "before\n");
		const tools = toolsFor("custom", dir);
		for (const name of ["edit", "write"] as const) {
			const native = name === "edit" ? createEditToolDefinition(dir) : createWriteToolDefinition(dir);
			const args = name === "edit"
				? { path: "preview.txt", edits: [{ oldText: "before", newText: "after" }] }
				: { path: "preview.txt", content: Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") };
			for (const isError of [false, true]) {
				const row = rowFor(tools, name, args, dir);
				const reference = new ToolExecutionComponent(name, name, args, {}, native, tui, dir);
				assert.deepEqual(previewLines(row), previewLines(reference));
				// Let edit's native asynchronous pre-execution preview settle.
				await new Promise((resolve) => setTimeout(resolve, 30));
				for (const partial of [true, false]) {
					const result = {
						content: [{ type: "text" as const, text: isError ? "first error\nlast error" : "Done" }],
						...(name === "edit" && !isError ? { details: { diff: "-1 before\n+1 after", firstChangedLine: 1 } } : {}),
						isError,
					};
					row.updateResult(result, partial);
					reference.updateResult(result, partial);
					for (const expanded of [false, true, false]) {
						row.setExpanded(expanded);
						reference.setExpanded(expanded);
						assert.deepEqual(previewLines(row), previewLines(reference), `${name} error=${isError} expanded=${expanded} partial=${partial}`);
						const output = row.render(100).map(plain).join("\n");
						assert.match(output, name === "edit" ? /Edit preview\.txt/ : /Write preview\.txt/);
						if (isError) {
							assert.match(output, /failed/);
							assert.match(output, /first error\s*\n/);
						} else if (!partial) {
							assert.match(output, name === "edit" ? /· \+1 −1/ : /· 15 lines/);
						}
						if (name === "write") {
							assert.equal(output.includes("line 15"), expanded);
							assert.equal(output.includes("to expand"), !expanded);
						}
					}
				}
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("custom keeps every other built-in compact and changes no execution or prompt metadata", () => {
	const custom = toolsFor("custom", process.cwd());
	const compact = toolsFor("compact", process.cwd());
	for (const [name, definition] of custom) {
		const previous = compact.get(name);
		assert.ok(previous);
		assert.deepEqual(definition.parameters, previous.parameters);
		assert.equal(definition.description, previous.description);
		assert.equal(definition.promptSnippet, previous.promptSnippet);
		assert.deepEqual(definition.promptGuidelines, previous.promptGuidelines);
		if (name === "edit" || name === "write") continue;
		const args = { path: "example.ts", pattern: "hello", command: "printf hello", purpose: "Check output" };
		const row = rowFor(custom, name, args, process.cwd());
		const reference = rowFor(compact, name, args, process.cwd());
		for (const expanded of [false, true]) {
			for (const current of [row, reference]) {
				current.updateResult({ content: [{ type: "text", text: "hello\nworld" }], isError: false });
				current.setExpanded(expanded);
			}
			assert.deepEqual(row.render(80), reference.render(80));
		}
	}
});

test("custom boxed rows interrupt compact spacing during streaming and restored history", async () => {
	type Handler = (event: unknown, context: unknown) => unknown;
	const original = ToolExecutionComponent.prototype.render;
	const handlers = new Map<string, Handler[]>();
	const pi = { on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as unknown as ExtensionAPI;
	registerMepieToolSpacing(pi, "custom");
	const tools = toolsFor("custom", process.cwd());
	const calls = ["read", "read", "write", "read", "read", "edit", "read", "read"].map((name, i) => ({ type: "toolCall", name, id: String(i), arguments: {} }));
	const message = { role: "assistant", content: calls };
	const ctx = (entries: unknown[]) => ({ mode: "tui", sessionManager: { getBranch: () => entries } });
	const emit = async (event: string, value: unknown, context: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(value, context);
	};
	try {
		for (const restored of [false, true]) {
			await emit("session_start", { reason: "reload" }, ctx(restored ? [{ type: "message", message }] : []));
			if (!restored) await emit("message_update", { message }, ctx([]));
			for (const [i, call] of calls.entries()) {
				const row = rowFor(tools, call.name, { path: "preview.txt", content: "line" }, process.cwd(), call.id);
				assert.equal(row.render(80)[0] === "", ![1, 4, 7].includes(i), `spacing for ${call.name} at ${i}`);
			}
			await emit("session_shutdown", {}, {});
			assert.equal(ToolExecutionComponent.prototype.render, original);
		}
	} finally {
		await emit("session_shutdown", {}, {});
	}
});
