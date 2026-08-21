import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { GitHubClient } from "./client.ts";
import {
	extractGitHubReferenceToken,
	filterGitHubReferences,
	MAX_ITEMS_PER_KIND,
	parseGitHubReferences,
	sortGitHubReferences,
	type GitHubReference,
	type GitHubReferenceKind,
} from "./references.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function resolveRepo(
	client: GitHubClient,
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	return (await client.repo(cwd, undefined, signal)).nameWithOwner;
}

async function loadReferenceKind(
	client: GitHubClient,
	cwd: string,
	repo: string,
	kind: GitHubReferenceKind,
	signal: AbortSignal,
): Promise<GitHubReference[]> {
	const command = kind === "issue" ? "issue" : "pr";
	const fields = kind === "issue"
		? "number,title,updatedAt,url,blockedBy"
		: "number,title,updatedAt,isDraft";
	const stdout = await client.readText(
		cwd,
		[
			command,
			"list",
			"--repo",
			repo,
			"--state",
			"open",
			"--limit",
			String(MAX_ITEMS_PER_KIND),
			"--json",
			fields,
		],
		`${command} autocomplete failed`,
		signal,
	);
	try {
		return parseGitHubReferences(stdout, kind);
	} catch (error) {
		client.invalidate(repo);
		throw error;
	}
}

async function loadReferences(
	client: GitHubClient,
	cwd: string,
	signal: AbortSignal,
): Promise<GitHubReference[]> {
	const repo = await resolveRepo(client, cwd, signal);
	const [issues, pullRequests] = await Promise.all([
		loadReferenceKind(client, cwd, repo, "issue", signal),
		loadReferenceKind(client, cwd, repo, "pull-request", signal),
	]);
	return sortGitHubReferences([...issues, ...pullRequests]);
}

export function createGitHubAutocomplete(
	client: GitHubClient,
	current: AutocompleteProvider,
	cwd: string,
	notify: (message: string) => void,
): AutocompleteProvider {
	let cachedReferences: GitHubReference[] | undefined;

	const getReferences = async (signal: AbortSignal): Promise<GitHubReference[] | undefined> => {
		if (cachedReferences) return cachedReferences;
		try {
			const references = await loadReferences(client, cwd, signal);
			cachedReferences = references;
			return references;
		} catch (error) {
			if (!signal.aborted) notify(`pi-github: ${errorMessage(error)}`);
			return undefined;
		}
	};

	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const token = extractGitHubReferenceToken(currentLine.slice(0, cursorCol));
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			if (options.signal.aborted) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const references = await getReferences(options.signal);
			if (options.signal.aborted || !references) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = filterGitHubReferences(references, token);
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			return { items, prefix: `#${token}` };
		},
		applyCompletion: current.applyCompletion.bind(current),
		...(current.shouldTriggerFileCompletion
			? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) }
			: {}),
	};
}
