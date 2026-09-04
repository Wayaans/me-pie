import { Effect, Schedule } from "effect";
import { OPENAI_RESPONSES_URL } from "./config.ts";
import { OpenAIError, isTransientStatus, redact, type Provider } from "./errors.ts";
import type { SearchOutcome, WebResult, FetchLike } from "./firecrawl.ts";
import { asRecord, firstString } from "./firecrawl.ts";

const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;

const retryOptions = {
	times: 2,
	schedule: Schedule.exponential(200),
	while: (error: OpenAIError) => error.retryable,
} as const;

const SEARCH_INSTRUCTIONS = [
	"You are a web research assistant inside a coding agent.",
	"Search the web and answer the user's query with a concise, factual summary.",
	"Cite sources inline using [n] markers matching the web_search results.",
].join(" ");

export interface OpenAIDeps {
	readonly apiKey: string;
	readonly model: string;
	readonly fetchLike?: FetchLike | undefined;
}

interface OpenAIAuth {
	readonly apiKey: string;
	readonly model: string;
}

function extractResults(output: Array<Record<string, unknown>>, limit: number): Array<WebResult> {
	const results: Array<WebResult> = [];
	const seen = new Set<string>();
	for (const item of output) {
		if (item.type !== "web_search_call") continue;
		const action = asRecord(item.action);
		const sources = Array.isArray(action?.sources) ? action.sources : [];
		for (const rawSource of sources) {
			const source = asRecord(rawSource);
			if (!source) continue;
			const url = firstString(source.url);
			if (!url || seen.has(url)) continue;
			seen.add(url);
			results.push({ url, title: firstString(source.title) ?? url, snippet: "" });
			if (results.length >= limit) return results;
		}
	}
	return results;
}

function snippetAround(text: string, start: unknown, end: unknown): string {
	const from = typeof start === "number" ? Math.max(0, start) : 0;
	const to = typeof end === "number" ? Math.min(text.length, end) : from;
	if (to <= from) return "";
	return text.slice(from, to).trim();
}

function extractAnswer(
	output: Array<Record<string, unknown>>,
	limit: number,
): { answer: string; results: Array<WebResult> } {
	const cited: Array<WebResult> = [];
	const seen = new Set<string>();
	let answer = "";
	for (const item of output) {
		if (item.type !== "message") continue;
		const contents = Array.isArray(item.content) ? item.content : [];
		for (const rawContent of contents) {
			const content = asRecord(rawContent);
			if (!content || content.type !== "output_text") continue;
			const text = firstString(content.text) ?? "";
			answer += text;
			const annotations = Array.isArray(content.annotations) ? content.annotations : [];
			for (const rawAnnotation of annotations) {
				const annotation = asRecord(rawAnnotation);
				if (!annotation || annotation.type !== "url_citation") continue;
				const url = firstString(annotation.url);
				if (!url || seen.has(url)) continue;
				seen.add(url);
				cited.push({
					url,
					title: firstString(annotation.title) ?? url,
					snippet: snippetAround(text, annotation.start_index, annotation.end_index),
				});
				if (cited.length >= limit) break;
			}
		}
	}
	const results = cited.length > 0 ? cited : extractResults(output, limit);
	return { answer: answer.trim(), results: results.slice(0, limit) };
}

function parseResponse(payload: unknown, limit: number): SearchOutcome {
	const record = asRecord(payload);
	const output = record && Array.isArray(record.output) ? record.output : [];
	const typedOutput: Array<Record<string, unknown>> = [];
	for (const item of output) {
		const record = asRecord(item);
		if (record) typedOutput.push(record);
	}
	const { answer, results } = extractAnswer(typedOutput, limit);
	if (!answer && results.length === 0) {
		throw new OpenAIError({ message: "OpenAI web_search returned no answer or sources", retryable: false });
	}
	return { provider: "openai" as Provider, answer, results };
}

function searchOnce(
	query: string,
	options: { numResults: number; auth: OpenAIAuth; signal?: AbortSignal | undefined; fetchLike: FetchLike },
): Effect.Effect<SearchOutcome, OpenAIError> {
	return Effect.tryPromise({
		try: async (signal) => {
			const response = await options.fetchLike(OPENAI_RESPONSES_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.auth.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: options.auth.model,
					instructions: SEARCH_INSTRUCTIONS,
					input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
					tools: [{ type: "web_search" }],
					include: ["web_search_call.action.sources"],
					store: false,
					stream: false,
					tool_choice: "required",
				}),
				signal: AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), signal]),
			});
			const text = await response.text();
			if (!response.ok) {
				const parsed = asRecord(safeJson(text));
				const detail = parsed
					? (firstString(parsed.error, parsed.message) ?? redact(text.slice(0, 300), [options.auth.apiKey]))
					: redact(text.slice(0, 300), [options.auth.apiKey]);
				throw new OpenAIError({
					message: `OpenAI API error: ${detail || `HTTP ${response.status}`}`,
					status: response.status,
					retryable: isTransientStatus(response.status),
				});
			}
			return parseResponse(safeJson(text), options.numResults);
		},
		catch: (error) => error instanceof OpenAIError
			? error
			: new OpenAIError({ message: `OpenAI search failed: ${String(error)}`, retryable: true }),
	});
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function openaiSearch(
	query: string,
	options: { numResults: number; recencyFilter?: string | undefined },
	deps: OpenAIDeps,
	signal?: AbortSignal | undefined,
): Effect.Effect<SearchOutcome, OpenAIError> {
	const fetchLike = deps.fetchLike ?? fetch;
	return searchOnce(query, {
		numResults: options.numResults,
		auth: { apiKey: deps.apiKey, model: deps.model },
		signal,
		fetchLike,
	}).pipe(
		Effect.timeout(SEARCH_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new OpenAIError({ message: "OpenAI search timed out", retryable: false }))),
		Effect.retry(retryOptions),
	);
}
