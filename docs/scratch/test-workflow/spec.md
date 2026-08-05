# Read-only Ticket Flow test specification

## Purpose

Exercise Ticket Flow planning, dependency ordering, worker startup, native reporting, report review, and sequential progression without changing repository contents.

This fixture intentionally tests an unsupported terminal path in a Git checkout: implementation-ticket acceptance requires a new authenticated commit, while every ticket below forbids commits. Workers should still finish their inspections and submit valid completed reports, but Main should be unable to accept them. Stop the run after confirming that acceptance is rejected.

## Global constraints

Every ticket must follow these rules:

1. Treat the entire repository as read-only.
2. Do not edit, create, delete, rename, or format files.
3. Do not run commands that can mutate files, dependencies, Git state, caches, or generated output.
4. Do not create commits, including empty commits, and do not include `commitIds` in the report.
5. Use only bounded file discovery, file reading, and content searches.
6. Do not run package scripts, installers, formatters, linters, tests, or build commands.
7. Submit findings only through the Ticket Flow worker report.

## Completed-report contract

For each planned requirement, provide exactly one requirement result with specific path-and-line evidence. Also provide:

- `filesChanged: []`;
- `filesChangedExplanation`: state that the ticket is intentionally read-only;
- at least one read-only validation check, such as a bounded file read or content search;
- empty `blockers` and `caveats` when none exist;
- no `commitIds`.

If evidence is unavailable, report that fact accurately rather than modifying the repository or inventing evidence.
