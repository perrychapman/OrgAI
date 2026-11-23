import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../shared/types'
import { capPeriods } from './spendGuard'
import { periodBounds, projectSpend } from './projectSpend'

function r(startedAt: number, cost: number | null, kind: RunSummary['kind'] = 'work'): RunSummary {
  return {
    id: `r${startedAt}`,
    projectId: 'p1',
    kind,
    status: 'finished',
    startedAt,
    totalCostUsd: cost ?? 0,
    usage: { costUsd: cost, costSource: cost === null ? 'unknown' : 'computed' }
  } as unknown as RunSummary
}

describe('periodBounds', () => {
  it('is the local day and month containing now', () => {
    const now = new Date(2026, 10, 20, 15, 30).getTime()
    const b = periodBounds(now)
    expect(b.dayFrom).toBe(new Date(2026, 10, 20).getTime())
    expect(b.dayUntil).toBe(new Date(2026, 10, 21).getTime())
    expect(b.monthFrom).toBe(new Date(2026, 10, 1).getTime())
    expect(b.monthUntil).toBe(new Date(2026, 11, 1).getTime())
  })
})

describe('projectSpend', () => {
  const now = new Date(2026, 10, 20, 15).getTime()
  const p = { id: 'p1', maxDailyUsd: 5 }
  it('counts by start time at the day and month boundaries', () => {
    const b = periodBounds(now)
    const runs = [r(b.dayFrom, 1), r(b.dayFrom - 1, 2), r(b.monthFrom, 4), r(b.monthFrom - 1, 8), r(now, 0.5, 'setup')]
    const s = projectSpend(p, runs, now)
    expect(s.day).toMatchObject({ spentUsd: 1.5, runs: 2, from: b.dayFrom, until: b.dayUntil })
    expect(s.month).toMatchObject({ spentUsd: 7.5, runs: 4, from: b.monthFrom, until: b.monthUntil })
    expect(s.maxDailyUsd).toBe(5)
    expect(s.maxMonthlyUsd).toBeUndefined()
  })
  it('counts a run that began before midnight and ended today toward today (and the month)', () => {
    const b = periodBounds(now)
    const across = { ...r(b.dayFrom - 3_600_000, 3), endedAt: b.dayFrom + 3_600_000 }
    const s = projectSpend(p, [across], now)
    expect(s.day).toMatchObject({ spentUsd: 3, runs: 1 })
    expect(capPeriods(s)[0]).toMatchObject({ spentUsd: 3 })
  })
  it('counts a still-open run that began yesterday toward today, and a run ended before today not', () => {
    const b = periodBounds(now)
    const open = { ...r(b.dayFrom - 7_200_000, 2), status: 'running' as const }
    const old = { ...r(b.dayFrom - 7_200_000, 9), endedAt: b.dayFrom - 3_600_000 }
    const s = projectSpend(p, [open, old], now)
    expect(s.day).toMatchObject({ spentUsd: 2, runs: 1 })
  })
  it('counts a run that began last month and ended this month toward both months', () => {
    const b = periodBounds(now)
    const across = { ...r(b.monthFrom - 3_600_000, 4), endedAt: b.monthFrom + 3_600_000 }
    const s = projectSpend(p, [across], now)
    expect(s.month).toMatchObject({ spentUsd: 4, runs: 1 })
    const lastMonth = projectSpend(p, [across], b.monthFrom - 1000)
    expect(lastMonth.month).toMatchObject({ spentUsd: 4, runs: 1 })
  })
  it('does not count a run starting at or after the period end', () => {
    const b = periodBounds(now)
    expect(projectSpend(p, [r(b.dayUntil, 5)], now).day.runs).toBe(0)
  })
  it('counts unknown-cost runs apart from the spend', () => {
    const s = projectSpend(p, [r(now, null), r(now, 2)], now)
    expect(s.day).toMatchObject({ spentUsd: 2, runs: 2, unknownRuns: 1 })
  })
  it('projects only after 3 elapsed days with some spend', () => {
    const early = new Date(2026, 10, 3, 0).getTime() // exactly 2 days in
    expect(projectSpend(p, [r(early, 5)], early).monthProjectionUsd).toBeNull()
    const at3 = new Date(2026, 10, 4, 0).getTime() // 3 days in, 30-day month
    const elapsed = (at3 - new Date(2026, 10, 1).getTime()) / 86_400_000 // DST shifts it slightly in November
    expect(projectSpend(p, [r(at3 - 1000, 3)], at3).monthProjectionUsd).toBeCloseTo((3 / elapsed) * 30)
    expect(projectSpend(p, [r(at3 - 1000, null)], at3).monthProjectionUsd).toBeNull()
  })
  it('gives spendGuard the cap, spend and reset time it reads', () => {
    const s = projectSpend(p, [r(now, 6)], now)
    expect(capPeriods(s)).toEqual([{ scope: 'day', limitUsd: 5, spentUsd: 6, resetsAt: s.day.until }])
  })
})
