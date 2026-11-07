/**
 * produce_output pptx: validate a SlideDeckInput (unknown, from an agent) and write a minimal PresentationML package
 * with jszip. No pptxgenjs, no network, no URL images, nothing fetched. Every string is plain text and XML-escaped
 * (never markup). Output is deterministic for one input (fixed zip dates, fixed part order).
 *
 * Counting rule (OUTPUT_PPTX_ELEMENTS_PER_SLIDE): title 1, subtitle 1, body 1, each bullet 1, each table ROW 1 (not each
 * cell; a table also has at most TABLE_MAX_COLUMNS columns), each image 1 (+1 for its caption). Two-content slides count
 * both columns. Slide-level bullets / body / table / image on a two-content slide with no `left` form its left column.
 * Layout, per slide: title and section show title + subtitle; content stacks bullets, body, table, image in the body area;
 * image puts the image (aspect-fit) on the left 55% and any text blocks on the right; blank has no title area unless a
 * title is given. All shapes carry explicit geometry; layouts exist for the used layout names only.
 * UNVERIFIED: that PowerPoint opens the result (structure follows what PowerPoint writes; only our own reader checked it).
 */
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import type { SlideBlock, SlideDeckInput, SlideInput } from '@shared/types'
import {
  OUTPUT_COLOR_RE,
  OUTPUT_PPTX_ELEMENTS_PER_SLIDE,
  OUTPUT_PPTX_FONT_MAX_CHARS,
  OUTPUT_PPTX_IMAGE_MAX_BYTES,
  OUTPUT_PPTX_MAX_SLIDES,
  OUTPUT_PPTX_TEXT_MAX_CHARS,
  OUTPUT_PPTX_TOTAL_MAX_BYTES
} from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { imageSize, sniffImage, type ImageType } from './imageInfo'

export interface DeckImageReader {
  /** Bytes of a deck image after the confinement and type / size checks; throws a plain sentence otherwise. */
  read(path: string): Buffer
}

export const TABLE_MAX_COLUMNS = 12
const ALT_MAX = 500
const LAYOUTS = ['title', 'section', 'content', 'two-content', 'image', 'blank'] as const
type LayoutName = (typeof LAYOUTS)[number]

// ---------- validation ----------

interface Bullet {
  text: string
  level: 0 | 1 | 2
}
interface NImage {
  type: 'image'
  data: Buffer
  img: ImageType
  w: number
  h: number
  alt: string
  caption?: string
}
type NBlock = { type: 'bullets'; items: Bullet[] } | { type: 'body'; lines: string[] } | { type: 'table'; rows: string[][]; header: boolean } | NImage
interface NSlide {
  layout: LayoutName
  title?: string
  subtitle?: string
  notes?: string[]
  main: NBlock[]
  left: NBlock[]
  right: NBlock[]
}
interface NDeck {
  wide: boolean
  accent: string
  fontHeading: string
  fontBody: string
  slides: NSlide[]
}

const bad = (m: string): never => {
  throw new Error(m)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function oneLine(v: unknown, label: string): string {
  if (typeof v !== 'string') return bad(`${label} must be text.`)
  const p = hiddenCharProblem(label, v)
  if (p) bad(p)
  if (v.length > OUTPUT_PPTX_TEXT_MAX_CHARS) bad(`${label} is longer than ${OUTPUT_PPTX_TEXT_MAX_CHARS} characters.`)
  return v
}

function prose(v: unknown, label: string): string[] {
  if (typeof v !== 'string') return bad(`${label} must be text.`)
  const t = v.replace(/\r\n?/g, '\n')
  const p = hiddenCharProblem(label, t, { prose: true })
  if (p) bad(p)
  if (t.length > OUTPUT_PPTX_TEXT_MAX_CHARS) bad(`${label} is longer than ${OUTPUT_PPTX_TEXT_MAX_CHARS} characters.`)
  return t.split('\n')
}

function bulletsOf(v: unknown, label: string): Bullet[] {
  if (!Array.isArray(v)) return bad(`${label} must be a list.`)
  return v.map((b, i) => {
    if (!isObj(b)) return bad(`${label} item ${i + 1} must be an object with text.`)
    const level = b.level === undefined ? 0 : b.level
    if (level !== 0 && level !== 1 && level !== 2) bad(`${label} item ${i + 1} has a level outside 0 to 2.`)
    return { text: oneLine(b.text, `${label} item ${i + 1}`), level: level as 0 | 1 | 2 }
  })
}

function tableOf(v: unknown, label: string): { rows: string[][]; header: boolean } {
  if (!isObj(v) || !Array.isArray(v.rows)) return bad(`${label} needs a rows list.`)
  if (!v.rows.length) bad(`${label} has no rows.`)
  let width = 0
  const rows = v.rows.map((r, ri) => {
    if (!Array.isArray(r)) return bad(`${label} row ${ri + 1} must be a list of cells.`)
    if (r.length > TABLE_MAX_COLUMNS) bad(`${label} row ${ri + 1} has more than ${TABLE_MAX_COLUMNS} columns.`)
    const cells = r.map((c, ci) => oneLine(c, `${label} row ${ri + 1} cell ${ci + 1}`))
    width = Math.max(width, cells.length)
    return cells
  })
  if (!width) bad(`${label} has no columns.`)
  for (const r of rows) while (r.length < width) r.push('')
  if (v.header !== undefined && typeof v.header !== 'boolean') bad(`${label} header must be true or false.`)
  return { rows, header: v.header === true }
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]+:\/\/|data:|file:|javascript:|\\\\)/i

function imageOf(v: unknown, label: string, images: DeckImageReader, totals: { bytes: number }): NImage {
  if (!isObj(v)) return bad(`${label} must be an object with path and alt.`)
  if (typeof v.path !== 'string' || !v.path.trim()) return bad(`${label} needs a path to an image file.`)
  const pathProblem = hiddenCharProblem(`${label} path`, v.path)
  if (pathProblem) bad(pathProblem)
  if (URL_LIKE.test(v.path.trim())) bad(`${label} must be a file in the project, not a web address.`)
  if (typeof v.alt !== 'string') bad(`${label} needs alt text (a short description).`)
  const alt = oneLine(v.alt, `${label} alt text`)
  if (alt.length > ALT_MAX) bad(`${label} alt text is longer than ${ALT_MAX} characters.`)
  const caption = v.caption === undefined ? undefined : oneLine(v.caption, `${label} caption`)
  let data: Buffer
  try {
    data = images.read(v.path)
  } catch (e) {
    return bad(e instanceof Error && e.message ? e.message : `${label} could not be read.`)
  }
  if (!Buffer.isBuffer(data)) return bad(`${label} could not be read.`)
  if (data.length > OUTPUT_PPTX_IMAGE_MAX_BYTES) bad(`${label} is larger than ${OUTPUT_PPTX_IMAGE_MAX_BYTES / 1024 / 1024} MB.`)
  const img = sniffImage(data)
  if (!img) bad(`${label} is not a PNG, JPEG, GIF or WebP image.`)
  totals.bytes += data.length
  if (totals.bytes > OUTPUT_PPTX_TOTAL_MAX_BYTES) bad('The images together are too large for one deck.')
  const size = imageSize(data, img) ?? { w: 4, h: 3 }
  return { type: 'image', data, img: img as ImageType, w: size.w, h: size.h, alt, ...(caption !== undefined ? { caption } : {}) }
}

function blockOf(b: unknown, label: string, images: DeckImageReader, totals: { bytes: number }): NBlock {
  if (!isObj(b)) return bad(`${label} must be an object.`)
  switch ((b as unknown as SlideBlock).type) {
    case 'bullets':
      return { type: 'bullets', items: bulletsOf(b.bullets, `${label} bullets`) }
    case 'body':
      return { type: 'body', lines: prose(b.text, `${label} text`) }
    case 'image':
      return imageOf(b, label, images, totals)
    case 'table':
      return { type: 'table', ...tableOf(b, `${label} table`) }
    default:
      return bad(`${label} has an unknown type (use bullets, body, image or table).`)
  }
}

function weigh(blocks: NBlock[]): number {
  let n = 0
  for (const b of blocks) {
    if (b.type === 'bullets') n += b.items.length
    else if (b.type === 'table') n += b.rows.length
    else if (b.type === 'image') n += b.caption !== undefined ? 2 : 1
    else n += 1
  }
  return n
}

function validate(input: unknown, images: DeckImageReader): NDeck {
  if (!isObj(input)) return bad('The deck must be an object with a slides list.')
  const size = input.size === undefined ? '16:9' : input.size
  if (size !== '16:9' && size !== '4:3') bad('size must be "16:9" or "4:3".')
  let accent = '2F5597'
  let fontHeading = 'Calibri'
  let fontBody = 'Calibri'
  if (input.theme !== undefined) {
    if (!isObj(input.theme)) bad('theme must be an object.')
    const t = input.theme as Record<string, unknown>
    if (t.accent !== undefined) {
      if (typeof t.accent !== 'string' || !OUTPUT_COLOR_RE.test(t.accent)) bad('theme accent must be a colour like #2f5597.')
      accent = (t.accent as string).slice(1).toUpperCase()
    }
    for (const key of ['fontHeading', 'fontBody'] as const) {
      const f = t[key]
      if (f === undefined) continue
      if (typeof f !== 'string' || !f.trim()) bad(`theme ${key} must be a font name.`)
      const s = f as string
      const p = hiddenCharProblem(`theme ${key}`, s)
      if (p) bad(p)
      if (s.length > OUTPUT_PPTX_FONT_MAX_CHARS) bad(`theme ${key} is longer than ${OUTPUT_PPTX_FONT_MAX_CHARS} characters.`)
      if (/[<>&"'\\/;{}]/.test(s)) bad(`theme ${key} has characters a font name cannot have.`)
      if (key === 'fontHeading') fontHeading = s.trim()
      else fontBody = s.trim()
    }
  }
  if (!Array.isArray(input.slides) || !input.slides.length) bad('A deck needs at least one slide.')
  const rawSlides = input.slides as unknown[]
  if (rawSlides.length > OUTPUT_PPTX_MAX_SLIDES) bad(`A deck can have at most ${OUTPUT_PPTX_MAX_SLIDES} slides.`)
  const totals = { bytes: 0 }
  const slides = rawSlides.map((raw, si): NSlide => {
    const L = `Slide ${si + 1}`
    if (!isObj(raw)) return bad(`${L} must be an object.`)
    const s = raw as unknown as SlideInput & Record<string, unknown>
    if (!LAYOUTS.includes(s.layout as LayoutName)) bad(`${L} has an unknown layout (use ${LAYOUTS.join(', ')}).`)
    const out: NSlide = { layout: s.layout, main: [], left: [], right: [] }
    if (s.title !== undefined) out.title = oneLine(s.title, `${L} title`)
    if (s.subtitle !== undefined) out.subtitle = oneLine(s.subtitle, `${L} subtitle`)
    if (s.notes !== undefined) out.notes = prose(s.notes, `${L} notes`)
    const own: NBlock[] = []
    if (s.bullets !== undefined) own.push({ type: 'bullets', items: bulletsOf(s.bullets, `${L} bullets`) })
    if (s.body !== undefined) own.push({ type: 'body', lines: prose(s.body, `${L} body`) })
    if (s.table !== undefined) own.push({ type: 'table', ...tableOf(s.table, `${L} table`) })
    if (s.image !== undefined) own.push(imageOf(s.image, `${L} image`, images, totals))
    if (s.left !== undefined && !Array.isArray(s.left)) bad(`${L} left must be a list of blocks.`)
    if (s.right !== undefined && !Array.isArray(s.right)) bad(`${L} right must be a list of blocks.`)
    const left = (s.left ?? []).map((b, i) => blockOf(b, `${L} left block ${i + 1}`, images, totals))
    const right = (s.right ?? []).map((b, i) => blockOf(b, `${L} right block ${i + 1}`, images, totals))
    if (out.layout === 'two-content') {
      out.left = s.left !== undefined ? left : own
      out.right = right
    } else {
      if (left.length || right.length) bad(`${L} uses left or right, which only the two-content layout has.`)
      out.main = own
    }
    const count = (out.title ? 1 : 0) + (out.subtitle ? 1 : 0) + weigh(out.main) + weigh(out.left) + weigh(out.right)
    if (count > OUTPUT_PPTX_ELEMENTS_PER_SLIDE) bad(`${L} has ${count} elements; at most ${OUTPUT_PPTX_ELEMENTS_PER_SLIDE} (bullets and table rows count one each).`)
    return out
  })
  return { wide: size === '16:9', accent, fontHeading, fontBody, slides }
}

// ---------- XML helpers ----------

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function esc(s: string): string {
  return s
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '�')
    .replace(/\t/g, '    ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function xfrm(b: Box, tag = 'a:xfrm'): string {
  return `<${tag}><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.max(1, Math.round(b.w))}" cy="${Math.max(1, Math.round(b.h))}"/></${tag}>`
}

interface Ctx {
  W: number
  H: number
  nextId: number
  /** Register image bytes; returns the slide-local relationship id. */
  addImage: (data: Buffer, type: ImageType) => string
}

const region = (c: Ctx, fx: number, fy: number, fw: number, fh: number): Box => ({ x: c.W * fx, y: c.H * fy, w: c.W * fw, h: c.H * fh })

function run(text: string, sizePt: number, extra = '', fill = ''): string {
  return `<a:r><a:rPr lang="en-US" sz="${Math.round(sizePt * 100)}"${extra} dirty="0">${fill}</a:rPr><a:t>${esc(text)}</a:t></a:r>`
}

function para(text: string, sizePt: number, opts: { level?: number; bullet?: boolean; algn?: 'l' | 'ctr' | 'r'; bold?: boolean; italic?: boolean; fill?: string; spcBefore?: number } = {}): string {
  const level = opts.level ?? 0
  const attrs = opts.bullet ? ` marL="${342900 + level * 342900}" indent="-285750" lvl="${level}"` : ` marL="0" indent="0"${opts.algn ? ` algn="${opts.algn}"` : ''}`
  const spc = opts.spcBefore ? `<a:spcBef><a:spcPts val="${Math.round(opts.spcBefore * 100)}"/></a:spcBef>` : ''
  const bu = opts.bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${level === 0 ? '•' : '–'}"/>` : '<a:buNone/>'
  const pPr = `<a:pPr${attrs}>${spc}${bu}</a:pPr>`
  if (!text) return `<a:p>${pPr}<a:endParaRPr lang="en-US" sz="${Math.round(sizePt * 100)}" dirty="0"/></a:p>`
  return `<a:p>${pPr}${run(text, sizePt, `${opts.bold ? ' b="1"' : ''}${opts.italic ? ' i="1"' : ''}`, opts.fill ?? '')}</a:p>`
}

function textBox(c: Ctx, name: string, b: Box, paras: string, o: { ph?: string; anchor?: 't' | 'ctr' | 'b' } = {}): string {
  const id = c.nextId++
  const nv = o.ph
    ? `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${o.ph}</p:nvPr>`
    : '<p:cNvSpPr txBox="1"/><p:nvPr/>'
  const geom = o.ph ? '' : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)} ${id - 1}"/>${nv}</p:nvSpPr><p:spPr>${xfrm(b)}${geom}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${o.anchor ?? 't'}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
}

/** Largest size from a ladder at which the paragraphs are estimated to fit the box. */
function fitSize(texts: { text: string; level: number }[], b: Box, ladder: number[]): number {
  const wIn = b.w / 914400 - 0.2
  const hIn = b.h / 914400 - 0.1
  for (const s of ladder) {
    let h = 0
    for (const t of texts) {
      const size = Math.max(10, s - t.level * 2)
      const width = Math.max(1, wIn - 0.4 - t.level * 0.4)
      const perLine = Math.max(4, Math.floor((width * 72) / (size * 0.5)))
      const lines = Math.max(1, Math.ceil(t.text.length / perLine))
      h += (lines * size * 1.2 + size * 0.5) / 72
    }
    if (h <= hIn) return s
  }
  return ladder[ladder.length - 1]
}

const LADDER = [24, 22, 20, 18, 16, 14, 12, 11, 10]

function bulletsXml(c: Ctx, items: Bullet[], b: Box): string {
  const size = fitSize(items.map((i) => ({ text: i.text, level: i.level })), b, LADDER)
  const paras = items.map((i) => para(i.text, Math.max(10, size - i.level * 2), { bullet: true, level: i.level, spcBefore: i.level === 0 ? 6 : 3 })).join('')
  return textBox(c, 'Content', b, paras || para('', size))
}

function bodyXml(c: Ctx, lines: string[], b: Box): string {
  const size = fitSize(lines.map((t) => ({ text: t, level: 0 })), b, LADDER)
  return textBox(c, 'Text', b, lines.map((t) => para(t, size, { spcBefore: 4 })).join(''))
}

function tableXml(c: Ctx, rows: string[][], header: boolean, b: Box, accent: string): string {
  const id = c.nextId++
  const cols = rows[0].length
  const size = rows.length > 14 ? 10 : rows.length > 8 ? 12 : 14
  const rowH = Math.min(b.h / rows.length, 0.5 * 914400, Math.max(size * 2.2 * 12700, 0))
  const colW = Math.floor(b.w / cols)
  const line = (tag: string): string => `<a:${tag} w="9525"><a:solidFill><a:srgbClr val="9CA3AF"/></a:solidFill></a:${tag}>`
  const borders = `${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}`
  const trs = rows
    .map((r, ri) => {
      const head = header && ri === 0
      const fill = head ? `<a:solidFill><a:srgbClr val="${accent}"/></a:solidFill>` : ''
      const txtFill = head ? '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' : ''
      const tcs = r
        .map((cell) => {
          const p = cell ? `<a:p>${run(cell, size, head ? ' b="1"' : '', txtFill)}</a:p>` : `<a:p><a:endParaRPr lang="en-US" sz="${size * 100}" dirty="0"/></a:p>`
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${p}</a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720">${borders}${fill}</a:tcPr></a:tc>`
        })
        .join('')
      return `<a:tr h="${Math.round(rowH)}">${tcs}</a:tr>`
    })
    .join('')
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('')
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id - 1}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm({ x: b.x, y: b.y, w: colW * cols, h: rowH * rows.length }, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr${header ? ' firstRow="1"' : ''}/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

function imageXml(c: Ctx, im: NImage, b: Box): string {
  const capH = im.caption !== undefined ? Math.min(c.H * 0.08, b.h * 0.2) : 0
  const area: Box = { x: b.x, y: b.y, w: b.w, h: b.h - capH }
  const ar = im.w / im.h
  let w = area.w
  let h = w / ar
  if (h > area.h) {
    h = area.h
    w = h * ar
  }
  const pos: Box = { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h }
  const rid = c.addImage(im.data, im.img)
  const id = c.nextId++
  let out = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id - 1}" descr="${esc(im.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(pos)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  if (im.caption !== undefined && capH > 0) {
    out += textBox(c, 'Caption', { x: b.x, y: area.y + area.h, w: b.w, h: capH }, para(im.caption, 14, { algn: 'ctr', italic: true }))
  }
  return out
}

function weightOf(b: NBlock): number {
  if (b.type === 'bullets') return Math.max(2, Math.min(6, b.items.length * 0.6))
  if (b.type === 'body') return Math.max(1.5, Math.min(5, b.lines.length * 0.8))
  if (b.type === 'table') return Math.max(1.5, Math.min(6, b.rows.length * 0.5))
  return 3
}

/** Stack blocks in a region, vertical shares by weight. */
function stack(c: Ctx, blocks: NBlock[], r: Box, accent: string): string {
  if (!blocks.length) return ''
  const gap = c.H * 0.02
  const total = blocks.reduce((s, b) => s + weightOf(b), 0)
  const free = r.h - gap * (blocks.length - 1)
  let y = r.y
  let out = ''
  for (const b of blocks) {
    const h = blocks.length === 1 ? r.h : (free * weightOf(b)) / total
    const box: Box = { x: r.x, y, w: r.w, h }
    if (b.type === 'bullets') out += bulletsXml(c, b.items, box)
    else if (b.type === 'body') out += bodyXml(c, b.lines, box)
    else if (b.type === 'table') out += tableXml(c, b.rows, b.header, box, accent)
    else out += imageXml(c, b, box)
    y += h + gap
  }
  return out
}

// ---------- slides ----------

const MX = 0.0625

function slideXml(deck: NDeck, s: NSlide, c: Ctx): string {
  let shapes = ''
  const accentBar = (fx: number, fy: number, fw: number, fh: number): string => {
    const id = c.nextId++
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent ${id - 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(region(c, fx, fy, fw, fh))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  }
  const titleBox = region(c, MX, 0.06, 1 - 2 * MX, 0.17)
  const bodyArea = region(c, MX, 0.27, 1 - 2 * MX, 0.64)
  switch (s.layout) {
    case 'title': {
      shapes += accentBar(0.1, 0.52, 0.2, 0.012)
      shapes += textBox(c, 'Title', region(c, 0.1, 0.24, 0.8, 0.26), para(s.title ?? '', 44, { bold: true }), { ph: '<p:ph type="ctrTitle"/>', anchor: 'b' })
      if (s.subtitle) shapes += textBox(c, 'Subtitle', region(c, 0.1, 0.56, 0.8, 0.16), para(s.subtitle, 24), { ph: '<p:ph type="subTitle" idx="1"/>' })
      shapes += stack(c, s.main, region(c, 0.1, 0.74, 0.8, 0.2), deck.accent)
      break
    }
    case 'section': {
      shapes += accentBar(0, 0.3, 0.025, 0.3)
      shapes += textBox(c, 'Title', region(c, 0.08, 0.3, 0.84, 0.18), para(s.title ?? '', 40, { bold: true }), { ph: '<p:ph type="title"/>', anchor: 'b' })
      if (s.subtitle) shapes += textBox(c, 'Subtitle', region(c, 0.08, 0.5, 0.84, 0.12), para(s.subtitle, 22), { ph: '<p:ph type="body" idx="1"/>' })
      shapes += stack(c, s.main, region(c, 0.08, 0.66, 0.84, 0.26), deck.accent)
      break
    }
    case 'content':
    case 'image':
    case 'two-content':
    case 'blank': {
      let top = bodyArea
      if (s.layout === 'blank' && !s.title) top = region(c, MX, 0.06, 1 - 2 * MX, 0.86)
      if (s.title || s.layout !== 'blank') {
        if (s.title) shapes += textBox(c, 'Title', titleBox, para(s.title, 32, { bold: true }), { ph: '<p:ph type="title"/>', anchor: 'ctr' })
        if (s.subtitle) {
          shapes += textBox(c, 'Subtitle', region(c, MX, 0.2, 1 - 2 * MX, 0.07), para(s.subtitle, 16, { italic: true }))
          top = region(c, MX, 0.29, 1 - 2 * MX, 0.62)
        }
      }
      if (s.layout === 'two-content') {
        const gap = 0.03
        const cw = (1 - 2 * MX - gap) / 2
        shapes += stack(c, s.left, { x: c.W * MX, y: top.y, w: c.W * cw, h: top.h }, deck.accent)
        shapes += stack(c, s.right, { x: c.W * (MX + cw + gap), y: top.y, w: c.W * cw, h: top.h }, deck.accent)
      } else if (s.layout === 'image') {
        const imgs = s.main.filter((b) => b.type === 'image')
        const rest = s.main.filter((b) => b.type !== 'image')
        if (!rest.length) shapes += stack(c, imgs, top, deck.accent)
        else {
          const lw = 0.55
          shapes += stack(c, imgs, { x: top.x, y: top.y, w: top.w * lw, h: top.h }, deck.accent)
          shapes += stack(c, rest, { x: top.x + top.w * (lw + 0.04), y: top.y, w: top.w * (1 - lw - 0.04), h: top.h }, deck.accent)
        }
      } else shapes += stack(c, s.main, top, deck.accent)
      break
    }
  }
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

// ---------- fixed parts ----------

function themeXml(deck: NDeck): string {
  const clr = (n: string, v: string): string => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`
  const font = (n: string, f: string): string => `<a:${n}><a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${n}>`
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const ln = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
  return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="OrgAI"><a:themeElements><a:clrScheme name="OrgAI">${clr('dk1', '111827')}${clr('lt1', 'FFFFFF')}${clr('dk2', '374151')}${clr('lt2', 'F3F4F6')}${clr('accent1', deck.accent)}${clr('accent2', 'ED7D31')}${clr('accent3', '70AD47')}${clr('accent4', 'FFC000')}${clr('accent5', '5B9BD5')}${clr('accent6', '7F7F7F')}${clr('hlink', '0563C1')}${clr('folHlink', '954F72')}</a:clrScheme><a:fontScheme name="OrgAI">${font('majorFont', deck.fontHeading)}${font('minorFont', deck.fontBody)}</a:fontScheme><a:fmtScheme name="OrgAI"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
}

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

function levelStyle(level: number, sz: number, bullet: boolean, major: boolean): string {
  const mar = bullet ? ` marL="${342900 + (level - 1) * 342900}" indent="-285750"` : ` marL="${(level - 1) * 457200}" indent="0"`
  const bu = bullet ? `<a:buFont typeface="Arial"/><a:buChar char="${level === 1 ? '•' : '–'}"/>` : '<a:buNone/>'
  const f = major ? 'mj' : 'mn'
  return `<a:lvl${level}pPr${mar} algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">${bu}<a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+${f}-lt"/><a:ea typeface="+${f}-ea"/><a:cs typeface="+${f}-cs"/></a:defRPr></a:lvl${level}pPr>`
}

function phSp(id: number, name: string, ph: string, b: Box | null, prompt: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${b ? xfrm(b) : ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(prompt)}</a:t></a:r></a:p></p:txBody></p:sp>`
}

function masterXml(W: number, H: number, layoutRids: string[]): string {
  const r = (fx: number, fy: number, fw: number, fh: number): Box => ({ x: W * fx, y: H * fy, w: W * fw, h: H * fh })
  const title = phSp(2, 'Title Placeholder 1', '<p:ph type="title"/>', r(MX, 0.06, 1 - 2 * MX, 0.17), 'Click to edit Master title style')
  const body = phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', r(MX, 0.27, 1 - 2 * MX, 0.64), 'Click to edit Master text styles')
  const ids = layoutRids.map((rid, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="${rid}"/>`).join('')
  const bodyLevels = [1, 2, 3, 4, 5].map((l) => levelStyle(l, [2800, 2400, 2000, 1800, 1800][l - 1], true, false)).join('')
  const titleLevel = levelStyle(1, 4000, false, true)
  const other = [1, 2, 3].map((l) => levelStyle(l, 1800, false, false)).join('')
  return `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${title}${body}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst><p:txStyles><p:titleStyle>${titleLevel}</p:titleStyle><p:bodyStyle>${bodyLevels}</p:bodyStyle><p:otherStyle>${other}</p:otherStyle></p:txStyles></p:sldMaster>`
}

const LAYOUT_META: Record<LayoutName, { type: string; name: string }> = {
  title: { type: 'title', name: 'Title Slide' },
  section: { type: 'secHead', name: 'Section Header' },
  content: { type: 'obj', name: 'Title and Content' },
  'two-content': { type: 'twoObj', name: 'Two Content' },
  image: { type: 'obj', name: 'Content with Picture' },
  blank: { type: 'blank', name: 'Blank' }
}

function layoutXml(layout: LayoutName, W: number, H: number): string {
  const r = (fx: number, fy: number, fw: number, fh: number): Box => ({ x: W * fx, y: H * fy, w: W * fw, h: H * fh })
  const t = 'Click to edit Master title style'
  const m = 'Click to edit Master text styles'
  let sps = ''
  if (layout === 'title') {
    sps = phSp(2, 'Title 1', '<p:ph type="ctrTitle"/>', r(0.1, 0.24, 0.8, 0.26), t) + phSp(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', r(0.1, 0.56, 0.8, 0.16), m)
  } else if (layout === 'section') {
    sps = phSp(2, 'Title 1', '<p:ph type="title"/>', r(0.08, 0.3, 0.84, 0.18), t) + phSp(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', r(0.08, 0.5, 0.84, 0.12), m)
  } else if (layout === 'two-content') {
    const cw = (1 - 2 * MX - 0.03) / 2
    sps = phSp(2, 'Title 1', '<p:ph type="title"/>', null, t) + phSp(3, 'Content Placeholder 2', '<p:ph sz="half" idx="1"/>', r(MX, 0.27, cw, 0.64), m) + phSp(4, 'Content Placeholder 3', '<p:ph sz="half" idx="2"/>', r(MX + cw + 0.03, 0.27, cw, 0.64), m)
  } else if (layout === 'content' || layout === 'image') {
    sps = phSp(2, 'Title 1', '<p:ph type="title"/>', null, t)
    if (layout === 'content') sps += phSp(3, 'Content Placeholder 2', '<p:ph idx="1"/>', null, m)
  }
  const { type, name } = LAYOUT_META[layout]
  return `${XML_HEAD}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GRP}${sps}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}

function notesMasterXml(): string {
  const sldImg = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>'
  const body = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp>'
  const style = '<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>'
  return `${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${sldImg}${body}</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle>${style}</p:notesStyle></p:notesMaster>`
}

function notesSlideXml(lines: string[]): string {
  const sldImg = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
  const ps = lines.map((l) => (l ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>')).join('')
  const body = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${ps}</p:txBody></p:sp>`
  return `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GRP}${sldImg}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
}

function rels(items: { id: string; type: string; target: string }[]): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((i) => `<Relationship Id="${i.id}" Type="${REL}/${i.type}" Target="${i.target}"/>`).join('')}</Relationships>`
}

// ---------- the package ----------

export async function renderDeck(input: SlideDeckInput, images: DeckImageReader): Promise<Buffer> {
  const deck = validate(input, images)
  const W = deck.wide ? 12192000 : 9144000
  const H = 6858000
  const zip = new JSZip()
  const FIXED = new Date(Date.UTC(2000, 0, 1))
  const put = (name: string, data: string | Buffer): void => {
    zip.file(name, data, { date: FIXED, createFolders: false, compression: 'DEFLATE' })
  }

  // media, deduplicated by content
  const media = new Map<string, { name: string; type: ImageType; data: Buffer }>()
  const usedLayouts = LAYOUTS.filter((l) => deck.slides.some((s) => s.layout === l))
  const layoutNo = (l: LayoutName): number => usedLayouts.indexOf(l) + 1
  const notesSlides: number[] = []

  deck.slides.forEach((s, i) => {
    const n = i + 1
    const slideRels: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: 'slideLayout', target: `../slideLayouts/slideLayout${layoutNo(s.layout)}.xml` }]
    const ctx: Ctx = {
      W,
      H,
      nextId: 2,
      addImage: (data, type) => {
        const key = createHash('sha256').update(data).digest('hex')
        let m = media.get(key)
        if (!m) {
          m = { name: `image${media.size + 1}.${type === 'jpeg' ? 'jpg' : type}`, type, data }
          media.set(key, m)
        }
        const target = `../media/${m.name}`
        const existing = slideRels.find((r) => r.type === 'image' && r.target === target)
        if (existing) return existing.id
        const id = `rId${slideRels.length + 1}`
        slideRels.push({ id, type: 'image', target })
        return id
      }
    }
    const xml = slideXml(deck, s, ctx)
    if (s.notes && s.notes.some((l) => l.trim())) {
      notesSlides.push(n)
      slideRels.push({ id: `rId${slideRels.length + 1}`, type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` })
      put(`ppt/notesSlides/notesSlide${n}.xml`, notesSlideXml(s.notes))
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([{ id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' }, { id: 'rId2', type: 'slide', target: `../slides/slide${n}.xml` }]))
    }
    put(`ppt/slides/slide${n}.xml`, xml)
    put(`ppt/slides/_rels/slide${n}.xml.rels`, rels(slideRels))
  })

  // slide layouts and master
  usedLayouts.forEach((l, i) => {
    put(`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(l, W, H))
    put(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]))
  })
  const layoutRids = usedLayouts.map((_l, i) => `rId${i + 1}`)
  put('ppt/slideMasters/slideMaster1.xml', masterXml(W, H, layoutRids))
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([...usedLayouts.map((_l, i) => ({ id: `rId${i + 1}`, type: 'slideLayout', target: `../slideLayouts/slideLayout${i + 1}.xml` })), { id: `rId${usedLayouts.length + 1}`, type: 'theme', target: '../theme/theme1.xml' }]))
  put('ppt/theme/theme1.xml', themeXml(deck))
  const hasNotes = notesSlides.length > 0
  if (hasNotes) {
    put('ppt/notesMasters/notesMaster1.xml', notesMasterXml())
    put('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([{ id: 'rId1', type: 'theme', target: '../theme/theme2.xml' }]))
    put('ppt/theme/theme2.xml', themeXml(deck))
  }
  for (const m of media.values()) put(`ppt/media/${m.name}`, m.data)

  // presentation
  const presRels: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }]
  deck.slides.forEach((_s, i) => presRels.push({ id: `rId${i + 2}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))
  let nextRid = deck.slides.length + 2
  const notesRid = hasNotes ? `rId${nextRid++}` : ''
  if (hasNotes) presRels.push({ id: notesRid, type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' })
  presRels.push({ id: `rId${nextRid++}`, type: 'presProps', target: 'presProps.xml' }, { id: `rId${nextRid++}`, type: 'viewProps', target: 'viewProps.xml' }, { id: `rId${nextRid++}`, type: 'theme', target: 'theme/theme1.xml' }, { id: `rId${nextRid++}`, type: 'tableStyles', target: 'tableStyles.xml' })
  const sldIds = deck.slides.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')
  const defRPr = (lvl: number): string => `<a:lvl${lvl}pPr marL="${(lvl - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${lvl}pPr>`
  put(
    'ppt/presentation.xml',
    `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesRid}"/></p:notesMasterIdLst>` : ''}<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"${deck.wide ? '' : ' type="screen4x3"'}/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${defRPr(1)}${defRPr(2)}${defRPr(3)}</p:defaultTextStyle></p:presentation>`
  )
  put('ppt/_rels/presentation.xml.rels', rels(presRels))
  put('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr ${NS}/>`)
  put('ppt/viewProps.xml', `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`)
  put('ppt/tableStyles.xml', `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)

  // docProps
  const first = deck.slides.find((s) => s.title)?.title ?? 'Presentation'
  put('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(first)}</dc:title><dc:creator>OrgAI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`)
  put('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OrgAI</Application><Slides>${deck.slides.length}</Slides><PresentationFormat>${deck.wide ? 'Widescreen' : 'On-screen Show (4:3)'}</PresentationFormat></Properties>`)
  put(
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`
  )

  // content types first
  const ov = (part: string, ct: string): string => `<Override PartName="/${part}" ContentType="${ct}"/>`
  const P = 'application/vnd.openxmlformats-officedocument.presentationml'
  const types =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    [...new Set([...media.values()].map((m) => m.type))].map((t) => `<Default Extension="${t === 'jpeg' ? 'jpg' : t}" ContentType="image/${t}"/>`).join('') +
    ov('ppt/presentation.xml', `${P}.presentation.main+xml`) +
    ov('ppt/slideMasters/slideMaster1.xml', `${P}.slideMaster+xml`) +
    usedLayouts.map((_l, i) => ov(`ppt/slideLayouts/slideLayout${i + 1}.xml`, `${P}.slideLayout+xml`)).join('') +
    deck.slides.map((_s, i) => ov(`ppt/slides/slide${i + 1}.xml`, `${P}.slide+xml`)).join('') +
    (hasNotes ? ov('ppt/notesMasters/notesMaster1.xml', `${P}.notesMaster+xml`) + ov('ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') : '') +
    notesSlides.map((n) => ov(`ppt/notesSlides/notesSlide${n}.xml`, `${P}.notesSlide+xml`)).join('') +
    ov('ppt/presProps.xml', `${P}.presProps+xml`) +
    ov('ppt/viewProps.xml', `${P}.viewProps+xml`) +
    ov('ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') +
    ov('ppt/tableStyles.xml', `${P}.tableStyles+xml`) +
    ov('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
    ov('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
    '</Types>'
  // JSZip keeps insertion order; the content types part goes first in the archive.
  const ordered = new JSZip()
  ordered.file('[Content_Types].xml', types, { date: FIXED, createFolders: false, compression: 'DEFLATE' })
  const names = Object.keys(zip.files).sort()
  for (const name of names) {
    const f = zip.file(name)
    if (f) ordered.file(name, await f.async('nodebuffer'), { date: FIXED, createFolders: false, compression: name.startsWith('ppt/media/') ? 'STORE' : 'DEFLATE' })
  }
  const out = await ordered.generateAsync({ type: 'nodebuffer', platform: 'DOS', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  if (out.length > OUTPUT_PPTX_TOTAL_MAX_BYTES) bad('The deck is larger than the 40 MB limit.')
  return out
}
