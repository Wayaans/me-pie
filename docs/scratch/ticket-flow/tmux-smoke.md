# Ticket Flow tmux smoke test

This check is manual and is not part of `bun test`.

1. Start Pi inside tmux from the Mepie checkout:

   ```sh
   tmux new-session -A -s mepie
   pi -e .
   ```

2. Run `/ticket-flow tmux <prompt>`, finalize a one-item plan with an explicit model and thinking level, then call `workflow_worker` with `action: "delegate"`.
3. Confirm a detached `tf-*` window appears with `tmux list-windows -F '#{window_id} #{window_name} #{pane_id}'` and that the child Pi remains interactive.
4. Close it through `workflow_worker` with `action: "close"`. Confirm the recorded window ID disappeared and unrelated windows remain.

Stage 3 intentionally does not send the ticket prompt. Native readiness and delegation begin in Stage 4.
