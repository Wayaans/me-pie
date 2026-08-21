export type GitHubItemKind = "issue" | "pull-request";

export function patchMarkdown(body: string, heading: string, operation: "append" | "replace" | "remove", content: string | undefined): string {
	const name = heading.trim();
	if (!name) throw new Error("section must be nonempty");
	const normalizedContent = content?.trim();
	if (operation !== "remove" && !normalizedContent) throw new Error(`${operation} requires nonempty content`);
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^##(?!#)\s+/.test(line) && line.replace(/^##\s+/, "").trim() === name);
	const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^##(?!#)\s+/.test(line));
	if (start < 0) {
		if (operation === "remove" || operation === "replace") throw new Error(`section not found: ${name}`);
		const suffix = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
		return `${body}${suffix}\n## ${name}\n${normalizedContent ?? ""}`;
	}
	const finish = end < 0 ? lines.length : end;
	const existing = lines.slice(start + 1, finish).join("\n").trim();
	if (operation === "remove") return [...lines.slice(0, start), ...lines.slice(finish)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
	const replacement = operation === "append"
		? [existing, normalizedContent].filter(Boolean).join("\n\n")
		: normalizedContent ?? "";
	const separator = finish > start + 1 && lines[finish - 1] === "" ? [""] : [];
	return [...lines.slice(0, start + 1), replacement, ...separator, ...lines.slice(finish)].join("\n");
}

export type GitHubIssueData = {
	kind: GitHubItemKind;
	number: number;
	title: string;
	state: string;
	stateReason?: string | undefined;
	author: string;
	body: string;
	url: string;
	labels: string[];
	assignees: string[];
	milestone?: string | undefined;
	commentCount: number;
	createdAt: string;
	updatedAt: string;
	closedAt?: string | undefined;
};

export type GitHubPullRequestData = {
	number: number;
	baseRefName: string;
	headRefName: string;
	isDraft: boolean;
	additions: number;
	deletions: number;
	changedFiles: number;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision?: string | undefined;
	reviewRequests: string[];
};

export type GitHubComment = {
	id: number;
	author: string;
	authorAssociation: string;
	body: string;
	url: string;
	createdAt: string;
	updatedAt: string;
};

export type CommentPagePlan = {
	ascStart: number;
	ascEnd: number;
	apiPages: number[];
	omittedBefore: number;
	omittedAfter: number;
	hasPrevious: boolean;
	hasNext: boolean;
};

export const COMMENT_MAX_BYTES = 4 * 1024;
export const COMMENTS_OUTPUT_MAX_BYTES = 24 * 1024;
export const DEFAULT_COMMENT_LIMIT = 5;
export const MAX_COMMENT_LIMIT = 20;

const MAX_LIST_ITEMS = 10;
const MAX_SCALAR_BYTES = 512;
const MAX_URL_BYTES = 2 * 1024;

type UnknownRecord = Record<string, unknown>;

type TruncatedText = {
	text: string;
	truncated: boolean;
	originalBytes: number;
	shownBytes: number;
};

function asRecord(value: unknown, label: string): UnknownRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as UnknownRecord;
}

function requiredString(record: UnknownRecord, key: string, label: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
	return value;
}

function nullableString(record: UnknownRecord, key: string, label: string): string | undefined {
	const value = record[key];
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label}.${key} must be a string or null`);
	return value;
}

function requiredInteger(record: UnknownRecord, key: string, label: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label}.${key} must be a non-negative integer`);
	}
	return value as number;
}

function requiredBoolean(record: UnknownRecord, key: string, label: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
	return value;
}

function parseLogin(value: unknown, label: string): string {
	if (value === null) return "ghost";
	return requiredString(asRecord(value, label), "login", label);
}

function parseStringArray(value: unknown, label: string, getValue: (item: UnknownRecord, label: string) => string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((item, index) => {
		const itemLabel = `${label}[${index}]`;
		return getValue(asRecord(item, itemLabel), itemLabel);
	});
}

export function parseGitHubIssue(json: string, expectedNumber: number): GitHubIssueData {
	const value = asRecord(JSON.parse(json) as unknown, "issue");
	const number = requiredInteger(value, "number", "issue");
	if (number !== expectedNumber) throw new Error(`issue.number did not match requested #${expectedNumber}`);

	let kind: GitHubItemKind = "issue";
	if ("pull_request" in value) {
		asRecord(value.pull_request, "issue.pull_request");
		kind = "pull-request";
	}

	const labels = parseStringArray(value.labels, "issue.labels", (item, label) => requiredString(item, "name", label));
	const assignees = parseStringArray(value.assignees, "issue.assignees", (item, label) => requiredString(item, "login", label));
	const milestoneValue = value.milestone;
	let milestone: string | undefined;
	if (milestoneValue !== null && milestoneValue !== undefined) {
		milestone = requiredString(asRecord(milestoneValue, "issue.milestone"), "title", "issue.milestone");
	}

	return {
		kind,
		number,
		title: requiredString(value, "title", "issue"),
		state: requiredString(value, "state", "issue"),
		stateReason: nullableString(value, "state_reason", "issue"),
		author: parseLogin(value.user, "issue.user"),
		body: nullableString(value, "body", "issue") ?? "",
		url: requiredString(value, "html_url", "issue"),
		labels,
		assignees,
		milestone,
		commentCount: requiredInteger(value, "comments", "issue"),
		createdAt: requiredString(value, "created_at", "issue"),
		updatedAt: requiredString(value, "updated_at", "issue"),
		closedAt: nullableString(value, "closed_at", "issue"),
	};
}

export function parseGitHubPullRequest(json: string, expectedNumber: number): GitHubPullRequestData {
	const value = asRecord(JSON.parse(json) as unknown, "pull request");
	const number = requiredInteger(value, "number", "pull request");
	if (number !== expectedNumber) throw new Error(`pull request.number did not match requested #${expectedNumber}`);

	const reviewRequests = parseStringArray(value.reviewRequests, "pull request.reviewRequests", (item, label) => {
		for (const key of ["login", "slug", "name"] as const) {
			if (typeof item[key] === "string") return item[key];
		}
		throw new Error(`${label} must contain login, slug, or name`);
	});

	return {
		number,
		baseRefName: requiredString(value, "baseRefName", "pull request"),
		headRefName: requiredString(value, "headRefName", "pull request"),
		isDraft: requiredBoolean(value, "isDraft", "pull request"),
		additions: requiredInteger(value, "additions", "pull request"),
		deletions: requiredInteger(value, "deletions", "pull request"),
		changedFiles: requiredInteger(value, "changedFiles", "pull request"),
		mergeable: requiredString(value, "mergeable", "pull request"),
		mergeStateStatus: requiredString(value, "mergeStateStatus", "pull request"),
		reviewDecision: nullableString(value, "reviewDecision", "pull request"),
		reviewRequests,
	};
}

export function parseGitHubComments(json: string): GitHubComment[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("comments response must be an array");

	return parsed.map((item, index) => {
		const label = `comments[${index}]`;
		const value = asRecord(item, label);
		return {
			id: requiredInteger(value, "id", label),
			author: parseLogin(value.user, `${label}.user`),
			authorAssociation: requiredString(value, "author_association", label),
			body: nullableString(value, "body", label) ?? "",
			url: requiredString(value, "html_url", label),
			createdAt: requiredString(value, "created_at", label),
			updatedAt: requiredString(value, "updated_at", label),
		};
	});
}

export function planCommentPage(total: number, page: number, limit: number, order: "asc" | "desc"): CommentPagePlan {
	const rawOffset = (page - 1) * limit;
	const offset = Number.isSafeInteger(rawOffset) ? rawOffset : total;
	const pageSize = offset >= total ? 0 : Math.min(limit, total - offset);
	let ascStart = offset;
	let ascEnd = offset + pageSize;

	if (order === "desc") {
		ascStart = Math.max(total - offset - pageSize, 0);
		ascEnd = Math.max(total - offset, 0);
	}

	const apiPages: number[] = [];
	if (pageSize > 0) {
		const firstPage = Math.floor(ascStart / limit) + 1;
		const lastPage = Math.floor((ascEnd - 1) / limit) + 1;
		for (let apiPage = firstPage; apiPage <= lastPage; apiPage += 1) apiPages.push(apiPage);
	}

	return {
		ascStart,
		ascEnd,
		apiPages,
		omittedBefore: Math.min(offset, total),
		omittedAfter: Math.max(total - Math.min(offset, total) - pageSize, 0),
		hasPrevious: offset > 0 && total > 0,
		hasNext: offset + pageSize < total,
	};
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	let bytes = 0;
	let result = "";
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function truncateWithNotice(text: string, maxBytes: number, label: string): TruncatedText {
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) {
		return { text, truncated: false, originalBytes, shownBytes: originalBytes };
	}

	let contentBudget = maxBytes;
	let content = "";
	let notice = "";
	for (let attempt = 0; attempt < 4; attempt += 1) {
		content = truncateUtf8(text, contentBudget);
		const shownBytes = Buffer.byteLength(content, "utf8");
		notice = `\n[${label} truncated: showing ${shownBytes} of ${originalBytes} bytes]`;
		contentBudget = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
	}

	content = truncateUtf8(text, contentBudget);
	const shownBytes = Buffer.byteLength(content, "utf8");
	notice = `\n[${label} truncated: showing ${shownBytes} of ${originalBytes} bytes]`;
	return {
		text: `${content}${notice}`,
		truncated: true,
		originalBytes,
		shownBytes,
	};
}

function boundedSingleLine(text: string, maxBytes = MAX_SCALAR_BYTES): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	const truncated = truncateWithNotice(singleLine, maxBytes, "value");
	return truncated.text.replace("\n", " ");
}

function formatList(values: string[]): string {
	if (values.length === 0) return "none";
	const shown = values.slice(0, MAX_LIST_ITEMS).map((value) => boundedSingleLine(value, 256));
	const omitted = values.length - shown.length;
	return omitted > 0 ? `${shown.join(", ")} (+${omitted} omitted)` : shown.join(", ");
}

export function formatGitHubOverview(issue: GitHubIssueData, pullRequest?: GitHubPullRequestData): string {
	if (issue.kind === "pull-request" && !pullRequest) throw new Error("pull request metadata is required");
	if (issue.kind === "issue" && pullRequest) throw new Error("pull request metadata was provided for an issue");

	const kind = issue.kind === "issue" ? "issue" : "pull request";
	const lines = [
		`GitHub ${kind} #${issue.number}`,
		`Title: ${boundedSingleLine(issue.title, 1024)}`,
		`State: ${boundedSingleLine(issue.state)}${issue.stateReason ? ` (${boundedSingleLine(issue.stateReason)})` : ""}`,
		`Author: @${boundedSingleLine(issue.author, 256)}`,
		`URL: ${boundedSingleLine(issue.url, MAX_URL_BYTES)}`,
		`Created: ${boundedSingleLine(issue.createdAt)} | Updated: ${boundedSingleLine(issue.updatedAt)}${issue.closedAt ? ` | Closed: ${boundedSingleLine(issue.closedAt)}` : ""}`,
		`Labels: ${formatList(issue.labels)}`,
		`Assignees: ${formatList(issue.assignees)}`,
		`Milestone: ${issue.milestone ? boundedSingleLine(issue.milestone) : "none"}`,
		`General comments: ${issue.commentCount} (omitted; use github command=comment action=list)`, 
	];

	if (pullRequest) {
		lines.push(
			`Branches: ${boundedSingleLine(pullRequest.headRefName)} -> ${boundedSingleLine(pullRequest.baseRefName)}`,
			`Changes: +${pullRequest.additions} -${pullRequest.deletions} across ${pullRequest.changedFiles} files`,
			`Draft: ${pullRequest.isDraft ? "yes" : "no"} | Mergeable: ${boundedSingleLine(pullRequest.mergeable)} | Merge state: ${boundedSingleLine(pullRequest.mergeStateStatus)}`,
			`Review decision: ${pullRequest.reviewDecision ? boundedSingleLine(pullRequest.reviewDecision) : "none"} | Pending requests: ${formatList(pullRequest.reviewRequests)}`,
			"Omitted content: general comments, review bodies, inline review threads, files, and diff were not fetched.",
		);
	} else {
		lines.push("Omitted content: general comments were not fetched.");
	}

	lines.push("", "Body:");
	return `${lines.join("\n")}\n${issue.body || "(empty)"}`;
}

export function formatGitHubComment(comment: GitHubComment): { text: string; truncated: boolean } {
	const body = comment.body || "(empty)";
	const raw = [
		`### Comment ${comment.id} by @${boundedSingleLine(comment.author, 256)}`,
		`Created: ${boundedSingleLine(comment.createdAt)} | Updated: ${boundedSingleLine(comment.updatedAt)}`,
		`Association: ${boundedSingleLine(comment.authorAssociation, 256)}`,
		`URL: ${boundedSingleLine(comment.url, MAX_URL_BYTES)}`,
		"",
		body,
	].join("\n");
	const bounded = truncateWithNotice(raw, COMMENT_MAX_BYTES, `Comment ${comment.id}`);
	return { text: bounded.text, truncated: bounded.truncated };
}

export function formatGitHubCommentsPage(input: {
	issue: GitHubIssueData;
	comments: GitHubComment[];
	page: number;
	limit: number;
	order: "asc" | "desc";
	plan: CommentPagePlan;
}): string {
	const formatted = input.comments.map(formatGitHubComment);
	const truncatedOnPage = formatted.filter((comment) => comment.truncated).length;
	let shown = [...formatted];

	const render = (): string => {
		const omittedByOutputLimit = formatted.length - shown.length;
		const truncatedShown = shown.filter((comment) => comment.truncated).length;
		const header = [
			`GitHub ${input.issue.kind === "issue" ? "issue" : "pull request"} #${input.issue.number} general comments`,
			`Pagination: page=${input.page} limit=${input.limit} order=${input.order} total=${input.issue.commentCount}`,
			`Counts: page_items=${formatted.length} shown=${shown.length} omitted_before=${input.plan.omittedBefore} omitted_after=${input.plan.omittedAfter} omitted_by_output_limit=${omittedByOutputLimit} truncated_on_page=${truncatedOnPage} truncated_shown=${truncatedShown}`,
			`Navigation: previous=${input.plan.hasPrevious ? "yes" : "no"} next=${input.plan.hasNext ? "yes" : "no"}`,
			`Limits: ${COMMENT_MAX_BYTES} bytes per comment; ${COMMENTS_OUTPUT_MAX_BYTES} bytes total.`,
			"Omitted content: inline review threads, review comments/reviews, files, and diffs were not fetched.",
		].join("\n");
		return shown.length > 0 ? `${header}\n\n${shown.map((comment) => comment.text).join("\n\n")}` : `${header}\n\n(No comments on this page.)`;
	};

	let output = render();
	while (Buffer.byteLength(output, "utf8") > COMMENTS_OUTPUT_MAX_BYTES && shown.length > 0) {
		shown.pop();
		output = render();
	}
	return truncateWithNotice(output, COMMENTS_OUTPUT_MAX_BYTES, "Comments output").text;
}
