# find-docs

Look up current library, framework, SDK, and CLI documentation through Context7.

## Tool

`find_docs` accepts:

- `query`, a specific documentation question
- `library`, a package or product name to resolve
- `libraryId`, a Context7 ID such as `/facebook/react`

Provide either `library` or `libraryId`. A supplied ID must use `/owner/project` or `/owner/project/version` form.

## Behavior

- Resolves library names through `ctx7 library ... --json`, then queries the selected ID.
- Uses an installed `ctx7` command when available.
- Falls back to `bunx --bun ctx7@latest` only when the installed command is unavailable.
- Preserves cancellation and classifies command, quota, timeout, input, and response failures.
- Reports empty library and documentation searches without repeating the request.
- Limits output to Pi's 50 KB or 2,000-line bounds. Complete oversized output is stored in a private temporary file until session shutdown.
- Blocks direct Context7 shell lookups while `find_docs` is active.

## Requirements

Install `ctx7`, or provide Bun and network access for the fallback. Run `ctx7 login` for higher Context7 rate limits.
