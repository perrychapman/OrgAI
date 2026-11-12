import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'

/**
 * A small deterministic Markdown subset -> block model -> docx. No dependency for parsing. Every scan is linear:
 * inline delimiters look for their closer once per opener and a failed search is remembered (no closer = the rest is
 * literal), link text stops at the next '[' and a failed URL scan is remembered by its stop position.
 *
 * Subset: ATX headings, paragraphs (lines joined with a space), **bold** __bold__ *italic* _italic_ `code` ~~strike~~,
 * links [text](url) (http, https, mailto only; else the text), lists (- * + and 1.) with ONE nesting level (2+ spaces
 * or a tab indent), GFM tables, fenced code, rules, and "\pagebreak" / "<!-- pagebreak -->" lines as page breaks.
 */

export interface Run {
  text: string
  bold?: true
  italic?: true
  strike?: true
  code?: true
  href?: string
}

export interface ListItem {
  runs: Run[]
  children?: { ordered: boolean; items: Run[][] }
}

export type Align = 'left' | 'center' | 'right' | null

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; header: Run[][]; rows: Run[][][]; align: Align[] }
  | { type: 'code'; lines: string[] }
  | { type: 'rule' }
  | { type: 'pageBreak' }

// ---------- inline ----------

// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g
const clean = (s: string): string => s.replace(XML_BAD, '')

const isWs = (c: string | undefined): boolean => c === undefined || c === ' ' || c === '\t' || c === '\n'
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)

interface Style {
  bold?: true
  italic?: true
  strike?: true
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i

function pushRun(out: Run[], text: string, style: Style, extra: Partial<Run> = {}): void {
  if (!text) return
  const last = out[out.length - 1]
  const same =
    last &&
    !last.code === !extra.code &&
    last.href === extra.href &&
    !last.bold === !style.bold &&
    !last.italic === !style.italic &&
    !last.strike === !style.strike
  if (same) {
    last.text += text
    return
  }
  const r: Run = { text }
  if (style.bold) r.bold = true
  if (style.italic) r.italic = true
  if (style.strike) r.strike = true
  if (extra.code) r.code = true
  if (extra.href) r.href = extra.href
  out.push(r)
}

/** Parse inline Markdown into runs. `allowLinks` is off inside link text. */
export function parseInline(text: string, style: Style = {}, allowLinks = true): Run[] {
  const out: Run[] = []
  const n = text.length
  let i = 0
  let lit = ''
  // Remembered failures: a delimiter with no closer after a point never matches again.
  const noCloser = new Set<string>()
  let noBracketUntil = -1
  let noParenUntil = -1
  const flush = (): void => {
    if (lit) pushRun(out, lit, style)
    lit = ''
  }

  /** Index of the closer of a delimiter whose content starts at `from`, or -1. */
  const findCloser = (d: string, from: number): number => {
    if (noCloser.has(d)) return -1
    let j = from
    for (;;) {
      j = text.indexOf(d, j)
      if (j < 0) {
        noCloser.add(d)
        return -1
      }
      // A single '*' skips a '**' pair.
      if (d === '*' && text[j + 1] === '*') {
        j += 2
        continue
      }
      if (d === '_' && text[j + 1] === '_') {
        j += 2
        continue
      }
      return j
    }
  }

  while (i < n) {
    const c = text[i]
    if (c === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!~|>]/.test(text[i + 1])) {
      lit += text[i + 1]
      i += 2
      continue
    }
    if (c === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const delim = '`'.repeat(run)
      const j = noCloser.has(delim) ? -1 : text.indexOf(delim, i + run)
      if (j >= 0) {
        flush()
        const inner = text.slice(i + run, j).replace(/\n/g, ' ')
        pushRun(out, inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner, style, { code: true })
        i = j + run
        continue
      }
      noCloser.add(delim)
      lit += delim
      i += run
      continue
    }
    if ((c === '*' || c === '_' || c === '~') && !(c === '~' && text[i + 1] !== '~')) {
      const double = text[i + 1] === c
      const triple = c !== '~' && double && text[i + 2] === c
      const d = c === '~' ? '~~' : triple ? c.repeat(3) : double ? c + c : c
      const opener = i
      const after = text[i + d.length]
      const before = i > 0 ? text[i - 1] : undefined
      const canOpen = !isWs(after) && !(c === '_' && isWord(before))
      // A run of the delimiter longer than d (e.g. ***) is taken a layer at a time.
      if (canOpen) {
        const j = findCloser(d, opener + d.length)
        if (j > opener + d.length) {
          const inner = text.slice(opener + d.length, j)
          const closeOk = !isWs(text[j - 1]) && !(c === '_' && isWord(text[j + d.length]))
          const strike = c === '~'
          const bold = !strike && d.length >= 2
          const italic = !strike && (d.length === 1 || d.length === 3)
          const taken = (bold && style.bold) || (italic && style.italic) || (strike && style.strike)
          if (closeOk && !taken) {
            flush()
            const next: Style = { ...style }
            if (bold) next.bold = true
            if (italic) next.italic = true
            if (strike) next.strike = true
            for (const r of parseInline(inner, next, allowLinks)) pushRun(out, r.text, { bold: r.bold, italic: r.italic, strike: r.strike }, { code: r.code, href: r.href })
            i = j + d.length
            continue
          }
        }
      }
      lit += d
      i += d.length
      continue
    }
    if (c === '[' && allowLinks && i >= noBracketUntil) {
      // link text runs to the next ']' and may not contain '['
      let k = i + 1
      while (k < n && text[k] !== ']' && text[k] !== '[') k++
      if (k < n && text[k] === ']' && text[k + 1] === '(') {
        const start = k + 2
        let m = -1
        if (start >= noParenUntil) {
          // The scan stops at the first ')' or whitespace; a failed stop is remembered so a later '(' before it fails at once.
          let p = start
          while (p < n && text[p] !== ')' && !isWs(text[p])) p++
          if (p < n && text[p] === ')') m = p
          else noParenUntil = p + 1
        }
        if (m >= 0) {
          const url = text.slice(start, m).trim()
          const label = text.slice(i + 1, k)
          flush()
          if (SAFE_HREF.test(url) && label) {
            for (const r of parseInline(label, style, false)) pushRun(out, r.text, { bold: r.bold, italic: r.italic, strike: r.strike }, { code: r.code, href: url })
          } else if (label) {
            for (const r of parseInline(label, style, false)) pushRun(out, r.text, { bold: r.bold, italic: r.italic, strike: r.strike }, { code: r.code })
          }
          i = m + 1
          continue
        }
      } else if (k >= n) {
        noBracketUntil = n + 1 // no ']' anywhere after this point: every later '[' is literal too
      }
      lit += c
      i++
      continue
    }
    lit += c
    i++
  }
  flush()
  return out
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(```+|~~~+)/
const PAGEBREAK = new Set(['\\pagebreak', '<!-- pagebreak -->'])

function isRuleLine(t: string): boolean {
  if (t.length < 3) return false
  const ch = t[0]
  if (ch !== '-' && ch !== '*' && ch !== '_') return false
  let count = 0
  for (const c of t) {
    if (c === ch) count++
    else if (c !== ' ') return false
  }
  return count >= 3
}

function headingOf(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  let h = 0
  while (line[i + h] === '#') h++
  if (h < 1 || h > 6) return null
  const rest = line.slice(i + h)
  if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null
  let t = rest.trim()
  // closing hashes preceded by a space
  let e = t.length
  while (e > 0 && t[e - 1] === '#') e--
  if (e < t.length && (e === 0 || t[e - 1] === ' ' || t[e - 1] === '\t')) t = t.slice(0, e).trimEnd()
  return { level: h as 1 | 2 | 3 | 4 | 5 | 6, text: t }
}

interface ListLine {
  indent: number
  ordered: boolean
  text: string
}

function listLine(line: string): ListLine | null {
  let i = 0
  let indent = 0
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    indent += line[i] === '\t' ? 4 : 1
    i++
  }
  const c = line[i]
  if (c === '-' || c === '*' || c === '+') {
    if (line[i + 1] !== ' ' && line[i + 1] !== '\t') return null
    return { indent, ordered: false, text: line.slice(i + 2).trim() }
  }
  let d = 0
  while (i + d < line.length && d < 9 && line.charCodeAt(i + d) >= 48 && line.charCodeAt(i + d) <= 57) d++
  if (d > 0 && line[i + d] === '.' && (line[i + d + 1] === ' ' || line[i + d + 1] === '\t')) {
    return { indent, ordered: true, text: line.slice(i + d + 2).trim() }
  }
  return null
}

function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

function separatorAlign(line: string): Align[] | null {
  if (!line.includes('-')) return null
  const cells = splitRow(line)
  const out: Align[] = []
  for (const c of cells) {
    if (!c) return null
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    const core = c.slice(l ? 1 : 0, c.length - (r ? 1 : 0))
    if (!core || core.length > 200) return null
    for (const ch of core) if (ch !== '-') return null
    out.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null)
  }
  return out
}

function startsBlock(line: string, next: string | undefined): boolean {
  const t = line.trim()
  if (!t) return true
  if (FENCE.test(line) || headingOf(line) || isRuleLine(t) || PAGEBREAK.has(t) || listLine(line)) return true
  if (next !== undefined && line.includes('|') && separatorAlign(next)) return true
  return false
}

/** Parse Markdown (the subset above) into blocks. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (!t) {
      i++
      continue
    }
    const f = FENCE.exec(line)
    if (f) {
      const fence = f[1]
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) {
        code.push(lines[i])
        i++
      }
      i++ // closing fence (or end)
      blocks.push({ type: 'code', lines: code })
      continue
    }
    const h = headingOf(line)
    if (h) {
      blocks.push({ type: 'heading', level: h.level, runs: parseInline(h.text) })
      i++
      continue
    }
    if (PAGEBREAK.has(t)) {
      blocks.push({ type: 'pageBreak' })
      i++
      continue
    }
    if (isRuleLine(t)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length) {
      const align = separatorAlign(lines[i + 1])
      if (align) {
        const header = splitRow(line)
        if (header.length === align.length) {
          const rows: Run[][][] = []
          i += 2
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            const cells = splitRow(lines[i])
            while (cells.length < align.length) cells.push('')
            rows.push(cells.slice(0, align.length).map((c) => parseInline(c)))
            i++
          }
          blocks.push({ type: 'table', header: header.map((c) => parseInline(c)), rows, align })
          continue
        }
      }
    }
    const ll = listLine(line)
    if (ll) {
      const baseOrdered = ll.ordered
      const items: ListItem[] = []
      let last: ListItem | undefined
      while (i < lines.length) {
        const cur = lines[i]
        if (!cur.trim()) break
        const l = listLine(cur)
        if (l) {
          if (l.indent >= 2 && last) {
            if (!last.children) last.children = { ordered: l.ordered, items: [] }
            last.children.items.push(parseInline(l.text))
          } else {
            if (l.ordered !== baseOrdered && items.length) break
            last = { runs: parseInline(l.text) }
            items.push(last)
          }
          i++
          continue
        }
        if (/^[ \t]/.test(cur) && last && !FENCE.test(cur) && !headingOf(cur)) {
          // lazy continuation of the previous item
          const target = last.children ? last.children.items : null
          if (target) target[target.length - 1] = parseInline(joinText(target[target.length - 1]) + ' ' + cur.trim())
          else last.runs = parseInline(joinText(last.runs) + ' ' + cur.trim())
          i++
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered: baseOrdered, items })
      continue
    }
    // paragraph
    const para: string[] = [t]
    i++
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i].trim())
      i++
    }
    blocks.push({ type: 'paragraph', runs: parseInline(para.join(' ')) })
  }
  return blocks
}

/** Plain text of runs (continuations re-parse the joined text; formatting marks are lost on a continued item only). */
function joinText(runs: Run[]): string {
  return runs
    .map((r) => {
      let s = r.text
      if (r.code) s = '`' + s + '`'
      if (r.strike) s = '~~' + s + '~~'
      if (r.bold) s = '**' + s + '**'
      if (r.italic) s = '*' + s + '*'
      if (r.href) s = `[${s}](${r.href})`
      return s
    })
    .join('')
}

// ---------- docx ----------

const MONO = 'Consolas'
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]

function textRun(r: Run, extra: { bold?: boolean } = {}): TextRun {
  return new TextRun({
    text: clean(r.text),
    bold: r.bold || extra.bold || undefined,
    italics: r.italic || undefined,
    strike: r.strike || undefined,
    font: r.code ? MONO : undefined,
    shading: r.code ? { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } : undefined
  })
}

function inlineChildren(runs: Run[], extra: { bold?: boolean } = {}): (TextRun | ExternalHyperlink)[] {
  return runs.map((r) =>
    r.href
      ? new ExternalHyperlink({
          link: r.href,
          children: [new TextRun({ text: clean(r.text), bold: r.bold || extra.bold || undefined, italics: r.italic || undefined, color: '0563C1', underline: {} })]
        })
      : textRun(r, extra)
  )
}

const BULLET_REF = 'orgai-bullets'
const ORDERED_REF = 'orgai-ordered'

function levels(format: (typeof LevelFormat)[keyof typeof LevelFormat], texts: [string, string]) {
  return texts.map((text, level) => ({
    level,
    format: level === 0 ? format : format === LevelFormat.DECIMAL ? LevelFormat.LOWER_LETTER : format,
    text,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
  }))
}

/** Render blocks to a docx file buffer. */
export async function markdownToDocx(markdown: string, title?: string): Promise<Buffer> {
  const blocks = parseMarkdown(markdown)
  const children: (Paragraph | Table)[] = []
  let orderedInstance = 0
  const none = { top: { style: BorderStyle.NONE, size: 0, color: 'auto' } }
  void none

  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        children.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: inlineChildren(b.runs) }))
        break
      case 'paragraph':
        children.push(new Paragraph({ children: inlineChildren(b.runs), spacing: { after: 120 } }))
        break
      case 'list': {
        const inst = b.ordered ? ++orderedInstance : 0
        for (const it of b.items) {
          children.push(
            new Paragraph({
              children: inlineChildren(it.runs),
              numbering: b.ordered ? { reference: ORDERED_REF, level: 0, instance: inst } : { reference: BULLET_REF, level: 0 }
            })
          )
          if (it.children) {
            const cinst = it.children.ordered ? ++orderedInstance : 0
            for (const c of it.children.items) {
              children.push(
                new Paragraph({
                  children: inlineChildren(c),
                  numbering: it.children.ordered ? { reference: ORDERED_REF, level: 1, instance: cinst } : { reference: BULLET_REF, level: 1 }
                })
              )
            }
          }
        }
        break
      }
      case 'table': {
        const cell = (runs: Run[], i: number, head: boolean): TableCell =>
          new TableCell({
            children: [
              new Paragraph({
                children: inlineChildren(runs, { bold: head }),
                alignment: b.align[i] === 'center' ? AlignmentType.CENTER : b.align[i] === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT
              })
            ],
            shading: head ? { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } : undefined
          })
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: b.header.map((c, i) => cell(c, i, true)) }),
              ...b.rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i, false)) }))
            ]
          })
        )
        children.push(new Paragraph({ children: [] }))
        break
      }
      case 'code':
        if (!b.lines.length) b.lines.push('')
        for (const l of b.lines) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: clean(l), font: MONO, size: 20 })],
              shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
              spacing: { after: 0 }
            })
          )
        }
        children.push(new Paragraph({ children: [] }))
        break
      case 'rule':
        children.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } } }))
        break
      case 'pageBreak':
        children.push(new Paragraph({ children: [new PageBreak()] }))
        break
    }
  }
  if (!children.length) children.push(new Paragraph({ children: [] }))

  const doc = new Document({
    title: title ? clean(title) : undefined,
    creator: 'OrgAI',
    numbering: {
      config: [
        { reference: BULLET_REF, levels: levels(LevelFormat.BULLET, ['•', '◦']) },
        { reference: ORDERED_REF, levels: levels(LevelFormat.DECIMAL, ['%1.', '%2.']) }
      ]
    },
    sections: [{ children }]
  })
  return Buffer.from(await Packer.toBuffer(doc))
}
