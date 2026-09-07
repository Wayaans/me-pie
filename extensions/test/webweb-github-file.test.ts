import { describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { createGitHubSession, serveGitHub, type ExecLike } from "../webweb/github.ts";
import { runFetch } from "../webweb/fetch.ts";
import { runRead } from "../webweb/read.ts";
import type { CacheEntry } from "../webweb/cache.ts";
import { formatFetchResult } from "../webweb/output.ts";
import { MAX_FILE_BYTES } from "../webweb/github-files.ts";
import { PAGE_BODY_LIMIT } from "../webweb/network.ts";
import { withHttpFixture } from "./webweb-http-fixture.ts";

const sha = "a".repeat(40);
const blob = `https://github.com/test/repo/blob/${sha}/src/file.ts`;
const config = { firecrawlApiKey: "fixture-provider-key", openaiApiKey: null, openaiSearchModel: "fixture", firecrawlApiVersion: "v2" as const, firecrawlBaseUrl: "https://provider.invalid" };
const noExec: ExecLike = async () => { throw new Error("Single SHA file must not execute git"); };

function memoryStore() {
	const entries = new Map<string, CacheEntry>();
	return { write: (entry: CacheEntry) => { entries.set(entry.id, entry); return Effect.void; }, read: (id: string) => Effect.succeed(entries.get(id) ?? null) };
}

describe("direct GitHub files", () => {
	test("raw and readable SHA files use one pinned request, no exec, checkout or provider, and are cacheable", async () => {
		const nativeFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No repository-size or provider fetch allowed"));
		try { await withHttpFixture((req, res) => {
			expect(req.headers.host).toBe("raw.githubusercontent.com");
			expect(req.headers.authorization).toBeUndefined();
			expect(req.headers.cookie).toBeUndefined();
			res.writeHead(200, { "content-type": "application/octet-stream" });
			res.end("export const value = 1;\n");
		}, async (transport, urls) => {
			for (const mode of ["raw", "readable"] as const) {
				const github = createGitHubSession();
				const store = memoryStore();
				const run = await Effect.runPromise(runFetch({ url: blob, mode }, {
					config, github, store, lookup: transport.lookup, githubRequest: transport.request,
					fetchLike: async () => { throw new Error("Must not call a provider or repository size API"); },
				}));
				expect(run.items[0]).toMatchObject({ status: "fetched", provider: "github", repoPath: null, fileCount: 1 });
				expect(github.cloneDirs.size).toBe(0);
				expect(formatFetchResult(run)).not.toContain("repository preview");
				expect(run.responseId).not.toBeNull();
				if (!run.responseId) throw new Error("Missing cached file");
				const read = await Effect.runPromise(runRead({ responseId: run.responseId }, { store }));
				expect(read.source).toMatchObject({ contentKind: "fetched-page", fetchedUrl: `https://raw.githubusercontent.com/test/repo/${sha}/src/file.ts` });
				expect(read.slice).toContain(`Commit: ${sha}`);
				expect(read.slice).toContain("export const value = 1;");
			}
			expect(urls).toEqual(Array(2).fill(`https://raw.githubusercontent.com/test/repo/${sha}/src/file.ts`));
			expect(nativeFetch).not.toHaveBeenCalled();
		}); } finally { nativeFetch.mockRestore(); }
	});

	test("encodes file components once, ignores query and fragment, and never follows raw symlink text", async () => {
		await withHttpFixture((_req, res) => res.end("../../outside/private-file"), async (transport, urls) => {
			const session = createGitHubSession();
			const result = await Effect.runPromise(serveGitHub(`https://github.com/test/repo/blob/${sha}/space%20name/%252F%23%3F.ts?download=1#L42`, session, noExec, undefined, false, transport));
			expect(urls).toEqual([`https://raw.githubusercontent.com/test/repo/${sha}/space%20name/%252F%23%3F.ts`]);
			expect(result.text).toContain("../../outside/private-file");
			expect(session.cloneDirs.size).toBe(0);
		});
	});

	for (const [name, status, type, body, error] of [
		["missing file", 404, "text/plain", "missing", "HTTP 404"],
		["binary MIME", 200, "image/png", "fake PNG", "binary"],
		["binary octet stream", 200, "application/octet-stream", Buffer.from([0, 1, 2]), "binary"],
		["invalid UTF-8", 200, "text/plain", Buffer.from([0xff]), "not UTF-8"],
		["oversized file", 200, "text/plain", "x".repeat(PAGE_BODY_LIMIT + 1), "byte limit"],
	] as const) {
		test(`${name} fails explicitly without cloning or fallback`, async () => {
			await withHttpFixture((_req, res) => { res.writeHead(status, { "content-type": type }); res.end(body); }, async (transport, urls) => {
				const session = createGitHubSession();
				await expect(Effect.runPromise(serveGitHub(blob, session, noExec, undefined, false, transport))).rejects.toThrow(error);
				expect(urls).toHaveLength(1);
				expect(session.cloneDirs.size).toBe(0);
			});
		});
	}

	test("caps previews without splitting UTF-8 characters", async () => {
		await withHttpFixture((_req, res) => res.end("x".repeat(MAX_FILE_BYTES - 1) + "é"), async (transport) => {
			const result = await Effect.runPromise(serveGitHub(blob, createGitHubSession(), noExec, undefined, false, transport));
			expect(result.text).toEndWith("x\n\n[File truncated at 50KB]");
			expect(result.text).not.toContain("�");
		});
	});

	test("cancellation interrupts a stalled raw body", async () => {
		const controller = new AbortController();
		await withHttpFixture((_req, res) => { res.writeHead(200); res.write("partial"); controller.abort(); }, async (transport) => {
			const exit = await Effect.runPromiseExit(serveGitHub(blob, createGitHubSession(), noExec, controller.signal, false, transport));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) => reason._tag === "Interrupt")).toBe(true);
		});
	});

	test("private DNS and private redirects fail before a private connection", async () => {
		await withHttpFixture((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1/private" }); res.end(); }, async (transport, urls) => {
			await expect(Effect.runPromise(serveGitHub(blob, createGitHubSession(), noExec, undefined, false, { ...transport, lookup: async () => [{ address: "127.0.0.1", family: 4 }] }))).rejects.toThrow("private or reserved");
			expect(urls).toHaveLength(0);
			await expect(Effect.runPromise(serveGitHub(blob, createGitHubSession(), noExec, undefined, false, transport))).rejects.toThrow("private or reserved");
			expect(urls).toHaveLength(1);
		});
	});

	test("named refs require exec, while invalid refs never fall back or request a file", async () => {
		await withHttpFixture((_req, res) => res.end("unexpected"), async (transport, urls) => {
			const named = "https://github.com/test/repo/blob/missing/file.ts";
			await expect(Effect.runPromise(serveGitHub(named, createGitHubSession(), undefined, undefined, false, transport))).rejects.toThrow("requires exec");
			const calls: Array<Array<string>> = [];
			await expect(Effect.runPromise(serveGitHub(named, createGitHubSession(), async (_command, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }, undefined, false, transport))).rejects.toThrow("No default-branch fallback");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe("ls-remote");
			expect(urls).toHaveLength(0);
		});
	});
});

test("Webweb guidance leads with usage and names tools in every flat guideline", async () => {
	const source = await readFile(new URL("../webweb/index.ts", import.meta.url), "utf8");
	for (const name of ["search", "fetch", "read"]) {
		const block = source.split(`const ${name}Tool =`)[1]?.split("parameters:")[0];
		if (!block) throw new Error(`Missing ${name} metadata`);
		expect(block).toContain(`"Use ww_${name}`);
		const guidelines = block.match(/promptGuidelines: \[([\s\S]*?)\]/)?.[1];
		if (!guidelines) throw new Error(`Missing ${name} guidelines`);
		for (const guideline of guidelines.matchAll(/"([^"\n]+)"/g)) expect(guideline[1]).toContain(`ww_${name}`);
	}
	expect(source).toContain("Prefer find_docs over ww_search for library and API documentation");
	expect(source).toContain("Before repeating ww_fetch, use ww_read with an existing responseId");
	expect(source).toContain("without factual verdicts or confidence scores");
});
