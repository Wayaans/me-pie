# Quote-of-the-day Ticket Flow test specification

## Problem Statement

The existing Ticket Flow fixture is read-only, so workers cannot satisfy the implementation close gate that requires a new commit. It also keeps a non-numbered Markdown specification beside numbered ticket files, which makes that directory invalid as a Ticket Flow ticket source.

The fixture needs the smallest real implementation task that can exercise worker delegation, committed changes, ticket completion, sequential progression, and final audit without touching application code.

## Solution

Use five numbered implementation tickets. Each ticket adds one quote-of-the-day Markdown file at `docs/quotes/<name>/quote.md`, where `<name>` is assigned by that ticket. A quote may be funny, serious, original, or attributed, but the file must contain exactly one non-empty Markdown blockquote and no other content except surrounding whitespace.

Each worker also checks its ticket's single acceptance checkbox, commits the new quote file and updated ticket together, and reports the exact commit introduced by its assignment. Ticket Flow then closes the assignment and advances through the five-ticket chain before running its normal final audit.

The specification remains outside the selected ticket directory and is supplied to workers as a reference file.

## User Stories

1. As a fixture maintainer, I want every ticket to make a tiny repository change, so that Ticket Flow can exercise its implementation close gate.
2. As a fixture maintainer, I want each ticket to create exactly one new quote file, so that the work remains easy to inspect and understand.
3. As a fixture maintainer, I want quote files stored in separate named collections, so that parallel concepts do not overwrite one another.
4. As a worker, I want freedom to choose any suitable quote, so that completing a ticket requires no research or product knowledge.
5. As a worker, I want one objective content rule, so that I can determine completion without clarification.
6. As a worker, I want one acceptance checkbox, so that marking the canonical ticket complete is unambiguous.
7. As the Ticket Flow coordinator, I want each worker to create a new commit, so that commit verification can accept and advance the assignment.
8. As the Ticket Flow coordinator, I want numbered tickets in a dedicated directory, so that ticket discovery sees only valid tickets.
9. As the workflow operator, I want five sequential assignments, so that repeated delegate, send, wait, and close transitions are exercised.
10. As the workflow operator, I want each ticket to declare its predecessor, so that the intended test order is visible in the fixture.
11. As an auditor, I want every acceptance criterion to name its quote collection, so that requirement verdicts are unique and traceable.
12. As an auditor, I want externally observable file-content requirements, so that the completed commits can be verified without relying on worker claims.
13. As a repository maintainer, I want the fixture limited to documentation files, so that a smoke test cannot affect runtime behavior.
14. As the workflow operator, I want a final clean audit, so that successful completion demonstrates the full Ticket Flow lifecycle.

## Implementation Decisions

- The fixture contains five consecutively numbered ticket files in a dedicated nested ticket directory.
- The specification is passed as a reference and is not placed in the directory selected for ticket discovery.
- The assigned quote collection names, in order, are `sunrise`, `coffee`, `debugging`, `moon`, and `weekend`.
- Each ticket creates exactly one new output file. Updating the existing ticket checkbox is an additional required change, not an additional created file.
- Every output file uses the common name `quote.md` inside its assigned collection.
- A valid quote file contains exactly one non-empty Markdown blockquote and no other content except surrounding whitespace.
- Attribution is optional and may be included inside the blockquote. Quote uniqueness and authorship verification are not required.
- Each ticket has exactly one uniquely worded Markdown acceptance checkbox.
- The tickets declare a linear blocking chain from the first ticket through the fifth. Ticket Flow's numeric processing remains the mechanism that enforces execution order.
- Workers own implementation commits and must include both the quote file and checked ticket in the assignment commit.
- No application source, package metadata, generated output, or dependency state is changed.

## Testing Decisions

- Test at the highest available seam: run the real Ticket Flow workflow and inspect its externally observable committed repository state and final audit result.
- A good test verifies the new quote file, its exact blockquote-only content contract, the checked canonical ticket requirement, the accepted commit, and progression to the next ticket. It does not test worker reasoning or Ticket Flow internals.
- Each implementation close should demonstrate that the worker reported the complete new commit history for its assignment, current HEAD is included, the worktree is clean, and the ticket checkbox is checked.
- The final audit should produce exactly one evidence-backed verdict for each of the five canonical ticket requirements and audit the exact accepted commit set.
- The completed fixture should leave five quote files in five named collections and all five ticket checkboxes checked.
- No package scripts are needed to validate quote content. The final audit can verify it through bounded reads of the committed Markdown files.
- Prior art is the real disposable Git-backed smoke test described by the Ticket Flow extension documentation; this fixture supplies the small implementation workload for that seam.

## Out of Scope

- Testing quote quality, originality, factual attribution, or uniqueness.
- Adding a quote application, renderer, index, navigation, schema, or automation.
- Modifying extension code, tests, package configuration, dependencies, prompts, skills, or themes.
- Exercising blocked reports, worker recovery, pause, abort, resume, cancellation, audit findings, or fixer loops.
- Running tickets concurrently or validating a dependency-graph scheduler.
- Reusing the fixture after completion without first resetting its commits and unchecked ticket state.

## Further Notes

Start the smoke test from a clean worktree on a named branch inside tmux. Select `docs/scratch/test-workflow/tickets/` as the Tickets directory and add `docs/scratch/test-workflow/spec.md` as a reference path.

The linear `Blocked by` declarations document the chosen scenario, but current Ticket Flow execution is determined by consecutive numeric filenames. A successful run ends only after all implementation assignments close and the fresh read-only audit reports no findings.
