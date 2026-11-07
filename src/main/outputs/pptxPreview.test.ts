import JSZip from 'jszip'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputPreview, SlideDeckInput, SlidePreview } from '@shared/types'
import { OUTPUT_PREVIEW_SLIDES_MAX, OUTPUT_PREVIEW_SLIDE_SHAPES_MAX } from '@shared/types'
import { renderDeck } from './pptxWrite'
import { previewPptxBuffer, resolveTarget } from './pptxPreview'
import { previewFile } from './preview'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-pptxp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const gen = async (zip: JSZip): Promise<Buffer> => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'DOS' })
const rels = (items: [string, string, string, boolean?][]): string =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${RT}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`

interface Mini {
  slide: string
  slideRels?: [string, string, string, boolean?][]
  layout?: string
  master?: string
  theme?: string
  extra?: Record<string, string | Buffer>
  contentTypes?: string
  slides?: number
}

/** A hand-written minimal package: one master, one layout, one theme and `slides` copies of the slide part. */
async function mini(m: Mini): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', m.contentTypes ?? '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
  zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]))
  const n = m.slides ?? 1
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`
  )
  zip.file('ppt/_rels/presentation.xml.rels', rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...Array.from({ length: n }, (_, i): [string, string, string] => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])]))
  for (let i = 1; i <= n; i++) {
    zip.file(`ppt/slides/slide${i}.xml`, m.slide)
    zip.file(`ppt/slides/_rels/slide${i}.xml.rels`, rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(m.slideRels ?? [])]))
  }
  zip.file('ppt/slideLayouts/slideLayout1.xml', m.layout ?? `<p:sldLayout ${NS}><p:cSld><p:spTree>${GRP}</p:spTree></p:cSld></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]))
  zip.file('ppt/slideMasters/slideMaster1.xml', m.master ?? `<p:sldMaster ${NS}><p:cSld><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]))
  zip.file(
    'ppt/theme/theme1.xml',
    m.theme ??
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme></a:themeElements></a:theme>'
  )
  for (const [k, v] of Object.entries(m.extra ?? {})) zip.file(k, v)
  return gen(zip)
}

const slideXml = (shapes: string, bg = ''): string => `<p:sld ${NS}><p:cSld>${bg}<p:spTree>${GRP}${shapes}</p:spTree></p:cSld></p:sld>`
const xf = (x: number, y: number, w: number, h: number): string => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`
const textSp = (id: number, body: string, g = xf(914400, 685800, 4572000, 685800), extraSpPr = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${g}${extraSpPr}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`

const slides = (p: OutputPreview): SlidePreview[] => {
  if (p.kind !== 'slides') throw new Error(`not slides: ${JSON.stringify(p).slice(0, 200)}`)
  return p.slides
}
const reason = (p: OutputPreview): string => (p.kind === 'none' ? p.reason : '')

describe('resolveTarget', () => {
  it('stays inside the package', () => {
    expect(resolveTarget('ppt/slides', '../media/a.png')).toBe('ppt/media/a.png')
    expect(resolveTarget('ppt/slides', 'slide2.xml')).toBe('ppt/slides/slide2.xml')
    expect(resolveTarget('ppt/slides', './x/../y.xml')).toBe('ppt/slides/y.xml')
    expect(resolveTarget('ppt/slides', '../../../etc/passwd')).toBeNull()
    expect(resolveTarget('', '../x')).toBeNull()
    expect(resolveTarget('ppt', '/ppt/x.xml')).toBeNull()
    expect(resolveTarget('ppt', 'C:\\x')).toBeNull()
    expect(resolveTarget('ppt', 'a\\b')).toBeNull()
    expect(resolveTarget('ppt', 'http://example.com/x')).toBeNull()
    expect(resolveTarget('ppt', 'file:///x')).toBeNull()
    expect(resolveTarget('ppt', '')).toBeNull()
  })
})

describe('placeholder inheritance, theme colours and text style', () => {
  it('takes geometry from the layout, then the master, and resolves scheme colours with lumMod / lumOff', async () => {
    const layout = `<p:sldLayout ${NS}><p:cSld><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xf(914400, 0, 7315200, 1371600)}</p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`
    const master = `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree>${GRP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="B"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xf(457200, 1828800, 8229600, 4572000)}</p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle><a:lvl1pPr><a:buChar char="x"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/><p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`
    const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Inherited title</a:t></a:r></a:p></p:txBody></p:sp>`
    const body = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Inherited body</a:t></a:r></a:p></p:txBody></p:sp>`
    const p = await previewPptxBuffer(await mini({ slide: slideXml(title + body), layout, master }))
    const s = slides(p)[0]
    expect(s.title).toBe('Inherited title')
    expect(s.background).toBe('#ffffff')
    const [t, b] = s.shapes
    expect(t.type === 'text' && t.paragraphs[0].runs[0]).toMatchObject({ text: 'Inherited title', sizePt: 44, bold: true })
    expect(t.x).toBeCloseTo(0.1, 3)
    expect(t.w).toBeCloseTo(0.8, 3)
    expect(t.type === 'text' && t.paragraphs[0].align).toBe('center')
    expect(b.x).toBeCloseTo(0.05, 3)
    expect(b.type === 'text' && b.anchor).toBe('middle')
    expect(b.type === 'text' && b.paragraphs[0]).toMatchObject({ bullet: 'disc' })
    // accent1 FF0000 at 50% luminance: 800000 (rounded)
    expect(b.type === 'text' && b.paragraphs[0].runs[0].color).toMatch(/^#[78][0-9a-f]0000$/)
    expect(b.type === 'text' && b.paragraphs[0].runs[0].sizePt).toBe(28)
  })
  it('flattens groups with their transform', async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="914400" cy="914400"/></a:xfrm></p:grpSpPr>${textSp(3, '<a:p><a:r><a:t>in group</a:t></a:r></a:p>', xf(457200, 0, 457200, 457200))}</p:grpSp>`
    const s = slides(await previewPptxBuffer(await mini({ slide: slideXml(grp) })))[0]
    const t = s.shapes[0]
    expect(t.x).toBeCloseTo((914400 + 457200 * 2) / 9144000, 4)
    expect(t.w).toBeCloseTo((457200 * 2) / 9144000, 4)
  })
  it('previews tables, charts and SmartArt placeholders and shapes', async () => {
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="1371600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:rPr b="1"/><a:t>H</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>v1</a:t></a:r></a:p><a:p><a:r><a:t>v2</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="c" descr="Sales chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="x" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`
    const dgm = chart.replace('/chart"', '/diagram"').replace('descr="Sales chart"', '')
    const rect = `<p:sp><p:nvSpPr><p:cNvPr id="7" name="r"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(0, 0, 100, 100)}<a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></p:spPr></p:sp>`
    const s = slides(await previewPptxBuffer(await mini({ slide: slideXml(tbl + chart + dgm + rect) })))[0]
    expect(s.shapes.map((x) => x.type)).toEqual(['table', 'placeholder', 'placeholder', 'shape'])
    const t = s.shapes[0]
    expect(t.type === 'table' && t.rows.map((r) => r[0].map((c) => c.text))).toEqual([['H'], ['v1', '\n', 'v2']])
    expect(s.shapes[1]).toMatchObject({ label: 'Chart', alt: 'Sales chart' })
    expect(s.shapes[2]).toMatchObject({ label: 'SmartArt' })
    expect(s.shapes[3]).toMatchObject({ geometry: 'roundRect', fill: '#00ff00', line: '#0000ff' })
  })
})

describe('hostile packages', () => {
  it('refuses a zip bomb, too many entries and unsafe entry names', async () => {
    const bomb = new JSZip()
    bomb.file('[Content_Types].xml', '<Types/>')
    bomb.file('ppt/slides/slide1.xml', Buffer.alloc(20 * 1024 * 1024))
    const r1 = await previewPptxBuffer(await gen(bomb))
    expect(reason(r1)).toMatch(/compressed far beyond|expands/)

    const many = new JSZip()
    for (let i = 0; i < 10_001; i++) many.file(`f${i}.txt`, 'x')
    expect(reason(await previewPptxBuffer(await gen(many)))).toMatch(/more than 10000 parts/)

    for (const name of ['../evil.xml', 'ppt/../../evil.xml', 'ppt\\evil.xml', '/abs.xml']) {
      const z = new JSZip()
      z.file('[Content_Types].xml', '<Types/>')
      z.file(name, 'x', { createFolders: false })
      const out = await previewPptxBuffer(await gen(z))
      expect(out.kind).toBe('none')
    }
  })
  it('never fetches an external relationship and shows the picture as a placeholder', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not be called'))
    const pic = (embed: string): string => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p" descr="remote"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr>${xf(0, 0, 914400, 914400)}</p:spPr></p:pic>`
    const link = `<p:sp><p:nvSpPr><p:cNvPr id="5" name="l"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf(0, 0, 100, 100)}</p:spPr><p:txBody><a:p><a:r><a:rPr><a:hlinkClick r:id="rId8"/></a:rPr><a:t>site</a:t></a:r><a:r><a:rPr><a:hlinkClick r:id="rId9"/></a:rPr><a:t>evil</a:t></a:r></a:p></p:txBody></p:sp>`
    const buf = await mini({
      slide: slideXml(pic('rId5') + link),
      slideRels: [['rId5', 'image', 'http://127.0.0.1:9/x.png', true], ['rId8', 'hyperlink', 'https://example.org/ok', true], ['rId9', 'hyperlink', 'javascript:alert(1)', true]]
    })
    const s = slides(await previewPptxBuffer(buf))[0]
    expect(s.shapes[0]).toMatchObject({ type: 'placeholder', label: 'Picture', alt: 'remote' })
    const t = s.shapes[1]
    expect(t.type === 'text' && t.paragraphs[0].runs.map((r) => r.href)).toEqual(['https://example.org/ok', undefined])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('a media target that escapes the package or is absolute reads nothing', async () => {
    const pic = (embed: string): string => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr>${xf(0, 0, 914400, 914400)}</p:spPr></p:pic>`
    const buf = await mini({
      slide: slideXml(pic('rId5') + pic('rId6') + pic('rId7')),
      slideRels: [['rId5', 'image', '../../../outside.png'], ['rId6', 'image', '/ppt/media/ok.png'], ['rId7', 'image', '..\\..\\x.png']],
      extra: { 'ppt/media/ok.png': PNG }
    })
    const s = slides(await previewPptxBuffer(buf))[0]
    expect(s.shapes.map((x) => x.type)).toEqual(['placeholder', 'placeholder', 'placeholder'])
  })
  it('shows only listed image types read by magic bytes; other media stay unread', async () => {
    const pic = (embed: string): string => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr>${xf(0, 0, 914400, 914400)}</p:spPr></p:pic>`
    const buf = await mini({
      slide: slideXml(pic('rId5') + pic('rId6') + pic('rId7') + pic('rId8')),
      slideRels: [['rId5', 'image', '../media/good.png'], ['rId6', 'image', '../media/script.png'], ['rId7', 'image', '../media/vec.emf'], ['rId8', 'image', '../slides/slide1.xml']],
      extra: { 'ppt/media/good.png': PNG, 'ppt/media/script.png': '<svg onload="x()"/>', 'ppt/media/vec.emf': Buffer.from([1, 0, 0, 0, 0, 0]) }
    })
    const s = slides(await previewPptxBuffer(buf))[0]
    expect(s.shapes.map((x) => (x.type === 'image' ? 'image' : x.type === 'placeholder' ? x.label : x.type))).toEqual(['image', 'Picture', 'Picture', 'Picture'])
    expect(s.shapes[0].type === 'image' && s.shapes[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  })
  it('an oversize picture is a placeholder and the deck total is capped', async () => {
    const big = Buffer.concat([PNG, randomBytes(2 * 1024 * 1024 + 10)])
    const pic = (rid: string): string => `<p:pic><p:nvPicPr><p:cNvPr id="4" name="p"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:spPr>${xf(0, 0, 914400, 914400)}</p:spPr></p:pic>`
    const s = slides(await previewPptxBuffer(await mini({ slide: slideXml(pic('rId5')), slideRels: [['rId5', 'image', '../media/big.png']], extra: { 'ppt/media/big.png': big } })))[0]
    expect(s.shapes[0]).toMatchObject({ type: 'placeholder', label: 'Picture' })
    // eleven pictures of 1.9 MB each: the deck total (20 MB) stops the last one
    const mid = Buffer.concat([PNG, randomBytes(2_000_000)])
    const extra: Record<string, Buffer> = {}
    const rl: [string, string, string][] = []
    for (let i = 0; i < 11; i++) {
      extra[`ppt/media/m${i}.png`] = mid.subarray(0, mid.length - i) // distinct bytes per entry
      rl.push([`rId${i + 5}`, 'image', `../media/m${i}.png`])
    }
    const t = slides(await previewPptxBuffer(await mini({ slide: slideXml(rl.map((r) => pic(r[0])).join('')), slideRels: rl, extra })))[0]
    expect(t.shapes.map((x) => x.type)).toEqual([...Array(10).fill('image'), 'placeholder'])
  })
  it('refuses XML past the cap before parsing it', async () => {
    const buf = await mini({ slide: slideXml(textSp(2, '<a:p><a:r><a:t>hello world</a:t></a:r></a:p>')) })
    expect(reason(await previewPptxBuffer(buf, 1000))).toMatch(/too large/)
    expect(slides(await previewPptxBuffer(buf))[0].shapes.length).toBe(1)
  })
  it('DOCTYPE and entity expansion in a part never expand', async () => {
    const laughs = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">]>'
    const slide = `${laughs}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${textSp(2, '<a:p><a:r><a:t>&lol2;</a:t></a:r></a:p>')}</p:spTree></p:cSld></p:sld>`
    const t0 = Date.now()
    const s = slides(await previewPptxBuffer(await mini({ slide })))[0]
    expect(s.shapes).toEqual([]) // the part is refused, the deck still opens
    expect(Date.now() - t0).toBeLessThan(3000)
    // an entity in the presentation part refuses the whole deck
    const z = await JSZip.loadAsync(await mini({ slide: slideXml('') }))
    z.file('ppt/presentation.xml', `<!DOCTYPE x [<!ENTITY e "x">]><p:presentation ${NS}/>`)
    expect(reason(await previewPptxBuffer(await gen(z)))).toMatch(/not laid out/)
    // an undeclared entity in text refuses the part, not the deck
    const s2 = slides(await previewPptxBuffer(await mini({ slide: slideXml(textSp(2, '<a:p><a:r><a:t>&nope;</a:t></a:r></a:p>')) })))[0]
    expect(s2.shapes).toEqual([])
  })
  it('refuses macro decks by part name and by content type, without reading the macro', async () => {
    const byPart = await mini({ slide: slideXml(''), extra: { 'ppt/vbaProject.bin': Buffer.from('MACRO') } })
    expect(reason(await previewPptxBuffer(byPart))).toBe('This deck contains macros; OrgAI does not preview it.')
    const byType = await mini({ slide: slideXml(''), contentTypes: '<?xml version="1.0"?><Types xmlns="x"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/></Types>' })
    expect(reason(await previewPptxBuffer(byType))).toBe('This deck contains macros; OrgAI does not preview it.')
    const ole = await mini({ slide: slideXml(''), extra: { 'ppt/embeddings/oleObject1.bin': Buffer.from('OLE'), 'ppt/activeX/activeX1.xml': '<x/>' } })
    expect(slides(await previewPptxBuffer(ole)).length).toBe(1) // present, never touched, not an error
  })
  it('drops colours that carry injected text', async () => {
    const body = `<a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="red;background:url(http://x/)"/></a:solidFill></a:rPr><a:t>a</a:t></a:r><a:r><a:rPr><a:solidFill><a:srgbClr val="0A1B2C"/></a:solidFill></a:rPr><a:t>b</a:t></a:r><a:r><a:rPr><a:solidFill><a:schemeClr val="accent9"/></a:solidFill></a:rPr><a:t>c</a:t></a:r></a:p>`
    const sp = textSp(2, body, undefined, '<a:solidFill><a:srgbClr val="#ff0000"/></a:solidFill>')
    const bg = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="zzzzzz"/></a:solidFill></p:bgPr></p:bg>'
    const s = slides(await previewPptxBuffer(await mini({ slide: slideXml(sp, bg) })))[0]
    const t = s.shapes[0]
    expect(t.type === 'text' && t.paragraphs[0].runs.map((r) => r.color)).toEqual([undefined, '#0a1b2c', undefined])
    expect(t.type === 'text' && t.fill).toBeUndefined()
    expect(s.background).toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('url(')
  })
  it('caps nesting: deep XML refuses the part, deep groups stop at the group limit', async () => {
    const deepXml = '<p:grpSp>'.repeat(100) + '</p:grpSp>'.repeat(100)
    expect(slides(await previewPptxBuffer(await mini({ slide: slideXml(deepXml) })))[0].shapes).toEqual([])
    const leaf = textSp(2, '<a:p><a:r><a:t>deep</a:t></a:r></a:p>')
    let g = leaf
    for (let i = 0; i < 20; i++) g = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${10 + i}" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${g}</p:grpSp>`
    expect(slides(await previewPptxBuffer(await mini({ slide: slideXml(g) })))[0].shapes).toEqual([]) // past 8 levels nothing is drawn
    let ok = leaf
    for (let i = 0; i < 4; i++) ok = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${10 + i}" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${ok}</p:grpSp>`
    expect(slides(await previewPptxBuffer(await mini({ slide: slideXml(ok) })))[0].shapes.length).toBe(1)
  })
  it('caps slides and shapes per slide with lower-bound counts', async () => {
    const many = await mini({ slide: slideXml(textSp(2, '<a:p><a:r><a:t>x</a:t></a:r></a:p>')), slides: OUTPUT_PREVIEW_SLIDES_MAX + 7 })
    const p = await previewPptxBuffer(many)
    expect(p.kind === 'slides' && p.slides.length).toBe(OUTPUT_PREVIEW_SLIDES_MAX)
    expect(p.kind === 'slides' && p.truncatedSlides).toBe(7)
    const shapes = Array.from({ length: OUTPUT_PREVIEW_SLIDE_SHAPES_MAX + 30 }, (_, i) => textSp(i + 2, '<a:p><a:r><a:t>x</a:t></a:r></a:p>')).join('')
    const s = slides(await previewPptxBuffer(await mini({ slide: slideXml(shapes) })))[0]
    expect(s.shapes.length).toBe(OUTPUT_PREVIEW_SLIDE_SHAPES_MAX)
    expect(s.truncatedShapes).toBe(30)
  })
  it('a part named in a relationship that does not exist is a blank slide, never a throw', async () => {
    const z = await JSZip.loadAsync(await mini({ slide: slideXml('') }))
    z.remove('ppt/slides/slide1.xml')
    const out = await previewPptxBuffer(await gen(z))
    expect(slides(out)[0].shapes).toEqual([])
    expect((await previewPptxBuffer(Buffer.from('not a zip at all, definitely not'))).kind).toBe('none')
  })
})

describe('previewFile wiring', () => {
  it('previews a produced deck by path and refuses a non-regular or missing file', async () => {
    const deck: SlideDeckInput = { slides: [{ layout: 'title', title: 'Hi' }] }
    const path = join(dir, 'a.pptx')
    writeFileSync(path, await renderDeck(deck, { read: () => PNG }))
    expect(slides(await previewFile(path, 'pptx'))[0].title).toBe('Hi')
    expect((await previewFile(join(dir, 'missing.pptx'), 'pptx')).kind).toBe('none')
    writeFileSync(join(dir, 'junk.pptx'), 'junk')
    expect((await previewFile(join(dir, 'junk.pptx'), 'pptx')).kind).toBe('none')
  })
})
