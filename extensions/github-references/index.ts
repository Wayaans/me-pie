import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Text, type AutocompleteProvider, type AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	extractGitHubReferenceToken,
	filterGitHubReferences,
	MAX_ITEMS_PER_KIND,
	parseGitHubReferences,
	sortGitHubReferences,
	type GitHubReference,
	type GitHubReferenceKind,
} from "./references.ts";
import {
	DEFAULT_COMMENT_LIMIT,
	formatGitHubCommentsPage,
	formatGitHubOverview,
	MAX_COMMENT_LIMIT,
	parseGitHubComments,
	parseGitHubIssue,
	parseGitHubPullRequest,
	planCommentPage,
	type CommentPagePlan,
	type GitHubComment,
	type GitHubIssueData,
	type GitHubPullRequestData,
} from "./tools.ts";

type RepoResolution = { ok: true; nameWithOwner: string } | { ok: false; error: string };
type ReferenceLoad = { references: GitHubReference[]; error?: string };
type LoadedCommentPage = {
	issue: GitHubIssueData;
	comments: GitHubComment[];
	plan: CommentPagePlan;
};
type GitHubGetDetails = {
	number: number;
	kind: GitHubIssueData["kind"];
	commentCount: number;
	fullOutputPath?: string;
};
type GitHubGetRenderState = {
	status?: "success" | "error" | undefined;
	kind?: GitHubIssueData["kind"] | undefined;
	callComponent?: Text | undefined;
};

const COMMAND_TIMEOUT_MS = 10_000;
const PULL_REQUEST_FIELDS = [
	"number",
	"baseRefName",
	"headRefName",
	"isDraft",
	"additions",
	"deletions",
	"changedFiles",
	"mergeable",
	"mergeStateStatus",
	"reviewDecision",
	"reviewRequests",
].join(",");

function commandError(label: string, stderr: string, code: number): string {
	const details = stderr.trim() || `exit code ${code}`;
	return `${label}: ${details}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<RepoResolution> {
	try {
		const result = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner"], {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			return { ok: false, error: commandError("could not resolve the current GitHub repository", result.stderr, result.code) };
		}

		const parsed: unknown = JSON.parse(result.stdout);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("nameWithOwner" in parsed) ||
			typeof parsed.nameWithOwner !== "string" ||
			!parsed.nameWithOwner.includes("/")
		) {
			return { ok: false, error: "could not parse the current GitHub repository" };
		}

		return { ok: true, nameWithOwner: parsed.nameWithOwner };
	} catch (error) {
		return { ok: false, error: `could not resolve the current GitHub repository: ${errorMessage(error)}` };
	}
}

async function runGitHubCommand(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	label: string,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const result = await pi.exec("gh", args, {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		});
		if (result.code !== 0) throw new Error(commandError(label, result.stderr, result.code));
		return result.stdout;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
		throw new Error(`${label}: ${errorMessage(error)}`);
	}
}

async function loadReferenceKind(
	pi: ExtensionAPI,
	cwd: string,
	kind: GitHubReferenceKind,
): Promise<ReferenceLoad> {
	const noun = kind === "issue" ? "issues" : "pull requests";
	const args = [
		kind === "issue" ? "issue" : "pr",
		"list",
		"--state",
		"open",
		"--limit",
		String(MAX_ITEMS_PER_KIND),
		"--json",
		kind === "issue" ? "number,title,updatedAt,url,blockedBy" : "number,title,updatedAt,isDraft",
	];

	try {
		const result = await pi.exec("gh", args, { cwd, timeout: COMMAND_TIMEOUT_MS });
		if (result.code !== 0) {
			return { references: [], error: commandError(`failed to load ${noun}`, result.stderr, result.code) };
		}

		try {
			return { references: parseGitHubReferences(result.stdout, kind) };
		} catch (error) {
			return { references: [], error: `failed to parse ${noun}: ${errorMessage(error)}` };
		}
	} catch (error) {
		return { references: [], error: `failed to load ${noun}: ${errorMessage(error)}` };
	}
}

async function loadGitHubReferences(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ references: GitHubReference[]; errors: string[] }> {
	const [issues, pullRequests] = await Promise.all([
		loadReferenceKind(pi, cwd, "issue"),
		loadReferenceKind(pi, cwd, "pull-request"),
	]);

	return {
		references: sortGitHubReferences([...issues.references, ...pullRequests.references]),
		errors: [issues.error, pullRequests.error].filter((error): error is string => error !== undefined),
	};
}

function createGitHubAutocompleteProvider(
	current: AutocompleteProvider,
	getReferences: () => Promise<GitHubReference[] | undefined>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const token = extractGitHubReferenceToken(currentLine.slice(0, cursorCol));
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const references = await getReferences();
			if (options.signal.aborted || !references || references.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const items = filterGitHubReferences(references, token);
			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { items, prefix: `#${token}` };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
	const existing = cache.get(key);
	if (existing) return existing;

	const promise = load().catch((error: unknown) => {
		cache.delete(key);
		throw error;
	});
	cache.set(key, promise);
	return promise;
}

function positiveInteger(value: number, label: string, maximum?: number): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	if (maximum !== undefined && value > maximum) throw new Error(`${label} must be at most ${maximum}`);
	return value;
}

function updateGitHubGetHeader(component: Text, number: number, state: GitHubGetRenderState, theme: Theme): void {
	const target = state.kind === "issue" ? `Issue #${number}` : state.kind === "pull-request" ? `PR #${number}` : `#${number}`;
	const marker = state.status === "success" ? theme.fg("success", " ✓") : state.status === "error" ? theme.fg("error", " ✗") : theme.fg("dim", " …");
	component.setText(
		`${theme.fg("toolTitle", theme.bold("github_get"))}${theme.fg("muted", " → ")}${theme.fg("accent", target)}${marker}`,
	);
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find((item) => item.type === "text");
	return content?.text ?? "";
}

export default function (pi: ExtensionAPI): void {
	const repoCache = new Map<string, Promise<RepoResolution>>();
	const issueCache = new Map<string, Promise<GitHubIssueData>>();
	const pullRequestCache = new Map<string, Promise<GitHubPullRequestData>>();
	const commentPageCache = new Map<string, Promise<LoadedCommentPage>>();

	const getRepo = (cwd: string): Promise<RepoResolution> => cached(repoCache, cwd, () => resolveGitHubRepo(pi, cwd));

	const requireRepo = async (cwd: string): Promise<Extract<RepoResolution, { ok: true }>> => {
		const repo = await getRepo(cwd);
		if (!repo.ok) throw new Error(repo.error);
		return repo;
	};

	const getIssue = (cwd: string, number: number, signal?: AbortSignal): Promise<GitHubIssueData> =>
		cached(issueCache, `${cwd}:${number}`, async () => {
			await requireRepo(cwd);
			const json = await runGitHubCommand(
				pi,
				cwd,
				["api", `repos/{owner}/{repo}/issues/${number}`, "-H", "Accept: application/vnd.github+json"],
				`failed to load GitHub issue or pull request #${number}`,
				signal,
			);
			try {
				return parseGitHubIssue(json, number);
			} catch (error) {
				throw new Error(`failed to parse GitHub issue or pull request #${number}: ${errorMessage(error)}`);
			}
		});

	const getPullRequest = (
		cwd: string,
		number: number,
		repo: string,
		signal?: AbortSignal,
	): Promise<GitHubPullRequestData> =>
		cached(pullRequestCache, `${cwd}:${number}`, async () => {
			const json = await runGitHubCommand(
				pi,
				cwd,
				["pr", "view", String(number), "--repo", repo, "--json", PULL_REQUEST_FIELDS],
				`failed to load pull request metadata for #${number}`,
				signal,
			);
			try {
				return parseGitHubPullRequest(json, number);
			} catch (error) {
				throw new Error(`failed to parse pull request metadata for #${number}: ${errorMessage(error)}`);
			}
		});

	const getCommentPage = (
		cwd: string,
		number: number,
		page: number,
		limit: number,
		order: "asc" | "desc",
		signal?: AbortSignal,
	): Promise<LoadedCommentPage> =>
		cached(commentPageCache, `${cwd}:${number}:${page}:${limit}:${order}`, async () => {
			const issue = await getIssue(cwd, number, signal);
			const plan = planCommentPage(issue.commentCount, page, limit, order);
			const loadedPages = await Promise.all(
				plan.apiPages.map(async (apiPage) => {
					const json = await runGitHubCommand(
						pi,
						cwd,
						[
							"api",
							`repos/{owner}/{repo}/issues/${number}/comments?per_page=${limit}&page=${apiPage}`,
							"-H",
							"Accept: application/vnd.github+json",
						],
						`failed to load general comments for #${number}`,
						signal,
					);
					try {
						return { apiPage, comments: parseGitHubComments(json) };
					} catch (error) {
						throw new Error(`failed to parse general comments for #${number}: ${errorMessage(error)}`);
					}
				}),
			);

			const indexedComments = loadedPages.flatMap(({ apiPage, comments }) =>
				comments.map((comment, index) => ({ index: (apiPage - 1) * limit + index, comment })),
			);
			const comments = indexedComments
				.filter(({ index }) => index >= plan.ascStart && index < plan.ascEnd)
				.sort((left, right) => left.index - right.index)
				.map(({ comment }) => comment);
			if (order === "desc") comments.reverse();

			return { issue, comments, plan };
		});

	pi.registerTool({
		name: "github_get",
		label: "GitHub Get",
		description: "Get a bounded overview of one issue or pull request in the current repository. Includes compact PR metadata and a truncated body; excludes comments, reviews, files, and diffs.",
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "Issue or pull request number" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return Effect.runPromise(Effect.tryPromise({
				try: async () => {
					const number = positiveInteger(params.number, "number");
					const repo = await requireRepo(ctx.cwd);
					const issue = await getIssue(ctx.cwd, number, signal);
					const pullRequest = issue.kind === "pull-request"
						? await getPullRequest(ctx.cwd, number, repo.nameWithOwner, signal)
						: undefined;
					const complete = formatGitHubOverview(issue, pullRequest);
					const truncation = truncateHead(complete, {
						maxBytes: DEFAULT_MAX_BYTES,
						maxLines: DEFAULT_MAX_LINES,
					});
					let text = truncation.content;
					let fullOutputPath: string | undefined;
					if (truncation.truncated) {
						const directory = await mkdtemp(join(tmpdir(), "mepie-github-"));
						fullOutputPath = join(directory, `${issue.kind}-${number}.txt`);
						await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, complete, "utf8"));
						text += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
					}
					return {
						content: [{ type: "text" as const, text }],
						details: {
							number,
							kind: issue.kind,
							commentCount: issue.commentCount,
							...(fullOutputPath ? { fullOutputPath } : {}),
						} satisfies GitHubGetDetails,
					};
				},
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}), { signal });
		},
		renderCall(args, theme, context) {
			const state = context.state as GitHubGetRenderState;
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			state.callComponent = component;
			updateGitHubGetHeader(component, args.number, state, theme);
			return component;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as GitHubGetRenderState;
			if (!options.isPartial) {
				const details = result.details as GitHubGetDetails | undefined;
				state.kind = details?.kind;
				state.status = context.isError ? "error" : "success";
				if (state.callComponent) updateGitHubGetHeader(state.callComponent, context.args.number, state, theme);
			}

			if (!options.expanded) return new Container();
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(toolResultText(result));
			return component;
		},
	});

	pi.registerTool({
		name: "github_comments",
		label: "GitHub Comments",
		description: `Get one bounded page of general issue or pull-request conversation from the current repository. Defaults to ${DEFAULT_COMMENT_LIMIT} comments, allows at most ${MAX_COMMENT_LIMIT}, and excludes inline review threads, reviews, files, and diffs.`,
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1, description: "Issue or pull request number" }),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page number (default: 1)" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMMENT_LIMIT, description: `Comments per page (default: ${DEFAULT_COMMENT_LIMIT}, maximum: ${MAX_COMMENT_LIMIT})` })),
			order: Type.Optional(StringEnum(["asc", "desc"] as const, { description: "Oldest-first (asc, default) or newest-first (desc)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return Effect.runPromise(Effect.tryPromise({
				try: async () => {
					const number = positiveInteger(params.number, "number");
					const page = positiveInteger(params.page ?? 1, "page");
					const limit = positiveInteger(params.limit ?? DEFAULT_COMMENT_LIMIT, "limit", MAX_COMMENT_LIMIT);
					const order = params.order ?? "asc";
					const loaded = await getCommentPage(ctx.cwd, number, page, limit, order, signal);
					return {
						content: [{ type: "text" as const, text: formatGitHubCommentsPage({ ...loaded, page, limit, order }) }],
						details: {
							number,
							kind: loaded.issue.kind,
							page,
							limit,
							order,
							totalComments: loaded.issue.commentCount,
							pageItems: loaded.comments.length,
						},
					};
				},
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}), { signal });
		},
	});

	pi.on("session_start", (_event, ctx) => {
		repoCache.clear();
		issueCache.clear();
		pullRequestCache.clear();
		commentPageCache.clear();

		if (!ctx.hasUI) return;

		let referencesPromise: Promise<GitHubReference[] | undefined> | undefined;
		let loadErrorsShown = false;

		const getReferences = (): Promise<GitHubReference[] | undefined> => {
			referencesPromise ??= (async () => {
				const repo = await getRepo(ctx.cwd);
				if (!repo.ok) {
					ctx.ui.notify(`github-references: ${repo.error}`, "warning");
					return undefined;
				}

				const { references, errors } = await loadGitHubReferences(pi, ctx.cwd);
				if (errors.length > 0 && !loadErrorsShown) {
					loadErrorsShown = true;
					ctx.ui.notify(`github-references: ${errors.join("; ")}`, "warning");
				}
				return references;
			})();
			return referencesPromise;
		};

		ctx.ui.addAutocompleteProvider((current) => createGitHubAutocompleteProvider(current, getReferences));
		void getReferences();
	});
}
