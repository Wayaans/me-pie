import { Effect, Schedule } from "effect";
import { SCRAPE_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "./config.ts";
import { FirecrawlError, SsrfBlockedError, isTransientStatus, redact, type Provider } from "./errors.ts";
import { awaitResponse, BodyLimitError, PROVIDER_BODY_LIMIT, readText, withAbort } from "./network.ts";
import { validateRemoteUrl, type LookupFunction } from "./ssrf.ts";
import { parseDomainFilters, type DomainFilters } from "./filters.ts";

export interface WebResult {
	readonly url: string;
	readonly title: string;
	readonly snippet: string;
}

export interface AnswerCitation {
	readonly url: string;
	readonly title: string;
	/** Offsets in the generated answer, never in source content. Null if invalid. */
	readonly startIndex: number | null;
	readonly endIndex: number | null;
}

export interface SearchOutcome {
	readonly provider: Provider;
	readonly answer: string;
	readonly answerKind: "generated-answer" | "snippet-summary";
	readonly citations: ReadonlyArray<AnswerCitation>;
	/** All returned consulted and cited sources, deduplicated by exact URL. */
	readonly results: ReadonlyArray<WebResult>;
}

export interface PageContent {
	readonly requestedUrl?: string;
	readonly url: string;
	readonly title: string;
	readonly content: string;
}

export type FetchLike = (
	url: string | URL,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: RequestRedirect },
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
			const combined = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), signal, ...(options.signal ? [options.signal] : [])]);
			combined.throwIfAborted();
			const response = await awaitResponse(options.fetchLike(options.url, {
				redirect: "manual",
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(options.body),
				signal: combined,
			}), combined);
			if (response.status >= 300 && response.status < 400) {
				void response.body?.cancel().catch(() => {});
				throw new FirecrawlError({ message: "Firecrawl redirect blocked", retryable: false, network: false, terminal: true });
			}
			const text = await readText(response, PROVIDER_BODY_LIMIT, combined);
			if (!response.ok) {
				const parsed = asRecord(safeJson(text));
				const detail = parsed
					? (firstString(parsed.error, parsed.message) ?? text)
					: text;
				throw new FirecrawlError({
					message: `Firecrawl request failed: ${redact(detail || `HTTP ${response.status}`, [options.apiKey]).slice(0, 300)}`,
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
					message: `Firecrawl request unsuccessful: ${redact(firstString(parsed.error, parsed.message) ?? "unknown error", [options.apiKey]).slice(0, 300)}`,
					retryable: false,
					network: false,
				});
			}
			return parsed.data !== undefined ? parsed.data : parsed;
		},
		catch: (error) => error instanceof FirecrawlError
			? error
			: new FirecrawlError({
				message: `Firecrawl request failed: ${redact(String(error), [options.apiKey]).slice(0, 300)}`,
				retryable: !(error instanceof BodyLimitError) && !options.signal?.aborted,
				network: !(error instanceof BodyLimitError),
				terminal: error instanceof BodyLimitError || options.signal?.aborted === true,
			}),
	}).pipe(
		Effect.timeout(options.timeoutMs),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new FirecrawlError({ message: "Firecrawl request timed out", retryable: false, network: true }))),
		Effect.retry(retryOptions),
		Effect.mapError((error) => new FirecrawlError({ ...error, message: redact(error.message, [options.apiKey]).slice(0, 400) })),
		(effect) => withAbort(effect, options.signal),
	);
}

export interface FirecrawlDeps {
	readonly apiKey: string;
	readonly apiVersion: "v1" | "v2";
	readonly baseUrl: string;
	readonly fetchLike?: FetchLike | undefined;
	readonly lookup?: LookupFunction | undefined;
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
	let domains: DomainFilters;
	try {
		domains = parseDomainFilters(options.domainFilter);
	} catch (error) {
		return Effect.fail(new FirecrawlError({ message: String(error), retryable: false, network: false, terminal: true }));
	}
	if (deps.apiVersion !== "v2" && (domains.include.length || domains.exclude.length || options.recencyFilter)) {
		return Effect.fail(new FirecrawlError({ message: "Constrained Firecrawl search requires API v2; v1 filter support is not guaranteed.", retryable: false, network: false, terminal: true }));
	}
	if (domains.include.length > 0) body.includeDomains = domains.include;
	if (domains.exclude.length > 0) body.excludeDomains = domains.exclude;
	const tbs = options.recencyFilter ? recencyToTbs(options.recencyFilter) : undefined;
	if (options.recencyFilter && !tbs) return Effect.fail(new FirecrawlError({ message: "Unsupported recencyFilter", retryable: false, network: false, terminal: true }));
	if (tbs) body.tbs = tbs;

	return postJson({
		url: `${deps.baseUrl}/${deps.apiVersion}/search`,
		apiKey: deps.apiKey,
		body,
		timeoutMs: SEARCH_TIMEOUT_MS,
		signal,
		fetchLike: deps.fetchLike ?? fetch,
	}).pipe(Effect.map((data) => {
		const results = mapSearchResults(data, options.numResults);
		return {
			provider: "firecrawl" as const,
			answer: buildSnippetAnswer(query, results),
			answerKind: "snippet-summary" as const,
			citations: [],
			results,
		};
	}));
}

export function firecrawlScrape(
	url: string,
	deps: FirecrawlDeps,
	signal?: AbortSignal | undefined,
): Effect.Effect<PageContent, FirecrawlError> {
	const validate = Effect.tryPromise({
		try: (runtimeSignal) => validateRemoteUrl(url, { lookup: deps.lookup, signal: AbortSignal.any([runtimeSignal, AbortSignal.timeout(SCRAPE_TIMEOUT_MS), ...(signal ? [signal] : [])]) }),
		catch: (error) => new FirecrawlError({ message: error instanceof SsrfBlockedError ? error.message : "Page validation failed", retryable: false, network: false, terminal: true }),
	});
	return validate.pipe(
		Effect.flatMap(() => postJson({
			url: `${deps.baseUrl}/${deps.apiVersion}/scrape`,
			apiKey: deps.apiKey,
			body: { url, formats: ["markdown"], onlyMainContent: true },
			timeoutMs: SCRAPE_TIMEOUT_MS,
			signal,
			fetchLike: deps.fetchLike ?? fetch,
		})),
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
		Effect.mapError((error) => new FirecrawlError({ ...error, message: redact(error.message, [deps.apiKey]).slice(0, 400) })),
		(effect) => withAbort(effect, signal),
	);
}
