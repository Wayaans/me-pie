# Ticket 2: Extension convention sample

## Objective

Check a bounded sample of extensions against the repository's documented entry-point conventions.

## Requirements

1. Read `AGENTS.md` and summarize the extension layout and default-factory requirements.
2. Inspect exactly the first three extension directories in lexical order.
3. For each sampled extension, verify whether `index.ts` exists in its own directory and whether it exports a default factory accepting the Pi extension API.
4. Report pass, fail, or inconclusive for each check with path-and-line evidence.

## Constraints

Follow all read-only and reporting rules in `spec.md`. Do not fix any finding, modify files, or create a commit.

## Dependency

Run after Ticket 1 so package scope is established before sampling implementations.
