import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const repo = Type.Optional(Type.String({
	pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$",
	description: "GitHub repository in owner/name form. Omit to resolve it from the working directory.",
}));
const number = Type.Integer({
	minimum: 1,
	description: "Positive issue or pull request number.",
});
const page = Type.Optional(Type.Integer({
	minimum: 1,
	maximum: 100,
	description: "1-based result page.",
}));
const limit = Type.Optional(Type.Integer({
	minimum: 1,
	maximum: 100,
	description: "Results per page, at most 100.",
}));
const state = Type.Optional(StringEnum(["open", "closed", "all"] as const, {
	description: "State filter. Defaults to open.",
}));
const order = Type.Optional(StringEnum(["asc", "desc"] as const, {
	description: "Updated-time order. Defaults to GitHub's native order.",
}));
const labels = Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
	description: "Label names.",
}));
const assignees = Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
	description: "GitHub login names.",
}));
const parent = Type.Optional(Type.Integer({
	minimum: 1,
	description: "Native parent issue number.",
}));
const relation = StringEnum(["child", "blocked-by"] as const, {
	description: "Native relation kind. For child, number is the parent. For blocked-by, number is the blocked issue.",
});

export const GitHubParameters = Type.Union([
	Type.Object({
		command: Type.Literal("repo"),
		action: Type.Literal("get", { description: "Read repository metadata." }),
		repo,
	}),
	Type.Object({
		command: Type.Literal("repo"),
		action: Type.Literal("auth-status", { description: "Read the authenticated GitHub user without exposing credentials." }),
		repo,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("get", { description: "Read one bounded issue overview and body." }),
		number,
		repo,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("list", { description: "Read a low-resolution issue index for frontier selection." }),
		repo,
		state,
		labels,
		assignee: Type.Optional(Type.String({ description: "Keep issues assigned to this login." })),
		unassigned: Type.Optional(Type.Boolean({ description: "Keep only issues with no assignees." })),
		parent,
		unblocked: Type.Optional(Type.Boolean({ description: "Keep only issues with no open blockers." })),
		page,
		limit,
		order,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("create", { description: "Create an issue, then optionally wire it as a native child." }),
		repo,
		title: Type.String({ minLength: 1 }),
		body: Type.Optional(Type.String()),
		labels,
		assignees,
		parent,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("edit", { description: "Edit issue fields. At least one change is required." }),
		number,
		repo,
		title: Type.Optional(Type.String()),
		body: Type.Optional(Type.String()),
		addLabels: labels,
		removeLabels: labels,
		addAssignees: assignees,
		removeAssignees: assignees,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("claim", { description: "Assign the authenticated current user." }),
		number,
		repo,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("close", { description: "Close an issue, optionally with a resolution comment." }),
		number,
		repo,
		comment: Type.Optional(Type.String()),
		reason: Type.Optional(StringEnum(["completed", "not planned"] as const)),
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("reopen"),
		number,
		repo,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("delete", { description: "Permanently delete an issue after TUI confirmation." }),
		number,
		repo,
	}),
	Type.Object({
		command: Type.Literal("issue"),
		action: Type.Literal("patch-section", { description: "Optimistically patch one named Markdown H2 section." }),
		number,
		repo,
		section: Type.String({ minLength: 1 }),
		operation: StringEnum(["append", "replace", "remove"] as const),
		content: Type.Optional(Type.String()),
		expectedUpdatedAt: Type.Optional(Type.String()),
	}),
	Type.Object({
		command: Type.Literal("pr"),
		action: Type.Literal("get", { description: "Read a bounded compact pull request overview." }),
		number,
		repo,
	}),
	Type.Object({
		command: Type.Literal("pr"),
		action: Type.Literal("list", { description: "Read a bounded pull request index." }),
		repo,
		state,
		page,
		limit,
		order,
	}),
	Type.Object({
		command: Type.Literal("comment"),
		action: Type.Literal("list", { description: "Read one bounded page of general issue or pull request comments." }),
		number,
		repo,
		page,
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		order,
	}),
	Type.Object({
		command: Type.Literal("comment"),
		action: Type.Literal("create", { description: "Create one general issue or pull request comment." }),
		number,
		repo,
		body: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		command: Type.Literal("comment"),
		action: Type.Literal("edit", { description: "Edit one general comment by database ID." }),
		commentId: Type.Integer({ minimum: 1 }),
		repo,
		body: Type.String({ minLength: 1 }),
	}),
	Type.Object({
		command: Type.Literal("comment"),
		action: Type.Literal("delete", { description: "Permanently delete one general comment after TUI confirmation." }),
		commentId: Type.Integer({ minimum: 1 }),
		repo,
	}),
	Type.Object({
		command: Type.Literal("relation"),
		action: Type.Literal("list", { description: "List native child or blocked-by relations." }),
		number,
		repo,
		relation,
		page,
		limit,
	}),
	Type.Object({
		command: Type.Literal("relation"),
		action: Type.Literal("add", { description: "Add a native child or blocked-by relation." }),
		number,
		repo,
		relatedIssue: number,
		relation,
	}),
	Type.Object({
		command: Type.Literal("relation"),
		action: Type.Literal("remove", { description: "Remove a native child or blocked-by relation." }),
		number,
		repo,
		relatedIssue: number,
		relation,
	}),
], {
	description: "Typed GitHub command/action request. Arbitrary shell and unrestricted gh api input are not accepted.",
});

export type GitHubParameters = Static<typeof GitHubParameters>;
export type RelationKind = "child" | "blocked-by";
export type ToolDetails = {
	command: string;
	action: string;
	number?: number;
	kind?: string;
	fullOutputPath?: string;
};
