import type { DocumentBlock, DocumentRun } from '@shared/types'
import { OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES, OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES } from '@shared/types'

/**
 * mammoth's HTML (untrusted: it comes from a user-supplied .docx) -> DocumentBlock[] through a strict allowlist and a
 * hand-written linear tokenizer. Nothing of the HTML survives except text, the style flags of the allowed inline tags,
 * http / https / mailto hrefs and base64 png / jpeg / gif / webp images within the caps.
 *
 * Rules:
 *  - allowed tags: p, h1-h6, ul, ol, li, table, thead, tbody, tr, td, th, strong, b, em, i, u, s, del, sub, sup, a, img,
 *    br, code, pre. Any other tag is dropped and its text kept; script, style, template, iframe, object (and embed,
 *    noscript, svg, math, textarea, title) lose their content too. Attributes other than href, src, alt are never read.
 *  - lists: the outermost list decides ordered / unordered; items of nested lists are appended to it as items of the
 *    same level (no prefix). Tables nested in a table or a list item are flattened into text with spaces.
 *  - block content inside a list item or table cell becomes runs separated by a space; <br> is a "\n" in a run.
 *  - images only become blocks outside lists and tables (inside them the image is dropped).
 *  - caps: MAX_BLOCKS blocks, MAX_TEXT_CHARS of text, MAX_UNITS runs / cells / items; past one the walk stops and
 *    `truncated` is true. Everything is one pass with no recursion and no backtracking pattern.
 */

export const HTML_MAX_BLOCKS = 5000
export const HTML_MAX_TEXT_CHARS = 2 * 1024 * 1024
const MAX_UNITS = 200_000
const HREF_MAX = 4096
const ALT_MAX = 500
const SRC_MAX = Math.ceil((OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES * 4) / 3) + 64

const DROP_CONTENT = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'textarea', 'title', 'head'])

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷'
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,8});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
      return String.fromCodePoint(cp)
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** An href that may be kept: http(s):// or mailto:, no control characters anywhere, at most HREF_MAX. */
export function safeHref(raw: string): string | undefined {
  if (raw.length > HREF_MAX * 2) return undefined
  const v = decodeEntities(raw).trim()
  if (!v || v.length > HREF_MAX || CONTROL.test(v) || /\s/.test(v)) return undefined
  return /^(?:https?:\/\/.|mailto:.)/i.test(v) ? v : undefined
}

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/

function imageMagicOk(type: string, head: Buffer): boolean {
  switch (type) {
    case 'png': return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    case 'jpeg': return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    case 'gif': return head.length >= 4 && head.toString('latin1', 0, 4) === 'GIF8'
    case 'webp': return head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
  }
  return false
}

/** Validate a data URL; returns the decoded size, or 'bad' / 'big'. */
function checkDataImage(src: string): { ok: true; bytes: number } | { ok: false; reason: 'bad' | 'big' } {
  const m = DATA_IMAGE.exec(src)
  if (!m) return { ok: false, reason: 'bad' }
  const b64 = m[2]
  if (b64.length % 4 !== 0) return { ok: false, reason: 'bad' }
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const bytes = (b64.length / 4) * 3 - pad
  if (bytes > OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES) return { ok: false, reason: 'big' }
  const head = Buffer.from(b64.slice(0, 24), 'base64')
  if (!imageMagicOk(m[1], head)) return { ok: false, reason: 'bad' }
  return { ok: true, bytes }
}

interface Attrs {
  href?: string
  src?: string
  alt?: string
}

type Tok =
  | { t: 'text'; text: string }
  | { t: 'start'; name: string; attrs: Attrs; selfClose: boolean }
  | { t: 'end'; name: string }

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

/** Index of the end tag `</name` (case-insensitive) at or after `from`, or -1. */
function findClose(html: string, from: number, name: string): number {
  let i = html.indexOf('</', from)
  while (i >= 0) {
    if (html.length >= i + 2 + name.length && html.substr(i + 2, name.length).toLowerCase() === name) return i
    i = html.indexOf('</', i + 2)
  }
  return -1
}

/** Linear tokenizer: comments, doctype, processing instructions and raw-text elements never reach the walker. */
function* tokens(html: string): Generator<Tok> {
  const n = html.length
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      yield { t: 'text', text: html.slice(i) }
      return
    }
    if (lt > i) yield { t: 'text', text: html.slice(i, lt) }
    i = lt
    const c = html[i + 1] ?? ''
    if (html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4)
      i = e < 0 ? n : e + 3
      continue
    }
    if (c === '!' || c === '?') {
      const e = html.indexOf('>', i + 2)
      i = e < 0 ? n : e + 1
      continue
    }
    if (c === '/') {
      let j = i + 2
      while (j < n && j < i + 40 && (isLetter(html[j]) || (html[j] >= '0' && html[j] <= '9') || html[j] === ':' || html[j] === '-')) j++
      const name = html.slice(i + 2, j).toLowerCase()
      const e = html.indexOf('>', j)
      i = e < 0 ? n : e + 1
      if (name) yield { t: 'end', name }
      continue
    }
    if (!isLetter(c)) {
      yield { t: 'text', text: '<' }
      i++
      continue
    }
    let j = i + 1
    while (j < n && (isLetter(html[j]) || (html[j] >= '0' && html[j] <= '9') || html[j] === ':' || html[j] === '-')) j++
    const name = html.slice(i + 1, Math.min(j, i + 41)).toLowerCase()
    const attrs: Attrs = {}
    let selfClose = false
    for (;;) {
      while (j < n && (isWs(html[j]) || html[j] === '/')) {
        if (html[j] === '/') selfClose = true
        else selfClose = false
        j++
      }
      if (j >= n) break
      if (html[j] === '>') {
        j++
        break
      }
      selfClose = false
      const a0 = j
      while (j < n && !isWs(html[j]) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/') j++
      const an = html.slice(a0, Math.min(j, a0 + 20)).toLowerCase()
      while (j < n && isWs(html[j])) j++
      let value: string | null = null
      let vs = -1
      let ve = -1
      if (html[j] === '=') {
        j++
        while (j < n && isWs(html[j])) j++
        const q = html[j]
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1)
          vs = j + 1
          ve = e < 0 ? n : e
          j = e < 0 ? n : e + 1
        } else {
          vs = j
          while (j < n && !isWs(html[j]) && html[j] !== '>') j++
          ve = j
        }
        value = ''
      }
      if (value !== null && (an === 'href' || an === 'src' || an === 'alt')) {
        const max = an === 'src' ? SRC_MAX : an === 'href' ? HREF_MAX * 2 : ALT_MAX * 6
        if (ve - vs <= max) attrs[an] = html.slice(vs, ve)
      }
      if (j === a0) j++ // always make progress
    }
    i = j
    if (DROP_CONTENT.has(name) && !selfClose) {
      const e = findClose(html, i, name)
      if (e < 0) {
        i = n
      } else {
        const g = html.indexOf('>', e)
        i = g < 0 ? n : g + 1
      }
      continue
    }
    if (DROP_CONTENT.has(name)) continue
    yield { t: 'start', name, attrs, selfClose }
  }
}

interface Style {
  bold: number
  italic: number
  underline: number
  strike: number
  code: number
}

type Cur = { kind: 'p' | 'li' | 'cell' | 'pre'; level?: 1 | 2 | 3 | 4 | 5 | 6; runs: DocumentRun[]; code: string; th: boolean }

const HEADING_RE = /^h([1-6])$/

export interface HtmlBlocksResult {
  blocks: DocumentBlock[]
  truncated: boolean
}

export function htmlToBlocks(html: string): HtmlBlocksResult {
  const blocks: DocumentBlock[] = []
  let truncated = false
  let stop = false
  let textChars = 0
  let units = 0
  let imageBytes = 0
  const style: Style = { bold: 0, italic: 0, underline: 0, strike: 0, code: 0 }
  const hrefs: (string | undefined)[] = []
  let cur: Cur | null = null
  let list: { ordered: boolean; items: DocumentRun[][] } | null = null
  let listDepth = 0
  let table: { rows: DocumentRun[][][]; row: DocumentRun[][] | null; rowAllTh: boolean; headerRows: number; inHead: boolean } | null = null
  let nestedTable = 0

  const cut = (): void => {
    truncated = true
    stop = true
  }
  const pushBlock = (b: DocumentBlock): void => {
    if (blocks.length >= HTML_MAX_BLOCKS) return cut()
    blocks.push(b)
  }
  const unit = (): boolean => {
    if (++units > MAX_UNITS) {
      cut()
      return false
    }
    return true
  }

  const trimRuns = (runs: DocumentRun[]): DocumentRun[] => {
    const out = runs.map((r) => ({ ...r }))
    while (out.length && !out[0].text.trim() && !out[0].href) out.shift()
    if (out.length) out[0].text = out[0].text.replace(/^ +/, '')
    while (out.length && !out[out.length - 1].text.trim() && !out[out.length - 1].href) out.pop()
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/ +$/, '')
    return out.filter((r) => r.text !== '')
  }

  const finishRow = (): void => {
    if (!table || !table.row) return
    if (table.row.length) {
      table.rows.push(table.row)
      if ((table.rowAllTh || table.inHead) && table.headerRows === table.rows.length - 1) table.headerRows++
    }
    table.row = null
  }
  const finishTable = (): void => {
    if (!table) return
    finishRow()
    if (table.rows.length) pushBlock({ type: 'table', rows: table.rows, ...(table.headerRows ? { headerRows: table.headerRows } : {}) })
    table = null
  }
  const finishList = (): void => {
    if (list && list.items.length) pushBlock({ type: 'list', ordered: list.ordered, items: list.items })
    list = null
  }

  const flushCur = (): void => {
    const c = cur
    cur = null
    if (!c) return
    if (c.kind === 'pre') {
      const text = c.code.replace(/\n+$/, '')
      if (text.trim()) pushBlock({ type: 'code', text })
      return
    }
    const runs = trimRuns(c.runs)
    if (c.kind === 'li') {
      if (list && unit()) list.items.push(runs)
      return
    }
    if (c.kind === 'cell') {
      if (!table) return
      if (!table.row) {
        table.row = []
        table.rowAllTh = true
      }
      if (!c.th) table.rowAllTh = false
      if (unit()) table.row.push(runs)
      return
    }
    if (!runs.length) return
    if (c.level) pushBlock({ type: 'heading', level: c.level, runs })
    else pushBlock({ type: 'paragraph', runs })
  }

  const addRun = (text: string, collapse: boolean): void => {
    if (!text) return
    if (!cur) cur = { kind: 'p', runs: [], code: '', th: false }
    if (cur.kind === 'pre') {
      if (textChars + text.length > HTML_MAX_TEXT_CHARS) {
        text = text.slice(0, Math.max(0, HTML_MAX_TEXT_CHARS - textChars))
        cut()
      }
      textChars += text.length
      cur.code += text
      return
    }
    let t = collapse ? text.replace(/[ \t\r\n\f]+/g, ' ') : text
    if (!cur.runs.length && !t.trim() && !cur.level) return
    if (textChars + t.length > HTML_MAX_TEXT_CHARS) {
      t = t.slice(0, Math.max(0, HTML_MAX_TEXT_CHARS - textChars))
      cut()
    }
    if (!t) return
    textChars += t.length
    const href = hrefs.length ? hrefs[hrefs.length - 1] : undefined
    const last = cur.runs[cur.runs.length - 1]
    const same =
      last &&
      last.href === href &&
      !last.bold === !style.bold &&
      !last.italic === !style.italic &&
      !last.underline === !style.underline &&
      !last.strike === !style.strike &&
      !last.code === !style.code
    if (same) {
      last.text += t
      return
    }
    if (!unit()) return
    const r: DocumentRun = { text: t }
    if (style.bold) r.bold = true
    if (style.italic) r.italic = true
    if (style.underline) r.underline = true
    if (style.strike) r.strike = true
    if (style.code) r.code = true
    if (href) r.href = href
    cur.runs.push(r)
  }

  /** A single space between block content flattened into one list item or cell. */
  const separate = (): void => {
    if (!cur || !cur.runs.length) return
    if (cur.runs[cur.runs.length - 1].text.endsWith(' ')) return
    addRun(' ', false)
  }

  const startBlock = (kind: 'p' | 'pre', level?: 1 | 2 | 3 | 4 | 5 | 6): void => {
    if (cur && (cur.kind === 'li' || cur.kind === 'cell')) {
      if (kind === 'pre') return
      separate()
      return
    }
    flushCur()
    cur = { kind, level, runs: [], code: '', th: false }
  }

  const bump = (name: string, d: 1 | -1): void => {
    const k = name === 'strong' || name === 'b' ? 'bold' : name === 'em' || name === 'i' ? 'italic' : name === 'u' ? 'underline' : name === 's' || name === 'del' ? 'strike' : name === 'code' ? 'code' : null
    if (k) style[k] = Math.max(0, style[k] + d)
  }

  outer: for (const tok of tokens(html)) {
    if (stop) break
    if (tok.t === 'text') {
      let raw = tok.text
      if (raw.length > HTML_MAX_TEXT_CHARS * 2) raw = raw.slice(0, HTML_MAX_TEXT_CHARS * 2)
      addRun(decodeEntities(raw), !(cur && cur.kind === 'pre'))
      continue
    }
    const name = tok.name
    if (tok.t === 'start') {
      const hm = HEADING_RE.exec(name)
      if (hm) {
        startBlock('p', Number(hm[1]) as 1 | 2 | 3 | 4 | 5 | 6)
        continue
      }
      switch (name) {
        case 'p':
          startBlock('p')
          break
        case 'pre':
          startBlock('pre')
          break
        case 'ul':
        case 'ol':
          if (listDepth === 0 && !table) {
            flushCur()
            finishList()
            list = { ordered: name === 'ol', items: [] }
          }
          listDepth++
          break
        case 'li':
          if (list) {
            flushCur()
            cur = { kind: 'li', runs: [], code: '', th: false }
          } else startBlock('p')
          break
        case 'table':
          if (table || list || cur?.kind === 'cell') nestedTable++
          else {
            flushCur()
            table = { rows: [], row: null, rowAllTh: true, headerRows: 0, inHead: false }
          }
          break
        case 'thead':
          if (table && !nestedTable) table.inHead = true
          break
        case 'tbody':
          if (table && !nestedTable) table.inHead = false
          break
        case 'tr':
          if (table && !nestedTable) {
            flushCur()
            finishRow()
            table.row = []
            table.rowAllTh = true
          }
          break
        case 'td':
        case 'th':
          if (table && !nestedTable) {
            flushCur()
            cur = { kind: 'cell', runs: [], code: '', th: name === 'th' }
          } else separate()
          break
        case 'strong': case 'b': case 'em': case 'i': case 'u': case 's': case 'del': case 'code':
          if (!tok.selfClose) bump(name, 1)
          break
        case 'a':
          hrefs.push(safeHref(tok.attrs.href ?? ''))
          break
        case 'br':
          addRun('\n', false)
          break
        case 'img': {
          const src = tok.attrs.src
          if (src === undefined || table || list || (cur && (cur.kind === 'cell' || cur.kind === 'li' || cur.kind === 'pre'))) break
          const r = checkDataImage(decodeEntities(src).trim())
          if (!r.ok) {
            if (r.reason === 'big') truncated = true
            break
          }
          if (imageBytes + r.bytes > OUTPUT_PREVIEW_DOC_IMAGES_TOTAL_BYTES) {
            truncated = true
            break
          }
          imageBytes += r.bytes
          flushCur()
          const alt = decodeEntities(tok.attrs.alt ?? '').slice(0, ALT_MAX)
          pushBlock({ type: 'image', dataUrl: decodeEntities(src).trim(), alt })
          break
        }
        default:
          // sub, sup and every unknown tag: dropped, their text stays.
          break
      }
      if (tok.selfClose && name !== 'br' && name !== 'img') {
        // <p/>, <td/> and similar close at once
        if (name === 'p' || HEADING_RE.test(name)) flushCur()
        if (name === 'td' || name === 'th' || name === 'li') flushCur()
        if (name === 'strong' || name === 'b' || name === 'em' || name === 'i' || name === 'u' || name === 's' || name === 'del' || name === 'code') {
          /* bump skipped above for self-closing */
        }
        if (name === 'a') hrefs.pop()
      }
      continue outer
    }
    // end tag
    if (HEADING_RE.test(name) || name === 'p') {
      if (cur && cur.kind === 'p') flushCur()
      else separate()
      continue
    }
    switch (name) {
      case 'pre':
        if (cur && cur.kind === 'pre') flushCur()
        break
      case 'li':
        if (cur && cur.kind === 'li') flushCur()
        break
      case 'ul':
      case 'ol':
        if (listDepth > 0) {
          listDepth--
          if (listDepth === 0) {
            flushCur()
            finishList()
          }
        }
        break
      case 'td':
      case 'th':
        if (cur && cur.kind === 'cell') flushCur()
        break
      case 'tr':
        if (table && !nestedTable) {
          flushCur()
          finishRow()
        }
        break
      case 'thead':
      case 'tbody':
        if (table && !nestedTable) {
          flushCur()
          finishRow()
          table.inHead = false
        }
        break
      case 'table':
        if (nestedTable > 0) nestedTable--
        else if (table) {
          flushCur()
          finishTable()
        }
        break
      case 'strong': case 'b': case 'em': case 'i': case 'u': case 's': case 'del': case 'code':
        bump(name, -1)
        break
      case 'a':
        hrefs.pop()
        break
      default:
        break
    }
  }
  flushCur()
  finishList()
  finishTable()
  return { blocks, truncated }
}
