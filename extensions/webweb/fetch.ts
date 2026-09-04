import { Effect, Exit, Option } from "effect";
import { FETCH_CONCURRENCY, loadConfig, MAX_BATCH_URLS, type WebwebConfig } from "./config.ts";
import { causeMessage, type Provider } from "./errors.ts";
import { firecrawlScrape, type FetchLike } from "./firecrawl.ts";
import { httpExtract } from "./extract.ts";
import { guardedFetch } from "./ssrf.ts";
import { createGitHubSession, parseGitHubUrl, serveGitHub, type ExecLike, type GitHubSession } from "./github.ts";
import { cacheStore, storeSources, type CachedSource } from "./cache.ts";

export interface FetchInput {
	readonly url?: string | undefined;
	readonly urls?: Array<string> | undefined;
	readonly mode?: "readable" | "raw" | undefined;
	readonly forceClone?: boolean | undefined;
}

export interface FetchedItem {
	readonly url: string;
	readonly status: "fetched" | "cloned" | "failed";
	readonly provider: Provider | null;
	readonly title: string | null;
	readonly content: string | null;
	readonly repoPath: string | null;
	readonly fileCount: number | null;
	readonly error: string | null;
}

export interface FetchRunResult {
	readonly items: ReadonlyArray<FetchedItem>;
	readonly responseId: string | null;
}

export interface FetchDeps {
	readonly signal?: AbortSignal | undefined;
	readonly fetchLike?: FetchLike | undefined;
	readonly execLike?: ExecLike | undefined;
	readonly config?: WebwebConfig | undefined;
	readonly store?: ReturnType<typeof cacheStore> | undefined;
	readonly github?: GitHubSession | undefined;
}

const RAW_TIMEOUT_MS = 60_000;

function failedItem(url: string, error: string): FetchedItem {
	return { url, status: "failed", provider: null, title: null, content: null, repoPath: null, fileCount: null, error };
}

function normalizeUrls(input: FetchInput): Array<string> {
	const urls = (input.urls ?? (input.url ? [input.url] : []))
		.map((url) => url.trim())
		.filter((url) => url !== "")
		.slice(0, MAX_BATCH_URLS);
	return [...new Set(urls)];
}

function isRawTextContentType(contentType: string): boolean {
	return /^(text\/plain|application\/(json|xml|javascript|typescript|x-yaml))/.test(contentType);
}

/** Raw mode: exact textual HTTP body via the SSRF-guarded fetch, no provider involved. */
export function fetchRaw(url: string, deps: FetchDeps): Effect.Effect<FetchedItem, never> {
	const attempt = Effect.tryPromise({
		try: async (signal) => {
			const signals = [AbortSignal.timeout(RAW_TIMEOUT_MS), signal];
			if (deps.signal) signals.push(deps.signal);
			const response = await guardedFetch(url, { signal: AbortSignal.any(signals) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (!isRawTextContentType(contentType)) {
				throw new Error(`raw mode requires a textual content-type, got "${contentType.split(";")[0] || "unknown"}"`);
			}
			return response.text();
		},
		catch: (error) => new Error(String(error)),
	}).pipe(
		Effect.timeout(RAW_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () => Effect.fail(new Error("raw fetch timed out"))),
		Effect.exit,
	);

	return Effect.map(attempt, (exit) =>
		Exit.isSuccess(exit)
			? {
					url,
					status: "fetched" as const,
					provider: "http" as const,
					title: url,
					content: exit.value,
					repoPath: null,
					fileCount: null,
					error: null,
				}
			: failedItem(url, causeMessage(exit.cause)));
}

function fetchReadable(url: string, deps: FetchDeps, config: WebwebConfig): Effect.Effect<FetchedItem, never> {
	const toItem = (page: { title: string; content: string }, provider: Provider): FetchedItem => ({
		url,
		status: "fetched",
		provider,
		title: page.title,
		content: page.content,
		repoPath: null,
		fileCount: null,
		error: null,
	});

	const firecrawl = config.firecrawlApiKey
		? Option.some(
			Effect.map(
				firecrawlScrape(url, {
					apiKey: config.firecrawlApiKey,
					apiVersion: config.firecrawlApiVersion,
				baseUrl: config.firecrawlBaseUrl,
					fetchLike: deps.fetchLike,
				}, deps.signal),
				(page) => toItem(page, "firecrawl"),
			),
		)
		: Option.none();

	const http = Effect.map(httpExtract(url, { signal: deps.signal }), (page) => toItem(page, "http"));

	const attempt = Option.isSome(firecrawl)
		? firecrawl.value.pipe(
			Effect.catchIf(() => true, (firecrawlError) =>
				Effect.mapError(http, (httpError) => new Error(
					`firecrawl: ${firecrawlError.message} | http fallback: ${httpError.message}`,
				))),
		)
		: http;

	return Effect.map(Effect.exit(attempt), (exit) =>
		Exit.isSuccess(exit) ? exit.value : failedItem(url, causeMessage(exit.cause)));
}

function fetchOne(
	url: string,
	input: FetchInput,
	deps: FetchDeps,
	config: WebwebConfig,
): Effect.Effect<FetchedItem, never> {
	const githubRef = parseGitHubUrl(url);
	if (githubRef) {
		if (!deps.execLike) {
			return Effect.succeed(failedItem(url, "GitHub handling unavailable: no exec capability provided"));
		}
		const github = deps.github ?? createGitHubSession();
		const execLike = deps.execLike;
		return Effect.map(
			Effect.exit(serveGitHub(url, github, execLike, deps.signal, input.forceClone)),
			(exit) =>
				Exit.isSuccess(exit)
					? {
							url,
							status: "cloned" as const,
							provider: "github" as const,
							title: githubRef.repo,
							content: exit.value.text,
							repoPath: exit.value.repoPath,
							fileCount: exit.value.fileCount,
							error: null,
						}
					: failedItem(url, causeMessage(exit.cause)),
		);
	}
	if (input.mode === "raw") {
		return fetchRaw(url, deps);
	}
	return fetchReadable(url, deps, config);
}

export function runFetch(input: FetchInput, deps: FetchDeps = {}): Effect.Effect<FetchRunResult, Error> {
	const urls = normalizeUrls(input);
	if (urls.length === 0) {
		return Effect.fail(new Error("Provide a url, or up to 5 urls for batch fetch."));
	}
	return Effect.gen(function*() {
		const config = deps.config ?? loadConfig();
		const items = yield* Effect.forEach(urls, (url) => fetchOne(url, input, deps, config), {
			concurrency: FETCH_CONCURRENCY,
			discard: false,
		});

		const cacheable: Array<CachedSource> = items.flatMap((item) =>
			item.content && item.status === "fetched"
				? [{ url: item.url, title: item.title ?? item.url, content: item.content }]
				: []
		);
		const responseId = cacheable.length > 0
			? yield* Effect.map(
					Effect.exit(storeSources("fetch", cacheable, deps.store ?? cacheStore())),
					(exit) => Exit.isSuccess(exit) ? exit.value : null,
				)
			: null;

		return { items, responseId };
	});
}
