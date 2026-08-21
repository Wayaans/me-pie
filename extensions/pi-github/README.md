# pi-github

`pi-github` provides `#` autocomplete and one typed native GitHub tool backed by the `gh` executable. It never accepts arbitrary shell text, raw argv, or unrestricted `gh api` input.

## Tool contract

The extension registers exactly one tool: `github`. Every call has top-level `command` and `action` discriminants. Every repository-backed action accepts `repo: "owner/name"` optionally. When omitted, the repository is resolved from the tool working directory with `gh repo view`.

| command | actions |
| --- | --- |
| `repo` | `get`, `auth-status` |
| `issue` | `get`, `list`, `create`, `edit`, `claim`, `close`, `reopen`, `delete`, `patch-section` |
| `pr` | `get`, `list` |
| `comment` | `list`, `create`, `edit`, `delete` |
| `relation` | `list`, `add`, `remove` |

Issue and pull-request targets are positive numbers. `issue.get` and `pr.get` return bounded metadata and body. Pull-request overviews include compact branch, change, draft, merge, and review-request metadata, but not reviews, files, checks, or diffs.

### Lists

`issue.list` supports `state: "open" | "closed" | "all"`, labels, assignee, `unassigned`, `parent`, `unblocked`, page, limit, and order. State defaults to `open`, including parent lists. Pull requests support state, page, limit, and order. Issue lists exclude pull requests and return only the low-resolution fields number, title, state, assignees, labels, URL, update time, and open blocker summaries. A parent uses GitHub's native sub-issues endpoint, fetches bounded blocker data for each returned child, and preserves native child order. Closed blockers are omitted. Page size is limited to 100, and issue or pull request list calls scan at most 500 items.

`comment.list` preserves general issue/PR conversation pagination. `page` defaults to 1, `limit` defaults to 5 and cannot exceed 20, and `order` defaults to oldest-first (`asc`). Each comment is limited to 4 KiB and total output to 24 KiB. Review threads and review comments are not included.

### Mutations

`issue.create` can add labels, assignees, and a native parent. `issue.edit` supports title/body and label or assignee additions/removals and rejects no-op requests. `issue.claim` assigns the authenticated user. `issue.close` supports a resolution comment and GitHub close reason. `issue.patch-section` appends, replaces, or removes one named level-2 Markdown section. It can require `expectedUpdatedAt`; a mismatch fails with a conflict before writing. Unrelated sections are preserved.

Comments can be created or edited by ID. `relation` operates on native GitHub relations only. For `child`, `issue` is the parent and `relatedIssue` is the child. For `blocked-by`, `issue` is blocked and `relatedIssue` is its blocker. Relation add/remove resolves the related issue's REST database ID and uses GitHub's native sub-issue or dependency endpoints.

Delete actions are destructive. They require an actual TUI confirmation and are rejected in non-TUI or no-UI modes. A cancelled confirmation performs no mutation.

Oversized issue/PR output stays within Pi's output limits and saves the complete overview to a temporary file. Mutation and list responses are bounded. Completed successful reads are cached for the current session, caches clear at session start, and every successful mutation invalidates affected repository reads. Failed reads are not cached, and autocomplete never fetches issue details merely because `#` was typed. Comment bodies are passed as literal `-f` fields, so values such as `@secret`, `true`, and multiline text are not interpreted by `gh`.

## Autocomplete

Type `#` to lazily load up to 500 open issues and 500 open pull requests, then filter locally. Suggestions show issue, PR, draft status, and open blockers. Autocomplete requires a UI and uses the current session snapshot.

## Requirements

- GitHub CLI (`gh`) installed and authenticated.
- A GitHub repository checkout, unless every call supplies `repo`.
- Appropriate GitHub permissions for requested reads and mutations.
