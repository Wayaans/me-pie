import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import github from "../pi-github/index.ts";
import { createGitHubAutocomplete } from "../pi-github/autocomplete.ts";
import { createGitHubClient } from "../pi-github/client.ts";
import { extractGitHubReferenceToken, filterGitHubReferences, parseGitHubReferences, sortGitHubReferences, type GitHubReference } from "../pi-github/references.ts";
import { COMMENT_MAX_BYTES, COMMENTS_OUTPUT_MAX_BYTES, formatGitHubComment, formatGitHubCommentsPage, formatGitHubOverview, parseGitHubComments, parseGitHubIssue, parseGitHubPullRequest, patchMarkdown, planCommentPage } from "../pi-github/tools.ts";
import { normalizeIssueIndex } from "../pi-github/lists.ts";

test("pi-github preserves hash autocomplete parsing and filtering", () => {
	assert.equal(extractGitHubReferenceToken("Fix #42"), "42");
	assert.equal(extractGitHubReferenceToken("word#42"), undefined);
	const refs: GitHubReference[] = [{ kind: "issue", number: 42, title: "Login fails", updatedAt: "2026-01-01", isDraft: false, blockers: [] }];
	assert.equal(filterGitHubReferences(refs, "4")[0]?.value, "#42");
});

test("patchMarkdown changes only a named H2 section", () => {
	const body = "## Destination\nold\n\n## Notes\nkeep";
	assert.equal(patchMarkdown(body, "Destination", "replace", "new"), "## Destination\nnew\n\n## Notes\nkeep");
	assert.equal(patchMarkdown(body, "Destination", "append", "more"), "## Destination\nold\n\nmore\n\n## Notes\nkeep");
	assert.throws(() => patchMarkdown(body, "Missing", "replace", "new"), /section not found/);
});

type GhResult = { code: number; stdout: string; stderr: string };
type Tool = {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, update: undefined, ctx: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;
};
function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { number, title: "Issue", state: "open", state_reason: null, user: { login: "octocat" }, body: "## Notes\nbody", html_url: `https://github.com/acme/repo/issues/${number}`, labels: [], assignees: [], milestone: null, comments: 0, created_at: "2026-01-01", updated_at: "2026-01-02", closed_at: null, ...overrides };
}
function harness(run: (args: string[]) => Promise<GhResult>): { tool: Tool; calls: string[][] } {
	let registered: Tool | undefined;
	const calls: string[][] = [];
	const pi = {
		on() {},
		registerTool(value: Tool) { registered = value; },
		async exec(command: string, args: string[]) { assert.equal(command, "gh"); calls.push(args); return run(args); },
	} as unknown as ExtensionAPI;
	github(pi);
	assert.ok(registered);
	return { tool: registered, calls };
}
async function execute(tool: Tool, params: Record<string, unknown>, ctx: Record<string, unknown> = { cwd: "/repo", mode: "print", hasUI: false, ui: {} }): Promise<{ content: Array<{ text: string }>; details?: unknown }> {
	return tool.execute("call", params, new AbortController().signal, undefined, ctx);
}

test("registers exactly one github tool and dispatches issue.get", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"acme/repo"}', stderr: "" };
		return { code: 0, stdout: JSON.stringify(issue(42)), stderr: "" };
	});
	const result = await execute(tool, { command: "issue", action: "get", number: 42 });
	assert.match(result.content[0]?.text ?? "", /GitHub issue #42/);
	assert.equal(calls.filter((args) => args[0] === "repo").length, 1);
	assert.equal(calls.filter((args) => args[0] === "api").length, 1);
});

test("passes explicit repository and signal/timeout to gh", async () => {
	let options: Record<string, unknown> | undefined;
	let registered: Tool | undefined;
	const pi = {
		on() {}, registerTool(value: Tool) { registered = value; },
		async exec(_command: string, args: string[], passed: Record<string, unknown>) { options = passed; return { code: 0, stdout: JSON.stringify(issue(7)), stderr: "" }; },
	} as unknown as ExtensionAPI;
	github(pi); assert.ok(registered);
	await execute(registered, { command: "issue", action: "get", number: 7, repo: "acme/repo" });
	assert.equal(options?.cwd, "/repo"); assert.equal(options?.timeout, 10_000); assert.ok(options?.signal instanceof AbortSignal);
});

test("rejects no-op issue edits before invoking gh", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: "", stderr: "" }));
	await assert.rejects(() => execute(tool, { command: "issue", action: "edit", number: 1, repo: "acme/repo" }), /no-op/);
	assert.equal(calls.length, 0);
});

test("requires TUI confirmation for destructive actions", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: "", stderr: "" }));
	await assert.rejects(() => execute(tool, { command: "issue", action: "delete", number: 1, repo: "acme/repo" }), /TUI confirmation/);
	assert.equal(calls.length, 0);
});

test("uses native relation endpoints and resolves database IDs", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[0] === "api" && args[1]?.endsWith("issues/9")) return { code: 0, stdout: JSON.stringify({ id: 909, number: 9, html_url: "url" }), stderr: "" };
		return { code: 0, stdout: "{}", stderr: "" };
	});
	await execute(tool, { command: "relation", action: "add", relation: "blocked-by", number: 8, relatedIssue: 9, repo: "acme/repo" });
	assert.match(calls[0]?.[1] ?? "", /issues\/9/);
	assert.match(calls[1]?.[1] ?? "", /dependencies\/blocked_by/);
	assert.ok(calls[1]?.includes("-F") && calls[1]?.includes("issue_id=909"));
});

test("rejects repository values that could alter an API path", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: "{}", stderr: "" }));
	await assert.rejects(
		() => execute(tool, { command: "issue", action: "get", number: 1, repo: "owner/repo?per_page=100" }),
		/expected owner\/name/,
	);
	assert.equal(calls.length, 0);
});

test("rejects malformed external JSON", async () => {
	const { tool } = harness(async () => ({ code: 0, stdout: "not json", stderr: "" }));
	await assert.rejects(() => execute(tool, { command: "repo", action: "auth-status" }), /malformed JSON/);
});

test("parseGitHubIssue validates issue identity", () => {
	assert.throws(() => parseGitHubIssue("{}", 1), /issue.number/);
});

test("reference parsing rejects malformed data and keeps only open blockers", () => {
	const parsed = parseGitHubReferences(JSON.stringify([{ number: 4, title: "Open", updatedAt: "2026-01-02", url: "https://github.com/acme/repo/issues/4", blockedBy: { nodes: [{ number: 2, title: "Closed", state: "closed", url: "https://github.com/acme/repo/issues/2" }, { number: 3, title: "Open", state: "OPEN", url: "https://github.com/acme/repo/issues/3" }] } }]), "issue");
	assert.deepEqual(parsed[0]?.blockers, [{ number: 3 }]);
	assert.throws(() => parseGitHubReferences("{}", "issue"), /JSON array/);
});

test("references sort by update time and fuzzy-filter titles and kinds", () => {
	const refs: GitHubReference[] = [
		{ kind: "issue", number: 2, title: "Login refresh", updatedAt: "2026-01-01", isDraft: false, blockers: [{ number: 1 }] },
		{ kind: "pull-request", number: 4, title: "OAuth retry", updatedAt: "2026-01-03", isDraft: true, blockers: [] },
	];
	assert.deepEqual(sortGitHubReferences(refs).map((item) => item.number), [4, 2]);
	assert.match(filterGitHubReferences(refs, "oauth")[0]?.description ?? "", /draft PR/);
	assert.match(filterGitHubReferences(refs, "refresh")[0]?.description ?? "", /block #1/);
});

test("normalized low-resolution lists support camel and snake case", () => {
	const items = normalizeIssueIndex([{ number: 7, title: "Child", state: "OPEN", url: "https://example/issues/7", updatedAt: "2026-01-02", labels: [{ name: "task" }], assignees: [{ login: "arya" }], blockedBy: [{ number: 3, title: "Closed", state: "closed", html_url: "url" }, { number: 4, title: "Blocker", state: "OPEN", html_url: "url4" }] }, { number: 8, title: "Snake", state: "closed", html_url: "url8", updated_at: "2026-01-01", labels: [], assignees: [] }], "issues");
	assert.deepEqual(items[0], { number: 7, title: "Child", state: "open", url: "https://example/issues/7", updatedAt: "2026-01-02", labels: ["task"], assignees: ["arya"], blockedBy: [{ number: 4, title: "Blocker", state: "open", url: "url4" }] });
	assert.equal(items[1]?.url, "url8");
});

test("comment pagination and byte limits remain bounded", () => {
	assert.deepEqual(planCommentPage(13, 1, 5, "desc").apiPages, [2, 3]);
	assert.deepEqual(planCommentPage(13, 3, 5, "asc").apiPages, [3]);
	const comment = parseGitHubComments(JSON.stringify([{ id: 1, user: { login: "u" }, author_association: "CONTRIBUTOR", body: "x".repeat(20_000), html_url: "url", created_at: "now", updated_at: "now" }]))[0]!;
	const bounded = formatGitHubComment(comment);
	assert.equal(bounded.truncated, true);
	assert.ok(Buffer.byteLength(bounded.text) <= COMMENT_MAX_BYTES);
	const parsedIssue = parseGitHubIssue(JSON.stringify(issue(7, { comments: 20 })), 7);
	const comments = parseGitHubComments(JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ id: index + 1, user: { login: "u" }, author_association: "CONTRIBUTOR", body: "y".repeat(10_000), html_url: "url", created_at: "now", updated_at: "now" }))));
	const output = formatGitHubCommentsPage({ issue: parsedIssue, comments, page: 1, limit: 20, order: "asc", plan: planCommentPage(20, 1, 20, "asc") });
	assert.ok(Buffer.byteLength(output) <= COMMENTS_OUTPUT_MAX_BYTES);
});

test("overview parsers retain PR metadata and complete body formatting", () => {
	const parsedIssue = parseGitHubIssue(JSON.stringify(issue(8, { pull_request: { url: "api" }, body: "body" })), 8);
	const pr = parseGitHubPullRequest(JSON.stringify({ number: 8, baseRefName: "main", headRefName: "feature", isDraft: true, additions: 1, deletions: 2, changedFiles: 1, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ login: "reviewer" }] }), 8);
	const formatted = formatGitHubOverview(parsedIssue, pr);
	assert.match(formatted, /Branches: feature -> main/);
	assert.match(formatted, /body/);
	assert.equal(pr.isDraft, true);
});

test("parent issue lists preserve child order, enrich blockers, and filter unassigned frontier", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[1]?.includes("sub_issues?")) return { code: 0, stdout: JSON.stringify([
			{ number: 10, title: "First", state: "OPEN", html_url: "u10", updated_at: "2026-01-01", labels: [], assignees: [] },
			{ number: 11, title: "Second", state: "OPEN", html_url: "u11", updated_at: "2026-01-02", labels: [], assignees: [{ login: "dev" }] },
		]), stderr: "" };
		if (args[1]?.includes("issues/10/dependencies/blocked_by")) return { code: 0, stdout: JSON.stringify([{ number: 3, title: "Closed", state: "CLOSED", html_url: "u3" }]), stderr: "" };
		if (args[1]?.includes("issues/11/dependencies/blocked_by")) return { code: 0, stdout: JSON.stringify([{ number: 4, title: "Open", state: "open", html_url: "u4" }]), stderr: "" };
		return { code: 0, stdout: "[]", stderr: "" };
	});
	const result = await execute(tool, { command: "issue", action: "list", repo: "acme/repo", parent: 1, unassigned: true, unblocked: true });
	const parsed = JSON.parse(result.content[0]?.text ?? "{}");
	assert.deepEqual(parsed.issues.map((item: { number: number }) => item.number), [10]);
	assert.deepEqual(parsed.issues[0].blockedBy, []);
	assert.equal(calls.filter((args) => args[1]?.includes("dependencies/blocked_by")).length, 1);
});

test("parent issue list pagination fills a filtered frontier page", async () => {
	const assigned = Array.from({ length: 100 }, (_, index) => ({
		number: index + 1,
		title: `Assigned ${index + 1}`,
		state: "OPEN",
		html_url: `u${index + 1}`,
		updated_at: "2026-01-01",
		labels: [],
		assignees: [{ login: "busy" }],
	}));
	const { tool, calls } = harness(async (args) => {
		if (args[1]?.includes("sub_issues?per_page=100&page=1")) {
			return { code: 0, stdout: JSON.stringify(assigned), stderr: "" };
		}
		if (args[1]?.includes("sub_issues?per_page=100&page=2")) {
			return { code: 0, stdout: JSON.stringify([{
				number: 101,
				title: "Available",
				state: "OPEN",
				html_url: "u101",
				updated_at: "2026-01-02",
				labels: [],
				assignees: [],
			}]), stderr: "" };
		}
		return { code: 0, stdout: "[]", stderr: "" };
	});
	const result = await execute(tool, {
		command: "issue",
		action: "list",
		repo: "acme/repo",
		parent: 1,
		unassigned: true,
		unblocked: true,
		limit: 1,
	});
	assert.deepEqual(
		JSON.parse(result.content[0]?.text ?? "{}").issues.map((item: { number: number }) => item.number),
		[101],
	);
	assert.ok(calls.some((args) => args[1]?.includes("sub_issues?per_page=100&page=2")));
});

test("parent issue lists default to open children", async () => {
	const { tool } = harness(async (args) => {
		if (args[1]?.includes("sub_issues?")) {
			return {
				code: 0,
				stdout: JSON.stringify([
					{ number: 20, title: "Closed", state: "CLOSED", html_url: "u20", updated_at: "2026-01-01", labels: [], assignees: [] },
					{ number: 21, title: "Open", state: "OPEN", html_url: "u21", updated_at: "2026-01-02", labels: [], assignees: [] },
				]),
				stderr: "",
			};
		}
		return { code: 0, stdout: "[]", stderr: "" };
	});
	const result = await execute(tool, {
		command: "issue",
		action: "list",
		repo: "acme/repo",
		parent: 1,
	});
	assert.deepEqual(
		JSON.parse(result.content[0]?.text ?? "{}").issues.map((item: { number: number }) => item.number),
		[21],
	);
});

test("repository issue lists filter before slicing local frontier pages", async () => {
	const { tool, calls } = harness(async () => ({
		code: 0,
		stdout: JSON.stringify([
			{ number: 1, title: "Claimed", state: "OPEN", url: "u1", updatedAt: "2026-01-02", labels: [], assignees: [{ login: "busy" }], blockedBy: { nodes: [] } },
			{ number: 2, title: "Available", state: "OPEN", url: "u2", updatedAt: "2026-01-01", labels: [], assignees: [], blockedBy: { nodes: [] } },
		]),
		stderr: "",
	}));
	const result = await execute(tool, {
		command: "issue",
		action: "list",
		repo: "acme/repo",
		unassigned: true,
		limit: 1,
	});
	assert.deepEqual(
		JSON.parse(result.content[0]?.text ?? "{}").issues.map((item: { number: number }) => item.number),
		[2],
	);
	assert.ok(calls[0]?.includes("500"));
});

test("issue list excludes bodies and returns stable fields", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: JSON.stringify([issue(3, { body: "should not be requested" })]), stderr: "" }));
	const result = await execute(tool, { command: "issue", action: "list", repo: "acme/repo" });
	const listCall = calls.find((args) => args[0] === "issue") ?? [];
	assert.ok(!(listCall[listCall.indexOf("--json") + 1] ?? "").includes("body"));
	const item = JSON.parse(result.content[0]?.text ?? "{}").issues[0];
	assert.deepEqual(Object.keys(item).sort(), ["assignees", "blockedBy", "labels", "number", "state", "title", "updatedAt", "url"]);
});

test("child removal uses the singular native endpoint and numeric form field", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[1]?.endsWith("issues/9")) return { code: 0, stdout: JSON.stringify({ id: 909, number: 9, html_url: "u9" }), stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
	await execute(tool, { command: "relation", action: "remove", relation: "child", number: 8, relatedIssue: 9, repo: "acme/repo" });
	assert.equal(calls[1]?.[1], "repos/acme/repo/issues/8/sub_issue");
	assert.ok(calls[1]?.includes("-F") && calls[1]?.includes("sub_issue_id=909"));
});

test("comment bodies are always literal -f values", async () => {
	const bodies = ["@secret", "true", "line one\nline two"];
	for (const body of bodies) {
		const { tool, calls } = harness(async () => ({ code: 0, stdout: "{}", stderr: "" }));
		await execute(tool, { command: "comment", action: "create", number: 1, repo: "acme/repo", body });
		const call = calls[0] ?? [];
		assert.ok(call.includes("-f"));
		assert.ok(call.includes(`body=${body}`));
		assert.ok(!call.includes("-F"));
	}
});

test("repeated mutations are not read-cache hits and successful mutations invalidate reads", async () => {
	let writes = 0;
	let reads = 0;
	const { tool } = harness(async (args) => {
		if (args[0] === "api" && args[1]?.includes("comments")) { writes += 1; return { code: 0, stdout: "{}", stderr: "" }; }
		reads += 1;
		return { code: 0, stdout: JSON.stringify(issue(1)), stderr: "" };
	});
	await execute(tool, { command: "issue", action: "get", number: 1, repo: "acme/repo" });
	await execute(tool, { command: "comment", action: "create", number: 1, repo: "acme/repo", body: "one" });
	await execute(tool, { command: "comment", action: "create", number: 1, repo: "acme/repo", body: "two" });
	await execute(tool, { command: "issue", action: "get", number: 1, repo: "acme/repo" });
	assert.equal(writes, 2);
	assert.equal(reads, 2);
});

test("patch-section append, replace, remove, and conflict all use fresh reads", async () => {
	let updatedAt = "2026-01-01";
	const { tool, calls } = harness(async (args) => {
		if (args[0] === "api") return { code: 0, stdout: JSON.stringify(issue(5, { body: "## Destination\nold\n\n## Notes\nkeep", updated_at: updatedAt })), stderr: "" };
		if (args[0] === "issue" && args[1] === "edit") { updatedAt = "2026-01-02"; return { code: 0, stdout: "", stderr: "" }; }
		return { code: 0, stdout: "", stderr: "" };
	});
	await execute(tool, { command: "issue", action: "patch-section", number: 5, repo: "acme/repo", section: "Destination", operation: "append", content: "more" });
	assert.ok(calls.some((args) => args[0] === "issue" && args.includes("--body")));
	await assert.rejects(() => execute(tool, { command: "issue", action: "patch-section", number: 5, repo: "acme/repo", section: "Notes", operation: "remove", expectedUpdatedAt: "stale" }), /conflict/);
	assert.equal(calls.filter((args) => args[0] === "issue" && args[1] === "edit").length, 1);
});

test("issue mutation actions use focused gh argv and edit rejects no-op", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: "ok", stderr: "" }));
	await execute(tool, { command: "issue", action: "edit", number: 2, repo: "acme/repo", title: "New", addLabels: ["task"], removeAssignees: ["old"] });
	await execute(tool, { command: "issue", action: "claim", number: 2, repo: "acme/repo" });
	await execute(tool, { command: "issue", action: "close", number: 2, repo: "acme/repo", reason: "not planned", comment: "done" });
	await execute(tool, { command: "issue", action: "reopen", number: 2, repo: "acme/repo" });
	assert.ok(calls.some((args) => args.includes("--add-label") && args.includes("--remove-assignee")));
	assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "edit" && args.includes("@me")));
	assert.ok(calls.some((args) => args[1] === "close" && args.includes("not planned")));
	assert.ok(calls.some((args) => args[1] === "reopen"));
});

test("relation list returns normalized items and relation semantics stay distinct", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[1]?.includes("sub_issues?")) return { code: 0, stdout: JSON.stringify([{ number: 4, title: "Child", state: "OPEN", html_url: "u4", updated_at: "now", labels: [], assignees: [] }]), stderr: "" };
		if (args[1]?.includes("issues/4/dependencies/blocked_by")) return { code: 0, stdout: JSON.stringify([]), stderr: "" };
		return { code: 0, stdout: "[]", stderr: "" };
	});
	const result = await execute(tool, { command: "relation", action: "list", relation: "child", number: 1, repo: "acme/repo" });
	assert.equal(JSON.parse(result.content[0]?.text ?? "{}").items[0].number, 4);
	assert.equal(calls[0]?.[1], "repos/acme/repo/issues/1/sub_issues?per_page=30&page=1");
});

test("repo context, auth status, PR get/list, and comment edit/delete dispatch", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ nameWithOwner: "acme/repo", name: "repo", url: "u", description: "d", isArchived: false }), stderr: "" };
		if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: JSON.stringify({ login: "arya", id: 1, name: "Ary" }), stderr: "" };
		if (args[0] === "api" && args[1]?.includes("issues/comments")) return { code: 0, stdout: "{}", stderr: "" };
		if (args[0] === "api") return { code: 0, stdout: JSON.stringify(issue(8, { pull_request: {} })), stderr: "" };
		if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify({ number: 8, baseRefName: "main", headRefName: "feature", isDraft: false, additions: 1, deletions: 1, changedFiles: 1, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, reviewRequests: [] }), stderr: "" };
		if (args[0] === "pr") return { code: 0, stdout: "[]", stderr: "" };
		return { code: 0, stdout: "[]", stderr: "" };
	});
	await execute(tool, { command: "repo", action: "get", repo: "acme/repo" });
	await execute(tool, { command: "repo", action: "auth-status" });
	await execute(tool, { command: "pr", action: "get", number: 8, repo: "acme/repo" });
	await execute(tool, { command: "pr", action: "list", repo: "acme/repo" });
	await execute(tool, { command: "comment", action: "edit", commentId: 2, repo: "acme/repo", body: "edited" });
	assert.ok(calls.some((args) => args[0] === "repo" && args[1] === "view"));
	assert.ok(calls.some((args) => args[1] === "user"));
	assert.ok(calls.some((args) => args[0] === "pr" && args[1] === "view"));
	assert.ok(calls.some((args) => args.includes("-f") && args.includes("body=edited")));
});

test("delete is denied without UI and cancelled confirmation never mutates", async () => {
	const { tool, calls } = harness(async () => ({ code: 0, stdout: "deleted", stderr: "" }));
	await assert.rejects(() => execute(tool, { command: "comment", action: "delete", commentId: 2, repo: "acme/repo" }), /TUI confirmation/);
	await assert.rejects(() => execute(tool, { command: "issue", action: "delete", number: 2, repo: "acme/repo" }, { cwd: "/repo", mode: "tui", hasUI: true, ui: { confirm: async () => false } }), /cancelled/);
	assert.equal(calls.length, 0);
});

test("oversized overview output is bounded and saves the complete response", async () => {
	const body = `begin\n${"x".repeat(100_000)}\nend`;
	const { tool } = harness(async () => ({ code: 0, stdout: JSON.stringify(issue(12, { body })), stderr: "" }));
	const result = await execute(tool, { command: "issue", action: "get", number: 12, repo: "acme/repo" });
	assert.match(result.content[0]?.text ?? "", /Output truncated/);
	assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 50 * 1024);
	assert.ok((result.content[0]?.text ?? "").split("\n").length <= 2_000);
	const details = result.details as { fullOutputPath?: string };
	assert.ok(details.fullOutputPath);
	assert.equal(readFileSync(details.fullOutputPath!, "utf8"), formatGitHubOverview(parseGitHubIssue(JSON.stringify(issue(12, { body })), 12)));
});

test("renderer keeps github collapsed and reveals bounded output when expanded", async () => {
	const { tool } = harness(async () => ({ code: 0, stdout: JSON.stringify(issue(2, { body: "complete body" })), stderr: "" }));
	const renderTool = tool as Tool & { renderCall?: (args: Record<string, unknown>, theme: TestTheme, context: Record<string, unknown>) => TestRenderable; renderResult?: (result: { content: Array<{ text: string }> }, options: { expanded: boolean; isPartial: boolean }, theme: TestTheme, context: Record<string, unknown>) => TestRenderable };
	assert.ok(renderTool.renderCall && renderTool.renderResult);
	const theme: TestTheme = { fg: (_color, text) => text, bold: (text) => text };
	const state: Record<string, unknown> = {};
	const call = renderTool.renderCall({ command: "issue", action: "get", number: 2 }, theme, { state, lastComponent: undefined });
	assert.match(call.render(100).join("\n"), /github issue.get #2/);
	const result = await execute(tool, { command: "issue", action: "get", number: 2, repo: "acme/repo" });
	const collapsed = renderTool.renderResult(result, { expanded: false, isPartial: false }, theme, { state, lastComponent: undefined, isError: false, args: { command: "issue", action: "get", number: 2 } });
	assert.equal(collapsed.render(100).join("\n"), "");
	const expanded = renderTool.renderResult(result, { expanded: true, isPartial: false }, theme, { state, lastComponent: collapsed, isError: false, args: { command: "issue", action: "get", number: 2 } });
	assert.match(expanded.render(100).join("\n"), /complete body/);
});

type TestRenderable = { render(width: number): string[] };
type TestTheme = { fg(color: string, text: string): string; bold(text: string): string };

test("autocomplete registration is nonblocking, lazy, cached, and reset at session start", async () => {
	let sessionHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
	let factory: ((current: { getSuggestions: () => Promise<null>; applyCompletion: (lines: string[], line: number, col: number, item: unknown, prefix: string) => { lines: string[]; cursorLine: number; cursorCol: number } }) => { getSuggestions: (lines: string[], line: number, col: number, options: { signal: AbortSignal }) => Promise<unknown> }) | undefined;
	let calls = 0;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { if (event === "session_start") sessionHandler = handler; },
		registerTool() {},
		async exec(_command: string, args: string[]) {
			calls += 1;
			if (args[0] === "repo") return { code: 0, stdout: '{"nameWithOwner":"acme/repo"}', stderr: "", killed: false };
			if (args[0] === "issue") return { code: 0, stdout: JSON.stringify([{ number: 2, title: "Login", updatedAt: "now", url: "https://github.com/acme/repo/issues/2", blockedBy: { nodes: [] } }]), stderr: "", killed: false };
			return { code: 0, stdout: JSON.stringify([{ number: 3, title: "PR", updatedAt: "now", url: "https://github.com/acme/repo/pull/3", isDraft: false }]), stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	github(pi);
	assert.ok(sessionHandler);
	const context = { hasUI: true, cwd: "/repo", ui: { addAutocompleteProvider(value: typeof factory) { factory = value; }, notify() {} } };
	const result = sessionHandler({}, context);
	assert.equal(result, undefined);
	assert.equal(calls, 0);
	assert.ok(factory);
	const current = { async getSuggestions() { return null; }, applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }) };
	const provider = factory(current);
	await provider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	await provider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(calls, 3);
	const next = sessionHandler({}, context);
	assert.equal(next, undefined);
	assert.ok(factory);
	await factory(current).getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(calls, 6);
});

test("autocomplete passes cancellation to gh and does not cache an aborted load", async () => {
	const signals: AbortSignal[] = [];
	const pi = {
		async exec(_command: string, args: string[], options: { signal?: AbortSignal }) {
			if (args[0] === "repo") {
				return { code: 0, stdout: '{"nameWithOwner":"acme/repo"}', stderr: "", killed: false };
			}
			assert.ok(options.signal);
			signals.push(options.signal);
			return new Promise<never>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
	} as unknown as ExtensionAPI;
	const current: AutocompleteProvider = {
		async getSuggestions() { return null; },
		applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
	};
	const provider = createGitHubAutocomplete(createGitHubClient(pi), current, "/repo", () => {});
	const controller = new AbortController();
	const suggestions = provider.getSuggestions(["#"], 0, 1, { signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	assert.equal(await suggestions, null);
	assert.equal(signals.length, 2);
	assert.ok(signals.every((signal) => signal === controller.signal && signal.aborted));
});

test("autocomplete retries malformed list output instead of caching it", async () => {
	let issueCalls = 0;
	const pi = {
		async exec(_command: string, args: string[]) {
			if (args[0] === "repo") {
				return { code: 0, stdout: '{"nameWithOwner":"acme/repo"}', stderr: "", killed: false };
			}
			if (args[0] === "issue") {
				issueCalls += 1;
				const stdout = issueCalls === 1
					? "not json"
					: JSON.stringify([{ number: 2, title: "Issue", updatedAt: "now", url: "https://github.com/acme/repo/issues/2", blockedBy: { nodes: [] } }]);
				return { code: 0, stdout, stderr: "", killed: false };
			}
			return { code: 0, stdout: "[]", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	const current: AutocompleteProvider = {
		async getSuggestions() { return null; },
		applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
	};
	const provider = createGitHubAutocomplete(createGitHubClient(pi), current, "/repo", () => {});
	assert.equal(await provider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal }), null);
	const retried = await provider.getSuggestions(["#"], 0, 1, { signal: new AbortController().signal });
	assert.equal(retried?.items[0]?.value, "#2");
	assert.equal(issueCalls, 2);
});

test("killed commands and cancellation are classified without leaking stderr", async () => {
	const killed = harness(async () => ({ code: 137, stdout: "", stderr: "secret-token " + "x".repeat(20_000), killed: true }));
	await assert.rejects(() => execute(killed.tool, { command: "repo", action: "auth-status" }), /timeout\/killed/);
	let capturedSignal: AbortSignal | undefined;
	const pi = {
		on() {}, registerTool(value: Tool) { (this as { tool?: Tool }).tool = value; },
		async exec(_command: string, _args: string[], options: { signal?: AbortSignal }) { capturedSignal = options.signal; return Promise.reject(new Error("aborted")); },
		tool: undefined as Tool | undefined,
	} as unknown as ExtensionAPI & { tool?: Tool };
	github(pi);
	assert.ok(pi.tool);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => pi.tool!.execute("id", { command: "repo", action: "auth-status" }, controller.signal, undefined, { cwd: "/repo", mode: "print", hasUI: false, ui: {} } as never), /cancelled/);
	assert.equal(capturedSignal, controller.signal);
});

test("comment list fetches only its planned API pages", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[1] === "repos/acme/repo/issues/7") {
			return { code: 0, stdout: JSON.stringify(issue(7, { comments: 13 })), stderr: "" };
		}
		const page = Number(args[1]?.match(/[?&]page=(\d+)/)?.[1]);
		const ids = page === 2 ? [6, 7, 8, 9, 10] : page === 3 ? [11, 12, 13] : [];
		return {
			code: 0,
			stdout: JSON.stringify(ids.map((id) => ({
				id,
				user: { login: `user-${id}` },
				author_association: "CONTRIBUTOR",
				body: `Comment ${id}`,
				html_url: `u${id}`,
				created_at: "now",
				updated_at: "now",
			}))),
			stderr: "",
		};
	});
	const result = await execute(tool, {
		command: "comment",
		action: "list",
		number: 7,
		repo: "acme/repo",
		order: "desc",
	});
	const output = result.content[0]?.text ?? "";
	assert.ok(output.indexOf("Comment 13") < output.indexOf("Comment 12"));
	assert.equal(calls.filter((args) => args[1]?.includes("/comments?")).length, 2);
	assert.ok(calls.some((args) => args[1]?.includes("page=2")));
	assert.ok(calls.some((args) => args[1]?.includes("page=3")));
});

test("blocked-by removal uses the blocker database ID in the endpoint", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[1]?.endsWith("issues/9")) {
			return { code: 0, stdout: JSON.stringify({ id: 909 }), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	});
	await execute(tool, {
		command: "relation",
		action: "remove",
		relation: "blocked-by",
		number: 8,
		relatedIssue: 9,
		repo: "acme/repo",
	});
	assert.equal(
		calls[1]?.[1],
		"repos/acme/repo/issues/8/dependencies/blocked_by/909",
	);
	assert.ok(!calls[1]?.includes("-F"));
});

test("issue create wires the created database ID as a native child", async () => {
	const { tool, calls } = harness(async (args) => {
		if (args[0] === "issue" && args[1] === "create") return { code: 0, stdout: "https://github.com/acme/repo/issues/20\n", stderr: "" };
		if (args[1]?.endsWith("issues/20")) return { code: 0, stdout: JSON.stringify(issue(20, { id: 2020 })), stderr: "" };
		if (args[1]?.endsWith("issues/20/sub_issues")) return { code: 0, stdout: "", stderr: "" };
		return { code: 0, stdout: JSON.stringify(issue(20, { id: 2020 })), stderr: "" };
	});
	await execute(tool, { command: "issue", action: "create", repo: "acme/repo", title: "New", body: "body", parent: 1 });
	assert.ok(calls[0]?.includes("--title") && calls[0]?.includes("--body"));
	const relationCall = calls.find((args) => args[1] === "repos/acme/repo/issues/1/sub_issues");
	assert.ok(relationCall);
	assert.ok(relationCall.includes("-F") && relationCall.includes("sub_issue_id=2020"));
});
