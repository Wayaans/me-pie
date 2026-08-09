# Mepie

Mepie packages Pi extensions and agent resources.

## Terminal environment terminology

The active terminal multiplexer that owns addressable terminal targets.
Avoid **Backend** in user-visible terminal behavior.

**Target**
One addressable terminal object, such as a tmux session, window, or pane. Use **target** only for raw target-based operations and diagnostics.

**Agent Run**
One coding-agent process launched in a Target. Every Agent Run has an authoritative UUID **Run ID** and retains its tmux target identity for diagnostics and safe ownership checks.

**Work Cycle**
One managed task delivered to an idle Agent Run. A Run ID can receive another Work Cycle after the previous one is complete; each Work Cycle has a new UUID **workId** and delivery UUID.

**Result Received**
The managed worker's explicit `workspace send` result was durably correlated to a Run ID and Work Cycle. This is not completion by itself.

**Work Finished**
The verified Pi lifecycle observed the worker turn finish for the bound Work Cycle. Result Received and Work Finished are independent durable facts; either may be observed first. Only Pi's settled lifecycle event establishes Work Finished; shutdown, rejection, readiness loss, and target loss do not.

**Work Interruption**
A Work Cycle ended without verified Work Finished because input was rejected, readiness was revoked, the session shut down, or the target was lost. A durably received result remains available but does not convert the interruption into Work Finished.

**Delivery**
One literal prompt or command successfully sent to a raw Target, or one managed task delivery resolved from a Run ID.

**Raw inbox signal**
A backwards-compatible, sequenced source-pane notification committed after a raw Delivery. A pending or uncertain raw delivery never wakes raw wait. Raw wait observes committed signals only; it does not claim Work Finished.

## Managed workflow

1. `workspace run` launches a fresh Agent Run and returns its UUID Run ID plus tmux target diagnostics. Pi runs wait for bounded verified readiness and effective model/thinking/session metadata. Codex, Claude, and OpenCode runs are persisted as process-started or unverified capabilities and never claim verified Work Finished.
2. A controller uses the same `workspace send` action with `kind: "task"`, `runId`, `input`, and literal `text` only for a verified Pi Run. The target is resolved internally and the action creates one Work Cycle (`workId`) and delivery UUID. Only one Work Cycle may be active per Agent Run; non-Pi runs retain UUID/raw operations but reject managed tasks.
3. A verified Pi worker receives private run-specific guidance through its launch context/system prompt. It reports with the same `workspace send` action using `kind: "result"`, explicit `outcome` (`completed`, `blocked`, or `failed`), and `text`; it supplies no target ID, Run ID, or Work Cycle ID. Result text is written to the shared durable coordination ledger and is not pasted into the controller terminal.
4. The controller uses managed `workspace wait` with `runId` and optional `workId`. It returns the exact correlated result text/outcome/metadata only after both Result Received and Work Finished. A Work Finished fact without Result Received returns an explicit protocol failure; an interruption reports that verified Work Finished was not observed and preserves any Result Received text. Fast replies and unrelated raw sends cannot satisfy another Work Cycle.
5. A completed or failed Work Cycle leaves the successfully launched Pi process, tmux pane/window, Agent Run, and internal bridge open. The same Run ID can receive another task with a new Work Cycle without resume. Only explicit `workspace close` with `runId` closes that run. Raw target-based send/wait/close calls remain supported for compatibility.
