import { describe, expect, it } from 'vitest'
import type { ModelUsageEntry, RunEfficiency, RunUsage, UsageOverviewRow } from '@shared/types'
import { tierForModel } from '@shared/defaults'
import { costByTier, leadComparison, makeTierOf, OTHER_TIER_LABEL, overlapText, reportTiming, reportTimingSummary } from './usageStaffing'

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    tokens: { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
    costUsd: 1,
    costSource: 'computed',
    models: [],
    roles: [],
    wallMs: 100_000,
    turns: 10,
    toolCalls: 5,
    retries: 0,
    agents: 1,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: 1,
    ...over
  } as RunUsage
}

let n = 0
function row(u: Partial<RunUsage> = {}, over: Partial<UsageOverviewRow> = {}): UsageOverviewRow {
  n++
  return { runId: `r${n}`, kind: 'work', status: 'finished', prompt: 'p', startedAt: n, projectId: 'p1', projectName: 'P', projectKind: 'code', usage: usage(u), ...over } as UsageOverviewRow
}

const eff = (o: Partial<RunEfficiency> = {}): RunEfficiency => ({ reports: 2, firstSpawnMs: 10_000, reportSumMs: 60_000, reportBusyMs: 40_000, maxParallel: 2, tailMs: 20_000, ...o })
const model = (m: string, costUsd: number | null, priceSource: ModelUsageEntry['priceSource'] = 'builtin'): ModelUsageEntry => ({
  model: m,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  costUsd,
  priceSource
})

describe('reportTiming', () => {
  it('derives the three signals', () => {
    expect(reportTiming(row({ efficiency: eff() }))).toMatchObject({ firstSpawnMs: 10_000, overlap: 1.5, tailShare: 0.2 })
  })
  it('is null without a report or an efficiency record', () => {
    expect(reportTiming(row({ efficiency: eff({ reports: 0 }) }))).toBeNull()
    expect(reportTiming(row())).toBeNull()
  })
  it('guards zero busy time and missing wall time', () => {
    expect(reportTiming(row({ efficiency: eff({ reportBusyMs: 0 }) }))?.overlap).toBeNull()
    expect(reportTiming(row({ wallMs: 0, efficiency: eff() }))?.tailShare).toBeNull()
  })
  it('keeps overlap at least 1 and the tail share within 0..1', () => {
    const t = reportTiming(row({ wallMs: 10_000, efficiency: eff({ reportSumMs: 30_000, reportBusyMs: 40_000, tailMs: 50_000 }) }))!
    expect(t.overlap).toBe(1)
    expect(t.tailShare).toBe(1)
  })
})

describe('reportTimingSummary', () => {
  it('takes medians over report runs only', () => {
    const rows = [
      row({ efficiency: eff({ firstSpawnMs: 10_000, reportSumMs: 40_000, reportBusyMs: 40_000 }) }),
      row({ efficiency: eff({ firstSpawnMs: 30_000, reportSumMs: 80_000, reportBusyMs: 40_000 }) }),
      row({ efficiency: eff({ firstSpawnMs: 50_000, reportSumMs: 120_000, reportBusyMs: 40_000 }) }),
      row()
    ]
    expect(reportTimingSummary(rows)).toMatchObject({ runs: 3, firstSpawnMs: 30_000, overlap: 2 })
  })
  it('is empty without report runs', () => {
    expect(reportTimingSummary([row(), row()])).toEqual({ runs: 0, firstSpawnMs: null, overlap: null, tailShare: null })
  })
  it('skips a run that cannot give a signal in that signal only', () => {
    const s = reportTimingSummary([row({ efficiency: eff({ reportBusyMs: 0 }) }), row({ efficiency: eff({ reportSumMs: 80_000, reportBusyMs: 40_000 }) })])
    expect(s.runs).toBe(2)
    expect(s.overlap).toBe(2)
  })
  it('formats overlap', () => {
    expect(overlapText(1.84)).toBe('1.8x')
    expect(overlapText(null)).toBe('—')
  })
})

describe('costByTier', () => {
  const tierOf = makeTierOf([{ id: 'litellm', tierModels: { top: 'gpt-x', fast: 'tiny-1' } }], tierForModel)
  const sum = (p: { costUsd: number }[] | null): number => (p ?? []).reduce((a, b) => a + b.costUsd, 0)

  it('splits by tier and the parts add up to the total', () => {
    const rows = [
      row({ costUsd: 1, models: [model('opus', 0.6), model('haiku', 0.2), model('mystery', 0.1)] }),
      row({ costUsd: 0.5, models: [model('sonnet', 0.5)] }, { connection: 'anthropic' })
    ]
    const parts = costByTier(rows, 1.5, tierOf)!
    expect(parts.map((p) => p.key)).toEqual(['deep', 'everyday', 'fast', 'other'])
    expect(sum(parts)).toBeCloseTo(1.5, 10)
    expect(parts.find((p) => p.key === 'other')).toMatchObject({ label: OTHER_TIER_LABEL })
    expect(parts.find((p) => p.key === 'other')!.costUsd).toBeCloseTo(0.2, 10)
  })
  it('uses the connection tier mapping before the alias fallback', () => {
    const parts = costByTier([row({ models: [model('gpt-x', 0.4), model('tiny-1', 0.1)] }, { connection: 'litellm' })], 0.5, tierOf)!
    expect(parts.map((p) => p.key)).toEqual(['top', 'fast'])
  })
  it('puts unpriced models and a larger provider total in the remainder', () => {
    const parts = costByTier([row({ models: [model('opus', 0.3), model('sonnet', null, 'unknown')] })], 1, tierOf)!
    expect(parts.map((p) => p.key)).toEqual(['deep', 'other'])
    expect(sum(parts)).toBeCloseTo(1, 10)
  })
  it('scales down when model parts exceed the total', () => {
    const parts = costByTier([row({ models: [model('opus', 2)] })], 1, tierOf)!
    expect(parts).toHaveLength(1)
    expect(sum(parts)).toBeCloseTo(1, 10)
  })
  it('narrows to one model', () => {
    const parts = costByTier([row({ models: [model('opus', 0.6), model('haiku', 0.2)] })], 0.6, tierOf, 'opus')!
    expect(parts.map((p) => p.key)).toEqual(['deep'])
  })
  it('is null for an unknown or zero total', () => {
    expect(costByTier([row({ models: [model('opus', 1)] })], null, tierOf)).toBeNull()
    expect(costByTier([], 0, tierOf)).toBeNull()
  })
  it('puts everything in the remainder when no model maps', () => {
    const parts = costByTier([row({ models: [model('mystery', 1)] })], 1, tierOf)!
    expect(parts.map((p) => p.key)).toEqual(['other'])
    expect(parts[0]!.share).toBeCloseTo(1, 10)
  })
})

describe('leadComparison', () => {
  it('compares lead-alone and with-report team runs by median wall time and cost', () => {
    const rows = [
      row({ wallMs: 60_000, costUsd: 0.1 }),
      row({ wallMs: 100_000, costUsd: 0.3 }),
      row({ wallMs: 300_000, costUsd: 0.9, agents: 3, efficiency: eff() }),
      row({ wallMs: 500_000, costUsd: 0.5, agents: 2, efficiency: eff() }),
      row({ wallMs: 400_000, costUsd: 0.7, agents: 4, efficiency: eff() })
    ]
    const c = leadComparison(rows)
    expect(c.alone).toMatchObject({ runs: 2, medianWallMs: 80_000, costKnownRuns: 2 })
    expect(c.alone.medianCostUsd).toBeCloseTo(0.2, 10)
    expect(c.withReports).toMatchObject({ runs: 3, medianWallMs: 400_000, medianCostUsd: 0.7 })
  })
  it('leaves out ask, setup, legacy and pre-field multi-agent runs', () => {
    const c = leadComparison([row({}, { team: 'single' }), row({}, { kind: 'setup' }), row({ legacy: true }), row({ agents: 3 })])
    expect(c.alone.runs).toBe(0)
    expect(c.withReports.runs).toBe(0)
  })
  it('has null medians for an empty group and ignores unknown costs', () => {
    const c = leadComparison([row({ costUsd: null, costSource: 'unknown' })])
    expect(c.withReports).toEqual({ runs: 0, medianWallMs: null, medianCostUsd: null, costKnownRuns: 0 })
    expect(c.alone).toMatchObject({ runs: 1, medianCostUsd: null, costKnownRuns: 0 })
  })
})
