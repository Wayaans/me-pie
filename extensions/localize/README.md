# localize

Translate mixed Bahasa Indonesia/English prompts into concise, natural English and prefill the pi editor without submitting them to the main conversation.

## Commands

- **/localize** `<prompt>` — translate and refine the prompt, preserve its structure, and load the result into the editor for review.
- **/localize-config** — select the project-specific model and thinking level, then edit the refiner prompt.

`/localize` makes a separate model request, but does not call `sendUserMessage()` or otherwise add the source or result to the current pi session. The user must submit the localized prompt manually.

The configured model is tried first, with the current session model as a fallback. If localization is cancelled, fails, or changes the prompt's line/list/code structure, the original prompt is restored to the editor.

## Project configuration

Package defaults:

```yaml
localize:
  model: openai-codex/gpt-5.4-mini
  thinking: low
  refinerPrompt: |-
    You are a prompt localizer and language refiner...
```

A trusted project's `.pi/mepie/config.yaml` can override these values. `/localize-config` saves there immediately while preserving other Mepie configuration sections; `/reload` is not required.

## Install

No extension-local dependencies.
