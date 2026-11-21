import { describe, expect, it } from 'vitest'
import type { Segment } from './usageCharts'
import { areaPath, crosshairModel, edgePath, kindRuns, linePaths, moveIndex, nearestIndex, pointStep, pointXs, runExtent, seriesTotals, stackAreas, stackOrder } from './usageAreas'

const seg = (key: string, series: number, value: number, o: Partial<Segment> = {}): Segment => ({
  key,
  series,
  value,
  state: 'known',
  runs: 1,
  tokens: 100,
  cost: { costUsd: value, costSource: 'computed' },
  projects: 1,
  ...o
})

describe('pointXs and nearestIndex', () => {
  it('spreads points edge to edge and centres a single slot', () => {
    expect(pointXs(0, 10, 100)).toEqual([])
    expect(pointXs(1, 10, 100)).toEqual([60])
    expect(pointXs(5, 10, 100)).toEqual([10, 35, 60, 85, 110])
    expect(pointStep(5, 100)).toBe(25)
    expect(pointStep(1, 100)).toBe(100)
  })
  it('picks the nearest point and null well outside the plot', () => {
    expect(nearestIndex(10, 10, 100, 5)).toBe(0)
    expect(nearestIndex(22, 10, 100, 5)).toBe(0)
    expect(nearestIndex(23, 10, 100, 5)).toBe(1)
    expect(nearestIndex(110, 10, 100, 5)).toBe(4)
    expect(nearestIndex(121, 10, 100, 5)).toBe(4)
    expect(nearestIndex(123, 10, 100, 5)).toBeNull()
    expect(nearestIndex(-5, 10, 100, 5)).toBeNull()
    expect(nearestIndex(50, 10, 100, 0)).toBeNull()
    expect(nearestIndex(50, 10, 100, 1)).toBe(0)
    expect(nearestIndex(5, 10, 100, 1)).toBeNull()
  })
})

describe('moveIndex', () => {
  it('moves one slot, jumps to the ends and stops there', () => {
    expect(moveIndex(3, 'ArrowLeft', 10)).toBe(2)
    expect(moveIndex(3, 'ArrowRight', 10)).toBe(4)
    expect(moveIndex(0, 'ArrowLeft', 10)).toBe(0)
    expect(moveIndex(9, 'ArrowRight', 10)).toBe(9)
    expect(moveIndex(4, 'Home', 10)).toBe(0)
    expect(moveIndex(4, 'End', 10)).toBe(9)
  })
  it('ignores other keys and empty charts, and clamps a stale index', () => {
    expect(moveIndex(3, 'ArrowUp', 10)).toBeNull()
    expect(moveIndex(3, 'Enter', 10)).toBeNull()
    expect(moveIndex(0, 'End', 0)).toBeNull()
    expect(moveIndex(50, 'ArrowRight', 10)).toBe(9)
  })
})

describe('stackOrder', () => {
  it('puts the largest series at the bottom, ties by colour with Other last, and drops empty series', () => {
    expect(
      stackOrder([
        { key: 'a', series: 0, total: 2 },
        { key: 'b', series: 1, total: 9 },
        { key: 'other', series: -1, total: 2 },
        { key: 'c', series: 2, total: 0 }
      ])
    ).toEqual(['b', 'a', 'other'])
  })
  it('totals each series over the shown slots', () => {
    const t = seriesTotals([[seg('a', 0, 1), seg('b', 1, 4)], [seg('a', 0, 2)], []])
    expect(t.find((x) => x.key === 'a')?.total).toBe(3)
    expect(t.find((x) => x.key === 'b')?.total).toBe(4)
  })
})

describe('stackAreas', () => {
  const values = [new Map([['b', 10], ['a', 5]]), new Map([['b', 0], ['a', 0]]), new Map([['a', 0.0001]])]
  const bands = stackAreas(['b', 'a'], values, 20, 100, 200)
  it('stacks the first key from the baseline and the next on top of it', () => {
    expect(bands.get('b')!.bottom[0]).toBe(200)
    expect(bands.get('b')!.top[0]).toBe(150)
    expect(bands.get('a')!.bottom[0]).toBe(150)
    expect(bands.get('a')!.top[0]).toBe(125)
  })
  it('keeps zero as zero thickness and a tiny value at least the minimum', () => {
    expect(bands.get('b')!.top[1]).toBe(200)
    expect(bands.get('a')!.top[1]).toBe(200)
    expect(200 - bands.get('a')!.top[2]!).toBeCloseTo(1.5)
  })
})

describe('paths', () => {
  const band = { top: [10, 5], bottom: [20, 20] }
  it('closes the outline along the top then back along the bottom', () => {
    expect(areaPath([0, 100], band)).toBe('M0 10L100 5L100 20L0 20Z')
    expect(edgePath([0, 100], band)).toBe('M0 10L100 5')
  })
  it('gives a single slot width either side of its point', () => {
    expect(areaPath([50], { top: [10], bottom: [20] }, 5)).toBe('M45 10L55 10L55 20L45 20Z')
    expect(areaPath([], band)).toBe('')
  })
  it('breaks a line at a gap instead of dipping to zero, and draws a lone point as a dot', () => {
    expect(linePaths([0, 10, 20, 30, 40], [1, 2, null, 3, null])).toEqual(['M0 1L10 2', 'M30 3L30 3'])
    expect(linePaths([0, 10], [null, null])).toEqual([])
  })
})

describe('kindRuns and runExtent', () => {
  it('merges consecutive slots of one kind and keeps different kinds apart', () => {
    expect(kindRuns<'unknown' | 'not-loaded'>(['unknown', 'unknown', null, 'unknown', 'not-loaded', 'not-loaded'])).toEqual([
      { from: 0, to: 1, kind: 'unknown' },
      { from: 3, to: 3, kind: 'unknown' },
      { from: 4, to: 5, kind: 'not-loaded' }
    ])
    expect(kindRuns([null, null])).toEqual([])
  })
  it('extends half a step either side and stays inside the plot', () => {
    const xs = [10, 35, 60, 85, 110]
    expect(runExtent({ from: 1, to: 2 }, xs, 25, 10, 110)).toEqual({ x: 22.5, w: 50 })
    expect(runExtent({ from: 0, to: 0 }, xs, 25, 10, 110)).toEqual({ x: 10, w: 12.5 })
    expect(runExtent({ from: 4, to: 4 }, xs, 25, 10, 110)).toEqual({ x: 97.5, w: 12.5 })
  })
})

describe('crosshairModel', () => {
  const base = {
    label: 'Tue 3 Nov',
    metric: 'cost' as const,
    notLoaded: false,
    hasPoint: true,
    runs: 3,
    runsLine: '3 runs, 1 unpriced',
    hiddenSeries: false,
    order: ['a', 'b'],
    name: (k: string) => (k === 'a' ? 'Billing' : k === 'b' ? 'Docs' : 'Notes'),
    clip: (n: string) => n,
    previous: null
  }
  it('lists the top of the stack first, the total and the runs', () => {
    const m = crosshairModel({ ...base, segments: [seg('a', 0, 6.1), seg('b', 1, 3.7)] })
    expect(m.rows.map((r) => r.key)).toEqual(['b', 'a'])
    expect(m.total).toBe('$9.80')
    expect(m.runs).toBe('3 runs, 1 unpriced')
    expect(m.text).toBe('Tue 3 Nov: $9.80, 3 runs, 1 unpriced. Docs $3.70, Billing $6.10.')
  })
  it('says Not priced for unknown cost, never $0, and a lower bound keeps its plus', () => {
    const unknown = seg('c', 2, 0, { state: 'unknown', cost: { costUsd: null, costSource: 'unknown' } })
    const partial = seg('a', 0, 0.42, { state: 'partial', cost: { costUsd: 0.42, costSource: 'computed', costPartial: true } })
    const m = crosshairModel({ ...base, order: ['a'], segments: [partial, unknown] })
    expect(m.rows.map((r) => [r.key, r.value])).toEqual([
      ['a', '$0.420+'],
      ['c', 'Not priced']
    ])
    expect(m.text).toContain('Notes Not priced')
    expect(m.text).not.toMatch(/\$0(\.00)?[^.\d]/)
    const only = crosshairModel({ ...base, order: [], segments: [unknown] })
    expect(only.total).toBe('Not priced')
  })
  it('reads tokens and runs with their units', () => {
    const t = crosshairModel({ ...base, metric: 'tokens', runsLine: '2 runs', segments: [seg('a', 0, 12000)] })
    expect(t.rows[0]!.value).toBe('12k')
    expect(t.text).toBe('Tue 3 Nov: 12k tokens, 2 runs. Billing 12k tokens.')
    const r = crosshairModel({ ...base, metric: 'runs', runsLine: '5 runs', segments: [seg('a', 0, 3), seg('b', 1, 2)] })
    expect(r.text).toBe('Tue 3 Nov: 5 runs. Docs 2 runs, Billing 3 runs.')
  })
  it('explains empty, hidden and not loaded slots and adds the previous period', () => {
    expect(crosshairModel({ ...base, runs: 0, hasPoint: false, segments: [] })).toMatchObject({ note: 'No runs', text: 'Tue 3 Nov: no runs.' })
    expect(crosshairModel({ ...base, runs: 0, hiddenSeries: true, segments: [] }).note).toBe('Nothing in the series shown')
    expect(crosshairModel({ ...base, notLoaded: true, segments: [] }).text).toBe('Tue 3 Nov: not loaded.')
    expect(crosshairModel({ ...base, runs: 0, hasPoint: false, segments: [], previous: '$4.20' }).text).toBe('Tue 3 Nov: no runs. Previous: $4.20.')
  })
})
