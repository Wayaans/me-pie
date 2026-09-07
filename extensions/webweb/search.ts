import { Effect, Exit } from "effect";
import { loadConfig, MAX_BATCH_QUERIES, type WebwebConfig } from "./config.ts";
import { errorMessage, type Provider } from "./errors.ts";
import {
	firecrawlSearch,
	firecrawlScrape,
	type FetchLike,
	type PageContent,
	type SearchOutcome,
} from "./firecrawl.ts";
import { openaiSearch } from "./openai.ts";
import { httpExtract } from "./extract.ts";
import { cacheStore, storeSources, type CachedSource } from "./cache.ts";
import { buildVerifyArtifact, type VerifyArtifact } from "./verify.ts";
import { settle, withAbort } from "./network.ts";
import type { LookupFunction } from "./ssrf.ts";

export interface SearchInput {
	readonly query?: string | undefined;
	readonly queries?: Array<string> | undefined;
	readonly numResults?: number | undefined;
	readonly recencyFilter?: "day" | "week" | "month" | "year" | undefined;
	readonly domainFilter?: Array<string> | undefined;
	readonly includeContent?: boolean | undefined;
}

export interface QueryOutcome {
	readonly query: string;
	readonly outcome: SearchOutcome;
	/** Set when Firecrawl was attempted but the OpenAI fallback had to take over. */
	readonly primaryError: string | null;
}

export interface SearchRunResult {
	readonly outcomes: ReadonlyArray<QueryOutcome>;
	readonly responseId: string | null;
	readonly provider: Provider | null;
	readonly includeContentError: string | null;
}

export interface SearchDeps {
	readonly signal?: AbortSignal | undefined;
	readonly fetchLike?: FetchLike | undefined;
	readonly lookup?: LookupFunction | undefined;
	readonly config?: WebwebConfig | undefined;
	readonly store?: ReturnType<typeof cacheStore> | undefined;
}

const MAX_NUM_RESULTS = 20;
const DEFAULT_NUM_RESULTS = 5;
const INCLUDE_CONTENT_LIMIT = 5;

function normalize(input: SearchInput): { queries: Array<string>; numResults: number } {
	const queries = (input.queries ?? (input.query ? [input.query] : []))
		.map((query) => query.trim())
		.filter((query) => query !== "")
		.slice(0, MAX_BATCH_QUERIES);
	const numResults = Math.min(Math.max(input.numResults ?? DEFAULT_NUM_RESULTS, 1), MAX_NUM_RESULTS);
	return { queries, numResults };
}

export function fetchPage(
	url: string,
	deps: SearchDeps,
	config: WebwebConfig,
): Effect.Effect<PageContent, Error> {
	const httpFallback = Effect.mapError(httpExtract(url, { signal: deps.signal, lookup: deps.lookup }), (error) => new Error(errorMessage(error)));
	if (config.firecrawlApiKey) {
		return firecrawlScrape(url, {
			apiKey: config.firecrawlApiKey,
			apiVersion: config.firecrawlApiVersion,
			baseUrl: config.firecrawlBaseUrl,
			fetchLike: deps.fetchLike,
			lookup: deps.lookup,
		}, deps.signal).pipe(
			Effect.catchIf((error) => !error.terminal && !deps.signal?.aborted, (firecrawlError) =>
				Effect.mapError(httpFallback, (httpError) => new Error(
					`firecrawl: ${firecrawlError.message} | http fallback: ${httpError.message}`,
				))),
		);
	}
	return httpFallback;
}

/** Fetch readable page text for the top sources; individual failures are counted, not fatal. */
export function fetchTopPages(
	results: ReadonlyArray<{ url: string }>,
	deps: SearchDeps,
	config: WebwebConfig,
	limit = INCLUDE_CONTENT_LIMIT,
): Effect.Effect<{ pages: Array<PageContent>; failures: number }, never> {
	return Effect.forEach(results.slice(0, limit), (target) =>
		settle(withAbort(Effect.map(fetchPage(target.url, deps, config), (page) => ({ ...page, requestedUrl: target.url })), deps.signal))).pipe(
		Effect.map((exits) => ({
			pages: exits.flatMap((exit) => Exit.isSuccess(exit) ? [exit.value] : []),
			failures: exits.filter((exit) => !Exit.isSuccess(exit)).length,
		})),
		(effect) => withAbort(effect, deps.signal),
	);
}

/**
 * One query, Firecrawl first with OpenAI as fallback. Returns the winning
 * outcome plus the primary's error (null when Firecrawl succeeded or was not
 * configured) so that fallback events stay visible instead of being swallowed.
 */
export function searchOneQuery(
	query: string,
	input: SearchInput,
	numResults: number,
	deps: SearchDeps,
	config: WebwebConfig,
): Effect.Effect<QueryOutcome, Error> {
	const firecrawl = config.firecrawlApiKey
		? firecrawlSearch(query, {
				numResults,
				domainFilter: input.domainFilter,
				recencyFilter: input.recencyFilter,
			}, {
				apiKey: config.firecrawlApiKey,
				apiVersion: config.firecrawlApiVersion,
				baseUrl: config.firecrawlBaseUrl,
				fetchLike: deps.fetchLike,
			}, deps.signal)
		: null;
	const openai = config.openaiApiKey
		? openaiSearch(query, { numResults, domainFilter: input.domainFilter, recencyFilter: input.recencyFilter }, {
				apiKey: config.openaiApiKey,
				model: config.openaiSearchModel,
				fetchLike: deps.fetchLike,
			}, deps.signal)
		: null;

	if (!firecrawl && !openai) {
		return Effect.fail(new Error(
			"No search provider configured. Run /webweb firecrawl (and optionally /webweb openai) in pi to save keys, or set FIRECRAWL_API_KEY and OPENAI_API_KEY environment variables.",
		));
	}

	if (firecrawl && openai) {
		return firecrawl.pipe(
			Effect.map((outcome): QueryOutcome => ({ query, outcome, primaryError: null })),
			Effect.catchIf((error) => !error.terminal && !deps.signal?.aborted, (firecrawlError) =>
				openai.pipe(
					Effect.map((outcome): QueryOutcome => ({
						query,
						outcome,
						primaryError: `firecrawl: ${firecrawlError.message}`,
					})),
					Effect.mapError((openaiError) => new Error(
						`Both providers failed. firecrawl: ${firecrawlError.message} | openai: ${openaiError.message}`,
					)),
				)),
		);
	}

	if (openai && !firecrawl) {
		return Effect.mapError(
			Effect.map(openai, (outcome): QueryOutcome => ({ query, outcome, primaryError: null })),
			(error) => new Error(errorMessage(error)),
		);
	}
	if (!firecrawl) {
		return Effect.fail(new Error("No search provider configured"));
	}
	return Effect.mapError(
		Effect.map(firecrawl, (outcome): QueryOutcome => ({ query, outcome, primaryError: null })),
		(error) => new Error(errorMessage(error)),
	);
}

function cacheSearchSources(results: ReadonlyArray<{ url: string; title: string; snippet: string }>, pages: ReadonlyArray<PageContent>): Array<CachedSource> {
	const byRequestedUrl = new Map(pages.map((page) => [page.requestedUrl ?? page.url, page]));
	return results.map((result) => {
		const page = byRequestedUrl.get(result.url);
		return {
			url: result.url, title: result.title,
			content: page?.content || result.snippet,
			contentKind: page?.content ? "fetched-page" : result.snippet ? "search-snippet" : "unavailable",
			...(page?.content ? { fetchedUrl: page.url } : {}),
		};
	});
}

export function runSearch(input: SearchInput, deps: SearchDeps = {}): Effect.Effect<SearchRunResult, Error> {
	const { queries, numResults } = normalize(input);
	if (queries.length === 0) {
		return Effect.fail(new Error("Provide a non-empty query, or 1-4 queries for batch search."));
	}
	return Effect.gen(function*() {
		const config = deps.config ?? loadConfig();
		const outcomes: Array<QueryOutcome> = [];
		for (const query of queries) {
			outcomes.push(yield* searchOneQuery(query, input, numResults, deps, config));
		}

		let includeContentFailures = 0;
		const sources: Array<CachedSource> = [];
		for (const { outcome } of outcomes) {
			let pages: Array<PageContent> = [];
			if (input.includeContent && outcome.results.length > 0) {
				const fetched = yield* fetchTopPages(outcome.results, deps, config);
				pages = fetched.pages;
				includeContentFailures += fetched.failures;
			}
			sources.push(...cacheSearchSources(outcome.results, pages));
		}

		const storedId = sources.length > 0
			? yield* Effect.map(
					settle(storeSources("search", sources, deps.store ?? cacheStore())),
					(exit) => Exit.isSuccess(exit) ? exit.value : null,
				)
			: null;

		const provider = outcomes[0]?.outcome.provider ?? null;
		return { outcomes, responseId: storedId, provider,
			includeContentError: includeContentFailures > 0 ? `${includeContentFailures} source page(s) could not be fetched` : null };
	}).pipe((effect) => withAbort(effect, deps.signal));
}

export interface VerifyInput {
	readonly claim: string;
	readonly recencyFilter?: SearchInput["recencyFilter"];
	readonly domainFilter?: Array<string> | undefined;
	readonly fetchContent?: boolean | undefined;
	readonly numResults?: number | undefined;
}

export interface VerifyRunResult {
	readonly artifact: VerifyArtifact;
	readonly responseId: string | null;
	readonly primaryError: string | null;
	readonly fetchFailures: number;
}

/** Collect evidence for caller assessment without assigning a factual verdict. */
export function runVerify(input: VerifyInput, deps: SearchDeps = {}): Effect.Effect<VerifyRunResult, Error> {
	const claim = input.claim.trim();
	if (!claim) {
		return Effect.fail(new Error("Provide a non-empty claim to verify."));
	}
	return Effect.gen(function*() {
		const config = deps.config ?? loadConfig();
		const search = yield* searchOneQuery(
			claim,
			{ domainFilter: input.domainFilter, recencyFilter: input.recencyFilter },
			input.numResults ?? 8,
			deps,
			config,
		);

		let fetched: Array<PageContent> = [];
		let fetchFailures = 0;
		if (input.fetchContent && search.outcome.results.length > 0) {
			const pages = yield* fetchTopPages(search.outcome.results, deps, config);
			fetched = pages.pages;
			fetchFailures = pages.failures;
		}

		const artifact = buildVerifyArtifact(claim, search.outcome.results, fetched,
			search.outcome.answerKind === "generated-answer" ? search.outcome.answer : null, search.outcome.citations);

		const cachedSources = cacheSearchSources(search.outcome.results, fetched);
		const responseId = cachedSources.length > 0
			? yield* Effect.map(
					settle(storeSources("verify", cachedSources, deps.store ?? cacheStore())),
					(exit) => Exit.isSuccess(exit) ? exit.value : null,
				)
			: null;

		return { artifact, responseId, primaryError: search.primaryError, fetchFailures };
	}).pipe((effect) => withAbort(effect, deps.signal));
}
