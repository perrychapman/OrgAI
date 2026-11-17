import { describe, expect, it } from 'vitest'
import type { UsageOverviewTrendPoint, UsageTrendProjectSlice } from '@shared/types'
import { OTHER_KEY, formatTick, readoutText, segmentReadout, segmentsOf, type BucketSlot } from './usageCharts'
import {
  alignPrevious,
  ariaSort,
  deltaDirection,
  metricAnnouncement,
  nextSort,
  overlayFigure,
  overlayMax,
  overlayReadout,
  resolveMetric,
  seriesAnnouncement,
  shortDelta,
  sortAnnouncement,
  sortRows,
  sparkSeries,
  sparkShape,
  sparkSignal,
  toggleSeries,
  visibleSegments
} from './usageDashboard'

const T = (n: number, cacheRead = 0) => ({ input: n, output: 0, cacheRead, cacheWrite: 0 })
const slice = (projectId: string, costUsd: number | null, o: Partial<UsageTrendProjectSlice> = {}): UsageTrendProjectSlice => ({
  projectId, runs: 1, tokens: T(100), costUsd, wallMs: 0, waitingMs: 0, costKnownRuns: costUsd === null ? 0 : 1, costUnknownRuns: costUsd === null ? 1 : 0, ...o
})
const point = (o: Partial<UsageOverviewTrendPoint> = {}): UsageOverviewTrendPoint =>
  ({ bucket: '', start: 0, runs: 1, tokens: T(100), costUsd: 1, costUnknownRuns: 0, costKnownRuns: 1, turns: 0, toolCalls: 0, nudges: 0, retries: 0, wallMs: 1000, waitingMs: 0, noResultTokens: 0, byProject: [], ...o }) as UsageOverviewTrendPoint
const slot = (p: UsageOverviewTrendPoint | null, i = 0): BucketSlot => ({ start: i, key: String(i), point: p })

describe('metric switch', () => {
  it('defaults to cost, to tokens when nothing is priced, and keeps a choice', () => {
    expect(resolveMetric(null, false)).toBe('cost')
    expect(resolveMetric(null, true)).toBe('tokens')
    expect(resolveMetric('runs', true)).toBe('runs')
    expect(metricAnnouncement('runs')).toBe('Chart shows runs.')
  })
  it('stacks runs by project with runs readouts', () => {
    const segs = segmentsOf([slice('a', 2, { runs: 3 }), slice('b', null, { runs: 1 })], new Map([['a', 0], ['b', 1]]), 'runs')
    expect(segs.map((s) => [s.key, s.value, s.state])).toEqual([['a', 3, 'known'], ['b', 1, 'known']])
    expect(readoutText('Tue 3 Nov', { runs: 4, cost: { costUsd: 2, costSource: 'computed' }, tokens: 0 }, segs, (k) => k, 'runs')).toBe('Tue 3 Nov: 4 runs. a 3 runs, b 1 run.')
    expect(segmentReadout('Tue 3 Nov', 'a', segs[0]!, 'runs')).toBe('Tue 3 Nov, a: 3 runs.')
    expect(formatTick(0, 'runs')).toBe('0')
    expect(formatTick(2.5, 'runs')).toBe('2.5')
    expect(formatTick(1500, 'runs')).toBe('1.5k')
  })
})

describe('deltaDirection', () => {
  it('reads the sentence the summary model writes', () => {
    expect(deltaDirection('up 12% on the previous 30 days')).toBe('up')
    expect(deltaDirection('down 3 points on the previous 30 days')).toBe('down')
    expect(deltaDirection('about the same as the previous 30 days')).toBe('same')
    expect(deltaDirection(null)).toBeNull()
  })
  it('shortens to one line for the band', () => {
    expect(shortDelta('up 400% on the previous 30 days')).toBe('400% vs previous 30 days')
    expect(shortDelta('down 3 points on the previous 7 days')).toBe('3 points vs previous 7 days')
    expect(shortDelta('about the same as the previous 30 days')).toBe('same as previous 30 days')
    expect(shortDelta('up 5% on last month')).toBe('5% vs last month')
    expect(shortDelta('something else')).toBe('something else')
  })
})

describe('sparklines', () => {
  it('has no sparkline for cost per run (a median has no per-bucket figure)', () => {
    expect(sparkSignal('cost-per-run')).toBeNull()
    expect(sparkSignal('cache')).toBe('cache')
  })
  it('keeps unknown cost distinct from zero and empty buckets at zero', () => {
    const s = sparkSeries([slot(point({ costUsd: 2 })), slot(point({ costUsd: null, costUnknownRuns: 1 })), slot(null), slot(point({ costUsd: 1, costUnknownRuns: 1 }))], 'cost')
    expect(s).toEqual([
      { value: 2, kind: 'known' },
      { value: null, kind: 'unknown' },
      { value: 0, kind: 'empty' },
      { value: 1, kind: 'partial' }
    ])
  })
  it('reads runs, tokens, wall time and cache (not reported is a gap, never 0%)', () => {
    const slots = [slot(point({ runs: 2, tokens: T(300, 100), wallMs: 5 })), slot(point({ tokens: T(50) })), slot(null)]
    expect(sparkSeries(slots, 'runs').map((p) => p.value)).toEqual([2, 1, 0])
    expect(sparkSeries(slots, 'tokens').map((p) => p.value)).toEqual([400, 50, 0])
    expect(sparkSeries(slots, 'wall').map((p) => p.value)).toEqual([5, 1000, 0])
    expect(sparkSeries(slots, 'cache')).toEqual([{ value: 0.25, kind: 'known' }, { value: null, kind: 'gap' }, { value: null, kind: 'empty' }])
  })
  it('draws nothing for fewer than two values', () => {
    expect(sparkShape([{ value: 3, kind: 'known' }], 80, 20)).toBeNull()
    expect(sparkShape([{ value: 3, kind: 'known' }, { value: null, kind: 'gap' }], 80, 20)).toBeNull()
  })
  it('splits the line at gaps, marks unknown with a hollow dot on the baseline and lifts small values 2 px', () => {
    const sh = sparkShape(
      [
        { value: 100, kind: 'known' },
        { value: 0.01, kind: 'partial' },
        { value: null, kind: 'unknown' },
        { value: 0, kind: 'empty' },
        { value: 50, kind: 'known' }
      ],
      82,
      20,
      1
    )!
    expect(sh.lines).toEqual(['1,1 21,17', '61,19 81,10'])
    expect(sh.hollow).toEqual([{ x: 41, y: 19 }])
    expect(sh.partial).toEqual([{ x: 21, y: 17 }])
    expect(sh.last).toEqual({ x: 81, y: 10 })
  })
})

describe('legend toggles', () => {
  const keys = ['a', 'b', OTHER_KEY]
  it('hides and shows a series, never the last visible one', () => {
    let r = toggleSeries(new Set(), 'a', keys)
    expect([...r.hidden]).toEqual(['a'])
    r = toggleSeries(r.hidden, 'b', keys)
    expect([...r.hidden].sort()).toEqual(['a', 'b'])
    const refused = toggleSeries(r.hidden, OTHER_KEY, keys)
    expect(refused.refused).toBe(true)
    expect(refused.hidden.has(OTHER_KEY)).toBe(false)
    expect(toggleSeries(r.hidden, 'a', keys).hidden.has('a')).toBe(false)
  })
  it('drops hidden keys that left the legend', () => {
    expect([...toggleSeries(new Set(['gone']), 'a', keys).hidden]).toEqual(['a'])
  })
  it('filters segments and words the announcement', () => {
    const segs = segmentsOf([slice('a', 1), slice('b', 2)], new Map([['a', 0], ['b', 1]]), 'cost')
    expect(visibleSegments(segs, new Set(['a'])).map((s) => s.key)).toEqual(['b'])
    expect(seriesAnnouncement('Billing', true)).toBe('Billing hidden from the chart.')
    expect(seriesAnnouncement('Billing', false)).toBe('Billing shown on the chart.')
    expect(seriesAnnouncement('Billing', false, true)).toMatch(/at least one series/)
  })
})

describe('previous-period overlay', () => {
  const series = new Map([['a', 0], ['b', 1]])
  it('aligns by position and pads with null', () => {
    const cur = [slot(null, 10), slot(null, 11), slot(null, 12)]
    const prev = [slot(point(), 0), slot(null, 1)]
    const al = alignPrevious(cur, prev)
    expect(al.map((s) => s?.start ?? null)).toEqual([0, 1, null])
  })
  it('totals the visible series under the metric and keeps unknown cost unknown', () => {
    const p = point({ byProject: [slice('a', 2, { runs: 2 }), slice('b', null, { runs: 1 })] })
    expect(overlayFigure(slot(p), series, 'cost', new Set())).toEqual({ value: 2, state: 'partial', runs: 3 })
    expect(overlayFigure(slot(p), series, 'cost', new Set(['b']))).toEqual({ value: 2, state: 'known', runs: 2 })
    expect(overlayFigure(slot(p), series, 'cost', new Set(['a']))).toEqual({ value: 0, state: 'unknown', runs: 1 })
    expect(overlayFigure(slot(p), series, 'runs', new Set())).toEqual({ value: 3, state: 'known', runs: 3 })
    expect(overlayFigure(null, series, 'cost', new Set())).toEqual({ value: 0, state: 'empty', runs: 0 })
    expect(overlayMax([{ value: 2, state: 'known', runs: 1 }, { value: 5, state: 'partial', runs: 1 }])).toBe(5)
  })
  it('words the readout without a made-up zero', () => {
    expect(overlayReadout({ value: 0, state: 'unknown', runs: 1 }, 'cost', '$0.00')).toBe('Previous period: cost unknown.')
    expect(overlayReadout({ value: 0, state: 'empty', runs: 0 }, 'cost', '')).toBe('Previous period: no runs.')
    expect(overlayReadout({ value: 2, state: 'partial', runs: 2 }, 'cost', '$2.00+')).toBe('Previous period: $2.00+.')
    expect(overlayReadout({ value: 2, state: 'known', runs: 1 }, 'runs', '')).toBe('Previous period: 1 run.')
  })
})

describe('table sorting', () => {
  const rows = [
    { n: 'beta', v: 2 as number | null },
    { n: 'Alpha', v: null },
    { n: 'gamma', v: 10 },
    { n: 'delta', v: 2 }
  ]
  it('starts numbers high to low and text A to Z, and flips on the same column', () => {
    expect(nextSort(null, 'cost', true)).toEqual({ key: 'cost', dir: 'desc' })
    expect(nextSort(null, 'name', false)).toEqual({ key: 'name', dir: 'asc' })
    expect(nextSort({ key: 'cost', dir: 'desc' }, 'cost', true)).toEqual({ key: 'cost', dir: 'asc' })
    expect(nextSort({ key: 'cost', dir: 'desc' }, 'name', false)).toEqual({ key: 'name', dir: 'asc' })
  })
  it('sorts stably and keeps unknown last in both directions', () => {
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.n)).toEqual(['gamma', 'beta', 'delta', 'Alpha'])
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.n)).toEqual(['beta', 'delta', 'gamma', 'Alpha'])
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['Alpha', 'beta', 'delta', 'gamma'])
  })
  it('gives aria-sort and an announcement', () => {
    expect(ariaSort({ key: 'cost', dir: 'asc' }, 'cost')).toBe('ascending')
    expect(ariaSort({ key: 'cost', dir: 'asc' }, 'runs')).toBe('none')
    expect(sortAnnouncement('Cost', 'desc', true)).toBe('Sorted by Cost, highest first.')
    expect(sortAnnouncement('Project', 'asc', false)).toBe('Sorted by Project, A to Z.')
  })
})
