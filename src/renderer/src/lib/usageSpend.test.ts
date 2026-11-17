import { describe, expect, it } from 'vitest'
import type { UsageOverviewTrendPoint, UsageTrendProjectSlice } from '@shared/types'
import { segmentsOf } from './usageCharts'
import { overlayFigure } from './usageDashboard'
import {
  barValueLabel,
  chartMotion,
  hiddenCount,
  MORPH_MAX_SEGMENTS,
  morphFrom,
  nearestBucket,
  overlayCostText,
  overlayDisabledReason,
  previousCellText,
  previousSortValue,
  previousTipText,
  runsLine,
  sameKeys,
  sameSet,
  segmentFigure,
  sliceKey,
  spendSummary,
  tooltipPlacement,
  unpricedRuns,
  visibleTotals,
  visualGeom
} from './usageSpend'

const T = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 })
const slice = (projectId: string, costUsd: number | null, o: Partial<UsageTrendProjectSlice> = {}): UsageTrendProjectSlice => ({
  projectId, runs: 1, tokens: T(100), costUsd, wallMs: 0, waitingMs: 0, costKnownRuns: costUsd === null ? 0 : 1, costUnknownRuns: costUsd === null ? 1 : 0, ...o
})
const point = (byProject: UsageTrendProjectSlice[]): UsageOverviewTrendPoint => {
  const known = byProject.filter((s) => s.costUsd !== null)
  return {
    bucket: '', start: 0, runs: byProject.reduce((n, s) => n + s.runs, 0), tokens: T(byProject.length * 100),
    costUsd: known.length > 0 ? known.reduce((n, s) => n + (s.costUsd ?? 0), 0) : null,
    costKnownRuns: known.length, costUnknownRuns: byProject.length - known.length,
    turns: 0, toolCalls: 0, nudges: 0, retries: 0, wallMs: 0, waitingMs: 0, noResultTokens: 0, byProject
  } as UsageOverviewTrendPoint
}
const series = new Map([['a', 0], ['b', 1]])

describe('visibleTotals', () => {
  const p = point([slice('a', 2), slice('b', 3), slice('c', null)])
  it('sums everything when nothing is hidden', () => {
    const t = visibleTotals([p], series, new Set())
    expect(t.runs).toBe(3)
    expect(t.tokens).toBe(300)
    expect(t.cost).toMatchObject({ costUsd: 5, costPartial: true })
  })
  it('drops a hidden project and the folded Other', () => {
    expect(visibleTotals([p], series, new Set(['b']))).toMatchObject({ runs: 2, tokens: 200, cost: { costUsd: 2, costPartial: true } })
    const t = visibleTotals([p], series, new Set(['other']))
    expect(t).toMatchObject({ runs: 2, cost: { costUsd: 5 } })
    expect(t.cost.costPartial).toBeUndefined()
  })
  it('keeps unknown cost unknown when only unpriced series remain', () => {
    expect(visibleTotals([p], series, new Set(['a', 'b'])).cost).toMatchObject({ costUsd: null, costSource: 'unknown' })
  })
  it('maps slices to legend keys', () => {
    expect(sliceKey('a', series)).toBe('a')
    expect(sliceKey('zzz', series)).toBe('other')
    expect(hiddenCount(new Set(['a', 'gone']), ['a', 'b', 'other'])).toBe(1)
  })
})

describe('spendSummary', () => {
  const totals = (runs: number, costUsd: number | null = 10) => ({ runs, tokens: 1500, cost: costUsd === null ? { costUsd: null, costSource: 'unknown' as const } : { costUsd, costSource: 'computed' as const } })
  const start = new Date(2026, 10, 3).getTime()
  it('says only what the chart adds: the busiest bucket (the totals are in the KPI band)', () => {
    const busiest = { start, value: 5 }
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(14), busiest, hidden: 0 })).toBe('Busiest day 3 Nov, 5 runs.')
    expect(spendSummary({ metric: 'tokens', bucket: 'day', totals: totals(1), busiest: { start, value: 1500 }, hidden: 0 })).toBe('Busiest day 3 Nov, 1.5k tokens.')
    expect(spendSummary({ metric: 'cost', bucket: 'week', totals: totals(2), busiest: { start, value: 4 }, hidden: 0 })).toMatch(/^Busiest week from 3 Nov, .*\.$/)
  })
  it('says N hidden and handles no runs and unknown cost', () => {
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(3), busiest: { start, value: 2 }, hidden: 2 })).toBe('Busiest day 3 Nov, 2 runs. 2 hidden.')
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(0), busiest: null, hidden: 0 })).toBe('No runs in this period.')
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(0), busiest: null, hidden: 1 })).toBe('No runs in the series shown. 1 hidden.')
    expect(spendSummary({ metric: 'cost', bucket: 'day', totals: totals(4, null), busiest: null, hidden: 0 })).toBe('Cost unknown for 4 runs: no price is known. Tokens are counted.')
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(1), busiest: null, hidden: 0 })).toBe('1 run.')
  })
})

describe('barValueLabel', () => {
  it('formats the visible stack by metric, with + for a lower bound and No price for unknown', () => {
    const segs = segmentsOf([slice('a', 2), slice('b', 3, { costKnownRuns: 1, costUnknownRuns: 1 })], series, 'cost')
    expect(barValueLabel('cost', segs)).toMatch(/\+$/)
    expect(barValueLabel('runs', segmentsOf([slice('a', 2, { runs: 3 })], series, 'runs'))).toBe('3')
    expect(barValueLabel('tokens', segmentsOf([slice('a', 2, { tokens: T(1500) })], series, 'tokens'))).toBe('1.5k')
    expect(barValueLabel('cost', segmentsOf([slice('a', null)], series, 'cost'))).toBe('No price')
    expect(barValueLabel('cost', [])).toBe('')
  })
})

describe('previous-period cells', () => {
  const known = overlayFigure({ start: 0, key: '', point: point([slice('a', 4.2)]) }, series, 'cost', new Set())
  const unknown = overlayFigure({ start: 0, key: '', point: point([slice('a', null)]) }, series, 'cost', new Set())
  const empty = overlayFigure(null, series, 'cost', new Set())
  it('reads text and sort values; unknown and empty have none', () => {
    expect(overlayCostText(known)).toContain('4.2')
    expect(previousCellText(known, 'cost')).toContain('4.2')
    expect(previousCellText(unknown, 'cost')).toBe('No price')
    expect(previousCellText(empty, 'cost')).toBe('—')
    expect(previousSortValue(known, 'cost')).toBeCloseTo(4.2)
    expect(previousSortValue(unknown, 'cost')).toBeNull()
    expect(previousSortValue(empty, 'runs')).toBeNull()
    const runs = overlayFigure({ start: 0, key: '', point: point([slice('a', 1, { runs: 4 })]) }, series, 'runs', new Set())
    expect(previousCellText(runs, 'runs')).toBe('4')
    expect(previousSortValue(runs, 'runs')).toBe(4)
  })
  it('explains a disabled overlay', () => {
    expect(overlayDisabledReason(false)).toBe('No previous period to compare with.')
    expect(overlayDisabledReason(true)).toBeNull()
  })
  it('words the tooltip line for the previous period', () => {
    const runs = overlayFigure({ start: 0, key: '', point: point([slice('a', 1, { runs: 4 })]) }, series, 'runs', new Set())
    expect(previousTipText(runs, 'runs')).toBe('4 runs')
    expect(previousTipText(known, 'cost')).toContain('4.2')
    expect(previousTipText(unknown, 'cost')).toBe('cost unknown')
    expect(previousTipText(empty, 'tokens')).toBe('no runs')
  })
})

describe('tooltip text', () => {
  it('reads a series figure by metric and a runs line with the unpriced part only when there is one', () => {
    const [seg] = segmentsOf([slice('a', 2, { runs: 3, tokens: T(1500) })], series, 'cost')
    expect(segmentFigure('runs', segmentsOf([slice('a', 2, { runs: 3 })], series, 'runs')[0]!)).toBe('3')
    expect(segmentFigure('tokens', segmentsOf([slice('a', 2, { tokens: T(1500) })], series, 'tokens')[0]!)).toBe('1.5k')
    expect(segmentFigure('cost', seg!)).toContain('2')
    expect(segmentFigure('cost', segmentsOf([slice('a', null)], series, 'cost')[0]!)).toBe('No price')
    expect(runsLine(2, 1)).toBe('2 runs, 1 unpriced')
    expect(runsLine(1, 0)).toBe('1 run')
  })
  it('counts unpriced runs over the series that are shown', () => {
    const p = point([slice('a', 2), slice('b', null), slice('c', null)])
    expect(unpricedRuns(p, series, new Set())).toBe(2)
    expect(unpricedRuns(p, series, new Set(['b']))).toBe(1)
    expect(unpricedRuns(p, series, new Set(['other']))).toBe(1)
  })
})

describe('nearestBucket', () => {
  it('maps x to the column under it and null outside the columns', () => {
    expect(nearestBucket(48, 48, 20, 5)).toBe(0)
    expect(nearestBucket(67.9, 48, 20, 5)).toBe(0)
    expect(nearestBucket(68, 48, 20, 5)).toBe(1)
    expect(nearestBucket(148, 48, 20, 5)).toBe(4)
    expect(nearestBucket(47, 48, 20, 5)).toBeNull()
    expect(nearestBucket(149, 48, 20, 5)).toBeNull()
    expect(nearestBucket(60, 48, 20, 0)).toBeNull()
  })
})

describe('tooltipPlacement', () => {
  const base = { half: 10, width: 120, viewLeft: 0, viewRight: 600 }
  it('sits right of the column, clear of its own bar', () => {
    expect(tooltipPlacement({ ...base, cx: 100 })).toEqual({ side: 'right', left: 118 })
  })
  it('flips to the left near the right edge and stays inside the view', () => {
    const p = tooltipPlacement({ ...base, cx: 560 })
    expect(p.side).toBe('left')
    expect(p.left + base.width).toBeLessThanOrEqual(560 - base.half)
    expect(p.left).toBeGreaterThanOrEqual(0)
  })
  it('clamps inside a view too narrow for either side', () => {
    const p = tooltipPlacement({ cx: 80, half: 10, width: 120, viewLeft: 0, viewRight: 160 })
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.left + 120).toBeLessThanOrEqual(160)
  })
  it('uses the scrolled view as its bounds', () => {
    expect(tooltipPlacement({ cx: 900, half: 10, width: 120, viewLeft: 400, viewRight: 1000 }).side).toBe('left')
    expect(tooltipPlacement({ cx: 500, half: 10, width: 120, viewLeft: 400, viewRight: 1000 }).side).toBe('right')
  })
})

describe('chartMotion', () => {
  const slots = ['1', '2', '3']
  const base = { prevSlots: slots, nextSlots: slots, viewChanged: false, metricChanged: false, hiddenChanged: false, segments: 40, reduced: false }
  it('does nothing on first paint or when nothing the user did changed', () => {
    expect(chartMotion({ ...base, prevSlots: null })).toBe('none')
    expect(chartMotion(base)).toBe('none')
    expect(chartMotion({ ...base, nextSlots: ['2', '3', '4'] })).toBe('none')
  })
  it('morphs when the metric or a legend series changed over the same buckets', () => {
    expect(chartMotion({ ...base, metricChanged: true })).toBe('morph')
    expect(chartMotion({ ...base, hiddenChanged: true })).toBe('morph')
  })
  it('fades once, never morphs, when the filters changed the buckets', () => {
    expect(chartMotion({ ...base, viewChanged: true, nextSlots: ['4', '5'] })).toBe('fade')
    expect(chartMotion({ ...base, viewChanged: true, metricChanged: true })).toBe('fade')
  })
  it('does not morph a different bucket set even when the metric also changed', () => {
    expect(chartMotion({ ...base, metricChanged: true, nextSlots: ['1', '2'] })).toBe('none')
  })
  it('skips above the segment cap and under reduced motion', () => {
    expect(chartMotion({ ...base, metricChanged: true, segments: MORPH_MAX_SEGMENTS })).toBe('morph')
    expect(chartMotion({ ...base, metricChanged: true, segments: MORPH_MAX_SEGMENTS + 1 })).toBe('none')
    expect(chartMotion({ ...base, metricChanged: true, reduced: true })).toBe('none')
    expect(chartMotion({ ...base, viewChanged: true, reduced: true })).toBe('none')
  })
  it('compares key lists and sets by content', () => {
    expect(sameKeys(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameKeys(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameSet(new Set(['a']), new Set(['b']))).toBe(false)
  })
})

describe('morph geometry', () => {
  it('maps the new rect onto the old one about its bottom edge', () => {
    // Old: bottom 100, height 40. New: bottom 100, height 80 -> scale 0.5, no shift.
    expect(morphFrom({ bottom: 100, h: 40 }, { bottom: 100, h: 80 })).toEqual({ ty: 0, sy: 0.5, entering: false })
    // Old stacked higher (bottom 60) than the new one (bottom 100): shift up by 40.
    expect(morphFrom({ bottom: 60, h: 20 }, { bottom: 100, h: 20 })).toEqual({ ty: -40, sy: 1, entering: false })
  })
  it('grows a segment with no old rect from nothing and skips one that did not move', () => {
    expect(morphFrom(undefined, { bottom: 100, h: 30 })).toEqual({ ty: 0, sy: 0, entering: true })
    expect(morphFrom({ bottom: 100, h: 30 }, { bottom: 100.2, h: 30.1 })).toBeNull()
    expect(morphFrom({ bottom: 100, h: 30 }, { bottom: 100, h: 0 })).toBeNull()
  })
  it('puts a segment where a running morph shows it, for a reversal that starts mid-flight', () => {
    const old = { bottom: 100, h: 40 }
    const next = { bottom: 100, h: 80 }
    const from = morphFrom(old, next)!
    expect(visualGeom(next, from.ty, from.sy)).toEqual(old)
    expect(visualGeom(next, from.ty / 2, 0.75)).toEqual({ bottom: 100, h: 60 })
  })
})
