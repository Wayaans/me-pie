# Repository guide

## Purpose

Mepie is a Pi package that distributes extensions, skills, prompt templates, and themes. Pi loads these resources directly from the paths declared in `package.json`.

## Toolchain

- Use Bun for dependency management and scripts. Do not add npm, pnpm, or Yarn lockfiles.
- Write strict TypeScript.
- Use Effect 4 for effectful workflows, typed failures, resource safety, and concurrency. Run effects at Pi command, tool, or event-handler boundaries.
- Pi executes extension TypeScript through jiti; do not add a build step unless publication later requires generated assets.

## Layout

- `extensions/<name>/index.ts`: one entry point per extension.
- `extensions/<name>/*`: modules owned by that extension.
- `skills/<name>/SKILL.md`: Agent Skills packages.
- `prompts/*.md`: slash-command prompt templates. Prompt discovery is not recursive.
- `themes/*.json`: complete Pi theme definitions.

Do not place extension entry points directly in `extensions/`. Every extension must have its own folder.

`package.json` declares only `extensions/mepie/index.ts`. It loads the extensions registered in `extensions/mepie/catalog.ts` after applying the enable rules from `mepie.json`. Register every new extension in that catalog, or it never loads.

Mepie settings live in one `mepie.json` per scope: `<agentDir>/mepie.json` and `<cwd>/.pi/mepie.json`. Use `extensions/mepie/settings.ts` to read and write them. Each feature owns and validates one top-level key.

## Extension conventions

- Export a default factory that accepts `ExtensionAPI`.
- Use `import type` for Pi types.
- Start long-lived resources during `session_start`, not in the factory, and release them idempotently during `session_shutdown`.
- Respect `AbortSignal` in asynchronous operations.
- Guard UI behavior with `ctx.hasUI` or `ctx.mode === "tui"` as required.
- Throw from tool execution to report failures.
- Truncate large tool output to Pi's 50 KB or 2,000-line limits.
- Keep extension state branch-safe by persisting it in tool result details or custom session entries.

## Dependencies

- Put runtime dependencies, including `effect`, in `dependencies` because Pi package installs omit development dependencies.
- List Pi-provided packages in `peerDependencies` with `"*"`; do not bundle them.
- Add development copies of peer packages only when local type-checking needs them.

## Validation

Run before completing a change:

```bash
bun install
bun run check
```

For a manual package smoke test:

```bash
pi -e .
```

Then invoke the command added by the changed extension.
