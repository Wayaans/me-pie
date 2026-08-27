import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import findDocsExtension from "../find-docs/index.ts";
import {
	findDocumentation,
	parseContext7LibraryId,
	type Context7CommandRunner,
} from "../find-docs/context7.ts";
import {
	formatFindDocsSummary,
	formatFindDocsTarget,
	isCtx7Bash,
	type FindDocsDetails,
} from "../find-docs/utils.ts";

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
	return { code: 0, stdout: "", stderr: "", killed: false, ...overrides };
}

function queuedRunner(responses: ExecResult[]) {
	const calls: Array<{ command: string; args: string[]; options: ExecOptions }> = [];
	const runner: Context7CommandRunner = async (command, args, options) => {
		calls.push({ command, args, options });
		const response = responses.shift();
		if (!response) throw new Error("Unexpected Context7 command");
		return response;
	};
	return { calls, runner };
}

test("find-docs parses the first Context7 JSON library result", async () => {
	assert.equal(
		await Effect.runPromise(parseContext7LibraryId('[{"id":"/facebook/react"},{"id":"/preactjs/preact"}]')),
		"/facebook/react",
	);
	assert.equal(await Effect.runPromise(parseContext7LibraryId("[]")), undefined);
	await assert.rejects(Effect.runPromise(parseContext7LibraryId("not json")), /invalid library search JSON/);
	await assert.rejects(Effect.runPromise(parseContext7LibraryId('[{"name":"React"}]')), /did not return a library ID/);
});

test("find-docs resolves a library with JSON before querying docs", async () => {
	const fake = queuedRunner([
		execResult({ stdout: '[{"id":"/facebook/react"}]' }),
		execResult({ stdout: "React documentation" }),
	]);

	const result = await Effect.runPromise(findDocumentation({ library: " react ", query: " hooks " }, fake.runner));
	assert.deepEqual(result, {
		status: "found",
		library: "react",
		libraryId: "/facebook/react",
		query: "hooks",
		docs: "React documentation",
		resolvedLibrary: true,
	});
	assert.deepEqual(fake.calls.map(({ command, args }) => [command, ...args]), [
		["ctx7", "library", "react", "hooks", "--json"],
		["ctx7", "docs", "/facebook/react", "hooks"],
	]);
	assert.ok(fake.calls.every(({ options }) => options.signal instanceof AbortSignal));
});

test("find-docs accepts a library ID without running resolution", async () => {
	const fake = queuedRunner([execResult({ stdout: "Next.js documentation" })]);
	const result = await Effect.runPromise(findDocumentation({ libraryId: "/vercel/next.js", query: "routing" }, fake.runner));

	assert.equal(result.status, "found");
	assert.deepEqual(fake.calls.map(({ command, args }) => [command, ...args]), [
		["ctx7", "docs", "/vercel/next.js", "routing"],
	]);
});

test("find-docs reports successful empty resolver and docs results", async () => {
	const noLibrary = queuedRunner([execResult({ stderr: "No libraries found" })]);
	assert.deepEqual(
		await Effect.runPromise(findDocumentation({ library: "missing", query: "usage" }, noLibrary.runner)),
		{ status: "library-not-found", library: "missing", query: "usage" },
	);

	const noDocs = queuedRunner([execResult({ stderr: "No documentation found" })]);
	assert.deepEqual(
		await Effect.runPromise(findDocumentation({ libraryId: "/owner/project", query: "missing" }, noDocs.runner)),
		{
			status: "docs-not-found",
			libraryId: "/owner/project",
			query: "missing",
			resolvedLibrary: false,
		},
	);
});

test("find-docs falls back once when the installed command is unavailable", async () => {
	const fake = queuedRunner([
		execResult({ code: 1 }),
		execResult({ stdout: '[{"id":"/facebook/react"}]' }),
		execResult({ stdout: "React documentation" }),
	]);

	await Effect.runPromise(findDocumentation({ library: "react", query: "hooks" }, fake.runner));
	assert.deepEqual(fake.calls.map(({ command, args }) => [command, ...args]), [
		["ctx7", "library", "react", "hooks", "--json"],
		["bunx", "--bun", "ctx7@latest", "library", "react", "hooks", "--json"],
		["bunx", "--bun", "ctx7@latest", "docs", "/facebook/react", "hooks"],
	]);
});

test("find-docs does not fall back after a real command or quota failure", async () => {
	const commandFailure = queuedRunner([execResult({ code: 1, stderr: "network unavailable" })]);
	await assert.rejects(
		Effect.runPromise(findDocumentation({ library: "react", query: "hooks" }, commandFailure.runner)),
		/network unavailable/,
	);
	assert.equal(commandFailure.calls.length, 1);

	const quotaFailure = queuedRunner([execResult({ code: 1, stderr: "Monthly quota reached" })]);
	await assert.rejects(
		Effect.runPromise(findDocumentation({ library: "react", query: "hooks" }, quotaFailure.runner)),
		/ctx7 login/,
	);
	assert.equal(quotaFailure.calls.length, 1);
});

test("find-docs validates semantic input before running commands", async () => {
	const fake = queuedRunner([]);
	await assert.rejects(
		Effect.runPromise(findDocumentation({ library: "react", query: "   " }, fake.runner)),
		/non-empty query/,
	);
	await assert.rejects(
		Effect.runPromise(findDocumentation({ libraryId: "react", query: "hooks" }, fake.runner)),
		/Expected \/owner\/project/,
	);
	await assert.rejects(
		Effect.runPromise(findDocumentation({ query: "hooks" }, fake.runner)),
		/requires either library or libraryId/,
	);
	assert.equal(fake.calls.length, 0);
});

test("find-docs forwards Effect cancellation to the command", async () => {
	let receivedSignal: AbortSignal | undefined;
	const runner: Context7CommandRunner = async (_command, _args, options) => {
		receivedSignal = options.signal;
		return new Promise((resolve) => {
			options.signal?.addEventListener("abort", () => resolve(execResult({ code: 1, killed: true })), { once: true });
		});
	};
	const controller = new AbortController();
	const running = Effect.runPromise(findDocumentation({ library: "react", query: "hooks" }, runner), {
		signal: controller.signal,
	});
	controller.abort();

	await assert.rejects(running);
	assert.equal(receivedSignal?.aborted, true);
});

test("find-docs formats collapsed call and result summaries", () => {
	assert.equal(formatFindDocsTarget({ library: "react", query: "useEffect cleanup" }), "react • useEffect cleanup");
	assert.equal(formatFindDocsTarget({ libraryId: "/vercel/next.js", query: "routing" }), "/vercel/next.js • routing");
	assert.equal(
		formatFindDocsSummary({ status: "found", libraryId: "/facebook/react", query: "hooks" }),
		"/facebook/react • hooks",
	);
	assert.equal(
		formatFindDocsSummary({ status: "library-not-found", library: "react", query: "hooks" }),
		"react • no Context7 match",
	);
	assert.equal(
		formatFindDocsSummary({ status: "docs-not-found", libraryId: "/facebook/react", query: "missing" }),
		"/facebook/react • no matching docs",
	);
	assert.equal(formatFindDocsSummary(undefined), "");
});

test("find-docs detects supported Context7 bash invocations", () => {
	assert.equal(isCtx7Bash("ctx7 docs /facebook/react hooks"), true);
	assert.equal(isCtx7Bash("bunx --bun ctx7@latest library react hooks"), true);
	assert.equal(isCtx7Bash("npx --yes ctx7@latest library react hooks"), true);
	assert.equal(isCtx7Bash("command ctx7 docs /facebook/react hooks"), true);
	assert.equal(isCtx7Bash("npm run docs"), false);
	assert.equal(isCtx7Bash("echo ctx7 docs"), false);
});

test("find-docs blocks direct shell lookup only while its tool is active", async () => {
	type ToolCallHandler = (event: unknown) => Promise<unknown>;
	let handler: ToolCallHandler | undefined;
	let active = false;
	const pi = {
		registerTool() {},
		on(event: string, value: ToolCallHandler) {
			if (event === "tool_call") handler = value;
		},
		getActiveTools() { return active ? ["find_docs"] : []; },
	} as unknown as ExtensionAPI;
	findDocsExtension(pi);
	assert.ok(handler);

	const event = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "bunx --bun ctx7@latest library react hooks" },
	};
	assert.equal(await handler(event), undefined);
	active = true;
	assert.deepEqual(await handler(event), {
		block: true,
		reason: "Use the find_docs tool instead of bash for Context7 documentation lookups.",
	});
});

test("find-docs removes truncated temporary output during session shutdown", async () => {
	type CapturedTool = {
		execute(
			toolCallId: string,
			params: { query: string; libraryId: string },
			signal: AbortSignal,
		): Promise<{ details: FindDocsDetails }>;
	};
	type ShutdownHandler = () => Promise<void>;
	let tool: CapturedTool | undefined;
	let shutdown: ShutdownHandler | undefined;
	const pi = {
		registerTool(value: CapturedTool) { tool = value; },
		on(event: string, value: ShutdownHandler) {
			if (event === "session_shutdown") shutdown = value;
		},
		getActiveTools() { return ["find_docs"]; },
		async exec() { return execResult({ stdout: "line\n".repeat(2_100) }); },
	} as unknown as ExtensionAPI;
	findDocsExtension(pi);
	assert.ok(tool);
	assert.ok(shutdown);

	const result = await tool.execute("call-1", { libraryId: "/owner/project", query: "usage" }, new AbortController().signal);
	assert.equal(result.details.truncated, true);
	const outputPath = result.details.fullOutputPath;
	assert.ok(outputPath);
	await access(outputPath);
	await shutdown();
	await assert.rejects(access(outputPath));
});
