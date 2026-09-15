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
// v2: browse, search-filter, view, and edit-in-place. Navigation and key
// conventions (h/j/k/l alongside arrows, `/` to filter, Escape/Left as one
// "go back" action rather than only "close") follow the same shape as
// almegal/pi-file-browser's NavigationInputHandler + PanelModel - adapted,
// not copied line-for-line, since that project targets a dual-pane picker
// and this stays a single-pane browser embedded in one pi-tui Component.
// Syntax highlighting (clarkarch/tfm-tui's approach) was deliberately not
// ported: it depends on @opentui/core's native CodeRenderable/tree-sitter
// stack, which is a different rendering model than pi-tui's plain
// `render(width): string[]` line contract this plugin renders through -
// pulling it in would mean a second UI framework in one process, not a
// reusable pattern. Still deferred, unforced: git diff and Markdown
// rendering - no second consumer has asked for them yet.

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

/** Case-insensitive substring filter over a directory listing - `..` always survives so "up" stays reachable while filtering. */
export function filterEntries(entries, query) {
  if (query === '') return entries
  const needle = query.toLowerCase()
  return entries.filter(e => e.name === '..' || e.name.toLowerCase().includes(needle))
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
  constructor(tui, startDir, close) {
    this.tui = tui
    this.close = close
    this.dir = startDir
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

  listHeight() {
    const availableRows = Math.max(10, this.tui.terminal.rows - 1)
    return Math.max(3, availableRows - 3)
  }

  maxOffset(total, height) {
    return Math.max(0, total - height)
  }

  render(width) {
    if (this.mode === 'view') return this.renderView(width)
    if (this.mode === 'edit') return this.renderEdit(width)
    return this.renderBrowse(width)
  }

  renderBrowse(_width) {
    const height = this.listHeight()
    const offset = Math.min(this.scrollOffset, this.maxOffset(this.filteredEntries.length, height))
    const header = this.searchQuery === ''
      ? bold(cyanBold(`Files — ${this.dir}`))
      : bold(cyanBold(`Files — ${this.dir}`)) + '  ' + dim(`/${this.searchQuery}`)
    const lines = [header]
    if (this.dirError !== undefined) {
      lines.push(`  ${this.dirError}`)
      lines.push(dim('esc close'))
      return lines
    }
    const windowed = this.filteredEntries.slice(offset, offset + height)
    windowed.forEach((entry, i) => {
      const index = offset + i
      const marker = index === this.selected ? '> ' : '  '
      const label = entry.isDir ? `${entry.name}/` : entry.name
      const line = `${marker}${entry.isDir ? bold(label) : label}`
      lines.push(index === this.selected ? cyanBold(line) : line)
    })
    if (this.filteredEntries.length === 0) lines.push(dim(this.searchQuery === '' ? '  (empty)' : '  (no matches)'))
    const backHint = this.dirStack.length > 0 ? 'esc/← back' : 'esc close'
    lines.push(dim(`↑↓/jk move · →/enter open · ${backHint} · / filter`))
    return lines
  }

  renderView(_width) {
    const height = this.listHeight()
    const lines = [bold(cyanBold(`File — ${this.viewPath}`))]
    if (this.viewError !== undefined) {
      lines.push(`  ${this.viewError}`)
      lines.push(dim('esc back'))
      return lines
    }
    const total = this.viewLines?.length ?? 0
    const offset = Math.min(this.viewScroll, this.maxOffset(total, height))
    const windowed = (this.viewLines ?? []).slice(offset, offset + height)
    const gutterWidth = String(offset + windowed.length).length
    windowed.forEach((line, i) => {
      lines.push(`${dim(String(offset + i + 1).padStart(gutterWidth))}  ${line}`)
    })
    lines.push(dim(`↑↓/jk scroll · e edit · esc back (line ${offset + 1}-${offset + windowed.length} of ${total})`))
    return lines
  }

  renderEdit(_width) {
    const height = this.listHeight()
    const { lines, row, col } = this.editState
    const offset = Math.min(this.editScroll, this.maxOffset(lines.length, height))
    const gutterWidth = String(Math.max(offset + height, lines.length)).length
    const dirtyMark = this.editDirty ? yellowBold(' [modified]') : ''
    const out = [bold(cyanBold(`Edit — ${this.viewPath}`)) + dirtyMark]
    const windowed = lines.slice(offset, offset + height)
    windowed.forEach((line, i) => {
      const lineIndex = offset + i
      const gutter = dim(String(lineIndex + 1).padStart(gutterWidth))
      if (lineIndex === row) {
        const before = line.slice(0, col)
        const at = line.slice(col, col + 1) || ' '
        const after = line.slice(col + 1)
        // Reverse-video the cursor cell so its position is visible without a
        // real terminal cursor - pi-tui's Component contract is a plain
        // string per row, it doesn't expose native cursor placement here.
        out.push(`${gutter}  ${before}\x1b[7m${at}\x1b[27m${after}`)
      } else {
        out.push(`${gutter}  ${line}`)
      }
    })
    out.push(dim(`${this.editStatus ?? 'type to edit'} · ctrl+s save · esc discard & back`))
    return out
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
    const height = this.listHeight()
    if (data === ARROW_UP || data === 'k') {
      this.selected = Math.max(0, this.selected - 1)
      if (this.selected < this.scrollOffset) this.scrollOffset = this.selected
      return
    }
    if (data === ARROW_DOWN || data === 'j') {
      this.selected = Math.min(Math.max(0, this.filteredEntries.length - 1), this.selected + 1)
      if (this.selected >= this.scrollOffset + height) this.scrollOffset = this.selected - height + 1
      return
    }
    if (data === ENTER || data === ENTER_ALT || data === ARROW_RIGHT || data === 'l') {
      this.openSelected()
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
    const height = this.listHeight()
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
    const height = this.listHeight()
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
    open: ({ tui, close }) => new FilesOverlay(tui, homedir(), close),
  })
  ctx.effect(() => dispose, 'dsh-editor-cli: /files command')
}
