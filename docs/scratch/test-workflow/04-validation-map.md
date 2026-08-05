# Ticket 4: Validation map

## Objective

Map the repository's declared validation commands to their package-script definitions without executing them.

## Requirements

1. Read validation guidance in `AGENTS.md` and list each required command.
2. Read `package.json` and map each referenced package script to its exact command body.
3. Identify which mapped commands appear to perform type checking, tests, formatting, or other validation based only on their declared command text.
4. Report any guidance command that has no matching script or cannot be resolved, with path-and-line evidence.

## Constraints

Follow all read-only and reporting rules in `spec.md`. Do not run the commands, install dependencies, modify files, or create a commit.

## Dependency

Run after Ticket 3 so the validation map follows the product-documentation inspection.
