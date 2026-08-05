# Ticket 5: Fixture integrity audit

## Objective

Perform a final read-only audit of this six-file test fixture.

## Requirements

1. Confirm that `docs/scratch/test-workflow/` contains exactly five numbered ticket files and one specification file.
2. Confirm that every ticket references `spec.md`, explicitly forbids repository changes and commits, and declares its dependency.
3. Verify that the dependency chain is acyclic and orders the tickets from 1 through 5.
4. Check that the specification explains the expected Git acceptance failure and the completed-report contract.
5. Report every discrepancy with path-and-line evidence; otherwise report that the fixture is internally consistent.

## Constraints

Follow all read-only and reporting rules in `spec.md`. Do not repair discrepancies, modify files, or create a commit.

## Dependency

Run after Tickets 1, 2, 3, and 4. This is the final ticket.
