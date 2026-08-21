import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ACCEPT_HEADER,
	COMMAND_TIMEOUT_MS,
	repoApiPath,
	type GitHubClient,
} from "./client.ts";
import {
	isUnblocked,
	normalizeBlockers,
	normalizeIssueIndex,
	type IssueIndexItem,
} from "./lists.ts";
import type {
	GitHubParameters,
	RelationKind,
	ToolDetails,
} from "./schema.ts";
import {
	DEFAULT_COMMENT_LIMIT,
	formatGitHubCommentsPage,
	formatGitHubOverview,
	MAX_COMMENT_LIMIT,
	parseGitHubComments,
	parseGitHubIssue,
	parseGitHubPullRequest,
	patchMarkdown,
	planCommentPage,
	type GitHubComment,
	type GitHubIssueData,
	type GitHubPullRequestData,
} from "./tools.ts";

const MAX_LIST_PAGE_SIZE = 100;
const MAX_LIST_SCAN = 500;
const MAX_RELATIONS = 100;
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

type UnknownRecord = Record<string, unknown>;
type RepoParameters = Extract<GitHubParameters, { command: "repo" }>;
type IssueParameters = Extract<GitHubParameters, { command: "issue" }>;
type PullRequestParameters = Extract<GitHubParameters, { command: "pr" }>;
type CommentParameters = Extract<GitHubParameters, { command: "comment" }>;
type RelationParameters = Extract<GitHubParameters, { command: "relation" }>;

export type GitHubToolResult = {
	content: [{ type: "text"; text: string }];
	details: ToolDetails;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, label: string): UnknownRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as UnknownRecord;
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === null || value === undefined) return undefined;
	return stringValue(value, label);
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value as number;
}

function pageNumber(value: number | undefined): number {
	return positiveInteger(value ?? 1, "page");
}

function pageLimit(value: number | undefined, fallback: number): number {
	const limit = positiveInteger(value ?? fallback, "limit");
	if (limit > MAX_LIST_PAGE_SIZE) {
		throw new Error(`limit must be at most ${MAX_LIST_PAGE_SIZE}`);
	}
	return limit;
}

function requestedScan(page: number, limit: number): number {
	const count = page * limit;
	if (!Number.isSafeInteger(count) || count > MAX_LIST_SCAN) {
		throw new Error(`issue and pull request lists scan at most ${MAX_LIST_SCAN} items`);
	}
	return count;
}

function jsonText(value: unknown, label: string): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch (error) {
		throw new Error(`${label} could not be serialized: ${errorMessage(error)}`);
	}
}

function toolResult(text: string, details: ToolDetails): GitHubToolResult {
	const firstPass = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!firstPass.truncated) {
		return { content: [{ type: "text", text: firstPass.content }], details };
	}

	const notice = "\n\n[Output truncated to Pi's output limit.]";
	const bounded = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
		maxLines: DEFAULT_MAX_LINES - 2,
	});
	return {
		content: [{ type: "text", text: `${bounded.content}${notice}` }],
		details,
	};
}

function addFlags(args: string[], flag: string, values: string[] | undefined): void {
	for (const value of values ?? []) args.push(flag, value);
}

async function resolveRepo(
	client: GitHubClient,
	cwd: string,
	requested: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	return (await client.repo(cwd, requested, signal)).nameWithOwner;
}

function issueApiArgs(repo: string, number: number): string[] {
	return [
		"api",
		repoApiPath(repo, `issues/${number}`),
		"-H",
		`Accept: ${ACCEPT_HEADER}`,
	];
}

async function getIssue(
	client: GitHubClient,
	cwd: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
	fresh = false,
): Promise<GitHubIssueData> {
	const args = issueApiArgs(repo, number);
	const value = fresh
		? await client.freshJson(cwd, args, `issue #${number} fetch failed`, signal)
		: await client.readJson(cwd, args, `issue #${number} fetch failed`, signal);
	try {
		return parseGitHubIssue(JSON.stringify(value), number);
	} catch (error) {
		throw new Error(`issue #${number} response malformed: ${errorMessage(error)}`);
	}
}

async function getPullRequest(
	client: GitHubClient,
	cwd: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
): Promise<GitHubPullRequestData> {
	const value = await client.readJson(
		cwd,
		["pr", "view", String(number), "--repo", repo, "--json", PULL_REQUEST_FIELDS],
		`pull request #${number} fetch failed`,
		signal,
	);
	try {
		return parseGitHubPullRequest(JSON.stringify(value), number);
	} catch (error) {
		throw new Error(`pull request #${number} response malformed: ${errorMessage(error)}`);
	}
}

async function overviewResult(
	client: GitHubClient,
	cwd: string,
	repo: string,
	number: number,
	command: "issue" | "pr",
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	const issue = await getIssue(client, cwd, repo, number, signal);
	const pullRequest = command === "pr" || issue.kind === "pull-request"
		? await getPullRequest(client, cwd, repo, number, signal)
		: undefined;
	const complete = formatGitHubOverview(issue, pullRequest);
	const firstPass = truncateHead(complete, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	let text = firstPass.content;
	let fullOutputPath: string | undefined;
	if (firstPass.truncated) {
		const directory = await mkdtemp(join(tmpdir(), "mepie-pi-github-"));
		fullOutputPath = join(directory, `${command}-${number}.txt`);
		await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, complete, "utf8"));
		const notice = [
			"",
			`[Output truncated from ${firstPass.totalLines} lines (${formatSize(firstPass.totalBytes)}). `
				+ `Full output saved to: ${fullOutputPath}]`,
		].join("\n");
		const bounded = truncateHead(complete, {
			maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
			maxLines: DEFAULT_MAX_LINES - 2,
		});
		text = `${bounded.content}${notice}`;
	}

	return toolResult(text, {
		command,
		action: "get",
		number,
		kind: issue.kind,
		...(fullOutputPath ? { fullOutputPath } : {}),
	});
}

function relationPath(kind: RelationKind, number: number): string {
	return kind === "child"
		? `issues/${number}/sub_issues`
		: `issues/${number}/dependencies/blocked_by`;
}

async function relationItems(
	client: GitHubClient,
	cwd: string,
	repo: string,
	number: number,
	kind: RelationKind,
	page: number,
	limit: number,
	signal?: AbortSignal,
): Promise<unknown> {
	const endpoint = `${relationPath(kind, number)}?per_page=${limit}&page=${page}`;
	return client.readJson(
		cwd,
		["api", repoApiPath(repo, endpoint), "-H", `Accept: ${ACCEPT_HEADER}`],
		`relation ${kind} list failed`,
		signal,
	);
}

async function enrichChildBlockers(
	client: GitHubClient,
	cwd: string,
	repo: string,
	children: IssueIndexItem[],
	signal?: AbortSignal,
): Promise<IssueIndexItem[]> {
	return Promise.all(children.map(async (child) => {
		const dependencies = await relationItems(
			client,
			cwd,
			repo,
			child.number,
			"blocked-by",
			1,
			MAX_RELATIONS,
			signal,
		);
		return {
			...child,
			blockedBy: normalizeBlockers(dependencies, `issue #${child.number}.blockedBy`),
		};
	}));
}

async function relatedIssueId(
	client: GitHubClient,
	cwd: string,
	repo: string,
	number: number,
	signal?: AbortSignal,
): Promise<number> {
	const value = await client.readJson(
		cwd,
		issueApiArgs(repo, number),
		`related issue #${number} fetch failed`,
		signal,
	);
	return positiveInteger(record(value, "issue").id, "issue.id");
}

function parseRepository(value: unknown): UnknownRecord {
	const repository = record(value, "repository");
	return {
		nameWithOwner: stringValue(repository.nameWithOwner, "repository.nameWithOwner"),
		name: stringValue(repository.name, "repository.name"),
		url: stringValue(repository.url, "repository.url"),
		description: optionalString(repository.description, "repository.description") ?? "",
		isArchived: repository.isArchived === true,
	};
}

function parseAuthenticatedUser(value: unknown): UnknownRecord {
	const user = record(value, "user");
	return {
		authenticated: true,
		login: stringValue(user.login, "user.login"),
		id: positiveInteger(user.id, "user.id"),
		name: optionalString(user.name, "user.name"),
	};
}

function pullRequestIndex(value: unknown): UnknownRecord[] {
	if (!Array.isArray(value)) throw new Error("pull requests must be an array");
	return value.map((entry, index) => {
		const item = record(entry, `pull requests[${index}]`);
		return {
			number: positiveInteger(item.number, `pull requests[${index}].number`),
			title: stringValue(item.title, `pull requests[${index}].title`),
			state: stringValue(item.state, `pull requests[${index}].state`).toLowerCase(),
			url: stringValue(item.url, `pull requests[${index}].url`),
			updatedAt: stringValue(item.updatedAt, `pull requests[${index}].updatedAt`),
			isDraft: item.isDraft === true,
			headRefName: stringValue(item.headRefName, `pull requests[${index}].headRefName`),
			baseRefName: stringValue(item.baseRefName, `pull requests[${index}].baseRefName`),
			mergeStateStatus: stringValue(item.mergeStateStatus, `pull requests[${index}].mergeStateStatus`),
			reviewDecision: optionalString(item.reviewDecision, `pull requests[${index}].reviewDecision`),
		};
	});
}

async function confirmDestructiveAction(
	parameters: GitHubParameters,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<void> {
	const deletesIssue = parameters.command === "issue" && parameters.action === "delete";
	const deletesComment = parameters.command === "comment" && parameters.action === "delete";
	if (!deletesIssue && !deletesComment) return;
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		throw new Error("destructive GitHub actions require TUI confirmation");
	}

	const target = deletesIssue
		? `issue #${parameters.number}`
		: `comment #${parameters.commentId}`;
	const confirmed = await ctx.ui.confirm(
		`Delete GitHub ${target}?`,
		"This cannot be undone.",
		{
			timeout: COMMAND_TIMEOUT_MS,
			...(signal ? { signal } : {}),
		},
	);
	if (!confirmed) throw new Error("deletion cancelled");
}

async function executeRepo(
	client: GitHubClient,
	parameters: RepoParameters,
	cwd: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	if (parameters.action === "auth-status") {
		const value = await client.readJson(
			cwd,
			["api", "user", "-H", `Accept: ${ACCEPT_HEADER}`],
			"authentication status failed",
			signal,
		);
		return toolResult(jsonText(parseAuthenticatedUser(value), "authenticated user"), {
			command: "repo",
			action: "auth-status",
		});
	}

	const repo = await resolveRepo(client, cwd, parameters.repo, signal);
	const value = await client.readJson(
		cwd,
		["repo", "view", repo, "--json", "nameWithOwner,name,url,description,isArchived"],
		"repository fetch failed",
		signal,
	);
	return toolResult(jsonText(parseRepository(value), "repository"), {
		command: "repo",
		action: "get",
	});
}

type IssueListParameters = Extract<IssueParameters, { action: "list" }>;

function filterIssueMetadata(
	items: IssueIndexItem[],
	parameters: IssueListParameters,
): IssueIndexItem[] {
	const state = parameters.state ?? "open";
	const labels = parameters.labels;
	const assignee = parameters.assignee;
	return items.filter((item) => {
		if (state !== "all" && item.state !== state) return false;
		if (labels?.some((label) => !item.labels.includes(label))) return false;
		if (assignee && !item.assignees.includes(assignee)) return false;
		if (parameters.unassigned && item.assignees.length > 0) return false;
		return true;
	});
}

async function listParentIssues(
	client: GitHubClient,
	parameters: IssueListParameters,
	cwd: string,
	repo: string,
	page: number,
	limit: number,
	signal?: AbortSignal,
): Promise<IssueIndexItem[]> {
	const parent = parameters.parent;
	if (parent === undefined) throw new Error("parent issue is required");
	const targetCount = requestedScan(page, limit);
	const matches: IssueIndexItem[] = [];
	const sourceLimit = MAX_LIST_PAGE_SIZE;
	const maximumSourcePages = MAX_LIST_SCAN / sourceLimit;

	for (let sourcePage = 1; sourcePage <= maximumSourcePages; sourcePage += 1) {
		const rawChildren = await relationItems(
			client,
			cwd,
			repo,
			parent,
			"child",
			sourcePage,
			sourceLimit,
			signal,
		);
		const sourceItems = normalizeIssueIndex(rawChildren, "issues");
		const candidates = filterIssueMetadata(sourceItems, parameters);
		let enriched = await enrichChildBlockers(client, cwd, repo, candidates, signal);
		if (parameters.unblocked) enriched = enriched.filter(isUnblocked);
		matches.push(...enriched);

		if (matches.length >= targetCount || sourceItems.length < sourceLimit) break;
	}

	return matches.slice((page - 1) * limit, page * limit);
}

async function listRepositoryIssues(
	client: GitHubClient,
	parameters: IssueListParameters,
	cwd: string,
	repo: string,
	page: number,
	limit: number,
	signal?: AbortSignal,
): Promise<IssueIndexItem[]> {
	const needsLocalFiltering = parameters.unassigned === true || parameters.unblocked === true;
	const scan = needsLocalFiltering ? MAX_LIST_SCAN : requestedScan(page, limit);
	const args = [
		"issue",
		"list",
		"--repo",
		repo,
		"--state",
		parameters.state ?? "open",
		"--limit",
		String(scan),
		"--json",
		"number,title,state,assignees,labels,url,updatedAt,blockedBy",
	];
	if (parameters.assignee) args.push("--assignee", parameters.assignee);
	addFlags(args, "--label", parameters.labels);
	if (parameters.order) args.push("--search", `sort:updated-${parameters.order}`);

	const value = await client.readJson(cwd, args, "issue list failed", signal);
	let items = filterIssueMetadata(normalizeIssueIndex(value, "issues"), parameters);
	if (parameters.unblocked) items = items.filter(isUnblocked);
	return items.slice((page - 1) * limit, page * limit);
}

async function listIssues(
	client: GitHubClient,
	parameters: IssueListParameters,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	if (parameters.assignee && parameters.unassigned) {
		throw new Error("issue list cannot combine assignee with unassigned");
	}

	const page = pageNumber(parameters.page);
	const limit = pageLimit(parameters.limit, 30);
	const items = parameters.parent === undefined
		? await listRepositoryIssues(client, parameters, cwd, repo, page, limit, signal)
		: await listParentIssues(client, parameters, cwd, repo, page, limit, signal);

	return toolResult(jsonText({ repo, page, limit, issues: items }, "issue list"), {
		command: "issue",
		action: "list",
	});
}

function issueEditArgs(
	parameters: Extract<IssueParameters, { action: "edit" }>,
	repo: string,
): string[] {
	const hasChange = parameters.title !== undefined
		|| parameters.body !== undefined
		|| (parameters.addLabels?.length ?? 0) > 0
		|| (parameters.removeLabels?.length ?? 0) > 0
		|| (parameters.addAssignees?.length ?? 0) > 0
		|| (parameters.removeAssignees?.length ?? 0) > 0;
	if (!hasChange) throw new Error("issue edit cannot be a no-op");

	const args = ["issue", "edit", String(parameters.number), "--repo", repo];
	if (parameters.title !== undefined) args.push("--title", parameters.title);
	if (parameters.body !== undefined) args.push("--body", parameters.body);
	addFlags(args, "--add-label", parameters.addLabels);
	addFlags(args, "--remove-label", parameters.removeLabels);
	addFlags(args, "--add-assignee", parameters.addAssignees);
	addFlags(args, "--remove-assignee", parameters.removeAssignees);
	return args;
}

async function createIssue(
	client: GitHubClient,
	parameters: Extract<IssueParameters, { action: "create" }>,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	const args = [
		"issue",
		"create",
		"--repo",
		repo,
		"--title",
		parameters.title,
		"--body",
		parameters.body ?? "",
	];
	addFlags(args, "--label", parameters.labels);
	addFlags(args, "--assignee", parameters.assignees);

	const output = await client.mutationText(cwd, repo, args, "issue create failed", signal);
	const match = output.match(/https:\/\/[^\s]+\/issues\/(\d+)/);
	if (!match?.[1]) throw new Error("issue create returned no issue URL");

	const number = positiveInteger(Number(match[1]), "created issue number");
	const issue = await getIssue(client, cwd, repo, number, signal);
	const rawIssue = await client.readJson(
		cwd,
		issueApiArgs(repo, number),
		"created issue fetch failed",
		signal,
	);
	const databaseId = positiveInteger(record(rawIssue, "issue").id, "issue.id");

	if (parameters.parent !== undefined) {
		await client.mutationText(
			cwd,
			repo,
			[
				"api",
				repoApiPath(repo, `issues/${parameters.parent}/sub_issues`),
				"-X",
				"POST",
				"-H",
				`Accept: ${ACCEPT_HEADER}`,
				"-F",
				`sub_issue_id=${databaseId}`,
			],
			"child relation create failed",
			signal,
		);
	}

	return toolResult(jsonText({ number, url: issue.url, id: databaseId }, "created issue"), {
		command: "issue",
		action: "create",
		number,
	});
}

async function patchIssueSection(
	client: GitHubClient,
	parameters: Extract<IssueParameters, { action: "patch-section" }>,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	const issue = await getIssue(client, cwd, repo, parameters.number, signal, true);
	if (parameters.expectedUpdatedAt && parameters.expectedUpdatedAt !== issue.updatedAt) {
		throw new Error(`conflict: issue #${parameters.number} changed since ${parameters.expectedUpdatedAt}`);
	}

	const body = patchMarkdown(issue.body, parameters.section, parameters.operation, parameters.content);
	await client.mutationText(
		cwd,
		repo,
		["issue", "edit", String(parameters.number), "--repo", repo, "--body", body],
		`issue #${parameters.number} patch failed`,
		signal,
	);
	const updated = await getIssue(client, cwd, repo, parameters.number, signal, true);
	return toolResult(jsonText({
		number: updated.number,
		url: updated.url,
		updatedAt: updated.updatedAt,
	}, "patched issue"), {
		command: "issue",
		action: "patch-section",
		number: parameters.number,
	});
}

async function executeIssue(
	client: GitHubClient,
	parameters: IssueParameters,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	switch (parameters.action) {
		case "get":
			return overviewResult(client, cwd, repo, parameters.number, "issue", signal);
		case "list":
			return listIssues(client, parameters, cwd, repo, signal);
		case "create":
			return createIssue(client, parameters, cwd, repo, signal);
		case "edit": {
			const output = await client.mutationText(
				cwd,
				repo,
				issueEditArgs(parameters, repo),
				"issue edit failed",
				signal,
			);
			return toolResult(output || "Issue edited.", {
				command: "issue",
				action: "edit",
				number: parameters.number,
			});
		}
		case "claim": {
			const output = await client.mutationText(
				cwd,
				repo,
				["issue", "edit", String(parameters.number), "--repo", repo, "--add-assignee", "@me"],
				"issue claim failed",
				signal,
			);
			return toolResult(output || `Issue #${parameters.number} claimed.`, {
				command: "issue",
				action: "claim",
				number: parameters.number,
			});
		}
		case "close": {
			const args = ["issue", "close", String(parameters.number), "--repo", repo];
			if (parameters.reason) args.push("--reason", parameters.reason);
			if (parameters.comment) args.push("--comment", parameters.comment);
			const output = await client.mutationText(cwd, repo, args, "issue close failed", signal);
			return toolResult(output || `Issue #${parameters.number} closed.`, {
				command: "issue",
				action: "close",
				number: parameters.number,
			});
		}
		case "reopen": {
			const output = await client.mutationText(
				cwd,
				repo,
				["issue", "reopen", String(parameters.number), "--repo", repo],
				"issue reopen failed",
				signal,
			);
			return toolResult(output || `Issue #${parameters.number} reopened.`, {
				command: "issue",
				action: "reopen",
				number: parameters.number,
			});
		}
		case "delete": {
			const output = await client.mutationText(
				cwd,
				repo,
				["issue", "delete", String(parameters.number), "--repo", repo, "--yes"],
				"issue delete failed",
				signal,
			);
			return toolResult(output || `Issue #${parameters.number} deleted.`, {
				command: "issue",
				action: "delete",
				number: parameters.number,
			});
		}
		case "patch-section":
			return patchIssueSection(client, parameters, cwd, repo, signal);
	}
}

async function executePullRequest(
	client: GitHubClient,
	parameters: PullRequestParameters,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	if (parameters.action === "get") {
		return overviewResult(client, cwd, repo, parameters.number, "pr", signal);
	}

	const page = pageNumber(parameters.page);
	const limit = pageLimit(parameters.limit, 30);
	const scan = requestedScan(page, limit);
	const args = [
		"pr",
		"list",
		"--repo",
		repo,
		"--state",
		parameters.state ?? "open",
		"--limit",
		String(scan),
		"--json",
		"number,title,state,isDraft,url,updatedAt,headRefName,baseRefName,mergeStateStatus,reviewDecision",
	];
	if (parameters.order) args.push("--search", `sort:updated-${parameters.order}`);

	const value = await client.readJson(cwd, args, "pull request list failed", signal);
	const scanned = pullRequestIndex(value);
	const pullRequests = scanned.slice((page - 1) * limit, page * limit);
	return toolResult(jsonText({ repo, page, limit, pullRequests }, "pull request list"), {
		command: "pr",
		action: "list",
	});
}

async function listComments(
	client: GitHubClient,
	parameters: Extract<CommentParameters, { action: "list" }>,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	const issue = await getIssue(client, cwd, repo, parameters.number, signal);
	const page = pageNumber(parameters.page);
	const limit = positiveInteger(parameters.limit ?? DEFAULT_COMMENT_LIMIT, "limit");
	if (limit > MAX_COMMENT_LIMIT) throw new Error(`limit must be at most ${MAX_COMMENT_LIMIT}`);
	const order = parameters.order ?? "asc";
	const plan = planCommentPage(issue.commentCount, page, limit, order);

	let comments: GitHubComment[] = [];
	if (plan.apiPages.length > 0) {
		const pages = await Promise.all(plan.apiPages.map(async (apiPage) => {
			const endpoint = `issues/${parameters.number}/comments?per_page=${limit}&page=${apiPage}`;
			const value = await client.readJson(
				cwd,
				["api", repoApiPath(repo, endpoint), "-H", `Accept: ${ACCEPT_HEADER}`],
				`comments for #${parameters.number} failed`,
				signal,
			);
			return parseGitHubComments(JSON.stringify(value));
		}));
		const indexed = pages.flatMap((items, pageIndex) => items.map((comment, offset) => ({
			comment,
			index: (plan.apiPages[pageIndex]! - 1) * limit + offset,
		})));
		comments = indexed
			.filter((item) => item.index >= plan.ascStart && item.index < plan.ascEnd)
			.sort((left, right) => left.index - right.index)
			.map((item) => item.comment);
		if (order === "desc") comments.reverse();
	}

	return toolResult(formatGitHubCommentsPage({ issue, comments, page, limit, order, plan }), {
		command: "comment",
		action: "list",
		number: parameters.number,
	});
}

async function executeComment(
	client: GitHubClient,
	parameters: CommentParameters,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	switch (parameters.action) {
		case "list":
			return listComments(client, parameters, cwd, repo, signal);
		case "create": {
			const value = await client.mutationJson(
				cwd,
				repo,
				[
					"api",
					repoApiPath(repo, `issues/${parameters.number}/comments`),
					"-X",
					"POST",
					"-H",
					`Accept: ${ACCEPT_HEADER}`,
					"-f",
					`body=${parameters.body}`,
				],
				"comment create failed",
				signal,
			);
			return toolResult(jsonText(value, "created comment"), {
				command: "comment",
				action: "create",
				number: parameters.number,
			});
		}
		case "edit": {
			const value = await client.mutationJson(
				cwd,
				repo,
				[
					"api",
					repoApiPath(repo, `issues/comments/${parameters.commentId}`),
					"-X",
					"PATCH",
					"-H",
					`Accept: ${ACCEPT_HEADER}`,
					"-f",
					`body=${parameters.body}`,
				],
				"comment edit failed",
				signal,
			);
			return toolResult(jsonText(value, "edited comment"), {
				command: "comment",
				action: "edit",
			});
		}
		case "delete": {
			const output = await client.mutationText(
				cwd,
				repo,
				[
					"api",
					repoApiPath(repo, `issues/comments/${parameters.commentId}`),
					"-X",
					"DELETE",
					"-H",
					`Accept: ${ACCEPT_HEADER}`,
				],
				"comment delete failed",
				signal,
			);
			return toolResult(output || `Comment #${parameters.commentId} deleted.`, {
				command: "comment",
				action: "delete",
			});
		}
	}
}

async function executeRelation(
	client: GitHubClient,
	parameters: RelationParameters,
	cwd: string,
	repo: string,
	signal?: AbortSignal,
): Promise<GitHubToolResult> {
	if (parameters.action === "list") {
		const page = pageNumber(parameters.page);
		const limit = pageLimit(parameters.limit, 30);
		const raw = await relationItems(
			client,
			cwd,
			repo,
			parameters.number,
			parameters.relation,
			page,
			limit,
			signal,
		);
		let items = normalizeIssueIndex(raw, "relations", false);
		if (parameters.relation === "child") {
			items = await enrichChildBlockers(client, cwd, repo, items, signal);
		}
		return toolResult(jsonText({
			issue: parameters.number,
			relation: parameters.relation,
			page,
			limit,
			items,
		}, "relations"), {
			command: "relation",
			action: "list",
			number: parameters.number,
		});
	}

	const databaseId = await relatedIssueId(
		client,
		cwd,
		repo,
		parameters.relatedIssue,
		signal,
	);
	let endpoint: string;
	const args = ["api"];

	if (parameters.relation === "child") {
		endpoint = parameters.action === "add"
			? `issues/${parameters.number}/sub_issues`
			: `issues/${parameters.number}/sub_issue`;
		args.push(
			repoApiPath(repo, endpoint),
			"-X",
			parameters.action === "add" ? "POST" : "DELETE",
			"-H",
			`Accept: ${ACCEPT_HEADER}`,
			"-F",
			`sub_issue_id=${databaseId}`,
		);
	} else {
		endpoint = parameters.action === "add"
			? `issues/${parameters.number}/dependencies/blocked_by`
			: `issues/${parameters.number}/dependencies/blocked_by/${databaseId}`;
		args.push(
			repoApiPath(repo, endpoint),
			"-X",
			parameters.action === "add" ? "POST" : "DELETE",
			"-H",
			`Accept: ${ACCEPT_HEADER}`,
		);
		if (parameters.action === "add") args.push("-F", `issue_id=${databaseId}`);
	}

	const output = await client.mutationText(
		cwd,
		repo,
		args,
		`relation ${parameters.action} failed`,
		signal,
	);
	return toolResult(output || `Relation ${parameters.action} succeeded.`, {
		command: "relation",
		action: parameters.action,
		number: parameters.number,
	});
}

export async function executeGitHub(
	client: GitHubClient,
	parameters: GitHubParameters,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<GitHubToolResult> {
	await confirmDestructiveAction(parameters, signal, ctx);

	if (parameters.command === "repo") {
		return executeRepo(client, parameters, ctx.cwd, signal);
	}

	const repo = await resolveRepo(client, ctx.cwd, parameters.repo, signal);
	switch (parameters.command) {
		case "issue":
			return executeIssue(client, parameters, ctx.cwd, repo, signal);
		case "pr":
			return executePullRequest(client, parameters, ctx.cwd, repo, signal);
		case "comment":
			return executeComment(client, parameters, ctx.cwd, repo, signal);
		case "relation":
			return executeRelation(client, parameters, ctx.cwd, repo, signal);
	}
}
