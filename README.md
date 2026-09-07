# mepie

Mepie is a [Pi](https://pi.dev) package for distributing extensions, skills, prompt templates, and themes from one repository. It uses Bun, strict TypeScript, and Effect 4.

## Requirements

- [Bun](https://bun.sh)
- Pi
- Node.js 22.19 or newer when running Pi through Node.js

## Setup

```bash
bun install
bun run check
```

Load the repository without installing it:

```bash
pi -e .
```

Or install it as a local Pi package:

```bash
pi install ./path/to/mepie
```

## Package layout

```text
extensions/
  <extension-name>/
    index.ts        # default Pi extension factory
skills/
  <skill-name>/
    SKILL.md
prompts/
  <command-name>.md
themes/
  <theme-name>.json
```

Each extension lives in a separate folder. The `pi` manifest in `package.json` loads `extensions/*/index.ts` and the package's resource directories.

## Included extensions

- `answer` — extract questions from the latest assistant response into an interactive Q&A.
- `checkpoint-compaction` — replace Pi compaction summaries with structured continuation checkpoints.
- `codex-usage` — show OpenAI Codex subscription usage.
- `file-search` — provide first-class, bounded `fd` and `rg` search tools.
- `find-docs` — retrieve current Context7 documentation.
- `pi-github` — typed GitHub repository, issue, pull request, comment, and relation operations plus autocomplete.
- `localize`: compose English prompts from instructions or refine wording while preserving structure before submission.
- `mepie` — enable or disable Mepie extensions globally or for the current project with `/mepie`.
- `mepie-ui` — add a theme-aware PI header and model, context, cost, and Git dashboard.
- `mepie-tool-ui`: render built-in tools as compact, state-colored conversation rows with expandable output and mark collapsed skill reads as `[] skill-name` (Nerd Font required).
- `skill-shortcut` — invoke loaded skills with `$skill-name`.
- `terminal-environment` — expose one tmux-backed `workspace` tool for raw target operations and managed Agent Runs / Work Cycles.

## Managed Agent Runs and Work Cycles

`workspace` remains one tool with the existing `spawn`, `run`, `send`, `wait`, and `close` actions. Raw target-based calls remain backward compatible. A successful `run` returns a UUID Run ID while retaining tmux target diagnostics.

For verified Pi lifecycle support:

1. Run an agent and keep its `runId`.
2. Send one task with `send: { kind: "task", runId, input: "prompt", text }`. This creates a `workId` and delivery UUID and resolves the target internally.
3. The managed transport wraps correlation privately, then the child input hook removes it before prompt-template or skill expansion and binds the exact Work Cycle. The Pi worker reports through the same action with `send: { kind: "result", outcome: "completed" | "blocked" | "failed", text }`; the result is stored durably and is not pasted into the controller terminal.
4. Wait with `{ runId, workId? }` until both **Result Received** and **Work Finished** are recorded. A result/finish pair leaves the process and tmux target open for another Work Cycle.
5. Close only with `close: { runId }` when the Agent Run should actually end.

Pi readiness and Work Finished are verified through bounded launch/readiness coordination. Only verified Pi runs accept managed Work Cycles; Codex, Claude, and OpenCode retain UUID/process-started persistence and raw target operations but never claim verified Work Finished. The shared per-tmux-instance ledger uses owner-only files, locking, atomic writes, bounded result payloads, UUID correlation, and bounded historical retention. Pi session snapshot entries are validated branch-local diagnostics; the ledger remains runtime authority.

## Webweb exposure limits

Use `ww_search` for general web research, current information, finding sources, and claim evidence. Prefer `find_docs` for library and API documentation. Use `ww_fetch` to read supplied URLs or search sources, including GitHub repositories, directories, and files. When a responseId already exists, use `ww_read` to inspect cached content before fetching again, unless fresh content is needed.

Webweb applies these safeguards:

- Direct HTTP resolves and validates every redirect target, then pins the connection to a validated public address while preserving TLS certificate checks. Private/reserved IPs, embedded URL credentials, and unsupported ports are blocked. IPv6 uses a conservative allocation allowlist.
- Firecrawl scrape targets are validated before submission. Firecrawl still controls its remote DNS resolution and redirects; local checks cannot guarantee its network isolation.
- Provider API redirects are blocked. Firecrawl uses only the configured endpoint, with no automatic alternate-host fallback. OpenAI remains the search fallback for eligible ordinary provider failures.
- Direct HTTP bodies are capped at 5 MiB for both compressed and decoded bytes. Provider JSON is capped at 10 MiB decoded. Oversized bodies are cancelled before full buffering and do not trigger a provider fallback.
- GitHub file previews return at most 50 KiB of file text, with a truncation notice. Direct file downloads have the same 5 MiB body cap as HTTP pages and reject binary or non-UTF-8 content. Checkout previews reject symlinks in the requested path; direct raw downloads return Git symlink link text without following it. Directory listings are capped at 2,000 entries. Output directs further inspection through GitHub URLs rather than exposing clone paths for unrestricted shell reads. Clones are private temporary directories, not a sandbox against other processes running as the same user.
- Tool cancellation interrupts network retries and GitHub subprocesses. Terminal rendering removes external control sequences without altering stored content.

## Webweb result integrity

Phase 2 removes automated factual verdicts. `ww_search` with `mode: "verify"` collects evidence and returns `not-assessed`, with no confidence score. Search snippets are labeled as snippets, not quotations. Optional fetched-page excerpts are selected by keyword relevance to the claim; selection does not establish support or contradiction. The caller must assess the claim. An empty passage list does not prove that evidence is absent.

Search keeps generated answer text, search snippets, URL citation metadata, and fetched page content separate. OpenAI citation offsets refer to its generated answer, never source quotations. All returned consulted and cited sources are merged by exact URL without discarding repeated citation associations. `numResults` is a requested target for OpenAI, not a cap that removes its citations. `ww_read` labels cached text as a fetched page, search snippet, unavailable, or legacy content of unknown provenance. It does not promise that a snippet or failed fetch is full page text.

Search constraints are never silently dropped:

- `domainFilter` accepts up to 100 hostnames, either all included or all prefixed with `-` to exclude. Mixed include/exclude lists are rejected because Firecrawl cannot honor them together. OpenAI fallback receives the same domain constraints.
- `recencyFilter` maps to Firecrawl's web time filter. OpenAI has no verified equivalent control here, so a recency-constrained search fails rather than falling back without it. Constrained Firecrawl searches require API v2; v1 support is not assumed.
- These controls use the providers' documented filtering semantics. They do not independently verify publication dates or the accuracy of provider results.

GitHub `/blob/` URLs download only the requested file from `raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>` through the pinned HTTP transport. They do not create a checkout, clone directory, or repository-size request. Named refs use `git ls-remote` to resolve an immutable commit; full 40-character SHA file URLs require no Git subprocess or exec capability. Both readable and raw modes return the file preview with its commit and path, rather than treating source code as a web page. Successful file previews are cached for `ww_read` with the immutable raw URL.

Repository-root and `/tree/` URLs still use temporary checkouts. They fetch the resolved commit and verify both the fetched and checked-out commit before reading. `forceClone` only affects this checkout path. Slash-containing refs use the longest advertised ref prefix; conflicting branch/tag names require a SHA. URL components are decoded once and encoded individually for raw URLs. Query strings and fragments do not become file paths. A missing ref, unavailable SHA/file, or checkout mismatch fails without default-branch, crawler, or clone fallback.

Direct file downloads do not send credentials. Private raw files requiring authentication are unsupported, even if local Git can authenticate during named-ref resolution. Checkout operations still use Git's configured credential mechanism. No GitHub credentials are passed to hosted providers. GitHub's [permanent file links](https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files) document commit-specific URLs; its [authentication troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) explains that unauthenticated private resources may return 404.

Provider contracts were checked against [Firecrawl search](https://docs.firecrawl.dev/features/search) and [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search). Tests use mocked providers and temporary local Git repositories, not live provider calls.

Retrieval selectors, fuzzy matching, cache durability, and paging remain deferred to phase 3. Clone size metadata remains a preflight estimate, not a hard disk quota. Provider key input and storage are unchanged.

## Add an extension

1. Create `extensions/<name>/index.ts`.
2. Export a default function that receives `ExtensionAPI`.
3. Keep supporting modules inside the same folder.
4. Use Effect for effectful workflows and run the resulting effect at a Pi handler boundary.
5. Run `bun run check`.

## Other resources

- Add skills as `skills/<name>/SKILL.md` with valid Agent Skills frontmatter.
- Add prompt templates as top-level Markdown files in `prompts/`.
- Add complete Pi theme JSON files to `themes/`.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run typecheck` | Type-check all extensions without emitting files. |
| `bun run test` | Run the extension test suite. |
| `bun run check` | Type-check and test the package. |

Effect 4 is currently installed as `4.0.0-beta.102`, the current Effect 4 beta pinned for reproducible installs.
