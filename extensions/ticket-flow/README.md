# Ticket Flow

Ticket Flow runs an ordered implementation plan with one normal Pi worker at a time:

```text
Pi orchestrator → tmux window → interactive Pi worker
```

The orchestrator plans, delegates, reviews structured reports, records completion, and advances the run. The worker owns implementation and validation. Workflow state is stored outside the repository.

## Requirements

- Pi
- tmux, with the orchestrator started inside an active tmux client
- Bun only for Mepie development and tests

Load this checkout for local use with `pi -e .`.

## Start a run

Run the command in Pi's TUI:

```text
/ticket-flow tmux <free-form prompt>
```

Include ticket/specification locations and an exact `provider/model` plus thinking level for every item. Ticket Flow never falls back to Pi's saved model or thinking setting.

```text
/ticket-flow tmux Implement the tickets under @docs/tickets using @docs/spec.md.
Determine order from their contents, not filenames. Use openai-codex/gpt-5.6-sol
with high thinking. Delegate each item with:
/implement this ticket {ticket} using {specs}
```

A prompt may define a default profile and per-item overrides:

```text
/ticket-flow tmux Implement @planning/auth using @planning/auth-spec.md.
Use openai-codex/gpt-5.6-sol with high thinking by default.
For the migration item use openai-codex/gpt-5.6-terra with medium thinking.
Use ledger-only completion.
```

Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Planning remains blocked if an item lacks an exact model or thinking level.

## Delegation and `/implement`

Each normalized work item stores one exact delegation prompt. Templates may use material such as ticket paths, specification paths, requirements, user answers, the item ID, and title. A prompt beginning with `/implement` is sent through normal Pi input processing in the worker, so prompt expansion, skills, project instructions, permissions, and ordinary tools still apply.

The worker receives one item only and remains a normal interactive Pi session. Ticket Flow does not restrict its implementation tools.

## Tools and roles

The orchestrator exposes:

- `workflow_plan` — save, update, validate, and finalize the normalized plan.
- `workflow_worker` — start, wait for, inspect, message, or close the owned worker.
- `workflow_review_report` — inspect, accept, revise, or block a report.
- `workflow_control` — inspect status, pause, resume, stop, or recover.

The worker exposes:

- `workflow_context` — retrieve authoritative item context or wait for feedback.
- `workflow_submit_report` — submit progress, completion, blocker, or failure reports.

Orchestrator implementation tools are restricted while a run is active. Worker implementation tools remain available. The orchestrator reviews report contents; it does not inspect or fix implementation code.

## State and Git isolation

Ticket Flow stores metadata under Pi's global agent directory:

```text
<agent-dir>/state/ticket-flow/<project-hash>/<run-id>/
├── state.json
├── plan.json
├── events.jsonl
└── reports/
```

`<agent-dir>` is `getAgentDir()` and follows `PI_CODING_AGENT_DIR` when configured. The project hash is derived from the canonical project path. Directories use owner-only `0700` permissions and files use `0600`.

No `.mepie`, workflow ledger, socket, or generated ignore rule is written to the project. Only an explicitly selected project-mutating completion strategy may change project files.

## Completion strategies

`ledger-only` is the default and records completion only in global state. Explicit alternatives are:

- append a completion entry to Markdown;
- update a frontmatter field;
- rename a file;
- move a file.

Project-mutating strategies are applied by the controller after report acceptance. Targets must remain inside the canonical project path. Repeated recovery is idempotent.

## Pause, resume, stop, and recover

- **Pause** stops automatic progression but preserves the worker and its tmux window.
- **Resume** verifies persisted tmux ownership and worker identity before continuing.
- **Stop** requests graceful worker shutdown, closes only a verified owned window, marks the run stopped, and releases the project lock.
- **Recover** reloads an unfinished global run, recreates its socket, and reconnects the same worker. It never creates a duplicate when identity is uncertain.

Use `workflow_control` with `status`, `pause`, `resume`, `stop`, or `recover`. Stopping an active worker requires interactive confirmation. Reloading or shutting down the orchestrator preserves an active worker for later recovery.

If recovery finds a missing, reused, foreign, or ambiguous tmux identity, the run stays paused. Choose whether to leave it paused or stop safely; Ticket Flow will not close an unverified window.

## Troubleshooting

### Model or thinking mismatch

Delegation is withheld when the worker's actual provider, model, or thinking level differs from the requested profile. This includes Pi clamping the thinking level. Inspect `workflow_control status`, close or stop the mismatched worker safely, verify that the requested profile is available, then start or recover with an exact supported profile.

### Stale or ambiguous lock

A lock prevents two orchestrators from controlling the same project. Dead owners with matching durable identity can be taken over and the takeover is logged. Corrupt or ambiguous ownership requires explicit interactive approval. Do not delete a lock while another Pi session may still own it.

### Missing or reused tmux window

Recovery pauses when the recorded stable window/pane IDs are missing or belong to another window. A durable report remains reviewable if it was persisted before the worker exited. Otherwise stop safely or resolve the worker manually; Ticket Flow never closes a window by display name alone.

### Inspect or delete completed runs

1. Run `workflow_control status` before completion if you need the run ID and project hash.
2. Stop or complete the run and confirm no Ticket Flow orchestrator still owns the project.
3. Inspect `<agent-dir>/state/ticket-flow/<project-hash>/<run-id>/` directly. Reports and events are ordinary owner-only JSON/JSONL files.
4. Delete only the selected completed or stopped `<run-id>` directory. Do not delete the project hash directory or lock while a run is active.

Changing `PI_CODING_AGENT_DIR` changes which state root Pi can discover.

## Development validation

Default tests use isolated temporary state, deterministic clock/ID inputs, and fake tmux controllers; native transport integration stays local. They do not require a live tmux server or model credentials.

```bash
bun install
bun run check
```

In the source checkout, follow `docs/scratch/ticket-flow/tmux-smoke.md` for the opt-in live procedure in a disposable repository. Paid model calls are never part of `bun test`.
