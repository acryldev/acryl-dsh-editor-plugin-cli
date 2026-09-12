# DSH Editor (CLI)

A native `/files` command for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)'s
terminal surface (`acryl-cli`) - browse and view files without leaving the
TUI.

This is the TUI-native sibling of
[`acryl-dsh-editor-plugin-web`](https://github.com/acryldev/acryl-dsh-editor-plugin-web),
built for `acryl-cli`'s own presentation-slot extension point
(`tuiCommands`, spec 034 T009) rather than a browser client bundle. There is
no Host/Client split here: the CLI and its Cordis Loader tree share one
process, so this plugin's own `apply(ctx)` both registers the `/files`
command and reads files directly - no wire protocol to design.

## Features (v1)

- **File tree** - browse from your home directory, `..` to go up, Enter to
  open a folder or file.
- **File viewer** - scrollable, read-only, line-numbered.

Deliberately scoped down from the Web sibling's full editor: no editing, no
cross-file search, no git diff, no Markdown rendering. Those are real,
separate follow-up work once this seam has a second real consumer to
generalize from.

## Install

```bash
dsh plugin --profile <name> add acryl-dsh-editor-plugin-cli
```

(Each profile is its own single-package pnpm workspace, which currently
needs `-w` to satisfy pnpm's own workspace-root safety check:
`dsh plugin --profile <name> add acryl-dsh-editor-plugin-cli -w`.)

After installing, restart `acryl tui`. Type `/files` at the prompt.

## Requirements

- Node.js `>= 20`
- `acryl-cli` with `tuiCommands` (spec 034 T009 or later) - the extension
  point this plugin registers against. Installing this on a surface without
  it (Web, Desktop) leaves the plugin's row simply inactive, not crashed:
  `tuiCommands` is a hard `inject` requirement, so the Fiber just never
  activates there.

## Architecture

A DSH TUI plugin declares itself via the npm package's `dsh` field
(`dsh.bundle.patch` -> `cordis.patch.yml`, which inserts the row) - the same
convention every DSH plugin uses. Unlike a Web plugin, there is no
`dsh.client` field: `lib/index.js` is a standard Cordis Host plugin whose
`apply(ctx)` calls `ctx.tuiCommands.register({command, description, open})`,
where `open({tui, close})` returns a real `pi-tui` `Component` built and
owned entirely by this package.

## License

[MIT](LICENSE)
