# mepie-tool-ui

A compact, theme-aware renderer for Pi's built-in tools.

The extension preserves the built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` implementations while replacing their conversation rendering. Collapsed successful tools occupy one line. Failures add one actionable error line with a rounded tree connector. Expanded tools show all content returned by the built-in implementation.

Tool shells have no box or background. Each row uses the same one-column left and right inset as Pi's assistant and thinking output. The bold tool label communicates state through the active theme:

- dim while arguments are being prepared
- accent while running
- the theme's tool-title color when complete
- error when failed

Pi adds one blank line before every self-rendered tool row, so adjacent tools remain visually separated without extension-owned spacing.

Example:

```text
Edit extensions/mepie-tool-ui/tools.ts · +8 −3

Edit extensions/mepie-tool-ui/tools.ts · failed
╰─ oldText did not match exactly. Re-read the file and retry.
```

Thinking text also uses the active theme's `dim` color. Pi's italic style remains unchanged, and the extension does not add bold styling.

The extension affects TUI presentation only. Tool inputs, outputs, execution semantics, and model context remain unchanged.
