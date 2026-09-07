import { MAX_SOURCES, MAX_VERIFY_FETCHES } from "./config.ts";
import type { AnswerCitation, PageContent, WebResult } from "./firecrawl.ts";

export interface ResearchPassage {
	readonly passageId: string;
	readonly sourceUrl: string;
	readonly sourceRank: number;
	readonly text: string;
	readonly provenance: "search-snippet" | "fetched-page-excerpt";
}

export interface VerifyArtifact {
	readonly claim: string;
	readonly status: "not-assessed";
	readonly passages: ReadonlyArray<ResearchPassage>;
	readonly sources: ReadonlyArray<WebResult>;
	readonly fetched: ReadonlyArray<PageContent>;
	readonly generatedAnswer: string | null;
	readonly citations: ReadonlyArray<AnswerCitation>;
}

/** Keyword ranking selects reading material only. It does not establish entailment. */
function relevantExcerpts(content: string, claim: string): Array<string> {
	const terms = [...new Set(claim.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))];
	return [...content.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)]
		.map((match, index) => ({ text: match[0].trim(), index }))
		.filter(({ text }) => text.length > 0 && text.length <= 400)
		.map((span) => ({ ...span, score: terms.filter((term) => span.text.toLowerCase().includes(term)).length }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 3)
		.map(({ text }) => text);
}

export function buildPassages(
	sources: ReadonlyArray<WebResult>,
	fetched: ReadonlyArray<PageContent>,
	claim = "",
): Array<ResearchPassage> {
	const passages: Array<ResearchPassage> = [];
	const fetchedByUrl = new Map(fetched.map((page) => [page.requestedUrl ?? page.url, page]));
	for (const [index, source] of sources.slice(0, MAX_SOURCES).entries()) {
		const sourceRank = index + 1;
		if (source.snippet) passages.push({
			passageId: `p-${sourceRank}-0`, sourceUrl: source.url, sourceRank,
			text: source.snippet, provenance: "search-snippet",
		});
		const page = fetchedByUrl.get(source.url);
		if (!page) continue;
		for (const [spanIndex, text] of relevantExcerpts(page.content, claim).entries()) {
			passages.push({ passageId: `p-${sourceRank}-${spanIndex + 1}`, sourceUrl: page.url, sourceRank,
				text, provenance: "fetched-page-excerpt" });
		}
	}
	return passages;
}

export function buildVerifyArtifact(
	claim: string,
	sources: ReadonlyArray<WebResult>,
	fetched: ReadonlyArray<PageContent>,
	generatedAnswer: string | null = null,
	citations: ReadonlyArray<AnswerCitation> = [],
): VerifyArtifact {
	const pages = fetched.slice(0, MAX_VERIFY_FETCHES);
	return { claim, status: "not-assessed", passages: buildPassages(sources, pages, claim), sources,
		fetched: pages, generatedAnswer, citations };
}

export function formatVerifyArtifact(artifact: VerifyArtifact): string {
	const lines = [
		`Claim: ${artifact.claim}`,
		"Status: not-assessed. Evidence collected for caller assessment; no factual verdict or confidence score is assigned.",
		"Search snippets are not source quotations. Fetched-page excerpts are selected by keyword relevance, not support or contradiction.",
	];
	if (artifact.generatedAnswer) lines.push(`\nGenerated answer, not source text:\n${artifact.generatedAnswer}`);
	if (artifact.passages.length === 0) lines.push("\nNo snippets or relevant fetched excerpts collected. This does not establish absence of evidence.");
	for (const passage of artifact.passages) {
		lines.push(`\n${passage.passageId} [${passage.provenance}] (${passage.sourceUrl}):\n${passage.text}`);
	}
	if (artifact.sources.length) lines.push("\nSources:");
	for (const [index, source] of artifact.sources.entries()) lines.push(`  Source ${index + 1}: ${source.title}: ${source.url}`);
	for (const citation of artifact.citations) lines.push(`Citation in generated answer [${citation.startIndex ?? "?"}, ${citation.endIndex ?? "?"}): ${citation.url}`);
	return lines.join("\n");
}
