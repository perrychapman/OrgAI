/**
 * pptx preview: a deck file -> OutputPreview kind 'slides' (data only, never HTML). Hostile input is assumed.
 *
 * Gates, in order: regular file <= 40 MB; zipGuard (zipInfo, entry names with no `..`, absolute or backslash form, one entry
 * <= 16 MB, the sum of XML parts <= OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES, then zipVerifyEntries inflates every entry against its
 * directory); a macro deck (vbaProject part or a macroEnabled content type) is refused; JSZip loads the package; every part is
 * parsed by xmlLite (no DTD, no entities, capped). Relationships resolve only inside the package (normalised, no `..` above
 * the root, no absolute or scheme targets); `TargetMode="External"` targets are never read or fetched (a hyperlink's http(s) /
 * mailto text may be shown). Media: only png / jpeg / gif / webp by magic bytes, each <= OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES,
 * all together <= OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES, as data URLs; everything else (EMF, WMF, SVG, OLE, ActiveX, charts,
 * SmartArt, video) is a placeholder and its part is never read. Colours are validated `#rrggbb` or dropped.
 * Geometry is inherited one level (layout, then master) by placeholder; text defaults come from the same chain.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import JSZip from 'jszip'
import type { DocumentRun, OutputPreview, SlideParagraph, SlidePreview, SlideRun, SlideShape } from '@shared/types'
import {
  OUTPUT_COLOR_RE,
  OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES,
  OUTPUT_PPTX_TOTAL_MAX_BYTES,
  OUTPUT_PREVIEW_COLUMNS_MAX,
  OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES,
  OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES,
  OUTPUT_PREVIEW_ROWS_MAX,
  OUTPUT_PREVIEW_SLIDES_MAX,
  OUTPUT_PREVIEW_SLIDE_SHAPES_MAX
} from '@shared/types'
import { sniffImage } from './imageInfo'
import { child, childrenNamed, descend, parseXml, XmlLiteError, type XmlEl } from './xmlLite'
import { zipEntryNames, zipEntrySize, zipInfo, zipMaxSize, zipSumSizes, zipVerifyEntries } from './zipGuard'

const none = (reason: string): OutputPreview => ({ kind: 'none', reason })

const ENTRY_MAX = 16 * 1024 * 1024
const TEXT_BUDGET = 4 * 1024 * 1024
const SHAPE_TEXT_MAX = 100_000
const NOTES_MAX = 20_000
const CELL_TEXT_MAX = 2000
const GROUP_DEPTH_MAX = 8
const PARAS_MAX = 1000
const ELEMENTS_BUDGET = 1_500_000
export const DECK_SHAPES_BUDGET = 20_000
export const DECK_CELLS_BUDGET = 200_000
const TOO_LARGE ='This deck is too large to preview here. Open it instead.'

function readCapped(path: string, cap: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    const want = Math.min(st.size, cap + 1)
    const buf = Buffer.alloc(want)
    let off = 0
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, off)
      if (n <= 0) break
      off += n
    }
    return off === want ? buf : buf.subarray(0, off)
  } finally {
    closeSync(fd)
  }
}

// ---------- package ----------

interface Rel {
  type: string
  /** Resolved package path; null for external or unresolvable targets. */
  target: string | null
  external: boolean
  raw: string
}

/** Resolve a relationship target against the folder of its source part, inside the package only. */
export function resolveTarget(baseDir: string, target: string): string | null {
  if (!target || target.length > 512) return null
  if (target.startsWith('/') || target.includes('\\') || target.includes('\0') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null
  const out = baseDir ? baseDir.split('/') : []
  for (const seg of target.split('#')[0].split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length ? out.join('/') : null
}

const dirOf = (part: string): string => (part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '')
const relsPart = (part: string): string => {
  const i = part.lastIndexOf('/')
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`
}

class Pkg {
  private xml = new Map<string, XmlEl | null>()
  private rels = new Map<string, Map<string, Rel>>()
  private xmlRead = 0
  private readonly elements = { left: ELEMENTS_BUDGET }
  imageReads = 0
  /** Bytes charged per USE of an image (each shape or background), not per distinct part. */
  imageBytes = 0
  private images = new Map<string, { dataUrl: string; len: number } | null>()
  constructor(
    readonly zip: JSZip,
    readonly names: Set<string>,
    readonly buf: Buffer,
    readonly maxXmlBytes: number = OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES
  ) {}

  async text(name: string): Promise<string | null> {
    if (!this.names.has(name)) return null
    const f = this.zip.file(name)
    if (!f) return null
    // charge the declared size at 1x BEFORE reading, whatever the part is called
    this.xmlRead += zipEntrySize(this.buf, name) ?? 0
    if (this.xmlRead > this.maxXmlBytes) throw new XmlLiteError(TOO_LARGE)
    const s = await f.async('string')
    if (this.xmlRead + s.length > this.maxXmlBytes * 2) throw new XmlLiteError(TOO_LARGE)
    return s
  }

  async parsed(name: string): Promise<XmlEl | null> {
    if (this.xml.has(name)) return this.xml.get(name) ?? null
    let el: XmlEl | null = null
    try {
      const s = await this.text(name)
      el = s === null ? null : parseXml(s, {}, this.elements)
    } catch (e) {
      if (!(e instanceof XmlLiteError)) throw e
      if (e.message === TOO_LARGE) throw e
      if (this.elements.left < 0) throw new XmlLiteError(TOO_LARGE)
    }
    this.xml.set(name, el)
    return el
  }

  /** Forget a parsed tree (and its rels) once its slide is done; layouts, masters and themes stay cached. */
  drop(part: string): void {
    this.xml.delete(part)
    this.xml.delete(relsPart(part))
    this.rels.delete(part)
  }

  async relsOf(part: string): Promise<Map<string, Rel>> {
    const hit = this.rels.get(part)
    if (hit) return hit
    const m = new Map<string, Rel>()
    const root = await this.parsed(relsPart(part))
    for (const r of childrenNamed(root ?? undefined, 'Relationship')) {
      const id = r.attrs.Id
      const type = (r.attrs.Type ?? '').split('/').pop() ?? ''
      const raw = r.attrs.Target ?? ''
      const external = (r.attrs.TargetMode ?? '').toLowerCase() === 'external'
      if (!id || m.has(id)) continue
      m.set(id, { type, raw, external, target: external ? null : resolveTarget(dirOf(part), raw) })
    }
    this.rels.set(part, m)
    return m
  }

  /** A listed image part as a data URL, within the caps; null for anything else (never read when over budget). */
  async image(target: string | null): Promise<{ dataUrl: string } | null> {
    if (!target || !this.names.has(target)) return null
    let hit = this.images.get(target)
    if (hit === undefined) {
      hit = null
      if (this.imageReads < OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES * 2 && this.imageBytes < OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES) {
        const f = this.zip.file(target)
        if (f) {
          const data = await f.async('nodebuffer')
          this.imageReads += data.length
          const t = sniffImage(data)
          if (t && data.length <= OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES) hit = { dataUrl: `data:image/${t};base64,${data.toString('base64')}`, len: data.length }
        }
      }
      this.images.set(target, hit)
    }
    if (!hit) return null
    // every use is charged: the data URL is copied into each shape or background that shows it
    if (this.imageBytes + hit.len > OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES) return null
    this.imageBytes += hit.len
    return { dataUrl: hit.dataUrl }
  }
}

// ---------- colours ----------

interface Theme {
  palette: Record<string, string>
  map: Record<string, string>
}

const SCHEME_ALIAS: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r = l
  let g = l
  let b = l
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = f(p, q, h + 1 / 3)
    g = f(p, q, h)
    b = f(p, q, h - 1 / 3)
  }
  const x = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${x(r)}${x(g)}${x(b)}`
}

function hex6(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const c = `#${v}`
  return OUTPUT_COLOR_RE.test(c) ? c.toLowerCase() : undefined
}

/** The colour inside a fill-like element (solidFill, a colour element itself): `#rrggbb` lowercase or undefined. */
function colorIn(holder: XmlEl | undefined, th: Theme | undefined): string | undefined {
  const el = holder && ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(holder.name) ? holder : holder?.children.find((c) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(c.name))
  if (!el) return undefined
  let base: string | undefined
  if (el.name === 'srgbClr') base = hex6(el.attrs.val)
  else if (el.name === 'sysClr') base = hex6(el.attrs.lastClr) ?? (el.attrs.val === 'window' ? '#ffffff' : el.attrs.val === 'windowText' ? '#000000' : undefined)
  else if (el.name === 'prstClr') base = el.attrs.val === 'black' ? '#000000' : el.attrs.val === 'white' ? '#ffffff' : undefined
  else if (el.name === 'schemeClr' && th) {
    const v = el.attrs.val ?? ''
    const key = th.map[v] ?? SCHEME_ALIAS[v] ?? v
    base = th.palette[SCHEME_ALIAS[key] ?? key]
  }
  if (!base || !OUTPUT_COLOR_RE.test(base)) return undefined
  let lumMod: number | undefined
  let lumOff = 0
  for (const m of el.children) {
    const n = Number(m.attrs.val)
    if (!Number.isFinite(n)) continue
    if (m.name === 'lumMod') lumMod = n / 100000
    else if (m.name === 'lumOff') lumOff = n / 100000
  }
  if (lumMod !== undefined || lumOff) {
    const [h, s, l] = rgbToHsl(parseInt(base.slice(1, 3), 16), parseInt(base.slice(3, 5), 16), parseInt(base.slice(5, 7), 16))
    base = hslToHex(h, s, Math.max(0, Math.min(1, l * (lumMod ?? 1) + lumOff)))
  }
  return OUTPUT_COLOR_RE.test(base) ? base.toLowerCase() : undefined
}

async function loadTheme(pkg: Pkg, masterPart: string, master: XmlEl): Promise<Theme> {
  const palette: Record<string, string> = {}
  const rels = await pkg.relsOf(masterPart)
  const themeRel = [...rels.values()].find((r) => r.type === 'theme')
  const theme = themeRel?.target ? await pkg.parsed(themeRel.target) : null
  const scheme = descend(theme ?? undefined, 'themeElements', 'clrScheme')
  for (const c of scheme?.children ?? []) {
    const v = colorIn(c, undefined) ?? hex6(child(c, 'srgbClr')?.attrs.val) ?? hex6(child(c, 'sysClr')?.attrs.lastClr)
    if (v) palette[c.name] = v
  }
  const map: Record<string, string> = {}
  const cm = child(master, 'clrMap')
  for (const [k, v] of Object.entries(cm?.attrs ?? {})) if (/^[a-zA-Z0-9]{2,12}$/.test(v)) map[k] = v
  return { palette, map }
}

// ---------- text style chain ----------

interface Level {
  sz?: number
  color?: string
  b?: boolean
  i?: boolean
  algn?: 'left' | 'center' | 'right'
  bullet?: 'disc' | 'number' | 'none'
}

function parseLevel(el: XmlEl | undefined, th: Theme | undefined): Level {
  const out: Level = {}
  if (!el) return out
  const al = el.attrs.algn
  if (al === 'l') out.algn = 'left'
  else if (al === 'ctr') out.algn = 'center'
  else if (al === 'r') out.algn = 'right'
  if (child(el, 'buNone')) out.bullet = 'none'
  else if (child(el, 'buChar')) out.bullet = 'disc'
  else if (child(el, 'buAutoNum')) out.bullet = 'number'
  const d = child(el, 'defRPr') ?? (el.name === 'rPr' ? el : undefined)
  if (d) {
    const sz = Number(d.attrs.sz)
    if (Number.isFinite(sz) && sz >= 100 && sz <= 400000) out.sz = sz / 100
    if (d.attrs.b === '1' || d.attrs.b === 'true') out.b = true
    else if (d.attrs.b === '0' || d.attrs.b === 'false') out.b = false
    if (d.attrs.i === '1' || d.attrs.i === 'true') out.i = true
    else if (d.attrs.i === '0' || d.attrs.i === 'false') out.i = false
    const c = colorIn(child(d, 'solidFill'), th)
    if (c) out.color = c
  }
  return out
}

/** Merge the level `lvl` (0-based) of each container in the chain, first defined wins. */
function levelFrom(chain: (XmlEl | undefined)[], lvl: number, th: Theme | undefined): Level {
  const out: Level = {}
  for (const c of chain) {
    if (!c) continue
    const l = parseLevel(child(c, `lvl${lvl + 1}pPr`), th)
    for (const k of Object.keys(l) as (keyof Level)[]) if (out[k] === undefined) (out as Record<string, unknown>)[k] = l[k]
  }
  return out
}

// ---------- shapes ----------

interface Tf {
  sx: number
  sy: number
  tx: number
  ty: number
}

interface Scope {
  pkg: Pkg
  th: Theme | undefined
  rels: Map<string, Rel>
  slideW: number
  slideH: number
  layoutTree: XmlEl | undefined
  masterTree: XmlEl | undefined
  masterStyles: XmlEl | undefined
  defaultText: XmlEl | undefined
  textBudget: { left: number }
  /** Deck-wide object budget shared by every slide: shapes built and table cells built (empty ones count). */
  deck: { shapes: number; cells: number }
  shapes: SlideShape[]
  truncated: number
  title?: string
}

const clampFrac = (v: number): number => (Number.isFinite(v) ? Math.max(-2, Math.min(3, v)) : 0)

function emuNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : undefined
}

function readXfrm(x: XmlEl | undefined): { x: number; y: number; w: number; h: number } | undefined {
  if (!x) return undefined
  const off = child(x, 'off')
  const ext = child(x, 'ext')
  const ox = emuNum(off?.attrs.x)
  const oy = emuNum(off?.attrs.y)
  const cx = emuNum(ext?.attrs.cx)
  const cy = emuNum(ext?.attrs.cy)
  if (ox === undefined || oy === undefined || cx === undefined || cy === undefined) return undefined
  return { x: ox, y: oy, w: cx, h: cy }
}

function toBox(s: Scope, g: { x: number; y: number; w: number; h: number }, tf: Tf): { x: number; y: number; w: number; h: number } {
  return {
    x: clampFrac((tf.tx + g.x * tf.sx) / s.slideW),
    y: clampFrac((tf.ty + g.y * tf.sy) / s.slideH),
    w: Math.max(0, clampFrac((g.w * tf.sx) / s.slideW)),
    h: Math.max(0, clampFrac((g.h * tf.sy) / s.slideH))
  }
}

interface PhInfo {
  type: string
  idx?: string
}

function phOf(sp: XmlEl): PhInfo | undefined {
  const ph = descend(sp, 'nvSpPr', 'nvPr', 'ph') ?? descend(sp, 'nvPicPr', 'nvPr', 'ph')
  if (!ph) return undefined
  return { type: ph.attrs.type ?? 'obj', ...(ph.attrs.idx !== undefined ? { idx: ph.attrs.idx } : {}) }
}

const normType = (t: string): string => (t === 'ctrTitle' ? 'title' : t === 'subTitle' || t === 'obj' || t === 'body' ? 'body' : t)

function findPh(tree: XmlEl | undefined, ph: PhInfo, byIdx: boolean): XmlEl | undefined {
  const sps = childrenNamed(descend(tree, 'cSld', 'spTree'), 'sp')
  if (byIdx && ph.idx !== undefined) {
    const hit = sps.find((sp) => phOf(sp)?.idx === ph.idx)
    if (hit) return hit
  }
  return sps.find((sp) => {
    const p = phOf(sp)
    return p !== undefined && normType(p.type) === normType(ph.type)
  })
}

function textOfParas(txBody: XmlEl | undefined): string {
  const out: string[] = []
  for (const p of childrenNamed(txBody, 'p')) {
    let t = ''
    for (const r of p.children) {
      if (r.name === 'r' || r.name === 'fld') t += child(r, 't')?.text ?? ''
      else if (r.name === 'br') t += ' '
    }
    out.push(t)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

function safeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function runHref(rPr: XmlEl | undefined, rels: Map<string, Rel>): string | undefined {
  const id = child(rPr, 'hlinkClick')?.attrs['r:id']
  if (!id) return undefined
  const r = rels.get(id)
  if (!r || r.type !== 'hyperlink' || !r.external) return undefined
  const raw = r.raw.trim()
  return raw.length <= 2048 && /^(https?:|mailto:)/i.test(raw) && !/[\u0000- \u007f-\u009f]/.test(raw) ? raw : undefined
}

function parseParas(s: Scope, txBody: XmlEl | undefined, chainBase: (XmlEl | undefined)[], scale: number): SlideParagraph[] {
  const out: SlideParagraph[] = []
  for (const p of childrenNamed(txBody, 'p')) {
    if (out.length >= PARAS_MAX || s.textBudget.left <= 0) break
    const pPr = child(p, 'pPr')
    const lvl = Math.max(0, Math.min(8, Number.parseInt(pPr?.attrs.lvl ?? '0', 10) || 0))
    const own = parseLevel(pPr, s.th)
    const inh = levelFrom(chainBase, lvl, s.th)
    const bullet = own.bullet ?? inh.bullet
    const runs: SlideRun[] = []
    for (const r of p.children) {
      if (r.name === 'br') {
        const last = runs[runs.length - 1]
        if (last) last.text += '\n'
        continue
      }
      if (r.name !== 'r' && r.name !== 'fld') continue
      const t = safeText(child(r, 't')?.text ?? '')
      if (!t) continue
      const rPr = child(r, 'rPr')
      const ro = parseLevel(rPr, s.th)
      const run: SlideRun = { text: t.length > SHAPE_TEXT_MAX ? t.slice(0, SHAPE_TEXT_MAX) : t }
      s.textBudget.left -= run.text.length
      const b = ro.b ?? inh.b
      const i = ro.i ?? inh.i
      if (b) run.bold = true
      if (i) run.italic = true
      const u = rPr?.attrs.u
      if (u && u !== 'none') run.underline = true
      const st = rPr?.attrs.strike
      if (st && st !== 'noStrike') run.strike = true
      const sz = ro.sz ?? inh.sz
      if (sz !== undefined) run.sizePt = Math.round(sz * scale * 10) / 10
      const color = child(rPr, 'solidFill') ? colorIn(child(rPr, 'solidFill'), s.th) : inh.color
      if (color) run.color = color
      const face = child(rPr, 'latin')?.attrs.typeface
      if (face && !face.startsWith('+') && face.length <= 64 && /^[\p{L}\p{N} ._\-()]+$/u.test(face)) run.font = face
      const href = runHref(rPr, s.rels)
      if (href) run.href = href
      runs.push(run)
    }
    const para: SlideParagraph = { runs }
    const algn = own.algn ?? inh.algn
    if (algn && algn !== 'left') para.align = algn
    if (lvl > 0) para.level = lvl
    if (bullet === 'disc' || bullet === 'number') para.bullet = bullet
    out.push(para)
  }
  return out
}

const hasText = (paras: SlideParagraph[]): boolean => paras.some((p) => p.runs.some((r) => r.text.trim() !== ''))

function fillOf(spPr: XmlEl | undefined, th: Theme | undefined): { fill?: string; line?: string } {
  const out: { fill?: string; line?: string } = {}
  const f = child(spPr, 'solidFill')
  if (f) {
    const c = colorIn(f, th)
    if (c) out.fill = c
  }
  const ln = child(spPr, 'ln')
  if (ln && !child(ln, 'noFill')) {
    const c = colorIn(child(ln, 'solidFill'), th)
    if (c) out.line = c
  }
  return out
}

const GEOMETRY = new Map<string, 'rect' | 'roundRect' | 'ellipse'>([
  ['rect', 'rect'],
  ['roundRect', 'roundRect'],
  ['ellipse', 'ellipse']
])

function altOf(nv: XmlEl | undefined): string | undefined {
  const d = child(nv, 'cNvPr')?.attrs.descr
  if (!d) return undefined
  const t = safeText(d).trim()
  return t ? t.slice(0, 500) : undefined
}

function push(s: Scope, shape: SlideShape): void {
  if (s.shapes.length >= OUTPUT_PREVIEW_SLIDE_SHAPES_MAX || s.deck.shapes <= 0) s.truncated++
  else {
    s.deck.shapes--
    s.shapes.push(shape)
  }
}

function cellRuns(s: Scope, tc: XmlEl): DocumentRun[] {
  const paras = parseParas(s, child(tc, 'txBody'), [], 1)
  const out: DocumentRun[] = []
  paras.forEach((p, i) => {
    if (i > 0 && out.length) out.push({ text: '\n' })
    for (const r of p.runs) {
      const run: DocumentRun = { text: r.text.length > CELL_TEXT_MAX ? r.text.slice(0, CELL_TEXT_MAX) : r.text }
      if (r.bold) run.bold = true
      if (r.italic) run.italic = true
      out.push(run)
    }
  })
  return out
}

async function processSp(s: Scope, sp: XmlEl, tf: Tf): Promise<void> {
  const ph = phOf(sp)
  const spPr = child(sp, 'spPr')
  const layoutPh = ph ? findPh(s.layoutTree, ph, true) : undefined
  const masterPh = ph ? findPh(s.masterTree, ph, false) : undefined
  let g = readXfrm(child(spPr, 'xfrm')) ?? readXfrm(descend(layoutPh, 'spPr', 'xfrm')) ?? readXfrm(descend(masterPh, 'spPr', 'xfrm'))
  const txBody = child(sp, 'txBody')
  const isTitle = ph !== undefined && (ph.type === 'title' || ph.type === 'ctrTitle')
  if (isTitle && s.title === undefined) {
    const t = safeText(textOfParas(txBody)).trim()
    if (t) s.title = t.slice(0, 500)
  }
  if (ph && (ph.type === 'sldNum' || ph.type === 'dt' || ph.type === 'ftr') && !hasTextBody(txBody)) return
  const kind = ph ? (isTitle ? 'title' : normType(ph.type) === 'body' ? 'body' : 'other') : 'other'
  const styleKind = kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle'
  const chain: (XmlEl | undefined)[] = [
    child(txBody, 'lstStyle'),
    descend(layoutPh, 'txBody', 'lstStyle'),
    descend(masterPh, 'txBody', 'lstStyle'),
    ph ? child(s.masterStyles, styleKind) : undefined,
    s.defaultText
  ]
  let scale = 1
  const bodyPr = child(txBody, 'bodyPr')
  const fs = Number(child(bodyPr, 'normAutofit')?.attrs.fontScale)
  if (Number.isFinite(fs) && fs > 0 && fs <= 100000) scale = fs / 100000
  const paras = txBody ? parseParas(s, txBody, chain, scale) : []
  const style = fillOf(spPr, s.th)
  const prst = child(spPr, 'prstGeom')?.attrs.prst
  if (!g) {
    if (!ph) return
    g = { x: 0, y: 0, w: s.slideW, h: s.slideH }
  }
  const box = toBox(s, g, tf)
  if (hasText(paras)) {
    const anchorRaw = bodyPr?.attrs.anchor ?? child(descend(layoutPh, 'txBody'), 'bodyPr')?.attrs.anchor ?? child(descend(masterPh, 'txBody'), 'bodyPr')?.attrs.anchor
    const anchor = anchorRaw === 'ctr' ? 'middle' : anchorRaw === 'b' ? 'bottom' : anchorRaw === 't' ? 'top' : undefined
    push(s, { type: 'text', ...box, paragraphs: paras, ...(anchor ? { anchor } : {}), ...style })
    return
  }
  if (!ph && (style.fill || style.line)) {
    push(s, { type: 'shape', ...box, geometry: (prst && GEOMETRY.get(prst)) || (prst ? 'other' : 'rect'), ...style })
  }
}

function hasTextBody(txBody: XmlEl | undefined): boolean {
  return childrenNamed(txBody, 'p').some((p) => p.children.some((r) => (r.name === 'r' || r.name === 'fld') && (child(r, 't')?.text ?? '').trim() !== ''))
}

async function processPic(s: Scope, pic: XmlEl, tf: Tf): Promise<void> {
  const g = readXfrm(descend(pic, 'spPr', 'xfrm'))
  if (!g) return
  const box = toBox(s, g, tf)
  const nv = child(pic, 'nvPicPr')
  const alt = altOf(nv)
  const media = descend(nv, 'nvPr')
  if (child(media, 'videoFile') || child(media, 'audioFile')) {
    push(s, { type: 'placeholder', ...box, label: 'Video', ...(alt ? { alt } : {}) })
    return
  }
  const blip = descend(pic, 'blipFill', 'blip')
  const rel = blip ? s.rels.get(blip.attrs['r:embed'] ?? '') : undefined
  const img = rel && !rel.external && rel.type === 'image' ? await s.pkg.image(rel.target) : null
  if (img) push(s, { type: 'image', ...box, dataUrl: img.dataUrl, ...(alt ? { alt } : {}) })
  else push(s, { type: 'placeholder', ...box, label: 'Picture', ...(alt ? { alt } : {}) })
}

async function processFrame(s: Scope, gf: XmlEl, tf: Tf): Promise<void> {
  const g = readXfrm(child(gf, 'xfrm'))
  if (!g) return
  const box = toBox(s, g, tf)
  const alt = altOf(child(gf, 'nvGraphicFramePr'))
  const data = descend(gf, 'graphic', 'graphicData')
  const uri = (data?.attrs.uri ?? '').toLowerCase()
  const tbl = child(data, 'tbl')
  if (tbl && uri.endsWith('/table')) {
    const rows: DocumentRun[][][] = []
    for (const tr of childrenNamed(tbl, 'tr')) {
      if (rows.length >= OUTPUT_PREVIEW_ROWS_MAX) break
      const tcs = childrenNamed(tr, 'tc').slice(0, OUTPUT_PREVIEW_COLUMNS_MAX)
      if (s.deck.cells < tcs.length) {
        s.deck.cells = 0
        s.truncated++
        break
      }
      s.deck.cells -= tcs.length
      rows.push(tcs.map((tc) => cellRuns(s, tc)))
    }
    push(s, { type: 'table', ...box, rows })
    return
  }
  const label = uri.endsWith('/chart') || uri.includes('/chart') ? 'Chart' : uri.includes('/diagram') ? 'SmartArt' : 'Object'
  push(s, { type: 'placeholder', ...box, label, ...(alt ? { alt } : {}) })
}

async function walk(s: Scope, parent: XmlEl, tf: Tf, depth: number): Promise<void> {
  for (const el of parent.children) {
    if (s.shapes.length >= OUTPUT_PREVIEW_SLIDE_SHAPES_MAX || s.deck.shapes <= 0) {
      if (['sp', 'pic', 'graphicFrame'].includes(el.name)) s.truncated++
      else if (el.name === 'grpSp') s.truncated += countLeaves(el)
      continue
    }
    if (el.name === 'sp') await processSp(s, el, tf)
    else if (el.name === 'pic') await processPic(s, el, tf)
    else if (el.name === 'graphicFrame') await processFrame(s, el, tf)
    else if (el.name === 'grpSp' && depth < GROUP_DEPTH_MAX) {
      const xf = child(child(el, 'grpSpPr'), 'xfrm')
      const o = readXfrm(xf)
      const chOff = child(xf, 'chOff')
      const chExt = child(xf, 'chExt')
      const cox = emuNum(chOff?.attrs.x)
      const coy = emuNum(chOff?.attrs.y)
      const cw = emuNum(chExt?.attrs.cx)
      const ch = emuNum(chExt?.attrs.cy)
      let next = tf
      if (o && cox !== undefined && coy !== undefined && cw && ch) {
        const kx = o.w / cw
        const ky = o.h / ch
        next = { sx: kx * tf.sx, sy: ky * tf.sy, tx: tf.tx + (o.x - cox * kx) * tf.sx, ty: tf.ty + (o.y - coy * ky) * tf.sy }
      }
      await walk(s, el, next, depth + 1)
    }
  }
}

function countLeaves(el: XmlEl): number {
  let n = 0
  const stack = [el]
  while (stack.length) {
    const e = stack.pop() as XmlEl
    for (const c of e.children) {
      if (c.name === 'sp' || c.name === 'pic' || c.name === 'graphicFrame') n++
      else if (c.name === 'grpSp') stack.push(c)
    }
  }
  return n
}

// ---------- background ----------

async function backgroundOf(s: Scope, trees: (XmlEl | undefined)[], rels: Map<string, Rel>[]): Promise<{ color?: string; image?: string }> {
  for (let i = 0; i < trees.length; i++) {
    const bg = descend(trees[i], 'cSld', 'bg')
    if (!bg) continue
    const pr = child(bg, 'bgPr')
    if (pr) {
      const c = colorIn(child(pr, 'solidFill'), s.th)
      if (c) return { color: c }
      const blip = descend(pr, 'blipFill', 'blip')
      const rel = blip ? rels[i]?.get(blip.attrs['r:embed'] ?? '') : undefined
      if (rel && !rel.external && rel.type === 'image') {
        const img = await s.pkg.image(rel.target)
        if (img) return { image: img.dataUrl }
      }
      return {}
    }
    const ref = child(bg, 'bgRef')
    if (ref) {
      const c = colorIn(ref, s.th)
      return c ? { color: c } : {}
    }
  }
  return {}
}

// ---------- entry ----------

const MACRO = 'This deck contains macros; OrgAI does not preview it.'

export async function previewPptxFile(path: string, maxSlides: number = OUTPUT_PREVIEW_SLIDES_MAX): Promise<OutputPreview> {
  const buf = readCapped(path, OUTPUT_PPTX_TOTAL_MAX_BYTES)
  return previewPptxBuffer(buf, OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES, maxSlides)
}

/** `maxSlides` below the cap parses only that many slides (thumbnails); the rest count as truncatedSlides. */
export async function previewPptxBuffer(buf: Buffer, maxXmlBytes: number = OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES, maxSlides: number = OUTPUT_PREVIEW_SLIDES_MAX): Promise<OutputPreview> {
  if (buf.length > OUTPUT_PPTX_TOTAL_MAX_BYTES) return none('This deck is larger than 40 MB, so OrgAI does not preview it; open it instead.')
  const zi = zipInfo(buf)
  if (zi.problem) return none(`OrgAI did not preview this deck: ${zi.problem}`)
  const names = zipEntryNames(buf)
  for (const n of names) {
    if (n.length > 260 || n.includes('\\') || n.includes('\0') || n.startsWith('/') || n.split('/').some((seg) => seg === '..')) return none('OrgAI did not preview this deck: a part of the package has an unsafe name.')
  }
  if (names.some((n) => /(^|\/)vbaproject/i.test(n))) return none(MACRO)
  const biggest = zipMaxSize(buf, () => true)
  if (biggest !== null && biggest > ENTRY_MAX) return none(TOO_LARGE)
  const xmlSize = zipSumSizes(buf, (n) => /\.(xml|rels)$/i.test(n))
  if (xmlSize !== null && xmlSize > maxXmlBytes) return none(TOO_LARGE)
  const zv = zipVerifyEntries(buf)
  if (zv) return none(`OrgAI did not preview this deck: ${zv}`)
  try {
    const zip = await JSZip.loadAsync(buf)
    const pkg = new Pkg(zip, new Set(names), buf, maxXmlBytes)
    const ct = await pkg.text('[Content_Types].xml')
    if (ct === null) return none('OrgAI did not preview this deck: it has no content types part.')
    if (/macroEnabled/i.test(ct)) return none(MACRO)
    const pkgRels = await pkg.relsOf('')
    // the package rels part is `_rels/.rels`, whose "part" name is the empty string
    const main = [...pkgRels.values()].find((r) => r.type === 'officeDocument')?.target ?? 'ppt/presentation.xml'
    const pres = await pkg.parsed(main)
    if (!pres || pres.name !== 'presentation') return none('OrgAI did not preview this deck: its parts are not laid out like a PowerPoint deck.')
    const sz = child(pres, 'sldSz')
    const cx = emuNum(sz?.attrs.cx) ?? 12192000
    const cy = emuNum(sz?.attrs.cy) ?? 6858000
    if (!(cx > 0 && cy > 0 && cx <= 1e9 && cy <= 1e9)) return none('OrgAI did not preview this deck: its slide size is not valid.')
    const presRels = await pkg.relsOf(main)
    const order: string[] = []
    const seen = new Set<string>()
    for (const sid of childrenNamed(child(pres, 'sldIdLst'), 'sldId')) {
      const rel = presRels.get(sid.attrs['r:id'] ?? '')
      // a part referenced again is never walked again
      if (rel && rel.type === 'slide' && rel.target && !seen.has(rel.target)) {
        seen.add(rel.target)
        order.push(rel.target)
      }
    }
    if (!order.length) return none('This deck has no slides to show.')
    const defaultText = child(pres, 'defaultTextStyle')
    const textBudget = { left: TEXT_BUDGET }
    const deck = { shapes: DECK_SHAPES_BUDGET, cells: DECK_CELLS_BUDGET }
    const slides: SlidePreview[] = []
    const themes = new Map<string, Theme>()
    for (const slidePart of order.slice(0, Math.min(maxSlides, OUTPUT_PREVIEW_SLIDES_MAX))) {
      const slideEl = await pkg.parsed(slidePart)
      const n = slides.length + 1
      if (!slideEl) {
        slides.push({ n, shapes: [] })
        pkg.drop(slidePart)
        continue
      }
      const rels = await pkg.relsOf(slidePart)
      const layoutRel = [...rels.values()].find((r) => r.type === 'slideLayout')
      const layoutPart = layoutRel?.target ?? null
      const layout = layoutPart ? await pkg.parsed(layoutPart) : null
      const layoutRels = layoutPart ? await pkg.relsOf(layoutPart) : new Map<string, Rel>()
      const masterRel = [...layoutRels.values()].find((r) => r.type === 'slideMaster')
      const masterPart = masterRel?.target ?? null
      const master = masterPart ? await pkg.parsed(masterPart) : null
      const masterRels = masterPart ? await pkg.relsOf(masterPart) : new Map<string, Rel>()
      let th: Theme | undefined
      if (masterPart && master) {
        th = themes.get(masterPart)
        if (!th) {
          th = await loadTheme(pkg, masterPart, master)
          themes.set(masterPart, th)
        }
      }
      const scope: Scope = {
        pkg,
        th,
        rels,
        slideW: cx,
        slideH: cy,
        layoutTree: layout ?? undefined,
        masterTree: master ?? undefined,
        masterStyles: child(master ?? undefined, 'txStyles'),
        defaultText,
        textBudget,
        deck,
        shapes: [],
        truncated: 0
      }
      const bg = await backgroundOf(scope, [slideEl, layout ?? undefined, master ?? undefined], [rels, layoutRels, masterRels])
      const tree = descend(slideEl, 'cSld', 'spTree')
      if (bg.image) scope.shapes.push({ type: 'image', x: 0, y: 0, w: 1, h: 1, dataUrl: bg.image })
      if (tree) await walk(scope, tree, { sx: 1, sy: 1, tx: 0, ty: 0 }, 0)
      const slide: SlidePreview = { n, shapes: scope.shapes }
      if (scope.title) slide.title = scope.title
      if (bg.color) slide.background = bg.color
      if (scope.truncated) slide.truncatedShapes = scope.truncated
      const notesRel = [...rels.values()].find((r) => r.type === 'notesSlide')
      const notes = notesRel?.target ? await pkg.parsed(notesRel.target) : null
      if (notes) {
        const sps = childrenNamed(descend(notes, 'cSld', 'spTree'), 'sp')
        const body = sps.find((sp) => phOf(sp)?.type === 'body')
        if (body) {
          const t = childrenNamed(child(body, 'txBody'), 'p')
            .map((p) => p.children.filter((r) => r.name === 'r' || r.name === 'fld').map((r) => child(r, 't')?.text ?? '').join(''))
            .join('\n')
            .replace(/\n+$/, '')
          const clean = safeText(t.replace(/[\r]/g, ''))
          if (clean.trim()) slide.notes = clean.length > NOTES_MAX ? clean.slice(0, NOTES_MAX) : clean
        }
      }
      slides.push(slide)
      pkg.drop(slidePart)
      if (notesRel?.target) pkg.drop(notesRel.target)
    }
    const truncatedSlides = order.length - slides.length
    return { kind: 'slides', size: { w: cx / 12700, h: cy / 12700 }, slides, ...(truncatedSlides > 0 ? { truncatedSlides } : {}) }
  } catch (e) {
    if (e instanceof XmlLiteError && e.message === TOO_LARGE) return none(TOO_LARGE)
    return none(`OrgAI could not read this deck: ${(e as Error).message}`)
  }
}
