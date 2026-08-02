# github-references

Autocomplete GitHub references and inspect issues or pull requests through bounded, read-only tools.

## Autocomplete

- Type `#` to list recently updated open issues and pull requests.
- Continue typing a number or title to filter the list.
- Suggestions identify issues, pull requests, and draft pull requests.
- Issues with open GitHub dependencies show their blockers, for example `[issue] [block #40 other/project#41]`. Same-repository blockers use `#40`; cross-repository blockers use `owner/repo#41`. Closed blockers are omitted.
- Selecting a suggestion inserts GitHub's native `#123` reference.

The extension loads up to 500 open issues and 500 open pull requests once per Pi session, then filters them locally. Run `/reload` to refresh the snapshot.

## Tools

### `github_get({ number })`

Returns an issue or pull-request overview with its body. Pull requests also include branch names, change totals, merge state, review decision, and pending review requests. Oversized output is truncated to Pi's 50 KB or 2,000-line limits and the complete output is saved to a temporary file.

The tool does not fetch general comments, review bodies, inline review threads, files, commits, or diffs. Its collapsed tool row shows only `github_get → Issue #1 ✓` or `github_get → PR #1 ✓`. Use Pi's tool-expansion shortcut (`Ctrl+O` by default) to show the returned metadata and body in the TUI.

### `github_comments({ number, page?, limit?, order? })`

Returns one page of general issue or pull-request conversation.

- `page` defaults to `1`.
- `limit` defaults to `5` and cannot exceed `20`.
- `order` defaults to `asc` (oldest first); use `desc` for newest first.
- Each comment is limited to 4 KiB.
- Total output is limited to 24 KiB.

The result reports the total comment count, navigation state, comments omitted before and after the page, comments omitted by the output limit, and truncated comments. It does not fetch inline review threads, review comments or reviews, files, or diffs.

Both tools fetch data only when called. Typing or mentioning `#123` never fetches an issue body, comments, PR files, reviews, or a diff. Successful tool requests are cached for the current Pi session; `/reload` refreshes them.

## Requirements

- GitHub CLI (`gh`) installed and authenticated, with `blockedBy` support in `gh issue list --json`.
- A GitHub repository checkout that `gh repo view` can resolve. If the checkout has multiple remotes, configure the intended repository with `gh repo set-default`.

The extension registers no commands and has no extension-local npm dependencies. Autocomplete requires a UI; the read-only tools also work in print and JSON modes.
