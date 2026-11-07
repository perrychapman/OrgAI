/**
 * thumbForFile: the small preview of a file (OutputThumb). Never throws ('none' on any failure).
 *
 * pptx: the first slide as a SlidePreview (only that slide is parsed). Image shapes are kept only when each data URL is
 * <= 32 KB and together <= 64 KB; larger ones become 'Picture' placeholders so a thumb stays small.
 * image: a data URL only when the FILE is already <= OUTPUT_THUMB_IMAGE_MAX_BYTES (main has no image scaler); else 'none'.
 * svg: { kind: 'svg', text } only when svgProblem passes and the file is <= 64 KB, else 'none'.
 * markdown / text / csv / json / mermaid: 'lines' (first 4 non-empty lines, at most OUTPUT_THUMB_LINES_MAX_CHARS in total).
 * docx: 'lines' from the first preview blocks. xlsx: 'cells', the top-left 4 rows x 6 columns of the first sheet.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import type { DocumentBlock, OutputKind, OutputThumb, SlidePreview, SlideShape } from '@shared/types'
import { OUTPUT_THUMB_IMAGE_MAX_BYTES, OUTPUT_THUMB_LINES_MAX_CHARS } from '@shared/types'
import { sniffImage } from './imageInfo'
import { previewFile } from './preview'
import { previewPptxFile } from './pptxPreview'
import { svgProblem } from './writers'

const SVG_THUMB_MAX = 64 * 1024
const THUMB_IMG_EACH = 32 * 1024
const THUMB_IMG_TOTAL = 64 * 1024
const NONE: OutputThumb = { kind: 'none' }
const CELL_MAX = 40

function readHead(path: string, max: number): { buf: Buffer; size: number } {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    const want = Math.min(st.size, max)
    const buf = Buffer.alloc(want)
    let off = 0
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off)
      if (n <= 0) break
      off += n
    }
    return { buf: buf.subarray(0, off), size: st.size }
  } finally {
    closeSync(fd)
  }
}

/** Up to 4 lines, in total at most OUTPUT_THUMB_LINES_MAX_CHARS characters. */
export function thumbLines(all: string[]): string[] {
  const out: string[] = []
  let left = OUTPUT_THUMB_LINES_MAX_CHARS
  for (const raw of all) {
    if (out.length >= 4 || left <= 0) break
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\t/g, ' ').trimEnd()
    if (!line.trim()) continue
    const cut = line.length > left ? line.slice(0, left) : line
    out.push(cut)
    left -= cut.length
  }
  return out
}

function slideForThumb(slide: SlidePreview): SlidePreview {
  let total = 0
  const shapes: SlideShape[] = slide.shapes.map((s) => {
    if (s.type !== 'image') return s
    if (s.dataUrl.length <= THUMB_IMG_EACH && total + s.dataUrl.length <= THUMB_IMG_TOTAL) {
      total += s.dataUrl.length
      return s
    }
    return { type: 'placeholder', x: s.x, y: s.y, w: s.w, h: s.h, label: 'Picture', ...(s.alt ? { alt: s.alt } : {}) }
  })
  const out: SlidePreview = { n: slide.n, shapes }
  if (slide.title) out.title = slide.title
  if (slide.background) out.background = slide.background
  return out
}

const runText = (rs: { text: string }[]): string => rs.map((r) => r.text).join('')

function blockLines(blocks: DocumentBlock[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    if (out.length >= 8) break
    if (b.type === 'heading' || b.type === 'paragraph') out.push(runText(b.runs))
    else if (b.type === 'list') for (const it of b.items) out.push(`- ${runText(it)}`)
    else if (b.type === 'table') for (const r of b.rows) out.push(r.map((c) => runText(c)).join(' | '))
    else if (b.type === 'code') out.push(...b.text.split('\n'))
  }
  return out
}

export async function thumbForFileImpl(path: string, kind: OutputKind): Promise<OutputThumb> {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return NONE
    switch (kind) {
      case 'pptx': {
        const p = await previewPptxFile(path, 1)
        if (p.kind !== 'slides' || !p.slides.length) return NONE
        return { kind: 'slide', size: p.size, slide: slideForThumb(p.slides[0]) }
      }
      case 'image': {
        if (st.size > OUTPUT_THUMB_IMAGE_MAX_BYTES) return NONE
        const { buf } = readHead(path, OUTPUT_THUMB_IMAGE_MAX_BYTES)
        const t = sniffImage(buf)
        return t ? { kind: 'image', dataUrl: `data:image/${t};base64,${buf.toString('base64')}` } : NONE
      }
      case 'svg': {
        if (st.size > SVG_THUMB_MAX) return NONE
        const { buf } = readHead(path, SVG_THUMB_MAX)
        const text = buf.toString('utf8').replace(/^﻿/, '')
        return svgProblem(text) ? NONE : { kind: 'svg', text }
      }
      case 'markdown':
      case 'text':
      case 'csv':
      case 'json':
      case 'mermaid': {
        const { buf } = readHead(path, 16 * 1024)
        const lines = thumbLines(buf.toString('utf8').replace(/^﻿/, '').split(/\r\n|\n|\r/))
        return lines.length ? { kind: 'lines', lines } : NONE
      }
      case 'docx': {
        const p = await previewFile(path, 'docx')
        if (p.kind !== 'document') return NONE
        const lines = thumbLines(blockLines(p.blocks))
        return lines.length ? { kind: 'lines', lines } : NONE
      }
      case 'xlsx': {
        const p = await previewFile(path, 'xlsx')
        if (p.kind !== 'sheets' || !p.sheets.length) return NONE
        const rows = p.sheets[0].rows.slice(0, 4).map((r) => {
          const out: (string | number | boolean | null)[] = []
          for (let c = 0; c < 6; c++) {
            const v = r[c]?.v ?? null
            out.push(typeof v === 'string' && v.length > CELL_MAX ? `${v.slice(0, CELL_MAX - 1)}…` : v)
          }
          return out
        })
        return rows.length ? { kind: 'cells', rows } : NONE
      }
      default:
        return NONE
    }
  } catch {
    return NONE
  }
}
