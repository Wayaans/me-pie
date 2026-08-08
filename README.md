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
- `codex-usage` — show OpenAI Codex subscription usage.
- `file-search` — provide first-class, bounded `fd` and `rg` search tools.
- `find-docs` — retrieve current Context7 documentation.
- `github-references` — autocomplete and inspect GitHub issues and pull requests.
- `localize` — translate and refine prompts into English before submission.
- `mepie-ui` — add a theme-aware PI header and model, context, cost, and Git dashboard.
- `skill-shortcut` — invoke loaded skills with `$skill-name`.

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
