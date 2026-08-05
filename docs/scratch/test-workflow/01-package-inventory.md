# Ticket 1: Package inventory

## Objective

Create a read-only inventory of the repository's package identity and distributed Pi resources.

## Requirements

1. Read `package.json` and report the package name, version, package type, package manager, and engine constraints.
2. Report every top-level resource path or glob that the package exposes to Pi.
3. Count the immediate extension, skill, prompt, and theme packages using bounded file discovery.
4. Cite repository paths and line ranges for every metadata claim.

## Constraints

Follow all read-only and reporting rules in `spec.md`. Do not modify the repository or create a commit.

## Dependency

None. This is the first ticket.
