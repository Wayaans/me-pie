# skill-shortcut

Adds `$skill-name` as a shortcut for invoking pi skills with `/skill:skill-name`.

## Behavior

- Typing `$` in the editor triggers layered autocomplete for loaded skill names without replacing Pi's editor component.
- Submitting `$diagnose this failure` transforms the input to `/skill:diagnose this failure` before pi expands skills.
- Unknown `$name` tokens are left unchanged.

## Commands and tools

No commands or tools are registered.

## Install

No extension-local dependencies.
