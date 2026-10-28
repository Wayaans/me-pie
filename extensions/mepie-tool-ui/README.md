# mepie-tool-ui

A compact, theme-aware renderer for Pi's built-in tools.

The extension preserves the built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` implementations while replacing their conversation rendering. Collapsed successful tools occupy one line. Failures add one actionable error line with a rounded tree connector. Expanded tools show all content returned by the built-in implementation.

Tool shells have no box or background. Each row uses the same one-column left and right inset as Pi's assistant and thinking output. The bold tool label communicates state through the active theme:

- dim while arguments are being prepared
- accent while running
- the theme's tool-title color when complete
- error when failed

Each built-in tool label starts with a Nerd Font icon in the theme's `text` color. The icon stays the same color while the bold tool name communicates execution state. The target after the label uses `muted`. Completed result summaries use `success`, while truncation and result limits use `warning`. Diff summaries keep their added and removed colors. Separators use `dim`.

```text
󰈙 Read package.json · 42 lines
 Bash bun run check · no output
󰏫 Edit extensions/mepie-tool-ui/tools.ts · +8 −3
󰆓 Write README.md · 12 lines · 640 B
󰍉 Grep /renderCall/ in extensions · 7 results
󰈞 Find *.ts in extensions · 14 files
󰉋 List extensions · 9 entries
```

The first Mepie tool after thinking, assistant text, a user message, or a non-Mepie tool keeps Pi's leading blank line. Consecutive Mepie tools form a compact group with no blank lines between them. The file-search extension's `fd` and `rg` rows belong to the same group, so transitions such as `Read` to `Fd` and `Rg` to `Read` stay compact.

Example:

```text
󰏫 Edit extensions/mepie-tool-ui/tools.ts · +8 −3
󰏫 Edit extensions/mepie-tool-ui/tools.ts · failed
╰─ oldText did not match exactly. Re-read the file and retry.
```

Collapsed Bash rows show only the script's first physical line. Long first lines still truncate to the available width, while execution and expanded output remain unchanged.

Collapsed reads of `SKILL.md` use the skill directory name instead of the file path:

```text
[] skill-name (ctrl+o to expand)
```

The brackets and shortcut use `muted`, the icon uses `toolTitle`, and the skill name uses `text`. Pi supplies the configured expansion shortcut. The `` glyph requires a Nerd Font.

Visible thinking text starts with the `󰧑` glyph and uses the active theme's `thinkingText` color and regular weight. Thinking does not append trailing space. A following Mepie tool owns the single blank line between the thinking text and tool group. The extension preserves Pi's italic and visibility settings. The glyph requires a Nerd Font.

```text
󰧑 I need to inspect the current implementation before proposing the change.
```

## Codemode

`codemode` rows use the same shell. Each nested tool call becomes one tree line with the icon, label, and target of its direct row and a right-aligned duration. Calls to tools without a Mepie row show their name and arguments. Codemode records only a 200-character preview of each call's arguments, so targets come from that preview, and result summaries such as line counts are not available.

```text
󰅩 Codemode · 3 calls · 0.4s
├─ 󰈙 Read extensions/mepie-tool-ui/tools.ts                 4ms
├─  Bash · Find renderer docs                            120ms
╰─ 󰍉 Grep /registerToolRenderer/ in extensions             38ms
```

When the script succeeds, the header counts calls and failed calls and shows the script's duration. A failed script's header shows `failed`. Collapsed rows show the last eight calls and no script output. A failed call adds its last error line below it. When the script fails for another reason, the script error is the last tree line. Cancelled calls show `cancelled` in place of a duration. Expanded rows show each call's full argument preview, the script, and its output. Nested Bash calls without a purpose show the command's first line. The `builtin` tool mode keeps Pi's codemode renderer.

The extension affects TUI presentation only. Tool inputs, outputs, execution semantics, and model context remain unchanged.
