import { Effect, Schedule } from "effect";
import {
	FIRECRAWL_DEFAULT_BASE_URL,
	FIRECRAWL_FALLBACK_BASE_URL,
	SCRAPE_TIMEOUT_MS,
	SEARCH_TIMEOUT_MS,
} from "./config.ts";
import { FirecrawlError, isTransientStatus, redact, type Provider } from "./errors.ts";

export interface WebResult {
	readonly url: string;
	readonly title: string;
	readonly snippet: string;
}

export interface SearchOutcome {
	readonly provider: Provider;
	readonly answer: string;
	readonly results: ReadonlyArray<WebResult>;
}

export interface PageContent {
	readonly url: string;
	readonly title: string;
	readonly content: string;
}

export type FetchLike = (
	url: string | URL,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

export function firstString(...values: Array<unknown>): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function mapSearchResults(data: unknown, limit: number): Array<WebResult> {
	const record = asRecord(data);
	const web = Array.isArray(data) ? data : record ? record.web : undefined;
	if (!Array.isArray(web)) return [];
	const results: Array<WebResult> = [];
	const seen = new Set<string>();
	for (const rawItem of web) {
		const item = asRecord(rawItem);
		if (!item) continue;
		const metadata = asRecord(item.metadata);
		const url = firstString(item.url, metadata?.sourceURL, metadata?.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		results.push({
			url,
			title: firstString(item.title, metadata?.title) ?? url,
			snippet: firstString(item.description, item.snippet, metadata?.description) ?? "",
		});
		if (results.length >= limit) break;
	}
	return results;
}

function mapScrape(data: unknown, url: string): PageContent | null {
	const record = asRecord(data);
	if (!record) return null;
	const markdown = firstString(record.markdown);
	if (!markdown) return null;
	const metadata = asRecord(record.metadata);
	return { url, title: firstString(record.title, metadata?.title) ?? url, content: markdown };
}

const retryOptions = {
	times: 2,
	schedule: Schedule.exponential(200),
	while: (error: FirecrawlError) => error.retryable,
} as const;

function postJson(options: {
	url: string;
	apiKey: string;
	body: Record<string, unknown>;
	timeoutMs: number;
	signal?: AbortSignal | undefined;
	fetchLike: FetchLike;
}): Effect.Effect<unknown, FirecrawlError> {
	return Effect.tryPromise({
		try: async (signal) => {
			const response = await options.fetchLike(options.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(options.body),
				signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs), signal]),
			});
			const text = await response.text();
			if (!response.ok) {
				const parsed = asRecord(safeJson(text));
				const detail = parsed
					? (firstString(parsed.error, parsed.message) ?? redact(text.slice(0, 300), [options.apiKey]))
					: redact(text.slice(0, 300), [options.apiKey]);
				throw new FirecrawlError({
					message: `Firecrawl request failed: ${detail || `HTTP ${response.status}`}`,
					status: response.status,
					retryable: isTransientStatus(response.status),
					network: false,
				});
			}
			const parsed = asRecord(safeJson(text));
			if (!parsed) {
				throw new FirecrawlError({ message: "Firecrawl returned an unexpected response shape", retryable: false, network: false });
			}
			if (parsed.success === false) {
				throw new FirecrawlError({
					message: `Firecrawl request unsuccessful: ${firstString(parsed.error) ?? "unknown error"}`,
					retryable: false,
					network: false,
				});
			}
			return parsed.data !== undefined ? parsed.data : parsed;
		},
		catch: (error) => error instanceof FirecrawlError
			? error
			: new FirecrawlError({ message: `Firecrawl request failed: ${String(error)}`, retryable: true, network: true }),
	}).pipe(
		Effect.timeout(options.timeoutMs),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new FirecrawlError({ message: "Firecrawl request timed out", retryable: false, network: true }))),
		Effect.retry(retryOptions),
	);
}

export interface FirecrawlDeps {
	readonly apiKey: string;
	readonly apiVersion: "v1" | "v2";
	readonly baseUrl: string;
	readonly fetchLike?: FetchLike | undefined;
}

function sameHost(a: string, b: string): boolean {
	try {
		return new URL(a).host === new URL(b).host;
	} catch {
		return false;
	}
}

/**
 * Run a request against the configured base URL. On a connect-level failure
 * (DNS/TLS, no HTTP response), retry once against the alternate Firecrawl
 * host, which serves the same API.
 */
function withHostFallback(
	deps: FirecrawlDeps,
	build: (baseUrl: string) => Effect.Effect<unknown, FirecrawlError>,
): Effect.Effect<unknown, FirecrawlError> {
	const primary = build(deps.baseUrl);
	if (sameHost(deps.baseUrl, FIRECRAWL_FALLBACK_BASE_URL)) return primary;
	return primary.pipe(
		Effect.catchIf(
			(error) => error.network,
			(fallbackReason) =>
				build(FIRECRAWL_FALLBACK_BASE_URL).pipe(
					Effect.mapError((error) => new FirecrawlError({
						message: `${fallbackReason.message} | fallback host also failed: ${error.message}`,
						status: error.status,
						retryable: error.retryable,
						network: error.network,
					})),
				),
		),
	);
}

function recencyToTbs(filter: string): string | undefined {
	switch (filter) {
		case "day":
			return "qdr:d";
		case "week":
			return "qdr:w";
		case "month":
			return "qdr:m";
		case "year":
			return "qdr:y";
		default:
			return undefined;
	}
}

export function buildSnippetAnswer(query: string, results: ReadonlyArray<WebResult>): string {
	if (results.length === 0) return "";
	const lines = results.slice(0, 5).map((result, index) => `[${index + 1}] ${result.title}: ${result.snippet}`);
	return `Top results for "${query}":\n${lines.join("\n")}`;
}

export function firecrawlSearch(
	query: string,
	options: { numResults: number; domainFilter?: Array<string> | undefined; recencyFilter?: string | undefined },
	deps: FirecrawlDeps,
	signal?: AbortSignal | undefined,
): Effect.Effect<SearchOutcome, FirecrawlError> {
	const body: Record<string, unknown> = {
		query,
		limit: options.numResults,
		sources: ["web"],
	};
	const include: Array<string> = [];
	const exclude: Array<string> = [];
	for (const filter of options.domainFilter ?? []) {
		if (filter.startsWith("-")) exclude.push(filter.slice(1));
		else include.push(filter);
	}
	if (include.length > 0) body.includeDomains = include;
	else if (exclude.length > 0) body.excludeDomains = exclude;
	const tbs = options.recencyFilter ? recencyToTbs(options.recencyFilter) : undefined;
	if (tbs) body.tbs = tbs;

	return withHostFallback(deps, (baseUrl) =>
		postJson({
			url: `${baseUrl}/${deps.apiVersion}/search`,
			apiKey: deps.apiKey,
			body,
			timeoutMs: SEARCH_TIMEOUT_MS,
			signal,
			fetchLike: deps.fetchLike ?? fetch,
		})).pipe(Effect.map((data) => {
		const results = mapSearchResults(data, options.numResults);
		return {
			provider: "firecrawl" as const,
			answer: buildSnippetAnswer(query, results),
			results,
		};
	}));
}

export function firecrawlScrape(
	url: string,
	deps: FirecrawlDeps,
	signal?: AbortSignal | undefined,
): Effect.Effect<PageContent, FirecrawlError> {
	return withHostFallback(deps, (baseUrl) =>
		postJson({
			url: `${baseUrl}/${deps.apiVersion}/scrape`,
			apiKey: deps.apiKey,
			body: { url, formats: ["markdown"], onlyMainContent: true },
			timeoutMs: SCRAPE_TIMEOUT_MS,
			signal,
			fetchLike: deps.fetchLike ?? fetch,
		})).pipe(
		Effect.flatMap((data) => {
			const content = mapScrape(data, url);
			if (!content) {
				return Effect.fail(new FirecrawlError({
					message: `Firecrawl scrape returned no markdown for ${url}`,
					retryable: false,
					network: false,
				}));
			}
			return Effect.succeed(content);
		}),
	);
}
