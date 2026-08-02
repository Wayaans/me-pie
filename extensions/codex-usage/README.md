# codex-usage

Shows configurable OpenAI Codex subscription usage in the footer and via `/codex-limit`.

## Behavior

- When the active model uses `openai-codex` with OAuth, fetches usage from ChatGPT's backend API after each agent turn (60s debounce).
- Publishes selected usage windows via `ctx.ui.setStatus()` — with polish-statusline enabled, they appear on the model line to the left of the provider prefix (not the extension-status row).
- `/codex-limit` opens an interactive breakdown (5-hour + weekly bars), configures which windows appear in the footer, and can open the usage dashboard in your browser.
- Footer choices are 5-hour only, 7-day only, or both. At least one remains enabled.
- The global preference is stored in the pi agent directory as `codex-usage.json`; the default remains 5-hour only.

## Limits

Requires OAuth (`openai-codex` subscription). Not a quota enforcement layer — informational only. Stale cache is kept on transient fetch failures. The extension uses an unofficial ChatGPT backend endpoint, which may change without notice.

## Commands

- **/codex-limit** — usage detail overlay (openai-codex + OAuth only)

## Subagents

Disabled in child `pi` processes (`PI_SUBAGENT_DEPTH` set).
