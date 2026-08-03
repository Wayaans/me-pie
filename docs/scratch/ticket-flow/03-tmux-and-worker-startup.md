# Stage 3: tmux and worker startup

## Objective

Create and manage one workflow-owned tmux window, launch a normal interactive Pi worker with an exact model and thinking level, and prepare worker-role startup. Native communication arrives in Stage 4, so this stage stops after process launch and observable readiness prerequisites.

## Deliverables

Add:

```text
tmux/controller.ts
tmux/types.ts
tmux/command.ts
worker/lifecycle.ts
```

Extend controller state with tmux and requested launch-profile metadata.

## tmux detection

Verify:

- `TMUX` is present.
- The `tmux` executable responds within a short timeout.
- The current session and pane can be identified.

Read the current session through tmux format output rather than parsing `$TMUX` as the durable identity.

Return typed errors for missing tmux, command timeout, unexpected output, and a vanished session.

## Window creation

Create one detached, unfocused window in the orchestrator’s current tmux session. Use a sanitized display name such as `tf-03-auth`, but persist returned IDs as identity:

- tmux session ID/name
- `window_id`
- `pane_id`
- work-item ID
- display name

Use `tmux new-window -d -P -F ... -c <project-cwd>` and parse its machine-readable result. Never discover or close a window by display name alone.

Tag the window or pane with run/work-item metadata when tmux user options make this practical. Treat tags as recovery aids, not primary authorization.

## Pi invocation

Resolve the Pi executable safely. Build arguments as data:

```text
--model <provider/model>
--thinking <level>
```

Ensure the worker loads the same Mepie package. Resolve the package root from the extension module and add an explicit package/extension argument when local development or installation discovery cannot guarantee child loading.

Pass workflow environment variables:

```text
MEPIE_WORKFLOW_ROLE=worker
MEPIE_WORKFLOW_RUN_ID
MEPIE_WORKFLOW_ITEM_ID
MEPIE_WORKFLOW_REQUESTED_MODEL
MEPIE_WORKFLOW_REQUESTED_THINKING
MEPIE_WORKFLOW_SOCKET
MEPIE_WORKFLOW_TOKEN
```

Do not put secrets in command-line arguments. The connection token belongs in the environment and owner-only state.

Because tmux ultimately executes a command through a shell, centralize POSIX argument quoting or use an owner-only launcher file. Do not concatenate untrusted ticket text into the launch command. Delegation is not sent through tmux.

## Ownership and shutdown

The controller may inspect or close only a handle recorded for the active run. Before a destructive operation, confirm the window still exists and that its pane metadata matches the expected run/work item when available.

Implement graceful close as a bounded sequence:

1. Request process termination when possible.
2. Wait for pane exit.
3. Use `kill-window -t <window_id>` only after timeout or explicit stop.

Stage 4 will replace process-only shutdown with a native Pi shutdown request.

## Worker role

In worker role:

- Do not register orchestrator tools or commands.
- Read and validate required environment values.
- Reject incomplete identity.
- Prepare a worker lifecycle object during `session_start`.
- Release resources idempotently during `session_shutdown`.

Do not restrict the worker’s normal Pi tools.

## Tests

Introduce an injectable tmux command runner. Unit tests must not require a live tmux server.

Cover:

- tmux format parsing
- Window-name sanitization
- Exact model and thinking arguments
- Environment construction
- Safe argument quoting/launcher generation
- Returned ID persistence
- Rejection of stale or foreign handles
- Graceful and forced close paths
- Worker-role environment validation
- No delegation text in tmux commands

Add an opt-in manual smoke script or documented command for live tmux testing, but do not include it in normal `bun test`.

## Acceptance criteria

- A finalized work item can create exactly one owned tmux window.
- The window runs normal interactive Pi with the requested launch profile.
- The worker extension enters worker role without losing normal tools.
- The controller cannot close an unrelated window.
- No delegation prompt is sent before native verification exists.
- `bun run check` passes.
