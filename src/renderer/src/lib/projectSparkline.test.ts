import { describe, expect, it } from 'vitest'
import type { RunStatus } from '@shared/types'
import { MIN_BAR_PX, type LedgerRun } from './activityStrip'
import { projectSpark, SPARK_BAR_PX, SPARK_DAYS, SPARK_MARK_PX, SPARK_PITCH_PX, SPARK_TRACK_PX } from './projectSparkline'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
// Saturday 7 November 2026, mid-afternoon: the week is Sun 1 Nov to Sat 7 Nov.
const NOW = at(2026, 11, 7, 15)

let n = 0
const run = (startedAt: number): LedgerRun => ({ id: `r${++n}`, startedAt, status: 'finished' as RunStatus, totalCostUsd: 0 })
const on = (d: number, count: number): LedgerRun[] => Array.from({ length: count }, () => run(at(2026, 11, d)))

describe('projectSpark', () => {
  it('is seven columns, oldest first, today last and marked once', () => {
    const s = projectSpark([], NOW)
    expect(s.days).toHaveLength(SPARK_DAYS)
    expect(s.days[0].key).toBe('2026-11-01')
    expect(s.days[6].key).toBe('2026-11-07')
    expect(s.days.filter((d) => d.today)).toHaveLength(1)
    expect(s.days[6].today).toBe(true)
  })

  it('declares fixed geometry: column pitch, centred bars, track plus marker row', () => {
    const s = projectSpark(on(3, 2), NOW)
    expect(s.width).toBe(SPARK_DAYS * SPARK_PITCH_PX)
    expect(s.height).toBe(SPARK_TRACK_PX + SPARK_MARK_PX)
    expect(s.days[0].x).toBe((SPARK_PITCH_PX - SPARK_BAR_PX) / 2)
    expect(s.days[3].x).toBe(3 * SPARK_PITCH_PX + (SPARK_PITCH_PX - SPARK_BAR_PX) / 2)
  })

  it('scales linearly from zero to the busiest day, a hairline (0) for no runs', () => {
    const s = projectSpark([...on(2, 4), ...on(3, 2), ...on(5, 1)], NOW)
    const h = Object.fromEntries(s.days.map((d) => [d.key, d.height]))
    expect(h['2026-11-02']).toBe(SPARK_TRACK_PX)
    expect(h['2026-11-03']).toBe(SPARK_TRACK_PX / 2)
    expect(h['2026-11-05']).toBe(SPARK_TRACK_PX / 4)
    expect(h['2026-11-04']).toBe(0)
    expect(h['2026-11-07']).toBe(0)
  })

  it('never draws a day with runs shorter than the minimum bar', () => {
    const s = projectSpark([...on(2, 100), ...on(3, 1)], NOW)
    expect(s.days.find((d) => d.key === '2026-11-03')?.height).toBe(MIN_BAR_PX)
  })

  it('leaves runs outside the 7 days out and counts each run id once', () => {
    const dup = run(at(2026, 11, 6))
    const s = projectSpark([dup, dup, run(at(2026, 10, 31)), run(at(2026, 11, 8))], NOW)
    expect(s.total).toBe(1)
    expect(s.days.find((d) => d.key === '2026-11-06')?.runs).toBe(1)
  })

  it('says the total and the busiest day', () => {
    const s = projectSpark([...on(3, 3), ...on(5, 2)], NOW)
    expect(s.total).toBe(5)
    expect(s.label).toBe('Runs in the last 7 days: 5, most on Tue 3 Nov')
  })

  it('says "all on" when one day holds every run and names today as today', () => {
    expect(projectSpark(on(4, 2), NOW).label).toBe('Runs in the last 7 days: 2, all on Wed 4 Nov')
    expect(projectSpark(on(7, 1), NOW).label).toBe('Runs in the last 7 days: 1, all on Today, Sat 7 Nov')
  })

  it('names no busiest day when two days tie', () => {
    expect(projectSpark([...on(3, 2), ...on(5, 2)], NOW).label).toBe('Runs in the last 7 days: 4')
  })

  it('says "No runs this week" with a flat row of zero heights when there are none', () => {
    const s = projectSpark([], NOW)
    expect(s.total).toBe(0)
    expect(s.label).toBe('No runs this week')
    expect(s.days.every((d) => d.height === 0 && d.runs === 0)).toBe(true)
  })
})
