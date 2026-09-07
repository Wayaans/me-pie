import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Exit } from "effect";
import { readRepositoryFile, repositoryListing, MAX_FILE_BYTES } from "../webweb/github-files.ts";
import { cleanupGitHubSession, createGitHubSession, parseGitHubUrl, serveGitHub, type ExecLike } from "../webweb/github.ts";
import { terminalText } from "../webweb/terminal.ts";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webweb from "../webweb/index.ts";
import { runFetch } from "../webweb/fetch.ts";
import { formatFetchResult } from "../webweb/output.ts";

async function fixture(run: (root: string, outside: string) => Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "webweb-containment-"));
	const root = path.join(dir, "repo");
	try {
		await mkdir(root);
		const outside = path.join(dir, "outside.txt");
		await writeFile(outside, "outside fixture, never return this");
		await run(root, outside);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function expectInterrupted(exit: Exit.Exit<unknown, unknown>) {
	expect(Exit.isFailure(exit)).toBe(true);
	if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Interrupt")).toBe(true);
}

describe("GitHub file containment", () => {
	test("rejects README/blob symlinks and traversal through a directory symlink", async () => {
		await fixture(async (root, outside) => {
			await symlink(outside, path.join(root, "README.md"));
			await symlink(path.dirname(outside), path.join(root, "docs"));
			await expect(readRepositoryFile(root, "README.md")).rejects.toThrow("symlinks");
			await expect(readRepositoryFile(root, "docs/outside.txt")).rejects.toThrow("symlinks");
			await expect(repositoryListing(root, "docs")).rejects.toThrow("symlinks");
			await expect(readRepositoryFile(root, "../outside.txt")).rejects.toThrow("escapes");
			await expect(readRepositoryFile(root, outside)).rejects.toThrow("escapes");
		});
	});

	test("reads regular files but rejects internal symlinks and directories", async () => {
		await fixture(async (root) => {
			await writeFile(path.join(root, "real.txt"), "safe");
			await symlink("real.txt", path.join(root, "alias.txt"));
			await expect(readRepositoryFile(root, "real.txt")).resolves.toBe("safe");
			await expect(readRepositoryFile(root, "alias.txt")).rejects.toThrow("symlinks");
			await expect(readRepositoryFile(root, "")).rejects.toThrow("regular file");
		});
	});

	test("bounds a large sparse file read and labels truncation", async () => {
		await fixture(async (root) => {
			const handle = await open(path.join(root, "large.txt"), "w");
			try {
				await handle.write("prefix");
				await handle.truncate(512 * 1024 * 1024);
			} finally { await handle.close(); }
			const text = await readRepositoryFile(root, "large.txt");
			expect(text.startsWith("prefix")).toBe(true);
			expect(text.endsWith("[File truncated at 50KB]")).toBe(true);
			expect(Buffer.byteLength(text)).toBeLessThan(MAX_FILE_BYTES + 100);
		});
	});

	test("repository-root fetch rejects a symlink README from the clone", async () => {
		await fixture(async (_root, outside) => {
			const session = createGitHubSession();
			const sha = "a".repeat(40);
			const exec: ExecLike = async (_command, args) => {
				if (args[0] === "ls-remote") return { code: 0, stdout: `${sha}\tHEAD\n`, stderr: "" };
				if (args[0] === "init") {
					const dest = args.at(-1);
					if (!dest) throw new Error("Missing clone destination");
					await mkdir(dest);
					await symlink(outside, path.join(dest, "README.md"));
				}
				return { code: 0, stdout: args.includes("rev-parse") ? sha : "", stderr: "" };
			};
			try {
				await expect(Effect.runPromise(serveGitHub("https://github.com/test/repo", session, exec, undefined, true))).rejects.toThrow("symlinks");
			} finally { await cleanupGitHubSession(session); }
		});
	});

	test("rejects credential-bearing and non-HTTP GitHub URLs", () => {
		for (const url of ["ftp://github.com/test/repo", "https://user:password@github.com/test/repo", "https://github.com:8080/test/repo", "https://github.com/test/.git"]) {
			expect(parseGitHubUrl(url)).toBeNull();
		}
	});
});

describe("GitHub cancellation", () => {
	test("pre-aborted calls create no clones or subprocesses", async () => {
		const session = createGitHubSession();
		let calls = 0;
		const exec: ExecLike = async () => { calls++; return { code: 0, stdout: "", stderr: "" }; };
		expectInterrupted(await Effect.runPromiseExit(serveGitHub("https://github.com/test/repo", session, exec, AbortSignal.abort(), true)));
		expect(calls).toBe(0);
		expect(session.cloneDirs.size).toBe(0);
	});

	test("inflight abort reaches the subprocess and prevents clone fallback", async () => {
		const session = createGitHubSession();
		const controller = new AbortController();
		let calls = 0;
		let childAborted = false;
		let started: () => void = () => {};
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const exec: ExecLike = async (_command, _args, options) => {
			calls++;
			const signal = options?.signal;
			if (!signal) throw new Error("Missing subprocess signal");
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => { childAborted = true; resolve({ code: 1, stdout: "", stderr: "cancelled" }); }, { once: true });
				started();
			});
		};
		try {
			const pending = Effect.runPromiseExit(serveGitHub("https://github.com/test/repo/tree/main", session, exec, controller.signal, true));
			await ready;
			controller.abort();
			expectInterrupted(await pending);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(childAborted).toBe(true);
			expect(calls).toBe(1);
		} finally { await cleanupGitHubSession(session); }
	});
});

interface CapturedTool {
	name: string;
	execute(id: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	renderResult(result: { content: Array<{ type: "text"; text: string }> }, options: { expanded: boolean }, theme: unknown): Text;
}

function registeredTools(): Array<CapturedTool> {
	const tools: Array<CapturedTool> = [];
	// This registration-only fixture supplies the three API members the factory uses.
	webweb({ registerTool: (tool: CapturedTool) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
	return tools;
}

describe("URL credential containment", () => {
	test("rejected URLs never echo userinfo and never invoke a provider", async () => {
		const url = "https://user:dummy-url-secret@127.0.0.1/file";
		const run = await Effect.runPromise(runFetch({ url }, { config: {
			firecrawlApiKey: null, openaiApiKey: null, openaiSearchModel: "unused", firecrawlApiVersion: "v2", firecrawlBaseUrl: "https://api.firecrawl.dev",
		} }));
		const text = formatFetchResult(run);
		expect(text).toContain("FAILED:");
		expect(text).not.toContain("dummy-url-secret");
		expect(text).not.toContain("user:");
		const session = createGitHubSession();
		await expect(Effect.runPromise(serveGitHub("https://user:dummy-url-secret@github.com/test/repo", session, async () => { throw new Error("Must not execute"); }, undefined, true))).rejects.not.toThrow("dummy-url-secret");
		expect(session.cloneDirs.size).toBe(0);
	});
});

describe("registered tool boundaries", () => {
	test("all expanded renderers sanitize external content", () => {
		const content = [{ type: "text" as const, text: "external\x1b]52;c;ZHVtbXk=\x07\x1b[2Jtext" }];
		const tools = registeredTools();
		expect(tools).toHaveLength(3);
		for (const tool of tools) {
			expect(tool.renderResult({ content }, { expanded: true }, {}).render(80).join("\n")).not.toContain("\x1b");
		}
		expect(content[0]?.text).toContain("\x1b");
	});

	test("pre-aborted tool calls stop before configuration, cache or provider access", async () => {
		for (const tool of registeredTools()) {
			await expect(tool.execute("cancelled", { query: "test", url: "https://example.com", responseId: "deadbeef" }, AbortSignal.abort())).rejects.toThrow();
		}
	});
});

describe("terminal-safe external text", () => {
	test("removes CSI, OSC, C1, unterminated escapes and bidi overrides", () => {
		const payload = "before\x1b[2J\x1b]52;c;ZHVtbXk=\x07\x9b31m\x1b]unterminated\u202eevil\x00after";
		const safe = terminalText(payload);
		expect(safe).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
		expect(new Text(safe, 0, 0).render(80).join("\n")).not.toContain("\x1b");
	});

	test("preserves normal Unicode, tabs, line breaks, and markdown", () => {
		const value = "# Café 漢字\n\t[link](https://example.com)";
		expect(terminalText(value)).toBe(value);
	});
});
