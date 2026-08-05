# Ticket 3: Ticket Flow documentation check

## Objective

Verify that public documentation describes the Ticket Flow extension consistently.

## Requirements

1. Locate the Ticket Flow entry in the repository `README.md` and compare it with `extensions/ticket-flow/README.md`.
2. Verify that the start command syntax is stated consistently.
3. Verify that both documentation surfaces accurately distinguish implementation workers from read-only audit workers.
4. List any contradiction or ambiguity with path-and-line evidence; otherwise report that none was found in the inspected scope.

## Constraints

Follow all read-only and reporting rules in `spec.md`. Do not edit documentation or create a commit.

## Dependency

Run after Ticket 2 because it narrows the review from general extension conventions to Ticket Flow.
