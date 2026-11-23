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
