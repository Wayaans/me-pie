# Stage 7: Recovery and lifecycle control

**Status: Complete**

## Objective

Make workflows survive Pi reloads, orchestrator restarts, socket loss, and tmux detachment without duplicating workers or damaging unrelated windows. Complete pause, resume, stop, and recover behavior.

## Deliverables

Add or complete:

```text
recovery.ts
orchestrator/lifecycle.ts
worker/reconnect.ts
```

Complete `workflow_control` actions and session lifecycle handlers.

## Discovery of unfinished runs

On orchestrator `session_start`:

1. Compute the current project ID.
2. List globally persisted unfinished runs for that project.
3. Validate schemas before displaying them.
4. Inspect lock ownership without stealing it.
5. Notify the user when a recoverable run exists.

Do not automatically recover and control a run merely because state exists. Require `/ticket-flow` conflict handling or `workflow_control(action: "recover")` unless the same live session already owns it.

## Recovery reconciliation

Build a reconciliation function from three sources:

- Persisted workflow state
- Current tmux session/window/pane state
- Native worker socket/handshake state

Classify outcomes:

- Safe to resume
- Worker alive but disconnected
- Worker exited with pending report
- Window missing
- Profile mismatch
- Foreign/reused tmux ID
- Ambiguous

Resume only after verifying run ID, work-item ID, window ownership metadata, Pi session identity when available, and requested/actual model profile. Ambiguous state pauses and asks the user.

## Socket recovery

Recreate the runtime socket at the persisted path or update state atomically to a new short path. The worker reconnect loop must discover the current path through a stable owner-only rendezvous record under the global run directory, or the orchestrator must recreate the same path.

Authenticate every reconnection. Replace the old connection only when it belongs to the same worker session or after explicit reconciliation.

## `workflow_control`

### `pause`

- Stop automatic progression.
- Preserve the worker and tmux window.
- Continue persisting worker events.
- Do not send new delegation or feedback automatically.

### `resume`

- Require an owned paused run.
- Reconcile tmux and worker state.
- Resume the correct wait/review/delegation step.
- Never spawn a second worker for an already active item.

### `stop`

- Require confirmation through UI for an active worker.
- Send native graceful shutdown.
- Wait with a bounded timeout.
- Close only the verified owned tmux window.
- Mark the run stopped and release its lock.
- Preserve plan, events, and reports.

### `recover`

- Acquire or transfer a stale lock only after proving the previous owner is gone or receiving explicit user approval.
- Reconcile state.
- Restore orchestrator tool restrictions and status UI.
- Resume from the last durable checkpoint.

## Session lifecycle

`session_shutdown` must be idempotent.

For orchestrator quit/reload:

- Stop local listeners and fibers.
- Preserve the worker unless the user explicitly stopped the run.
- Leave durable state recoverable.

For worker quit:

- Send a final shutdown/disconnect event when possible.
- Close the client and retry fibers.
- Do not alter ticket completion state.

Do not rely on extension factory cleanup.

## Stale locks

Define a conservative stale-lock policy using PID liveness, run metadata, and session identity. PID reuse means PID checks alone are insufficient. If ownership cannot be proven stale, require user confirmation.

Record every lock takeover in `events.jsonl`.

## Tests

Cover a matrix of:

- Orchestrator reload while worker runs
- Orchestrator process exit and later recovery
- Worker reconnect after socket recreation
- Worker exit before report
- Worker exit after report but before acceptance
- Window missing
- Window ID reused by unrelated process
- Stale lock with dead owner
- Ambiguous lock ownership
- Pause and resume
- Graceful and forced stop
- Repeated shutdown handlers
- No duplicate worker creation

Use fake tmux and protocol services for deterministic unit tests. Add a bounded live smoke scenario separately.

## Acceptance criteria

- A running tmux worker survives orchestrator reload.
- Recovery never silently takes over ambiguous state.
- Recovery cannot close a foreign window or launch a duplicate worker.
- Pause, resume, stop, and recover have durable, idempotent behavior.
- Locks are released only by verified owners or explicit takeover.
- `bun run check` passes.
