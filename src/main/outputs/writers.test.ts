import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { OUTPUT_TEXT_MAX_BYTES } from '@shared/types'
import { mermaidProblem, renderProduced, sanitizeSheetNames, svgProblem } from './writers'

const GOOD_SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><style>.a{fill:url(#g)}</style><rect width="5" height="5" fill="url(#g)"/><use xlink:href="#g"/><text>a &amp; b &#169;</text></svg>'

describe('text kinds', () => {
  it('writes UTF-8 text', async () => {
    expect((await renderProduced({ kind: 'markdown', title: 't', content: '# é' })).toString('utf8')).toBe('# é')
    expect((await renderProduced({ kind: 'csv', title: 't', content: 'a,b\n1,2' })).toString()).toBe('a,b\n1,2')
  })
  it('refuses non-strings, oversize and NUL', async () => {
    await expect(renderProduced({ kind: 'text', title: 't', content: { sheets: [] } })).rejects.toThrow(/must be text/)
    await expect(renderProduced({ kind: 'text', title: 't', content: 'x'.repeat(OUTPUT_TEXT_MAX_BYTES + 1) })).rejects.toThrow(/larger/)
    await expect(renderProduced({ kind: 'text', title: 't', content: 'a\u0000b' })).rejects.toThrow(/NUL/)
  })
  it('json must parse', async () => {
    await renderProduced({ kind: 'json', title: 't', content: '{"a":1}' })
    await expect(renderProduced({ kind: 'json', title: 't', content: '{a:1}' })).rejects.toThrow(/not valid/)
  })
  it('refuses an unknown kind', async () => {
    await expect(renderProduced({ kind: 'exe' as never, title: 't', content: 'x' })).rejects.toThrow(/cannot be produced/)
  })
})

describe('mermaid', () => {
  it.each(['flowchart TD\nA-->B', '%% c\n\ngraph LR;\nA-->B', '---\ntitle: x\n---\nsequenceDiagram\nA->>B: hi', 'pie title X\n"a": 1', 'classDiagram-v2\nclass A', 'xychart-beta\ntitle "x"'])('accepts %j', (t) => {
    expect(mermaidProblem(t)).toBeNull()
  })
  it.each(['', '   \n%% only a comment', 'hello world', 'graphviz x', '---\nflowchart TD', 'flowchartTD'])('refuses %j', (t) => {
    expect(mermaidProblem(t)).toBeTruthy()
  })
  it('writer refuses a bad diagram', async () => {
    await expect(renderProduced({ kind: 'mermaid', title: 't', content: 'nope' })).rejects.toThrow(/diagram type/)
  })
})

describe('svg namespaces, loading attributes and CSS', () => {
  const NS = 'xmlns="http://www.w3.org/2000/svg"'
  it.each([
    ['html element via prefix', `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:div/></svg>`],
    ['prefix bound elsewhere', `<svg ${NS} xmlns:s="http://evil/"><s:rect/></svg>`],
    ['unbound prefix', `<svg ${NS}><x:rect/></svg>`],
    ['default namespace rebound', `<svg ${NS}><g xmlns="http://www.w3.org/1999/xhtml"><rect/></g></svg>`],
    ['default namespace emptied', `<svg ${NS}><g xmlns=""><rect/></g></svg>`],
    ['root default namespace not svg', '<svg xmlns="http://www.w3.org/1999/xhtml"/>'],
    ['unknown element', `<svg ${NS}><blink/></svg>`],
    ['html in svg', `<svg ${NS}><div/></svg>`],
    ['src', `<svg ${NS}><image src="x.png"/></svg>`],
    ['srcset', `<svg ${NS}><g srcset="a 1x"/></svg>`],
    ['action', `<svg ${NS}><g action="x"/></svg>`],
    ['formaction', `<svg ${NS}><g formaction="x"/></svg>`],
    ['data', `<svg ${NS}><g data="x"/></svg>`],
    ['poster', `<svg ${NS}><g poster="x"/></svg>`],
    ['background', `<svg ${NS}><g background="x"/></svg>`],
    ['prefixed src', `<svg ${NS} xmlns:q="http://q/"><g q:src="x"/></svg>`],
    ['image-set attr', `<svg ${NS}><rect style="fill:image-set(url(#a) 1x)"/></svg>`],
    ['image-set style', `<svg ${NS}><style>a{background:IMAGE-SET("x" 1x)}</style></svg>`],
    ['@import style', `<svg ${NS}><style>@import "x.css";</style></svg>`],
    ['@import in a prefixed style element', `<svg ${NS}><s:style xmlns:s="http://www.w3.org/2000/svg">@import "x.css";</s:style></svg>`],
    ['@import in an upper-case prefixed style', `<svg ${NS}><s:STYLE xmlns:s="http://www.w3.org/2000/svg">@import "x.css";</s:STYLE></svg>`],
    ['@import attr', `<svg ${NS}><rect style="@import 'x'"/></svg>`]
  ])('refuses %s', (_n, svg) => {
    expect(svgProblem(svg)).toBeTruthy()
  })
  it('still accepts data-* attributes, prefixed SVG elements, nested scope and filters', () => {
    expect(svgProblem(`<svg ${NS}><g data-x="1"><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></g></svg>`)).toBeNull()
    expect(svgProblem('<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:g><s:rect/></s:g></s:svg>')).toBeNull()
    expect(svgProblem(`<svg ${NS}><g xmlns:s="http://www.w3.org/2000/svg"><s:rect/></g></svg>`)).toBeNull()
    // a prefix bound inside one element is not in scope for its sibling
    expect(svgProblem(`<svg ${NS}><g xmlns:s="http://www.w3.org/2000/svg"/><s:rect/></svg>`)).toBeTruthy()
  })
})

describe('svg', () => {
  it('accepts a plain svg with fragment references', () => {
    expect(svgProblem(GOOD_SVG)).toBeNull()
    expect(svgProblem('<svg/>')).toBeNull()
    expect(svgProblem('﻿<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:g/></svg:svg>')).toBeNull()
  })
  it.each([
    ['doctype', '<!DOCTYPE svg><svg/>'],
    ['entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>'],
    ['undefined entity', '<svg>&x;</svg>'],
    ['pi', '<svg><?php echo 1 ?></svg>'],
    ['pi first not xml', '<?xml-stylesheet href="a"?><svg/>'],
    ['xml decl later', '<svg/><?xml version="1.0"?>'],
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['SCRIPT case', '<svg><ScRiPt/></svg>'],
    ['prefixed script', '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script/></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['iframe', '<svg><iframe src="x"/></svg>'],
    ['embed', '<svg><embed/></svg>'],
    ['object', '<svg><object/></svg>'],
    ['onload', '<svg onload="alert(1)"/>'],
    ['ONCLICK', '<svg><rect ONCLICK="x()"/></svg>'],
    ['prefixed on', '<svg><rect x:onclick="x()"/></svg>'],
    ['href external', '<svg><a href="https://evil/"><rect/></a></svg>'],
    ['href javascript', '<svg><a href="javascript:alert(1)"/></svg>'],
    ['href entity', '<svg><a href="&#106;avascript:alert(1)"/></svg>'],
    ['xlink external', '<svg><use xlink:href="http://x/y.svg#a"/></svg>'],
    ['data image', '<svg><image href="data:image/png;base64,AAAA"/></svg>'],
    ['url external attr', '<svg><rect fill="url(http://evil/x)"/></svg>'],
    ['url quoted external', '<svg><rect style="fill:url( \'http://evil/x\' )"/></svg>'],
    ['url entity', '<svg><rect style="fill:u&#114;l(http://evil/x)"/></svg>'],
    ['css escape', '<svg><style>.a{background:\\75rl(http://x)}</style></svg>'],
    ['style url external', '<svg><style>.a{fill:url(http://evil/x)}</style></svg>'],
    ['style cdata url', '<svg><style><![CDATA[.a{fill:url(//evil/x)}]]></style></svg>'],
    ['import', '<svg><style>@import url(#a);</style></svg>'],
    ['import attr', '<svg><rect style="@import \'x\'"/></svg>'],
    ['animate href', '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>'],
    ['root not svg', '<html/>'],
    ['two roots', '<svg/><svg/>'],
    ['unbalanced', '<svg><g></svg>'],
    ['mismatch', '<svg><g></h></svg>'],
    ['unclosed', '<svg><g>'],
    ['unquoted attr', '<svg width=10/>'],
    ['unclosed attr', '<svg width="10/>'],
    ['no space between attrs', '<svg a="1"b="2"/>'],
    ['text outside', 'hello <svg/>'],
    ['text after', '<svg/> trailing'],
    ['lt in attr', '<svg a="<"/>'],
    ['control char', '<svg>\u0001</svg>'],
    ['empty', ''],
    ['unclosed comment', '<svg><!-- x</svg>'],
    ['deep', '<svg>' + '<g>'.repeat(1100) + '</g>'.repeat(1100) + '</svg>']
  ])('refuses %s', (_n, s) => {
    expect(svgProblem(s)).toBeTruthy()
  })
  it('is linear on a hostile input', () => {
    const t0 = performance.now()
    svgProblem('<svg>' + '<a '.repeat(200_000))
    svgProblem('<svg ' + 'a="1" '.repeat(200_000) + '/>')
    svgProblem('<svg>' + '&'.repeat(500_000) + '</svg>')
    expect(performance.now() - t0).toBeLessThan(2000)
  })
  it('writer refuses and never strips', async () => {
    await expect(renderProduced({ kind: 'svg', title: 't', content: '<svg><script/></svg>' })).rejects.toThrow(/script/)
    expect((await renderProduced({ kind: 'svg', title: 't', content: GOOD_SVG })).toString()).toBe(GOOD_SVG)
  })
})

describe('xlsx', () => {
  const read = async (buf: Buffer) => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    return wb
  }
  it('writes sheets, header row, widths and number formats', async () => {
    const buf = await renderProduced({
      kind: 'xlsx',
      title: 't',
      content: {
        sheets: [{ name: 'Data', columns: [{ header: 'Name', width: 400 }, { header: 'Amt' }], rows: [['a', 1234.5], ['b', true], [null, 'x']], numberFormat: [null, '#,##0.00'] }]
      }
    })
    const wb = await read(buf)
    const ws = wb.getWorksheet('Data')!
    expect(ws.getRow(1).getCell(1).value).toBe('Name')
    expect(ws.getRow(1).font?.bold).toBe(true)
    expect(ws.getColumn(1).width).toBe(255)
    expect(ws.getRow(2).getCell(2).value).toBe(1234.5)
    expect(ws.getRow(2).getCell(2).numFmt).toBe('#,##0.00')
    expect(ws.getRow(3).getCell(2).value).toBe(true)
    expect(ws.getRow(4).getCell(1).value).toBeNull()
  })
  it('never writes a formula', async () => {
    const buf = await renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'F', rows: [['=SUM(A1:A2)', '+1', '-1', '@x', '=cmd|"/c calc"!A1']] }] } })
    const wb = await read(buf)
    const row = wb.getWorksheet('F')!.getRow(1)
    for (let c = 1; c <= 5; c++) {
      const cell = row.getCell(c)
      expect(cell.formula).toBeUndefined()
      expect(cell.type).toBe(ExcelJS.ValueType.String)
      expect(typeof cell.value).toBe('string')
    }
    expect(row.getCell(1).value).toBe('=SUM(A1:A2)')
    // and no <f> element in the sheet XML
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).not.toMatch(/<f[ >]/)
  })
  it('sanitizes sheet names', () => {
    expect(sanitizeSheetNames(['a:b\\c/d?e*f[g]h', "'quoted'", '', 'x'.repeat(40), 'Dup', 'dup', 'DUP', 'History'])).toEqual([
      'a-b-c-d-e-f-g-h', 'quoted', 'Sheet3', 'x'.repeat(31), 'Dup', 'dup (2)', 'DUP (3)', 'History-'
    ])
    const dups = sanitizeSheetNames(['y'.repeat(31), 'y'.repeat(31)])
    expect(dups[1].length).toBeLessThanOrEqual(31)
    expect(dups[1]).not.toBe(dups[0])
  })
  it.each([
    ['not an object', 'x'],
    ['no sheets', { sheets: [] }],
    ['21 sheets', { sheets: Array.from({ length: 21 }, (_, i) => ({ name: `s${i}`, rows: [] })) }],
    ['rows missing', { sheets: [{ name: 'a' }] }],
    ['too many rows', { sheets: [{ name: 'a', rows: Array.from({ length: 10_001 }, () => []) }] }],
    ['too many columns', { sheets: [{ name: 'a', rows: [Array.from({ length: 257 }, () => 1)] }] }],
    ['cell object', { sheets: [{ name: 'a', rows: [[{ formula: 'A1' }]] }] }],
    ['NaN', { sheets: [{ name: 'a', rows: [[NaN]] }] }],
    ['Infinity', { sheets: [{ name: 'a', rows: [[Infinity]] }] }],
    ['long cell', { sheets: [{ name: 'a', rows: [['x'.repeat(32 * 1024 + 1)]] }] }],
    ['bad format', { sheets: [{ name: 'a', rows: [], numberFormat: ['x'.repeat(65)] }] }],
    ['control format', { sheets: [{ name: 'a', rows: [], numberFormat: ['0\u0001'] }] }],
    ['no name', { sheets: [{ rows: [] }] }],
    ['string content', { sheets: 'x' }]
  ])('refuses %s', async (_n, content) => {
    await expect(renderProduced({ kind: 'xlsx', title: 't', content: content as never })).rejects.toThrow()
  })
  it('refuses text content for xlsx', async () => {
    await expect(renderProduced({ kind: 'xlsx', title: 't', content: 'a,b' })).rejects.toThrow(/object/)
  })
})

describe('docx', () => {
  it('refuses a workbook object and oversize text', async () => {
    await expect(renderProduced({ kind: 'docx', title: 't', content: { sheets: [] } })).rejects.toThrow(/must be text/)
    await expect(renderProduced({ kind: 'docx', title: 't', content: 'x'.repeat(OUTPUT_TEXT_MAX_BYTES + 1) })).rejects.toThrow(/larger/)
  })
  it('renders', async () => {
    expect((await renderProduced({ kind: 'docx', title: 't', content: '# Hi' })).subarray(0, 2).toString()).toBe('PK')
  })
})
