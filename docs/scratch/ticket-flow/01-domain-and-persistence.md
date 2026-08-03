# Stage 1: Domain and persistence

## Objective

Define the workflow model, legal state transitions, global storage layout, schema versioning, atomic persistence, and project-level locking. This stage must work without Pi UI, tmux, or sockets.

## Deliverables

Create the initial modules under `extensions/ticket-flow/`:

```text
domain.ts
schemas.ts
paths.ts
state-machine.ts
state-store.ts
event-store.ts
lock.ts
errors.ts
```

Add focused tests under `extensions/test/`.

## Domain model

Define immutable, serializable types for:

- `WorkflowRun`
- `WorkflowPlan`
- `WorkItem`
- `PiLaunchProfile`
- `UserResolution`
- `CompletionStrategy`
- `WorkerIdentity`
- `WorkerReport`
- `RunPhase`
- `WorkItemStatus`

Use stable string IDs. Generate a random run ID and let the orchestrator assign readable work-item IDs. Reject duplicate work-item IDs.

A launch profile must contain an exact `provider/model` identifier and an explicit thinking level. Missing values are validation failures, not defaults.

Represent ticket requirements as orchestrator-derived text. Do not introduce a ticket-file parser or ticket schema.

## State transitions

Centralize transitions in pure functions. At minimum, model:

```text
Run: analyzing → awaiting-user → ready → executing → completed
Run: any active phase → paused | failed | stopped

Item: planned → ready → spawning → verifying-worker → running
Item: running → report-pending → report-review → completed
Item: report-review → report-revision → running
Item: running → blocked | failed | interrupted
```

Reject illegal transitions with typed errors. Retrying the same already-applied transition should be idempotent where recovery can repeat an operation.

Validate plan invariants:

- Work-item IDs are unique.
- Order values are deterministic.
- Dependencies reference existing items.
- The dependency graph has no cycle.
- Completed dependencies precede a ready item.
- Every finalized item has requirements, a delegation prompt, model, thinking level, and completion strategy.
- Only one item may occupy an active worker state.

## Global paths

Resolve storage from `getAgentDir()`:

```text
<agent-dir>/state/ticket-flow/<project-id>/<run-id>/
```

Derive `project-id` from SHA-256 of the canonical project path. Store the readable canonical path in run metadata. Do not write workflow metadata into the repository.

Use:

- Directory mode `0700`
- File mode `0600`
- `state.json` for the latest snapshot
- `plan.json` for the normalized plan
- `events.jsonl` for append-only events
- `reports/` for report attempts and accepted reports

## Persistence

Define schemas with an explicit version field. Decode unknown JSON before use and return typed corruption/version errors.

Implement atomic snapshot writes:

1. Serialize deterministically.
2. Write a sibling temporary file with mode `0600`.
3. Flush and close it.
4. Rename it over the destination.
5. Clean temporary files on interruption.

Append one bounded JSON object per line to `events.jsonl`. Include event ID, timestamp, run ID, event type, and transition-specific data. Never place raw model credentials in state or events.

## Locking

Use an atomic lock directory or exclusive lock file scoped to the canonical project. Persist owner metadata: run ID, PID, session ID when available, and creation time.

Stage 1 should detect contention but must not automatically steal stale locks. Recovery policy belongs to Stage 7.

## Effect boundaries

Model filesystem and clock dependencies as injectable services or narrow interfaces. Use Effect typed errors, scoped cleanup, and `Effect.runPromise` only at tests or future Pi handler boundaries.

## Tests

Cover:

- Stable project IDs for canonical paths
- Different IDs for different projects
- No project-local files
- Secure directory and file modes
- Schema round trips
- Unsupported schema versions
- Corrupt JSON
- Atomic replacement behavior
- JSONL append and replay
- Duplicate IDs
- Missing dependencies
- Dependency cycles
- Illegal and idempotent transitions
- Lock contention

## Acceptance criteria

- A valid run can be created, saved, loaded, and replayed.
- Corrupt or incompatible state fails with a typed error.
- Two controllers cannot acquire the same project lock.
- No implementation path points inside the project unless it is an explicit ticket completion target.
- `bun run check` passes.
