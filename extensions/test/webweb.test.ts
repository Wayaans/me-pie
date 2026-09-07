import { describe, expect, test } from "bun:test";
import { stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cause, Effect, Exit } from "effect";
import { globalConfigPath, loadConfig, maskKey, setConfigValue } from "../webweb/config.ts";
import { validateRemoteUrl, type LookupFunction } from "../webweb/ssrf.ts";
const publicLookup: LookupFunction = async () => [{ address: "93.184.216.34", family: 4 }];
import { mapSearchResults, buildSnippetAnswer } from "../webweb/firecrawl.ts";
import { runSearch, searchOneQuery, runVerify, fetchTopPages, type SearchDeps } from "../webweb/search.ts";
import { runFetch } from "../webweb/fetch.ts";
import { runRead } from "../webweb/read.ts";
import { parseGitHubUrl } from "../webweb/github.ts";
import { newResponseId, type CacheEntry } from "../webweb/cache.ts";
import { buildVerifyArtifact } from "../webweb/verify.ts";
import { formatSearchResult, formatFetchResult, formatReadResult } from "../webweb/output.ts";
import { handleWebwebCommand, type CommandUi } from "../webweb/command.ts";

const CONFIG = {
	firecrawlApiKey: "fc-test-key" as string | null,
	openaiApiKey: "sk-test-key" as string | null,
	openaiSearchModel: "gpt-test",
	firecrawlApiVersion: "v2" as const,
	firecrawlBaseUrl: "https://api.firecrawl.dev",
};

const configWith = (overrides: Partial<typeof CONFIG>) => ({ ...CONFIG, ...overrides });

async function expectFailure<A, E>(effect: Effect.Effect<A, E, never>): Promise<E> {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) throw new Error(`expected failure, got success: ${JSON.stringify(exit.value)}`);
	const fail = exit.cause.reasons.find((reason): reason is Cause.Fail<E> => reason._tag === "Fail");
	if (!fail) throw new Error(`expected typed failure, got: ${JSON.stringify(exit.cause)}`);
	return fail.error;
}

interface Route {
	match: (url: string, body: string) => boolean;
	status: number;
	body: unknown;
}

function fakeFetch(routes: Array<Route>): { calls: Array<string>; fetchLike: any } {
	const calls: Array<string> = [];
	const fetchLike = async (url: string | URL, init?: { body?: string }) => {
		const target = String(url);
		calls.push(target);
		const route = routes.find((candidate) => candidate.match(target, init?.body ?? ""));
		if (!route) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify(route.body), { status: route.status });
	};
	return { calls, fetchLike };
}

function memoryStore() {
	const entries = new Map<string, CacheEntry>();
	return {
		write: (entry: CacheEntry) => {
			entries.set(entry.id, entry);
			return Effect.void;
		},
		read: (id: string) => Effect.succeed(entries.get(id) ?? null),
	};
}

function firecrawlSearchRoute(results: Array<{ url: string; title: string; description?: string }>): Route {
	return {
		match: (url) => url.includes("/v2/search"),
		status: 200,
		body: { success: true, data: { web: results } },
	};
}

function firecrawlScrapeRoute(markdown: string): Route {
	return {
		match: (url) => url.includes("/v2/scrape"),
		status: 200,
		body: { success: true, data: { markdown, metadata: { title: "Scraped" } } },
	};
}

function openaiRoute(): Route {
	return {
		match: (url) => url.includes("api.openai.com"),
		status: 200,
		body: {
			output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://s1.dev", title: "S1" }] } },
				{
					type: "message",
					content: [{
						type: "output_text",
						text: "The claim holds [1].",
						annotations: [{ type: "url_citation", url: "https://s1.dev", title: "S1", start_index: 0, end_index: 18 }],
					}],
				},
			],
		},
	};
}

describe("global pi config storage", () => {
	test("globalConfigPath lives inside the pi agent dir", () => {
		expect(globalConfigPath()).toContain("webweb.json");
	});

	test("setConfigValue merges, preserves other fields, and writes 0600", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cfg-"));
		const configPath = path.join(dir, "agent", "webweb.json");
		setConfigValue("firecrawlApiKey", "fc-secret-123456", configPath);
		setConfigValue("openaiApiKey", "sk-secret-654321", configPath);
		const info = await stat(configPath);
		expect(info.mode & 0o777).toBe(0o600);
		const config = loadConfig({} as NodeJS.ProcessEnv, configPath);
		expect(config.firecrawlApiKey).toBe("fc-secret-123456");
		expect(config.openaiApiKey).toBe("sk-secret-654321");
		setConfigValue("firecrawlApiKey", null, configPath);
		const afterClear = loadConfig({} as NodeJS.ProcessEnv, configPath);
		expect(afterClear.firecrawlApiKey).toBeNull();
		expect(afterClear.openaiApiKey).toBe("sk-secret-654321");
	});

	test("maskKey keeps prefix and suffix only", () => {
		expect(maskKey("fc-abcdefgh1234")).toBe("fc-…1234");
		expect(maskKey("short")).toBe("***");
	});
});

describe("/webweb command", () => {
	function fakeUi(inputValue: string | undefined): { ui: CommandUi; notifications: Array<{ message: string; type: string }> } {
		const notifications: Array<{ message: string; type: string }> = [];
		return {
			notifications,
			ui: {
				hasUI: true,
				ui: {
					input: async () => inputValue,
					notify: (message: string, type?: "info" | "warning" | "error") => {
						notifications.push({ message, type: type ?? "info" });
					},
				},
			},
		};
	}

	test("firecrawl subcommand saves the pasted key to the config file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cmd-"));
		const configPath = path.join(dir, "webweb.json");
		const { ui } = fakeUi("fc-secret-987654");
		await handleWebwebCommand("firecrawl", ui, configPath);
		expect(loadConfig({} as NodeJS.ProcessEnv, configPath).firecrawlApiKey).toBe("fc-secret-987654");
	});

	test("cancelled input dialog does not write anything", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cmd-"));
		const configPath = path.join(dir, "webweb.json");
		const { ui } = fakeUi(undefined);
		await handleWebwebCommand("firecrawl", ui, configPath);
		expect(loadConfig({} as NodeJS.ProcessEnv, configPath).firecrawlApiKey).toBeNull();
	});

	test("status shows masked keys, never the full key", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cmd-"));
		const configPath = path.join(dir, "webweb.json");
		setConfigValue("firecrawlApiKey", "fc-secret-987654", configPath);
		const { ui, notifications } = fakeUi(undefined);
		await handleWebwebCommand("status", ui, configPath);
		const message = notifications[0]?.message ?? "";
		expect(message).toContain("fc-…7654");
		expect(message).not.toContain("fc-secret-987654");
	});

	test("clear removes the stored key", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cmd-"));
		const configPath = path.join(dir, "webweb.json");
		setConfigValue("firecrawlApiKey", "fc-temp", configPath);
		const { ui } = fakeUi(undefined);
		await handleWebwebCommand("clear firecrawl", ui, configPath);
		expect(loadConfig({} as NodeJS.ProcessEnv, configPath).firecrawlApiKey).toBeNull();
	});

	test("unknown subcommand warns without writing", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "webweb-cmd-"));
		const configPath = path.join(dir, "webweb.json");
		const { ui, notifications } = fakeUi(undefined);
		await handleWebwebCommand("bogus", ui, configPath);
		expect(notifications[0]?.type).toBe("warning");
	});
});

describe("config resolution", () => {
	test("environment variables win, defaults apply", () => {
		const config = loadConfig(
			{ FIRECRAWL_API_KEY: "env-fc", OPENAI_API_KEY: "env-oai" } as NodeJS.ProcessEnv,
			"/nonexistent/webweb.json",
		);
		expect(config.firecrawlApiKey).toBe("env-fc");
		expect(config.openaiApiKey).toBe("env-oai");
		expect(config.openaiSearchModel).toBe("gpt-5-mini");
		expect(config.firecrawlApiVersion).toBe("v2");
	});

	test("missing keys resolve to null without throwing", () => {
		const config = loadConfig({} as NodeJS.ProcessEnv, "/nonexistent/webweb.json");
		expect(config.firecrawlApiKey).toBeNull();
		expect(config.openaiApiKey).toBeNull();
	});
});

describe("ssrf guard", () => {
	const blockedUrls = [
		"http://127.0.0.1/x",
		"http://10.0.0.1/x",
		"http://192.168.1.1/x",
		"http://[::1]/x",
		"http://169.254.1.1/x",
		"http://172.16.0.1/x",
		"file:///etc/passwd",
		"http://user:pass@example.com/x",
		"http://example.com:22/x",
	];

	for (const url of blockedUrls) {
		test(`blocks ${url}`, async () => {
			await expect(validateRemoteUrl(url)).rejects.toThrow();
		});
	}

	const fakeLookup: any = async (hostname: string) => {
		if (hostname === "evil.example.com") return [{ address: "127.0.0.1", family: 4 }];
		return [{ address: "93.184.216.34", family: 4 }];
	};

	test("blocks hostnames resolving to private ranges", async () => {
		await expect(validateRemoteUrl("http://evil.example.com/x", { lookup: fakeLookup })).rejects.toThrow();
	});

	test("allows hostnames resolving to public ranges", async () => {
		const validated = await validateRemoteUrl("http://good.example.com/x", { lookup: fakeLookup });
		expect(validated.hostname).toBe("good.example.com");
	});
});

describe("firecrawl provider", () => {
	test("maps v2 search envelope and dedupes by url", () => {
		const results = mapSearchResults({
			web: [
				{ url: "https://a.dev", title: "A", description: "first" },
				{ url: "https://b.dev", title: "B", metadata: { description: "second" } },
				{ url: "https://a.dev", title: "dup" },
			],
		}, 10);
		expect(results).toHaveLength(2);
		expect(results[0]?.snippet).toBe("first");
		expect(results[1]?.snippet).toBe("second");
	});

	test("searchOneQuery falls back to openai when firecrawl fails", async () => {
		const { calls, fetchLike } = fakeFetch([
			{ match: (url) => url.includes("firecrawl"), status: 401, body: { error: "invalid key" } },
			openaiRoute(),
		]);
		const outcome = await Effect.runPromise(
			searchOneQuery("q", {}, 5, { config: CONFIG, fetchLike }, CONFIG),
		);
		expect(outcome.primaryError).toContain("firecrawl");
		expect(outcome.outcome.provider).toBe("openai");
		expect(calls.some((call) => call.includes("api.openai.com"))).toBe(true);
	});

	test("searchOneQuery fails with both messages when both providers fail", async () => {
		const { fetchLike } = fakeFetch([
			{ match: (url) => url.includes("firecrawl"), status: 500, body: { error: "boom" } },
			{ match: (url) => url.includes("api.openai.com"), status: 503, body: { error: "down" } },
		]);
		const error = await expectFailure(
			searchOneQuery("q", {}, 5, { config: CONFIG, fetchLike }, CONFIG),
		);
		expect(String(error)).toContain("firecrawl");
		expect(String(error)).toContain("openai");
	});

	test("non-retryable errors are not retried", async () => {
		const { calls, fetchLike } = fakeFetch([
			{ match: (url) => url.includes("firecrawl"), status: 401, body: { error: "invalid" } },
			openaiRoute(),
		]);
		await Effect.runPromise(searchOneQuery("q", {}, 5, { config: CONFIG, fetchLike }, CONFIG));
		expect(calls.filter((call) => call.includes("firecrawl"))).toHaveLength(1);
	});
});

describe("search pipeline", () => {
	test("runSearch returns answer, sources, and a responseId", async () => {
		const { fetchLike } = fakeFetch([
			firecrawlSearchRoute([
				{ url: "https://a.dev", title: "A", description: "alpha" },
				{ url: "https://b.dev", title: "B", description: "beta" },
			]),
		]);
		const store = memoryStore();
		const run = await Effect.runPromise(runSearch({ query: "test" }, { config: CONFIG, fetchLike, store }));
		expect(run.provider).toBe("firecrawl");
		const responseId = run.responseId;
		expect(responseId).toMatch(/^[0-9a-f]{8}$/);
		const formatted = formatSearchResult(run);
		expect(formatted).toContain("responseId");
		const entry = responseId ? await Effect.runPromise(store.read(responseId)) : null;
		expect(entry?.sources).toHaveLength(2);
	});

	test("runSearch without any configured provider fails with setup guidance", async () => {
		const error = await expectFailure(
			runSearch({ query: "x" }, { config: configWith({ firecrawlApiKey: null, openaiApiKey: null }) }),
		);
		expect(String(error)).toContain("FIRECRAWL_API_KEY");
	});
});

describe("verify pipeline", () => {
	test("evidence collection assigns neither factual verdict nor confidence", () => {
		for (const claim of ["effect four requires bun", "effect four does not require bun"]) {
			const artifact = buildVerifyArtifact(claim, [{ url: "https://a.dev", title: "A", snippet: "It is confirmed that effect four requires bun." }], []);
			expect(artifact.status).toBe("not-assessed");
			expect(artifact).not.toHaveProperty("assessment");
			expect(artifact).not.toHaveProperty("confidence");
			expect(artifact.passages[0]?.provenance).toBe("search-snippet");
		}
	});

	test("runVerify produces an artifact with sources, passages, and a responseId", async () => {
		const { fetchLike } = fakeFetch([
			firecrawlSearchRoute([
				{ url: "https://a.dev", title: "A", description: "It is confirmed that effect four requires bun according to the docs." },
			]),
		]);
		const store = memoryStore();
		const run = await Effect.runPromise(
			runVerify({ claim: "effect four requires bun" }, { config: CONFIG, fetchLike, store }),
		);
		expect(run.artifact.status).toBe("not-assessed");
		expect(run.artifact.sources).toHaveLength(1);
		expect(run.responseId).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("fetch pipeline", () => {
	test("runFetch fetches a page via firecrawl and stores it", async () => {
		const { calls, fetchLike } = fakeFetch([firecrawlScrapeRoute("# Hello")]);
		const store = memoryStore();
		const run = await Effect.runPromise(
			runFetch({ url: "https://example.dev/post" }, { config: CONFIG, fetchLike, store, lookup: publicLookup }),
		);
		expect(run.items[0]?.status).toBe("fetched");
		expect(run.items[0]?.provider).toBe("firecrawl");
		expect(run.items[0]?.content).toBe("# Hello");
		expect(calls.some((call) => call.includes("/v2/scrape"))).toBe(true);
		expect(run.responseId).toMatch(/^[0-9a-f]{8}$/);
	});

	test("runFetch records a terminal failure for blocked targets", async () => {
		const { fetchLike } = fakeFetch([
			{ match: (url) => url.includes("firecrawl"), status: 500, body: { error: "boom" } },
			{ match: () => true, status: 403, body: "forbidden" },
		]);
		// 192.0.2.1 is TEST-NET-1: blocked locally by the SSRF guard without DNS
		const run = await Effect.runPromise(
			runFetch({ url: "https://192.0.2.1/post" }, { config: CONFIG, fetchLike }),
		);
		expect(run.items[0]?.status).toBe("failed");
		expect(run.items[0]?.error).toContain("private or reserved");
	});

	test("runFetch reports a clear failure for github urls without exec capability", async () => {
		const run = await Effect.runPromise(
			runFetch({ url: "https://github.com/owner/repo" }, { config: CONFIG }),
		);
		expect(run.items[0]?.status).toBe("failed");
	});
});

describe("read pipeline", () => {
	test("runRead slices stored content and finds passages", async () => {
		const store = memoryStore();
		const id = newResponseId();
		const entry: CacheEntry = {
			id,
			createdAt: Date.now(),
			kind: "fetch",
			sources: [{ url: "https://a.dev", title: "A", content: "alpha beta gamma delta epsilon zeta" }],
		};
		await Effect.runPromise(store.write(entry));

		const read = await Effect.runPromise(runRead({ responseId: id }, { store }));
		expect(read.status).toBe("found");
		expect(read.slice).toContain("alpha");

		const found = await Effect.runPromise(runRead({ responseId: id, findText: "gamma" }, { store }));
		expect(found.matches?.[0]?.excerpt).toContain("gamma");

		const missing = await Effect.runPromise(runRead({ responseId: "deadbeef" }, { store }));
		expect(missing.status).toBe("not-found");
	});
});

describe("github url parsing", () => {
	test("parses repo, tree, and blob urls", () => {
		expect(parseGitHubUrl("https://github.com/owner/repo")).toEqual({ kind: "repo", owner: "owner", repo: "repo" });
		expect(parseGitHubUrl("https://github.com/owner/repo.git")).toEqual({ kind: "repo", owner: "owner", repo: "repo" });
		expect(parseGitHubUrl("https://github.com/owner/repo/tree/v5/src")).toEqual({
			kind: "tree", owner: "owner", repo: "repo", ref: "v5", filePath: "src",
		});
		expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/index.ts")).toEqual({
			kind: "blob", owner: "owner", repo: "repo", ref: "main", filePath: "index.ts",
		});
		expect(parseGitHubUrl("https://gitlab.com/owner/repo")).toBeNull();
		expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
	});
});

describe("output formatting", () => {
	test("formatFetchResult renders cloned and failed items", () => {
		const text = formatFetchResult({
			items: [
				{ url: "https://github.com/o/r", status: "cloned", provider: "github", title: "r", content: "README body", repoPath: "/tmp/x", fileCount: 10, error: null },
				{ url: "https://bad.dev", status: "failed", provider: null, title: null, content: null, repoPath: null, fileCount: null, error: "HTTP 500" },
			],
			responseId: null,
		});
		expect(text).toContain("GitHub repository preview");
		expect(text).not.toContain("/tmp/x");
		expect(text).not.toContain("Explore it with read and bash");
		expect(text).toContain("FAILED: HTTP 500");
	});

	test("formatReadResult renders matches and slices", () => {
		const matches = formatReadResult({
			status: "found",
			entry: null,
			source: null,
			matches: [{ url: "https://a.dev", excerpt: "...gamma..." }],
			slice: null,
			error: null,
		});
		expect(matches).toContain("Match 1");
		expect(matches).toContain("gamma");

		const slice = formatReadResult({
			status: "found",
			entry: null,
			source: { url: "https://a.dev", title: "A", content: "body" },
			matches: null,
			slice: "body slice",
			error: null,
		});
		expect(slice).toContain("body slice");
	});

	test("fetchTopPages drops failed pages without failing the run", async () => {
		const { fetchLike } = fakeFetch([
			{ match: (url, body) => url.includes("/v2/scrape") && !body.includes("192.0.2.1"), status: 200, body: { success: true, data: { markdown: "ok" } } },
		]);
		// second url is TEST-NET-1: blocked locally by the SSRF guard without DNS
		const { pages, failures } = await Effect.runPromise(fetchTopPages(
			[{ url: "https://ok.dev/a" }, { url: "https://192.0.2.1/b" }],
			{ config: CONFIG, fetchLike, lookup: publicLookup },
			CONFIG,
		));
		expect(pages).toHaveLength(1);
		expect(failures).toBe(1);
	});
});

describe("snippet answer", () => {
	test("buildSnippetAnswer formats top results", () => {
		const answer = buildSnippetAnswer("q", [{ url: "https://a.dev", title: "A", snippet: "alpha" }]);
		expect(answer).toContain("[1] A: alpha");
	});
});
