import { describe, expect, it } from 'vitest'
import { columnLetter, headingLevel, isSafeHref, isSafeImageDataUrl, parseCsv, sheetCellText, svgDataUrl, utf8ToBase64 } from './outputPreview'

describe('columnLetter', () => {
  it('counts like a spreadsheet', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(27)).toBe('AB')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(52)).toBe('BA')
    expect(columnLetter(701)).toBe('ZZ')
    expect(columnLetter(702)).toBe('AAA')
  })
})

describe('sheetCellText', () => {
  it('formats percent, decimals, booleans, null and text', () => {
    expect(sheetCellText({ v: 0.25, fmt: '0%' })).toBe('25%')
    expect(sheetCellText({ v: 0.256, fmt: '0.0%' })).toBe('25.6%')
    expect(sheetCellText({ v: 1234.5, fmt: '#,##0.00' })).toBe('1234.50')
    expect(sheetCellText({ v: true })).toBe('TRUE')
    expect(sheetCellText({ v: false })).toBe('FALSE')
    expect(sheetCellText({ v: null })).toBe('')
    expect(sheetCellText({ v: 7 })).toBe('7')
    expect(sheetCellText({ v: '=1+1' })).toBe('=1+1')
  })
})

describe('parseCsv', () => {
  it('parses quotes, escaped quotes and embedded newlines', () => {
    expect(parseCsv('a,b\n"x,1","he said ""hi"""\r\n"l1\nl2",z\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['l1\nl2', 'z']
    ])
  })
  it('keeps empty cells', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3']
    ])
  })
  it('refuses ragged, unterminated and empty input', () => {
    expect(parseCsv('a,b\n1')).toBeNull()
    expect(parseCsv('a,"b\n1,2')).toBeNull()
    expect(parseCsv('')).toBeNull()
    expect(parseCsv('just text')).toBeNull()
  })
})

describe('image data urls', () => {
  it('allows only the four raster types as base64', () => {
    expect(isSafeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isSafeImageDataUrl('data:image/webp;base64,AAAA')).toBe(true)
    expect(isSafeImageDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false)
    expect(isSafeImageDataUrl('data:text/html;base64,AAAA')).toBe(false)
    expect(isSafeImageDataUrl('https://example.com/a.png')).toBe(false)
    expect(isSafeImageDataUrl('data:image/png;base64,AAAA" onerror="x')).toBe(false)
  })
})

describe('svg base64', () => {
  it('is UTF-8 safe', () => {
    expect(utf8ToBase64('hi')).toBe('aGk=')
    expect(Buffer.from(utf8ToBase64('é€😀'), 'base64').toString('utf8')).toBe('é€😀')
    expect(svgDataUrl('<svg/>').startsWith('data:image/svg+xml;base64,')).toBe(true)
  })
})

describe('headingLevel', () => {
  it('maps n to n+3 capped at 6', () => {
    expect([1, 2, 3, 4, 5, 6].map(headingLevel)).toEqual([4, 5, 6, 6, 6, 6])
  })
})

describe('isSafeHref', () => {
  it('allows http, https and mailto only', () => {
    expect(isSafeHref('https://a.com')).toBe(true)
    expect(isSafeHref('HTTP://a.com')).toBe(true)
    expect(isSafeHref('mailto:a@b.c')).toBe(true)
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('file:///c:/x')).toBe(false)
    expect(isSafeHref('/relative')).toBe(false)
    expect(isSafeHref(undefined)).toBe(false)
  })
})
