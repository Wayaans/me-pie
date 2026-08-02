# mepie-ui

A theme-aware Pi header and dashboard footer, adapted with permission from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup).

The header preserves the original block `PI` logo while deriving every color from the active Pi theme. The footer shows:

- working directory
- provider, model, and thinking level
- context utilization, session cost, and approximate generation speed
- Git branch, changed-file count, and an optional linked pull request when `gh` is available
- statuses published by other extensions

Git information refreshes in the background. All polling and UI resources are released during session shutdown. The extension is inactive outside Pi's interactive TUI mode.
