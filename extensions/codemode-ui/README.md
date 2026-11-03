# codemode-ui

Renders `codemode` tool rows. Only the rendering changes. Codemode itself runs as before.

## Collapsed

While the script runs, the row is one live line that names the nested call in progress, plus the call count and elapsed time:

```
Running bun run check · 3 tools · 4.0s
```

- `bash` shows only the last command of a chain, without leading env assignments or the commands it pipes into: `cd x && FOO=1 bun test | tail` becomes `Running bun test`.
- Known tools get a verb: `Reading`, `Editing`, `Writing`, `Searching`, `Finding`, `Fetching`, `Looking up`. Other tools show `Calling <name>`.
- Between calls, the line reads `Executing script`.

When the script finishes, the line becomes a summary, such as `Ran 5 tools · 2.3s`. If a call or the script failed, one line underneath names the error.

## Expanded

The summary line, then every nested call as a tree with its status, target, and duration, and the first lines of each call error. The script and its output are not shown.

## Notes

- The elapsed time redraws the row once per second only while the script runs. The timer stops when the result is final.
- Mepie loads extensions in catalog order, and the first tool renderer wins, so this takes precedence over `mepie-tool-ui`'s codemode rows.
