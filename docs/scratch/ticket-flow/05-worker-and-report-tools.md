# Stage 5: Worker and report tools

## Objective

Implement the two worker-role tools, define the structured report contract, persist report attempts, and expose native worker events to orchestrator waits.

## Deliverables

Add:

```text
worker/tools.ts
worker/context.ts
worker/report.ts
worker/renderers.ts
```

Complete the worker-side schemas in `schemas.ts` and transport mappings from Stage 4.

## `workflow_context`

Register only in worker role.

Actions:

- `get`
- `wait-for-feedback`

`get` returns the authoritative context bound to the connected worker:

- Run and work-item IDs
- Work-item title
- Ticket/source paths
- Specification paths
- Orchestrator-derived requirements
- User resolutions
- Exact delegation prompt
- Requested and actual model/thinking
- Expected report fields

Load this data from the authenticated orchestrator connection, not mutable worker-supplied environment alone. Bound and truncate large context while preserving paths and requirement text.

`wait-for-feedback` waits for acceptance, revision instructions, user answers, or shutdown. Respect `AbortSignal`; cancellation must not terminate Pi or the workflow.

## `workflow_submit_report`

Register only in worker role. Use one schema with statuses:

- `progress`
- `completed`
- `blocked`
- `failed`

Common fields:

```ts
status
summary
requirements?
filesChanged?
checks?
caveats?
blockers?
questions?
```

A completed report requires:

- Non-empty summary
- One result for every planned requirement, matched by stable requirement ID or exact normalized requirement reference
- Explicit result: `satisfied`, `not-satisfied`, or `not-applicable`
- Files changed, which may be empty only with explanation
- Validation checks, including `not-run` with a reason
- Caveats and blockers arrays

A blocked report requires a blocker and whether user intervention is needed. A failed report requires a useful failure summary. Progress may be compact and does not change the item into report review.

Throw validation and transport failures so Pi marks the tool result as an error.

## Report persistence

The orchestrator persists each final attempt globally:

```text
reports/<safe-item-id>-attempt-<n>.json
```

After acceptance, also persist an accepted snapshot or mark the accepted attempt in state. Use mode `0600` and atomic writes. Do not persist full terminal captures by default.

Include:

- Report schema version
- Attempt number
- Submission timestamp
- Worker session identity
- Requested and actual launch profiles
- Report body

Never allow the worker to choose the destination path.

## Native events

Translate submissions to protocol messages and run events:

- Progress → `worker-progress`
- Completed → `worker-report`
- Blocked → `worker-blocked`
- Failed → `worker-failed`

Wake matching `workflow_worker wait` calls. Preserve unconsumed final events so a report is not lost when no wait is currently active.

## Worker guidance

Add worker-specific prompt guidance only in worker role:

- Work on the delegated item only.
- Use normal tools and project instructions.
- Call `workflow_context` after context loss or uncertainty.
- Call `workflow_submit_report` for progress, blockers, failure, and final completion.
- Do not mark ticket files complete.
- Do not claim checks passed without running them.

Do not restrict active worker tools.

## Rendering

Provide compact tool renderers:

```text
workflow-context · get
workflow-report · progress
workflow-report · completed · 6/6 requirements
```

The visible label may say “workflow report,” but the actual unique tool name remains `workflow_submit_report`.

## Tests

Cover:

- Tools absent in orchestrator role and present in worker role
- Context identity and truncation
- Completed-report field requirements
- Missing or duplicate requirement results
- Blocked and failed validation
- Progress behavior
- Secure report filenames and modes
- Attempt numbering
- Event delivery when a waiter exists or arrives later
- Cancellation of feedback waits
- Transport failure surfaced as a tool error

## Acceptance criteria

- A normal Pi worker can retrieve authoritative context.
- It can submit progress, blocked, failed, and completed reports through one uniquely named tool.
- Reports are validated and persisted outside the project.
- The orchestrator can wait for and receive final reports without pane capture.
- Worker tools do not restrict normal implementation capabilities.
- `bun run check` passes.
