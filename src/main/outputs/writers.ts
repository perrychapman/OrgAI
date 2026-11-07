import ExcelJS from 'exceljs'
import type { OutputProduceInput, OutputSheetInput, OutputWorkbookInput } from '@shared/types'
import {
  OUTPUT_PRODUCE_KINDS,
  OUTPUT_TEXT_MAX_BYTES,
  OUTPUT_XLSX_CELL_MAX_CHARS,
  OUTPUT_XLSX_MAX_COLUMNS,
  OUTPUT_XLSX_MAX_ROWS,
  OUTPUT_XLSX_MAX_SHEETS,
  OUTPUT_XLSX_SHEET_NAME_MAX_CHARS
} from '@shared/types'
import { hiddenCharIn } from '../capabilities/sanitize'
import { markdownToDocx } from './markdownDoc'

/** Per-kind validation and rendering of produce_output content. Every refusal is Error(one plain sentence). */

// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

export const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function textContent(input: OutputProduceInput): string {
  if (typeof input.content !== 'string') throw new Error(`Content for a ${input.kind} file must be text.`)
  if (utf8Bytes(input.content) > OUTPUT_TEXT_MAX_BYTES) throw new Error(`The content is larger than ${Math.round(OUTPUT_TEXT_MAX_BYTES / 1024)} KB.`)
  return input.content
}

// ---------- mermaid ----------

const MERMAID_KEYWORDS = [
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey',
  'gantt', 'pie', 'quadrantChart', 'requirementDiagram', 'gitGraph', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
  'mindmap', 'timeline', 'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'kanban', 'architecture-beta', 'radar-beta', 'treemap-beta'
]

/** Why this is not Mermaid source, or null. */
export function mermaidProblem(text: string): string | null {
  const lines = text.split(/\r\n|\r|\n/)
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length && lines[i].trim() === '---') {
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '---') j++
    if (j >= lines.length) return 'The Mermaid front matter is not closed with "---".'
    i = j + 1
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    const word = /^[A-Za-z0-9-]+/.exec(t)?.[0] ?? ''
    if (MERMAID_KEYWORDS.includes(word) && (t.length === word.length || /[\s;{(\[]/.test(t[word.length]))) return null
    return `Mermaid source must start with a diagram type such as "flowchart TD" or "sequenceDiagram"; found "${t.slice(0, 40)}".`
  }
  return 'The Mermaid source is empty.'
}

// ---------- svg ----------

const SVG_FORBIDDEN_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'embed', 'object'])
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/y
const SVG_MAX_DEPTH = 1000
const SVG_MAX_ATTRS = 2000

function entityProblem(s: string): boolean {
  let i = s.indexOf('&')
  while (i >= 0) {
    ENTITY.lastIndex = i
    if (!ENTITY.test(s)) return true
    i = s.indexOf('&', i + 1)
  }
  return false
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g, (_m, e: string) => {
    switch (e) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
    }
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�'
  })
}

/** CSS-ish text (style element or attribute value): no @import, no escapes, url() only to a fragment. */
function cssProblem(raw: string): string | null {
  const s = decodeEntities(raw)
  if (s.includes('\\')) return 'The SVG has a backslash escape in its style.'
  const lower = s.toLowerCase()
  if (lower.includes('@import')) return 'The SVG imports an external style sheet (@import).'
  if (lower.includes('expression(') || lower.includes('javascript:')) return 'The SVG has a script in its style.'
  let i = lower.indexOf('url(')
  while (i >= 0) {
    let j = i + 4
    while (j < lower.length && (lower[j] === ' ' || lower[j] === '\t' || lower[j] === '\n' || lower[j] === '\r')) j++
    if (lower[j] === '"' || lower[j] === "'") {
      j++
      while (j < lower.length && (lower[j] === ' ' || lower[j] === '\t')) j++
    }
    if (lower[j] !== '#') return 'The SVG refers to an outside address with url(); only #fragments are allowed.'
    i = lower.indexOf('url(', i + 4)
  }
  return null
}

/**
 * Why this SVG is refused, or null when it is well formed, rooted at <svg> and holds nothing active or external:
 * no DOCTYPE / ENTITY / processing instruction (except a leading <?xml?>), no script, foreignObject, iframe, embed or
 * object, no on* attribute, href / xlink:href only to a #fragment, url() and @import only to a #fragment.
 * One linear pass; nothing is stripped, a failing SVG is refused whole.
 */
export function svgProblem(raw: string): string | null {
  const text = raw.replace(/^﻿/, '')
  const n = text.length
  if (hiddenCharIn(text, { multiline: true })) return 'The SVG contains a control or hidden character.'
  let i = 0
  const stack: string[] = []
  let sawRoot = false
  let rootClosed = false
  let first = true
  let attrTotal = 0
  while (i < n) {
    const lt = text.indexOf('<', i)
    const between = text.slice(i, lt < 0 ? n : lt)
    if (between) {
      if (entityProblem(between)) return 'The SVG uses an entity that is not defined (only &amp; &lt; &gt; &quot; &apos; and numbers).'
      if (between.trim()) {
        if (!sawRoot || rootClosed) return 'The SVG has text outside its <svg> element.'
        if (stack[stack.length - 1] === 'style') {
          const p = cssProblem(between)
          if (p) return p
        }
      }
    }
    if (lt < 0) break
    i = lt
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4)
      if (e < 0) return 'The SVG has an unclosed comment.'
      if (text.slice(i + 4, e).includes('--')) return 'The SVG has a comment containing "--".'
      i = e + 3
      first = false
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9)
      if (e < 0) return 'The SVG has an unclosed CDATA section.'
      if (!sawRoot || rootClosed) return 'The SVG has text outside its <svg> element.'
      if (stack[stack.length - 1] === 'style') {
        const p = cssProblem(text.slice(i + 9, e))
        if (p) return p
      }
      i = e + 3
      first = false
      continue
    }
    if (text.startsWith('<!', i)) return 'The SVG has a DOCTYPE or ENTITY declaration, which is not allowed.'
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2)
      const body = e < 0 ? '' : text.slice(i + 2, e)
      if (!first || e < 0 || !/^xml[ \t\r\n]/.test(body)) return 'The SVG has a processing instruction, which is not allowed.'
      i = e + 2
      first = false
      continue
    }
    first = false
    if (text[i + 1] === '/') {
      let j = i + 2
      while (j < n && NAME_CHAR.test(text[j])) j++
      const name = text.slice(i + 2, j)
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '>' || !name) return 'The SVG has a malformed closing tag.'
      if (stack.pop() !== name) return `The SVG has a closing tag </${name}> that does not match.`
      if (!stack.length) rootClosed = true
      i = j + 1
      continue
    }
    // start tag
    let j = i + 1
    while (j < n && NAME_CHAR.test(text[j])) j++
    const name = text.slice(i + 1, j)
    if (!name || /^[0-9.\-]/.test(name)) return 'The SVG has a malformed tag.'
    const local = name.slice(name.lastIndexOf(':') + 1)
    const lowerLocal = local.toLowerCase()
    if (SVG_FORBIDDEN_ELEMENTS.has(lowerLocal)) return `The SVG contains a <${local}> element, which is not allowed.`
    if (rootClosed) return 'The SVG has more than one root element.'
    if (!sawRoot) {
      if (local !== 'svg') return 'The root element must be <svg>.'
      sawRoot = true
    }
    let selfClose = false
    let attrName = ''
    let attributeNameValue = ''
    for (;;) {
      const hadSpace = j < n && /\s/.test(text[j])
      while (j < n && /\s/.test(text[j])) j++
      if (j >= n) return 'The SVG ends inside a tag.'
      if (text[j] === '>') {
        j++
        break
      }
      if (text[j] === '/') {
        if (text[j + 1] !== '>') return 'The SVG has a malformed tag.'
        selfClose = true
        j += 2
        break
      }
      if (!hadSpace) return 'The SVG has attributes with no space between them.'
      const a0 = j
      while (j < n && NAME_CHAR.test(text[j])) j++
      attrName = text.slice(a0, j)
      if (!attrName) return 'The SVG has a malformed attribute.'
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '=') return `The SVG attribute ${attrName} has no quoted value.`
      j++
      while (j < n && /\s/.test(text[j])) j++
      const q = text[j]
      if (q !== '"' && q !== "'") return `The SVG attribute ${attrName} must have a quoted value.`
      const e = text.indexOf(q, j + 1)
      if (e < 0) return `The SVG attribute ${attrName} is not closed.`
      const value = text.slice(j + 1, e)
      j = e + 1
      if (value.includes('<')) return `The SVG attribute ${attrName} contains "<".`
      if (entityProblem(value)) return 'The SVG uses an entity that is not defined (only &amp; &lt; &gt; &quot; &apos; and numbers).'
      if (++attrTotal > SVG_MAX_ATTRS * 100) return 'The SVG has too many attributes.'
      const aLocal = attrName.slice(attrName.lastIndexOf(':') + 1).toLowerCase()
      if (aLocal.startsWith('on')) return `The SVG has an event attribute (${attrName}), which is not allowed.`
      const decoded = decodeEntities(value)
      if (aLocal === 'href' && !decoded.trim().startsWith('#')) return 'The SVG links to an outside address; only #fragments are allowed in href.'
      if (aLocal === 'attributename') attributeNameValue = decoded.trim().toLowerCase()
      const css = cssProblem(value)
      if (css) return css
    }
    if (attributeNameValue && (lowerLocal === 'set' || lowerLocal === 'animate' || lowerLocal === 'animatetransform' || lowerLocal === 'animatemotion')) {
      const t = attributeNameValue.slice(attributeNameValue.lastIndexOf(':') + 1)
      if (t === 'href' || t.startsWith('on')) return 'The SVG animates a link or an event attribute, which is not allowed.'
    }
    if (!selfClose) {
      stack.push(name)
      if (stack.length > SVG_MAX_DEPTH) return 'The SVG is nested too deeply.'
    } else if (!stack.length) rootClosed = true
    i = j
  }
  if (!sawRoot) return 'The SVG has no <svg> element.'
  if (stack.length) return 'The SVG has a tag that is never closed.'
  return null
}

// ---------- xlsx ----------

export function sanitizeSheetNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((raw, idx) => {
    let name = raw.replace(/[:\\/?*[\]]/g, '-').replace(XML_BAD, '').replace(/^'+|'+$/g, '').trim()
    name = name.slice(0, OUTPUT_XLSX_SHEET_NAME_MAX_CHARS).replace(/^'+|'+$/g, '')
    if (!name) name = `Sheet${idx + 1}`
    if (name.toLowerCase() === 'history') name = 'History-'
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`
      candidate = name.slice(0, OUTPUT_XLSX_SHEET_NAME_MAX_CHARS - suffix.length) + suffix
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

function validateWorkbook(c: unknown): OutputWorkbookInput {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Spreadsheet content must be an object with a "sheets" list.')
  const sheets = (c as { sheets?: unknown }).sheets
  if (!Array.isArray(sheets) || sheets.length < 1) throw new Error('A spreadsheet needs at least one sheet.')
  if (sheets.length > OUTPUT_XLSX_MAX_SHEETS) throw new Error(`A spreadsheet can have at most ${OUTPUT_XLSX_MAX_SHEETS} sheets.`)
  sheets.forEach((s: unknown, si: number) => {
    const at = `Sheet ${si + 1}`
    if (!s || typeof s !== 'object') throw new Error(`${at} is not an object.`)
    const sh = s as OutputSheetInput
    if (typeof sh.name !== 'string') throw new Error(`${at} needs a name.`)
    if (!Array.isArray(sh.rows)) throw new Error(`${at} needs a "rows" list.`)
    if (sh.rows.length > OUTPUT_XLSX_MAX_ROWS) throw new Error(`${at} has more than ${OUTPUT_XLSX_MAX_ROWS} rows.`)
    let widest = 0
    for (let r = 0; r < sh.rows.length; r++) {
      const row = sh.rows[r]
      if (!Array.isArray(row)) throw new Error(`${at} row ${r + 1} is not a list of cells.`)
      if (row.length > OUTPUT_XLSX_MAX_COLUMNS) throw new Error(`${at} row ${r + 1} has more than ${OUTPUT_XLSX_MAX_COLUMNS} columns.`)
      widest = Math.max(widest, row.length)
      for (let k = 0; k < row.length; k++) {
        const v = row[k]
        if (v === null || typeof v === 'boolean') continue
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) throw new Error(`${at} row ${r + 1} column ${k + 1} is not a finite number.`)
        } else if (typeof v === 'string') {
          if (v.length > OUTPUT_XLSX_CELL_MAX_CHARS) throw new Error(`${at} row ${r + 1} column ${k + 1} is longer than ${OUTPUT_XLSX_CELL_MAX_CHARS} characters.`)
        } else throw new Error(`${at} row ${r + 1} column ${k + 1} must be text, a number, true / false or null.`)
      }
    }
    if (sh.columns !== undefined) {
      if (!Array.isArray(sh.columns)) throw new Error(`${at} "columns" must be a list.`)
      if (sh.columns.length > OUTPUT_XLSX_MAX_COLUMNS) throw new Error(`${at} has more than ${OUTPUT_XLSX_MAX_COLUMNS} columns.`)
      for (const col of sh.columns) {
        if (!col || typeof col.header !== 'string') throw new Error(`${at} column headers must be text.`)
        if (col.header.length > OUTPUT_XLSX_CELL_MAX_CHARS) throw new Error(`${at} has a column header longer than ${OUTPUT_XLSX_CELL_MAX_CHARS} characters.`)
        if (col.width !== undefined && (typeof col.width !== 'number' || !Number.isFinite(col.width))) throw new Error(`${at} column widths must be numbers.`)
      }
    }
    if (sh.numberFormat !== undefined) {
      if (!Array.isArray(sh.numberFormat) || sh.numberFormat.length > OUTPUT_XLSX_MAX_COLUMNS) throw new Error(`${at} "numberFormat" must be a list of at most ${OUTPUT_XLSX_MAX_COLUMNS} formats.`)
      for (const f of sh.numberFormat) {
        if (f === null || f === undefined) continue
        if (typeof f !== 'string' || f.length > 64) throw new Error(`${at} number formats must be text of at most 64 characters.`)
        if (hiddenCharIn(f)) throw new Error(`${at} has a number format with a hidden character.`)
      }
    }
  })
  return c as OutputWorkbookInput
}

const cleanCell = (s: string): string => s.replace(XML_BAD, '')

async function renderWorkbook(c: unknown): Promise<Buffer> {
  const wb = validateWorkbook(c)
  const book = new ExcelJS.Workbook()
  book.creator = 'OrgAI'
  const names = sanitizeSheetNames(wb.sheets.map((s) => s.name))
  wb.sheets.forEach((s, si) => {
    const ws = book.addWorksheet(names[si])
    let rowOffset = 0
    if (s.columns && s.columns.length) {
      const header = ws.addRow(s.columns.map((col) => cleanCell(col.header)))
      header.font = { bold: true }
      rowOffset = 1
      s.columns.forEach((col, ci) => {
        if (col.width !== undefined) ws.getColumn(ci + 1).width = Math.min(255, Math.max(1, col.width))
      })
    }
    for (const row of s.rows) {
      // Strings are always plain string values: exceljs only writes a formula for { formula } objects.
      const r = ws.addRow(row.map((v) => (v === null ? null : typeof v === 'string' ? cleanCell(v) : v)))
      if (s.numberFormat) {
        row.forEach((v, ci) => {
          const f = s.numberFormat?.[ci]
          if (typeof v === 'number' && typeof f === 'string' && f) r.getCell(ci + 1).numFmt = f
        })
      }
    }
    void rowOffset
  })
  return Buffer.from(await book.xlsx.writeBuffer())
}

// ---------- entry ----------

/** Render the content of a produce_output call to the file's bytes. Throws a plain sentence on bad content. */
export async function renderProduced(input: OutputProduceInput): Promise<Buffer> {
  if (!input || !(OUTPUT_PRODUCE_KINDS as readonly string[]).includes(input.kind)) throw new Error('That kind of file cannot be produced.')
  switch (input.kind) {
    case 'docx':
      return markdownToDocx(textContent(input), input.title)
    case 'xlsx':
      return renderWorkbook(input.content)
    case 'json': {
      const t = textContent(input)
      try {
        JSON.parse(t)
      } catch (e) {
        throw new Error(`The JSON is not valid: ${(e as Error).message}`)
      }
      return Buffer.from(t, 'utf8')
    }
    case 'mermaid': {
      const t = textContent(input)
      const p = mermaidProblem(t)
      if (p) throw new Error(p)
      return Buffer.from(t, 'utf8')
    }
    case 'svg': {
      const t = textContent(input)
      const p = svgProblem(t)
      if (p) throw new Error(p)
      return Buffer.from(t, 'utf8')
    }
    default: {
      const t = textContent(input)
      if (t.includes('\u0000')) throw new Error('The text contains a NUL character.')
      return Buffer.from(t, 'utf8')
    }
  }
}
