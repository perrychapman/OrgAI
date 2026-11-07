import { describe, expect, it } from 'vitest'
import { columnLetter, formulaText, isNumericCell, isSafeImageDataUrl, parseCsv, prettyJson, safeDocHref, sheetCellText, svgDataUrl } from './outputPreview'

describe('sheetCellText', () => {
  it('formats percent, fixed decimals and plain values', () => {
    expect(sheetCellText({ v: 0.125, fmt: '0.0%' })).toBe('12.5%')
    expect(sheetCellText({ v: 0.5, fmt: '0%' })).toBe('50%')
    expect(sheetCellText({ v: 1200, fmt: '#,##0.00' })).toBe('1,200.00')
    expect(sheetCellText({ v: 1200.5, fmt: '0.00' })).toBe('1200.50')
    expect(sheetCellText({ v: 42 })).toBe('42')
    expect(sheetCellText({ v: 'hi' })).toBe('hi')
    expect(sheetCellText({ v: true })).toBe('TRUE')
    expect(sheetCellText({ v: false })).toBe('FALSE')
    expect(sheetCellText({ v: null })).toBe('')
    expect(sheetCellText(undefined)).toBe('')
  })
  it('numeric detection', () => {
    expect(isNumericCell({ v: 1 })).toBe(true)
    expect(isNumericCell({ v: '1' })).toBe(false)
    expect(isNumericCell({ v: null })).toBe(false)
  })
  it('formula text', () => {
    expect(formulaText('SUM(A1:A2)')).toBe('=SUM(A1:A2)')
    expect(formulaText('=A1')).toBe('=A1')
  })
})

describe('columnLetter', () => {
  it('counts like a spreadsheet', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
  })
})

describe('parseCsv', () => {
  it('parses quotes, escaped quotes, CRLF and embedded newlines', () => {
    const r = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"l1\nl2",z\r\n')
    expect(r).toEqual({ rows: [['a', 'b'], ['x, y', 'say "hi"'], ['l1\nl2', 'z']], more: false })
  })
  it('keeps empty fields and a last row without newline', () => {
    expect(parseCsv('a,b,c\n1,,3')?.rows).toEqual([['a', 'b', 'c'], ['1', '', '3']])
  })
  it('caps rows and says there is more', () => {
    const text = Array.from({ length: 10 }, (_, i) => `${i},x`).join('\n')
    const r = parseCsv(text, 3)
    expect(r?.rows.length).toBe(3)
    expect(r?.more).toBe(true)
  })
  it('refuses malformed input', () => {
    expect(parseCsv('a,"b\nc')).toBeNull()
    expect(parseCsv('a,"b"x\n')).toBeNull()
    expect(parseCsv('')).toBeNull()
    expect(parseCsv('a,b\n1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20')).toBeNull()
  })
})

describe('prettyJson', () => {
  it('pretty prints valid JSON and refuses the rest', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}')
    expect(prettyJson('{nope')).toBeNull()
  })
})

describe('isSafeImageDataUrl', () => {
  it('allows only base64 raster images', () => {
    expect(isSafeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isSafeImageDataUrl('data:image/webp;base64,AAAA')).toBe(true)
    expect(isSafeImageDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false)
    expect(isSafeImageDataUrl('data:image/png;base64,AAAA" onerror="x')).toBe(false)
    expect(isSafeImageDataUrl('https://example.com/a.png')).toBe(false)
    expect(isSafeImageDataUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeImageDataUrl(undefined)).toBe(false)
  })
})

describe('svgDataUrl', () => {
  it('encodes UTF-8 safely', () => {
    const url = svgDataUrl('<svg>é€</svg>')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const back = Buffer.from(url.split(',')[1], 'base64').toString('utf8')
    expect(back).toBe('<svg>é€</svg>')
  })
})

describe('safeDocHref', () => {
  it('allows http, https and mailto only', () => {
    expect(safeDocHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeDocHref('http://example.com')).toBe('http://example.com')
    expect(safeDocHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(safeDocHref('javascript:alert(1)')).toBeNull()
    expect(safeDocHref('file:///c:/x')).toBeNull()
    expect(safeDocHref('data:text/html,hi')).toBeNull()
    expect(safeDocHref('/relative')).toBeNull()
    expect(safeDocHref('')).toBeNull()
  })
})
