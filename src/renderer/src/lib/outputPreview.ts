// Pure helpers for the in-window output previews (docs/design/outputs.md section 4). No React, no DOM.
import type { DocumentRun, SheetCell } from '@shared/types'

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(i: number): string {
  let n = Math.max(0, Math.floor(i))
  let s = ''
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
    if (n < 0) return s
  }
}

function decimalsOf(fmt: string): number {
  const m = /0\.(0+)/.exec(fmt)
  return m ? m[1].length : 0
}

/** The text of a sheet cell. A string starting with '=' is shown as text. */
export function sheetCellText(cell: SheetCell): string {
  const v = cell.v
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    const fmt = cell.fmt ?? ''
    if (fmt.includes('%')) return `${(v * 100).toFixed(decimalsOf(fmt))}%`
    if (fmt.includes('0.00')) return v.toFixed(2)
  }
  return String(v)
}

/** Parse CSV (RFC 4180 quotes). Null when empty, unterminated, or the rows have different widths. */
export function parseCsv(text: string): string[][] | null {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let any = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      any = true
    } else if (c === ',') {
      row.push(cell)
      cell = ''
      any = true
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      if (any || cell !== '') {
        row.push(cell)
        rows.push(row)
      }
      row = []
      cell = ''
      any = false
    } else {
      cell += c
      any = true
    }
  }
  if (quoted) return null
  if (any || cell !== '') {
    row.push(cell)
    rows.push(row)
  }
  if (rows.length === 0) return null
  const width = rows[0].length
  if (width < 2) return null
  return rows.every((r) => r.length === width) ? rows : null
}

const SAFE_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/

/** Only png / jpeg / gif / webp base64 data URLs are ever used as an image source. */
export function isSafeImageDataUrl(url: string): boolean {
  return typeof url === 'string' && url.length < 20 * 1024 * 1024 && SAFE_IMAGE_URL.test(url)
}

/** UTF-8 safe base64 of a string. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** `data:image/svg+xml;base64,...` of SVG source, used only as an img src (never inlined). */
export function svgDataUrl(text: string): string {
  return `data:image/svg+xml;base64,${utf8ToBase64(text)}`
}

/** Heading level n becomes h(n+3), at most h6. */
export function headingLevel(level: number): 4 | 5 | 6 {
  const n = Math.min(6, Math.max(1, Math.floor(level) || 1)) + 3
  return Math.min(6, n) as 4 | 5 | 6
}

/** Only http:, https: and mailto: hrefs become links. */
export function isSafeHref(href: string | undefined): href is string {
  return typeof href === 'string' && /^(https?:|mailto:)/i.test(href.trim()) && !/[\u0000-\u001f\u007f]/.test(href)
}

/** The run's text, for keys and tests. */
export function runsText(runs: readonly DocumentRun[]): string {
  return runs.map((r) => r.text).join('')
}
