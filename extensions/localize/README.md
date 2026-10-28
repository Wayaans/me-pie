# localize

Compose or refine English prompts from English, Bahasa Indonesia, or mixed input. Results go into the Pi editor for review, never automatic submission.

## Commands

- `/localize compose <instructions>` creates a concise, ready-to-use English prompt. It may reorganize the input while preserving explicit requirements and supplied technical literals. It must not invent requirements or answer the task.
- `/localize refine <prompt>` conservatively translates and refines wording. Exact line, paragraph, list, indentation, and code structure is validated.
- `/localize config` selects the shared model and thinking level, then edits the composer and refiner prompts before confirming the save.

An explicit subcommand is required. Missing or invalid subcommands, empty prompts, and extra arguments after `config` show usage without a model request. `/localize-config` is no longer registered.

Argument autocomplete offers `compose`, `refine`, and `config` with descriptions. It filters by prefix and stops after the subcommand separator. The parser removes one separator after the subcommand, treating CRLF as one newline, and preserves the remaining prompt whitespace and multiline formatting.

All commands require interactive TUI mode. Compose and refine make a separate model request without adding the source or result to the current Pi conversation. The configured model is tried first, with the current session model as a fallback. Failure or cancellation restores the source prompt without the command prefix.

Refine rejects structural changes. Compose accepts any nonempty text response; preserving meaning and technical literals relies on its system prompt and your review, not structural validation.

## Configuration

Package defaults:

```json
{
  "localize": {
    "model": "openai-codex/gpt-5.4-mini",
    "thinking": "low",
    "composerPrompt": "You write ready-to-use prompts from the user's instructions...",
    "refinerPrompt": "You are a prompt localizer and language refiner..."
  }
}
```

These prompt excerpts are illustrative. Omit either prompt field to use its complete package default. Existing configs without `composerPrompt` keep their `refinerPrompt` and use the default composer prompt. Both prompt fields must be nonempty strings.

Set `localize` in the global `~/.pi/agent/mepie.json` or in a trusted project's `.pi/mepie.json`. Project fields override global fields. Untrusted projects use only global values and defaults. `/localize config` requires project trust, saves only after confirmation, and replaces only the `localize` key. No `/reload` is required.

## Install

No extension-local dependencies.
