# Stage 6: Review and automatic progression

## Objective

Complete orchestrator worker control, report review, completion recording, report-revision feedback, graceful worker shutdown, and sequential advancement through the finalized plan.

## Deliverables

Complete:

```text
controller.ts
orchestrator/tools.ts
completion.ts
```

Add a coordinator that serializes all progression decisions for one run.

## `workflow_worker`

Implement all actions:

- `delegate`
- `wait`
- `read`
- `send`
- `close`

`delegate` may target only the next ready item selected from the finalized plan. It creates one tmux worker, verifies identity/profile, sends the stored prompt, and transitions the item to `running`. Reject delegation when another item is active.

`wait` returns the next matching native event and streams compact status updates. Timeouts do not imply failure or completion.

`read` uses bounded `tmux capture-pane` output for human observation and diagnostics only. It is never the source of report truth.

`send` delivers a native feedback message. Do not use tmux input.

`close` requests graceful Pi shutdown, waits with a timeout, and closes only the persisted owned window.

## `workflow_review_report`

Implement:

- `inspect`
- `accept`
- `revise`
- `block`

`inspect` returns the latest immutable report attempt and the planned requirements.

`accept` requires an item in `report-review`, a valid completed report, and an orchestrator comment. It must not inspect code or run tests. In one serialized operation:

1. Mark the report attempt accepted.
2. Record the comment and completion metadata.
3. Apply the configured completion strategy.
4. Transition the item to `completed`.
5. Gracefully stop and close the worker.
6. Determine the next dependency-ready item.
7. Delegate it automatically, or complete the run when none remain.

Make recovery safe if interruption occurs between these steps by persisting checkpoints/events before external side effects.

`revise` records feedback and missing requirements, changes the item to `report-revision`, and sends feedback to the same worker session. The worker returns to `running` until another report arrives.

`block` persists a blocker and pauses the run. If questions are supplied, the orchestrator uses `ask_me`, records answers through plan/control state, and sends them to the same worker before resuming.

## Completion strategies

Implement `ledger-only` first and make it the default. It records completion entirely in global state.

Add project-mutating strategies only when explicitly present in the finalized plan:

- Append a Markdown completion block
- Update a known frontmatter field
- Rename a ticket file
- Move a ticket file

Validate paths against the trusted project and use Pi’s file mutation queue for edits. Never infer a source-file mutation after finalization. The worker never applies completion changes.

## Sequential coordinator

Use a mutex/semaphore or equivalent serialized Effect workflow so report acceptance, socket events, stop requests, and retries cannot start two workers.

The next item is selected by finalized order among items whose dependencies are completed. Do not skip a blocked earlier item unless the plan is explicitly updated.

## Orchestrator continuation

After delegation, guide the orchestrator to call `workflow_worker wait`. When a report arrives, its tool result should include the report and planned requirements so the next model turn can inspect or review it.

Acceptance automatically advances the controller, then returns the newly active item or final summary. This preserves AFK execution without asking the user between normal tickets.

## Tests

Cover:

- Only one active worker
- Next-ready item selection
- Dependency gating
- Report inspection
- Acceptance requiring a comment
- Acceptance without code auditing
- Revision feedback to the same session
- Repeated report attempts
- Block and user-answer resume
- Ledger-only completion
- Explicit project-file completion strategies
- Interruption checkpoints around completion
- Automatic next delegation
- Final run completion and tool restoration

## Acceptance criteria

- A finalized plan runs one item at a time without normal user intervention.
- Incomplete reports can be revised in the same worker session.
- Accepted reports produce comments and durable completion records.
- The next dependency-ready item starts automatically.
- The orchestrator never needs implementation tools.
- `bun run check` passes.
