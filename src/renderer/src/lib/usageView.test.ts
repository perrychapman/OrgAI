import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunUsage } from '@shared/types'
import { agentRow, agentRows, agentSignals, formatHitRate, roleRows, runSignals, timeRows, tokenRows, skillRows, skillLoadsFromTranscript } from './usageView'

const tokens = { input: 100, output: 50, cacheRead: 300, cacheWrite: 100 }

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    tokens,
    costUsd: 1,
    costSource: 'computed',
    models: [],
    roles: [],
    wallMs: 600_000,
    turns: 4,
    toolCalls: 9,
    retries: 0,
    agents: 3,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: 0,
    ...over
  }
}

function agent(over: Partial<AgentInstance> = {}): AgentInstance {
  return { id: 'a', name: 'Dev', roleSlug: 'dev', parentId: 'root', state: 'working', inputTokens: 10, outputTokens: 5, costUsd: 0, ...over } as AgentInstance
}

describe('usageView', () => {
  it('lists the four token kinds', () => {
    expect(tokenRows(tokens).map((r) => [r.kind, r.value])).toEqual([
      ['input', 100],
      ['output', 50],
      ['cacheRead', 300],
      ['cacheWrite', 100]
    ])
  })

  it('formats the cache hit rate', () => {
    expect(formatHitRate(tokens)).toBe('60%')
    expect(formatHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBe('—')
  })

  it('falls back to counters for an agent without usage', () => {
    const r = agentRow(agent())
    expect(r.total).toBe(15)
    expect(r.approximate).toBe(true)
  })

  it('marks agents that ended without a result', () => {
    expect(agentRow(agent({ state: 'done' })).producedNothing).toBe(true)
    expect(agentRow(agent({ state: 'done', result: 'ok' })).producedNothing).toBe(false)
  })

  it('never flags the root as producing nothing', () => {
    const root = agentRow(agent({ id: 'root', parentId: null, state: 'done' }))
    expect(root.isRoot).toBe(true)
    expect(root.producedNothing).toBe(false)
    const rows = agentRows([agent({ id: 'root', parentId: null, state: 'done' }), agent({ id: 'x', state: 'done' })])
    expect(runSignals(usage({ agentsWithoutResult: 2, noResultTokens: 30 }), rows)[0]).toBe('1 agent spent 15 tokens and produced no result.')
  })

  it('names same-role agents by handle or index', () => {
    const rows = agentRows([
      agent({ id: 'a', name: 'Implementer', roleSlug: 'implementer', startedAt: 2, inputTokens: 5 }),
      agent({ id: 'b', name: 'Implementer', roleSlug: 'implementer', startedAt: 1, inputTokens: 9 }),
      agent({ id: 'c', name: 'Implementer', roleSlug: 'implementer', handle: 'implementer-9', startedAt: 3, inputTokens: 1 })
    ])
    const label = (id: string): string | undefined => rows.find((r) => r.id === id)?.label
    expect(label('b')).toBe('implementer-1')
    expect(label('a')).toBe('implementer-2')
    expect(label('c')).toBe('implementer-9')
  })

  it('sorts agents by tokens', () => {
    const rows = agentRows({ a: agent({ id: 'a', inputTokens: 1 }), b: agent({ id: 'b', name: 'Big', inputTokens: 900 }) })
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('words efficiency signals', () => {
    const s = runSignals(usage({ agentsWithoutResult: 2, noResultTokens: 14_000, retries: 1, waitingMs: 300_000, limitHoldMs: 60_000, nudges: 3 }))
    expect(s[0]).toBe('2 agents spent 14k tokens and produced no result.')
    expect(s).toContain('1 API retry slowed the run down.')
    expect(s.some((x) => x.startsWith('50% of the run'))).toBe(true)
    expect(s).toContain('The harness sent 3 automatic continues.')
    expect(runSignals(usage())).toEqual([])
  })

  it('ignores short or small waits', () => {
    expect(runSignals(usage({ waitingMs: 10_000, wallMs: 20_000 }))).toEqual([])
    expect(runSignals(usage({ waitingMs: 60_000 }))).toEqual([])
  })

  it('has agent signals', () => {
    expect(agentSignals(agentRow(agent({ state: 'error' })))[0]).toMatch(/produced nothing/)
  })

  it('shows optional times only when non-zero', () => {
    expect(timeRows(usage()).map((t) => t.id)).toEqual(['wall'])
    expect(timeRows(usage({ idleMs: 5000, waitingMs: 1000 })).map((t) => t.id)).toEqual(['wall', 'waiting', 'idle'])
  })

  it('dims roles that produced nothing', () => {
    const role = { roleId: 'r', roleSlug: 'qa', roleName: 'QA', agents: 2, tokens, costUsd: 1, costSource: 'computed' as const, turns: 1, toolCalls: 1, retries: 0, agentWallMs: 1, agentsWithoutResult: 2, noResultTokens: 5, models: [] }
    expect(roleRows(usage({ roles: [role] }))[0].dim).toBe(true)
  })
})

describe('skillRows', () => {
  it('sorts by loads, words the count and joins roles', () => {
    const rows = skillRows({ skills: [{ skillId: 'a', name: 'a', loads: 1, roles: [] }, { skillId: 'b', name: 'b', loads: 3, roles: ['qa', 'dev'] }] })
    expect(rows.map((r) => r.name)).toEqual(['b', 'a'])
    expect(rows[0]).toMatchObject({ loadsText: 'Loaded 3 times', roles: 'qa, dev' })
    expect(rows[1].loadsText).toBe('Loaded 1 time')
  })
  it('is empty without skills', () => {
    expect(skillRows({})).toEqual([])
  })
  it('counts agents and scopes to one agent from the transcript', () => {
    const e = (agentId: string, text: string) => ({ agentId, source: 'harness' as const, block: { kind: 'system' as const, text } })
    const entries = [e('a1', 'Loaded skill api'), e('a2', 'Loaded skill api'), e('a2', 'Loaded skill api'), e('a1', 'Loaded skill other')]
    const u = { skills: [{ skillId: 's1', name: 'api', loads: 3, roles: ['dev'] }] }
    expect(skillRows(u, skillLoadsFromTranscript(entries))[0]).toMatchObject({ agents: 2, agentsText: '2 agents' })
    const own = skillRows(u, skillLoadsFromTranscript(entries, 'a2'), true)
    expect(own.map((r) => [r.name, r.loadsText])).toEqual([['api', 'Loaded 2 times']])
  })
})
