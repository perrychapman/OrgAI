import { describe, expect, it } from 'vitest'
import type { RunOutput } from '@shared/types'
import { countLine, dayGroups, dayLabel, filterOutputs, idAfterRemoval, isOutputsFilterActive, kindCounts, matchesQuery, newOutputIds, producedText, resolveOutputFocus, runOptions, titleTypeAhead, EMPTY_OUTPUTS_FILTER } from './outputsList'

const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime()
const day = (d: number, h = 10): number => new Date(2026, 10, d, h, 0, 0).getTime()

function out(id: string, over: Partial<RunOutput> = {}): RunOutput {
  return { id, projectId: 'p', runId: 'r1', kind: 'docx', title: `Title ${id}`, fileName: `${id}.docx`, path: `/p/outputs/${id}.docx`, relPath: `outputs/${id}.docx`, bytes: 10, createdAt: day(7), source: 'produced', ...over }
}

describe('filter', () => {
  const list = [
    out('a', { title: 'Project plan', role: 'Analyst', kind: 'docx' }),
    out('b', { title: 'Budget', fileName: 'Budget.xlsx', relPath: 'outputs/Budget.xlsx', kind: 'xlsx', runId: 'r2' }),
    out('c', { title: 'Logo', kind: 'image', runId: 'r2', source: 'registered' })
  ]
  it('is inactive when empty and passes everything', () => {
    expect(isOutputsFilterActive(EMPTY_OUTPUTS_FILTER)).toBe(false)
    expect(filterOutputs(list, EMPTY_OUTPUTS_FILTER)).toHaveLength(3)
  })
  it('searches title, file name, path and role, case-insensitively', () => {
    expect(matchesQuery(list[0], 'PLAN')).toBe(true)
    expect(matchesQuery(list[0], 'analyst')).toBe(true)
    expect(matchesQuery(list[1], 'budget.xlsx')).toBe(true)
    expect(matchesQuery(list[1], 'outputs/bud')).toBe(true)
    expect(matchesQuery(list[1], 'zzz')).toBe(false)
    // the app's words and the extension
    expect(matchesQuery(list[0], 'word')).toBe(true)
    expect(matchesQuery(list[1], 'excel')).toBe(true)
    expect(matchesQuery(list[1], 'xlsx')).toBe(true)
    expect(matchesQuery(list[0], 'excel')).toBe(false)
    expect(matchesQuery(list[1], '   ')).toBe(true)
  })
  it('ORs kinds and ANDs the run', () => {
    expect(filterOutputs(list, { query: '', kinds: ['docx', 'image'], runId: '' }).map((o) => o.id)).toEqual(['a', 'c'])
    expect(filterOutputs(list, { query: '', kinds: ['docx', 'image'], runId: 'r2' }).map((o) => o.id)).toEqual(['c'])
  })
  it('counts kinds in use over search and run but not over kinds', () => {
    const counts = kindCounts(list, { query: '', kinds: ['docx'], runId: 'r2' })
    expect(counts.map((c) => [c.kind, c.count]).sort()).toEqual([
      ['docx', 0],
      ['image', 1],
      ['xlsx', 1]
    ])
    expect(counts.find((c) => c.kind === 'xlsx')?.label).toBe('Excel')
    expect(counts.find((c) => c.kind === 'docx')?.label).toBe('Word')
    expect(counts.find((c) => c.kind === 'image')?.label).toBe('Image')
  })
})

describe('runOptions', () => {
  it('lists only runs with outputs, newest first, tagged', () => {
    const list = [out('a', { runId: 'r1' }), out('b', { runId: 'r3' }), out('c', { runId: 'r3' })]
    const opts = runOptions(
      list,
      new Map([
        ['r1', 1],
        ['r2', 2],
        ['r3', 3]
      ]),
      new Map([
        ['r1', 'Plan it'],
        ['r3', 'Build it']
      ])
    )
    expect(opts).toEqual([
      { value: 'r3', label: 'R3 · Build it' },
      { value: 'r1', label: 'R1 · Plan it' }
    ])
  })
  it('falls back to the tag alone', () => {
    expect(runOptions([out('a')], new Map(), new Map())).toEqual([{ value: 'r1', label: 'R?' }])
  })
})

describe('day groups', () => {
  it('labels Today, Yesterday and dates', () => {
    expect(dayLabel(day(7, 1), NOW)).toBe('Today')
    expect(dayLabel(day(6, 23), NOW)).toBe('Yesterday')
    expect(dayLabel(day(4), NOW)).toBe('4 Nov 2026')
  })
  it('groups consecutive rows by local day and keeps order', () => {
    const groups = dayGroups([out('a', { createdAt: day(7, 11) }), out('b', { createdAt: day(7, 9) }), out('c', { createdAt: day(6) }), out('d', { createdAt: day(1) })], NOW)
    expect(groups.map((g) => [g.label, g.items.map((o) => o.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['1 Nov 2026', ['d']]
    ])
  })
})

describe('text', () => {
  it('count line', () => {
    expect(countLine(12, 12)).toBe('12 outputs')
    expect(countLine(5, 12)).toBe('5 of 12 outputs')
    expect(countLine(1, 1)).toBe('1 output')
  })
  it('produced text', () => {
    expect(producedText(2)).toBe('Agents produced 2 outputs')
    expect(producedText(1)).toBe('Agents produced 1 output')
  })
})

describe('navigation', () => {
  const rows = [out('a', { title: 'Summary' }), out('b', { title: 'Budget' }), out('c', { title: 'Brief' })]
  it('type-ahead by title', () => {
    expect(titleTypeAhead(rows, 0, 'b')).toBe(1)
    expect(titleTypeAhead(rows, 1, 'b')).toBe(2)
    expect(titleTypeAhead(rows, 0, 'bri')).toBe(2)
    expect(titleTypeAhead(rows, 0, 'x')).toBe(-1)
  })
  it('selection after a removal', () => {
    expect(idAfterRemoval(rows, 'b')).toBe('c')
    expect(idAfterRemoval(rows, 'c')).toBe('b')
    expect(idAfterRemoval([rows[0]], 'a')).toBeNull()
    expect(idAfterRemoval(rows, 'zz')).toBeNull()
  })
  it('resolves a focus request', () => {
    expect(resolveOutputFocus(rows, 'b')?.id).toBe('b')
    expect(resolveOutputFocus(rows, 'zz')).toBeNull()
    expect(resolveOutputFocus(rows, undefined)).toBeNull()
  })
  it('finds arrivals', () => {
    expect(newOutputIds([rows[0]], rows)).toEqual(['b', 'c'])
  })
})
