import JSZip from 'jszip'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlideDeckInput } from '@shared/types'
import { OUTPUT_PPTX_ELEMENTS_PER_SLIDE, OUTPUT_PPTX_IMAGE_MAX_BYTES, OUTPUT_PPTX_MAX_SLIDES, OUTPUT_PPTX_TEXT_MAX_CHARS } from '@shared/types'
import { renderDeck, TABLE_MAX_COLUMNS, type DeckImageReader } from './pptxWrite'
import { previewFile } from './preview'
import { zipProblem, zipVerifyEntries } from './zipGuard'
import { imageSize, sniffImage } from './imageInfo'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** A 20x10 png header (the reader only needs the header; bytes after are filler). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(40)
  PNG.copy(b, 0, 0, 24)
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

const reader = (files: Record<string, Buffer>): DeckImageReader => ({
  read(path) {
    const b = files[path]
    if (!b) throw new Error(`The image ${path} is not a file OrgAI can use.`)
    return b
  }
})
const noImages = reader({})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-pptx-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const refused = async (deck: unknown, images: DeckImageReader = noImages): Promise<string> => {
  try {
    await renderDeck(deck as SlideDeckInput, images)
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected a refusal')
}

describe('renderDeck validation', () => {
  const one = (s: Record<string, unknown>): unknown => ({ slides: [{ layout: 'content', ...s }] })

  it('refuses a bad deck shape, size, colour and fonts', async () => {
    expect(await refused(null)).toMatch(/object/)
    expect(await refused({ slides: [] })).toMatch(/at least one slide/)
    expect(await refused({ size: '3:2', slides: [{ layout: 'blank' }] })).toMatch(/size/)
    expect(await refused({ theme: { accent: 'red;background:url(x)' }, slides: [{ layout: 'blank' }] })).toMatch(/accent/)
    expect(await refused({ theme: { accent: '#12345' }, slides: [{ layout: 'blank' }] })).toMatch(/accent/)
    expect(await refused({ theme: { fontBody: 'Arial<script>' }, slides: [{ layout: 'blank' }] })).toMatch(/font/)
    expect(await refused({ theme: { fontHeading: 'x'.repeat(65) }, slides: [{ layout: 'blank' }] })).toMatch(/64/)
    expect(await refused({ theme: { fontHeading: 'A‮B' }, slides: [{ layout: 'blank' }] })).toMatch(/hidden character/)
  })
  it('refuses too many slides, unknown layouts and too many elements', async () => {
    expect(await refused({ slides: Array.from({ length: OUTPUT_PPTX_MAX_SLIDES + 1 }, () => ({ layout: 'blank' })) })).toMatch(/at most 100 slides/)
    expect(await refused({ slides: [{ layout: 'fancy' }] })).toMatch(/unknown layout/)
    const bullets = Array.from({ length: OUTPUT_PPTX_ELEMENTS_PER_SLIDE + 1 }, (_, i) => ({ text: `b${i}` }))
    expect(await refused(one({ bullets }))).toMatch(/at most 40/)
    // table rows count one each, not cells
    expect((await renderDeck(one({ table: { rows: Array.from({ length: 30 }, () => ['a', 'b', 'c']) } }) as SlideDeckInput, noImages)).length).toBeGreaterThan(0)
    expect(await refused(one({ table: { rows: Array.from({ length: 41 }, () => ['a']) } }))).toMatch(/at most 40/)
    expect(await refused(one({ table: { rows: [Array.from({ length: TABLE_MAX_COLUMNS + 1 }, () => 'x')] } }))).toMatch(/columns/)
  })
  it('refuses overlong text, hidden characters, newlines in one-line fields and bad levels', async () => {
    expect(await refused(one({ title: 'x'.repeat(OUTPUT_PPTX_TEXT_MAX_CHARS + 1) }))).toMatch(/longer than/)
    expect(await refused(one({ title: 'a​b' }))).toMatch(/hidden character/)
    expect(await refused(one({ title: 'a\nb' }))).toMatch(/hidden character/)
    expect(await refused(one({ body: 'a‮b' }))).toMatch(/hidden character/)
    expect(await refused(one({ notes: 'a\u0007b' }))).toMatch(/hidden character/)
    expect(await refused(one({ bullets: [{ text: 'x', level: 3 }] }))).toMatch(/level/)
    expect(await refused(one({ bullets: [{ text: 'a\tb' }] }))).toMatch(/hidden character/)
    expect(await refused(one({ table: { rows: [['a', 'b‮c']] } }))).toMatch(/hidden character/)
    // prose allows line breaks
    expect((await renderDeck(one({ body: 'one\ntwo\r\nthree', notes: 'n1\nn2' }) as SlideDeckInput, noImages)).length).toBeGreaterThan(0)
  })
  it('refuses left or right outside two-content', async () => {
    expect(await refused(one({ left: [{ type: 'body', text: 'x' }] }))).toMatch(/two-content/)
    expect(await refused({ slides: [{ layout: 'two-content', left: [{ type: 'carousel' }] }] })).toMatch(/unknown type/)
  })
  it('refuses URL-like, missing and non-image paths, wrong magic, oversize', async () => {
    const img = (path: string): unknown => ({ slides: [{ layout: 'image', image: { path, alt: 'a' } }] })
    expect(await refused(img('https://example.com/x.png'))).toMatch(/not a web address/)
    expect(await refused(img('data:image/png;base64,AAAA'))).toMatch(/not a web address/)
    expect(await refused(img('file:///etc/passwd'))).toMatch(/not a web address/)
    expect(await refused(img('\\\\host\\share\\x.png'))).toMatch(/not a web address/)
    expect(await refused(img('missing.png'))).toMatch(/not a file OrgAI can use/)
    expect(await refused(img(''))).toMatch(/path/)
    expect(await refused({ slides: [{ layout: 'image', image: { path: 'a.png' } }] }, reader({ 'a.png': PNG }))).toMatch(/alt/)
    expect(await refused(img('a.png'), reader({ 'a.png': Buffer.from('<svg onload="x()"/>') }))).toMatch(/PNG, JPEG, GIF or WebP/)
    expect(await refused(img('a.png'), reader({ 'a.png': Buffer.concat([PNG, Buffer.alloc(OUTPUT_PPTX_IMAGE_MAX_BYTES)]) }))).toMatch(/larger than 5 MB/)
    expect(await refused(img('a.png'), { read: () => { throw 'boom' } })).toMatch(/could not be read/)
  })
  it('produces zip layout the package guard accepts', async () => {
    const buf = await renderDeck({ slides: [{ layout: 'title', title: 'Hello', notes: 'n' }, { layout: 'blank' }] }, noImages)
    expect(zipProblem(buf)).toBeNull()
    expect(zipVerifyEntries(buf)).toBeNull()
    const zip = await JSZip.loadAsync(buf)
    expect(Object.keys(zip.files)[0]).toBe('[Content_Types].xml')
    expect(Object.keys(zip.files).some((n) => n.endsWith('/'))).toBe(false)
  })
  it('is deterministic', async () => {
    const d = { slides: [{ layout: 'content', title: 'T', bullets: [{ text: 'a' }, { text: 'b', level: 1 }] }, { layout: 'image', image: { path: 'a.png', alt: 'x', caption: 'c' } }] } as SlideDeckInput
    const r = reader({ 'a.png': PNG })
    expect((await renderDeck(d, r)).equals(await renderDeck(d, r))).toBe(true)
  })
  it('escapes markup in every string', async () => {
    const buf = await renderDeck({ slides: [{ layout: 'content', title: '<a:t>&"x"</a:t>', bullets: [{ text: '</p:sp><p:sp>' }], notes: '<b>n</b>' }] }, noImages)
    const zip = await JSZip.loadAsync(buf)
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(slide).not.toContain('<a:t><a:t>')
    expect(slide).toContain('&lt;a:t&gt;&amp;&quot;x&quot;&lt;/a:t&gt;')
    expect(slide).toContain('&lt;/p:sp&gt;&lt;p:sp&gt;')
    const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')
    expect(notes).toContain('&lt;b&gt;n&lt;/b&gt;')
  })
})

describe('imageInfo', () => {
  it('reads png, gif, jpeg and webp sizes from the header', () => {
    expect(imageSize(png(20, 10))).toEqual({ w: 20, h: 10 })
    const gif = Buffer.alloc(16)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(30, 6)
    gif.writeUInt16LE(15, 8)
    expect(imageSize(gif)).toEqual({ w: 30, h: 15 })
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x11, 0x00])
    expect(sniffImage(jpg)).toBe('jpeg')
    expect(imageSize(jpg)).toEqual({ w: 200, h: 100 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBP', 8, 'latin1')
    webp.write('VP8X', 12, 'latin1')
    webp.writeUIntLE(399, 24, 3)
    webp.writeUIntLE(199, 27, 3)
    expect(imageSize(webp)).toEqual({ w: 400, h: 200 })
    expect(imageSize(Buffer.from('nope'))).toBeNull()
  })
})

describe('deck round trip through the preview', () => {
  it('five slides keep titles, bullet levels, table text, image and notes', async () => {
    const deck: SlideDeckInput = {
      theme: { accent: '#B03060', fontHeading: 'Georgia', fontBody: 'Verdana' },
      slides: [
        { layout: 'title', title: 'Quarterly review', subtitle: 'Q3 2026', notes: 'Welcome everyone.\nKeep it short.' },
        { layout: 'content', title: 'Highlights', bullets: [{ text: 'Revenue up' }, { text: 'EMEA led', level: 1 }, { text: 'Retail', level: 2 }, { text: 'Churn down' }] },
        { layout: 'two-content', title: 'Compare', left: [{ type: 'bullets', bullets: [{ text: 'Left one' }, { text: 'Left two' }] }], right: [{ type: 'body', text: 'Right text' }, { type: 'table', rows: [['Region', 'Sales'], ['EMEA', '12']], header: true }] },
        { layout: 'image', title: 'Chart', image: { path: 'chart.png', alt: 'A chart', caption: 'Figure 1' }, notes: 'Explain the axis.' },
        { layout: 'content', title: 'Numbers', table: { rows: [['Name', 'Qty'], ['Apple', '3'], ['Pear', '4']], header: true }, body: 'Totals below.' }
      ]
    }
    const buf = await renderDeck(deck, reader({ 'chart.png': png(400, 200) }))
    expect(zipVerifyEntries(buf)).toBeNull()
    const path = join(dir, 'deck.pptx')
    writeFileSync(path, buf)
    const p = await previewFile(path, 'pptx')
    expect(p.kind).toBe('slides')
    if (p.kind !== 'slides') return
    expect(p.size).toEqual({ w: 960, h: 540 })
    expect(p.slides.map((s) => s.title)).toEqual(['Quarterly review', 'Highlights', 'Compare', 'Chart', 'Numbers'])
    const texts = (i: number): string[] => p.slides[i].shapes.flatMap((s) => (s.type === 'text' ? [s.paragraphs.map((q) => q.runs.map((r) => r.text).join('')).join('|')] : []))
    expect(texts(0)).toContain('Q3 2026')
    expect(p.slides[0].notes).toBe('Welcome everyone.\nKeep it short.')
    // bullet levels and bullets survive
    const bulletsShape = p.slides[1].shapes.find((s) => s.type === 'text' && s.paragraphs.some((q) => q.bullet))
    expect(bulletsShape?.type).toBe('text')
    if (bulletsShape?.type === 'text') {
      expect(bulletsShape.paragraphs.map((q) => [q.runs[0].text, q.level ?? 0, q.bullet])).toEqual([
        ['Revenue up', 0, 'disc'],
        ['EMEA led', 1, 'disc'],
        ['Retail', 2, 'disc'],
        ['Churn down', 0, 'disc']
      ])
    }
    // two columns: left box is left of the right box
    const cols = p.slides[2].shapes.filter((s) => s.type === 'text' && s.paragraphs.some((q) => q.runs.some((r) => /Left|Right/.test(r.text)))) as { x: number }[]
    expect(cols).toHaveLength(2)
    expect(cols[0].x).toBeLessThan(cols[1].x)
    const t2 = p.slides[2].shapes.find((s) => s.type === 'table')
    expect(t2?.type === 'table' && t2.rows.map((r) => r.map((c) => c[0].text))).toEqual([['Region', 'Sales'], ['EMEA', '12']])
    // image
    const im = p.slides[3].shapes.find((s) => s.type === 'image')
    expect(im?.type === 'image' && im.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(im?.type === 'image' && im.alt).toBe('A chart')
    expect(texts(3)).toContain('Figure 1')
    expect(p.slides[3].notes).toBe('Explain the axis.')
    expect(p.slides[3].notes).not.toBe(p.slides[0].notes)
    // table slide
    const t4 = p.slides[4].shapes.find((s) => s.type === 'table')
    expect(t4?.type === 'table' && t4.rows.map((r) => r.map((c) => c[0].text))).toEqual([['Name', 'Qty'], ['Apple', '3'], ['Pear', '4']])
    expect(p.slides[1].notes).toBeUndefined()
    // everything is inside the slide and colours are validated hex
    for (const s of p.slides) for (const sh of s.shapes) {
      expect(sh.x).toBeGreaterThanOrEqual(0)
      expect(sh.x + sh.w).toBeLessThanOrEqual(1.001)
      expect(sh.y + sh.h).toBeLessThanOrEqual(1.001)
    }
    const colours = JSON.stringify(p.slides)
    for (const m of colours.matchAll(/"(?:color|fill|line|background)":"([^"]*)"/g)) expect(m[1]).toMatch(/^#[0-9a-f]{6}$/)
    // the accent reaches the title-slide bar through the theme palette
    expect(p.slides[0].shapes.some((s) => s.type === 'shape' && s.fill === '#b03060')).toBe(true)
  })
  it('4:3 changes the slide size; a deck of every layout previews', async () => {
    const buf = await renderDeck({ size: '4:3', slides: (['title', 'section', 'content', 'two-content', 'image', 'blank'] as const).map((layout) => ({ layout, title: layout })) }, noImages)
    const path = join(dir, 'd.pptx')
    writeFileSync(path, buf)
    const p = await previewFile(path, 'pptx')
    expect(p.kind === 'slides' && p.size).toEqual({ w: 720, h: 540 })
    expect(p.kind === 'slides' && p.slides.length).toBe(6)
  })
})
