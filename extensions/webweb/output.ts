import type { SearchRunResult } from "./search.ts";
import type { FetchRunResult } from "./fetch.ts";
import type { ReadRunResult } from "./read.ts";
import { displayUrl } from "./url.ts";

export type WebwebDetails =
	| {
		readonly tool: "search";
		readonly status: "answered" | "failed";
		readonly provider: string | null;
		readonly responseId: string | null;
		readonly sourceCount: number;
	}
	| {
		readonly tool: "verify";
		readonly status: "not-assessed" | "failed";
		readonly responseId: string | null;
		readonly sourceCount: number;
		readonly passageCount: number;
	}
	| {
		readonly tool: "fetch";
		readonly status: "fetched" | "cloned" | "failed" | "partial";
		readonly responseId: string | null;
		readonly provider: string | null;
		readonly wordCount: number;
	}
	| {
		readonly tool: "read";
		readonly status: "found" | "not-found";
		readonly matches: number | null;
		readonly chars: number;
	};

export function formatSearchResult(run: SearchRunResult): string {
	const sections: Array<string> = [];
	for (const { query, outcome, primaryError } of run.outcomes) {
		const lines: Array<string> = [];
		if (run.outcomes.length > 1) lines.push(`## ${query}`);
		if (outcome.answer) lines.push(`${outcome.answerKind === "generated-answer" ? "Generated answer, not source text" : "Search snippet summary"}:\n${outcome.answer}`);
		if (outcome.results.length > 0) {
			lines.push("", "Sources:");
			for (const [index, source] of outcome.results.entries()) {
				const snippet = source.snippet ? `\n      Search snippet, not a source quotation: ${source.snippet}` : "\n      Source metadata only; no source text returned.";
				lines.push(`  Source ${index + 1}: ${source.title}: ${source.url}${snippet}`);
			}
		}
		for (const citation of outcome.citations) lines.push(`Citation in generated answer [${citation.startIndex ?? "?"}, ${citation.endIndex ?? "?"}): ${citation.url}`);
		if (primaryError) lines.push("", `Note: primary provider failed, fallback used (${primaryError})`);
		sections.push(lines.join("\n"));
	}
	if (run.includeContentError) sections.push(`Note: ${run.includeContentError}`);
	if (run.responseId) {
		sections.push(`Source records stored under responseId "${run.responseId}". ww_read labels fetched pages, search snippets, or unavailable text; these are not necessarily full source content.`);
	}
	return sections.join("\n\n");
}

export function formatFetchResult(run: FetchRunResult): string {
	const sections: Array<string> = [];
	for (const [index, item] of run.items.entries()) {
		const header = `[${index + 1}] ${displayUrl(item.url)}`;
		if (item.status === "failed") {
			sections.push(`${header}\nFAILED: ${item.error}`);
			continue;
		}
		if (item.status === "cloned") {
			sections.push(
				`${header}\nGitHub repository preview. Use ww_fetch with GitHub /tree/ or /blob/ URLs to inspect other paths.\n\n${item.content}`,
			);
			continue;
		}
		sections.push(`${header}\n(${item.provider}) ${item.title ?? ""}\n\n${item.content}`);
	}
	if (run.responseId) {
		sections.push(`Fetched content stored under responseId "${run.responseId}". Use ww_read to retrieve slices.`);
	}
	return sections.join("\n\n---\n\n");
}

export function formatReadResult(run: ReadRunResult): string {
	if (run.error) return `Not found: ${run.error}`;
	if (run.matches) {
		if (run.matches.length === 0) return "No passages matched the requested text.";
		return run.matches
			.map((match, index) => `Match ${index + 1} [${match.contentKind ?? "legacy content, provenance unknown"}] (${match.fetchedUrl ?? match.url}):\n${match.excerpt}`)
			.join("\n\n");
	}
	if (run.source) {
		return `${run.source.title}: ${run.source.url}\nContent kind: ${run.source.contentKind ?? "legacy content, provenance unknown"}${run.source.fetchedUrl ? `\nFetched URL: ${run.source.fetchedUrl}` : ""}\n\n${run.slice ?? ""}`;
	}
	return "No content available for this responseId.";
}

export function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}
