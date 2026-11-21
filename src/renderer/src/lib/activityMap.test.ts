import { describe, expect, it } from 'vitest'
import { activityMap, blockRange, firstDayLabel, mapText, MIN_STRENGTH, todayText } from './activityMap'

const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min, 0).getTime()
// Saturday 7 November 2026, 15:30: block 3 (12:00 to 16:00) of today has started, blocks 4 and 5 have not.
const NOW = at(2026, 11, 7, 15, 30)
const r = (id: string, startedAt: number): { id: string; startedAt: number } => ({ id, startedAt })

describe('activityMap days', () => {
  it('has 14 local days, oldest first, today last, six blocks each', () => {
    const m = activityMap([], NOW)
    expect(m.days).toHaveLength(14)
    expect(m.days[0].key).toBe('2026-10-25')
    expect(m.days[13].key).toBe('2026-11-07')
    expect(m.days.filter((d) => d.today)).toHaveLength(1)
    expect(m.days.every((d) => d.cells.length === 6)).toBe(true)
    expect(firstDayLabel(m)).toBe('25 Oct')
  })

  it('never repeats or skips a day over a daylight saving change or a year boundary', () => {
    for (const now of [at(2026, 3, 12), at(2026, 3, 30), at(2026, 10, 28), at(2026, 11, 8), at(2027, 1, 3)]) {
      const m = activityMap([], now)
      expect(new Set(m.days.map((d) => d.key)).size).toBe(14)
      for (let i = 1; i < m.days.length; i++) {
        const prev = new Date(m.days[i - 1].start)
        expect(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1).getTime()).toBe(m.days[i].start)
      }
    }
  })
})

describe('activityMap bucketing', () => {
  it('puts a run in the local day and four-hour block of its start', () => {
    const m = activityMap([r('a', at(2026, 11, 7, 9)), r('b', at(2026, 11, 7, 11, 59)), r('c', at(2026, 11, 6, 0)), r('d', at(2026, 11, 6, 23, 59))], NOW)
    expect(m.days[13].cells[2].runs).toBe(2)
    expect(m.days[12].cells[0].runs).toBe(1)
    expect(m.days[12].cells[5].runs).toBe(1)
    expect(m.total).toBe(4)
    expect(m.today).toBe(2)
  })

  it('splits at the block edges: 03:59 is 00-04 and 04:00 is 04-08', () => {
    const m = activityMap([r('a', at(2026, 11, 5, 3, 59)), r('b', at(2026, 11, 5, 4, 0))], NOW)
    expect(m.days[11].cells[0].runs).toBe(1)
    expect(m.days[11].cells[1].runs).toBe(1)
  })

  it('counts a run just before midnight in the day it started', () => {
    const m = activityMap([r('a', new Date(2026, 10, 6, 23, 59, 59).getTime())], NOW)
    expect(m.days[12].cells[5].runs).toBe(1)
    expect(m.days[13].total).toBe(0)
  })

  it('leaves out runs older than 14 days and counts each id once', () => {
    const m = activityMap([r('old', at(2026, 10, 24, 12)), r('edge', at(2026, 10, 25, 0)), r('a', at(2026, 11, 1)), r('a', at(2026, 11, 1))], NOW)
    expect(m.total).toBe(2)
    expect(m.days[0].cells[0].runs).toBe(1)
  })

  it('leaves out a run stamped in the future and a run without a time', () => {
    const m = activityMap([r('late', at(2026, 11, 7, 20)), r('next', at(2026, 11, 8)), r('nan', Number.NaN)], NOW)
    expect(m.total).toBe(0)
  })

  it('keeps the local hour across a daylight saving change (US spring forward, 2026-03-08)', () => {
    const now = at(2026, 3, 9, 12)
    const m = activityMap([r('a', at(2026, 3, 8, 1, 30)), r('b', at(2026, 3, 8, 3, 30)), r('c', at(2026, 3, 8, 5))], now)
    const day = m.days.find((d) => d.key === '2026-03-08')!
    expect(day.cells[0].runs).toBe(2)
    expect(day.cells[1].runs).toBe(1)
    expect(m.total).toBe(3)
  })
})

describe('activityMap strength and states', () => {
  it('scales to the busiest block with a floor for any block that has runs', () => {
    const many = Array.from({ length: 40 }, (_, i) => r(`m${i}`, at(2026, 11, 3, 9)))
    const m = activityMap([...many, r('one', at(2026, 11, 4, 9)), r('twenty-a', at(2026, 11, 5, 9))], NOW)
    expect(m.max).toBe(40)
    expect(m.days[9].cells[2].strength).toBe(1)
    expect(m.days[10].cells[2].strength).toBe(MIN_STRENGTH)
    expect(m.days[10].cells[2].state).toBe('some')
    expect(m.days[9].cells[1].strength).toBe(0)
  })

  it('tells a block that has not started yet (future) from one that had no runs (zero)', () => {
    const m = activityMap([], NOW)
    const today = m.days[13].cells.map((c) => c.state)
    expect(today).toEqual(['zero', 'zero', 'zero', 'zero', 'future', 'future'])
    expect(m.days[12].cells.every((c) => c.state === 'zero')).toBe(true)
  })

  it('draws a run in the current block as some, never future', () => {
    const m = activityMap([r('a', at(2026, 11, 7, 14))], NOW)
    expect(m.days[13].cells[3].state).toBe('some')
  })
})

describe('activityMap words', () => {
  it('names the two busiest blocks of the day and the total', () => {
    const m = activityMap([r('a', at(2026, 11, 5, 13)), r('b', at(2026, 11, 4, 14)), r('c', at(2026, 11, 3, 9)), r('d', at(2026, 11, 2, 22))], NOW)
    expect(mapText(m)).toBe('Runs started per four-hour block over the last 14 days. 4 runs in all. Busiest: 12:00 to 16:00 with 2 runs, then 08:00 to 12:00 with 1.')
  })
  it('says so when nothing started', () => {
    expect(mapText(activityMap([], NOW))).toBe('No runs started in the last 14 days.')
  })
  it('says today in words', () => {
    expect(todayText(activityMap([], NOW))).toBe('No runs started today yet.')
    expect(todayText(activityMap([r('a', at(2026, 11, 7, 9))], NOW))).toBe('1 run started today.')
    expect(todayText(activityMap([r('a', at(2026, 11, 7, 9)), r('b', at(2026, 11, 7, 10))], NOW))).toBe('2 runs started today.')
  })
  it('names a block range, wrapping the last to midnight', () => {
    expect(blockRange(0)).toBe('00:00 to 04:00')
    expect(blockRange(5)).toBe('20:00 to 00:00')
  })
})
