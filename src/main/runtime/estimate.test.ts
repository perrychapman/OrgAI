import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../shared/types'
import { estimateRun, knownRunCostUsd, percentile, rangeOf } from './estimate'

const NOW = Date.UTC(2026, 10, 20, 12)
const DAY = 86_400_000

export function run(over: Partial<RunSummary> & { cost?: number | null; source?: 'provider' | 'computed' | 'unknown' | 'none'; minutes?: number; ageDays?: number } = {}): RunSummary {
  const { cost = 1, source = 'computed', minutes = 10, ageDays = 1, ...rest } = over
  const startedAt = NOW - ageDays * DAY
  const base = {
    id: `r${Math.random()}`,
    projectId: 'p1',
    kind: 'work',
    status: 'finished',
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    totalCostUsd: cost ?? 0,
    usage: { tokens: {}, costUsd: cost, costSource: source, models: [], roles: [], wallMs: 0, turns: 0, toolCalls: 0, retries: 0, agents: 1, agentsWithoutResult: 0 },
    ...rest
  }
  return base as unknown as RunSummary
}

describe('knownRunCostUsd', () => {
  it('counts priced runs and not unknown ones', () => {
    expect(knownRunCostUsd(run({ cost: 2, source: 'provider' }))).toBe(2)
    expect(knownRunCostUsd(run({ cost: 0, source: 'computed' }))).toBe(0)
    expect(knownRunCostUsd(run({ cost: null, source: 'unknown' }))).toBeNull()
    expect(knownRunCostUsd(run({ cost: 3, source: 'none' }))).toBeNull()
    expect(knownRunCostUsd({ usage: undefined })).toBeNull()
  })
})

describe('percentile and range', () => {
  it('interpolates linearly', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2)
    expect(percentile([1, 2], 0.5)).toBe(1.5)
  })
  it('uses min/median/max below 5 values and quartiles from 5', () => {
    expect(rangeOf([3, 1, 2])).toEqual({ low: 1, median: 2, high: 3 })
    expect(rangeOf([1, 2, 3, 4, 100])).toEqual({ low: 2, median: 3, high: 4 })
  })
})

describe('estimateRun', () => {
  it('has no basis with too few runs (nulls, not zeros)', () => {
    const e = estimateRun([run(), run()], { projectId: 'p1' }, NOW)
    expect(e).toMatchObject({ basis: 'none', costUsd: null, minutes: null, sampleRuns: 2 })
    expect(e.note.length).toBeGreaterThan(0)
  })
  it('excludes unknown-cost, unfinished, setup, quick and old runs', () => {
    const runs = [
      run({ cost: 1 }),
      run({ cost: 2 }),
      run({ cost: null, source: 'unknown' }),
      run({ status: 'error' }),
      run({ kind: 'setup' }),
      run({ quick: {} as never }),
      run({ ageDays: 200 })
    ]
    const e = estimateRun(runs, { projectId: 'p1' }, NOW)
    expect(e.basis).toBe('none')
    expect(e.sampleRuns).toBe(2)
  })
  it('gives min/median/max with 3 runs and wall minutes', () => {
    const e = estimateRun([run({ cost: 1, minutes: 5 }), run({ cost: 3, minutes: 15 }), run({ cost: 2, minutes: 10 })], { projectId: 'p1' }, NOW)
    expect(e.basis).toBe('history')
    expect(e.costUsd).toEqual({ low: 1, median: 2, high: 3 })
    expect(e.minutes).toEqual({ low: 5, median: 10, high: 15 })
    expect(e.note).toContain('last 3 similar runs')
  })
  it('uses percentiles with 5 or more runs', () => {
    const runs = [1, 2, 3, 4, 100].map((c, i) => run({ cost: c, ageDays: i + 1 }))
    expect(estimateRun(runs, { projectId: 'p1' }, NOW).costUsd).toEqual({ low: 2, median: 3, high: 4 })
  })
  it('keeps only the newest 20', () => {
    const runs = Array.from({ length: 25 }, (_, i) => run({ cost: i < 20 ? 1 : 50, ageDays: i + 1 }))
    const e = estimateRun(runs, { projectId: 'p1' }, NOW)
    expect(e.sampleRuns).toBe(20)
    expect(e.costUsd?.high).toBe(1)
  })
  it('compares only the same team mode', () => {
    const single = [run({ team: 'single' }), run({ team: 'single' }), run({ team: 'single' })]
    expect(estimateRun(single, { projectId: 'p1' }, NOW).basis).toBe('none')
    expect(estimateRun(single, { projectId: 'p1', team: 'single' }, NOW).basis).toBe('history')
    expect(estimateRun([run(), run(), run()], { projectId: 'p1', team: 'single' }, NOW).basis).toBe('none')
  })
  it('prefers runs with the same exclusions when enough, else all', () => {
    const same = [run({ cost: 9, excludedRoleIds: ['a'] }), run({ cost: 9, excludedRoleIds: ['a'] }), run({ cost: 9, excludedRoleIds: ['a'] })]
    const other = [run({ cost: 1 }), run({ cost: 1 })]
    const e = estimateRun([...same, ...other], { projectId: 'p1', excludeRoleIds: ['a'] }, NOW)
    expect(e.sampleRuns).toBe(3)
    expect(e.costUsd?.median).toBe(9)
    expect(e.note).toContain('same roles left out')
    const e2 = estimateRun([...same.slice(0, 2), ...other], { projectId: 'p1', excludeRoleIds: ['a'] }, NOW)
    expect(e2.sampleRuns).toBe(4)
    expect(e2.note).toContain('other roles left out')
  })
})
