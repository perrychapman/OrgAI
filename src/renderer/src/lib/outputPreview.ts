// Pure helpers for the output previews (docs/design/outputs.md section 4). No React, no DOM, no store.
import type { SheetCell } from '@shared/types'

/** Number with `decimals` places, optionally grouped with commas. */
function fixed(n: number, decimals: number, group: boolean): string {
  const s = n.toFixed(decimals)
  if (!group) return s
  const [int, frac] = s.split('.')
  const neg = int.startsWith('-')
  const digits = neg ? int.slice(1) : int
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

/** What a sheet cell shows: the number format applied for percent and fixed decimals, else the plain value. */
export function sheetCellText(cell: SheetCell | null | undefined): string {
  if (!cell) return ''
  const { v, fmt } = cell
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number' && Number.isFinite(v) && fmt) {
    if (fmt.includes('%')) {
      const pct = v * 100
      const m = /0\.(0+)%/.exec(fmt)
      if (m) return `${fixed(pct, Math.min(m[1].length, 2), false)}%`
      return `${String(Math.round(pct * 100) / 100)}%`
    }
    if (fmt.includes('0.00')) return fixed(v, 2, fmt.includes(','))
    if (fmt.includes(',') && fmt.includes('#,##0')) return fixed(v, 0, true)
  }
  return String(v)
}

/** True for a cell that holds a number (right-aligned). */
export function isNumericCell(cell: SheetCell | null | undefined): boolean {
  return !!cell && typeof cell.v === 'number' && Number.isFinite(cell.v)
}

/** 0 -> A, 25 -> Z, 26 -> AA, 701 -> ZZ, 702 -> AAA. */
export function columnLetter(i: number): string {
  let n = Math.max(0, Math.floor(i)) + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** A formula as shown in a title: "=SUM(B2:B4)" with a leading = whether or not the file stored one. */
export function formulaText(f: string): string {
  return f.startsWith('=') ? f : `=${f}`
}

/**
 * RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. At most `maxRows` rows are returned (`more` says
 * there were others). Null when the text is malformed (an unterminated quote, text after a closing quote) or so
 * ragged (a row more than twice as wide as the first, or far narrower) that a table would mislead.
 */
export function parseCsv(text: string, maxRows = 500): { rows: string[][]; more: boolean } | null {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let quoted = false
  let more = false
  let i = 0
  const endField = (): void => {
    row.push(field)
    field = ''
    quoted = false
  }
  const endRow = (): boolean => {
    endField()
    if (rows.length >= maxRows) {
      more = true
      return false
    }
    rows.push(row)
    row = []
    return true
  }
  while (i < src.length) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        const next = src[i]
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') return null
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      if (field !== '' || quoted) return null
      inQuotes = true
      quoted = true
      i++
    } else if (c === ',') {
      endField()
      i++
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      i++
      if (!endRow()) break
    } else {
      field += c
      i++
    }
  }
  if (inQuotes) return null
  if (!more && (field !== '' || row.length > 0 || quoted)) {
    endRow()
  }
  if (rows.length === 0) return null
  const width = rows[0].length
  if (width < 1) return null
  for (const r of rows) {
    if (r.length > Math.max(width * 2, width + 8) || r.length * 4 < width) return null
  }
  return { rows, more }
}

/** Pretty-printed JSON text, or null when it does not parse. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

const SAFE_IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/

/** Only a base64 png / jpeg / gif / webp data URL ever becomes an img src. */
export function isSafeImageDataUrl(url: unknown): url is string {
  return typeof url === 'string' && SAFE_IMAGE_DATA_URL.test(url)
}

/** UTF-8 safe base64 data URL for SVG text, used only as an <img> src (never inlined). */
export function svgDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return `data:image/svg+xml;base64,${btoa(bin)}`
}

/** A document link is shown as a link only for http:, https: and mailto:. */
export function safeDocHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const t = href.trim()
  if (!t) return null
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? t : null
  } catch {
    return null
  }
}
