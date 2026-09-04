import { Effect } from "effect";
import { cacheStore, findPassages, sliceContent, type CacheEntry } from "./cache.ts";
import { Exit } from "effect";

export interface ReadInput {
	readonly responseId: string;
	readonly url?: string | undefined;
	readonly urlIndex?: number | undefined;
	readonly query?: string | undefined;
	readonly findText?: string | Array<string> | undefined;
	readonly findMode?: "exact" | "case-insensitive" | "fuzzy" | undefined;
	readonly offset?: number | undefined;
	readonly limit?: number | undefined;
}

export interface ReadRunResult {
	readonly status: "found" | "not-found";
	readonly entry: CacheEntry | null;
	readonly source: { url: string; title: string; content: string } | null;
	readonly matches: ReadonlyArray<{ url: string; excerpt: string }> | null;
	readonly slice: string | null;
	readonly error: string | null;
}

const DEFAULT_SLICE_LIMIT = 30_000;

function selectSource(entry: CacheEntry, input: ReadInput): { url: string; title: string; content: string } | null {
	if (input.url) {
		return entry.sources.find((source) => source.url === input.url) ?? null;
	}
	if (input.query) {
		const needle = input.query.toLowerCase();
		const match = entry.sources.find((source) =>
			source.url.toLowerCase().includes(needle) || source.title.toLowerCase().includes(needle)
		);
		return match ?? null;
	}
	if (input.urlIndex !== undefined) {
		return entry.sources[input.urlIndex] ?? null;
	}
	return entry.sources[0] ?? null;
}

export interface ReadDeps {
	readonly store?: ReturnType<typeof cacheStore>;
}

export function runRead(input: ReadInput, deps: ReadDeps = {}): Effect.Effect<ReadRunResult, Error> {
	return Effect.gen(function*() {
		const exit = yield* Effect.exit((deps.store ?? cacheStore()).read(input.responseId));
		if (!Exit.isSuccess(exit)) {
			return { status: "not-found" as const, entry: null, source: null, matches: null, slice: null, error: "Cache read failed" };
		}
		const entry = exit.value;
		if (!entry) {
			return {
				status: "not-found" as const,
				entry: null,
				source: null,
				matches: null,
				slice: null,
				error: `No cached content for responseId "${input.responseId}". It may have expired (1 hour) or the id is wrong.`,
			};
		}
		const cached = entry;

		const texts = typeof input.findText === "string" ? [input.findText] : input.findText;
		if (texts && texts.length > 0) {
			const matches = findPassages(cached, texts, input.findMode ?? "case-insensitive");
			return { status: "found" as const, entry: cached, source: null, matches, slice: null, error: null };
		}

		const source = selectSource(cached, input);
		if (!source) {
			return { status: "not-found" as const, entry: cached, source: null, matches: null, slice: null, error: null };
		}
		const limit = input.limit ?? DEFAULT_SLICE_LIMIT;
		const slice = sliceContent(source.content, input.offset ?? 0, limit);
		return { status: "found" as const, entry: cached, source, matches: null, slice, error: null };
	});
}
