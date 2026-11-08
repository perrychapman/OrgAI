import { describe, expect, it } from 'vitest'
import type { DocumentBlock, OutputDiff, SheetCell } from '@shared/types'
import {
  blockGapText,
  blockRows,
  blockText,
  cellChangeText,
  csvRows,
  gridOfCsv,
  changeStarts,
  changedLineCount,
  gapText,
  gridChangeRows,
  linesOf,
  mergeGrid,
  segmentsOf,
  sideRows,
  stepChange,
  summarySentence,
  tableCells,
  textRows,
  valueText,
  visibleGridRows
} from './outputDiff'

type TextDiff = Extract<OutputDiff, { kind: 'text' }>

const textDiff: TextDiff = {
  kind: 'text',
  added: 3,
  removed: 2,
  hunks: [
    {
      aStart: 4,
      aCount: 4,
      bStart: 4,
      bCount: 5,
      lines: [
        { op: 'eq', a: 4, b: 4, text: 'c' },
        { op: 'del', a: 5, text: 'old one', marks: [[0, 3]] },
        { op: 'del', a: 6, text: 'gone' },
        { op: 'add', b: 5, text: 'new one', marks: [[0, 3]] },
        { op: 'add', b: 6, text: 'fresh' },
        { op: 'add', b: 7, text: 'extra' },
        { op: 'eq', a: 7, b: 8, text: 'd' }
      ]
    }
  ]
}

describe('summarySentence', () => {
  it('counts changed pairs once and drops zero parts', () => {
    expect(changedLineCount(textDiff)).toBe(2)
    expect(summarySentence(textDiff)).toBe('1 line added, 2 changed')
  })
  it('says the noun once and handles no changes', () => {
    expect(summarySentence({ kind: 'text', hunks: [], added: 12, removed: 4 })).toBe('12 lines added, 4 removed')
    expect(summarySentence({ kind: 'text', hunks: [], added: 0, removed: 0 })).toContain('no changes')
  })
  it('notes a truncated comparison', () => {
    expect(summarySentence({ kind: 'text', hunks: [], added: 1, removed: 0, truncated: true })).toContain('not shown')
  })
  it('counts blocks and cells', () => {
    expect(summarySentence({ kind: 'blocks', rows: [{ op: 'add', b: 0 }, { op: 'chg', a: 1, b: 1 }, { op: 'eq', a: 2, b: 2 }] })).toBe('1 paragraph added, 1 changed')
    const cells: OutputDiff = {
      kind: 'cells',
      sheets: [{ name: 'S', status: 'changed', changes: [{ r: 0, c: 0, op: 'chg' }, { r: 1, c: 1, op: 'add' }], rowOps: [{ r: 3, op: 'del' }] }]
    }
    expect(summarySentence(cells)).toBe('2 cells changed, 1 row removed')
    expect(summarySentence({ kind: 'none', reason: 'x' })).toBe('')
  })
})

describe('segmentsOf', () => {
  it('splits at marks and repairs bad ones', () => {
    expect(segmentsOf('hello world', [[6, 11]])).toEqual([
      { text: 'hello ', marked: false },
      { text: 'world', marked: true }
    ])
    expect(segmentsOf('abc', [[2, 99], [1, 2]]).map((s) => s.text).join('')).toBe('abc')
    expect(segmentsOf('abc', [[2, 1]])).toEqual([{ text: 'abc', marked: false }])
    expect(segmentsOf('', undefined)).toEqual([])
  })
})

describe('textRows', () => {
  const b = ['a', 'b', 'c', 'x', 'new one', 'fresh', 'extra', 'd', 'e', 'f']
  it('adds gaps before and after the hunks and numbers changes', () => {
    const rows = textRows(textDiff, b, new Set())
    expect(rows[0]).toMatchObject({ kind: 'gap', count: 3, aFrom: 1, bFrom: 1, known: true })
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'gap', count: 2 })
    expect(changeStarts(rows)).toHaveLength(1)
  })
  it('expands a gap from B lines', () => {
    const rows = textRows(textDiff, b, new Set(['g1-1']))
    expect(rows.slice(0, 3)).toMatchObject([{ kind: 'line', op: 'eq', a: 1, b: 1, text: 'a' }, { text: 'b' }, { text: 'c' }])
  })
  it('without B text gaps are not expandable and the tail is unknown', () => {
    const rows = textRows(textDiff, null, new Set())
    expect(rows[0]).toMatchObject({ kind: 'gap', known: false })
    expect(rows[rows.length - 1].kind).toBe('line')
  })
  it('pairs side by side by index', () => {
    const side = sideRows(textRows(textDiff, b, new Set()))
    const pairs = side.filter((r) => r.kind === 'pair')
    const changed = pairs.filter((p) => p.kind === 'pair' && (p.left?.op === 'del' || p.right?.op === 'add'))
    expect(changed).toHaveLength(3)
    expect(changed[0]).toMatchObject({ left: { text: 'old one' }, right: { text: 'new one' } })
    expect(changed[2]).toMatchObject({ right: { text: 'extra' } })
    expect((changed[2] as { left?: unknown }).left).toBeUndefined()
  })
  it('splits lines like main', () => {
    expect(linesOf('a\r\nb\nc\n')).toEqual(['a', 'b', 'c'])
    expect(linesOf('')).toEqual([])
  })
})

describe('stepChange and gap words', () => {
  it('wraps both ways', () => {
    expect(stepChange(3, -1, 1)).toBe(0)
    expect(stepChange(3, -1, -1)).toBe(2)
    expect(stepChange(3, 2, 1)).toBe(0)
    expect(stepChange(3, 0, -1)).toBe(2)
    expect(stepChange(0, -1, 1)).toBeNull()
  })
  it('words', () => {
    expect(gapText(1)).toBe('1 unchanged line')
    expect(gapText(12)).toBe('12 unchanged lines')
    expect(blockGapText(5)).toBe('5 unchanged paragraphs')
  })
})

describe('blockText mirrors main', () => {
  const r = (text: string) => [{ text }]
  const cases: [DocumentBlock, string][] = [
    [{ type: 'heading', level: 2, runs: [{ text: 'Hi ' }, { text: 'there', bold: true }] }, 'Hi there'],
    [{ type: 'paragraph', runs: r('p') }, 'p'],
    [{ type: 'list', ordered: false, items: [r('a'), r('b')] }, 'a\nb'],
    [{ type: 'table', rows: [[r('a'), r('b')], [r('c'), r('d')]] }, 'a\tb\nc\td'],
    [{ type: 'image', dataUrl: 'data:image/png;base64,AA==', alt: 'logo' }, '[image: logo]'],
    [{ type: 'code', text: 'x = 1' }, 'x = 1'],
    [{ type: 'rule' }, '---'],
    [{ type: 'pageBreak' }, '[page break]']
  ]
  it.each(cases)('%j', (b, want) => expect(blockText(b)).toBe(want))
})

describe('blockRows', () => {
  const para = (t: string): DocumentBlock => ({ type: 'paragraph', runs: [{ text: t }] })
  const blocks = Array.from({ length: 10 }, (_, i) => para(`p${i}`))
  it('collapses long equal runs, keeping one block beside a change', () => {
    const rows = blockRows(
      [
        { op: 'chg', a: 0, b: 0, marks: { a: [[0, 1]], b: [[0, 1]] } },
        ...Array.from({ length: 8 }, (_, i) => ({ op: 'eq' as const, a: i + 1, b: i + 1 })),
        { op: 'add', b: 9 }
      ],
      blocks,
      blocks,
      new Set()
    )
    expect(rows.map((r) => r.kind)).toEqual(['row', 'row', 'gap', 'row', 'row'])
    const gap = rows[2]
    expect(gap.kind === 'gap' && gap.count).toBe(6)
    expect(rows.filter((r) => r.kind === 'row' && r.first)).toHaveLength(2)
  })
  it('expands', () => {
    const rows = blockRows(Array.from({ length: 9 }, (_, i) => ({ op: i === 0 ? ('add' as const) : ('eq' as const), a: i, b: i })), blocks, blocks, new Set(['b1']))
    expect(rows.some((r) => r.kind === 'gap')).toBe(false)
  })
})

describe('tableCells', () => {
  it('maps marks into cells', () => {
    const cells = tableCells('ab\tcd\nef\tgh', [[3, 4]])
    expect(cells[0][1]).toEqual([
      { text: 'c', marked: true },
      { text: 'd', marked: false }
    ])
    expect(cells[1][0]).toEqual([{ text: 'ef', marked: false }])
  })
})

describe('csvRows mirrors main parseCsv', () => {
  it('reads quotes, doubled quotes, embedded newlines and CRLF', () => {
    expect(csvRows('a,"b,c","d ""e"""\r\n1,2,3\n"x\ny",,')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
      ['x\ny', '', '']
    ])
    expect(csvRows('')).toEqual([])
    expect(gridOfCsv('﻿a,b')[0][0].v).toBe('a')
  })
})

describe('cells', () => {
  const c = (v: SheetCell['v']): SheetCell => ({ v })
  const a = [[c('Item'), c('Cost')], [c('x'), c(1200)], [c('gone'), c(1)], [c('z'), c(3)]]
  const b = [[c('Item'), c('Cost')], [c('x'), c(1350)], [c('z'), c(3)], [c('new'), c(9)]]
  const sheet = {
    name: 'S',
    status: 'changed' as const,
    changes: [{ r: 1, c: 1, op: 'chg' as const, was: 1200, now: 1350 }],
    rowOps: [{ r: 2, op: 'del' as const }, { r: 3, op: 'add' as const }]
  }
  it('puts removed rows back and marks changed cells', () => {
    const g = mergeGrid(sheet, a, b)
    expect(g.map((r) => r.op)).toEqual(['eq', 'eq', 'del', 'eq', 'add'])
    expect(g[1].cells[1]).toMatchObject({ text: '1,350', op: 'chg', was: '1,200' })
    expect(g[2].n).toBe(3)
    expect(g[4].n).toBe(4)
  })
  it('only changes keeps the header', () => {
    const g = mergeGrid(sheet, a, b)
    expect(visibleGridRows(g, true).map((r) => r.n)).toEqual([1, 2, 3, 4])
    expect(visibleGridRows(g, false)).toHaveLength(5)
    expect(gridChangeRows(g)).toEqual([1, 2, 4])
  })
  it('tolerates a cleared cell', () => {
    const g = mergeGrid({ ...sheet, changes: [{ r: 0, c: 1, op: 'del', was: 5 }], rowOps: [] }, [[c('a'), c(5)]], [[c('a'), c(null)]])
    expect(g[0].cells[1]).toMatchObject({ op: 'del', was: '5', text: '' })
  })
  it('words values', () => {
    expect(cellChangeText({ op: 'chg', was: 1200, now: 1350 })).toBe('was 1,200, now 1,350')
    expect(cellChangeText({ op: 'add', now: 'x' })).toBe('was empty, now x')
    expect(cellChangeText({ op: 'del', was: 'x' })).toBe('was x, now empty')
    expect(valueText(null)).toBe('')
    expect(valueText(true)).toBe('true')
  })
})
