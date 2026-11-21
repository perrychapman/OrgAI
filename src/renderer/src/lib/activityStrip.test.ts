import { describe, expect, it } from 'vitest'
import type { CostSource, RunStatus } from '@shared/types'
import { costView } from './cost'
import { barHeight, dayKey, dayLedger, dayName, honestCost, ledgerTotals, outcomeOf, runWorkMs, weekdayInitial, type LedgerRun } from './activityStrip'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
// Saturday 7 November 2026, mid-afternoon: the week is Sun 1 Nov to Sat 7 Nov.
const NOW = at(2026, 11, 7, 15)
const MIN = 60_000

interface RunOpts {
  cost?: number | null
  source?: CostSource
  partial?: boolean
  /** wallMs, idleMs, waitingMs of a run with usage. */
  wall?: number
  idle?: number
  waiting?: number
  limitHold?: number
}

function run(id: string, startedAt: number, over: Partial<LedgerRun> & RunOpts = {}): LedgerRun {
  const { cost, source, partial, wall, idle, waiting, limitHold, ...rest } = over
  const hasUsage = cost !== undefined || wall !== undefined || idle !== undefined || waiting !== undefined
  const usage = hasUsage
    ? ({
        costUsd: cost ?? 0,
        costSource: source ?? (cost === null ? 'unknown' : cost === 0 || cost === undefined ? 'none' : 'provider'),
        ...(partial ? { costPartial: true } : {}),
        wallMs: wall ?? 0,
        idleMs: idle ?? 0,
        waitingMs: waiting ?? 0,
        limitHoldMs: limitHold ?? 0
      } as unknown as NonNullable<LedgerRun['usage']>)
    : undefined
  return { id, startedAt, status: 'finished' as RunStatus, totalCostUsd: 0, ...(usage ? { usage } : {}), ...rest }
}

const costText = (c: Parameters<typeof costView>[0]): string => {
  const v = costView(honestCost(c), { compact: true })
  return v.kind === 'none' ? '' : v.text
}

describe('dayLedger days', () => {
  it('is 7 local days, oldest first, today last', () => {
    const days = dayLedger([], NOW)
    expect(days).toHaveLength(7)
    expect(days[6].key).toBe('2026-11-07')
    expect(days[6].today).toBe(true)
    expect(days[0].key).toBe('2026-11-01')
    expect(days.filter((d) => d.today)).toHaveLength(1)
    expect(new Set(days.map((d) => d.key)).size).toBe(7)
  })

  it('never repeats or skips a day over a month boundary or a year boundary', () => {
    const jan = dayLedger([], at(2027, 1, 3)).map((d) => d.key)
    expect(jan[0]).toBe('2026-12-28')
    expect(jan[6]).toBe('2027-01-03')
    expect(new Set(jan).size).toBe(7)
  })

  it('stays one day per step across daylight saving changes (US spring, EU autumn, US autumn)', () => {
    for (const today of [at(2026, 3, 12), at(2026, 3, 30), at(2026, 10, 28), at(2026, 11, 8)]) {
      const days = dayLedger([], today)
      expect(days).toHaveLength(7)
      expect(new Set(days.map((d) => d.key)).size).toBe(7)
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1].start)
        const cur = new Date(days[i].start)
        expect(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1).getTime()).toBe(cur.getTime())
      }
      expect(days[6].key).toBe(dayKey(today))
    }
  })

  it('works when `now` is just after midnight and just before it', () => {
    expect(dayLedger([], new Date(2026, 10, 7, 0, 0, 1).getTime())[6].key).toBe('2026-11-07')
    expect(dayLedger([], new Date(2026, 10, 7, 23, 59, 59).getTime())[6].key).toBe('2026-11-07')
  })

  it('builds as many days as asked (14 for the week before)', () => {
    const days = dayLedger([], NOW, 14)
    expect(days).toHaveLength(14)
    expect(days[0].key).toBe('2026-10-25')
  })
})

describe('dayLedger attribution', () => {
  it('counts a run on the local day it started, with its whole cost, even past midnight', () => {
    const late = new Date(2026, 10, 6, 23, 59, 0).getTime()
    const days = dayLedger([{ ...run('a', late, { cost: 2, status: 'finished' }), endedAt: late + 3_600_000 } as LedgerRun], NOW)
    expect(days.find((d) => d.key === '2026-11-06')?.runs).toBe(1)
    expect(costText(days.find((d) => d.key === '2026-11-06')!.cost)).toBe('$2.00')
    expect(days.find((d) => d.key === '2026-11-07')?.runs).toBe(0)
  })

  it('drops runs outside the 7 days and counts each id once', () => {
    const days = dayLedger([run('old', at(2026, 10, 31)), run('a', at(2026, 11, 1)), run('a', at(2026, 11, 1)), run('future', at(2026, 11, 8))], NOW)
    expect(days.reduce((s, d) => s + d.runs, 0)).toBe(1)
  })

  it('counts every kind of run and tallies outcomes from the status words', () => {
    const days = dayLedger(
      [
        run('f', at(2026, 11, 7, 9)),
        run('e', at(2026, 11, 7, 9), { status: 'error' }),
        run('s', at(2026, 11, 7, 9), { endedBy: 'user' }),
        run('q', at(2026, 11, 7, 9), { endedBy: 'app' }),
        run('r', at(2026, 11, 7, 9), { status: 'running' }),
        run('p', at(2026, 11, 7, 9), { status: 'paused' }),
        run('k', at(2026, 11, 7, 9), { kind: 'setup' })
      ],
      NOW
    )
    const today = days[6]
    expect(today.runs).toBe(7)
    expect(today.outcomes).toEqual({ finished: 2, failed: 1, stopped: 2, open: 1, paused: 1 })
  })

  it('maps run statuses to outcomes', () => {
    expect(outcomeOf(run('a', 1, { status: 'idle' }))).toBe('open')
    expect(outcomeOf(run('a', 1, { status: 'stopping' }))).toBe('open')
  })
})

describe('working time', () => {
  it('is wall minus idle minus waiting, floored at 0, and does not subtract the limit hold', () => {
    expect(runWorkMs(run('a', 1, { wall: 60 * MIN, idle: 10 * MIN, waiting: 5 * MIN }).usage)).toBe(45 * MIN)
    // A usage-limited run: the hold (20 min) sits inside the idle time (30 min); subtracting it too would give 10 min.
    expect(runWorkMs(run('a', 1, { wall: 60 * MIN, idle: 30 * MIN, limitHold: 20 * MIN }).usage)).toBe(30 * MIN)
    expect(runWorkMs(run('a', 1, { wall: 10 * MIN, idle: 8 * MIN, waiting: 8 * MIN }).usage)).toBe(0)
  })

  it('is null without usage and tolerates records that lack the newer timers', () => {
    expect(runWorkMs(undefined)).toBeNull()
    expect(runWorkMs({ wallMs: 5 * MIN } as never)).toBe(5 * MIN)
    expect(runWorkMs({ wallMs: Number.NaN } as never)).toBeNull()
  })

  it('sums per day and marks a day with a run lacking usage as a lower bound', () => {
    const days = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 0, wall: 130 * MIN }), run('b', at(2026, 11, 7, 10), { wall: 0 }), run('c', at(2026, 11, 6, 9))], NOW)
    expect(days[6].workMs).toBe(130 * MIN)
    expect(days[6].workPartial).toBe(false)
    expect(days[5].workMs).toBe(0)
    expect(days[5].workPartial).toBe(true)
    expect(ledgerTotals(days).workPartial).toBe(true)
  })
})

describe('cost', () => {
  it('has no cost kind on an empty day or one that spent nothing', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 0 })], NOW)
    expect(days[5].costKind).toBe('none')
    expect(days[6].costKind).toBe('none')
    expect(days[6].runs).toBe(1)
  })

  it('treats a reported zero from a provider as nothing spent, never "$0.00"', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 0, source: 'provider' })], NOW)
    expect(days[6].costKind).toBe('none')
    expect(costText(days[6].cost)).toBe('')
  })

  it('sums known costs', () => {
    const days = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 1.5 }), run('b', at(2026, 11, 7, 10), { cost: 0.5 })], NOW)
    expect(days[6].costKind).toBe('known')
    expect(costText(days[6].cost)).toBe('$2.00')
  })

  it('keeps unknown unknown, never $0', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: null })], NOW)
    expect(days[6].costKind).toBe('unknown')
    expect(costText(days[6].cost)).not.toContain('$0')
  })

  it('marks a day partial when a known cost sits beside an unknown one, or a run is itself partial', () => {
    const mixed = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 1 }), run('b', at(2026, 11, 7, 10), { cost: null })], NOW)
    expect(mixed[6].costKind).toBe('partial')
    expect(costText(mixed[6].cost)).toContain('$1.00+')
    const flagged = dayLedger([run('a', at(2026, 11, 7), { cost: 1, partial: true })], NOW)
    expect(flagged[6].costKind).toBe('partial')
  })

  it('reads a lower bound of zero as unknown, not "$0.00+"', () => {
    expect(costView(honestCost({ costUsd: 0, costSource: 'provider', costPartial: true })).kind).toBe('unknown')
  })

  it('totals runs and cost over the days, partial when any day is unknown beside a known one', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 1 }), run('b', at(2026, 11, 5), { cost: null }), run('c', at(2026, 11, 4))], NOW)
    const t = ledgerTotals(days)
    expect(t.runs).toBe(3)
    expect(t.costKind).toBe('partial')
    expect(ledgerTotals(dayLedger([], NOW))).toMatchObject({ runs: 0, failed: 0, costKind: 'none', workMs: 0, workPartial: false })
  })
})

describe('names and bars', () => {
  it('scales linearly from zero with a 2 px floor and never past the track', () => {
    expect(barHeight(40, 40, 40)).toBe(40)
    expect(barHeight(1, 40, 40)).toBe(2)
    expect(barHeight(0, 40, 40)).toBe(0)
    expect(barHeight(9, 4, 56)).toBe(56)
  })

  it('names a day and its weekday initial in en-GB parts', () => {
    const start = at(2026, 11, 4, 0)
    expect(dayName(start)).toBe('Wed 4 Nov')
    expect(weekdayInitial(start)).toBe('W')
  })
})
