import { describe, expect, it } from 'vitest'
import {
  CSV_GRID_MAX_COLS,
  CSV_GRID_MAX_ROWS,
  addColAt,
  addRowAt,
  cellName,
  columnName,
  deleteColAt,
  deleteRowAt,
  describeRange,
  hasFormulaCells,
  normalizeRange,
  parseCsv,
  rangeName,
  serializeCsv,
  setCell,
  undoBack,
  undoForward,
  undoPush,
  undoStart
} from './csvGrid'

function model(text: string) {
  const p = parseCsv(text)
  if (!p.ok) throw new Error(`not offered: ${p.reason}`)
  return p.model
}

describe('parseCsv / serializeCsv', () => {
  it.each(['a,b\n1,2\n', 'a,b\r\n1,2\r\n', 'a,b\n1,2', '"x, y","say ""hi"""\n"line\nbreak",z\n', 'a\n\nb\n', ''])('round trips %j', (text) => {
    expect(serializeCsv(model(text))).toBe(text)
  })

  it('keeps the line ending and the trailing newline', () => {
    const m = model('a,b\r\n1,2')
    expect(m.eol).toBe('\r\n')
    expect(m.trailingNewline).toBe(false)
    expect(model('a\n').trailingNewline).toBe(true)
  })

  it('reads quoted fields with commas, quotes and line breaks', () => {
    expect(model('"a,b","c""d","e\nf"\n').rows).toEqual([['a,b', 'c"d', 'e\nf']])
  })

  it('writes a cell as typed: = + - @ are never changed', () => {
    const m = model('a,b\n')
    m.rows[0][0] = '=SUM(A1)'
    m.rows[0][1] = '-5'
    expect(serializeCsv(m)).toBe('=SUM(A1),-5\n')
    expect(hasFormulaCells(m)).toBe(true)
    expect(hasFormulaCells(model('a,b\n'))).toBe(false)
  })

  it('pads a slightly ragged file', () => {
    const rows = Array.from({ length: 20 }, (_, i) => (i === 3 ? '1,2' : '1,2,3')).join('\n')
    expect(model(rows).rows[3]).toEqual(['1', '2', ''])
  })

  it('does not offer the grid for the cases it cannot follow', () => {
    expect(parseCsv('a;b\n1;2\n')).toMatchObject({ ok: false, reason: 'delimiter' })
    expect(parseCsv('a\tb\n')).toMatchObject({ ok: false, reason: 'delimiter' })
    expect(parseCsv('a,"b\n')).toMatchObject({ ok: false, reason: 'quotes' })
    expect(parseCsv('a,b"c\n')).toMatchObject({ ok: false, reason: 'quotes' })
    expect(parseCsv('"a"x,b\n')).toMatchObject({ ok: false, reason: 'quotes' })
    expect(parseCsv('a,b\r\n1,2\n')).toMatchObject({ ok: false, reason: 'mixed-endings' })
    expect(parseCsv('a,b\rc\n')).toMatchObject({ ok: false, reason: 'quotes' })
  })

  it('refuses over the row and column limits and a ragged file', () => {
    expect(parseCsv('a\n'.repeat(CSV_GRID_MAX_ROWS + 1))).toMatchObject({ ok: false, reason: 'too-big' })
    expect(parseCsv('a\n'.repeat(CSV_GRID_MAX_ROWS)).ok).toBe(true)
    expect(parseCsv(Array(CSV_GRID_MAX_COLS + 1).fill('x').join(',') + '\n')).toMatchObject({ ok: false, reason: 'too-big' })
    const ragged = ['1,2,3', '1,2', '1', '1,2,3', '1,2,3'].join('\n')
    expect(parseCsv(ragged)).toMatchObject({ ok: false, reason: 'ragged' })
  })
})

describe('cell names', () => {
  it('names columns past Z', () => {
    expect([columnName(0), columnName(25), columnName(26), columnName(27), columnName(701), columnName(702)]).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })
  it('names cells and ranges', () => {
    expect(cellName(1, 1)).toBe('B2')
    const r = normalizeRange({ r: 3, c: 2 }, { r: 1, c: 1 })
    expect(r).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 })
    expect(rangeName(r)).toBe('B2:C4')
    expect(describeRange(r)).toBe('Cells B2:C4')
    expect(describeRange(normalizeRange({ r: 0, c: 0 }, { r: 0, c: 0 }))).toBe('Cell A1')
  })
})

describe('edits', () => {
  const rows = [
    ['a', 'b'],
    ['c', 'd']
  ]
  it('sets a cell without touching the input', () => {
    const next = setCell(rows, 1, 0, 'x')
    expect(next[1][0]).toBe('x')
    expect(rows[1][0]).toBe('c')
    expect(setCell(rows, 1, 0, 'c')).toBe(rows)
  })
  it('adds and deletes rows and columns', () => {
    expect(addRowAt(rows, 1)).toEqual([['a', 'b'], ['', ''], ['c', 'd']])
    expect(addColAt(rows, 2)).toEqual([['a', 'b', ''], ['c', 'd', '']])
    expect(deleteRowAt(rows, 0)).toEqual([['c', 'd']])
    expect(deleteColAt(rows, 1)).toEqual([['a'], ['c']])
  })
  it('never deletes the last row or column and respects the limits', () => {
    expect(deleteRowAt([['a']], 0)).toBeNull()
    expect(deleteColAt([['a']], 0)).toBeNull()
    expect(addRowAt(Array.from({ length: CSV_GRID_MAX_ROWS }, () => ['']), 0)).toBeNull()
    expect(addColAt([Array<string>(CSV_GRID_MAX_COLS).fill('')], 0)).toBeNull()
  })
})

describe('undo stack', () => {
  it('goes back and forward and clears the future on a new edit', () => {
    let s = undoStart(0)
    s = undoPush(s, 1)
    s = undoPush(s, 2)
    s = undoBack(s)
    expect(s.present).toBe(1)
    s = undoForward(s)
    expect(s.present).toBe(2)
    s = undoBack(undoBack(s))
    expect(s.present).toBe(0)
    expect(undoBack(s)).toBe(s)
    s = undoPush(s, 9)
    expect(s.future).toEqual([])
    expect(undoForward(s)).toBe(s)
  })
  it('keeps at most the limit', () => {
    let s = undoStart(0)
    for (let i = 1; i <= 150; i++) s = undoPush(s, i)
    expect(s.past).toHaveLength(100)
    expect(s.past[0]).toBe(50)
  })
  it('ignores an unchanged value', () => {
    const s = undoStart('a')
    expect(undoPush(s, 'a')).toBe(s)
  })
})
