import { describe, expect, it } from 'vitest'
import type { RunOutput } from '@shared/types'
import {
  EMPTY_OUTPUTS_FILTER,
  OUTPUTS_PAGE,
  countLine,
  dayLabel,
  filterOutputs,
  groupByDay,
  idAfterRemoval,
  isFilterActive,
  kindCounts,
  matchesQuery,
  newOutputIds,
  producedText,
  runOptionLabel,
  runOptions,
  statusText,
  typeAheadMatch
} from './outputsList'

const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime()
const out = (id: string, over: Partial<RunOutput> = {}): RunOutput => ({
  id,
  projectId: 'p',
  runId: 'r1',
  kind: 'docx',
  title: `Title ${id}`,
  fileName: `${id}.docx`,
  path: `/p/outputs/${id}.docx`,
  relPath: `outputs/${id}.docx`,
  bytes: 10,
  createdAt: NOW,
  source: 'produced',
  ...over
})

describe('filter and search', () => {
  const list = [out('a', { title: 'Project plan', role: 'Analyst' }), out('b', { kind: 'xlsx', fileName: 'budget.xlsx', relPath: 'outputs/q4/budget.xlsx', runId: 'r2' }), out('c', { kind: 'mermaid', title: 'Flow' })]
  it('matches title, file name, relPath and role, every word', () => {
    expect(matchesQuery(list[0], 'plan analyst')).toBe(true)
    expect(matchesQuery(list[1], 'Q4')).toBe(true)
    expect(matchesQuery(list[1], 'budget.xlsx')).toBe(true)
    expect(matchesQuery(list[0], 'nothing')).toBe(false)
    expect(matchesQuery(list[0], '   ')).toBe(true)
  })
  it('combines kind, run and query', () => {
    expect(filterOutputs(list, EMPTY_OUTPUTS_FILTER)).toHaveLength(3)
    expect(filterOutputs(list, { query: '', kinds: ['xlsx', 'mermaid'], runId: '' }).map((o) => o.id)).toEqual(['b', 'c'])
    expect(filterOutputs(list, { query: '', kinds: [], runId: 'r2' }).map((o) => o.id)).toEqual(['b'])
    expect(filterOutputs(list, { query: 'flow', kinds: ['docx'], runId: '' })).toHaveLength(0)
  })
  it('knows when a filter is active', () => {
    expect(isFilterActive(EMPTY_OUTPUTS_FILTER)).toBe(false)
    expect(isFilterActive({ ...EMPTY_OUTPUTS_FILTER, query: ' x ' })).toBe(true)
    expect(isFilterActive({ ...EMPTY_OUTPUTS_FILTER, query: '  ' })).toBe(false)
    expect(isFilterActive({ ...EMPTY_OUTPUTS_FILTER, runId: 'r' })).toBe(true)
  })
  it('counts kinds in use only, in contract order', () => {
    expect(kindCounts(list)).toEqual([
      { kind: 'docx', label: 'Documents', count: 1 },
      { kind: 'xlsx', label: 'Spreadsheets', count: 1 },
      { kind: 'mermaid', label: 'Diagrams', count: 1 }
    ])
    expect(kindCounts([])).toEqual([])
  })
})

describe('day groups', () => {
  it('labels Today, Yesterday and a date', () => {
    expect(dayLabel(NOW - 3600_000, NOW)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 6, 23, 0).getTime(), NOW)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 4, 9, 0).getTime(), NOW)).toBe('4 Nov 2026')
  })
  it('groups newest first and caps the rows', () => {
    const day = (d: number, h = 10): number => new Date(2026, 10, d, h).getTime()
    const list = [out('old', { createdAt: day(4) }), out('t1', { createdAt: day(7, 9) }), out('t2', { createdAt: day(7, 11) }), out('y', { createdAt: day(6) })]
    const g = groupByDay(list, NOW)
    expect(g.groups.map((x) => x.label)).toEqual(['Today', 'Yesterday', '4 Nov 2026'])
    expect(g.groups[0].items.map((o) => o.id)).toEqual(['t2', 't1'])
    expect(g.shown).toBe(4)
    expect(g.hidden).toBe(0)
    const capped = groupByDay(list, NOW, 2)
    expect(capped.shown).toBe(2)
    expect(capped.hidden).toBe(2)
  })
  it('pages at 300', () => {
    const many = Array.from({ length: 450 }, (_, i) => out(`o${i}`, { createdAt: NOW - i * 1000 }))
    const g = groupByDay(many, NOW)
    expect(g.shown).toBe(OUTPUTS_PAGE)
    expect(g.hidden).toBe(150)
  })
})

describe('text', () => {
  it('writes the count line and status', () => {
    expect(countLine(5, 12, true)).toBe('5 of 12 outputs')
    expect(countLine(1, 1, true)).toBe('1 of 1 output')
    expect(countLine(12, 12, false)).toBe('12 outputs')
    expect(statusText(0, 0, false)).toBe('No outputs yet.')
    expect(statusText(0, 4, true)).toBe('No outputs match. 0 of 4 outputs.')
    expect(statusText(5, 12, true)).toBe('5 of 12 outputs.')
    expect(producedText(2)).toBe('Agents produced 2 outputs')
    expect(producedText(1)).toBe('Agents produced 1 output')
  })
  it('finds new ids after the first load only', () => {
    const list = [out('a'), out('b')]
    expect(newOutputIds(null, list)).toEqual([])
    expect(newOutputIds(new Set(['a']), list)).toEqual(['b'])
  })
})

describe('focus and type-ahead', () => {
  it('moves to the next row, else the previous, else nothing', () => {
    expect(idAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(idAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(idAfterRemoval(['a'], 'a')).toBeNull()
    expect(idAfterRemoval(['a'], 'z')).toBeNull()
  })
  it('matches titles by prefix and cycles one letter', () => {
    const names = ['Budget', 'Brief', 'Plan']
    expect(typeAheadMatch(names, 0, 'b')).toBe(1)
    expect(typeAheadMatch(names, 0, 'bud')).toBe(0)
    expect(typeAheadMatch(names, 0, 'p')).toBe(2)
    expect(typeAheadMatch(names, 0, 'z')).toBe(-1)
  })
})

describe('run options', () => {
  it('lists runs with outputs, newest output first, after All runs', () => {
    const list = [out('a', { runId: 'r1', createdAt: 100 }), out('b', { runId: 'r2', createdAt: 300 }), out('c', { runId: 'r1', createdAt: 200 }), out('d', { runId: 'gone', createdAt: 50 })]
    const labels: Record<string, string> = { r1: 'R1 · Plan', r2: 'R2 · Budget' }
    expect(runOptions(list, (id) => labels[id])).toEqual([
      { value: '', label: 'All runs' },
      { value: 'r2', label: 'R2 · Budget' },
      { value: 'r1', label: 'R1 · Plan' },
      { value: 'gone', label: 'Earlier run' }
    ])
    expect(runOptionLabel('R3', 'Add caching')).toBe('R3 · Add caching')
    expect(runOptionLabel('R3', '')).toBe('R3')
  })
})
