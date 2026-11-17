import { describe, expect, it } from 'vitest'
import type { UsageOverviewTrendPoint, UsageTrendProjectSlice } from '@shared/types'
import { segmentsOf } from './usageCharts'
import { overlayFigure } from './usageDashboard'
import { barValueLabel, hiddenCount, overlayCostText, overlayDisabledReason, previousCellText, previousSortValue, sliceKey, spendSummary, visibleTotals } from './usageSpend'

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
  it('writes runs, tokens and cost sentences with the busiest bucket', () => {
    const busiest = { start, value: 5 }
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(14), busiest, hidden: 0 })).toBe('14 runs; busiest day 3 Nov, 5 runs.')
    expect(spendSummary({ metric: 'tokens', bucket: 'day', totals: totals(1), busiest: { start, value: 1500 }, hidden: 0 })).toBe('1.5k tokens across 1 run; busiest day 3 Nov, 1.5k tokens.')
    expect(spendSummary({ metric: 'cost', bucket: 'week', totals: totals(2), busiest: { start, value: 4 }, hidden: 0 })).toMatch(/^Estimated .* across 2 runs; busiest week from 3 Nov, .*\.$/)
  })
  it('says N hidden and handles no runs and unknown cost', () => {
    expect(spendSummary({ metric: 'runs', bucket: 'day', totals: totals(3), busiest: { start, value: 2 }, hidden: 2 })).toBe('3 runs; busiest day 3 Nov, 2 runs. 2 hidden.')
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
})
