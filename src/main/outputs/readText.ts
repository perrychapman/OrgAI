/**
 * textForAgent: a file's text for read_output. docx as Markdown-like text (headings '#', lists '-', tables as pipe rows),
 * xlsx as tab-separated text per sheet under "## Sheet <name>", pptx per slide ("## Slide <n>: <title>", text, "Speaker
 * notes: ..."), text kinds (markdown, text, csv, json, mermaid, svg) as stored. Capped at OUTPUT_TEXT_MAX_BYTES of UTF-8
 * (truncated: true). Documents, sheets and decks are read through their preview, so the preview's own caps apply (500 rows,
 * 64 columns, 200 slides, ...) and count as truncated. image, pdf and other are refused. Never throws.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { DocumentBlock, DocumentRun, OutputKind, SlidePreview } from '@shared/types'
import { OUTPUT_TEXT_MAX_BYTES } from '@shared/types'
import { previewFile } from './preview'

const REFUSED = 'OrgAI cannot read this kind of file as text.'
const TEXT_KINDS: ReadonlySet<OutputKind> = new Set(['markdown', 'text', 'csv', 'json', 'mermaid', 'svg'])

const runs = (rs: DocumentRun[]): string => rs.map((r) => r.text).join('')
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

export function blocksToMarkdown(blocks: DocumentBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        out.push(`${'#'.repeat(b.level)} ${runs(b.runs)}`)
        break
      case 'paragraph':
        out.push(runs(b.runs))
        break
      case 'list':
        out.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${runs(it)}`).join('\n'))
        break
      case 'table': {
        const rows = b.rows.map((r) => `| ${r.map((c) => cell(runs(c))).join(' | ')} |`)
        if (rows.length) {
          const width = Math.max(1, ...b.rows.map((r) => r.length))
          rows.splice(Math.max(1, b.headerRows ?? 1), 0, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`)
        }
        out.push(rows.join('\n'))
        break
      }
      case 'image':
        out.push(`[image: ${b.alt}]`)
        break
      case 'code':
        out.push('```\n' + b.text + '\n```')
        break
      case 'rule':
        out.push('---')
        break
      case 'pageBreak':
        break
    }
  }
  return out.join('\n\n')
}

const tab = (v: unknown): string => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '))

function slideText(s: SlidePreview): string {
  const parts: string[] = [`## Slide ${s.n}: ${s.title ?? ''}`.trimEnd()]
  for (const sh of s.shapes) {
    if (sh.type === 'text') {
      const t = sh.paragraphs.map((p) => `${p.bullet ? `${'  '.repeat(p.level ?? 0)}- ` : ''}${p.runs.map((r) => r.text).join('')}`).filter((l) => l.trim()).join('\n')
      if (t && t.trim() !== (s.title ?? '').trim()) parts.push(t)
    } else if (sh.type === 'table') {
      parts.push(sh.rows.map((r) => r.map((c) => cell(runs(c))).join('\t')).join('\n'))
    } else if (sh.type === 'image' && sh.alt) parts.push(`[image: ${sh.alt}]`)
    else if (sh.type === 'placeholder') parts.push(`[${sh.label}${sh.alt ? `: ${sh.alt}` : ''}]`)
  }
  if (s.notes) parts.push(`Speaker notes: ${s.notes}`)
  return parts.join('\n')
}

/** `end`, moved back when the bytes before it end inside a multi-byte UTF-8 sequence. */
export function utf8End(buf: Buffer, end: number): number {
  let i = end - 1
  let k = 0
  while (i >= 0 && k < 3 && (buf[i] & 0xc0) === 0x80) {
    i--
    k++
  }
  if (i >= 0 && buf[i] >= 0xc0) {
    const need = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : 2
    if (k + 1 < need) return i
  }
  return end
}

function capBytes(text: string, truncated: boolean): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= OUTPUT_TEXT_MAX_BYTES) return { text, truncated }
  return { text: buf.toString('utf8', 0, utf8End(buf, OUTPUT_TEXT_MAX_BYTES)), truncated: true }
}

export async function textForAgentImpl(path: string, kind: OutputKind): Promise<{ text: string; truncated: boolean } | { refused: string }> {
  try {
    if (TEXT_KINDS.has(kind)) {
      const fd = openSync(path, 'r')
      try {
        const st = fstatSync(fd)
        if (!st.isFile()) return { refused: 'That file is not a regular file.' }
        const want = Math.min(st.size, OUTPUT_TEXT_MAX_BYTES)
        const buf = Buffer.alloc(want)
        let off = 0
        while (off < want) {
          const n = readSync(fd, buf, off, want - off, off)
          if (n <= 0) break
          off += n
        }
        const cut = st.size > OUTPUT_TEXT_MAX_BYTES
        return { text: buf.toString('utf8', 0, cut ? utf8End(buf, off) : off).replace(/^﻿/, ''), truncated: cut }
      } finally {
        closeSync(fd)
      }
    }
    if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') return { refused: REFUSED }
    const p = await previewFile(path, kind)
    if (p.kind === 'none') return { refused: p.reason }
    if (p.kind === 'document') return capBytes(blocksToMarkdown(p.blocks), !!p.truncated)
    if (p.kind === 'sheets') {
      const parts = p.sheets.map((s) => `## Sheet ${s.name}\n${s.rows.map((r) => r.map((c) => tab(c.v)).join('\t')).join('\n')}${s.truncatedRows ? `\n(${s.truncatedRows} more rows not shown)` : ''}`)
      return capBytes(parts.join('\n\n'), !!(p.truncatedSheets || p.sheets.some((s) => s.truncatedRows || s.truncatedCols)))
    }
    if (p.kind === 'slides') return capBytes(p.slides.map(slideText).join('\n\n'), !!p.truncatedSlides)
    return { refused: REFUSED }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { refused: code === 'ENOENT' ? 'The file is no longer there.' : `OrgAI could not read this file: ${(e as Error).message}` }
  }
}
