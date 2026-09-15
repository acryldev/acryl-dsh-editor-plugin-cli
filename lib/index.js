// DSH Editor (CLI) — a TUI-native file browser and viewer.
//
// Standard Cordis plugin mounted via cordis.patch.yml (see package.json
// `dsh.bundle.patch`). Registers a `/files` command with `tuiCommands`
// (acryl-cli's own TUI presentation-slot extension point, spec 034 T009) -
// there is no Host/Client split the way the Web sibling plugin
// (acryl-dsh-editor-plugin-web) needs: the CLI and its Cordis Loader tree
// share one process, so this file both registers the command AND reads
// files directly, in-process, with no wire protocol to design.
//
// Deliberately v1-scoped: browse and view files (read-only). No editing, no
// search, no git diff, no Markdown rendering - those are real, separate
// follow-up work once this seam has a second real consumer to generalize
// from, not features to guess at up front.

import { readdirSync, readFileSync, statSync } from 'node:fs'
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

/** One directory's sorted, listable entries - directories first, then files, both alphabetical. */
function listDirectory(path) {
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

/** Read one file as display lines, capped so a huge or binary file can't hang the render loop. */
function readFileLines(path) {
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
  // real MIME/content sniff - good enough to avoid rendering garbage.
  if (content.indexOf(String.fromCharCode(0)) !== -1) return { error: 'binary file - not shown' }
  return { lines: content.split(/\r\n|\r|\n/) }
}

const RESET = '\x1b[0m'
const bold = s => `\x1b[1m${s}${RESET}`
const dim = s => `\x1b[2m${s}${RESET}`
const cyanBold = s => `\x1b[1;36m${s}${RESET}`

class FilesOverlay {
  constructor(tui, startDir, close) {
    this.tui = tui
    this.close = close
    this.dir = startDir
    this.selected = 0
    this.scrollOffset = 0
    this.mode = 'browse' // 'browse' | 'view'
    this.entries = []
    this.dirError = undefined
    this.viewPath = undefined
    this.viewLines = undefined
    this.viewError = undefined
    this.viewScroll = 0
    this.reload()
  }

  reload() {
    const result = listDirectory(this.dir)
    this.entries = result.entries ?? []
    this.dirError = result.error
    this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1))
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
    return this.renderBrowse(width)
  }

  renderBrowse(_width) {
    const height = this.listHeight()
    const offset = Math.min(this.scrollOffset, this.maxOffset(this.entries.length, height))
    const lines = [bold(cyanBold(`Files — ${this.dir}`))]
    if (this.dirError !== undefined) {
      lines.push(`  ${this.dirError}`)
      lines.push(dim('esc close'))
      return lines
    }
    const windowed = this.entries.slice(offset, offset + height)
    windowed.forEach((entry, i) => {
      const index = offset + i
      const marker = index === this.selected ? '> ' : '  '
      const label = entry.isDir ? `${entry.name}/` : entry.name
      const line = `${marker}${entry.isDir ? bold(label) : label}`
      lines.push(index === this.selected ? cyanBold(line) : line)
    })
    if (this.entries.length === 0) lines.push(dim('  (empty)'))
    lines.push(dim('↑↓ move · enter open · esc close'))
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
    lines.push(dim(`↑↓ scroll · esc back (line ${offset + 1}-${offset + windowed.length} of ${total})`))
    return lines
  }

  handleInput(data) {
    if (this.mode === 'view') {
      this.handleViewInput(data)
      return
    }
    this.handleBrowseInput(data)
  }

  handleBrowseInput(data) {
    if (data === '\x1b' || data === 'q') {
      this.close()
      return
    }
    const height = this.listHeight()
    if (data === '\x1b[A') { // up
      this.selected = Math.max(0, this.selected - 1)
      if (this.selected < this.scrollOffset) this.scrollOffset = this.selected
      return
    }
    if (data === '\x1b[B') { // down
      this.selected = Math.min(Math.max(0, this.entries.length - 1), this.selected + 1)
      if (this.selected >= this.scrollOffset + height) this.scrollOffset = this.selected - height + 1
      return
    }
    if (data === '\r' || data === '\n') {
      const entry = this.entries[this.selected]
      if (entry === undefined) return
      if (entry.name === '..') {
        this.dir = dirname(this.dir)
        this.reload()
        return
      }
      const path = join(this.dir, entry.name)
      if (entry.isDir) {
        this.dir = path
        this.reload()
        return
      }
      this.openFile(path)
    }
  }

  openFile(path) {
    const result = readFileLines(path)
    this.viewPath = path
    this.viewLines = result.lines
    this.viewError = result.error
    this.viewScroll = 0
    this.mode = 'view'
  }

  handleViewInput(data) {
    if (data === '\x1b') {
      this.mode = 'browse'
      return
    }
    const height = this.listHeight()
    const total = this.viewLines?.length ?? 0
    if (data === '\x1b[A') {
      this.viewScroll = Math.max(0, this.viewScroll - 1)
      return
    }
    if (data === '\x1b[B') {
      this.viewScroll = Math.min(this.maxOffset(total, height), this.viewScroll + 1)
      return
    }
    if (data === '\x1b[5~') { // page up
      this.viewScroll = Math.max(0, this.viewScroll - height)
      return
    }
    if (data === '\x1b[6~') { // page down
      this.viewScroll = Math.min(this.maxOffset(total, height), this.viewScroll + height)
    }
  }
}

export function apply(ctx) {
  const dispose = ctx.tuiCommands.register({
    command: '/files',
    description: 'Browse and view files',
    packageName: 'acryl-dsh-editor-plugin-cli',
    open: ({ tui, close }) => new FilesOverlay(tui, homedir(), close),
  })
  ctx.effect(() => dispose, 'dsh-editor-cli: /files command')
}
