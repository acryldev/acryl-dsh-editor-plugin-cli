# DSH Editor

A VS Code-style code editor that runs inside [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — and therefore inside ACRYL Desktop, which hosts the same DSH plugin runtime. It adds a **Files** tab to the session main area with a file tree, the Monaco editor, cross-file search/replace, a Markdown preview, and Git status/diff.

The plugin is a **standard Cordis plugin (npm package)**. It installs with one `dsh plugin add` command and survives restarts.

## Features

- **File tree** — browse the workspace directory, expand/collapse folders, Git status badges (`M`/`A`/`??`…); click a badge to view the diff.
- **Monaco editor** — multi-file tabs, syntax highlighting, configurable word wrap / minimap / font size / tab width, customizable keybindings.
- **Cross-file search** — powered by ripgrep: streaming incremental results, match highlighting, virtual scrolling (up to 20,000 results), case/whole-word/regex toggles, include/exclude globs, search history, cross-file replace.
- **Markdown preview** — source / preview / split views; rendered with marked + DOMPurify sanitization, highlight.js, mermaid diagrams, KaTeX math, and task-list checkboxes.
- **Quick open** — `Ctrl+P` with fuzzy matching on relative paths.
- **Conversation path jump** — `Ctrl+click` (`Cmd+click` on macOS) a file path inside an inline-code snippet in the conversation to jump straight to the Files tab and open it.
- **Theme sync** — follows the DSH light/dark theme; Monaco, highlight.js, and mermaid switch in real time.

## Requirements

- Node.js `>= 20`
- A DSH (or ACRYL Desktop) installation with the `dsh` CLI available
- `ripgrep` on PATH for cross-file search (the editor degrades gracefully without it)
- `git` on PATH for status badges and diffs (optional)

## Install

### From npm (recommended)

```bash
dsh plugin --profile web add acryl-dsh-editor-plugin
```

### From GitHub

```bash
dsh plugin --profile web add git+https://github.com/acryldev/acryl-dsh-editor-plugin.git
```

### From a local directory

```bash
dsh plugin --profile web add file:/path/to/acryl-dsh-editor-plugin
```

After installing, **restart DSH** (`dsh web --profile web`). A **Files** tab appears in the session main area.

### Install into ACRYL Desktop

ACRYL Desktop hosts the same DSH plugin runtime, so the same command works from its built-in terminal — omit the profile flag and the Desktop's active profile is used:

```bash
dsh plugin add acryl-dsh-editor-plugin
```

Or install from a local checkout while developing:

```bash
dsh plugin add file:/path/to/acryl-dsh-editor-plugin
```

The Desktop routes `dsh plugin add` through its recoverable install boundary: the active profile is snapshotted, the package is installed, and on success it is reconciled into `dsh.profile.bundles`. **Restart ACRYL Desktop afterwards** so the client module table is re-scanned and the Files tab mounts.

### How installation works

`dsh plugin add` appends the package to `dsh.profile.bundles`. At profile boot, DSH merges this package's bundle patch (`cordis.patch.yml`) — one `insert` of the `dsh-editor` host row — exactly like a manual `cordis.patch.yml` mount line, and loads the browser half declared under the package's `dsh.client` field. The client module table scan result is cached in-process, so **plugin set changes require a DSH restart to take effect**.

## Architecture

A DSH browser-UI plugin has two halves, declared via the npm package's `dsh` field:

- **Host half** (`lib/index.js`) — a standard Cordis plugin in the Node process. Injects `fs`, `subprocess`, and `connection`; serves the editor's private JSON RPC on the `/editor` connection channel:
  - `fs:init`, `fs:stat-path`, `fs:project-root`, `fs:list`, `fs:read`, `fs:write`, `fs:files`
  - `fs:search-start` / `fs:search-poll` / `fs:search-cancel` (ripgrep jobs), `fs:search-replace`
  - `git:status`, `git:diff`
- **Client half** (`lib/client.js`) — a browser module loaded by the DSH client runtime. Renders the React UI (file tree, tabs, Monaco, search, preview), talks to the host over the `/editor` channel, and registers the `Files` conversation view plus an `Editor` settings section.

The two halves are wired at boot: `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml` (Host) and `dsh.client` → `./lib/client.js` (Client). No profile file edits are needed.

## Dynamic one-off install (try it without installing)

`src/host.js` and `src/client.js` are the same editor packaged as **dynamic Cordis plugin function bodies**. They can be defined inside a single DSH session with the `cordis_define` tool and activated with `cordis_run` — no profile change, but they vanish when the process restarts. See [install/INSTALL.md](install/INSTALL.md).

## Directory structure

```
acryl-dsh-editor-plugin/
├── lib/
│   ├── index.js           # Host half (Node: fs/git/ripgrep backends + /editor RPC)
│   └── client.js          # Client half (browser: UI, Monaco, search, preview via /editor RPC)
├── src/
│   ├── host.js            # Dynamic-plugin function body of the host half (reference / quick try)
│   └── client.js          # Dynamic-plugin function body of the client half
├── cordis.patch.yml       # dsh.bundle.patch: inserts the host plugin row into the profile
├── package.json           # dsh.bundle.patch + dsh.client declarations
├── install/INSTALL.md     # Install & migration guide
├── README.md
└── LICENSE
```

## Where it's listed

- **DSH Store (featured example):** https://acryl.dev/store/packages/acryl-dsh-editor-plugin — featured at the top of the directory and used as the worked example in the [publishing guide](https://acryl.dev/store/publishing).
- **npm:** https://www.npmjs.com/package/acryl-dsh-editor-plugin — tagged `dsh-plugin` + `acryl-package`, which is how the store and the DSH Desktop market catalog discover it.
- **Publishing guide:** https://acryl.dev/store/publishing — how to publish your own DSH plugin, using this repository as the reference.

## License

[MIT](LICENSE)
