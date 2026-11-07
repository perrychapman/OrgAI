import { describe, expect, it } from 'vitest'
import type { RunUsage, UsageOverviewRow } from '@shared/types'
import {
  effectiveWastefulSort,
  efficiencyByProject,
  efficiencyItems,
  efficiencySummary,
  median,
  minutesText,
  noResultAgentsLine,
  noResultSentence,
  percentText,
  sortEfficiencyRows,
  sortedByText,
  wastefulRuns
} from './usageEfficiency'

const names = { connectionName: (id: string) => (id === 'openai' ? 'OpenAI' : id) }

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    tokens: { input: 10_000, output: 2_000, cacheRead: 30_000, cacheWrite: 1_000 },
    costUsd: 0.5,
    costSource: 'computed',
    models: [],
    roles: [],
    wallMs: 600_000,
    turns: 10,
    toolCalls: 5,
    retries: 0,
    agents: 2,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: 1,
    ...over
  }
}

let n = 0
function row(over: Partial<UsageOverviewRow> = {}, u: Partial<RunUsage> = {}): UsageOverviewRow {
  n++
  return {
    runId: `r${n}`,
    kind: 'work',
    status: 'finished',
    prompt: 'p',
    startedAt: 1_000 + n,
    projectId: 'p1',
    projectName: 'Billing',
    projectKind: 'code',
    usage: usage(u),
    ...over
  } as UsageOverviewRow
}

const item = (rows: UsageOverviewRow[], signal: string) => efficiencyItems(rows, names).find((i) => i.signal === signal)

describe('helpers', () => {
  it('median and text', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(percentText(0.004)).toBe('<1%')
    expect(percentText(0)).toBe('0%')
    expect(percentText(0.414)).toBe('41%')
    expect(minutesText(12 * 60_000)).toBe('12 min')
    expect(minutesText(80 * 60_000)).toBe('1 h 20 min')
    expect(sortedByText('cache')).toBe('Sorted by lowest cache hit.')
  })
})

describe('efficiencyItems', () => {
  it('reports cache hit as a share of prompt tokens', () => {
    const i = item([row(), row()], 'cache')!
    expect(i.value).toBe('73%')
    expect(i.draw).toEqual({ kind: 'rail', fraction: 30_000 / 41_000 })
    expect(i.basis).toBe('Based on 2 of 2 runs.')
  })

  it('says Not reported, never 0%, when no run reports cache tokens', () => {
    const rows = [row({ connection: 'openai' }, { tokens: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0 } })]
    const i = item(rows, 'cache')!
    expect(i.value).toBe('Not reported')
    expect(i.detail).toBe('Not reported by OpenAI.')
    expect(i.draw).toEqual({ kind: 'rail', fraction: null })
  })

  it('leaves legacy rows out and says so', () => {
    const rows = [row(), row({ legacy: true }, { legacy: true })]
    expect(item(rows, 'cost-per-run')!.basis).toBe('Based on 1 of 2 runs.')
  })

  it('gives median cost excluding unknown and counts them', () => {
    const rows = [row({}, { costUsd: 1 }), row({}, { costUsd: 3 }), row({}, { costUsd: 100 }), row({}, { costUsd: null, costSource: 'unknown' }), row({}, { costUsd: 4, costPartial: true })]
    const i = item(rows, 'cost-per-run')!
    expect(i.value).toBe('$3.00')
    expect(i.detail).toContain('Mean $34.67')
    expect(i.detail).toContain('2 runs have no price')
    expect(i.draw).toMatchObject({ kind: 'range', min: 1, max: 100, median: 3 })
  })

  it('shows No price when nothing is priced', () => {
    const i = item([row({}, { costUsd: null, costSource: 'unknown' })], 'cost-per-run')!
    expect(i.value).toBe('No price')
    expect(i.value).not.toContain('$0')
  })

  it('hides tokens per turn with no turns', () => {
    expect(item([row({}, { turns: 0 })], 'tokens-per-turn')).toBeUndefined()
    const i = item([row(), row()], 'tokens-per-turn')!
    expect(i.value).toBe('4.3k')
  })

  it('counts retries per 100 turns', () => {
    const i = item([row({}, { retries: 2, turns: 10 }), row({}, { retries: 0, turns: 10 })], 'retries')!
    expect(i.value).toBe('10 per 100 turns')
    expect(i.detail).toBe('2 retries across 1 run.')
  })

  it('shares no-result tokens and nudges per run', () => {
    const rows = [row({}, { noResultTokens: 4_300, agentsWithoutResult: 1 }), row()]
    expect(item(rows, 'no-result')!.value).toBe('5%')
    expect(item(rows, 'no-result')!.detail).toBe('1 agent returned nothing in 1 run.')
    expect(item([row({}, { nudges: 3 }), row()], 'nudges')!.value).toBe('1.5 per run')
  })

  it('splits wall time into waiting, idle and limit hold', () => {
    const i = item([row({}, { wallMs: 1000, waitingMs: 180, idleMs: 70, limitHoldMs: 20 })], 'idle')!
    expect(i.value).toBe('18%')
    expect(i.detail).toBe('Waiting on you 18%, idle 7%, limit hold 2%.')
  })

  it('compares Team and Ask only with three of each', () => {
    const team = [1, 2, 3].map((c) => row({}, { costUsd: c }))
    const ask = [0.1, 0.2].map((c) => row({ team: 'single' }, { costUsd: c }))
    expect(item([...team, ...ask], 'team-vs-ask')!.value).toBe('Not enough Ask runs to compare')
    const more = [...team, ...ask, row({ team: 'single' }, { costUsd: 0.3 })]
    expect(item(more, 'team-vs-ask')!.value).toBe('Team $2.00, Ask $0.200')
  })
})

describe('noResultAgentsLine', () => {
  it('names the agents', () => {
    expect(noResultAgentsLine([])).toBeNull()
    expect(noResultAgentsLine(['a'])).toBe('a produced no result')
    expect(noResultAgentsLine(['a', 'b'])).toBe('a and b produced no result')
    expect(noResultAgentsLine(['a', 'b', 'c', 'd'])).toBe('a, b and 2 others produced no result')
  })
})

describe('efficiencySummary', () => {
  it('compares the weakest project only when others exist', () => {
    const low = (id: string, name: string) => row({ projectId: id, projectName: name }, { tokens: { input: 60_000, output: 100, cacheRead: 40_000, cacheWrite: 0 } })
    const high = (id: string, name: string) => row({ projectId: id, projectName: name }, { tokens: { input: 10_000, output: 100, cacheRead: 90_000, cacheWrite: 0 } })
    const rows = [low('a', 'Billing'), low('a', 'Billing'), low('a', 'Billing'), high('b', 'Docs'), high('b', 'Docs'), high('b', 'Docs')]
    expect(efficiencySummary(rows, names)).toBe('Cache hit in Billing is 40%, lower than the 90% your other projects reach.')
    expect(efficiencySummary([low('a', 'Billing'), low('a', 'Billing'), low('a', 'Billing')], names)).toBe('Cache hit is 40%.')
  })

  it('handles empty and legacy-only views', () => {
    expect(efficiencySummary([], names)).toBe('No runs in this view.')
    expect(efficiencySummary([row({ legacy: true }, { legacy: true })], names)).toContain('before OrgAI measured usage')
  })
})

describe('efficiencyByProject', () => {
  it('summarises per project and sorts on any column with nulls last', () => {
    const rows = [row({ projectId: 'a', projectName: 'Alpha' }, { costUsd: 2 }), row({ projectId: 'b', projectName: 'Beta' }, { costUsd: null, costSource: 'unknown' }), row({ projectId: 'b', projectName: 'Beta' }, { costUsd: null, costSource: 'unknown' })]
    const t = efficiencyByProject(rows, names)
    expect(t.map((r) => r.project)).toEqual(['Beta', 'Alpha'])
    expect(t[0]!.cells.cost).toBe('No price')
    expect(sortEfficiencyRows(t, 'cost', 'desc').map((r) => r.project)).toEqual(['Alpha', 'Beta'])
    expect(sortEfficiencyRows(t, 'cost', 'asc').map((r) => r.project)).toEqual(['Alpha', 'Beta'])
    expect(sortEfficiencyRows(t, 'project', 'asc').map((r) => r.project)).toEqual(['Alpha', 'Beta'])
  })
})

describe('wastefulRuns', () => {
  const agent = (name: string) => ({ agentId: name, name, roleName: 'Implementer', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 })

  it('writes the why sentences from the spec', () => {
    const one = row({}, { agentsWithoutResult: 1, noResultTokens: 820, noResultCostUsd: 0.02, noResultAgents: [agent('implementer-2')] })
    expect(noResultSentence(one)).toBe('implementer-2 spent 820 tokens and produced no result')
    const two = row({}, { agentsWithoutResult: 2, noResultTokens: 1640, noResultCostUsd: 0.04, noResultAgents: [agent('implementer-2'), agent('implementer-3')] })
    expect(noResultSentence(two)).toBe('implementer-2 and 1 other spent 1,640 tokens and produced no result')
    expect(wastefulRuns([one], 'no-result')[0]!.why).toBe('implementer-2 spent 820 tokens and produced no result')
    expect(wastefulRuns([row({}, { retries: 2 })], 'retries')[0]!.why).toBe('Retried 2 times')
    expect(wastefulRuns([row({}, { nudges: 3 })], 'nudges')[0]!.why).toBe('Auto-continued 3 times')
    expect(wastefulRuns([row({}, { idleMs: 300_000, wallMs: 600_000, waitingMs: 720_000 })], 'idle')[0]!.why).toBe('Idle 5 min, 50% of its time; waited on you 12 min')
    expect(wastefulRuns([row({}, { tokens: { input: 20_000, output: 10, cacheRead: 9_000, cacheWrite: 0 } })], 'cache')[0]!.why).toBe('Cache hit 31%')
  })

  it('ranks no-result by its cost plus failed runs, unknown after known', () => {
    const a = row({}, { agentsWithoutResult: 1, noResultTokens: 100, noResultCostUsd: 0.5 })
    const b = row({ status: 'error' }, { costUsd: 2, agentsWithoutResult: 1, noResultTokens: 100, noResultCostUsd: 0.5 })
    const c = row({}, { agentsWithoutResult: 1, noResultTokens: 900, noResultCostUsd: null })
    const d = row({}, { agentsWithoutResult: 1, noResultTokens: 100, noResultCostUsd: null })
    const e = row({})
    const list = wastefulRuns([a, b, c, d, e], 'no-result')
    expect(list.map((x) => x.row)).toEqual([b, a, c, d])
    expect(list[0]!.why).toContain('the run failed')
    expect(list[2]!.unknownCost).toBe(true)
    expect(list.every((x) => x.noResult)).toBe(true)
  })

  it('falls back to cost when no row carries noResultCostUsd', () => {
    expect(effectiveWastefulSort('no-result', [row()])).toBe('cost')
    expect(effectiveWastefulSort('no-result', [row({}, { noResultCostUsd: 0 })])).toBe('no-result')
    expect(effectiveWastefulSort('retries', [row()])).toBe('retries')
  })

  it('sorts by cost with unknown last by tokens', () => {
    const cheap = row({}, { costUsd: 0.1 })
    const dear = row({}, { costUsd: 5 })
    const unk = row({}, { costUsd: null, costSource: 'unknown' })
    const list = wastefulRuns([cheap, unk, dear], 'cost')
    expect(list.map((x) => x.row)).toEqual([dear, cheap, unk])
    expect(list[2]!.why).toContain('Cost unknown')
  })

  it('lists cache only for runs of 20k input tokens or more that report it, lowest first', () => {
    const tiny = row({}, { tokens: { input: 500, output: 1, cacheRead: 0, cacheWrite: 0 } })
    const unreported = row({}, { tokens: { input: 50_000, output: 1, cacheRead: 0, cacheWrite: 0 } })
    const low = row({}, { tokens: { input: 30_000, output: 1, cacheRead: 10_000, cacheWrite: 0 } })
    const high = row({}, { tokens: { input: 10_000, output: 1, cacheRead: 30_000, cacheWrite: 0 } })
    expect(wastefulRuns([tiny, unreported, high, low], 'cache').map((x) => x.row)).toEqual([low, high])
  })

  it('is empty when nothing has a signal', () => {
    expect(wastefulRuns([row()], 'retries')).toEqual([])
    expect(wastefulRuns([row()], 'no-result')).toEqual([])
  })
})
