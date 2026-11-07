import { describe, expect, it } from 'vitest'
import type { RunUsage, UsageOverviewRow } from '@shared/types'
import { rowCacheHit, rowCostInput, rowModels, rowName, rowStatusWord, runsScrollTopFor, runsWindow, sortRunRows } from './usageRuns'

function row(over: Partial<UsageOverviewRow> = {}, u: Partial<RunUsage> = {}): UsageOverviewRow {
  return {
    runId: 'r',
    kind: 'work',
    status: 'finished',
    prompt: 'Add caching',
    startedAt: 100,
    projectId: 'p',
    projectName: 'P',
    projectKind: 'code',
    usage: {
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      costUsd: 1,
      costSource: 'computed',
      models: [],
      roles: [],
      wallMs: 0,
      turns: 0,
      toolCalls: 0,
      retries: 0,
      agents: 1,
      agentsWithoutResult: 0,
      noResultTokens: 0,
      nudges: 0,
      waitingMs: 0,
      limitHoldMs: 0,
      idleMs: 0,
      updatedAt: 1,
      ...u
    },
    ...over
  } as UsageOverviewRow
}

describe('row view-models', () => {
  it('names a run and carries legacy and partial marks into the cost input', () => {
    expect(rowName(row({ title: 'Cache work' }))).toBe('Cache work')
    expect(rowCostInput(row({ legacy: true }, { legacy: true, costPartial: true }))).toMatchObject({ legacy: true, costPartial: true, sourceMixed: true })
  })

  it('reads cache hit as a dash with a reason when not reported', () => {
    expect(rowCacheHit(row())).toMatchObject({ text: '—', title: 'Not reported', rate: null })
    expect(rowCacheHit(row({}, { tokens: { input: 100, output: 1, cacheRead: 300, cacheWrite: 0 } })).text).toBe('75%')
    expect(rowCacheHit(row({ legacy: true }, { legacy: true })).rate).toBeNull()
  })

  it('lists models by tokens with a +N', () => {
    const m = (model: string, input: number) => ({ model, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, priceSource: 'builtin' as const })
    expect(rowModels(row({}, { models: [m('a', 1), m('b', 9), m('c', 5)] })).text).toBe('b +2')
    expect(rowModels(row()).text).toBe('—')
  })

  it('uses the shared status words', () => {
    expect(rowStatusWord(row()).word).toBe('Finished')
    expect(rowStatusWord(row({ status: 'error' })).word).toBe('Failed')
    expect(rowStatusWord(row({ endedBy: 'user' })).word).toBe('Stopped')
    expect(rowStatusWord(row({ status: 'running' })).word).toBe('Running')
  })
})

describe('sortRunRows', () => {
  const a = row({ runId: 'a', startedAt: 1, title: 'Alpha' }, { costUsd: 5 })
  const b = row({ runId: 'b', startedAt: 2, title: 'Beta' }, { costUsd: 1 })
  const u = row({ runId: 'u', startedAt: 3, title: 'Unknown' }, { costUsd: null, costSource: 'unknown' })

  it('keeps unknown cost last in both directions', () => {
    expect(sortRunRows([u, a, b], 'cost', 'desc').map((r) => r.runId)).toEqual(['a', 'b', 'u'])
    expect(sortRunRows([u, a, b], 'cost', 'asc').map((r) => r.runId)).toEqual(['b', 'a', 'u'])
  })
  it('sorts by name and by date', () => {
    expect(sortRunRows([b, a], 'run', 'asc').map((r) => r.runId)).toEqual(['a', 'b'])
    expect(sortRunRows([a, b], 'when', 'desc').map((r) => r.runId)).toEqual(['b', 'a'])
  })
})

describe('runsWindow', () => {
  it('renders the visible rows plus overscan and spacers that add up', () => {
    const w = runsWindow(1000, 4400, 440, 44, 5)
    expect(w.start).toBe(95)
    expect(w.end).toBe(110 + 5)
    expect(w.before + (w.end - w.start) * 44 + w.after).toBe(1000 * 44)
  })
  it('clamps at the ends', () => {
    expect(runsWindow(10, 0, 400, 44, 5)).toMatchObject({ start: 0, end: 10, after: 0 })
    expect(runsWindow(0, 0, 400).end).toBe(0)
  })
  it('scrolls the least', () => {
    expect(runsScrollTopFor(2, 0, 440, 44)).toBe(0)
    expect(runsScrollTopFor(20, 0, 440, 44)).toBe(20 * 44 + 44 - 440)
    expect(runsScrollTopFor(1, 400, 440, 44)).toBe(44)
  })
})
