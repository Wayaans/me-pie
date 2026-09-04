import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Type } from "typebox";
import { handleWebwebCommand } from "./command.ts";
import { globalConfigPath } from "./config.ts";
import { createGitHubSession, cleanupGitHubSession, type GitHubSession } from "./github.ts";
import { formatFetchResult, formatReadResult, formatSearchResult, wordCount, type WebwebDetails } from "./output.ts";
import { runFetch, type FetchDeps, type FetchRunResult } from "./fetch.ts";
import { runRead } from "./read.ts";
import { runSearch, runVerify, type SearchDeps, type SearchRunResult, type VerifyRunResult } from "./search.ts";
import { formatVerifyArtifact } from "./verify.ts";

interface Session {
	readonly temporaryDirectories: Set<string>;
	readonly github: GitHubSession;
}

function createSession(): Session {
	return { temporaryDirectories: new Set(), github: createGitHubSession() };
}

async function cleanupSession(session: Session): Promise<void> {
	const directories = [...session.temporaryDirectories];
	session.temporaryDirectories.clear();
	await Promise.allSettled(directories.map((directory) => rm(directory, { recursive: true, force: true })));
	await cleanupGitHubSession(session.github);
}

function searchDeps(signal?: AbortSignal): SearchDeps {
	return { signal };
}

function fetchDeps(session: Session, signal?: AbortSignal, execLike?: FetchDeps["execLike"]): FetchDeps {
	return { signal, github: session.github, execLike };
}

/** Truncate to Pi limits; overflow goes to a session-tracked temp file. */
async function makeTextToolResult(
	text: string,
	details: WebwebDetails,
	temporaryDirectories: Set<string>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: WebwebDetails }> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return { content: [{ type: "text" as const, text: truncation.content || "No output" }], details };
	}
	const tempDir = await mkdtemp(path.join(tmpdir(), "webweb-"));
	const tempFile = path.join(tempDir, "output.txt");
	await writeFile(tempFile, text, { encoding: "utf8", mode: 0o600 });
	temporaryDirectories.add(tempDir);

	const resultText = `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
	return {
		content: [{ type: "text" as const, text: resultText }],
		details,
	};
}

/** One-line collapsed summary for any webweb tool result. */
function summaryFor(details: WebwebDetails | undefined): string {
	if (!details) return "";
	switch (details.tool) {
		case "search":
			return details.status === "failed"
				? "failed"
				: `${details.sourceCount} sources · via ${details.provider ?? "n/a"}${details.responseId ? ` · id: ${details.responseId}` : ""}`;
		case "verify":
			return details.status === "failed"
				? "failed"
				: `${details.status} · ${details.passageCount} passages · ${details.sourceCount} sources`;
		case "fetch":
			return details.status === "failed"
				? "failed"
				: details.status === "cloned"
					? `cloned · ${details.wordCount} words`
					: `${details.status} · ${details.provider ?? "http"} · ${details.wordCount} words${details.responseId ? ` · id: ${details.responseId}` : ""}`;
		case "read":
			return details.status === "not-found"
				? "not found"
				: details.matches !== null
					? `${details.matches} match(es)`
					: `${details.chars} chars`;
	}
}

const SearchParams = Type.Object({
	query: Type.Optional(Type.String({
		description: "Single search query",
		minLength: 1,
		maxLength: 2000,
	})),
	queries: Type.Optional(Type.Array(Type.String(), {
		description: "Multiple queries searched in sequence, each returning its own answer. Prefer this for research: vary phrasing and scope across 2-4 queries",
		maxItems: 4,
	})),
	numResults: Type.Optional(Type.Integer({
		description: "Results per query (default: 5, max: 20)",
		minimum: 1,
		maximum: 20,
	})),
	recencyFilter: Type.Optional(Type.Union([
		Type.Literal("day"),
		Type.Literal("week"),
		Type.Literal("month"),
		Type.Literal("year"),
	], { description: "Filter by recency" })),
	domainFilter: Type.Optional(Type.Array(Type.String(), {
		description: "Limit to domains (prefix with - to exclude)",
	})),
	includeContent: Type.Optional(Type.Boolean({
		description: "Fetch full page content from the top sources in the background",
	})),
	mode: Type.Optional(Type.Union([
		Type.Literal("search"),
		Type.Literal("verify"),
	], { description: "search (default) returns a synthesized answer; verify fact-checks the claim parameter" })),
	claim: Type.Optional(Type.String({
		description: "The assertion to check (required when mode is verify)",
		minLength: 1,
		maxLength: 2000,
	})),
	fetchContent: Type.Optional(Type.Boolean({
		description: "verify mode: fetch up to 5 source pages for passage extraction",
	})),
});

const searchTool = (session: Session) =>
	defineTool({
		name: "ww_search",
		label: "WW Search",
		description:
			"Search the web with a synthesized answer and source citations. Firecrawl is the primary provider, OpenAI the fallback. mode 'verify' fact-checks a claim and returns supported/contradicted/unclear/missing-evidence with passage citations.",
		promptSnippet: "Search the web or fact-check a claim (Firecrawl primary, OpenAI fallback)",
		promptGuidelines: [
			"For research, prefer queries (plural) with 2-4 varied angles over a single query.",
			"Use mode verify with the claim parameter to check a specific assertion against web sources.",
		],
		parameters: SearchParams,

		async execute(_toolCallId, params, signal) {
			const deps = searchDeps(signal);
			if (params.mode === "verify") {
				if (!params.claim) {
					throw new Error("mode 'verify' requires the claim parameter");
				}
				const run = await Effect.runPromise(runVerify({
					claim: params.claim,
					domainFilter: params.domainFilter,
					numResults: params.numResults,
					fetchContent: params.fetchContent,
				}, deps));
				const text = formatVerifyArtifact(run.artifact);
				const details: WebwebDetails = {
					tool: "verify",
					status: run.artifact.assessment.status,
					responseId: run.responseId,
					sourceCount: run.artifact.sources.length,
					passageCount: run.artifact.passages.length,
				};
				return makeTextToolResult(text, details, session.temporaryDirectories);
			}
			const run: SearchRunResult = await Effect.runPromise(runSearch({
				query: params.query,
				queries: params.queries,
				numResults: params.numResults,
				recencyFilter: params.recencyFilter,
				domainFilter: params.domainFilter,
				includeContent: params.includeContent,
			}, deps));
			const text = formatSearchResult(run);
			const details: WebwebDetails = {
				tool: "search",
				status: "answered",
				provider: run.provider,
				responseId: run.responseId,
				sourceCount: run.outcomes.reduce((sum, outcome) => sum + outcome.outcome.results.length, 0),
			};
			return makeTextToolResult(text, details, session.temporaryDirectories);
		},

		renderCall(args, theme) {
			const isVerify = args.mode === "verify";
			const queries = args.queries ?? [];
			const subject = isVerify
				? `verify: ${args.claim ?? ""}`
				: (args.query ?? queries.join(" | "));
			const truncated = subject.length > 70 ? `${subject.slice(0, 69)}…` : subject;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("⚡ ww_search"))} ${truncated}`,
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as WebwebDetails | undefined;
			const summary = summaryFor(details);
			if (!options.expanded) {
				return new Text(summary ? theme.fg("dim", `↳ ${summary}`) : "", 0, 0);
			}
			const full = result.content.find((content) => content.type === "text");
			return new Text(full?.type === "text" ? full.text : "", 0, 0);
		},
	});

const FetchParams = Type.Object({
	url: Type.Optional(Type.String({
		description: "Single URL to fetch",
		minLength: 1,
		maxLength: 2000,
	})),
	urls: Type.Optional(Type.Array(Type.String(), {
		description: "Multiple URLs (parallel, max 5)",
		maxItems: 5,
	})),
	mode: Type.Optional(Type.Union([
		Type.Literal("readable"),
		Type.Literal("raw"),
	], { description: "readable (default) extracts markdown; raw returns the exact textual HTTP body" })),
	forceClone: Type.Optional(Type.Boolean({
		description: "Clone GitHub repos that exceed the 350MB size threshold",
	})),
});

const fetchTool = (session: Session, pi: ExtensionAPI) =>
	defineTool({
		name: "ww_fetch",
		label: "WW Fetch",
		description:
			"Fetch URL(s) as readable markdown (Firecrawl scrape primary, keyless HTTP extraction fallback). GitHub URLs are cloned locally: root returns tree + README, /tree/ paths return listings, /blob/ paths return file contents. raw mode returns the exact textual HTTP body.",
		promptSnippet: "Fetch URL content as markdown; clones GitHub repos for real file access",
		parameters: FetchParams,

		async execute(_toolCallId, params, signal) {
			const run: FetchRunResult = await Effect.runPromise(runFetch({
				url: params.url,
				urls: params.urls,
				mode: params.mode,
				forceClone: params.forceClone,
			}, fetchDeps(session, signal, (command, args, options) => pi.exec(command, args, {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
			}))));
			const text = formatFetchResult(run);
			const fetched = run.items.filter((item) => item.status !== "failed");
			const words = run.items.reduce((sum, item) => sum + (item.content ? wordCount(item.content) : 0), 0);
			const statuses = new Set(run.items.map((item) => item.status));
			const status = statuses.has("failed")
				? (fetched.length > 0 ? "partial" as const : "failed" as const)
				: statuses.has("cloned") ? "cloned" as const : "fetched" as const;
			const details: WebwebDetails = {
				tool: "fetch",
				status,
				responseId: run.responseId,
				provider: run.items[0]?.provider ?? null,
				wordCount: words,
			};
			return makeTextToolResult(text, details, session.temporaryDirectories);
		},

		renderCall(args, theme) {
			const urls = args.urls ?? [];
			const subject = args.url ?? `${urls.length} urls`;
			const truncated = subject.length > 70 ? `${subject.slice(0, 69)}…` : subject;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("⚡ ww_fetch"))} ${truncated}`,
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as WebwebDetails | undefined;
			const summary = summaryFor(details);
			if (!options.expanded) {
				return new Text(summary ? theme.fg("dim", `↳ ${summary}`) : "", 0, 0);
			}
			const full = result.content.find((content) => content.type === "text");
			return new Text(full?.type === "text" ? full.text : "", 0, 0);
		},
	});

const ReadParams = Type.Object({
	responseId: Type.String({
		description: "The responseId from a previous ww_search, ww_fetch, or verify call",
		minLength: 8,
		maxLength: 8,
	}),
	url: Type.Optional(Type.String({ description: "Get content for this URL" })),
	urlIndex: Type.Optional(Type.Integer({ description: "Get content for the source at this index", minimum: 0 })),
	findText: Type.Optional(Type.Union([
		Type.String({ minLength: 1, maxLength: 500 }),
		Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
	], { description: "Text or texts to find in the stored content. Cannot be combined with offset/limit" })),
	findMode: Type.Optional(Type.Union([
		Type.Literal("exact"),
		Type.Literal("case-insensitive"),
		Type.Literal("fuzzy"),
	], { description: "Matching mode for findText (default: case-insensitive)" })),
	offset: Type.Optional(Type.Integer({
		description: "Character offset for content slices (default: 0). Cannot be combined with findText",
		minimum: 0,
	})),
	limit: Type.Optional(Type.Integer({
		description: "Maximum characters to return (default and max: 30000). Cannot be combined with findText",
		minimum: 1,
		maximum: 30_000,
	})),
});

const readTool = () =>
	defineTool({
		name: "ww_read",
		label: "WW Read",
		description:
			"Retrieve stored content from a previous ww_search or ww_fetch via its responseId. Use findText to locate passages without paging through the full content, or offset/limit for intentional slices. Cache lifetime is 1 hour.",
		promptSnippet: "Retrieve stored web content by responseId; supports passage lookup",
		parameters: ReadParams,

		async execute(_toolCallId, params) {
			const run = await Effect.runPromise(runRead({
				responseId: params.responseId,
				url: params.url,
				urlIndex: params.urlIndex,
				findText: params.findText,
				findMode: params.findMode,
				offset: params.offset,
				limit: params.limit,
			}));
			const text = formatReadResult(run);
			const details: WebwebDetails = {
				tool: "read",
				status: run.status,
				matches: run.matches ? run.matches.length : null,
				chars: run.slice ? run.slice.length : 0,
			};
			return { content: [{ type: "text" as const, text }], details };
		},

		renderCall(args, theme) {
			const findText = Array.isArray(args.findText)
				? args.findText.join(", ")
				: args.findText ?? null;
			const parts = [args.responseId];
			if (findText) parts.push(`find "${findText.length > 40 ? `${findText.slice(0, 39)}…` : findText}"`);
			if (typeof args.offset === "number") parts.push(`@${args.offset}`);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("⚡ ww_read"))} ${parts.join(" · ")}`,
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as WebwebDetails | undefined;
			const summary = summaryFor(details);
			if (!options.expanded) {
				return new Text(summary ? theme.fg("dim", `↳ ${summary}`) : "", 0, 0);
			}
			const full = result.content.find((content) => content.type === "text");
			return new Text(full?.type === "text" ? full.text : "", 0, 0);
		},
	});

export default function webwebExtension(pi: ExtensionAPI): void {
	const session = createSession();

	pi.registerTool(searchTool(session));
	pi.registerTool(fetchTool(session, pi));
	pi.registerTool(readTool());

	pi.registerCommand("webweb", {
		description: "Configure webweb providers: paste API keys, view status, clear keys",
		getArgumentCompletions: (argumentPrefix) => {
			const subcommands = ["firecrawl", "openai", "status", "clear"];
			return subcommands
				.filter((sub) => sub.startsWith(argumentPrefix))
				.map((sub) => ({ value: sub, label: sub }));
		},
		handler: (args, ctx) => handleWebwebCommand(args, ctx, globalConfigPath()),
	});

	pi.on("session_shutdown", async () => {
		await cleanupSession(session);
	});
}
