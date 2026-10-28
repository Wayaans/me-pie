# answer

Extract actionable questions from the last assistant message and answer them in an interactive TUI.

## Behavior

1. Reads the latest assistant message on the current branch and requires it to be complete.
2. Uses the configured model and thinking level to extract every question as structured JSON.
3. Rewrites unresolved decisions as clear standalone questions while retaining every choice, constraint, qualifier, caveat, and default that affects the answer.
4. Captures explicit recommendations as answer-ready text without copying headings such as `Recommendation:`.
5. Presents an interactive Q&A flow and submits the compiled answers as a user message.

## Commands

- **/answer** — extract and answer questions from the last assistant message.
- **/answer-config** — search for a project-specific extraction model, then select its thinking level.

Both selectors support type-to-search. `/answer-config` saves immediately to the project's `.pi/mepie.json`; `/reload` is not required.

## Shortcuts

- **Ctrl+.** — same as `/answer`.
- **Ctrl+R** — while answering a question with a recommendation, fill an empty answer with that recommendation.

Ctrl+R never overwrites an answer that already contains text. Ctrl+Y is not used because it is pi's editor yank shortcut.

## Configuration

Package defaults:

```json
{ "answer": { "model": "openai-codex/gpt-5.4-mini", "thinking": "medium" } }
```

Set `answer` in the global `~/.pi/agent/mepie.json` or in a trusted project's `.pi/mepie.json`. Project fields override global fields. Saving replaces only the `answer` key.

The configured authenticated model is tried first. If it is unavailable or encounters a recoverable error, `/answer` falls back to the current session model. The configured thinking level is applied through pi's provider-neutral reasoning interface and clamped to the selected model's capabilities.

## Q&A controls

- **Tab / Enter** — next question
- **Shift+Tab** — previous question
- **Shift+Enter** — newline
- **Ctrl+R** — use the explicit recommendation when the answer is empty
- **Esc** — cancel

## Troubleshooting

If you see "Cancelled" after the loader or Q&A UI, you pressed Esc or Ctrl+C.

Authentication, model, malformed config, and invalid JSON failures are shown as `Question extraction failed: …` or as configuration errors.
