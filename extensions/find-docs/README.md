# find-docs

Look up current library and framework documentation through a dedicated Context7 tool.

## Tool

- **`find_docs`** — resolves a Context7 library ID, then fetches documentation relevant to the query.

Parameters: `query`, optional `library`, optional `libraryId`.

## Behavior

- Adds Pi tool guidance that prefers `find_docs` for current library, framework, SDK, and CLI documentation.
- Blocks direct `ctx7`, `bunx ctx7`, and `npx ctx7` shell invocations while the tool is available.
- Truncates output to Pi's 50 KB or 2,000-line limits and saves complete oversized output to a temporary file.
- Runs an installed `ctx7` first, then falls back to `bunx --bun ctx7@latest`.

## Requirements

Install `ctx7`, or provide Bun and network access for the fallback.
