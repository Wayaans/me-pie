import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";

export type GitHubReferenceKind = "issue" | "pull-request";

export type GitHubBlocker = {
	number: number;
	repository?: string;
};

export type GitHubReference = {
	kind: GitHubReferenceKind;
	number: number;
	title: string;
	updatedAt: string;
	isDraft: boolean;
	blockers: GitHubBlocker[];
};

type GitHubListItem = {
	number?: unknown;
	title?: unknown;
	updatedAt?: unknown;
	isDraft?: unknown;
	url?: unknown;
	blockedBy?: unknown;
};

type GitHubBlockedByNode = {
	number?: unknown;
	state?: unknown;
	url?: unknown;
};

export const MAX_ITEMS_PER_KIND = 500;
export const MAX_SUGGESTIONS = 20;

export function extractGitHubReferenceToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
	return match?.[1];
}

function issueRepository(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;

	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		if (segments.length < 4 || segments[2] !== "issues") return undefined;
		return `${segments[0]}/${segments[1]}`;
	} catch {
		return undefined;
	}
}

function parseBlockers(item: GitHubListItem, index: number): GitHubBlocker[] {
	const repository = issueRepository(item.url);
	if (!repository || typeof item.blockedBy !== "object" || item.blockedBy === null) {
		throw new Error(`invalid item at index ${index}`);
	}

	const nodes = "nodes" in item.blockedBy ? item.blockedBy.nodes : undefined;
	if (!Array.isArray(nodes)) throw new Error(`invalid item at index ${index}`);

	return nodes.flatMap((node) => {
		const blocker = node as GitHubBlockedByNode;
		const blockerRepository = issueRepository(blocker.url);
		if (
			typeof blocker.number !== "number" ||
			typeof blocker.state !== "string" ||
			!blockerRepository
		) {
			throw new Error(`invalid item at index ${index}`);
		}
		if (blocker.state !== "OPEN") return [];

		return [{
			number: blocker.number,
			...(blockerRepository === repository ? {} : { repository: blockerRepository }),
		}];
	});
}

export function parseGitHubReferences(json: string, kind: GitHubReferenceKind): GitHubReference[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) {
		throw new Error("expected a JSON array");
	}

	return parsed.map((item, index) => {
		const value = item as GitHubListItem;
		if (
			typeof value.number !== "number" ||
			typeof value.title !== "string" ||
			typeof value.updatedAt !== "string"
		) {
			throw new Error(`invalid item at index ${index}`);
		}

		return {
			kind,
			number: value.number,
			title: value.title,
			updatedAt: value.updatedAt,
			isDraft: kind === "pull-request" && value.isDraft === true,
			blockers: kind === "issue" ? parseBlockers(value, index) : [],
		};
	});
}

export function sortGitHubReferences(references: GitHubReference[]): GitHubReference[] {
	return [...references].sort((left, right) => {
		const updatedDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		return updatedDifference || right.number - left.number;
	});
}

function formatReferenceItem(reference: GitHubReference): AutocompleteItem {
	const kind = reference.kind === "issue" ? "issue" : reference.isDraft ? "draft PR" : "PR";
	const blockerTag = reference.blockers.length > 0
		? ` [block ${reference.blockers.map((blocker) => `${blocker.repository ?? ""}#${blocker.number}`).join(" ")}]`
		: "";
	return {
		value: `#${reference.number}`,
		label: `#${reference.number}`,
		description: `[${kind}]${blockerTag} ${reference.title}`,
	};
}

export function filterGitHubReferences(references: GitHubReference[], query: string): AutocompleteItem[] {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) {
		return references.slice(0, MAX_SUGGESTIONS).map(formatReferenceItem);
	}

	if (/^\d+$/.test(normalizedQuery)) {
		const numericMatches = references
			.filter((reference) => String(reference.number).startsWith(normalizedQuery))
			.slice(0, MAX_SUGGESTIONS)
			.map(formatReferenceItem);
		if (numericMatches.length > 0) {
			return numericMatches;
		}
	}

	return fuzzyFilter(references, normalizedQuery, (reference) => {
		const kind = reference.kind === "issue" ? "issue" : reference.isDraft ? "draft pull request pr" : "pull request pr";
		return `${reference.number} ${kind} ${reference.title}`;
	})
		.slice(0, MAX_SUGGESTIONS)
		.map(formatReferenceItem);
}
