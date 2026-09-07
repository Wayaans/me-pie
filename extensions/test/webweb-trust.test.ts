import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { firecrawlSearch, type FetchLike } from "../webweb/firecrawl.ts";
import { openaiSearch } from "../webweb/openai.ts";
import { runSearch, runVerify, searchOneQuery } from "../webweb/search.ts";
import { cacheStore, type CacheEntry } from "../webweb/cache.ts";
import { runRead } from "../webweb/read.ts";
import { formatReadResult, formatSearchResult } from "../webweb/output.ts";
import { buildVerifyArtifact, formatVerifyArtifact } from "../webweb/verify.ts";
import { withHttpFixture } from "./webweb-http-fixture.ts";
import { cleanupGitHubSession, createGitHubSession, parseGitHubUrl, serveGitHub, type ExecLike, type GitHubTransport } from "../webweb/github.ts";

const config = {
	firecrawlApiKey: "fixture-firecrawl", openaiApiKey: "fixture-openai", openaiSearchModel: "fixture-model",
	firecrawlApiVersion: "v2" as const, firecrawlBaseUrl: "https://api.firecrawl.dev",
};
const firecrawlDeps = { apiKey: config.firecrawlApiKey, apiVersion: config.firecrawlApiVersion, baseUrl: config.firecrawlBaseUrl };
const openaiDeps = { apiKey: config.openaiApiKey, model: config.openaiSearchModel };
const openaiPayload = { output: [
	{ type: "web_search_call", action: { sources: [
		{ url: "https://a.dev", title: "Consulted A" }, { url: "https://b.dev", title: "Uncited B" }, { url: "https://a.dev" },
	] } },
	{ type: "message", content: [
		{ type: "output_text", text: "  Generated assertion. ", annotations: [
			{ type: "url_citation", url: "https://a.dev", title: "Cited A", start_index: 2, end_index: 11 },
			{ type: "url_citation", url: "https://a.dev", start_index: 12, end_index: 21 },
		] },
		{ type: "output_text", text: "Second generated assertion.", annotations: [
			{ type: "url_citation", url: "https://c.dev", title: "Citation-only C", start_index: 0, end_index: 6 },
			{ type: "url_citation", url: "https://c.dev", start_index: -1, end_index: 900 },
		] },
	] },
] };

function memoryStore() {
	const entries = new Map<string, CacheEntry>();
	return { write: (entry: CacheEntry) => { entries.set(entry.id, entry); return Effect.void; }, read: (id: string) => Effect.succeed(entries.get(id) ?? null) };
}

function mockProvider(payload: unknown = openaiPayload) {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchLike: FetchLike = async (url, init) => {
		const body: unknown = JSON.parse(init?.body ?? "{}");
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected request object");
		calls.push({ url: String(url), body: body as Record<string, unknown> });
		return Response.json(payload);
	};
	return { calls, fetchLike };
}

describe("search constraints", () => {
	for (const [filter, tbs] of [["day", "qdr:d"], ["week", "qdr:w"], ["month", "qdr:m"], ["year", "qdr:y"]]) {
		test(`Firecrawl preserves ${filter} recency and included domains`, async () => {
			const { calls, fetchLike } = mockProvider({ success: true, data: { web: [] } });
			await Effect.runPromise(firecrawlSearch("q", { numResults: 5, domainFilter: ["Docs.Example.com"], recencyFilter: filter }, { ...firecrawlDeps, fetchLike }));
			expect(calls[0]?.body).toMatchObject({ includeDomains: ["docs.example.com"], tbs, sources: ["web"] });
			expect(calls[0]?.body).not.toHaveProperty("excludeDomains");
		});
	}
	test("excluded domains reach both providers, including fallback", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const fetchLike: FetchLike = async (url, init) => {
			calls.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
			return String(url).includes("firecrawl") ? Response.json({ error: "fixture primary failure" }, { status: 401 }) : Response.json(openaiPayload);
		};
		const run = await Effect.runPromise(searchOneQuery("q", { domainFilter: ["-example.com"] }, 1, { fetchLike }, config));
		expect(run.outcome.provider).toBe("openai");
		expect(calls[0]).toMatchObject({ excludeDomains: ["example.com"] });
		expect(calls[1]).toMatchObject({ tools: [{ type: "web_search", filters: { blocked_domains: ["example.com"] } }] });
	});
	test("OpenAI sends allowed_domains", async () => {
		const { calls, fetchLike } = mockProvider();
		await Effect.runPromise(openaiSearch("q", { numResults: 2, domainFilter: ["example.com"] }, { ...openaiDeps, fetchLike }));
		expect(calls[0]?.body).toMatchObject({ tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }] });
	});
	test("mixed or invalid domain filters fail before provider calls", async () => {
		const { calls, fetchLike } = mockProvider();
		for (const domainFilter of [["example.com", "-bad.com"], ["https://example.com"], ["example.com/path"], ["-"], [""], ["*.example.com"]]) {
			await expect(Effect.runPromise(searchOneQuery("q", { domainFilter }, 2, { fetchLike }, config))).rejects.toThrow("domainFilter");
		}
		expect(calls).toHaveLength(0);
	});
	test("recency cannot silently fall back to OpenAI", async () => {
		const { calls, fetchLike } = mockProvider();
		await expect(Effect.runPromise(openaiSearch("q", { numResults: 2, recencyFilter: "day" }, { ...openaiDeps, fetchLike }))).rejects.toThrow("cannot honor recencyFilter");
		expect(calls).toHaveLength(0);
		let primaryCalls = 0;
		const failedPrimary: FetchLike = async (url) => {
			expect(String(url)).toContain("firecrawl");
			primaryCalls++;
			return Response.json({ error: "fixture primary failure" }, { status: 401 });
		};
		await expect(Effect.runPromise(searchOneQuery("q", { recencyFilter: "week" }, 2, { fetchLike: failedPrimary }, config))).rejects.toThrow("fallback refused");
		expect(primaryCalls).toBe(1);
	});
	test("v1 constrained search fails explicitly", async () => {
		const { calls, fetchLike } = mockProvider();
		await expect(Effect.runPromise(firecrawlSearch("q", { numResults: 2, domainFilter: ["example.com"] }, { ...firecrawlDeps, apiVersion: "v1", fetchLike }))).rejects.toThrow("requires API v2");
		expect(calls).toHaveLength(0);
	});
});

describe("evidence provenance", () => {
	test("all consulted/cited sources survive merging and answer slices never become snippets", async () => {
		const { fetchLike } = mockProvider();
		const outcome = await Effect.runPromise(openaiSearch("q", { numResults: 1 }, { ...openaiDeps, fetchLike }));
		expect(outcome.results.map(({ url }) => url)).toEqual(["https://a.dev", "https://b.dev", "https://c.dev"]);
		expect(outcome.results.every(({ snippet }) => snippet === "")).toBe(true);
		expect(outcome.results[0]?.title).toBe("Cited A");
		expect(outcome.citations).toHaveLength(4);
		expect(outcome.citations[0]).toMatchObject({ startIndex: 2, endIndex: 11 });
		expect(outcome.citations[2]).toMatchObject({ startIndex: 23, endIndex: 29 });
		expect(outcome.citations[3]).toMatchObject({ startIndex: null, endIndex: null });
		const artifact = buildVerifyArtifact("Generated assertion", outcome.results, [], outcome.answer, outcome.citations);
		expect(artifact.passages).toHaveLength(0);
		expect(artifact.status).toBe("not-assessed");
		expect(formatVerifyArtifact(artifact)).toContain("Generated answer, not source text");
		expect(formatVerifyArtifact(artifact)).toContain("does not establish absence of evidence");
	});
	test("verify never caches generated prose as evidence", async () => {
		const { fetchLike } = mockProvider();
		const store = memoryStore();
		const run = await Effect.runPromise(runVerify({ claim: "Generated assertion" }, { config: { ...config, firecrawlApiKey: null }, fetchLike, store }));
		expect(run.artifact.passages).toHaveLength(0);
		if (!run.responseId) throw new Error("Missing cache id");
		const entry = await Effect.runPromise(store.read(run.responseId));
		expect(entry?.sources).toHaveLength(3);
		expect(entry?.sources.every((source) => source.content === "" && source.contentKind === "unavailable")).toBe(true);
	});
	test("fetched passages use the claim, not an unrelated snippet, and preserve redirect provenance", () => {
		const artifact = buildVerifyArtifact("effect requires bun", [{ url: "https://old.dev", title: "Old", snippet: "Generic weather forecast." }], [
			{ requestedUrl: "https://old.dev", url: "https://new.dev", title: "New", content: "Weather is sunny. Effect does not require Bun." },
		]);
		expect(artifact.passages).toEqual([
			{ passageId: "p-1-0", sourceUrl: "https://old.dev", sourceRank: 1, text: "Generic weather forecast.", provenance: "search-snippet" },
			{ passageId: "p-1-1", sourceUrl: "https://new.dev", sourceRank: 1, text: "Effect does not require Bun.", provenance: "fetched-page-excerpt" },
		]);
		expect(artifact.status).toBe("not-assessed");
	});
	test("search caches snippets honestly and persists provenance through disk reads", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-provenance-"));
		try {
			const store = cacheStore({ dir });
			const { fetchLike } = mockProvider({ success: true, data: { web: [{ url: "https://a.dev", description: "snippet only" }] } });
			const run = await Effect.runPromise(runSearch({ query: "q" }, { config, fetchLike, store }));
			expect(formatSearchResult(run)).not.toContain("Full source content stored");
			if (!run.responseId) throw new Error("Missing cache id");
			const read = await Effect.runPromise(runRead({ responseId: run.responseId }, { store }));
			expect(read.source?.contentKind).toBe("search-snippet");
			expect(formatReadResult(read)).toContain("search-snippet");
			const matches = await Effect.runPromise(runRead({ responseId: run.responseId, findText: "snippet" }, { store }));
			expect(formatReadResult(matches)).toContain("search-snippet");
		} finally { await rm(dir, { recursive: true, force: true }); }
	});
	test("successful source fetches replace snippet-only cache text with labeled fetched pages", async () => {
		const store = memoryStore();
		const fetchLike: FetchLike = async (url) => Response.json(String(url).endsWith("/search")
			? { success: true, data: { web: [{ url: "https://a.dev", description: "snippet only" }] } }
			: { success: true, data: { markdown: "actual fetched page" } });
		const run = await Effect.runPromise(runSearch({ query: "q", includeContent: true }, {
			config, fetchLike, store, lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		}));
		if (!run.responseId) throw new Error("Missing cache id");
		const entry = await Effect.runPromise(store.read(run.responseId));
		expect(entry?.sources[0]).toMatchObject({ contentKind: "fetched-page", content: "actual fetched page", fetchedUrl: "https://a.dev" });
	});
});

function localGit(args: Array<string>, options?: Parameters<ExecLike>[2]): ReturnType<ExecLike> {
	return new Promise((resolve, reject) => {
		execFile("git", args, {
			...(options?.signal ? { signal: options.signal } : {}), timeout: options?.timeout ?? 10_000, maxBuffer: 1024 * 1024,
			env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
				GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
		}, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") { reject(error); return; }
			resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
		});
	});
}

async function repositoryFixture(run: (fixture: { old: string; head: string; exec: ExecLike; calls: Array<Array<string>>; transport: GitHubTransport }) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "webweb-revision-"));
	const repo = path.join(root, "remote");
	const git = async (args: Array<string>) => {
		const result = await localGit(args);
		if (result.code !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	try {
		await git(["init", "--initial-branch=main", repo]);
		await mkdir(path.join(repo, "docs"));
		await writeFile(path.join(repo, "docs", "space name.md"), "old revision");
		await git(["-C", repo, "add", "."]);
		await git(["-C", repo, "commit", "-m", "old"]);
		const old = await git(["-C", repo, "rev-parse", "HEAD"]);
		await git(["-C", repo, "branch", "feature/slash"]);
		await git(["-C", repo, "tag", "-a", "v1", "-m", "annotated fixture"]);
		await git(["-C", repo, "tag", "release/one"]);
		await writeFile(path.join(repo, "docs", "space name.md"), "new revision");
		await writeFile(path.join(repo, "only-new.txt"), "only on default branch");
		await git(["-C", repo, "add", "."]);
		await git(["-C", repo, "commit", "-m", "new"]);
		const head = await git(["-C", repo, "rev-parse", "HEAD"]);
		await git(["-C", repo, "branch", "release"]);
		await git(["-C", repo, "branch", "collision"]);
		await git(["-C", repo, "tag", "collision", old]);
		const calls: Array<Array<string>> = [];
		const exec: ExecLike = async (command, args, options) => {
			expect(command).toBe("git");
			expect(options?.signal).toBeDefined();
			expect(options?.timeout).toBeGreaterThan(0);
			calls.push(args);
			return localGit(args.map((arg) => arg === "https://github.com/test/repo.git" ? pathToFileURL(repo).href : arg), options);
		};
		await withHttpFixture((req, res) => {
			const pathname = new URL(req.url ?? "/", "https://raw.githubusercontent.com").pathname;
			const commit = pathname.split("/")[3];
			if ((commit === old || commit === head) && pathname.endsWith("/docs/space%20name.md")) {
				res.setHeader("content-type", "text/plain");
				res.end(commit === old ? "old revision" : "new revision");
			} else { res.writeHead(404); res.end(); }
		}, (transport) => run({ old, head, exec, calls, transport }));
	} finally { await rm(root, { recursive: true, force: true }); }
}

describe("exact GitHub revisions", () => {
	test("serves full SHA, branch, annotated/lightweight tags, slash refs, encoded paths and trees from verified commits", async () => {
		await repositoryFixture(async ({ old, head, exec, transport, calls }) => {
			const session = createGitHubSession();
			try {
				for (const [ref, expected] of [[old, old], ["main", head], ["v1", old], ["feature/slash", old], ["feature%2Fslash", old], ["release/one", old]]) {
					const result = await Effect.runPromise(serveGitHub(`https://github.com/test/repo/blob/${ref}/docs/space%20name.md`, session, exec, undefined, true, transport));
					expect(result.repoPath).toBeNull();
					expect(session.cloneDirs.size).toBe(0);
					expect(calls.every((args) => args[0] === "ls-remote")).toBe(true);
					expect(result.text).toContain(`Commit: ${expected}`);
					expect(result.text).toContain(expected === head ? "new revision" : "old revision");
				}
				const tree = await Effect.runPromise(serveGitHub("https://github.com/test/repo/tree/feature/slash/docs", session, exec, undefined, true));
				expect(tree.text).toContain("space name.md");
				expect(tree.text).toContain(`Commit: ${old}`);
				const root = await Effect.runPromise(serveGitHub("https://github.com/test/repo", session, exec, undefined, true));
				expect(root.text).toContain(`Commit: ${head}`);
			} finally { await cleanupGitHubSession(session); }
		});
	});
	test("missing revisions and invalid SHAs fail without default branch fallback", async () => {
		await repositoryFixture(async ({ exec, calls, transport }) => {
			const session = createGitHubSession();
			try {
				await expect(Effect.runPromise(serveGitHub("https://github.com/test/repo/blob/missing/docs/space%20name.md", session, exec, undefined, true))).rejects.toThrow("not found");
				expect(calls).toHaveLength(1);
				await expect(Effect.runPromise(serveGitHub(`https://github.com/test/repo/blob/${"f".repeat(40)}/docs/space%20name.md`, session, undefined, undefined, true, transport))).rejects.toThrow("HTTP 404");
				expect(calls.some((args) => args.includes("clone") || args.includes("checkout"))).toBe(false);
			} finally { await cleanupGitHubSession(session); }
		});
	});
	test("ambiguous branch/tag names and missing files at an old revision never use default-branch files", async () => {
		await repositoryFixture(async ({ old, exec, transport }) => {
			const session = createGitHubSession();
			try {
				await expect(Effect.runPromise(serveGitHub("https://github.com/test/repo/blob/collision/docs/space%20name.md", session, exec, undefined, true))).rejects.toThrow("Ambiguous branch/tag");
				await expect(Effect.runPromise(serveGitHub(`https://github.com/test/repo/blob/${old}/only-new.txt`, session, exec, undefined, true, transport))).rejects.toThrow("HTTP 404");
			} finally { await cleanupGitHubSession(session); }
		});
	});
	test("commit mismatch fails before serving file content", async () => {
		await repositoryFixture(async ({ old, head, exec }) => {
			for (const target of ["FETCH_HEAD^{commit}", "HEAD^{commit}"]) {
				const session = createGitHubSession();
				const wrongCommit: ExecLike = async (command, args, options) => args.at(-1) === target
					? { code: 0, stdout: head, stderr: "" } : exec(command, args, options);
				try {
					await expect(Effect.runPromise(serveGitHub(`https://github.com/test/repo/tree/${old}/docs`, session, wrongCommit, undefined, true))).rejects.toThrow("does not match");
				} finally { await cleanupGitHubSession(session); }
			}
		});
	});
	test("rejects malformed decoding and encoded traversal before git", () => {
		expect(parseGitHubUrl("https://github.com?path=/test/repo")).toBeNull();
		expect(parseGitHubUrl(`https://github.com/test/repo/tree/main/${Array(65).fill("a").join("%2F")}`)).toBeNull();
		for (const suffix of ["main/%GG", "main/%2e%2e/secret", "main/../secret", "main/%2fetc", "main/%5csecret", "main/%00file"]) {
			expect(parseGitHubUrl(`https://github.com/test/repo/blob/${suffix}`)).toBeNull();
		}
	});
});
