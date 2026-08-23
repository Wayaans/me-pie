# file-search

First-class `fd` and `rg` tools for Pi, adapted with permission from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup).

- `fd` discovers files and directories by name, extension, type, or glob.
- `rg` searches file contents with regex or literal matching.
- Both respect `.gitignore` unless hidden files are explicitly requested.
- Output is capped at Pi's 2,000-line/50 KB limits; complete truncated output is saved to a temporary file.
- Tool calls use the same compact, expandable renderer and color hierarchy as `mepie-tool-ui`, without a leading blank line. `Fd` uses the `󰈞` files icon and `Rg` uses the `󰍉` search icon. Both icons use the theme's `text` color.

The extension prefers system `fd`/`fdfind` and `rg` binaries. Missing binaries are downloaded from official releases into the versioned Mepie cache after HTTPS, size, and SHA-256 validation. Automatic downloads support macOS and Linux on ARM64 and x64; other platforms can provide system binaries.
