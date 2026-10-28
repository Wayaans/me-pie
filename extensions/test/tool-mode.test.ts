import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createBashToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionCommandContext, type ExtensionToolContext, type ToolDefinition, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { registerMepieCommand } from "../mepie/manager.ts";
import mepieToolUi from "../mepie-tool-ui/index.ts";
import fileSearch from "../file-search/index.ts";
import { readToolRenderMode, saveToolRenderMode, TOOL_RENDER_MODES, toolPresentation } from "../mepie/tool-mode.ts";

initTheme();

test("tool mode settings and commands preserve configuration and reload only after saving", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mepie-mode-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.deepEqual(readToolRenderMode(dir), { mode: "compact" });
		const path = join(dir, "mepie.json");
		await writeFile(path, JSON.stringify({ unrelated: { keep: true } }));
		assert.deepEqual(readToolRenderMode(dir), { mode: "compact" });
		await Effect.runPromise(saveToolRenderMode("simple", dir));
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { unrelated: { keep: true }, toolRenderMode: "simple" });

		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		registerMepieCommand({ registerCommand(_name, value) { command = value; } }, readToolRenderMode(dir).mode);
		assert.ok(command);
		assert.deepEqual(command.getArgumentCompletions?.("tool s"), [{ value: "tool simple", label: "tool simple" }]);
		assert.deepEqual(command.getArgumentCompletions?.("tool cu"), [{ value: "tool custom", label: "tool custom" }]);
		const events: string[] = [];
		const context = {
			hasUI: true,
			ui: { notify(message: string) { events.push(message); } },
			async waitForIdle() { events.push("idle"); },
			async reload() {
				assert.equal(readToolRenderMode(dir).mode, "custom");
				events.push("reload");
			},
		} as unknown as ExtensionCommandContext;
		await command.handler("tool simple", context);
		assert.deepEqual(events, []);
		await command.handler("tool", context);
		assert.match(events.pop() ?? "", /simple.*compact, builtin, simple, custom/);
		await command.handler("tool wrong", context);
		assert.match(events.pop() ?? "", /Usage/);
		await command.handler("tool compact extra", context);
		assert.match(events.pop() ?? "", /Usage/);
		await command.handler("tool custom", context);
		assert.deepEqual(events, ["idle", "reload"]);

		for (const invalid of ["{broken", "[]", '{"toolRenderMode":"unknown"}', '{"toolRenderMode":null}']) {
			await writeFile(path, invalid);
			assert.equal(readToolRenderMode(dir).mode, "compact");
			assert.ok(readToolRenderMode(dir).warning);
			events.length = 0;
			await command.handler("tool builtin", context);
			assert.equal(events[0], "idle");
			assert.match(events[1] ?? "", /Could not save/);
			assert.equal(events.some((event: string) => event === "reload"), false);
			assert.equal(await readFile(path, "utf8"), invalid);
		}
		const notDirectory = join(dir, "file");
		await writeFile(notDirectory, "not a directory");
		await assert.rejects(Effect.runPromise(saveToolRenderMode("simple", notDirectory)), /Could not save/);
		await mkdir(join(dir, "nested"));
		assert.equal(readToolRenderMode(join(dir, "nested")).mode, "compact");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("render modes survive reload cycles and file-search reads its mode independently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mepie-render-mode-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const nativeRender = ToolExecutionComponent.prototype.render;
	type Handler = (event: unknown, context: unknown) => unknown;
	try {
		for (const mode of [...TOOL_RENDER_MODES, "compact"] as const) {
			await Effect.runPromise(saveToolRenderMode(mode, dir));
			for (const factory of [mepieToolUi, fileSearch]) {
				const tools = new Map<string, ToolDefinition>();
				const handlers = new Map<string, Handler[]>();
				const rendererResolvers: ToolRendererResolver[] = [];
				factory({
					registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
					registerToolRenderer(resolver: ToolRendererResolver) { rendererResolvers.push(resolver); },
					on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
				} as unknown as ExtensionAPI);
				// Codemode keeps its built-in renderer only in builtin mode.
				assert.equal(rendererResolvers.length, factory === mepieToolUi && mode !== "builtin" ? 1 : 0);
				const start = handlers.get("session_start")?.[0];
				assert.ok(start);
				// Start only spacing, not binary setup or thinking styling.
				await start({}, { mode: "tui", sessionManager: { getBranch: () => [{
					type: "message",
					message: { role: "assistant", content: [
						{ type: "toolCall", id: "previous", name: "read" },
						{ type: "toolCall", id: "row", name: factory === fileSearch ? "fd" : "bash" },
					] },
				}] } });
				assert.equal(ToolExecutionComponent.prototype.render === nativeRender, mode !== "compact" && mode !== "custom");
				try {
					if (mode !== "builtin") {
						for (const tool of tools.values()) {
							const presentation = toolPresentation(mode, tool.name);
							if (presentation === "native-preview") continue;
							assert.equal(tool.renderShell, presentation === "compact" ? "self" : "default");
						}
					}
					const tool = tools.get(factory === fileSearch ? "fd" : "bash");
					assert.ok(tool);
					if (factory === fileSearch && mode === "builtin") {
						assert.equal(tool.renderCall, undefined);
						assert.equal(tool.renderResult, undefined);
					}
					if (factory === mepieToolUi) {
						assert.ok(JSON.stringify(tool.parameters).includes('"purpose"'));
						const result = await tool.execute("bash-test", { command: "printf unchanged", purpose: "Test execution" }, undefined, undefined, { cwd: dir, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as unknown as ExtensionToolContext);
						assert.equal(result.content[0]?.type, "text");
						assert.ok(JSON.stringify(result.content).includes("unchanged"));
					}
					const args = factory === fileSearch ? { pattern: "*.ts" } : { command: "printf unchanged", purpose: "Test execution" };
					const row = new ToolExecutionComponent(tool.name, "row", args, {}, tool, { requestRender() {} } as unknown as TUI, dir);
					row.updateResult({ content: [{ type: "text", text: "first\nlast" }], details: { matchCount: 2 }, isError: false });
					if (mode === "compact" || mode === "custom") assert.equal(row.render(80)[0] === "", factory === fileSearch);
					const collapsed = row.render(80).join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
					if (mode === "simple") {
						const heading = collapsed.split("\n").find((line) => line.includes(factory === fileSearch ? "Fd" : "Bash"));
						assert.ok(heading);
						assert.match(heading, /^ [^ ]/); // Native Box provides the only inset.
					}
					if (mode === "builtin" && factory === mepieToolUi) {
						const native = new ToolExecutionComponent("bash", "row", args, {}, createBashToolDefinition(dir), { requestRender() {} } as unknown as TUI, dir);
						native.updateResult({ content: [{ type: "text", text: "first\nlast" }], details: { matchCount: 2 }, isError: false });
						assert.deepEqual(row.render(80), native.render(80));
					}
					for (const expanded of [false, true]) {
						row.setExpanded(expanded);
						for (const width of [1, 2, 8, 80]) assert.doesNotThrow(() => row.render(width));
						for (const line of row.render(80)) assert.ok(visibleWidth(line) <= 80);
					}
					row.updateResult({ content: [{ type: "text", text: "first error\nlast error" }], isError: true });
					if (mode !== "builtin") {
						row.setExpanded(false);
						assert.ok(row.render(80).join("\n").includes("last error"));
						assert.ok(!row.render(80).join("\n").includes("first error"));
						row.setExpanded(true);
						assert.ok(row.render(80).join("\n").includes("first error"));
					}
				} finally {
					await handlers.get("session_shutdown")?.[0]?.({}, {});
				}
				assert.equal(ToolExecutionComponent.prototype.render, nativeRender);
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	}
});
