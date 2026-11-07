import JSZip from 'jszip'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SlideDeckInput } from '@shared/types'
import { OUTPUT_PPTX_ELEMENTS_PER_SLIDE, OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES } from '@shared/types'
import { renderDeck } from './pptxWrite'
import { previewPptxBuffer } from './pptxPreview'
import { previewFile } from './preview'

/**
 * Timings of the pptx write and preview paths at their caps. Logged; asserted only against generous bounds so a slow
 * runner stays green. The preview runs on the main thread (one at a time through the service queue).
 */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-pptx-measure-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now()
  const r = await fn()
  const t = performance.now() - t0
  console.log(`[pptx measure] ${label}: ${t.toFixed(0)} ms`)
  return [r, t]
}

describe('pptx write and preview at the caps', () => {
  it('100 full slides: write, then preview', async () => {
    const deck: SlideDeckInput = {
      slides: Array.from({ length: 100 }, (_, i) => ({
        layout: i % 3 === 0 ? ('content' as const) : i % 3 === 1 ? ('two-content' as const) : ('image' as const),
        title: `Slide ${i + 1}`,
        ...(i % 3 === 0 ? { bullets: Array.from({ length: OUTPUT_PPTX_ELEMENTS_PER_SLIDE - 2 }, (_, k) => ({ text: `Bullet ${k} with some words to wrap around the line`, level: (k % 3) as 0 | 1 | 2 })) } : {}),
        ...(i % 3 === 1 ? { left: [{ type: 'table' as const, rows: Array.from({ length: 15 }, (_, r) => Array.from({ length: 6 }, (_, c) => `r${r}c${c}`)), header: true }], right: [{ type: 'bullets' as const, bullets: Array.from({ length: 10 }, (_, k) => ({ text: `Right ${k}` })) }] } : {}),
        ...(i % 3 === 2 ? { image: { path: 'p.png', alt: 'pic', caption: 'cap' } } : {}),
        notes: `Notes for slide ${i + 1}`
      }))
    }
    const [buf, tw] = await ms('write 100 slides', () => renderDeck(deck, { read: () => PNG }))
    const path = join(dir, 'full.pptx')
    writeFileSync(path, buf)
    const [p, tp] = await ms(`preview 100 slides (${(buf.length / 1024).toFixed(0)} KB)`, () => previewFile(path, 'pptx'))
    expect(p.kind).toBe('slides')
    expect(p.kind === 'slides' && p.slides.length).toBe(100)
    expect(tw).toBeLessThan(15_000)
    expect(tp).toBeLessThan(10_000)
  })

  it('XML near the 8 MB cap: 200 slides of about 37 KB', async () => {
    const shape = (i: number): string => `<p:sp><p:nvSpPr><p:cNvPr id="${i}" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${(i % 50) * 100000}" y="${(i % 20) * 100000}"/><a:ext cx="900000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200" b="1"><a:solidFill><a:srgbClr val="336699"/></a:solidFill></a:rPr><a:t>Shape ${i} text</a:t></a:r></a:p></p:txBody></p:sp>`
    let body = ''
    let n = 2
    while (body.length < 37_000) body += shape(n++)
    const slide = `<p:sld ${NS}><p:cSld><p:spTree>${GRP}${body}</p:spTree></p:cSld></p:sld>`
    const slideCount = Math.floor((OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES * 0.93) / slide.length)
    const rels = (items: string): string => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types xmlns="x"/>')
    zip.file('_rels/.rels', rels(`<Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/>`))
    zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst>${Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`)
    zip.file('ppt/_rels/presentation.xml.rels', rels(Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${RT}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')))
    for (let i = 1; i <= slideCount; i++) zip.file(`ppt/slides/slide${i}.xml`, slide.replace('Shape 2 text', `Shape 2 text ${i}`))
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' })
    const [p, t] = await ms(`preview ${slideCount} slides x ${slide.length} B of XML (${(buf.length / 1024).toFixed(0)} KB zip)`, () => previewPptxBuffer(buf))
    expect(p.kind).toBe('slides')
    // a slide count past the cap shows the first 200 only; the XML cap is on the package, not the parsed part
    expect(t).toBeLessThan(15_000)
  })

  it('a deck past the XML cap is refused at once, without parsing', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types xmlns="x"/>')
    for (let i = 0; i < 12; i++) zip.file(`ppt/slides/slide${i}.xml`, `<p:sld ${NS}>${'<!-- pad -->'.repeat(70_000)}</p:sld>`)
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' })
    const [p, t] = await ms('refuse a 9 MB XML package', () => previewPptxBuffer(buf))
    expect(p.kind === 'none' && p.reason).toMatch(/too large|compressed far/)
    expect(t).toBeLessThan(5000)
  })
})
