# Ticket Flow live tmux smoke test

This is an opt-in manual release check. It is not part of `bun test` and may make paid model calls. Use a disposable repository, an inexpensive available model, and tickets that require only a trivial edit.

## Setup

1. Ensure `pi`, `tmux`, and `bun` are available.
2. Create a disposable Git repository outside the Mepie checkout:

   ```sh
   repo="$(mktemp -d)/ticket-flow-smoke"
   mkdir -p "$repo/docs/tickets" "$repo/docs/specs"
   cd "$repo"
   git init
   printf '# Spec\nCreate the requested text files.\n' > docs/specs/spec.md
   printf '# First\nCreate first.txt containing first.\n' > docs/tickets/01-first.md
   printf '# Second\nAfter First, create second.txt containing second.\n' > docs/tickets/02-second.md
   git add . && git commit -m 'smoke fixture'
   ```

3. Start a dedicated tmux session and load the local Mepie package:

   ```sh
   tmux new-session -s ticket-flow-smoke
   pi -e /absolute/path/to/mepie
   ```

4. Record the project status with `git status --short`.

## Checklist

- [ ] Invoke one command with an exact inexpensive model and supported thinking level:

  ```text
  /ticket-flow tmux Implement @docs/tickets using @docs/specs/spec.md.
  Determine dependency order from content. Use <provider/model> with <thinking> thinking.
  Delegate each item using /implement this ticket {ticket} using {specs}.
  Use ledger-only completion.
  ```

- [ ] Planning identifies two items, records content-derived order, expands `/implement`, and finalizes without a missing-profile fallback.
- [ ] Finalization creates exactly one `tf-*` worker window. Verify stable IDs without changing focus:

  ```sh
  tmux list-windows -F '#{window_id} #{window_name} #{pane_id} #{@mepie_workflow_run_id} #{@mepie_workflow_item_id}'
  ```

- [ ] The worker window displays normal interactive Pi, not a headless process.
- [ ] Worker state shows the exact requested provider/model and thinking level.
- [ ] The `/implement ...` delegation expands normally and the worker receives only the active item.
- [ ] The worker retains normal implementation tools, project instructions, skills, and prompt templates.
- [ ] Submit a native progress event with `workflow_submit_report`; `workflow_worker wait` receives it without terminal scraping.
- [ ] Submit a completed report; the orchestrator receives and persists it through the native protocol.
- [ ] Request one report revision. Confirm the feedback reaches the same Pi session and no second window is created.
- [ ] Submit the revised report and accept it. Confirm only the recorded first window closes and one second-item window starts.
- [ ] Detach with the tmux prefix plus `d`, then reattach with `tmux attach -t ticket-flow-smoke`. Confirm the run and worker continue.
- [ ] Reload or exit/restart the orchestrator while the second worker runs, then invoke recovery. Confirm it reconnects to the existing window and creates no duplicate.
- [ ] Accept the second report. Confirm the run completes and all workflow-owned windows close.
- [ ] Confirm unrelated tmux windows remain untouched.
- [ ] Confirm `git status --short` shows only the worker's intended `first.txt` and `second.txt` changes. It must not show `.mepie`, state, plan, event, report, socket, launcher, lock, or ignore files.
- [ ] Locate the configured Pi agent directory and confirm metadata exists only at:

  ```text
  <agent-dir>/state/ticket-flow/<project-hash>/<run-id>/
  ```

- [ ] Confirm the run directories are mode `0700` and state, plan, event, token (while active), and report files are owner-only (`0600`).
- [ ] Run `workflow_control status` and confirm output is bounded and does not reveal a connection token.

## Recovery failure checks

Perform these only if convenient in a second disposable run:

- [ ] Start a worker with an unavailable/mismatched profile and confirm no delegation is delivered.
- [ ] Rename or manually remove the owned worker window, then recover. Confirm the run pauses and does not create a duplicate.
- [ ] Present a reused/foreign tmux ID and stop the run. Confirm Ticket Flow does not close that window.
- [ ] Stop an active valid run. Confirm graceful shutdown is attempted, the owned window closes, and the project lock is released.

## Cleanup

1. Stop any unfinished run through `workflow_control stop`.
2. Confirm no `tf-*` windows from the disposable run remain.
3. Exit the dedicated tmux session.
4. Delete the disposable repository.
5. After confirming the run is completed or stopped, optionally delete only its global `<run-id>` directory as described in `extensions/ticket-flow/README.md`.
