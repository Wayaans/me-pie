# Ticket Flow

Ticket Flow coordinates numbered implementation tickets through one persistent Pi Worker at a time. It is deliberately sequential and explicit: Main delegates, sends, waits, and closes each Assignment before the cursor can move.

This version is a breaking replacement for the former planning workflow. It has no model-authored plan, dependency graph, `workflow_*` compatibility tools, event journal, or automatic continuation prompt.

## Requirements

- Pi TUI mode
- a functioning current tmux session
- a clean Git worktree on a named branch
- numbered Markdown ticket files (`01-name.md`, `02-name.md`, …)
- at least one Markdown task-list checkbox in every ticket

A ticket is complete only when every Markdown checkbox in that ticket is checked. Workers, not Main, own implementation commits and ticket marking.

## Commands

```text
/ticketflow tmux
/ticketflow herdr       # not supported yet
/ticketflow cmux        # not supported yet
/ticketflow status
/ticketflow pause
/ticketflow resume
/ticketflow stop
/ticketflow cancel      # confirmed stop alias
```

`/ticketflow tmux` opens a native Pi setup form for:

- Tickets directory, with `@` path autocomplete
- optional reference file paths, one per line, with `@` path autocomplete
- exact Worker `provider/model`
- explicit Worker thinking level
- immutable delegation prompt template

Supported delegation placeholders are:

```text
{ticketPath}
{ticketName}
{ticketIndex}
{ticketCount}
{referencePaths}
```

Ticket Flow replaces these placeholders only. The resulting task is sent to the Worker without any prefix or suffix. Setup rejects duplicate, missing, or ambiguous ticket numbers and displays the canonical order for confirmation before creating durable state.

## Tool roles

Main receives exactly these Ticket Flow tools while it owns a run:

| Tool | Responsibility |
| --- | --- |
| `ticketflow_delegate` | Spawn the durable next Assignment; do not send work. |
| `ticketflow_send` | Send the exact task, steering, answer, or follow-up. |
| `ticketflow_wait` | Wait for `agent_settled` and return the durable report. |
| `ticketflow_close` | Verify gates, advance the cursor, and close the owned Worker. |
| `ticketflow_resume` | Reopen and verify the exact persisted Pi session. |
| `ticketflow_abort` | Abort only the active turn while preserving the session. |

In the TUI, each tool uses compact pending, success, and failure states. `ticketflow_send` renders the delivered message as Markdown, while `ticketflow_wait` shows live elapsed time and renders the durable report as Markdown. `ticketflow_delegate` keeps the initial task out of its visible result; the task appears when `ticketflow_send` delivers it.

Workers receive only `ticketflow_report` from Ticket Flow. Implementation and fix Workers retain normal implementation tools. Audit Workers receive only `read`, `grep`, `find`, `ls`, `rg`, `fd`, and `ticketflow_report`; raw tools and `!`/`!!` user shell commands are blocked.

A report, `agent_settled`, completion acceptance, and tmux closure are separate durable facts. Cancelling `ticketflow_wait` stops only that wait; it never aborts the Worker. A blocked report settles one turn, after which Main may send an answer as a follow-up and wait again. A settled audit report remains follow-up eligible until `ticketflow_close` accepts it. If the close gate rejects its structure or evidence, Main sends correction instructions to the same Worker, waits for a replacement report, and retries close.

## Lifecycle

```text
implementation ticket
  delegate -> send exact task -> wait
    blocked -> send answer/follow-up -> wait
    failed or unreported -> user intervention
    completed -> close gate

all tickets complete
  fresh read-only audit
    clean -> completed
    findings -> fixer -> fresh audit
```

Only `ticketflow_close` advances the cursor. Exactly one Assignment and one Worker may be active. Only a clean audit can complete a run.

Implementation and fix close gates require:

- a durable completed report
- the same Worker turn at `agent_settled`
- new reported commits reachable from the current named branch, including exact HEAD
- a clean worktree
- for implementation, every checkbox in the canonical ticket checked

Audit launch and close require a clean worktree, exact accepted HEAD, and an exact accepted commit set. Audit reports must repeat that set exactly, give one verdict for every canonical ticket checkbox requirement, and cite verified in-project `path:line` evidence. Audit tasks use the immutable prompt from the redesign contract, with only its two placeholders substituted. Repeated identical findings without a new accepted commit pause the run.

## Pause, abort, resume, and stop

- **Pause** prevents new progression. A running Worker may finish its turn; the widget says “pausing after current worker.”
- **Abort** calls the Worker Pi context abort for the current turn, waits for settlement, and preserves the session.
- **Resume** restores progression and reopens the exact persisted Worker session when its process/window is gone. It never resends old work. If a process died at an ambiguous command boundary, Ticket Flow marks the turn interrupted, pauses, and requires an explicit resume plus follow-up rather than risking duplicate delivery.
- **Stop/cancel** terminally aborts when needed, closes only a fully verified owned tmux window, releases the project lock, and cancels the run.

## Durable state and recovery

Ticket Flow stores global owner-only state under Pi's agent directory:

```text
state/ticketflow/<project-sha256>/<run-id>/
├── run.json
├── reports/              # immutable identity-bound reports
└── .transport-token      # separate credential, never copied into JSON

state/ticketflow/<project-sha256>.lock/
└── owner.json
```

`run.json` is the only authoritative workflow snapshot. There is no `state.json`, `plan.json`, or authoritative event journal. Writes are atomic and owner-only. Reports are content-hashed, owner-only, and never overwritten.

Before creating tmux, the coordinator persists a launch intent. tmux windows are tagged with run, Assignment, and operation IDs. Recovery reconciles the exact tags and stable socket/session/window/pane IDs, so a crash after window creation cannot create a duplicate. Foreign, ambiguous, or reused IDs are never killed.

Legacy unfinished state under `state/ticket-flow` is intentionally not migrated. `/ticketflow tmux` refuses it with an actionable error.

## Validation

```bash
bun install
bun run check
pi -e .
```

For the real smoke test, start Pi inside tmux, run `/ticketflow tmux`, and complete a small disposable Git-backed ticket set.
