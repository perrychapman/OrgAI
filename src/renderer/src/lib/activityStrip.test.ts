import { describe, expect, it } from 'vitest'
import type { CostSource, RunStatus } from '@shared/types'
import { barHeight, dayAriaLabel, dayKey, dayLedger, dayReadout, ledgerTicks, ledgerTotals, maxDayCost, outcomeOf, type LedgerRun } from './activityStrip'

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0).getTime()
const NOW = at(2026, 11, 7, 15)

function run(id: string, startedAt: number, over: Partial<LedgerRun> & { cost?: number | null; source?: CostSource; partial?: boolean; waiting?: number } = {}): LedgerRun {
  const { cost, source, partial, waiting, ...rest } = over
  const usage =
    cost === undefined && waiting === undefined
      ? undefined
      : ({
          costUsd: cost ?? 0,
          costSource: source ?? (cost === null ? 'unknown' : cost === 0 || cost === undefined ? 'none' : 'provider'),
          ...(partial ? { costPartial: true } : {}),
          waitingMs: waiting ?? 0
        } as unknown as NonNullable<LedgerRun['usage']>)
  return { id, startedAt, status: 'finished' as RunStatus, totalCostUsd: 0, ...(usage ? { usage } : {}), ...rest }
}

describe('dayLedger days', () => {
  it('is 14 local days, oldest first, today last', () => {
    const days = dayLedger([], NOW)
    expect(days).toHaveLength(14)
    expect(days[13].key).toBe('2026-11-07')
    expect(days[13].today).toBe(true)
    expect(days[0].key).toBe('2026-10-25')
    expect(days.filter((d) => d.today)).toHaveLength(1)
    expect(new Set(days.map((d) => d.key)).size).toBe(14)
  })

  it('never repeats or skips a day over a month boundary or a year boundary', () => {
    const jan = dayLedger([], at(2027, 1, 3)).map((d) => d.key)
    expect(jan[0]).toBe('2026-12-21')
    expect(jan[13]).toBe('2027-01-03')
    expect(new Set(jan).size).toBe(14)
  })

  it('stays one day per step across daylight saving changes (US spring, EU autumn, US autumn)', () => {
    for (const today of [at(2026, 3, 12), at(2026, 3, 30), at(2026, 10, 28), at(2026, 11, 8)]) {
      const days = dayLedger([], today)
      expect(days).toHaveLength(14)
      expect(new Set(days.map((d) => d.key)).size).toBe(14)
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1].start)
        const cur = new Date(days[i].start)
        expect(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1).getTime()).toBe(cur.getTime())
      }
      expect(days[13].key).toBe(dayKey(today))
    }
  })

  it('works when `now` is just after midnight and just before it', () => {
    expect(dayLedger([], new Date(2026, 10, 7, 0, 0, 1).getTime())[13].key).toBe('2026-11-07')
    expect(dayLedger([], new Date(2026, 10, 7, 23, 59, 59).getTime())[13].key).toBe('2026-11-07')
  })
})

describe('dayLedger attribution', () => {
  it('counts a run on the local day it started, with its whole cost, even past midnight', () => {
    const late = new Date(2026, 10, 6, 23, 59, 0).getTime()
    const days = dayLedger([{ ...run('a', late, { cost: 2, status: 'finished' }), endedAt: late + 3_600_000 } as LedgerRun], NOW)
    expect(days.find((d) => d.key === '2026-11-06')?.runs).toBe(1)
    expect(days.find((d) => d.key === '2026-11-06')?.costUsd).toBe(2)
    expect(days.find((d) => d.key === '2026-11-07')?.runs).toBe(0)
  })

  it('drops runs outside the 14 days and counts each id once', () => {
    const days = dayLedger([run('old', at(2026, 10, 24)), run('a', at(2026, 11, 1)), run('a', at(2026, 11, 1)), run('future', at(2026, 11, 8))], NOW)
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
    const today = days[13]
    expect(today.runs).toBe(7)
    expect(today.outcomes).toEqual({ finished: 2, failed: 1, stopped: 2, open: 1, paused: 1 })
  })

  it('sums waiting time where it is present', () => {
    const days = dayLedger([run('a', at(2026, 11, 7, 9), { waiting: 60_000, cost: 0 }), run('b', at(2026, 11, 7, 10)), run('c', at(2026, 11, 7, 11), { waiting: 30_000, cost: 0 })], NOW)
    expect(days[13].waitingMs).toBe(90_000)
    expect(ledgerTotals(days).waitingMs).toBe(90_000)
  })
})

describe('dayLedger cost', () => {
  it('has no cost kind on an empty day or one that spent nothing', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 0 })], NOW)
    expect(days[12].costKind).toBe('none')
    expect(days[13].costKind).toBe('none')
    expect(days[13].runs).toBe(1)
    expect(barHeight(days[13], 5, 40)).toBe(0)
  })

  it('sums known costs', () => {
    const days = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 1.5 }), run('b', at(2026, 11, 7, 10), { cost: 0.5 })], NOW)
    expect(days[13].costKind).toBe('known')
    expect(days[13].costUsd).toBe(2)
  })

  it('keeps unknown unknown, never $0, and has no bar', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: null })], NOW)
    expect(days[13].costKind).toBe('unknown')
    expect(days[13].costUsd).toBe(0)
    expect(barHeight(days[13], 5, 40)).toBe(0)
    expect(dayReadout(days[13])).toContain('cost unknown')
    expect(dayReadout(days[13])).not.toContain('$0')
  })

  it('marks a day partial when a known cost sits beside an unknown one, or a run is itself partial', () => {
    const mixed = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 1 }), run('b', at(2026, 11, 7, 10), { cost: null })], NOW)
    expect(mixed[13].costKind).toBe('partial')
    expect(mixed[13].costUsd).toBe(1)
    expect(dayReadout(mixed[13])).toContain('$1.00+')
    const flagged = dayLedger([run('a', at(2026, 11, 7), { cost: 1, partial: true })], NOW)
    expect(flagged[13].costKind).toBe('partial')
  })

  it('totals runs and cost over the days, partial when any day is unknown beside a known one', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 1 }), run('b', at(2026, 11, 5), { cost: null }), run('c', at(2026, 11, 4))], NOW)
    const t = ledgerTotals(days)
    expect(t.runs).toBe(3)
    expect(t.costKind).toBe('partial')
    expect(ledgerTotals(dayLedger([], NOW))).toMatchObject({ runs: 0, costKind: 'none', waitingMs: 0 })
  })
})

describe('bars and ticks', () => {
  it('scales bars to the largest known day with a 2 px floor', () => {
    const days = dayLedger([run('a', at(2026, 11, 7), { cost: 4 }), run('b', at(2026, 11, 6), { cost: 1 }), run('c', at(2026, 11, 5), { cost: 0.0001 })], NOW)
    const max = maxDayCost(days)
    expect(max).toBe(4)
    expect(barHeight(days[13], max, 40)).toBe(40)
    expect(barHeight(days[12], max, 40)).toBe(10)
    expect(barHeight(days[11], max, 40)).toBe(2)
    expect(barHeight(days[0], max, 40)).toBe(0)
  })

  it('orders ticks failed, open, paused, finished, stopped and caps them with a more tick', () => {
    const o = { finished: 2, failed: 1, stopped: 1, open: 1, paused: 1 }
    expect(ledgerTicks(o, 6).map((t) => t.outcome)).toEqual(['failed', 'open', 'paused', 'finished', 'finished', 'stopped'])
    expect(ledgerTicks(o, 4).map((t) => t.outcome)).toEqual(['failed', 'open', 'paused', 'more'])
    expect(ledgerTicks({ ...o, finished: 0, failed: 0, stopped: 0, open: 0, paused: 0 }, 6)).toEqual([])
  })
})

describe('words', () => {
  it('reads out today and past days', () => {
    const days = dayLedger([run('a', at(2026, 11, 7, 9), { cost: 0.42, waiting: 12 * 60_000 }), run('b', at(2026, 11, 4, 9), { status: 'error', cost: 1.2 }), run('c', at(2026, 11, 4, 9), { cost: 0 })], NOW)
    expect(dayReadout(days[13])).toBe('Today: 1 run started · $0.42 · waited on you 12m 00s')
    expect(dayReadout(days[10])).toBe('Wed 4 Nov: 2 runs started (1 failed) · $1.20')
    expect(dayReadout(days[0])).toBe('Sun 25 Oct: no runs')
  })

  it('names a day for assistive tech without zero parts', () => {
    const days = dayLedger([run('a', at(2026, 11, 4, 9), { status: 'error', cost: 1.2 }), run('b', at(2026, 11, 4, 10))], NOW)
    expect(dayAriaLabel(days[10])).toBe('Wed 4 Nov: 2 runs (1 finished, 1 failed), cost $1.20')
    expect(dayAriaLabel(days[0])).toBe('Sun 25 Oct: no runs')
  })

  it('maps run statuses to outcomes', () => {
    expect(outcomeOf(run('a', 1, { status: 'idle' }))).toBe('open')
    expect(outcomeOf(run('a', 1, { status: 'stopping' }))).toBe('open')
  })
})
