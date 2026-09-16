// DSH Editor (CLI) — a TUI-native file browser and editor.
//
// Standard Cordis plugin mounted via cordis.patch.yml (see package.json
// `dsh.bundle.patch`). Registers a `/files` command with `tuiCommands`
// (acryl-cli's own TUI presentation-slot extension point, spec 034 T009) -
// there is no Host/Client split the way the Web sibling plugin
// (acryl-dsh-editor-plugin-web) needs: the CLI and its Cordis Loader tree
// share one process, so this file both registers the command AND reads/
// writes files directly, in-process, with no wire protocol to design.
//
// v2: browse, search-filter, view, and edit-in-place. v3: the actual visual
// language of almegal/pi-file-browser's FileBrowserComponent, not just its
// key conventions - a bordered rounded-corner box (its own addBorder),
// per-extension file-type icons (its own FileTypeIconProvider, trimmed to
// the extensions likely to show up browsing a real project rather than
// copied wholesale), directories-first/prefix-match-first ranked search
// (its own PanelModel._applyFilter), fzf-style auto-search on any
// unrecognized printable keystroke while browsing - not only after
// pressing `/` - and centered-on-selection scrolling instead of merely
// keeping the cursor on-screen. h/j/k/l alongside arrows and Escape/Left as
// one "go back" action (not only "close") were already adapted from the
// same source in v2. Not copied line-for-line - that project targets a
// dual-pane picker and this stays a single-pane browser embedded in one
// pi-tui Component - but genuinely the same look and feel, verified
// side-by-side against its actual source, not just its docs.
//
// clarkarch/tfm-tui was evaluated and ruled out, not skipped: it's a
// standalone Bun-compiled binary (`bun build --compile`, `private: true`,
// no exports) whose only dependency is @opentui/core - a different runtime
// (Bun, not Node) and a different terminal-rendering engine (opentui's own
// native compositor, not pi-tui's plain `render(width): string[]` line
// contract this plugin renders through). It cannot be imported as a
// library into any Node/pi-tui program, this one included - confirmed by
// reading its package.json and composition root directly, not assumed.
// Its syntax-highlighting approach (tree-sitter through opentui's
// CodeRenderable) is real and worth having eventually, but needs a genuine
// port to a pi-tui-compatible highlighter, not an import. Still deferred,
// unforced: git diff and Markdown rendering - no second consumer has asked
// for them yet.
//
// v4: registers `overlay: { width: '60%', anchor: 'center', margin: { top:
// 2, bottom: 2 } }` on its `tuiCommands.register()` call (acryl-cli's new
// per-command presentation hint, TuiCommandOverlayHint), so this renders as
// the actual compact centered popup pi-file-browser's own reference UI
// shows - chat history visible above it - instead of the full-screen
// takeover every dynamic command got before that hint existed. FilesOverlay
// now takes an optional `maxVisibleRows` (see the constructor and
// `listHeight()`) because `tui.terminal.rows` keeps reporting the whole
// terminal's height even inside a bounded popup - a plain pi-tui contract,
// confirmed directly against pi-tui's own `showOverlay` source - so sizing
// the list off it unmodified would size for the wrong box.

import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

export const name = 'dsh-editor-cli'

// tuiCommands is TUI-specific and only ever exists on acryl-cli's own Loader
// tree - declaring it in the static `inject` list means this plugin's own
// Fiber simply never activates on a surface that doesn't provide it (Web,
// Desktop), the same graceful-absence behavior dsh-community-market's own
// Desktop-only capabilities already rely on, rather than a hard crash.
export const inject = ['tuiCommands']

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 5000
const MAX_EDIT_LINES = 20000 // an editable buffer this codebase can reasonably hold/re-render per keystroke

// --- pure helpers (no pi-tui, no `this`) - kept free-standing so each one is
// independently callable/testable without constructing a FilesOverlay. ---

/** One directory's sorted, listable entries - directories first, then files, both alphabetical. */
export function listDirectory(path) {
  let names
  try {
    names = readdirSync(path, { withFileTypes: true })
  } catch (e) {
    return { error: String((e && e.message) ? e.message : e) }
  }
  const entries = []
  for (const entry of names) {
    if (entries.length >= MAX_ENTRIES) break
    if (entry.name.startsWith('.') && entry.name !== '..') continue
    entries.push({ name: entry.name, isDir: entry.isDirectory() || entry.isSymbolicLink() && isDirLink(path, entry.name) })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  if (path !== sep && dirname(path) !== path) entries.unshift({ name: '..', isDir: true })
  return { entries }
}

function isDirLink(path, name) {
  try {
    return statSync(join(path, name)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Fuzzy-filter and rank a directory listing, matching pi-file-browser's own
 * PanelModel._applyFilter exactly: directories before files, a name that
 * *starts with* the query before one that merely contains it, alphabetical
 * within each group. `..` always survives so "up" stays reachable while
 * filtering.
 */
export function filterEntries(entries, query) {
  if (query === '') return entries
  const needle = query.toLowerCase()
  const matched = entries.filter(e => e.name === '..' || e.name.toLowerCase().includes(needle))
  return matched.sort((a, b) => {
    if (a.name === '..') return -1
    if (b.name === '..') return 1
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1
    const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1
    if (aPrefix !== bPrefix) return aPrefix - bPrefix
    return a.name.localeCompare(b.name)
  })
}

/**
 * File-type icon lookup, adapted from pi-file-browser's own
 * FileTypeIconProvider (extension map + a handful of well-known directory
 * and special-filename overrides) - trimmed to the entries actually likely
 * to show up browsing a real project, not a line-for-line copy of every
 * extension it lists.
 */
const EXTENSION_ICONS = new Map([
  ['ts', '\u{1F7E6}'], ['tsx', '\u{1F7E6}'], ['js', '\u{1F7E2}'], ['jsx', '\u{1F7E2}'], ['mjs', '\u{1F7E2}'],
  ['py', '\u{1F40D}'], ['rb', '\u{1F48E}'], ['go', '\u{1F98B}'], ['rs', '\u{1F9E9}'],
  ['java', '☕'], ['c', '⚙'], ['cpp', '⚙'], ['h', '⚙'],
  ['html', '\u{1F310}'], ['css', '\u{1F3A8}'], ['scss', '\u{1F3A8}'],
  ['json', '\u{1F4E6}'], ['yaml', '\u{1F4E6}'], ['yml', '\u{1F4E6}'], ['toml', '\u{1F4E6}'],
  ['md', '\u{1F4DD}'], ['mdx', '\u{1F4DD}'], ['txt', '\u{1F4C4}'],
  ['sh', '\u{1F4BB}'], ['bash', '\u{1F4BB}'], ['zsh', '\u{1F4BB}'],
  ['lock', '\u{1F512}'], ['png', '\u{1F5BC}'], ['jpg', '\u{1F5BC}'], ['jpeg', '\u{1F5BC}'], ['svg', '\u{1F3A8}'],
  ['zip', '\u{1F5DC}'], ['tar', '\u{1F5DC}'], ['gz', '\u{1F5DC}'],
])
const DIRECTORY_ICONS = new Map([
  ['node_modules', '\u{1F4E6}'], ['src', '\u{1F4C2}'], ['dist', '\u{1F4E4}'], ['build', '\u{1F528}'],
  ['test', '✅'], ['tests', '✅'], ['.git', '\u{1F500}'], ['.github', '\u{1F500}'],
  ['docs', '\u{1F4DA}'], ['lib', '\u{1F4DA}'], ['scripts', '\u{1F4BB}'], ['bin', '⚡'],
])
const SPECIAL_FILE_ICONS = new Map([
  ['Makefile', '\u{1F528}'], ['Dockerfile', '\u{1F528}'],
  ['.gitignore', '\u{1F6AB}'], ['.dockerignore', '\u{1F6AB}'],
  ['package.json', '\u{1F4E6}'], ['tsconfig.json', '\u{1F4E6}'],
  ['LICENSE', '\u{1F4DC}'], ['README.md', '\u{1F4D6}'],
])
const DEFAULT_FILE_ICON = '\u{1F4C4}'
const DEFAULT_DIR_ICON = '\u{1F4C1}'
const UP_ICON = '⬆'

export function iconFor(entry) {
  if (entry.name === '..') return UP_ICON
  if (entry.isDir) return DIRECTORY_ICONS.get(entry.name) ?? DEFAULT_DIR_ICON
  const special = SPECIAL_FILE_ICONS.get(entry.name)
  if (special !== undefined) return special
  const dot = entry.name.lastIndexOf('.')
  if (dot >= 0) {
    const ext = EXTENSION_ICONS.get(entry.name.slice(dot + 1).toLowerCase())
    if (ext !== undefined) return ext
  }
  return DEFAULT_FILE_ICON
}

/** Read one file as display/edit lines, capped so a huge or binary file can't hang the render loop or an edit session. */
export function readFileLines(path) {
  let stat
  try {
    stat = statSync(path)
  } catch (e) {
    return { error: String((e && e.message) ? e.message : e) }
  }
  if (!stat.isFile()) return { error: 'not a regular file' }
  if (stat.size > MAX_FILE_BYTES) {
    return { error: `file is ${Math.round(stat.size / 1024 / 1024)} MB, over the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB display limit` }
  }
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch (e) {
    return { error: String((e && e.message) ? e.message : e) }
  }
  // A NUL byte is the simplest reliable "this isn't text" signal without a
  // real MIME/content sniff - good enough to avoid rendering garbage, and to
  // refuse editing something we can't safely round-trip as line-delimited text.
  if (content.indexOf(String.fromCharCode(0)) !== -1) return { error: 'binary file - not shown' }
  const hadTrailingNewline = content.length > 0 && /\r\n$|\r$|\n$/.test(content)
  const lines = content.length === 0 ? [''] : content.split(/\r\n|\r|\n/).slice(0, hadTrailingNewline ? -1 : undefined)
  if (lines.length > MAX_EDIT_LINES) {
    return { error: `file has ${lines.length} lines, over the ${MAX_EDIT_LINES}-line edit limit` }
  }
  return { lines, hadTrailingNewline }
}

/**
 * Write an edited buffer back to disk. Writes to a sibling temp file then
 * renames over the original (same directory, so the rename is same-filesystem
 * and atomic) - a mid-write crash or full disk leaves the original untouched
 * instead of a half-written file, the same discipline this repo's own
 * `dsh-atomic-write` package documents for durable state elsewhere.
 */
export function writeFileLines(path, lines, hadTrailingNewline) {
  const content = lines.join('\n') + (hadTrailingNewline ? '\n' : '')
  const tmpPath = join(dirname(path), `.dsh-editor-cli.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, path)
    return { ok: true }
  } catch (e) {
    try { unlinkSync(tmpPath) } catch {} // best-effort: no-op if the write itself never created it
    return { error: String((e && e.message) ? e.message : e) }
  }
}

// --- edit-buffer mutation ops: pure functions over {lines, row, col} so the
// cursor/text state machine is testable without a terminal. Each returns a
// new {lines, row, col}; none mutate their input, matching this codebase's
// preference for explicit state over hidden mutation. ---

export function editInsertChar(state, ch) {
  const { lines, row, col } = state
  const line = lines[row] ?? ''
  const nextLine = line.slice(0, col) + ch + line.slice(col)
  const nextLines = lines.slice()
  nextLines[row] = nextLine
  return { lines: nextLines, row, col: col + ch.length }
}

export function editBackspace(state) {
  const { lines, row, col } = state
  if (col > 0) {
    const line = lines[row] ?? ''
    const nextLine = line.slice(0, col - 1) + line.slice(col)
    const nextLines = lines.slice()
    nextLines[row] = nextLine
    return { lines: nextLines, row, col: col - 1 }
  }
  if (row === 0) return state // nothing before the first line's first column
  const prevLine = lines[row - 1] ?? ''
  const joined = prevLine + (lines[row] ?? '')
  const nextLines = lines.slice(0, row - 1).concat([joined], lines.slice(row + 1))
  return { lines: nextLines, row: row - 1, col: prevLine.length }
}

export function editNewline(state) {
  const { lines, row, col } = state
  const line = lines[row] ?? ''
  const before = line.slice(0, col)
  const after = line.slice(col)
  const nextLines = lines.slice(0, row).concat([before, after], lines.slice(row + 1))
  return { lines: nextLines, row: row + 1, col: 0 }
}

export function editMoveCursor(state, dRow, dCol) {
  const { lines } = state
  let row = Math.max(0, Math.min(lines.length - 1, state.row + dRow))
  let col = state.col
  if (dRow !== 0) {
    // Vertical moves clamp the column into the destination line's own length,
    // then remember nothing beyond that - simplest correct behavior; a
    // "sticky" preferred-column is a real editor refinement, not required here.
    col = Math.min(col, (lines[row] ?? '').length)
  } else {
    col = col + dCol
    if (col < 0) {
      if (row === 0) col = 0
      else { row -= 1; col = (lines[row] ?? '').length }
    } else if (col > (lines[row] ?? '').length) {
      if (row === lines.length - 1) col = (lines[row] ?? '').length
      else { row += 1; col = 0 }
    }
  }
  return { lines, row, col }
}

const RESET = '\x1b[0m'
const bold = s => `\x1b[1m${s}${RESET}`
const dim = s => `\x1b[2m${s}${RESET}`
const cyanBold = s => `\x1b[1;36m${s}${RESET}`
const yellowBold = s => `\x1b[1;33m${s}${RESET}`
const reverse = s => `\x1b[7m${s}\x1b[27m`

// Rounded-corner box, matching pi-file-browser's own FileBrowserComponent.addBorder.
const BOX_TL = '╭', BOX_TR = '╮', BOX_BL = '╰', BOX_BR = '╯', BOX_H = '─', BOX_V = '│'

/** Strip ANSI SGR codes to measure a line's real on-screen width, so box borders line up regardless of color codes already applied to `line`. */
function visibleLength(line) {
  return line.replace(/\x1b\[[0-9;]*m/gu, '').length
}

/**
 * Wrap already-rendered body lines in a bordered box with `title` in the top
 * edge, matching pi-file-browser's own bordered-panel look. `width` is the
 * box's own outer width (including the two border columns); body lines are
 * padded/truncated to fit the interior.
 */
function withBorder(title, bodyLines, width) {
  const inner = Math.max(1, width - 2)
  const titleText = ` ${title} `.slice(0, inner)
  const titlePad = Math.max(0, inner - visibleLength(titleText))
  const out = [dim(BOX_TL + BOX_H) + cyanBold(titleText) + dim(BOX_H.repeat(titlePad) + BOX_TR)]
  for (const line of bodyLines) {
    const pad = Math.max(0, inner - visibleLength(line))
    out.push(dim(BOX_V) + line + ' '.repeat(pad) + dim(BOX_V))
  }
  out.push(dim(BOX_BL + BOX_H.repeat(inner) + BOX_BR))
  return out
}

const ESCAPE = '\x1b'
const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'
const ARROW_RIGHT = '\x1b[C'
const ARROW_LEFT = '\x1b[D'
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const BACKSPACE = '\x7f'
const BACKSPACE_ALT = '\x08'
const CTRL_S = '\x13'
const ENTER = '\r'
const ENTER_ALT = '\n'

class FilesOverlay {
  constructor(tui, startDir, close, maxVisibleRows) {
    this.tui = tui
    this.close = close
    this.dir = startDir
    this.maxVisibleRows = maxVisibleRows
    this.selected = 0
    this.scrollOffset = 0
    this.mode = 'browse' // 'browse' | 'search' | 'view' | 'edit'
    this.entries = []
    this.filteredEntries = []
    this.dirError = undefined
    this.searchQuery = ''
    // One entry per directory level entered, so Escape/Left can pop back to
    // exactly where we came from and restore the selection to the child we
    // entered from - the same "remember what I came from" idiom
    // pi-file-browser's own PanelModel.goUp() uses, adapted to a plain stack
    // since this overlay has no separate nav-history/entries split.
    this.dirStack = []
    this.viewPath = undefined
    this.viewLines = undefined
    this.viewError = undefined
    this.viewHadTrailingNewline = undefined
    this.viewScroll = 0
    this.editState = undefined // { lines, row, col } while mode === 'edit'
    this.editScroll = 0
    this.editDirty = false
    this.editStatus = undefined
    this.reload()
  }

  reload() {
    const result = listDirectory(this.dir)
    this.entries = result.entries ?? []
    this.dirError = result.error
    this.applyFilter()
  }

  applyFilter() {
    this.filteredEntries = filterEntries(this.entries, this.searchQuery)
    this.selected = Math.min(this.selected, Math.max(0, this.filteredEntries.length - 1))
    this.scrollOffset = 0
  }

  invalidate() {}

  listHeight(chrome) {
    // `maxVisibleRows`, when set, bounds this to the compact popup's own
    // budget instead of the full terminal height: `tui.terminal.rows` still
    // reports the terminal's real height even when this component renders
    // inside a `showOverlay` popup narrower than the screen - `pi-tui`'s
    // `showOverlay` only bounds the width it passes to `render(width)`
    // (confirmed directly in its own `compositeOverlays`/`resolveOverlayLayout`
    // source), not what a component reads off `tui.terminal` itself. Without
    // this, a popup registration would still try to lay out a full-terminal-height
    // list and get silently truncated by the overlay's own maxHeight/margin
    // clamp rather than sizing itself to fit its box.
    const availableRows = Math.max(10, (this.maxVisibleRows ?? this.tui.terminal.rows) - 1)
    return Math.max(3, availableRows - chrome)
  }

  maxOffset(total, height) {
    return Math.max(0, total - height)
  }

  render(width) {
    if (this.mode === 'view') return this.renderView(width)
    if (this.mode === 'edit') return this.renderEdit(width)
    return this.renderBrowse(width)
  }

  /** Selection centered in the visible window rather than merely kept on-screen, matching pi-file-browser's own PanelModel scroll behavior. */
  centeredOffset(total, selected, height) {
    if (total <= height) return 0
    const half = Math.floor(height / 2)
    return Math.min(Math.max(0, selected - half), Math.max(0, total - height))
  }

  renderBrowse(width) {
    // border(2) + status line(1) + hint line(1)
    const height = this.listHeight(4)
    if (this.dirError !== undefined) {
      return withBorder(this.dir, [`  ${this.dirError}`, dim('esc close')], width)
    }
    const offset = this.centeredOffset(this.filteredEntries.length, this.selected, height)
    const body = []
    for (let i = 0; i < height; i++) {
      const index = offset + i
      const entry = this.filteredEntries[index]
      if (entry === undefined) { body.push('') ; continue }
      const marker = index === this.selected ? cyanBold('> ') : '  '
      const suffix = entry.isDir && entry.name !== '..' ? '/' : ''
      const label = `${iconFor(entry)} ${entry.name}${suffix}`
      const styled = index === this.selected ? reverse(label) : entry.isDir ? cyanBold(label) : label
      body.push(`${marker}${styled}`)
    }
    if (this.filteredEntries.length === 0) body[0] = dim(this.searchQuery === '' ? '  (empty)' : '  (no matches)')
    const selectedEntry = this.filteredEntries[this.selected]
    const status = selectedEntry === undefined
      ? dim('(empty)')
      : dim(`${selectedEntry.isDir ? 'DIR' : 'FILE'}  ${selectedEntry.name}`)
    body.push(this.searchQuery === '' ? status : cyanBold(`\u{1F50D} /${this.searchQuery}`) + `  ${dim(`(${this.filteredEntries.length} match${this.filteredEntries.length === 1 ? '' : 'es'})`)}`)
    const backHint = this.dirStack.length > 0 ? 'esc/← back' : 'esc close'
    body.push(dim(`↑↓/jk move · →/enter open · ${backHint} · type to filter`))
    return withBorder(this.dir, body, width)
  }

  renderView(width) {
    // border(2) + hint line(1)
    const height = this.listHeight(3)
    if (this.viewError !== undefined) {
      return withBorder(`File — ${this.viewPath}`, [`  ${this.viewError}`, dim('esc back')], width)
    }
    const total = this.viewLines?.length ?? 0
    const offset = Math.min(this.viewScroll, this.maxOffset(total, height))
    const windowed = (this.viewLines ?? []).slice(offset, offset + height)
    const gutterWidth = String(offset + windowed.length).length
    const body = windowed.map((line, i) => `${dim(String(offset + i + 1).padStart(gutterWidth))}  ${line}`)
    body.push(dim(`↑↓/jk scroll · e edit · esc back (line ${offset + 1}-${offset + windowed.length} of ${total})`))
    return withBorder(`File — ${this.viewPath}`, body, width)
  }

  renderEdit(width) {
    // border(2) + hint line(1)
    const height = this.listHeight(3)
    const { lines, row, col } = this.editState
    const offset = Math.min(this.editScroll, this.maxOffset(lines.length, height))
    const gutterWidth = String(Math.max(offset + height, lines.length)).length
    const dirtyMark = this.editDirty ? yellowBold(' [modified]') : ''
    const windowed = lines.slice(offset, offset + height)
    const body = windowed.map((line, i) => {
      const lineIndex = offset + i
      const gutter = dim(String(lineIndex + 1).padStart(gutterWidth))
      if (lineIndex !== row) return `${gutter}  ${line}`
      const before = line.slice(0, col)
      const at = line.slice(col, col + 1) || ' '
      const after = line.slice(col + 1)
      // Reverse-video the cursor cell so its position is visible without a
      // real terminal cursor - pi-tui's Component contract is a plain
      // string per row, it doesn't expose native cursor placement here.
      return `${gutter}  ${before}${reverse(at)}${after}`
    })
    body.push(dim(`${this.editStatus ?? 'type to edit'} · ctrl+s save · esc discard & back`))
    return withBorder(`Edit — ${this.viewPath}${dirtyMark}`, body, width)
  }

  handleInput(data) {
    if (this.mode === 'view') return this.handleViewInput(data)
    if (this.mode === 'edit') return this.handleEditInput(data)
    if (this.mode === 'search') return this.handleSearchInput(data)
    return this.handleBrowseInput(data)
  }

  /** Pop one level of the directory stack, restoring the selection to the child directory we came from. */
  goUpOneLevel() {
    const entry = this.dirStack.pop()
    if (entry === undefined) return false
    this.dir = entry.dir
    this.searchQuery = ''
    this.reload()
    const idx = this.filteredEntries.findIndex(e => e.name === entry.childName)
    this.selected = idx >= 0 ? idx : 0
    this.scrollOffset = 0
    return true
  }

  handleBrowseInput(data) {
    if (data === ESCAPE || data === ARROW_LEFT || data === 'h') {
      if (this.goUpOneLevel()) return
      if (data === 'h') return // plain 'h' with nothing to go up to is not a close shortcut
      this.close()
      return
    }
    if (data === 'q') {
      this.close()
      return
    }
    if (data === '/') {
      this.mode = 'search'
      return
    }
    if (data === ARROW_UP || data === 'k') {
      this.selected = Math.max(0, this.selected - 1)
      return
    }
    if (data === ARROW_DOWN || data === 'j') {
      this.selected = Math.min(Math.max(0, this.filteredEntries.length - 1), this.selected + 1)
      return
    }
    if (data === ENTER || data === ENTER_ALT || data === ARROW_RIGHT || data === 'l') {
      this.openSelected()
      return
    }
    // Any other single printable character auto-activates search seeded with
    // it (fzf-style), matching pi-file-browser's own FileBrowserComponent
    // behavior: browsing mode treats an unrecognized printable keystroke as
    // "start filtering", not a no-op - you don't have to press / first.
    if (data.length === 1) {
      const code = data.charCodeAt(0)
      if (code >= 0x20 && code < 0x7f) {
        this.mode = 'search'
        this.searchQuery = data
        this.applyFilter()
      }
    }
  }

  openSelected() {
    const entry = this.filteredEntries[this.selected]
    if (entry === undefined) return
    if (entry.name === '..') {
      if (!this.goUpOneLevel()) {
        // No stack entry (started at a root-ish path and navigated via '..'
        // rather than drilling in) - fall back to a plain parent-dir move
        // with no "restore selection" target to return to.
        this.dir = dirname(this.dir)
        this.searchQuery = ''
        this.reload()
      }
      return
    }
    const path = join(this.dir, entry.name)
    if (entry.isDir) {
      this.dirStack.push({ dir: this.dir, childName: entry.name })
      this.dir = path
      this.searchQuery = ''
      this.reload()
      return
    }
    this.openFile(path)
  }

  handleSearchInput(data) {
    if (data === ESCAPE) {
      this.searchQuery = ''
      this.applyFilter()
      this.mode = 'browse'
      return
    }
    if (data === ENTER || data === ENTER_ALT) {
      this.mode = 'browse'
      this.openSelected()
      return
    }
    if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.searchQuery = this.searchQuery.slice(0, -1)
      this.applyFilter()
      return
    }
    if (data === ARROW_UP) {
      this.selected = Math.max(0, this.selected - 1)
      return
    }
    if (data === ARROW_DOWN) {
      this.selected = Math.min(Math.max(0, this.filteredEntries.length - 1), this.selected + 1)
      return
    }
    // Printable characters extend the filter (fzf-style incremental search,
    // matching pi-file-browser's own auto-activate-on-printable-char pattern
    // for the *first* keystroke - here search is already an explicit mode
    // entered via '/', so every printable char while in it is filter text).
    if (data.length === 1) {
      const code = data.charCodeAt(0)
      if (code >= 0x20 && code < 0x7f) {
        this.searchQuery += data
        this.applyFilter()
      }
    }
  }

  openFile(path) {
    const result = readFileLines(path)
    this.viewPath = path
    this.viewLines = result.lines
    this.viewError = result.error
    this.viewHadTrailingNewline = result.hadTrailingNewline
    this.viewScroll = 0
    this.mode = 'view'
  }

  handleViewInput(data) {
    if (data === ESCAPE || data === ARROW_LEFT) {
      this.mode = 'browse'
      return
    }
    if (data === 'e' && this.viewError === undefined) {
      this.editState = { lines: (this.viewLines ?? ['']).slice(), row: 0, col: 0 }
      this.editScroll = 0
      this.editDirty = false
      this.editStatus = undefined
      this.mode = 'edit'
      return
    }
    const height = this.listHeight(3) // border(2) + hint line(1), matching renderView
    const total = this.viewLines?.length ?? 0
    if (data === ARROW_UP || data === 'k') {
      this.viewScroll = Math.max(0, this.viewScroll - 1)
      return
    }
    if (data === ARROW_DOWN || data === 'j') {
      this.viewScroll = Math.min(this.maxOffset(total, height), this.viewScroll + 1)
      return
    }
    if (data === PAGE_UP) {
      this.viewScroll = Math.max(0, this.viewScroll - height)
      return
    }
    if (data === PAGE_DOWN) {
      this.viewScroll = Math.min(this.maxOffset(total, height), this.viewScroll + height)
    }
  }

  followEditCursor() {
    const height = this.listHeight(3) // border(2) + hint line(1), matching renderEdit
    if (this.editState.row < this.editScroll) this.editScroll = this.editState.row
    else if (this.editState.row >= this.editScroll + height) this.editScroll = this.editState.row - height + 1
  }

  handleEditInput(data) {
    if (data === ESCAPE) {
      // Discard-on-escape, no confirmation prompt: this plugin has no modal
      // dialog primitive to ask "discard changes?" without adding a whole
      // second overlay mode for one rare path - documented here so it's a
      // deliberate simplicity trade, not an oversight.
      this.mode = 'view'
      return
    }
    if (data === CTRL_S) {
      const result = writeFileLines(this.viewPath, this.editState.lines, this.viewHadTrailingNewline)
      if (result.error !== undefined) {
        this.editStatus = `save failed: ${result.error}`
        return
      }
      this.viewLines = this.editState.lines.slice()
      this.editDirty = false
      this.editStatus = 'saved'
      return
    }
    if (data === ARROW_UP) { this.editState = editMoveCursor(this.editState, -1, 0); this.followEditCursor(); return }
    if (data === ARROW_DOWN) { this.editState = editMoveCursor(this.editState, 1, 0); this.followEditCursor(); return }
    if (data === ARROW_LEFT) { this.editState = editMoveCursor(this.editState, 0, -1); this.followEditCursor(); return }
    if (data === ARROW_RIGHT) { this.editState = editMoveCursor(this.editState, 0, 1); this.followEditCursor(); return }
    if (data === BACKSPACE || data === BACKSPACE_ALT) {
      this.editState = editBackspace(this.editState)
      this.editDirty = true
      this.editStatus = undefined
      this.followEditCursor()
      return
    }
    if (data === ENTER || data === ENTER_ALT) {
      if (this.editState.lines.length >= MAX_EDIT_LINES) {
        this.editStatus = `at the ${MAX_EDIT_LINES}-line edit limit`
        return
      }
      this.editState = editNewline(this.editState)
      this.editDirty = true
      this.editStatus = undefined
      this.followEditCursor()
      return
    }
    // Any other single printable character inserts at the cursor. Multi-byte
    // escape sequences (unhandled arrow variants, function keys, etc.) are
    // deliberately ignored rather than inserted verbatim, so a stray key
    // combo this overlay doesn't recognize can't corrupt the buffer with
    // control bytes.
    if (data.length === 1) {
      const code = data.charCodeAt(0)
      if (code >= 0x20 && code < 0x7f) {
        this.editState = editInsertChar(this.editState, data)
        this.editDirty = true
        this.editStatus = undefined
      }
      return
    }
    if (/^[ -￿]$/u.test(data)) {
      // A single non-ASCII printable character (paste of accented text, etc.)
      this.editState = editInsertChar(this.editState, data)
      this.editDirty = true
      this.editStatus = undefined
    }
  }
}

export function apply(ctx) {
  const dispose = ctx.tuiCommands.register({
    command: '/files',
    description: 'Browse, view, and edit files',
    packageName: 'acryl-dsh-editor-plugin-cli',
    // Compact centered popup, matching almegal/pi-file-browser's own real
    // running UI exactly (`ctx.ui.custom(builder, { overlay: true,
    // overlayOptions: { width: '60%', anchor: 'center', margin: { top: 2,
    // bottom: 2 } } })`) - a file browser doesn't need the full-screen
    // treatment `/plugins`' 90-row list genuinely does, and leaving the
    // chat transcript visible above it (as the reference screenshot showed)
    // is the whole point of a popup over a takeover.
    overlay: { width: '60%', anchor: 'center', margin: { top: 2, bottom: 2 } },
    open: ({ tui, close }) => {
      // Mirrors the margin above: with 2 rows reserved top and bottom, the
      // popup's own vertical budget is `terminal.rows - 4`, not the full
      // terminal height `listHeight()` would otherwise assume it owns.
      const maxVisibleRows = Math.max(10, tui.terminal.rows - 4)
      return new FilesOverlay(tui, homedir(), close, maxVisibleRows)
    },
  })
  ctx.effect(() => dispose, 'dsh-editor-cli: /files command')
}
