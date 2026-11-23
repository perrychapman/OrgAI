import { describe, expect, it } from 'vitest'
import type { ProjectSpend } from '@shared/types'
import { RUN_ADD_BUDGET_MAX_USD } from '@shared/types'
import {
  addBudgetRefusal,
  capPeriods,
  capsReached,
  capValue,
  dueWarnings,
  money,
  raiseConversationCap,
  spendLimitMode,
  spendLimitReason,
  startRefusal,
  warnPercentOf,
  warnText,
  type WarnScope
} from './spendGuard'

const DAY_END = 1_800_000_000_000
const MONTH_END = DAY_END + 20 * 86_400_000

function spend(over: { day?: number; month?: number; maxDailyUsd?: number; maxMonthlyUsd?: number } = {}): ProjectSpend {
  return {
    projectId: 'p1',
    day: { spentUsd: over.day ?? 0, runs: 1, unknownRuns: 0, from: DAY_END - 86_400_000, until: DAY_END },
    month: { spentUsd: over.month ?? 0, runs: 1, unknownRuns: 0, from: MONTH_END - 30 * 86_400_000, until: MONTH_END },
    ...(over.maxDailyUsd !== undefined ? { maxDailyUsd: over.maxDailyUsd } : {}),
    ...(over.maxMonthlyUsd !== undefined ? { maxMonthlyUsd: over.maxMonthlyUsd } : {}),
    monthProjectionUsd: null,
    generatedAt: 0
  }
}

describe('caps', () => {
  it('only counts a finite cap above zero', () => {
    expect(capValue(5)).toBe(5)
    for (const v of [0, -1, NaN, Infinity, '5', null, undefined]) expect(capValue(v)).toBeUndefined()
  })

  it('lists the periods that have a cap, day first, with their reset', () => {
    expect(capPeriods(spend())).toEqual([])
    expect(capPeriods(spend({ maxMonthlyUsd: 30, month: 4, maxDailyUsd: 5, day: 1 }))).toEqual([
      { scope: 'day', limitUsd: 5, spentUsd: 1, resetsAt: DAY_END },
      { scope: 'month', limitUsd: 30, spentUsd: 4, resetsAt: MONTH_END }
    ])
  })

  it('a cap is reached when spend is at or over it, not below', () => {
    expect(capsReached(spend({ maxDailyUsd: 5, day: 4.99 }))).toEqual([])
    expect(capsReached(spend({ maxDailyUsd: 5, day: 5 }))).toHaveLength(1)
    expect(capsReached(spend({ maxDailyUsd: 5, day: 7, maxMonthlyUsd: 10, month: 10 })).map((c) => c.scope)).toEqual(['day', 'month'])
  })

  it('refuses a start at a reached cap with a plain sentence naming the limit; none without a cap or below it', () => {
    expect(startRefusal(undefined)).toBeNull()
    expect(startRefusal(spend({ day: 100 }))).toBeNull()
    expect(startRefusal(spend({ maxDailyUsd: 5, day: 4 }))).toBeNull()
    expect(startRefusal(spend({ maxDailyUsd: 5, day: 5 }))).toContain('daily spending limit of $5.00')
    expect(startRefusal(spend({ maxMonthlyUsd: 30, month: 31 }))).toContain('monthly spending limit of $30.00')
    // the day comes first when both are reached
    expect(startRefusal(spend({ maxDailyUsd: 5, day: 5, maxMonthlyUsd: 30, month: 31 }))).toContain('daily')
  })

  it('pauses unless the project says stop, and an exec run always stops', () => {
    expect(spendLimitMode(undefined, false)).toBe('pause')
    expect(spendLimitMode('pause', false)).toBe('pause')
    expect(spendLimitMode('stop', false)).toBe('stop')
    expect(spendLimitMode('junk', false)).toBe('pause')
    expect(spendLimitMode('pause', true)).toBe('stop')
  })

  it('words the pause and the stop differently', () => {
    const cap = { scope: 'day' as const, limitUsd: 5, spentUsd: 5.2, resetsAt: DAY_END }
    expect(spendLimitReason(cap, 'pause')).toContain('paused until the day resets')
    expect(spendLimitReason(cap, 'stop')).toContain('was stopped')
  })

  it('formats money to cents', () => {
    expect(money(5)).toBe('$5.00')
    expect(money(0.125)).toBe('$0.13')
  })
})

describe('addBudgetRefusal', () => {
  it('refuses non-numbers, zero, negatives, NaN and Infinity', () => {
    for (const v of [undefined, '5', 0, -1, NaN, Infinity]) expect(addBudgetRefusal({ addUsd: v })).toBe('Choose an amount above $0.')
  })

  it('refuses more than the most one add may be', () => {
    expect(addBudgetRefusal({ addUsd: RUN_ADD_BUDGET_MAX_USD + 1 })).toContain('at most $1000.00')
    expect(addBudgetRefusal({ addUsd: RUN_ADD_BUDGET_MAX_USD })).toBeNull()
  })

  it("keeps the project's per-run cap as the ceiling and says where to raise it", () => {
    const r = addBudgetRefusal({ addUsd: 6, projectCapUsd: 5 })
    expect(r).toContain('$5.00')
    expect(r).toContain("Raise the project's limit in Settings")
    expect(addBudgetRefusal({ addUsd: 5, projectCapUsd: 5 })).toBeNull()
    expect(addBudgetRefusal({ addUsd: 500 })).toBeNull()
  })

  it('refuses more than what is left of the daily or monthly cap', () => {
    expect(addBudgetRefusal({ addUsd: 3, spend: spend({ maxDailyUsd: 10, day: 8 }) })).toContain('Only $2.00 is left of this project\'s daily spending limit')
    expect(addBudgetRefusal({ addUsd: 2, spend: spend({ maxDailyUsd: 10, day: 8 }) })).toBeNull()
    expect(addBudgetRefusal({ addUsd: 5, spend: spend({ maxMonthlyUsd: 20, month: 18 }) })).toContain('monthly')
    // a cap already reached is the start refusal
    expect(addBudgetRefusal({ addUsd: 1, spend: spend({ maxDailyUsd: 10, day: 10 }) })).toContain('reached its daily spending limit')
  })
})

describe('raiseConversationCap', () => {
  it('raises the total by the amount, bounded by the project cap', () => {
    expect(raiseConversationCap({ conversationUsd: 5, addUsd: 2, spentUsd: 5 })).toEqual({ totalUsd: 7 })
    expect(raiseConversationCap({ conversationUsd: 5, addUsd: 2, spentUsd: 5, projectCapUsd: 6 })).toEqual({ totalUsd: 6 })
  })

  it('refuses when the project cap leaves nothing more to spend', () => {
    const r = raiseConversationCap({ conversationUsd: 5, addUsd: 2, spentUsd: 5, projectCapUsd: 5 })
    expect(r).toMatchObject({ refusal: expect.stringContaining("Raise the project's limit in Settings") })
  })
})

describe('spend warnings', () => {
  it('only a percent from 50 to 99 turns warnings on', () => {
    expect(warnPercentOf(80)).toBe(80)
    for (const v of [undefined, null, 0, 49, 100, NaN, '80']) expect(warnPercentOf(v)).toBeUndefined()
  })

  it('warns at the percent of a limit, once per scope', () => {
    const items = [
      { scope: 'run' as const, limitUsd: 10, spentUsd: 7.99 },
      { scope: 'day' as const, limitUsd: 10, spentUsd: 8 }
    ]
    const first = dueWarnings(items, 80, new Set<WarnScope>(), 5)
    expect(first).toEqual([{ scope: 'day', limitUsd: 10, spentUsd: 8, percent: 80, at: 5 }])
    expect(dueWarnings(items, 80, new Set<WarnScope>(['day']), 6)).toEqual([])
    expect(dueWarnings(items, undefined, new Set<WarnScope>(), 6)).toEqual([])
    // a duplicate scope in one call warns once
    expect(dueWarnings([...items, { scope: 'day', limitUsd: 10, spentUsd: 9 }], 80, new Set<WarnScope>(), 7)).toHaveLength(1)
  })

  it('ignores a limit that is not a positive number', () => {
    expect(dueWarnings([{ scope: 'run', limitUsd: 0, spentUsd: 1 }, { scope: 'month', limitUsd: NaN, spentUsd: 1 }], 50, new Set<WarnScope>(), 1)).toEqual([])
  })

  it('words each scope', () => {
    expect(warnText({ scope: 'run', limitUsd: 10, spentUsd: 8, percent: 80, at: 0 })).toBe("You have used 80% of this run's spending limit ($8.00 of $10.00).")
    expect(warnText({ scope: 'month', limitUsd: 10, spentUsd: 9, percent: 80, at: 0 })).toContain("project's monthly spending limit")
  })
})
