# Installation Guide

DSH Editor is distributed as a **standard Cordis plugin (npm package)**. It installs with one `dsh plugin add` command and survives restarts.

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

## Install into ACRYL Desktop

ACRYL Desktop hosts the same DSH plugin runtime. Run the same command from the Desktop's built-in terminal — the Desktop's active profile is used:

```bash
dsh plugin add acryl-dsh-editor-plugin
```

Or, while developing, install from a local checkout:

```bash
dsh plugin add file:/path/to/acryl-dsh-editor-plugin
```

The Desktop routes `dsh plugin add` through its recoverable install boundary: it snapshots the active profile, installs the package, and reconciles it into `dsh.profile.bundles` on success. **Restart ACRYL Desktop afterwards** so the client module table is re-scanned and the Files tab mounts.

## Dynamic install (temporary try-out)

`src/host.js` and `src/client.js` are the same editor's **dynamic Cordis plugin** function bodies. They suit a quick try inside a single DSH session without touching the profile. The downside: they disappear when the process restarts.

In a DSH session, ask the Agent:

```
Read src/host.js and src/client.js, then define a plugin with cordis_define
(plugin: { kind: 'new', idPrefix: 'editr' },
 code: { host: <host.js contents>, client: <client.js contents> }),
and activate it with cordis_run (mode: 'run').
```

## Notes

`dsh plugin add` appends the package to `dsh.profile.bundles`. At profile boot, DSH merges this package's bundle patch (`cordis.patch.yml`) — one `insert` of the `dsh-editor` host row — and loads the browser half declared under the package's `dsh.client` field. The client module table scan result is cached in-process, so **plugin set changes require a DSH restart to take effect**.
