# Terminal Environment

`terminal-environment` exposes exactly one `workspace` tool when Pi is running inside a validated tmux environment. It keeps the existing `spawn`, `run`, `send`, `wait`, and `close` actions. Raw target-based operations remain available for compatibility; managed operations add UUID correlation without changing those raw semantics.

## Vocabulary

- **Agent Run** — one coding-agent process in a tmux Target.
- **Run ID** — authoritative UUID for an Agent Run; tmux target IDs remain diagnostics.
- **Work Cycle** — one managed task on an idle Agent Run, identified by a new `workId` and delivery UUID.
- **Result Received** — the worker result is durably stored and correlated.
- **Work Finished** — verified Pi lifecycle observed the worker turn finish; it is recorded separately from Result Received.

Result Received and Work Finished are separate facts. A raw inbox signal is only a cooperative source-pane notification and never means Work Finished.

## Spawn and Run

Raw spawn still creates detached tmux sessions, windows, or panes and returns native `$session`, `@window`, and `%pane` IDs.

```json
{ "action": "spawn", "spawn": {} }
```

Run starts a fresh interactive Pi, Codex, Claude, or OpenCode process without an initial prompt or user-supplied arbitrary CLI arguments. Managed Pi launches add only the package's controlled extension path so the child can validate its private launch context:

```json
{
  "action": "run",
  "run": { "agent": "pi", "model": "openai/gpt", "thinking": "high", "cwd": "." }
}
```

Every successful run returns a UUID `runId`, tmux target diagnostics, durable persistence, and process-started capability. Pi launch context is validated against the tmux server, target identity, run token, current pane, selected model, and resolved provider authentication. Pi readiness reports effective model, thinking level, and session metadata through the shared coordination ledger using bounded polling. Only verified Pi runs accept managed Work Cycles; Codex, Claude, and OpenCode retain UUID/process-started persistence and raw target operations but never claim verified Work Finished.

## Managed task / result / wait

The controller sends a task through the existing send action. The target is resolved from the Run ID, so no target ID is supplied:

```json
{
  "action": "send",
  "send": {
    "kind": "task",
    "runId": "<run UUID>",
    "input": "prompt",
    "text": "Review the authentication module literally."
  }
}
```

One Agent Run can have only one active Work Cycle. A completed Work Cycle leaves the Pi process, tmux pane/window, Agent Run, and internal bridge open; a later task gets a new `workId` without resume.

A verified Pi worker uses the same workspace send action:

```json
{
  "action": "send",
  "send": {
    "kind": "result",
    "outcome": "completed",
    "text": "Tests pass; authentication review is complete."
  }
}
```

The worker supplies no `targetId`, `runId`, or `workId`. The controller wraps terminal transport in a private correlated envelope so Pi's TUI cannot trim the task or intercept it as a built-in command. The child input hook authenticates the launch before resolving or mutating the run, removes the envelope before prompt-template or skill expansion, binds the exact Work Cycle, and passes the original task text onward. Protocol guidance is injected privately into the worker's Pi system prompt. Rejected input, shutdown, readiness revocation, and target loss are reported as interruptions without inventing Work Finished. Result text goes into the shared per-tmux-instance durable ledger and is never pasted into the controller terminal. The result send terminates the current Pi turn only; it does not close Pi, tmux, or the run.

The controller waits for both durable facts:

```json
{
  "action": "wait",
  "wait": { "runId": "<run UUID>", "workId": "<work UUID>", "timeoutMs": 120000 }
}
```

Managed wait returns the exact correlated result text, explicit outcome, delivery/result timestamps, effective session metadata, and the separate Result Received / Work Finished state. Work Finished without Result Received returns a protocol failure instead of inventing an outcome. An interrupted, rejected, or lost Work Cycle explicitly reports that Work Finished was not observed while retaining any previously received result. Fast results are retained before wait starts, and unrelated target sends cannot satisfy it.

## Raw compatibility

Raw send remains literal bracketed paste and writes a source-pane inbox signal:

```json
{
  "action": "send",
  "send": { "targetId": "%13", "input": "prompt", "text": "# Task\n\nReview this." }
}
```

Raw send reserves a delivery UUID before paste, then commits its inbox signal only after transport succeeds. Pending or uncertain deliveries do not wake raw wait. If transport was attempted but its outcome cannot be committed, the error identifies `delivery_uncertain` and its delivery ID so callers do not blindly retry and duplicate input. Raw wait remains target/sequence based and returns the next committed signal from its selected inbox. Use the send result's `replyAfterSequence` to avoid missing a fast raw signal. Raw close still accepts `%pane` or `@window` and rejects `$session`.

## Close

Only explicit close closes a successfully launched managed run:

```json
{ "action": "close", "close": { "runId": "<run UUID>" } }
```

Managed close validates run ownership, tmux server identity, and the recorded target/runtime identity before closing the run's pane. Stale, reused, interrupted, or otherwise uncertain close targets are marked lost and are never blindly killed again. A new run never retires a live run that owns the same target; close or mark the old run lost first. Raw target close retains its hierarchy protection and rejects panes or windows owned by an open Agent Run, which must be closed by `runId`.

## Persistence and safety

The shared coordination ledger is per tmux server instance under the user's private cache root. It uses owner-only directories/files, lock ownership, atomic writes, full post-transition validation, bounded payloads, authenticated destructive transitions, UUID correlation, idempotent result/finish facts, and bounded retention of historical runs/Work Cycles. Validated custom snapshots are written for parent and worker sessions, restored only from the active branch, and reconciled against exact live tmux identity/runtime; the ledger remains runtime authority and launch tokens are never stored in Pi session details. Existing v1 source-only signal files continue to support raw operations.

## TUI

Workspace rows distinguish Agent Run, Work Cycle, Result Received, Work Finished, outcomes, and raw inbox signals. Expanded managed waits show correlated result text and metadata; managed results never render as terminal input delivery. Requests, target diagnostics, result text, and errors are sanitized before display and tool output remains bounded.

## Activation

The tool is registered only when `TMUX` is present, Herdr/cmux guards are absent, and tmux returns a valid current socket/server/session/window/pane identity. All tmux commands use that validated server instance.

## Validation

```bash
bun install
bun run check
```

For a manual smoke test, start Pi inside tmux:

```bash
pi -e .
```
