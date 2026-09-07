import { Effect, Schedule } from "effect";
import { OPENAI_RESPONSES_URL } from "./config.ts";
import { OpenAIError, isTransientStatus, redact, type Provider } from "./errors.ts";
import type { AnswerCitation, SearchOutcome, WebResult, FetchLike } from "./firecrawl.ts";
import { parseDomainFilters, type DomainFilters } from "./filters.ts";
import { asRecord, firstString } from "./firecrawl.ts";
import { awaitResponse, BodyLimitError, PROVIDER_BODY_LIMIT, readText, withAbort } from "./network.ts";

const SEARCH_TIMEOUT_MS = 60_000;

const retryOptions = {
	times: 2,
	schedule: Schedule.exponential(200),
	while: (error: OpenAIError) => error.retryable,
} as const;

const SEARCH_INSTRUCTIONS = [
	"You are a web research assistant inside a coding agent.",
	"Search the web and answer the user's query with a concise, factual summary.",
	"Cite sources using web search URL citations.",
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

function extractResults(output: Array<Record<string, unknown>>): Array<WebResult> {
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
		}
	}
	return results;
}

function extractAnswer(
	output: Array<Record<string, unknown>>,
): { answer: string; results: Array<WebResult>; citations: Array<AnswerCitation> } {
	const sources = new Map(extractResults(output).map((source) => [source.url, source]));
	const citations: Array<AnswerCitation> = [];
	let answer = "";
	for (const item of output) {
		if (item.type !== "message") continue;
		const contents = Array.isArray(item.content) ? item.content : [];
		for (const rawContent of contents) {
			const content = asRecord(rawContent);
			if (!content || content.type !== "output_text") continue;
			const text = typeof content.text === "string" ? content.text : "";
			const offset = answer.length;
			answer += text;
			const annotations = Array.isArray(content.annotations) ? content.annotations : [];
			for (const rawAnnotation of annotations) {
				const annotation = asRecord(rawAnnotation);
				if (!annotation || annotation.type !== "url_citation") continue;
				const url = firstString(annotation.url);
				if (!url) continue;
				const title = firstString(annotation.title) ?? sources.get(url)?.title ?? url;
				const start = annotation.start_index;
				const end = annotation.end_index;
				const valid = typeof start === "number" && Number.isInteger(start) && typeof end === "number" && Number.isInteger(end)
					&& start >= 0 && end > start && end <= text.length;
				citations.push({ url, title, startIndex: valid ? offset + start : null, endIndex: valid ? offset + end : null });
				sources.set(url, { url, title, snippet: "" });
			}
		}
	}
	return { answer, results: [...sources.values()], citations };
}

function parseResponse(payload: unknown): SearchOutcome {
	const record = asRecord(payload);
	const output = record && Array.isArray(record.output) ? record.output : [];
	const typedOutput: Array<Record<string, unknown>> = [];
	for (const item of output) {
		const record = asRecord(item);
		if (record) typedOutput.push(record);
	}
	const { answer, results, citations } = extractAnswer(typedOutput);
	if (!answer && results.length === 0) {
		throw new OpenAIError({ message: "OpenAI web_search returned no answer or sources", retryable: false });
	}
	return { provider: "openai" as Provider, answer, answerKind: "generated-answer", results, citations };
}

function searchOnce(
	query: string,
	options: { numResults: number; domains: DomainFilters; auth: OpenAIAuth; signal?: AbortSignal | undefined; fetchLike: FetchLike },
): Effect.Effect<SearchOutcome, OpenAIError> {
	return Effect.tryPromise({
		try: async (signal) => {
			const combined = AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), signal, ...(options.signal ? [options.signal] : [])]);
			combined.throwIfAborted();
			const response = await awaitResponse(options.fetchLike(OPENAI_RESPONSES_URL, {
				redirect: "manual",
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.auth.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: options.auth.model,
					instructions: `${SEARCH_INSTRUCTIONS} Aim for ${options.numResults} sources.`,
					input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
					tools: [{ type: "web_search", filters: {
						...(options.domains.include.length ? { allowed_domains: options.domains.include } : {}),
						...(options.domains.exclude.length ? { blocked_domains: options.domains.exclude } : {}),
					} }],
					include: ["web_search_call.action.sources"],
					store: false,
					stream: false,
					tool_choice: "required",
				}),
				signal: combined,
			}), combined);
			if (response.status >= 300 && response.status < 400) {
				void response.body?.cancel().catch(() => {});
				throw new OpenAIError({ message: "OpenAI redirect blocked", retryable: false, terminal: true });
			}
			const text = await readText(response, PROVIDER_BODY_LIMIT, combined);
			if (!response.ok) {
				const parsed = asRecord(safeJson(text));
				const detail = parsed
					? (firstString(parsed.error, parsed.message) ?? text)
					: text;
				throw new OpenAIError({
					message: `OpenAI API error: ${redact(detail || `HTTP ${response.status}`, [options.auth.apiKey]).slice(0, 300)}`,
					status: response.status,
					retryable: isTransientStatus(response.status),
				});
			}
			return parseResponse(safeJson(text));
		},
		catch: (error) => error instanceof OpenAIError
			? error
			: new OpenAIError({
				message: `OpenAI search failed: ${redact(String(error), [options.auth.apiKey]).slice(0, 300)}`,
				retryable: !(error instanceof BodyLimitError) && !options.signal?.aborted,
				terminal: error instanceof BodyLimitError || options.signal?.aborted === true,
			}),
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
	options: { numResults: number; recencyFilter?: string | undefined; domainFilter?: Array<string> | undefined },
	deps: OpenAIDeps,
	signal?: AbortSignal | undefined,
): Effect.Effect<SearchOutcome, OpenAIError> {
	if (options.recencyFilter) return Effect.fail(new OpenAIError({ message: "OpenAI search cannot honor recencyFilter; fallback refused. Use Firecrawl or remove the recency constraint explicitly.", retryable: false, terminal: true }));
	let domains: DomainFilters;
	try {
		domains = parseDomainFilters(options.domainFilter);
	} catch (error) {
		return Effect.fail(new OpenAIError({ message: String(error), retryable: false, terminal: true }));
	}
	const fetchLike = deps.fetchLike ?? fetch;
	return searchOnce(query, {
		numResults: options.numResults,
		domains,
		auth: { apiKey: deps.apiKey, model: deps.model },
		signal,
		fetchLike,
	}).pipe(
		Effect.timeout(SEARCH_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new OpenAIError({ message: "OpenAI search timed out", retryable: false }))),
		Effect.retry(retryOptions),
		Effect.mapError((error) => new OpenAIError({ ...error, message: redact(error.message, [deps.apiKey]).slice(0, 400) })),
		(effect) => withAbort(effect, signal),
	);
}
