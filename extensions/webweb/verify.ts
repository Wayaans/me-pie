import { Effect } from "effect";
import { MAX_SOURCES, MAX_VERIFY_FETCHES } from "./config.ts";
import type { PageContent, WebResult } from "./firecrawl.ts";

export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";

export interface ResearchPassage {
	readonly passageId: string;
	readonly sourceUrl: string;
	readonly sourceRank: number;
	readonly text: string;
}

export interface ClaimAssessment {
	readonly claim: string;
	readonly status: ClaimStatus;
	readonly supporting: ReadonlyArray<string>;
	readonly contradicting: ReadonlyArray<string>;
	readonly rationale: string;
	readonly confidence: number;
}

export interface VerifyArtifact {
	readonly claim: string;
	readonly assessment: ClaimAssessment;
	readonly passages: ReadonlyArray<ResearchPassage>;
	readonly sources: ReadonlyArray<WebResult>;
	readonly fetched: ReadonlyArray<PageContent>;
}

interface Span {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

export function tokenizeClaim(value: string): Array<string> {
	return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3))];
}

function extractRelevantSpans(content: string, hint: string): Array<Span> {
	const sentences: Array<Span> = [];
	const sentencePattern = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
	for (const match of content.matchAll(sentencePattern)) {
		const raw = match[0];
		const text = raw.trim();
		if (text.length > 0 && text.length <= 400 && match.index !== undefined) {
			const start = match.index + raw.indexOf(text);
			sentences.push({ text, start, end: start + text.length });
		}
	}
	const terms = tokenizeClaim(hint);
	if (terms.length === 0) return [];
	return sentences
		.map((sentence, index) => ({
			sentence,
			index,
			score: terms.filter((term) => sentence.text.toLowerCase().includes(term)).length,
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, 3)
		.map(({ sentence }) => sentence);
}

export function hashContent(text: string): string {
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildPassages(
	sources: ReadonlyArray<WebResult>,
	fetched: ReadonlyArray<PageContent>,
	hint = "",
): Array<ResearchPassage> {
	const passages: Array<ResearchPassage> = [];
	const fetchedByUrl = new Map(fetched.map((page) => [page.url, page]));
	for (const [index, source] of sources.slice(0, MAX_SOURCES).entries()) {
		const rank = index + 1;
		if (source.snippet) {
			passages.push({
				passageId: `p-${rank}-0`,
				sourceUrl: source.url,
				sourceRank: rank,
				text: source.snippet,
			});
		}
		const page = fetchedByUrl.get(source.url);
		if (page && page.content) {
			const passageHint = source.snippet.trim() || hint;
			for (const [spanIndex, span] of extractRelevantSpans(page.content, passageHint).entries()) {
				passages.push({
					passageId: `p-${rank}-${spanIndex + 1}`,
					sourceUrl: source.url,
					sourceRank: rank,
					text: span.text,
				});
			}
		}
	}
	return passages;
}

const CONTRADICTION_MARKERS = [
	"not true",
	"false",
	"incorrect",
	"debunked",
	"retracted",
	"no longer",
	"never",
	"denied",
	"contrary",
	"misleading",
];
const SUPPORT_MARKERS = [
	"yes",
	"true",
	"correct",
	"confirmed",
	"according to",
	"shows that",
	"demonstrates",
	"reported",
	"verified",
	"established",
];

function containsPhrase(value: string, phrase: string): boolean {
	const escaped = phrase.trim().toLowerCase().split(/\s+/)
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(value);
}

function markerIsNegated(value: string, marker: string): boolean {
	const escaped = marker.trim().toLowerCase().split(/\s+/)
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("\\s+");
	const match = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").exec(value);
	if (!match || match.index === undefined) return false;
	const matchedMarker = match[0].replace(/^[^a-z0-9]+/i, "");
	const beforeMarker = value.slice(0, match.index + match[0].length - matchedMarker.length);
	return /(?:^|[^a-z0-9])(?:not|no|never|without)\s+$/i.test(beforeMarker);
}

function hasPolarityMarker(value: string, markers: ReadonlyArray<string>, allowNegated = false): boolean {
	return markers.some((marker) => containsPhrase(value, marker) && (allowNegated || !markerIsNegated(value, marker)));
}

export function assessClaim(claim: string, passages: ReadonlyArray<ResearchPassage>): ClaimAssessment {
	const terms = tokenizeClaim(claim);
	if (terms.length === 0 || passages.length === 0) {
		return {
			claim,
			status: "missing-evidence",
			supporting: [],
			contradicting: [],
			rationale: "No passages available that discuss the claim's terms.",
			confidence: 0.2,
		};
	}
	const supporting: Array<string> = [];
	const contradicting: Array<string> = [];
	for (const passage of passages) {
		const lower = passage.text.toLowerCase();
		const overlap = terms.filter((term) => containsPhrase(lower, term)).length;
		if (overlap < Math.max(2, Math.ceil(terms.length / 4))) continue;
		const contra = hasPolarityMarker(lower, CONTRADICTION_MARKERS);
		const support = hasPolarityMarker(lower, SUPPORT_MARKERS);
		if (contra && !support) contradicting.push(passage.passageId);
		else if (support && !contra) supporting.push(passage.passageId);
	}
	if (contradicting.length > 0 && supporting.length === 0) {
		return {
			claim,
			status: "contradicted",
			supporting: [],
			contradicting,
			rationale: `${contradicting.length} passage(s) contradict the claim; none support it.`,
			confidence: Math.min(0.85, 0.5 + contradicting.length * 0.1),
		};
	}
	if (supporting.length > 0 && contradicting.length === 0) {
		return {
			claim,
			status: "supported",
			supporting,
			contradicting: [],
			rationale: `${supporting.length} passage(s) support the claim; none contradict it.`,
			confidence: Math.min(0.85, 0.5 + supporting.length * 0.1),
		};
	}
	if (supporting.length > 0 && contradicting.length > 0) {
		return {
			claim,
			status: "unclear",
			supporting,
			contradicting,
			rationale: "Passages both support and contradict the claim; manual review needed.",
			confidence: 0.4,
		};
	}
	return {
		claim,
		status: "missing-evidence",
		supporting: [],
		contradicting: [],
		rationale: `${passages.length} passage(s) found, none clearly supportive or contradictory.`,
		confidence: 0.3,
	};
}

export function buildVerifyArtifact(
	claim: string,
	sources: ReadonlyArray<WebResult>,
	fetched: ReadonlyArray<PageContent>,
): VerifyArtifact {
	const passages = buildPassages(sources, fetched, claim);
	return {
		claim,
		assessment: assessClaim(claim, passages),
		passages,
		sources: sources.slice(0, MAX_SOURCES),
		fetched: fetched.slice(0, MAX_VERIFY_FETCHES),
	};
}

export function formatVerifyArtifact(artifact: VerifyArtifact): string {
	const { assessment, passages, sources } = artifact;
	const byId = new Map(passages.map((passage) => [passage.passageId, passage]));
	const renderIds = (ids: ReadonlyArray<string>) =>
		ids.map((id) => {
			const passage = byId.get(id);
			return passage ? `  - ${id} (${passage.sourceUrl}): ${passage.text}` : `  - ${id}`;
		}).join("\n");

	const lines: Array<string> = [
		`Claim: ${assessment.claim}`,
		`Status: ${assessment.status} (confidence ${assessment.confidence.toFixed(2)})`,
		`Rationale: ${assessment.rationale}`,
	];
	if (assessment.supporting.length > 0) {
		lines.push(`\nSupporting passages:\n${renderIds(assessment.supporting)}`);
	}
	if (assessment.contradicting.length > 0) {
		lines.push(`\nContradicting passages:\n${renderIds(assessment.contradicting)}`);
	}
	if (sources.length > 0) {
		lines.push("\nSources:");
		for (const [index, source] of sources.slice(0, 10).entries()) {
			lines.push(`  [${index + 1}] ${source.title} — ${source.url}`);
		}
	}
	return lines.join("\n");
}
