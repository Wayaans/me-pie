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

A supplied target must be an idle shell unless `replace` is explicitly true. A window created by the same `run` action is safe to replace automatically. Agent launches use owner-only temporary scripts and argument arrays; they do not evaluate user-authored shell command strings.

Codex and Claude initial prompts use an end-of-options delimiter, and OpenCode uses its explicit prompt option. Pi's CLI has no equivalent delimiter, so an initial Pi prompt beginning with `-` or `@` is rejected; start Pi first and deliver that prompt with `workspace send`.

### Send

Send pastes literal text into the resolved pane, optionally presses Enter, then advances the pane's send-signal sequence.

```json
{
  "action": "send",
  "send": {
    "targetId": "%13",
    "input": "prompt",
    "text": "# Task\n\nReview the authentication module."
  }
}
```

`prompt` and `command` describe the input's intent. Both are delivered literally; the process running in the pane decides how to interpret the text.

### Wait

Wait observes successful `workspace` sends targeting the resolved pane.

```json
{
  "action": "wait",
  "wait": {
    "targetId": "%13",
    "afterSequence": 4,
    "timeoutMs": 120000
  }
}
```

If `afterSequence` is omitted, wait uses the sequence present when the action starts and waits for the next send. It also returns when the timeout expires or the target disappears. Wait does not detect coding-agent turn completion.

## TUI presentation

The `workspace` tool uses compact action and result rows. Expanded results show tmux target metadata; send results preview Markdown; pending waits show elapsed time and clearly identify the event as a workspace send signal. Narrow terminals keep only the action, primary pane ID, and status.

Renderer text strips terminal control characters from requests, target metadata, previews, and errors before display. Launch `extraArgs` and executable paths remain hidden.

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
