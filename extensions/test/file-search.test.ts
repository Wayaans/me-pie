import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import {
	initTheme,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Component, TUI } from "@earendil-works/pi-tui";
import fileSearchTools, {
	installNotifications,
	makeBinaryInitializers,
} from "../file-search/index.ts";
import {
	FD_DEFAULT_LIMIT,
	buildFdArgs,
	buildRgArgs,
	normalizeSearchPath,
} from "../file-search/src/args.ts";
import {
	InstallError,
	TOOL_SPECS,
	releaseAsset,
	resolveBinary,
	type BinaryEnv,
	type ReleaseAsset,
	type ResolvedBinary,
} from "../file-search/src/binaries.ts";
import { formatOutput } from "../file-search/src/output.ts";

function makeEnvironment(options: { available?: string[]; failInstall?: boolean } = {}) {
	const installed = new Set<string>();
	const installs: ReleaseAsset[] = [];
	const environment: BinaryEnv = {
		probe: (command) =>
			Effect.sync(() => options.available?.includes(command) === true || installed.has(command)),
		install: (asset, destination) => {
			if (options.failInstall) {
				return Effect.fail(new InstallError({ message: "network down" }));
			}
			return Effect.sync(() => {
				installs.push(asset);
				installed.add(destination);
			});
		},
	};
	return { environment, installs };
}

const darwinArm = { os: "darwin", arch: "arm64" } as const;

test("fd constructs safe arguments and normalizes paths", () => {
	assert.deepEqual(
		buildFdArgs({ pattern: "-rf", path: "@src", extension: ".ts", hidden: true, limit: 50 }),
		[
			"--color=never",
			"--hidden",
			"--extension",
			"ts",
			"--max-results",
			"50",
			"--",
			"-rf",
			"src",
		],
	);
	assert.deepEqual(buildFdArgs({}), [
		"--color=never",
		"--max-results",
		String(FD_DEFAULT_LIMIT),
		"--",
		"",
	]);
	assert.equal(normalizeSearchPath("~"), homedir());
	assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
});

test("rg uses smart case and keeps patterns behind the option separator", () => {
	assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
		"--line-number",
		"--color=never",
		"--no-heading",
		"--with-filename",
		"--smart-case",
		"--max-count",
		"100",
		"--",
		"--help",
	]);
});

test("binary resolution prefers the system and accepts Debian fdfind", async () => {
	const { environment, installs } = makeEnvironment({ available: ["fdfind"] });
	const resolved = await Effect.runPromise(
		resolveBinary(TOOL_SPECS.fd, "/cache", darwinArm, environment),
	);
	assert.deepEqual(resolved, { tool: "fd", command: "fdfind", source: "system" });
	assert.equal(installs.length, 0);
});

test("missing binaries are installed from verified release metadata", async () => {
	const { environment, installs } = makeEnvironment();
	const resolved = await Effect.runPromise(
		resolveBinary(TOOL_SPECS.rg, "/cache", darwinArm, environment),
	);
	assert.equal(resolved.source, "installed");
	assert.equal(installs.length, 1);
	assert.match(installs[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
});

test("one failed initializer does not disable the other tool", async () => {
	const { environment } = makeEnvironment({ available: ["rg"], failInstall: true });
	const initializers = makeBinaryInitializers("/cache", darwinArm, environment);
	await assert.rejects(Effect.runPromise(initializers.fd), /network down/);
	assert.deepEqual(await Effect.runPromise(initializers.rg), {
		tool: "rg",
		command: "rg",
		source: "system",
	});
});

test("release metadata supports macOS and Linux on arm64 and x64", () => {
	for (const os of ["darwin", "linux"] as const) {
		for (const arch of ["arm64", "x64"] as const) {
			for (const tool of ["fd", "rg"] as const) {
				const asset = releaseAsset(tool, { os, arch });
				assert.ok(asset);
				assert.match(asset.url, /^https:\/\//);
				assert.match(asset.sha256, /^[a-f0-9]{64}$/);
			}
		}
	}
});

test("only freshly installed binaries produce notifications", () => {
	const binaries: ResolvedBinary[] = [
		{ tool: "fd", command: "fd", source: "system" },
		{ tool: "rg", command: "/cache/rg", source: "installed", version: "15.2.0" },
	];
	assert.equal(installNotifications(binaries).length, 1);
});

test("large output is truncated and its complete form is persisted", async () => {
	const output = Array.from({ length: 3_000 }, (_, index) => `file-${index}.ts`).join("\n");
	let persisted = "";
	const formatted = await formatOutput(output, {
		tempPrefix: "mepie-fd-test-",
		persistFullOutput: async (full) => {
			persisted = full;
			return "/tmp/mepie-search/output.txt";
		},
	});
	assert.equal(persisted, output);
	assert.equal(formatted.truncated, true);
	assert.match(formatted.text, /2000 of 3000 lines/);
	assert.equal(formatted.fullOutputPath, "/tmp/mepie-search/output.txt");
});

interface RenderedSearchTool {
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

function registeredSearchTools(): Map<string, RenderedSearchTool> {
	const tools = new Map<string, RenderedSearchTool>();
	const pi = {
		on() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as unknown as RenderedSearchTool);
		},
	};
	fileSearchTools(pi as unknown as ExtensionAPI);
	return tools;
}

function renderCompletedSearch(
	tool: RenderedSearchTool,
	args: unknown,
	result: AgentToolResult<unknown>,
	expanded = false,
	theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme,
	width = 120,
): { readonly call: string; readonly result: string } {
	const context = {
		args,
		toolCallId: "search-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: true,
		isError: false,
	};
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

initTheme();

test("file-search rows omit Pi's leading tool spacer", async () => {
	type EventHandler = (event: unknown, context: { readonly mode: string }) => unknown;
	const handlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, RenderedSearchTool>();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as unknown as RenderedSearchTool);
		},
	};
	fileSearchTools(pi as unknown as ExtensionAPI);

	const spacingStart = handlers.get("session_start")?.[0];
	const spacingShutdown = handlers.get("session_shutdown")?.[0];
	assert.ok(spacingStart);
	assert.ok(spacingShutdown);
	await spacingStart({}, { mode: "tui" });

	try {
		const fd = tools.get("fd");
		assert.ok(fd);
		const component = new ToolExecutionComponent(
			"fd",
			"search-1",
			{ pattern: "*.ts", path: "src" },
			{},
			fd as unknown as ToolDefinition,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		assert.notEqual(component.render(120)[0], "");
	} finally {
		await spacingShutdown({}, { mode: "tui" });
	}
});

test("file-search uses the compact Mepie tool renderer", () => {
	const tools = registeredSearchTools();
	const fd = tools.get("fd");
	const rg = tools.get("rg");
	assert.ok(fd);
	assert.ok(rg);
	assert.equal(fd.renderShell, "self");
	assert.equal(rg.renderShell, "self");

	const fdResult = renderCompletedSearch(
		fd,
		{ pattern: "*.ts", path: "src" },
		{
			content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
			details: { binarySource: "system", matchCount: 2, truncated: false },
		},
	);
	assert.equal(fdResult.call, "Fd *.ts in src · 2 entries");
	assert.equal(fdResult.result, "");

	const rgResult = renderCompletedSearch(
		rg,
		{ pattern: "renderCall", path: "extensions", glob: "*.ts" },
		{
			content: [{ type: "text", text: "a.ts:1:renderCall\nb.ts:2:renderCall" }],
			details: { binarySource: "system", outputLines: 2, truncated: true },
		},
		true,
	);
	assert.equal(rgResult.call, "Rg /renderCall/ in extensions · *.ts · 2 lines · truncated");
	assert.match(rgResult.result, /a\.ts:1:renderCall/);
	assert.match(rgResult.result, /b\.ts:2:renderCall/);

	const taggedTheme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as unknown as Theme;
	const styledRgResult = renderCompletedSearch(
		rg,
		{ pattern: "renderCall", path: "extensions", glob: "*.ts" },
		{
			content: [{ type: "text", text: "a.ts:1:renderCall\nb.ts:2:renderCall" }],
			details: { binarySource: "system", outputLines: 2, truncated: true },
		},
		false,
		taggedTheme,
		300,
	);
	assert.equal(
		styledRgResult.call,
		"<toolTitle><b>Rg</b></toolTitle> <muted>/renderCall/ in extensions</muted>" +
			"<dim> · </dim><muted>*.ts</muted><dim> · </dim><success>2 lines</success>" +
			"<dim> · </dim><warning>truncated</warning>",
	);
});
