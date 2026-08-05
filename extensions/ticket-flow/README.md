# Ticket Flow

Ticket Flow is an explicit, crash-safe workflow for ordered implementation tickets, fresh audits, and audit fixes:

```text
Main → workflow_delegate → owned tmux Pi worker → authenticated Unix socket
```

Main plans and reviews reports; workers implement or perform read-only audits. A completed implementation plan is **not** complete until a fresh clean audit is accepted.

## Start and controls

Run inside Pi TUI and an active tmux client:

```text
/ticket-flow tmux <free-form prompt>
/ticket-flow status
/ticket-flow pause
/ticket-flow resume
/ticket-flow stop
```

`tmux <prompt>` is the only start syntax. User controls do not require a new worker. `status` toggles the task-list widget in the current Pi session; the session that starts a run shows it automatically, while other sessions keep it hidden until their first `status` invocation. `pause`, `resume`, and `stop` discover and safely attach a detached durable run when needed without changing widget visibility. Stop confirms before closing an owned active worker. Recovery never creates a duplicate worker. Command arguments autocomplete in the Pi editor.

## Main tools

Only these tools are active while an owned run exists:

- `workflow_plan` — `get`, `save`, or typed `update`. Save a complete normalized plan and set `finalized: true` only after all clarification questions, exact profiles, dependencies, and completion mutations are resolved. Put an explicit `auditProfile` in the plan; there is no audit-model fallback.
- `workflow_delegate` — `start`, `wait`, `send`, `accept`, `revise`, or `close`. Progression is explicit: accepting a ticket never starts the next worker.

Default tool rows use the same compact tool-plus-command form as `workflow-worker` (for example, `workflow-plan · save` and `workflow-delegate · start`). Full run/plan state is in tool `details` and the owner-only `plan.json` snapshot.

`workflow_delegate start` is one recoverable transaction. It persists checkpoints while it creates the owned tmux window, launches Pi, verifies the exact provider/model/thinking profile, authenticates the native connection, and delivers the exact planned prompt. Visible substep updates are emitted while the transaction runs. A failed or cancelled substep pauses safely for recovery. Main keeps scheduling bounded continuation turns while durable state changes and the run remains actionable, so finalizing a plan cannot silently end the workflow; it stops only for completion, failure, pause, or a genuine user decision.

## Worker tool

A worker process exposes exactly one workflow tool:

- `workflow_worker get` — retrieve authoritative context;
- `workflow_worker send` — send a question to Main; blocking sends keep the authenticated socket open until Main replies (use `workflow_delegate send` for the reply), with cancellation and a bounded timeout;
- `workflow_worker submit` — send progress, blocker, failure, implementation, or audit reports.

A blocking question first appears as a blocked worker event (`workflow_delegate wait --until blocked`); Main replies with `workflow_delegate send` without restarting the worker. Audit workers receive only structured read, search, and listing tools; raw shell execution is unavailable because shell expansion, PATH helpers, and command flags cannot provide a reliable read-only guarantee. Implementation and fix workers retain normal Pi implementation tools.

## Widget

A bordered task-list widget can remain above the editor while a run is active or recoverable. Its title reports each live step—planning, ticket analysis, plan updates/finalization, delegation, worker verification, report review, audit, audit fixes, and finalization. It also shows compact item statuses, an animated current-step marker, current model/thinking, tmux stable display/window/pane IDs, clarification blockers, and audit/fix rounds. Widget visibility is session-local: a newly started run is shown in its starting session, recoverable runs stay hidden in other sessions, and `/ticket-flow status` toggles show/hide for the current session. Stopped, completed, and no-run states clear it.

## Durable state and ownership

All authoritative runtime data is in the owner-only global `plan.json`:

```text
<agent-dir>/state/ticket-flow/<project-hash>/<run-id>/
├── plan.json       # complete run/plan snapshot and checkpoints
├── state.json      # non-authoritative legacy pointer only
├── events.jsonl
└── reports/
```

The snapshot includes the original prompt, ticket/spec paths, exact profiles and prompts, stable tmux IDs, Pi identities, attempts/history/report references, timestamps, plan-approved completion targets, completion checkpoints, Git baseline/current head/accepted commits (including dedicated completion commits), audit rounds/findings/fix links, and final state. Authentication tokens remain in a separate owner-only file and are never stored in plan, events, or reports. Ambiguous journal appends remain pending and are reconciled by event ID during recovery.

A project lock, authenticated native protocol, stable tmux ownership tags, immutable report files, cancellation, and idempotent recovery protect against duplicate or foreign workers. Workflow tools are guarded both by dynamic activation and at execution time; prior active tools are restored conservatively when the run ends.

## Git policy

For a Git checkout, Ticket Flow requires a clean preflight and records the baseline. It creates and switches to `mepie/ticket-flow/<run-id>` only when the starting branch is exactly `main`; from every other branch it preserves and uses the current branch without creating or switching branches. Implementation/fix reports identify their commits; accepted commit IDs are persisted. Plan-driven completion mutations are staged only by their exact declared paths and committed with a deterministic `mepie(ticket-flow): record completion …` subject; unrelated staged or changed paths abort the transaction. Ledger-only completion creates no commit. Audits use only the persisted accepted commit set and never claim to audit uncommitted changes. Fix workers may modify the checkout and must report their implementation commits; only audit workers are read-only.

## Completion mutations

Every mutation is plan-driven, previewable in the durable strategy, and idempotent:

- `ledger-only`;
- exact `text-replacement`;
- `markdown-checkbox`;
- `frontmatter`;
- `append`/`append-markdown`;
- `rename-file` or `move-file`.

Every non-ledger target must be one of the item's declared ticket/source/specification paths or an explicit `completionTargets` path approved during planning. Targets are canonicalized inside the trusted checkout, `.git`/repository-control paths, symlinks, and multiply-linked files are refused, and mutations use the same file-mutation queue as Pi's built-in edit/write tools.

## Audit and fixes

After implementation items are accepted, Ticket Flow creates a fresh read-only audit item. Its prompt is immutable and exactly the approved template, substituting only feature name, accepted commit IDs/range, ticket path, and spec path. Audit reports contain requirement verdicts, file-level evidence, and findings. Findings schedule a fix item, then a fresh audit. A clean audit permits terminal completion. The same unresolved finding twice without changed evidence pauses for the user.

## Development

Use Bun only:

```bash
bun install
bun run check
```

Tests use isolated state, deterministic clocks/IDs, fake tmux, authenticated native sockets, Git completion commits (including rename paths and recovery boundaries), injected append write/sync/close failures, widget width assertions, explicit sequential progression, audit/fix rounds, immutable-report/plan-forgery checks, and recovery ownership scenarios. No model credentials or paid calls are needed.
