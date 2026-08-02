import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AutocompleteProviderFactory, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import githubReferencesExtension from "../github-references/index.ts";
import {
	extractGitHubReferenceToken,
	filterGitHubReferences,
	parseGitHubReferences,
	sortGitHubReferences,
	type GitHubReference,
} from "../github-references/references.ts";
import {
	COMMENT_MAX_BYTES,
	COMMENTS_OUTPUT_MAX_BYTES,
	formatGitHubComment,
	formatGitHubCommentsPage,
	formatGitHubOverview,
	parseGitHubComments,
	parseGitHubIssue,
	parseGitHubPullRequest,
	planCommentPage,
} from "../github-references/tools.ts";

const references: GitHubReference[] = [
	{
		kind: "issue",
		number: 42,
		title: "Login fails after token refresh",
		updatedAt: "2026-07-08T10:00:00Z",
		isDraft: false,
		blockers: [
			{ number: 40 },
			{ number: 41, repository: "other/project" },
		],
	},
	{
		kind: "pull-request",
		number: 51,
		title: "Add OAuth retry handling",
		updatedAt: "2026-07-09T10:00:00Z",
		isDraft: false,
		blockers: [],
	},
	{
		kind: "pull-request",
		number: 57,
		title: "Refactor authentication",
		updatedAt: "2026-07-10T10:00:00Z",
		isDraft: true,
		blockers: [],
	},
];

test("github-references extracts a hash token at a token boundary", () => {
	assert.equal(extractGitHubReferenceToken("Fix #"), "");
	assert.equal(extractGitHubReferenceToken("Fix #auth"), "auth");
	assert.equal(extractGitHubReferenceToken("#51"), "51");
	assert.equal(extractGitHubReferenceToken("word#51"), undefined);
	assert.equal(extractGitHubReferenceToken("Fix #51 later"), undefined);
});

test("github-references parses issue and pull request lists", () => {
	const issues = parseGitHubReferences(
		JSON.stringify([
			{
				number: 42,
				title: "Login fails",
				state: "OPEN",
				updatedAt: "2026-07-08T10:00:00Z",
				url: "https://github.com/example/repo/issues/42",
				blockedBy: {
					nodes: [
						{
							number: 40,
							title: "Open same-repo blocker",
							state: "OPEN",
							url: "https://github.com/example/repo/issues/40",
						},
						{
							number: 41,
							title: "Open cross-repo blocker",
							state: "OPEN",
							url: "https://github.com/other/project/issues/41",
						},
						{
							number: 39,
							title: "Closed blocker",
							state: "CLOSED",
							url: "https://github.com/example/repo/issues/39",
						},
					],
					totalCount: 3,
				},
			},
		]),
		"issue",
	);
	const pullRequests = parseGitHubReferences(
		JSON.stringify([
			{
				number: 57,
				title: "Refactor authentication",
				state: "OPEN",
				updatedAt: "2026-07-10T10:00:00Z",
				url: "https://github.com/example/repo/pull/57",
				isDraft: true,
			},
		]),
		"pull-request",
	);

	assert.equal(issues[0]?.kind, "issue");
	assert.equal(issues[0]?.isDraft, false);
	assert.deepEqual(issues[0]?.blockers, [
		{ number: 40 },
		{ number: 41, repository: "other/project" },
	]);
	assert.equal(pullRequests[0]?.kind, "pull-request");
	assert.equal(pullRequests[0]?.isDraft, true);
});

test("github-references rejects malformed list output", () => {
	assert.throws(() => parseGitHubReferences("{}", "issue"), /expected a JSON array/);
	assert.throws(() => parseGitHubReferences('[{"number":"42"}]', "issue"), /invalid item at index 0/);
});

test("github-references sorts merged results by most recently updated", () => {
	assert.deepEqual(
		sortGitHubReferences(references).map((reference) => reference.number),
		[57, 51, 42],
	);
});

test("github-references prioritizes numeric prefixes", () => {
	const items = filterGitHubReferences(references, "5");
	assert.deepEqual(
		items.map((item) => item.value),
		["#51", "#57"],
	);
});

test("github-references fuzzy-searches titles and labels item kinds", () => {
	const issueItems = filterGitHubReferences(references, "token refresh");
	assert.equal(issueItems[0]?.value, "#42");
	assert.equal(
		issueItems[0]?.description,
		"[issue] [block #40 other/project#41] Login fails after token refresh",
	);
	const unblockedIssueItems = filterGitHubReferences([{ ...references[0]!, blockers: [] }], "token refresh");
	assert.equal(unblockedIssueItems[0]?.description, "[issue] Login fails after token refresh");

	const pullRequestItems = filterGitHubReferences(references, "oauth");
	assert.equal(pullRequestItems[0]?.value, "#51");
	assert.equal(pullRequestItems[0]?.description, "[PR] Add OAuth retry handling");

	const draftItems = filterGitHubReferences(references, "draft");
	assert.equal(draftItems[0]?.description, "[draft PR] Refactor authentication");
});

test("github-references extension loads and caches both reference kinds", async () => {
	let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	let autocompleteFactory: AutocompleteProviderFactory | undefined;
	const commands: string[][] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool() {},
		async exec(command: string, args: string[]) {
			assert.equal(command, "gh");
			commands.push(args);
			if (args[0] === "repo") {
				return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
			}
			if (args[0] === "issue") {
				return {
					code: 0,
					stdout: JSON.stringify([{
						number: 42,
						title: "Login fails after token refresh",
						updatedAt: "2026-07-08T10:00:00Z",
						url: "https://github.com/example/repo/issues/42",
						blockedBy: {
							nodes: [
								{ number: 40, state: "OPEN", url: "https://github.com/example/repo/issues/40" },
								{ number: 41, state: "OPEN", url: "https://github.com/other/project/issues/41" },
							],
							totalCount: 2,
						},
					}]),
					stderr: "",
				};
			}
			return { code: 0, stdout: JSON.stringify([references[1], references[2]]), stderr: "" };
		},
	} as unknown as ExtensionAPI;

	githubReferencesExtension(pi);
	assert.ok(sessionStart);
	await sessionStart({}, {
		hasUI: true,
		cwd: "/repo",
		ui: {
			notify() {},
			addAutocompleteProvider(factory: AutocompleteProviderFactory) {
				autocompleteFactory = factory;
			},
		},
	});

	assert.ok(autocompleteFactory);
	const current: AutocompleteProvider = {
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const provider = autocompleteFactory(current);
	const suggestions = await provider.getSuggestions(["Fix #oauth"], 0, 10, {
		signal: new AbortController().signal,
	});
	assert.equal(suggestions?.items[0]?.value, "#51");

	await provider.getSuggestions(["Review #"], 0, 8, { signal: new AbortController().signal });
	assert.equal(commands.filter((args) => args[0] === "issue").length, 1);
	assert.ok(commands.find((args) => args[0] === "issue")?.includes("number,title,updatedAt,url,blockedBy"));
	assert.equal(commands.filter((args) => args[0] === "pr").length, 1);
	assert.equal(commands.filter((args) => args[0] === "api").length, 0, "# autocomplete must not fetch details");
});

test("github-references does not block later session-start editor setup", async () => {
	let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
	let autocompleteFactory: AutocompleteProviderFactory | undefined;
	let resolveRepo: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined;
	const repoResult = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		resolveRepo = resolve;
	});

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "session_start") sessionStart = handler;
		},
		registerTool() {},
		exec() {
			return repoResult;
		},
	} as unknown as ExtensionAPI;

	githubReferencesExtension(pi);
	assert.ok(sessionStart);
	const handlerResult = sessionStart({}, {
		hasUI: true,
		cwd: "/repo",
		ui: {
			notify() {},
			addAutocompleteProvider(factory: AutocompleteProviderFactory) {
				autocompleteFactory = factory;
			},
		},
	});

	try {
		assert.equal(handlerResult, undefined);
		assert.ok(autocompleteFactory, "autocomplete should register before gh resolves");
	} finally {
		resolveRepo?.({ code: 1, stdout: "", stderr: "no remote" });
		if (handlerResult instanceof Promise) await handlerResult;
	}
});

type GitHubToolResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type TestRenderable = { render(width: number): string[] };
type TestTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type RegisteredGitHubTool = {
	name: string;
	execute(
		toolCallId: string,
		params: { number: number; page?: number; limit?: number; order?: "asc" | "desc" },
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<GitHubToolResult>;
	renderCall?: (args: { number: number }, theme: TestTheme, context: unknown) => TestRenderable;
	renderResult?: (
		result: GitHubToolResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: TestTheme,
		context: unknown,
	) => TestRenderable;
};

type GhResult = { code: number; stdout: string; stderr: string };

function issueFixture(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number,
		title: "Fix authentication refresh",
		state: "open",
		state_reason: null,
		user: { login: "octocat" },
		body: "Issue body",
		html_url: `https://github.com/example/repo/issues/${number}`,
		labels: [{ name: "bug" }],
		assignees: [{ login: "hubot" }],
		milestone: { title: "v1" },
		comments: 0,
		created_at: "2026-07-01T10:00:00Z",
		updated_at: "2026-07-10T10:00:00Z",
		closed_at: null,
		...overrides,
	};
}

function pullRequestFixture(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number,
		baseRefName: "main",
		headRefName: "fix/auth-refresh",
		isDraft: false,
		additions: 20,
		deletions: 5,
		changedFiles: 3,
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: "REVIEW_REQUIRED",
		reviewRequests: [{ login: "reviewer" }, { slug: "platform" }],
		...overrides,
	};
}

function commentFixture(id: number, body = `Comment ${id}`): Record<string, unknown> {
	return {
		id,
		user: { login: `user-${id}` },
		author_association: "CONTRIBUTOR",
		body,
		html_url: `https://github.com/example/repo/issues/7#issuecomment-${id}`,
		created_at: `2026-07-${String(id).padStart(2, "0")}T10:00:00Z`,
		updated_at: `2026-07-${String(id).padStart(2, "0")}T11:00:00Z`,
	};
}

function registerToolHarness(run: (args: string[]) => Promise<GhResult>): {
	tools: Map<string, RegisteredGitHubTool>;
	calls: string[][];
} {
	const tools = new Map<string, RegisteredGitHubTool>();
	const calls: string[][] = [];
	const pi = {
		on() {},
		registerTool(tool: RegisteredGitHubTool) {
			tools.set(tool.name, tool);
		},
		async exec(command: string, args: string[]) {
			assert.equal(command, "gh");
			calls.push(args);
			return run(args);
		},
	} as unknown as ExtensionAPI;
	githubReferencesExtension(pi);
	return { tools, calls };
}

async function executeTool(
	tool: RegisteredGitHubTool | undefined,
	params: { number: number; page?: number; limit?: number; order?: "asc" | "desc" },
): Promise<GitHubToolResult> {
	assert.ok(tool);
	return tool.execute("call-1", params, new AbortController().signal, undefined, { cwd: "/repo" });
}

test("github tools parse issue and pull-request responses", () => {
	const issue = parseGitHubIssue(JSON.stringify(issueFixture(7)), 7);
	const pullRequestIssue = parseGitHubIssue(
		JSON.stringify(issueFixture(8, { pull_request: { url: "https://api.github.com/repos/example/repo/pulls/8" } })),
		8,
	);
	const pullRequest = parseGitHubPullRequest(JSON.stringify(pullRequestFixture(8)), 8);

	assert.equal(issue.kind, "issue");
	assert.equal(pullRequestIssue.kind, "pull-request");
	assert.equal(pullRequest.headRefName, "fix/auth-refresh");
	assert.deepEqual(pullRequest.reviewRequests, ["reviewer", "platform"]);
});

test("github tools reject malformed overview and comment responses", () => {
	assert.throws(() => parseGitHubIssue("{}", 7), /issue.number/);
	assert.throws(
		() => parseGitHubPullRequest(JSON.stringify(pullRequestFixture(7, { reviewRequests: [{}] })), 7),
		/reviewRequests\[0\]/,
	);
	assert.throws(() => parseGitHubComments("{}"), /must be an array/);
	assert.throws(() => parseGitHubComments('[{"id":"bad"}]'), /comments\[0\].id/);
});

test("github_get formatting returns the complete body and reports omitted secondary content", () => {
	const body = `begin\n${"🙂".repeat(10_000)}\nend`;
	const issue = parseGitHubIssue(JSON.stringify(issueFixture(7, { body, comments: 12 })), 7);
	const output = formatGitHubOverview(issue);

	assert.ok(output.endsWith(body));
	assert.doesNotMatch(output, /Body truncated:|Overview output truncated:/);
	assert.match(output, /General comments: 12 \(omitted; use github_comments\)/);
	assert.match(output, /Omitted content: general comments were not fetched/);
});

test("github_get formatting includes compact PR metadata but no review bodies or diff", () => {
	const issue = parseGitHubIssue(
		JSON.stringify(issueFixture(8, { pull_request: { url: "https://api.github.com/repos/example/repo/pulls/8" } })),
		8,
	);
	const output = formatGitHubOverview(issue, parseGitHubPullRequest(JSON.stringify(pullRequestFixture(8)), 8));

	assert.match(output, /Branches: fix\/auth-refresh -> main/);
	assert.match(output, /Changes: \+20 -5 across 3 files/);
	assert.match(output, /Review decision: REVIEW_REQUIRED/);
	assert.match(output, /review bodies, inline review threads, files, and diff were not fetched/);
});

test("github_comments plans ascending and descending pages without fetching all comments", () => {
	assert.deepEqual(planCommentPage(13, 3, 5, "asc"), {
		ascStart: 10,
		ascEnd: 13,
		apiPages: [3],
		omittedBefore: 10,
		omittedAfter: 0,
		hasPrevious: true,
		hasNext: false,
	});
	assert.deepEqual(planCommentPage(13, 1, 5, "desc"), {
		ascStart: 8,
		ascEnd: 13,
		apiPages: [2, 3],
		omittedBefore: 0,
		omittedAfter: 8,
		hasPrevious: false,
		hasNext: true,
	});
});

test("github_comments defaults to the first five oldest comments", async () => {
	const { tools, calls } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		return { code: 0, stdout: JSON.stringify(issueFixture(7)), stderr: "" };
	});

	const result = await executeTool(tools.get("github_comments"), { number: 7 });
	assert.match(result.content[0]?.text ?? "", /Pagination: page=1 limit=5 order=asc total=0/);
	assert.equal(calls.filter((args) => args[1]?.includes("/comments?")).length, 0);
});

test("github_comments enforces per-comment and total byte limits", () => {
	const parsed = parseGitHubComments(JSON.stringify([commentFixture(1, "x".repeat(10_000))]))[0];
	assert.ok(parsed);
	const boundedComment = formatGitHubComment(parsed);
	assert.equal(boundedComment.truncated, true);
	assert.ok(Buffer.byteLength(boundedComment.text, "utf8") <= COMMENT_MAX_BYTES);
	assert.match(boundedComment.text, /Comment 1 truncated:/);

	const issue = parseGitHubIssue(JSON.stringify(issueFixture(7, { comments: 20 })), 7);
	const comments = parseGitHubComments(
		JSON.stringify(Array.from({ length: 20 }, (_, index) => commentFixture(index + 1, "y".repeat(10_000)))),
	);
	const output = formatGitHubCommentsPage({
		issue,
		comments,
		page: 1,
		limit: 20,
		order: "asc",
		plan: planCommentPage(20, 1, 20, "asc"),
	});
	assert.ok(Buffer.byteLength(output, "utf8") <= COMMENTS_OUTPUT_MAX_BYTES);
	assert.match(output, /omitted_by_output_limit=[1-9]/);
	assert.match(output, /truncated_on_page=20/);
	assert.match(output, /inline review threads, review comments\/reviews, files, and diffs were not fetched/);
});

test("github tools register synchronously and github_get fetches lazily with session caching", async () => {
	const { tools, calls } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		if (args[0] === "api") return { code: 0, stdout: JSON.stringify(issueFixture(7)), stderr: "" };
		throw new Error(`unexpected gh command: ${args.join(" ")}`);
	});

	assert.deepEqual([...tools.keys()], ["github_get", "github_comments"]);
	assert.equal(calls.length, 0, "tool registration must not fetch GitHub data");

	const first = await executeTool(tools.get("github_get"), { number: 7 });
	const second = await executeTool(tools.get("github_get"), { number: 7 });
	assert.match(first.content[0]?.text ?? "", /GitHub issue #7/);
	assert.equal(second.content[0]?.text, first.content[0]?.text);
	assert.equal(calls.filter((args) => args[0] === "repo").length, 1);
	assert.equal(calls.filter((args) => args[0] === "api").length, 1);
	assert.equal(calls.filter((args) => args[0] === "pr").length, 0);
});

test("github_get truncates oversized output and saves the complete response", async () => {
	const body = `begin\n${"x".repeat(100_000)}\nend`;
	const { tools } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		return { code: 0, stdout: JSON.stringify(issueFixture(7, { body })), stderr: "" };
	});

	const result = await executeTool(tools.get("github_get"), { number: 7 });
	assert.match(result.content[0]?.text ?? "", /Output truncated/);
	const details = result.details as { fullOutputPath?: string };
	assert.ok(details.fullOutputPath);
	assert.match(readFileSync(details.fullOutputPath, "utf8"), /begin/);
	assert.ok(readFileSync(details.fullOutputPath, "utf8").endsWith(body));
});

test("github_get renderer keeps the body collapsed and exposes it when expanded", async () => {
	const { tools } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		return { code: 0, stdout: JSON.stringify(issueFixture(7, { body: "complete body" })), stderr: "" };
	});
	const tool = tools.get("github_get");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const theme: TestTheme = {
		fg(_color, text) {
			return text;
		},
		bold(text) {
			return text;
		},
	};
	const state: Record<string, unknown> = {};
	const call = tool.renderCall({ number: 7 }, theme, { state, lastComponent: undefined });
	assert.equal(call.render(120).map((line) => line.trimEnd()).join("\n"), "github_get → #7 …");

	const result = await executeTool(tool, { number: 7 });
	const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {
		state,
		lastComponent: undefined,
		isError: false,
		args: { number: 7 },
	});
	assert.equal(call.render(120).map((line) => line.trimEnd()).join("\n"), "github_get → Issue #7 ✓");
	assert.equal(collapsed.render(120).map((line) => line.trimEnd()).join("\n"), "");

	const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {
		state,
		lastComponent: collapsed,
		isError: false,
		args: { number: 7 },
	});
	assert.match(expanded.render(120).join("\n"), /complete body/);
});

test("github_get detects PRs and fetches only compact PR fields", async () => {
	const { tools, calls } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		if (args[0] === "api") {
			return {
				code: 0,
				stdout: JSON.stringify(issueFixture(8, { pull_request: { url: "https://api.github.com/repos/example/repo/pulls/8" } })),
				stderr: "",
			};
		}
		if (args[0] === "pr") return { code: 0, stdout: JSON.stringify(pullRequestFixture(8)), stderr: "" };
		throw new Error(`unexpected gh command: ${args.join(" ")}`);
	});

	const result = await executeTool(tools.get("github_get"), { number: 8 });
	assert.match(result.content[0]?.text ?? "", /GitHub pull request #8/);
	const prCall = calls.find((args) => args[0] === "pr");
	assert.ok(prCall);
	const requestedFields = (prCall[prCall.indexOf("--json") + 1] ?? "").split(",");
	for (const excluded of ["comments", "commits", "files", "latestReviews", "reviews"]) {
		assert.ok(!requestedFields.includes(excluded), `${excluded} must not be fetched`);
	}
});

test("github_comments paginates newest-first, reports counts, and caches an exact page", async () => {
	const { tools, calls } = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		if (args[0] === "api" && !args[1]?.includes("/comments?")) {
			return { code: 0, stdout: JSON.stringify(issueFixture(7, { comments: 13 })), stderr: "" };
		}
		if (args[0] === "api") {
			const page = Number(args[1]?.match(/[?&]page=(\d+)/)?.[1]);
			const ids = page === 2 ? [6, 7, 8, 9, 10] : page === 3 ? [11, 12, 13] : [];
			return { code: 0, stdout: JSON.stringify(ids.map((id) => commentFixture(id))), stderr: "" };
		}
		throw new Error(`unexpected gh command: ${args.join(" ")}`);
	});

	const params = { number: 7, page: 1, limit: 5, order: "desc" as const };
	const first = await executeTool(tools.get("github_comments"), params);
	await executeTool(tools.get("github_comments"), params);
	const output = first.content[0]?.text ?? "";
	assert.match(output, /page_items=5 shown=5 omitted_before=0 omitted_after=8/);
	assert.ok(output.indexOf("Comment 13") < output.indexOf("Comment 12"));
	assert.ok(output.indexOf("Comment 12") < output.indexOf("Comment 9"));
	assert.equal(calls.filter((args) => args[1]?.includes("/comments?")).length, 2);
	assert.equal(calls.filter((args) => args[0] === "repo").length, 1);
});

test("github tools surface command failures and malformed called responses", async () => {
	const failed = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		return { code: 1, stdout: "", stderr: "permission denied" };
	});
	await assert.rejects(() => executeTool(failed.tools.get("github_get"), { number: 7 }), /permission denied/);

	const malformedOverview = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		return { code: 0, stdout: "{}", stderr: "" };
	});
	await assert.rejects(
		() => executeTool(malformedOverview.tools.get("github_get"), { number: 7 }),
		/failed to parse GitHub issue or pull request #7/,
	);

	const malformedComments = registerToolHarness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"example/repo"}', stderr: "" };
		if (args[0] === "api" && !args[1]?.includes("/comments?")) {
			return { code: 0, stdout: JSON.stringify(issueFixture(7, { comments: 1 })), stderr: "" };
		}
		return { code: 0, stdout: "{}", stderr: "" };
	});
	await assert.rejects(
		() => executeTool(malformedComments.tools.get("github_comments"), { number: 7 }),
		/failed to parse general comments for #7/,
	);
	await assert.rejects(
		() => executeTool(malformedComments.tools.get("github_comments"), { number: 7, limit: 21 }),
		/limit must be at most 20/,
	);
});
