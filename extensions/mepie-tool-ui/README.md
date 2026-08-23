# mepie-tool-ui

A compact, theme-aware renderer for Pi's built-in tools.

The extension preserves the built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` implementations while replacing their conversation rendering. Collapsed successful tools occupy one line. Failures add one actionable error line with a rounded tree connector. Expanded tools show all content returned by the built-in implementation.

Tool shells have no box or background. Each row uses the same one-column left and right inset as Pi's assistant and thinking output. The bold tool label communicates state through the active theme:

- dim while arguments are being prepared
- accent while running
- the theme's tool-title color when complete
- error when failed

The target after the label uses `muted`. Completed result summaries use `success`, while truncation and result limits use `warning`. Diff summaries keep their added and removed colors. Separators use `dim`.

The extension removes Pi's leading blank line from its tool rows. Adjacent tool calls therefore render without an empty line between them.

Example:

```text
Edit extensions/mepie-tool-ui/tools.ts · +8 −3
Edit extensions/mepie-tool-ui/tools.ts · failed
╰─ oldText did not match exactly. Re-read the file and retry.
```

Collapsed Bash rows show only the script's first physical line. Long first lines still truncate to the available width, while execution and expanded output remain unchanged.

Collapsed reads of `SKILL.md` use the skill directory name instead of the file path:

```text
[] skill-name (ctrl+o to expand)
```

The brackets and shortcut use `muted`, the icon uses `toolTitle`, and the skill name uses `text`. Pi supplies the configured expansion shortcut. The `` glyph requires a Nerd Font.

Visible thinking text starts with the `󰧑` glyph, uses the active theme's `thinkingText` color and regular weight, and has one blank line below it. Assistant text followed by a tool call also has one blank line below it. The extension preserves Pi's italic and visibility settings. The glyph requires a Nerd Font.

```text
󰧑 I need to inspect the current implementation before proposing the change.
```

The extension affects TUI presentation only. Tool inputs, outputs, execution semantics, and model context remain unchanged.
