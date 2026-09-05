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
