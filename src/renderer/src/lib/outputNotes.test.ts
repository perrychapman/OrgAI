import { describe, expect, it } from 'vitest'
import type { DocumentBlock, OutputNote, OutputNoteAnchor } from '@shared/types'
import {
  anchorDescription,
  blockPartOffsets,
  blockText,
  boxFromPoints,
  boxesIntersect,
  cellName,
  cellsAnchor,
  cellsDescription,
  cleanLabels,
  countsLine,
  defaultBox,
  filterNotes,
  findQuote,
  isDeliberate,
  mapEndByNonWhitespace,
  mapRenderedToSource,
  mapStartByNonWhitespace,
  markStatus,
  moveBox,
  noteHint,
  noteStamp,
  noteStyleOf,
  noteTextProblem,
  normalizeRange,
  pinNumbers,
  regionAnchor,
  resizeBox,
  reviseLabel,
  segmentsOf,
  stepFractions,
  textAnchorRange,
  textRanges,
  visibleFraction
} from './outputNotes'

const note = (id: string, version: number, status: OutputNote['status'], anchor: OutputNoteAnchor = { type: 'whole' }): OutputNote => ({ id, outputId: 'o', version, anchor, text: 't', status, createdAt: 1 })

describe('anchors', () => {
  it('names cells and ranges', () => {
    expect(cellName(0, 0)).toBe('A1')
    expect(cellName(1, 27)).toBe('AB2')
    const g = normalizeRange({ r: 3, c: 2 }, { r: 1, c: 1 })
    expect(g).toEqual({ r1: 1, c1: 1, r2: 3, c2: 2 })
    expect(cellsDescription('Budget', g)).toBe('Cells B2:C4 on Budget')
    expect(cellsDescription('', { r1: 0, c1: 0, r2: 0, c2: 0 })).toBe('Cell A1')
  })
  it('describes every anchor type', () => {
    expect(anchorDescription({ type: 'region', slide: 3, shape: 'box', x: 0, y: 0, w: 0.1, h: 0.1 })).toBe('Slide 3, box')
    expect(anchorDescription({ type: 'region', shape: 'ellipse', x: 0, y: 0, w: 0.1, h: 0.1 })).toBe('Marked circle')
    expect(anchorDescription({ type: 'slide', slide: 2 })).toBe('Slide 2')
    expect(anchorDescription({ type: 'whole' })).toBe('Whole output')
    expect(anchorDescription({ type: 'text', start: 0, end: 3, quote: 'x'.repeat(100) })).toMatch(/^“x{59}…”$/)
  })
  it('cuts a cell quote to 80', () => {
    const a = cellsAnchor('', { r1: 0, c1: 0, r2: 0, c2: 0 }, 'y'.repeat(200))
    expect(a.type === 'cells' && a.quote?.length).toBe(80)
  })
  it('hints per kind', () => {
    expect(noteHint('markdown')).toBe('Select text to add a note.')
    expect(noteHint('xlsx')).toBe('Select cells to add a note.')
    expect(noteHint('pptx')).toBe('Mark an area to add a note.')
    expect(noteStyleOf('pdf')).toBe('none')
  })
})

describe('mark ranges', () => {
  it('clamps and drops empty ranges', () => {
    const notes = [note('a', 1, 'open', { type: 'text', start: -5, end: 4, quote: '' }), note('b', 1, 'open', { type: 'text', start: 8, end: 99, quote: '' }), note('c', 1, 'open', { type: 'text', start: 6, end: 6, quote: '' }), note('d', 1, 'open')]
    const r = textRanges(notes, 10, textAnchorRange)
    expect(r.map((x) => [x.id, x.start, x.end])).toEqual([
      ['a', 0, 4],
      ['b', 8, 10]
    ])
  })
  it('segments overlaps and ranks open first', () => {
    const ranges = [
      { start: 0, end: 6, id: 'a', status: 'resolved' as const },
      { start: 3, end: 9, id: 'b', status: 'open' as const }
    ]
    const s = segmentsOf(10, ranges)
    expect(s.map((x) => [x.start, x.end, x.notes.map((n) => n.id).join('')])).toEqual([
      [0, 3, 'a'],
      [3, 6, 'ba'],
      [6, 9, 'b'],
      [9, 10, '']
    ])
    expect(markStatus(s[1].notes)).toBe('open')
    expect(markStatus(s[0].notes)).toBe('resolved')
  })
})

describe('json offsets', () => {
  const raw = '{"a":1,"b":[2,3]}'
  const pretty = JSON.stringify(JSON.parse(raw), null, 2)
  it('maps both ways', () => {
    const at = pretty.indexOf('"b"')
    const start = mapStartByNonWhitespace(pretty, raw, at)
    expect(raw.slice(start, start + 3)).toBe('"b"')
    const endAt = pretty.indexOf('3') + 1
    expect(raw.slice(0, mapEndByNonWhitespace(pretty, raw, endAt)).endsWith('3')).toBe(true)
    const back = mapStartByNonWhitespace(raw, pretty, raw.indexOf('"b"'))
    expect(pretty.slice(back, back + 3)).toBe('"b"')
  })
})

describe('markdown mapping', () => {
  const src = '# Title\n\nThe **plan** is simple.\n\nSecond paragraph here.\n'
  it('maps plain prose exactly', () => {
    const r = mapRenderedToSource(src, 'Second paragraph')
    expect(src.slice(r!.start, r!.end)).toBe('Second paragraph')
  })
  it('falls back to the enclosing paragraph with markup', () => {
    const r = mapRenderedToSource(src, 'The plan is simple.')
    expect(src.slice(r!.start, r!.end)).toBe('The **plan** is simple.')
  })
  it('gives up on text not in the source', () => {
    expect(mapRenderedToSource(src, 'nothing like it')).toBeNull()
    expect(mapRenderedToSource(src, '   ')).toBeNull()
  })
  it('finds a quote in rendered text across whitespace', () => {
    expect(findQuote('a  b\nc d', 'b c')).toEqual({ start: 3, end: 6 })
  })
})

describe('blockText twin', () => {
  const run = (text: string) => ({ text })
  const list: DocumentBlock = { type: 'list', ordered: false, items: [[run('one')], [run('two'), run('!')]] }
  const table: DocumentBlock = { type: 'table', rows: [[[run('a')], [run('bb')]], [[run('c')], [run('d')]]] }
  it('joins like main does', () => {
    expect(blockText(list)).toBe('one\ntwo!')
    expect(blockText(table)).toBe('a\tbb\nc\td')
    expect(blockText({ type: 'image', dataUrl: '', alt: 'x' })).toBe('[image: x]')
    expect(blockText({ type: 'rule' })).toBe('---')
    expect(blockText({ type: 'pageBreak' })).toBe('[page break]')
  })
  it('offsets parts inside the block text', () => {
    expect(blockPartOffsets(list)).toEqual([0, 4])
    const t = blockText(table)
    expect(blockPartOffsets(table).map((o) => t[o])).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('regions', () => {
  it('draws from two points, clamped', () => {
    expect(boxFromPoints({ x: 0.5, y: 0.5 }, { x: 0.2, y: 1.4 })).toEqual({ x: 0.2, y: 0.5, w: 0.3, h: 0.5 })
    expect(isDeliberate({ x: 0, y: 0, w: 0.005, h: 0.5 })).toBe(false)
  })
  it('places a centred 20% box in the visible area', () => {
    const b = defaultBox({ x: 0.5, y: 0, w: 0.5, h: 1 })
    expect(b.w).toBeCloseTo(0.1)
    expect(b.h).toBeCloseTo(0.2)
    expect(b.x).toBeCloseTo(0.7)
    expect(b.y).toBeCloseTo(0.4)
  })
  it('moves and resizes inside the drawing', () => {
    expect(moveBox({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, 0.5, 0.5)).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 })
    expect(resizeBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, -1, 0).w).toBe(0.01)
    const s = stepFractions({ x: 0, y: 0, w: 1, h: 0.5 }, 800, 400)
    expect(s.dx).toBeCloseTo(0.01)
    expect(s.dy).toBeCloseTo(0.01)
  })
  it('intersects boxes', () => {
    expect(boxesIntersect({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe(true)
    expect(boxesIntersect({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toBe(false)
  })
  it('limits labels to 20 x 80 and dedupes', () => {
    const many = Array.from({ length: 30 }, (_, i) => `label ${i}`)
    expect(cleanLabels(many)).toHaveLength(20)
    expect(cleanLabels(['a', 'a', ' ', 'z'.repeat(200)]).map((l) => l.length)).toEqual([1, 80])
    const a = regionAnchor('box', { x: 0, y: 0, w: 1, h: 1 }, 2, ['x'])
    expect(a).toMatchObject({ type: 'region', slide: 2, labels: ['x'] })
    expect('labels' in regionAnchor('box', { x: 0, y: 0, w: 1, h: 1 }, undefined)).toBe(false)
  })
  it('reads the visible fraction from the view', () => {
    const v = visibleFraction({ k: 2, x: -200, y: 0 }, { w: 400, h: 300 }, { w: 800, h: 600 })
    expect(v.x).toBeCloseTo(0.125)
    expect(v.w).toBeCloseTo(0.25)
    expect(v.h).toBeCloseTo(0.25)
  })
})

describe('panel', () => {
  const notes = [note('a', 1, 'open'), note('b', 2, 'open'), note('c', 1, 'resolved'), note('d', 1, 'sent')]
  it('numbers pins in list order per version', () => {
    expect([...pinNumbers(notes, 1)]).toEqual([
      ['a', 1],
      ['c', 2],
      ['d', 3]
    ])
  })
  it('counts and filters; sent counts as open', () => {
    expect(countsLine(notes.filter((n) => n.version === 1))).toBe('2 open, 1 resolved')
    expect(countsLine([])).toBe('No notes')
    expect(filterNotes(notes, 'open').map((n) => n.id)).toEqual(['a', 'b', 'd'])
    expect(filterNotes(notes, 'resolved').map((n) => n.id)).toEqual(['c'])
    expect(filterNotes(notes, 'all')).toHaveLength(4)
  })
  it('words the revise button', () => {
    expect(reviseLabel(0)).toBe('Revise with these notes')
    expect(reviseLabel(1)).toBe('Revise with 1 note')
    expect(reviseLabel(3)).toBe('Revise with 3 notes')
  })
  it('stamps a date without the year this year', () => {
    const now = new Date(2026, 10, 7, 12).getTime()
    expect(noteStamp(new Date(2026, 10, 7, 11, 4).getTime(), now)).toBe('7 Nov 11:04')
    expect(noteStamp(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe('2 Jan 2025 09:05')
  })
})

describe('composer text', () => {
  it('refuses hidden characters and over-long text, allows line breaks', () => {
    expect(noteTextProblem('fine\nline')).toBeNull()
    expect(noteTextProblem('bad​text')).toMatch(/hidden/)
    expect(noteTextProblem('x'.repeat(2001))).toMatch(/2,000/)
    expect(noteTextProblem('')).toBeNull()
  })
})
