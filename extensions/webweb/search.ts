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
	const httpFallback = Effect.mapError(httpExtract(url, { signal: deps.signal }), (error) => new Error(errorMessage(error)));
	if (config.firecrawlApiKey) {
		return firecrawlScrape(url, {
			apiKey: config.firecrawlApiKey,
			apiVersion: config.firecrawlApiVersion,
				baseUrl: config.firecrawlBaseUrl,
			fetchLike: deps.fetchLike,
		}, deps.signal).pipe(
			Effect.catchIf(() => true, (firecrawlError) =>
				Effect.mapError(httpFallback, (httpError) => new Error(
					`firecrawl: ${firecrawlError.message} | http fallback: ${httpError.message}`,
				))),
		);
	}
	return httpFallback;
}

/** Fetch full page content for the top sources; individual failures are dropped, not fatal. */
export function fetchTopPages(
	results: ReadonlyArray<{ url: string }>,
	deps: SearchDeps,
	config: WebwebConfig,
	limit = INCLUDE_CONTENT_LIMIT,
): Effect.Effect<{ pages: Array<PageContent>; failures: number }, never> {
	return Effect.forEach(results.slice(0, limit), (target) =>
		Effect.exit(fetchPage(target.url, deps, config))).pipe(
		Effect.map((exits) => ({
			pages: exits.flatMap((exit) => Exit.isSuccess(exit) ? [exit.value] : []),
			failures: exits.filter((exit) => !Exit.isSuccess(exit)).length,
		})),
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
		? openaiSearch(query, { numResults }, {
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
			Effect.catchIf(() => true, (firecrawlError) =>
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

	const only = firecrawl ?? openai;
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

		let includeContentError: string | null = null;
		const sources: Array<CachedSource> = [];
		for (const { outcome } of outcomes) {
			let contentByUrl = new Map<string, string>();
			if (input.includeContent && outcome.results.length > 0) {
				const { pages, failures } = yield* fetchTopPages(outcome.results, deps, config);
				if (failures > 0) includeContentError = `${failures} source page(s) could not be fetched`;
				contentByUrl = new Map(pages.map((page) => [page.url, page.content]));
			}
			for (const result of outcome.results) {
				sources.push({
					url: result.url,
					title: result.title,
					content: contentByUrl.get(result.url) ?? result.snippet,
				});
			}
		}

		const storedId = sources.length > 0
			? yield* Effect.map(
					Effect.exit(storeSources("search", sources, deps.store ?? cacheStore())),
					(exit) => Exit.isSuccess(exit) ? exit.value : null,
				)
			: null;

		const provider = outcomes[0]?.outcome.provider ?? null;
		return { outcomes, responseId: storedId, provider, includeContentError };
	});
}

export interface VerifyInput {
	readonly claim: string;
	readonly domainFilter?: Array<string> | undefined;
	readonly fetchContent?: boolean | undefined;
	readonly numResults?: number | undefined;
}

export interface VerifyRunResult {
	readonly artifact: VerifyArtifact;
	readonly responseId: string | null;
	readonly primaryError: string | null;
}

/**
 * Verify a claim: search for evidence (Firecrawl → OpenAI), optionally fetch
 * the top source pages, then assess the claim against extracted passages.
 */
export function runVerify(input: VerifyInput, deps: SearchDeps = {}): Effect.Effect<VerifyRunResult, Error> {
	const claim = input.claim.trim();
	if (!claim) {
		return Effect.fail(new Error("Provide a non-empty claim to verify."));
	}
	return Effect.gen(function*() {
		const config = deps.config ?? loadConfig();
		const search = yield* searchOneQuery(
			claim,
			{ domainFilter: input.domainFilter },
			input.numResults ?? 8,
			deps,
			config,
		);

		let fetched: Array<PageContent> = [];
		if (input.fetchContent && search.outcome.results.length > 0) {
			fetched = (yield* fetchTopPages(search.outcome.results, deps, config)).pages;
		}

		const artifact = buildVerifyArtifact(claim, search.outcome.results, fetched);

		const cachedSources: Array<CachedSource> = [
			...artifact.passages.map((passage) => ({
				url: passage.sourceUrl,
				title: `passage ${passage.passageId}`,
				content: passage.text,
			})),
			...fetched.map((page) => ({ url: page.url, title: page.title, content: page.content })),
		];
		const responseId = cachedSources.length > 0
			? yield* Effect.map(
					Effect.exit(storeSources("verify", cachedSources, deps.store ?? cacheStore())),
					(exit) => Exit.isSuccess(exit) ? exit.value : null,
				)
			: null;

		return { artifact, responseId, primaryError: search.primaryError };
	});
}
