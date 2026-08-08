# Terminal Environment

`terminal-environment` exposes one `workspace` tool when Pi is running inside a functioning supported terminal environment. The MVP supports tmux. Herdr and cmux adapters are planned but are not activated through the tmux fallback.

## Actions

### Spawn

With no options, spawn creates a detached window in the current tmux session and uses Pi's current working directory.

```json
{ "action": "spawn", "spawn": {} }
```

Supported tmux kinds are `session`, `window`, and `pane`. Results include the stable tmux session (`$`), window (`@`), and pane (`%`) IDs. Prefer pane IDs for later operations.

### Run

With no target, run creates a detached window and starts Pi. Supported coding agents are `pi`, `codex`, `claude`, and `opencode`.

```json
{
  "action": "run",
  "run": {
    "agent": "codex",
    "model": "gpt-5.4",
    "thinking": "high",
    "cwd": "."
  }
}
```

A supplied target must be an idle shell unless `replace` is explicitly true. A window created by the same `run` action is safe to replace automatically. Agent launches use owner-only temporary scripts and managed argument arrays.

Run never supplies an initial prompt or arbitrary CLI arguments. It starts a fresh interactive coding agent only. Deliver the task afterward with `workspace send`.

### Send

Send requests tmux bracketed paste so supported destination editors receive multiline Markdown as one paste. It presses Enter exactly once when `submit` is true, then writes a signal to the destination pane's inbox. The signal records the current pane as its source.

```json
{
  "action": "send",
  "send": {
    "targetId": "%13",
    "input": "prompt",
    "text": "# Task\n\nReview the authentication module. When done, report with workspace send to %5."
  }
}
```

`prompt` and `command` describe the input's intent. Both are delivered literally; the process running in the pane decides how to interpret the text. The result identifies the source and destination. Its `sequence` is the destination inbox sequence. Its `replyAfterSequence` is the source inbox baseline: use it when the source pane waits for a reply.

### Wait

Wait listens on the resolved recipient target's inbox for the next successful `workspace` send delivered there. The signal identifies its source pane. For a controller/worker handshake, the controller sends a task to the worker, the worker sends its report back to the controller, and the controller waits on its own pane ID.

```json
{
  "action": "wait",
  "wait": {
    "targetId": "%5",
    "afterSequence": 4,
    "timeoutMs": 120000
  }
}
```

Use the task send result's `replyAfterSequence` as `afterSequence`. This prevents a fast worker report from being missed between send and wait. If `afterSequence` is omitted, wait uses the current inbox sequence and waits for the next signal. Wait ends only when a signal reaches that inbox or the timeout expires. After a timeout, call wait again with the returned `sequence`.

The worker must be told to deliver its final report with `workspace send` to the controller pane. The worker should not call `workspace wait` to receive its task: the task is normal terminal input. A received signal is the worker's cooperative report; it does not independently inspect coding-agent process state.

### Close

Close terminates the exact native tmux pane or window: `%` IDs close panes and `@` IDs close windows. Session (`$`) IDs are rejected. Prefer the worker pane ID returned by spawn or run so the operation has the smallest scope.

```json
{
  "action": "close",
  "close": {
    "targetId": "%13"
  }
}
```

Close resolves the target immediately before issuing the corresponding tmux `kill-*` command and returns its pre-close metadata snapshot. It rejects the calling pane and its containing window, preventing the controller from terminating itself. Missing targets and tmux failures are reported as tool errors. Close workers explicitly after their reports and any verification are complete; wait does not close them automatically.

## TUI presentation

The `workspace` tool uses compact action and result rows. Expanded results show tmux target metadata; send results preview Markdown and show the race-safe reply baseline; pending waits show the recipient inbox and elapsed time, while successful waits show the source-to-recipient route. Narrow terminals keep only the action, primary pane ID, and status.

Renderer text strips terminal control characters from requests, target metadata, previews, and errors before display. Executable paths remain hidden.

## Activation

The tool is registered during `session_start` only when:

- `TMUX` is present,
- Pi is not marked as running inside Herdr or cmux, and
- `tmux display-message` returns a valid current socket/session/window/pane identity.

Outside a supported environment, the tool is absent. tmux metadata containing newlines or the ASCII unit-separator control character is rejected fail-closed because tmux format output cannot represent those values unambiguously.

## Validation

```bash
bun install
bun run check
```

For a manual smoke test, start Pi inside tmux:

```bash
pi -e .
```
