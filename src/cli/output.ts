/**
 * How commands write (cli-spec 6.1, 5.2). Three formats:
 * - text: human lines. Every untrusted string (titles, prompts, agent names, transcript text, paths, host error
 *   messages) goes through `safe` / `safeLine` (sanitizeTty) BEFORE any ANSI styling is added, so an agent can never
 *   smuggle an escape sequence to the terminal. Colour only when ctx.globals.color.
 * - json: one pretty object with `schemaVersion` first, through `jsonText`: JSON.stringify escapes only U+0000-U+001F,
 *   so DEL, the C1 controls U+0080-U+009F (U+009B is a one-byte CSI), the bidi controls, zero-width characters,
 *   U+2028 / U+2029 and the BOM are escaped as \uXXXX too. The parsed value is unchanged; a terminal never sees them raw.
 * - stream-json: one compact object per line, each with `schemaVersion`, through `jsonText` as well. A non-streaming
 *   command prints one line.
 */
import { sanitizeTty } from './tui/sanitizeTty'
import { CLI_JSON_SCHEMA_VERSION, type CliContext } from './types'

export type Json = Record<string, unknown>

/**
 * Characters JSON.stringify leaves raw that a terminal (or a reader) may act on: DEL and the C1 controls, Arabic letter
 * mark, zero-width space / joiners and marks, line and paragraph separators, the bidi embeddings / overrides /
 * isolates, the word joiner and invisible operators, and the BOM. They only ever occur inside JSON strings.
 */
const JSON_UNSAFE_RE = /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/**
 * JSON.stringify(value, null, indent) with every JSON_UNSAFE_RE character written as a \uXXXX escape (review M15).
 * JSON.parse of the result equals JSON.parse of the plain stringify.
 */
export function jsonText(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(JSON_UNSAFE_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** True for json and stream-json. */
export const isJsonOutput = (ctx: CliContext): boolean => ctx.globals.outputFormat !== 'text'

/** `{ schemaVersion, ...value }` (schemaVersion always first, never overridden). */
export function withSchema(value: Json): Json {
  const rest = { ...value }
  delete rest.schemaVersion
  return { schemaVersion: CLI_JSON_SCHEMA_VERSION, ...rest }
}

/**
 * Print a command's result: `value` as JSON (pretty for json, one compact line for stream-json), else the lines
 * `text()` returns. `text` must build its strings with `safe` / `safeLine` for untrusted parts.
 */
export function emit(ctx: CliContext, value: Json, text: () => string | string[]): void {
  const fmt = ctx.globals.outputFormat
  if (fmt === 'json') {
    ctx.io.stdout.write(`${jsonText(withSchema(value), 2)}\n`)
    return
  }
  if (fmt === 'stream-json') {
    emitLine(ctx, value)
    return
  }
  const out = text()
  const lines = Array.isArray(out) ? out : [out]
  if (lines.length > 0) ctx.io.stdout.write(`${lines.join('\n')}\n`)
}

/** One compact JSON line with schemaVersion (stream-json records, and json mode of streaming commands). */
export function emitLine(ctx: CliContext, value: Json): void {
  ctx.io.stdout.write(`${jsonText(withSchema(value))}\n`)
}

/** Text lines to stdout (text mode only; ignored for JSON formats). */
export function printText(ctx: CliContext, lines: string | string[]): void {
  if (isJsonOutput(ctx)) return
  const list = Array.isArray(lines) ? lines : [lines]
  if (list.length > 0) ctx.io.stdout.write(`${list.join('\n')}\n`)
}

/** A one-line note on stderr, text mode only (JSON consumers read hostState instead). */
export function note(ctx: CliContext, message: string): void {
  if (isJsonOutput(ctx)) return
  ctx.io.stderr.write(`${safeLine(message)}\n`)
}

/** A line on stderr in every format (warnings a script should still see, e.g. version skew). */
export function warn(ctx: CliContext, message: string): void {
  ctx.io.stderr.write(`${safeLine(message)}\n`)
}

// ---------- Sanitizing ----------

/** sanitizeTty over any value (newlines and tabs kept). */
export function safe(s: unknown): string {
  return sanitizeTty(s === undefined || s === null ? '' : String(s))
}

/** sanitizeTty, then every run of whitespace (newlines included) collapsed to one space and trimmed. */
export function safeLine(s: unknown): string {
  return safe(s).replace(/\s+/g, ' ').trim()
}

// ---------- Style ----------

export interface Style {
  bold(s: string): string
  dim(s: string): string
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  cyan(s: string): string
}

const sgr = (open: number, close: number) => (s: string) => (s ? `\x1b[${open}m${s}\x1b[${close}m` : s)
const PLAIN: Style = { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s }
const COLOR: Style = { bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), cyan: sgr(36, 39) }

/** ANSI styling when ctx.globals.color, else identity functions. Apply only to already-sanitized text. */
export function styleFor(ctx: CliContext): Style {
  return ctx.globals.color ? COLOR : PLAIN
}

/** The colour of a status word (statusText output). */
export function styleStatus(st: Style, word: string): string {
  switch (word) {
    case 'Running':
      return st.cyan(word)
    case 'Needs you':
      return st.yellow(word)
    case 'Failed':
      return st.red(word)
    case 'Finished':
      return st.green(word)
    default:
      return st.dim(word)
  }
}

// ---------- Width and tables ----------

/** Terminal width: io.stdout.columns, default 100, never below 40. */
export function termWidth(ctx: CliContext): number {
  const c = ctx.io.stdout.columns
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? Math.max(40, Math.floor(c)) : 100
}

const chars = (s: string): string[] => Array.from(s)

/** Display length in code points (wide characters count as one; good enough for tables). */
export const textWidth = (s: string): number => chars(s).length

/** Cut to `width` with a trailing '…'. */
export function ellipsisEnd(s: string, width: number): string {
  const cs = chars(s)
  if (cs.length <= width) return s
  if (width <= 1) return width === 1 ? '…' : ''
  return `${cs.slice(0, width - 1).join('')}…`
}

/** Cut to `width` keeping both ends ("/Users/me/…/project"). */
export function ellipsisMiddle(s: string, width: number): string {
  const cs = chars(s)
  if (cs.length <= width) return s
  if (width <= 1) return width === 1 ? '…' : ''
  const head = Math.ceil((width - 1) / 2)
  const tail = width - 1 - head
  return `${cs.slice(0, head).join('')}…${tail > 0 ? cs.slice(cs.length - tail).join('') : ''}`
}

export interface TableColumn {
  header: string
  /** 'end' (default) or 'middle' ellipsis when the column must shrink. */
  ellipsis?: 'end' | 'middle'
  /** This column takes the room left over (and shrinks first). At most one; default the widest. */
  flex?: boolean
  /** Never shrink below this (default 4). */
  min?: number
  align?: 'left' | 'right'
  /** Styling applied to a cell after fitting (cells are sanitized text). */
  style?: (cell: string, row: number) => string
}

/**
 * Lay out a table that fits `width`: two spaces between columns, the flex column shrinks first, then the others in
 * turn down to their minimum. Cells must already be sanitized one-line text; styling comes after the fit.
 */
export function table(cols: readonly TableColumn[], rows: readonly string[][], width: number, st: Style): string[] {
  const gap = 2
  const widths = cols.map((c, i) => Math.max(textWidth(c.header), ...rows.map((r) => textWidth(r[i] ?? ''))))
  const total = (): number => widths.reduce((a, b) => a + b, 0) + gap * (cols.length - 1)
  let flex = cols.findIndex((c) => c.flex)
  if (flex === -1) flex = widths.indexOf(Math.max(...widths))
  const order = [flex, ...cols.map((_, i) => i).filter((i) => i !== flex).sort((a, b) => widths[b] - widths[a])]
  for (const i of order) {
    const over = total() - width
    if (over <= 0) break
    const min = cols[i].min ?? 4
    widths[i] = Math.max(min, widths[i] - over)
  }
  const fit = (s: string, i: number): string => {
    const w = widths[i]
    const cut = (cols[i].ellipsis ?? 'end') === 'middle' ? ellipsisMiddle(s, w) : ellipsisEnd(s, w)
    return cut
  }
  const pad = (s: string, i: number, last: boolean): string => {
    const room = widths[i] - textWidth(s)
    if (cols[i].align === 'right') return ' '.repeat(Math.max(0, room)) + s
    return last ? s : s + ' '.repeat(Math.max(0, room))
  }
  const line = (cells: string[], row: number, header: boolean): string =>
    cells
      .map((cell, i) => {
        const fitted = fit(cell ?? '', i)
        const padded = pad(fitted, i, i === cells.length - 1)
        if (header) return st.dim(padded)
        const style = cols[i].style
        if (!style) return padded
        // Style the text only, then restore the padding (escape codes have no width).
        const trimmedRight = padded.trimEnd()
        const left = padded.length - padded.trimStart().length
        const core = padded.slice(left, trimmedRight.length)
        return padded.slice(0, left) + style(core, row) + padded.slice(trimmedRight.length)
      })
      .join(' '.repeat(gap))
      .trimEnd()
  return [line(cols.map((c) => c.header), -1, true), ...rows.map((r, i) => line(r, i, false))]
}

// ---------- Time ----------

/** "just now", "45s ago", "5m ago", "3h ago", "2d ago", else the date ("4 Nov 2026"). */
export function relativeTime(ms: number | undefined, now: number, formatDate: (ms: number) => string): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = Math.max(0, now - ms)
  const s = Math.floor(d / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 14) return `${days}d ago`
  return formatDate(ms)
}

/** "45s", "5m", "3h 05m", "2d 4h" for an uptime. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** "1 live run", "2 live runs". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
