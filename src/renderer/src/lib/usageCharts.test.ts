import { describe, expect, it } from 'vitest'
import type { UsageOverviewTrendPoint, UsageProjectRollup, UsageTrendProjectSlice } from '@shared/types'
import {
  allUnpriced,
  assignSeries,
  axisLabel,
  barFraction,
  barHeight,
  barState,
  barWidth,
  cacheHit,
  clipMiddle,
  costFigureText,
  fillBuckets,
  formatTick,
  niceTicks,
  OTHER_KEY,
  rankByCost,
  readoutText,
  rollupCost,
  segmentsOf,
  segmentReadout,
  sharePercent,
  slotWidth,
  stackMax,
  thinLabels
} from './usageCharts'

const T = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 })
const slice = (projectId: string, costUsd: number | null, o: Partial<UsageTrendProjectSlice> = {}): UsageTrendProjectSlice => ({
  projectId, runs: 1, tokens: T(100), costUsd, wallMs: 0, waitingMs: 0, costKnownRuns: costUsd === null ? 0 : 1, costUnknownRuns: costUsd === null ? 1 : 0, ...o
})
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
const point = (start: number, byProject: UsageTrendProjectSlice[]): UsageOverviewTrendPoint =>
  ({ bucket: '', start, runs: byProject.length, tokens: T(100), costUsd: null, costUnknownRuns: 0, costKnownRuns: 0, turns: 0, toolCalls: 0, nudges: 0, retries: 0, wallMs: 0, waitingMs: 0, noResultTokens: 0, byProject }) as UsageOverviewTrendPoint

describe('niceTicks', () => {
  it('starts at 0, has 3 to 5 ticks and covers the maximum', () => {
    for (const m of [0.0007, 0.42, 1, 3.3, 9.8, 42.1, 99, 120, 1234.5, 98765]) {
      const t = niceTicks(m)
      expect(t.ticks[0]).toBe(0)
      expect(t.ticks.length).toBeGreaterThanOrEqual(3)
      expect(t.ticks.length).toBeLessThanOrEqual(5)
      expect(t.max).toBeGreaterThanOrEqual(m)
      expect(t.ticks[t.ticks.length - 1]).toBe(t.max)
    }
  })
  it('picks round steps', () => {
    expect(niceTicks(9.8).ticks).toEqual([0, 2.5, 5, 7.5, 10])
    expect(niceTicks(42).ticks).toEqual([0, 20, 40, 60])
    expect(niceTicks(100).ticks).toEqual([0, 25, 50, 75, 100])
    expect(niceTicks(0).max).toBe(1)
  })
})

describe('formatTick', () => {
  it('uses compact labels', () => {
    expect(formatTick(0, 'cost')).toBe('$0')
    expect(formatTick(5, 'cost')).toBe('$5')
    expect(formatTick(12000, 'cost')).toBe('$12k')
    expect(formatTick(0.5, 'cost')).toBe('$0.50')
    expect(formatTick(0.015, 'cost')).toBe('$0.015')
    expect(formatTick(0.01, 'cost')).toBe('$0.01')
    expect(formatTick(0.02, 'cost')).toBe('$0.02')
    expect(formatTick(1500, 'tokens')).toBe('1.5k')
  })
})

describe('sizes', () => {
  it('keeps a small value visible and bars at least 6 px', () => {
    expect(barHeight(0, 10, 100)).toBe(0)
    expect(barHeight(0.001, 10, 100)).toBe(2)
    expect(barHeight(10, 10, 100)).toBe(100)
    expect(barWidth(5)).toBe(6)
    expect(barWidth(40)).toBe(28)
    expect(slotWidth(100, 400)).toBe(8)
    expect(slotWidth(10, 400)).toBe(40)
  })
  it('barFraction gives anything above zero a visible bar', () => {
    expect(barFraction(0, 10)).toBe(0)
    expect(barFraction(0.0001, 10)).toBe(0.02)
    expect(barFraction(10, 10)).toBe(1)
  })
})

describe('fillBuckets', () => {
  it('draws empty days between runs', () => {
    const a = point(day(2026, 11, 3), [slice('p', 1)])
    const b = point(day(2026, 11, 6), [slice('p', 2)])
    const slots = fillBuckets([a, b], day(2026, 11, 2), day(2026, 11, 8), 'day')
    expect(slots.map((s) => s.point !== null)).toEqual([false, true, false, false, true, false])
    expect(slots).toHaveLength(6)
  })
  it('fills weeks from Monday and months', () => {
    const w = fillBuckets([], day(2026, 11, 4), day(2026, 11, 23), 'week')
    expect(new Date(w[0]!.start).getDay()).toBe(1)
    expect(w).toHaveLength(3)
    expect(fillBuckets([], day(2026, 9, 10), day(2026, 11, 5), 'month')).toHaveLength(3)
  })
  it('keeps a point outside the span', () => {
    const p = point(day(2026, 10, 1), [slice('p', 1)])
    expect(fillBuckets([p], day(2026, 11, 2), day(2026, 11, 4), 'day').some((s) => s.point === p)).toBe(true)
  })
})

describe('labels', () => {
  it('always shows the first and the last label and never two touching', () => {
    for (const n of [1, 2, 7, 14, 31, 92]) {
      const set = thinLabels(n, 20, 44)
      expect(set.has(0)).toBe(true)
      expect(set.has(n - 1)).toBe(true)
      const sorted = [...set].sort((a, b) => a - b)
      // Gaps are one step (3 slots of 20 px for a 44 px label), except the last label's, which may sit nearer the first only for tiny counts.
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(n > 3 ? 3 : 1)
    }
  })
  it('shows every label when there is room', () => {
    expect(thinLabels(5, 60, 44).size).toBe(5)
  })
  it('clips the middle of long names', () => {
    expect(clipMiddle('short', 10)).toBe('short')
    const c = clipMiddle('claude-sonnet-4-5-20251001', 14)
    expect(c).toHaveLength(14)
    expect(c.startsWith('claude-')).toBe(true)
    expect(c.endsWith('1001')).toBe(true)
    expect(c).toContain('…')
  })
  it('labels axes locally', () => {
    expect(axisLabel(day(2026, 11, 3), 'day')).toBe('3 Nov')
    expect(axisLabel(day(2026, 11, 1), 'month')).toBe('Nov')
  })
})

const series = new Map([['a', 0], ['b', 1]])

describe('segmentsOf', () => {
  it('orders by series with Other last and folds the rest', () => {
    const segs = segmentsOf([slice('c', 1), slice('b', 2), slice('a', 3), slice('d', 4)], series, 'cost')
    expect(segs.map((s) => s.key)).toEqual(['a', 'b', OTHER_KEY])
    expect(segs[2]!.value).toBe(5)
    expect(segs[2]!.projects).toBe(2)
    expect(stackMax([segs])).toBe(10)
  })
  it('encodes known, partial, unknown and nothing spent', () => {
    const segs = segmentsOf(
      [slice('a', 2), slice('b', 1, { costUnknownRuns: 1, costKnownRuns: 1, runs: 2 }), slice('c', null), slice('d', 0)],
      new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]]),
      'cost'
    )
    expect(segs.map((s) => [s.key, s.state])).toEqual([['a', 'known'], ['b', 'partial'], ['c', 'unknown']])
    expect(segs[2]!.value).toBe(0)
    expect(segs[2]!.cost.costUsd).toBeNull()
  })
  it('an Other of only unknown parts stays unknown and adds nothing', () => {
    const segs = segmentsOf([slice('x', null), slice('y', null)], series, 'cost')
    expect(segs).toHaveLength(1)
    expect(segs[0]!.state).toBe('unknown')
    expect(stackMax([segs])).toBe(0)
  })
  it('tokens stack every project, priced or not', () => {
    const segs = segmentsOf([slice('a', null), slice('b', 2)], series, 'tokens')
    expect(segs.map((s) => s.state)).toEqual(['known', 'known'])
    expect(stackMax([segs])).toBe(200)
  })
})

describe('barState and allUnpriced', () => {
  it('classifies a bar', () => {
    const s = (state: 'known' | 'partial' | 'unknown') => segmentsOf([slice('a', state === 'unknown' ? null : 1, state === 'partial' ? { costUnknownRuns: 1 } : {})], series, 'cost')
    expect(barState(s('known'), true)).toBe('known')
    expect(barState(s('partial'), true)).toBe('partial')
    expect(barState(s('unknown'), true)).toBe('unknown')
    expect(barState([], false)).toBe('empty')
    expect(barState([...s('known'), ...segmentsOf([slice('b', null)], series, 'cost')], true)).toBe('partial')
  })
  it('detects a period with nothing priced', () => {
    const p = (cost: number | null) => ({ ...point(1, [slice('a', cost)]), costUsd: cost })
    expect(allUnpriced([p(null), p(null)])).toBe(true)
    expect(allUnpriced([p(null), p(1)])).toBe(false)
    expect(allUnpriced([])).toBe(false)
  })
})

describe('text', () => {
  it('words a readout and names unknown parts', () => {
    const segs = segmentsOf([slice('a', 6.1), slice('b', null)], series, 'cost')
    const names = (k: string) => (k === 'a' ? 'Billing' : 'Docs')
    const t = readoutText('Tue 3 Nov', { runs: 2, cost: { costUsd: 6.1, costSource: 'computed', costPartial: true }, tokens: 200 }, segs, names, 'cost')
    expect(t).toBe('Tue 3 Nov: $6.10+, 2 runs. Billing $6.10, Docs unknown.')
    expect(readoutText('Wed 4 Nov', { runs: 0, cost: { costUsd: 0, costSource: 'none' }, tokens: 0 }, [], names, 'cost')).toBe('Wed 4 Nov: no runs.')
    expect(segmentReadout('Tue 3 Nov', 'Docs', segs[1]!, 'cost')).toBe('Tue 3 Nov, Docs: cost unknown, 1 run.')
  })
  it('never prints $0 for an unknown cost', () => {
    expect(costFigureText({ costUsd: null, costSource: 'unknown' })).toBe('No price')
    expect(costFigureText({ costUsd: 0.4261, costSource: 'computed', costPartial: true })).toBe('$0.426+')
  })
  it('puts + on a rollup iff a run in it is unknown', () => {
    expect(rollupCost({ costUsd: 4.2, costKnownRuns: 3, costUnknownRuns: 1 }).costPartial).toBe(true)
    expect(rollupCost({ costUsd: 4.2, costKnownRuns: 4, costUnknownRuns: 0 }).costPartial).toBeUndefined()
    expect(rollupCost({ costUsd: null, costKnownRuns: 0, costUnknownRuns: 2 }).costUsd).toBeNull()
  })
  it('computes cache hit and shares', () => {
    expect(cacheHit({ input: 100, output: 5, cacheRead: 300, cacheWrite: 100 })).toBeCloseTo(0.6)
    expect(cacheHit({ input: 100, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(sharePercent(61, 100)).toBe(61)
    expect(sharePercent(1, 0)).toBe(0)
  })
})

describe('rankByCost', () => {
  it('puts unknown cost after known, by tokens', () => {
    const items = [
      { n: 'u1', costUsd: null, tokens: 50 },
      { n: 'k1', costUsd: 1, tokens: 1 },
      { n: 'u2', costUsd: null, tokens: 900 },
      { n: 'k2', costUsd: 5, tokens: 1 }
    ]
    expect(rankByCost(items, (i) => i).map((i) => i.n)).toEqual(['k2', 'k1', 'u2', 'u1'])
  })
})

describe('assignSeries', () => {
  const p = (id: string) => ({ projectId: id }) as UsageProjectRollup
  it('gives the top five series and keeps them while the period is unchanged', () => {
    const first = assignSeries(null, ['a', 'b', 'c', 'd', 'e', 'f'].map(p), 'k')
    expect(first.map.size).toBe(5)
    expect(first.map.get('f')).toBeUndefined()
    expect(assignSeries(first, [p('b'), p('a')], 'k')).toBe(first)
    expect(assignSeries(first, [p('z')], 'k2').map.get('z')).toBe(0)
  })
})
