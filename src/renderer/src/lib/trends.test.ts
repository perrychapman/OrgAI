import { describe, expect, it } from 'vitest'
import type { UsageTrendPoint } from '@shared/types'
import { barFractions, bucketKey, bucketStart, fillBuckets, formatShare, pointValue, rangeSince, shares, totalTokens } from './trends'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

function point(start: number, input: number, costUsd: number | null): UsageTrendPoint {
  return {
    bucket: bucketKey(start),
    start,
    runs: 1,
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd,
    costUnknownRuns: 0,
    turns: 0,
    toolCalls: 0,
    nudges: 0,
    retries: 0,
    wallMs: 0,
    waitingMs: 0,
    noResultTokens: 0
  }
}

describe('trends helpers', () => {
  it('sums all four token kinds', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10)
  })

  it('rangeSince covers today plus the days before', () => {
    expect(rangeSince(at(2026, 3, 10), 7)).toBe(at(2026, 3, 4, 0))
    expect(rangeSince(at(2026, 3, 10), 1)).toBe(at(2026, 3, 10, 0))
  })

  it('bucketStart snaps to midnight or Monday', () => {
    expect(bucketStart(at(2026, 3, 11, 15), 'day')).toBe(at(2026, 3, 11, 0))
    // 2026-03-11 is a Wednesday; its Monday is the 9th. Sunday the 15th belongs to the same week.
    expect(bucketStart(at(2026, 3, 11), 'week')).toBe(at(2026, 3, 9, 0))
    expect(bucketStart(at(2026, 3, 15), 'week')).toBe(at(2026, 3, 9, 0))
  })

  it('fillBuckets adds the empty days and keeps the real points', () => {
    const real = point(at(2026, 3, 9, 0), 100, 1)
    const out = fillBuckets([real], at(2026, 3, 8), at(2026, 3, 10), 'day')
    expect(out.map((p) => p.bucket)).toEqual(['2026-03-08', '2026-03-09', '2026-03-10'])
    expect(out[1]).toBe(real)
    expect(out[0].runs).toBe(0)
    expect(out[0].costUsd).toBeNull()
  })

  it('fillBuckets works by week and with no points', () => {
    const out = fillBuckets([], at(2026, 3, 1), at(2026, 3, 20), 'week')
    expect(out.map((p) => p.bucket)).toEqual(['2026-02-23', '2026-03-02', '2026-03-09', '2026-03-16'])
  })

  it('pointValue keeps unknown cost as null', () => {
    const p = point(at(2026, 3, 9, 0), 50, null)
    expect(pointValue(p, 'cost')).toBeNull()
    expect(pointValue(p, 'tokens')).toBe(50)
  })

  it('barFractions scales to the max, floors tiny values and zeroes unknowns', () => {
    expect(barFractions([10, 5, 0, null])).toEqual([1, 0.5, 0, 0])
    expect(barFractions([1000, 1])[1]).toBe(0.04)
    expect(barFractions([0, null])).toEqual([0, 0])
    expect(barFractions([])).toEqual([])
  })

  it('shares sum to one and survive a zero total', () => {
    expect(shares([1, 3])).toEqual([0.25, 0.75])
    expect(shares([0, 0])).toEqual([0, 0])
  })

  it('formatShare', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.004)).toBe('<1%')
    expect(formatShare(0.426)).toBe('43%')
  })
})
