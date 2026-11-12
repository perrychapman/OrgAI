import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunRecord, RunSummary, RunUsage, TokenUsage, TranscriptEntry } from '@shared/types'
import { runSummary } from './testHelpers'
import { agentProducedNothing } from '@shared/defaults'
import { priceAgentUsage } from './pricing'
import { IntervalTimer, addTokens, bucketOf, buildUsageStats, cleanKnowledgeUsage, cleanRunEfficiency, computeRunEfficiency, computeRunUsage, countUsage, emptyAgentUsage, legacySummaryUsage, mergeCosts, normalizeRunRecord, setModelTokens, sumRunUsage, usageFromLegacyAgent, usageOf } from './runUsage'

const tok = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage => ({ input, output, cacheRead, cacheWrite })

function agent(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return { roleId: null, roleSlug: 'x', name: 'X', parentId: null, spawnToolUseId: null, state: 'done', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 0, result: 'ok', ...over }
}

/** A priced agent with one model. */
function priced(over: Partial<AgentInstance> & { id: string }, model: string, t: TokenUsage, providerCostUsd?: number): AgentInstance {
  const a = agent(over)
  setModelTokens(a, model, t, providerCostUsd)
  a.usage = priceAgentUsage(a.usage!, { overrides: [], catalog: [] })
  a.costUsd = a.usage.costUsd ?? 0
  return a
}

const inputs = (over: Partial<Parameters<typeof computeRunUsage>[2]> = {}) => ({ nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: 10_000, ...over })

describe('adapter helpers', () => {
  it('sets model tokens, recomputes totals and the legacy fields', () => {
    const a = agent({ id: 'a' })
    setModelTokens(a, 'm1', tok(10, 5, 100, 20), 0.5)
    setModelTokens(a, 'm2', tok(1, 1))
    setModelTokens(a, 'm1', tok(11, 6, 100, 20))
    expect(usageOf(a).tokens).toEqual(tok(12, 7, 100, 20))
    expect(a.inputTokens).toBe(12 + 100 + 20)
    expect(a.outputTokens).toBe(7)
    expect(a.usage!.models[0]!.providerCostUsd).toBeUndefined()
    countUsage(a, 'turns', 2)
    countUsage(a, 'toolCalls')
    expect(a.usage).toMatchObject({ turns: 2, toolCalls: 1 })
    expect(addTokens(tok(1, 2, 3, 4), tok(1, 1, 1, 1))).toEqual(tok(2, 3, 4, 5))
    expect(emptyAgentUsage().costSource).toBe('none')
  })
})

describe('IntervalTimer', () => {
  it('sums disjoint intervals and ignores repeated sets', () => {
    const t = new IntervalTimer()
    t.set(true, 100)
    t.set(true, 150)
    expect(t.elapsed(200)).toBe(100)
    t.set(false, 300)
    t.set(false, 400)
    expect(t.elapsed(1000)).toBe(200)
    t.set(true, 500)
    expect(t.isOpen).toBe(true)
    expect(t.elapsed(560)).toBe(260)
  })
})

describe('mergeCosts', () => {
  it('applies the source and partial rules', () => {
    expect(mergeCosts([])).toEqual({ costUsd: 0, costSource: 'none' })
    expect(mergeCosts([{ costUsd: 0, costSource: 'none' }])).toEqual({ costUsd: 0, costSource: 'none' })
    expect(mergeCosts([{ costUsd: null, costSource: 'unknown' }])).toEqual({ costUsd: null, costSource: 'unknown' })
    expect(mergeCosts([{ costUsd: 1, costSource: 'provider' }, { costUsd: 2, costSource: 'provider' }])).toEqual({ costUsd: 3, costSource: 'provider' })
    expect(mergeCosts([{ costUsd: 1, costSource: 'provider' }, { costUsd: 2, costSource: 'computed' }])).toEqual({ costUsd: 3, costSource: 'computed' })
    expect(mergeCosts([{ costUsd: 1, costSource: 'computed' }, { costUsd: null, costSource: 'unknown' }, { costUsd: 0, costSource: 'none' }])).toEqual({ costUsd: 1, costSource: 'computed', costPartial: true })
    expect(mergeCosts([{ costUsd: 1, costSource: 'computed', costPartial: true }])).toMatchObject({ costPartial: true })
  })
})

describe('computeRunUsage agents without a result', () => {
  it('records their cost and up to 20 of them, handle first', () => {
    const p = (id: string, model: string, handle?: string): AgentInstance => {
      const a = priced({ id, parentId: 'root', name: 'Worker-2', result: undefined, state: 'done', ...(handle ? { handle } : {}) }, model, tok(1000, 100))
      return a
    }
    const root = priced({ id: 'root' }, 'claude-sonnet-4-5', tok(10))
    const u = computeRunUsage(runSummary({ id: 'r', projectId: 'p' }), [root, p('w1', 'claude-sonnet-4-5', 'w-1'), p('w2', 'never-priced-zzz')], inputs())
    expect(u.agentsWithoutResult).toBe(2)
    expect(u.noResultCostUsd).toBeGreaterThan(0)
    expect(u.noResultCostPartial).toBe(true)
    expect(u.noResultAgents!.map((a) => [a.agentId, a.name, a.roleName, a.costUsd === null])).toEqual([
      ['w1', 'w-1', 'Worker', false],
      ['w2', 'Worker-2', 'Worker', true]
    ])
    const many = Array.from({ length: 25 }, (_, i) => p(`w${i}`, 'claude-sonnet-4-5'))
    expect(computeRunUsage(runSummary({ id: 'r', projectId: 'p' }), [root, ...many], inputs()).noResultAgents).toHaveLength(20)
    expect(computeRunUsage(runSummary({ id: 'r', projectId: 'p' }), [root], inputs())).not.toHaveProperty('noResultCostUsd')
  })
})

describe('computeRunUsage connections', () => {
  it('marks a connection whose agents are partly unpriced as costPartial', () => {
    const builtin = (id: string, conn: string | undefined, model: string): AgentInstance => {
      const a = agent({ id, ...(conn ? { connection: conn } : {}) })
      setModelTokens(a, model, tok(1000, 100))
      a.usage = priceAgentUsage(a.usage!, { overrides: [{ model: 'priced-x', price: { inputPerToken: 0.000001, outputPerToken: 0.000002 } }], catalog: [] })
      return a
    }
    const u = computeRunUsage(
      runSummary({ id: 'r', projectId: 'p', connection: 'anthropic' }),
      [builtin('root', undefined, 'priced-x'), builtin('a', 'openai', 'priced-x'), builtin('b', 'openai', 'never-priced-zzz')],
      inputs()
    )
    expect(u.connections!.openai).toMatchObject({ agents: 2, costPartial: true })
    expect(u.connections!.anthropic).not.toHaveProperty('costPartial')
  })
})

describe('computeRunUsage', () => {
  const summary = runSummary({ startedAt: 1000 })

  it('merges tokens and models across agents and groups roles', () => {
    const agents = [
      priced({ id: 'root', roleId: 'r-lead', roleSlug: 'lead', name: 'Lead', startedAt: 1000, endedAt: 5000 }, 'claude-sonnet-4-5', tok(1_000_000, 0, 0, 0)),
      priced({ id: 'e1', roleId: 'r-eng', roleSlug: 'engineer', name: 'Engineer-1', startedAt: 2000, endedAt: 4000 }, 'claude-sonnet-4-5', tok(0, 1_000_000)),
      priced({ id: 'e2', roleId: 'r-eng', roleSlug: 'engineer', name: 'Engineer-2', startedAt: 2500 }, 'claude-haiku-4-5', tok(1_000_000)),
      priced({ id: 'b', roleId: null, roleSlug: 'custom', name: 'Custom 3', startedAt: 3000, endedAt: 3500 }, 'mystery', tok(10))
    ]
    agents[1]!.usage!.turns = 4
    agents[2]!.usage!.toolCalls = 7
    agents[1]!.usage!.retries = 1
    const u = computeRunUsage(summary, agents, inputs({ nudges: 2, waitingMs: 300, limitHoldMs: 40, idleMs: 50 }))
    expect(u.tokens).toEqual(tok(2_000_010, 1_000_000))
    expect(u.models.map((m) => m.model).sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5', 'mystery'])
    const sonnet = u.models.find((m) => m.model === 'claude-sonnet-4-5')!
    expect(sonnet.tokens).toEqual(tok(1_000_000, 1_000_000))
    expect(sonnet.costUsd).toBeCloseTo(18, 9)
    expect(u.models.find((m) => m.model === 'mystery')!.costUsd).toBeNull()
    // 3 + 15 + 1 = 19, mystery unpriced
    expect(u.costUsd).toBeCloseTo(19, 9)
    expect(u.costSource).toBe('computed')
    expect(u.costPartial).toBe(true)
    expect(u.agents).toBe(4)
    expect(u.turns).toBe(4)
    expect(u.toolCalls).toBe(7)
    expect(u.retries).toBe(1)
    expect(u).toMatchObject({ nudges: 2, waitingMs: 300, limitHoldMs: 40, idleMs: 50, wallMs: 9000, updatedAt: 10_000 })
    expect(u.legacy).toBeUndefined()

    const eng = u.roles.find((r) => r.roleId === 'r-eng')!
    expect(eng).toMatchObject({ roleSlug: 'engineer', roleName: 'Engineer', agents: 2, turns: 4, toolCalls: 7, models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] })
    expect(eng.agentWallMs).toBe(2000 + (10_000 - 2500))
    expect(eng.costUsd).toBeCloseTo(16, 9)
    const custom = u.roles.find((r) => r.roleId === null)!
    expect(custom).toMatchObject({ roleName: 'Custom', costSource: 'unknown', costUsd: null })
    expect(u.roles).toHaveLength(3)
  })

  it('counts agents that ended without a result and their tokens', () => {
    const agents = [
      priced({ id: 'root', result: 'done', roleSlug: 'lead' }, 'claude-sonnet-4-5', tok(100, 10)),
      priced({ id: 'w', parentId: 'root', roleSlug: 'worker', result: '  ', state: 'done' }, 'claude-sonnet-4-5', tok(40, 2, 8, 0)),
      priced({ id: 'live', parentId: 'root', roleSlug: 'worker', result: undefined, state: 'thinking' }, 'claude-sonnet-4-5', tok(5))
    ]
    const u = computeRunUsage(summary, agents, inputs())
    expect(u.agentsWithoutResult).toBe(1)
    expect(u.noResultTokens).toBe(50)
    expect(u.roles.find((r) => r.roleSlug === 'worker')).toMatchObject({ agentsWithoutResult: 1, noResultTokens: 50, agents: 2 })
  })

  it('never counts the root orchestrator as producing no result', () => {
    const agents = [
      priced({ id: 'root', parentId: null, roleSlug: 'lead', result: undefined, state: 'done' }, 'claude-sonnet-4-5', tok(100, 10)),
      priced({ id: 'r2', parentId: null, roleSlug: 'lead', result: '', state: 'error' }, 'claude-sonnet-4-5', tok(7)),
      priced({ id: 'w', parentId: 'root', roleSlug: 'worker', result: '', state: 'error' }, 'claude-sonnet-4-5', tok(20))
    ]
    const u = computeRunUsage(summary, agents, inputs())
    expect(u.agentsWithoutResult).toBe(1)
    expect(u.noResultTokens).toBe(20)
    expect(u.roles.find((r) => r.roleSlug === 'lead')).toMatchObject({ agentsWithoutResult: 0, noResultTokens: 0 })
    expect(agentProducedNothing({ id: 'root', parentId: 'x', state: 'done', result: '' })).toBe(false)
    expect(agentProducedNothing({ id: 'w', parentId: 'root', state: 'done', result: '' })).toBe(true)
    expect(agentProducedNothing({ id: 'w', parentId: 'root', state: 'thinking', result: '' })).toBe(false)
  })

  it('prefers the provider total when every priced agent was provider-priced', () => {
    const agents = [priced({ id: 'a' }, 'm', tok(1), 0.4), priced({ id: 'b' }, 'm', tok(1), 0.3)]
    const u = computeRunUsage(summary, agents, inputs({ providerTotalUsd: 0.9 }))
    expect(u.costSource).toBe('provider')
    expect(u.costUsd).toBe(0.9)
    expect(u.providerCostUsd).toBe(0.9)
    expect(computeRunUsage(summary, agents, inputs()).costUsd).toBeCloseTo(0.7, 9)
    expect(computeRunUsage(summary, agents, inputs({ providerTotalUsd: 0 })).costUsd).toBeCloseTo(0.7, 9)
    // computed agents ignore the provider total
    const computed = computeRunUsage(summary, [priced({ id: 'c' }, 'claude-sonnet-4-5', tok(1_000_000))], inputs({ providerTotalUsd: 99 }))
    expect(computed.costUsd).toBeCloseTo(3, 9)
    expect(computed.providerCostUsd).toBe(99)
    // no agent cost at all: the provider's run total stands in
    const bare = computeRunUsage(summary, [priced({ id: 'd' }, 'mystery', tok(5))], inputs({ providerTotalUsd: 1.5 }))
    expect(bare).toMatchObject({ costUsd: 1.5, costSource: 'provider' })
    expect(bare.costPartial).toBeUndefined()
    expect(computeRunUsage(summary, [], inputs({ providerTotalUsd: 2 }))).toMatchObject({ costUsd: 2, costSource: 'provider' })
  })

  it('reports none for an empty run and unknown for unpriced tokens', () => {
    expect(computeRunUsage(summary, [], inputs())).toMatchObject({ costUsd: 0, costSource: 'none', agents: 0, roles: [] })
    const u = computeRunUsage(summary, [priced({ id: 'a' }, 'mystery', tok(5))], inputs())
    expect(u).toMatchObject({ costUsd: null, costSource: 'unknown' })
    expect(u.costPartial).toBeUndefined()
  })

  it('uses endedAt for the wall time of an ended run', () => {
    expect(computeRunUsage({ ...summary, endedAt: 4000 }, [], inputs()).wallMs).toBe(3000)
  })
})

describe('normalizeRunRecord hardening', () => {
  it('skips a persisted __proto__ agent id instead of setting a prototype', () => {
    const agents = JSON.parse('{"__proto__": {"id": "x"}}') as Record<string, AgentInstance>
    agents.root = agent({ id: 'root' })
    const rec: RunRecord = { summary: runSummary({ startedAt: 1, endedAt: 2, status: 'finished' }), agents, transcript: [], logs: [] }
    const out = normalizeRunRecord(rec, 5)
    expect(Object.keys(out.agents)).toEqual(['root'])
    expect(Object.getPrototypeOf(out.agents)).toBe(Object.prototype)
  })
  it('clamps non-finite and negative token counts from an adapter', () => {
    const a = agent({ id: 'r' })
    setModelTokens(a, 'm', { input: Number.NaN, output: -5, cacheRead: Infinity, cacheWrite: 3 })
    expect(a.usage!.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 3 })
  })
})

describe('normalizeRunRecord', () => {
  const oldAgent = (id: string, over: Partial<AgentInstance> = {}): AgentInstance => agent({ id, ...over })
  function oldRecord(over: Partial<RunSummary> = {}, agents: AgentInstance[] = []): RunRecord {
    return { summary: runSummary({ startedAt: 1000, endedAt: 3000, status: 'finished', ...over }), agents: Object.fromEntries(agents.map((a) => [a.id, a])), transcript: [], logs: [] }
  }

  it('builds legacy agent and run usage from the old fields', () => {
    const rec = oldRecord({ totalCostUsd: 0.5 }, [
      oldAgent('root', { roleId: 'r1', roleSlug: 'lead', name: 'Lead', model: 'opus', inputTokens: 1000, outputTokens: 200, costUsd: 0.5 }),
      oldAgent('w', { parentId: 'root', roleSlug: 'worker', name: 'Worker-2', inputTokens: 50, outputTokens: 5, costUsd: 0, result: undefined })
    ])
    const out = normalizeRunRecord(rec, 9999)
    const root = out.agents.root!.usage!
    expect(root).toMatchObject({ legacy: true, costUsd: 0.5, costSource: 'provider', turns: 0 })
    expect(root.tokens).toEqual(tok(1000, 200))
    expect(root.models).toEqual([{ model: 'opus', tokens: tok(1000, 200), providerCostUsd: 0.5, costUsd: 0.5, priceSource: 'provider' }])
    const w = out.agents.w!.usage!
    expect(w).toMatchObject({ legacy: true, costUsd: null, costSource: 'unknown', producedNothing: true })
    expect(w.models[0]).toMatchObject({ model: 'unknown', priceSource: 'unknown', costUsd: null })
    const run = out.summary.usage!
    expect(run).toMatchObject({ legacy: true, providerCostUsd: 0.5, costSource: 'provider', agents: 2, nudges: 0, waitingMs: 0, wallMs: 2000, updatedAt: 9999 })
    expect(run.costPartial).toBe(true)
    expect(run.costUsd).toBe(0.5)
    expect(rec.agents.root!.usage).toBeUndefined() // the input is untouched
  })

  it('takes nudges from the plan and handles a record with no agents', () => {
    const rec = oldRecord({ totalCostUsd: 2 })
    rec.plan = { goal: 'g', steps: [], status: 'done', autoContinues: 3, updatedAt: 1 }
    const run = normalizeRunRecord(rec, 5).summary.usage!
    expect(run).toMatchObject({ legacy: true, nudges: 3, costUsd: 2, costSource: 'provider', providerCostUsd: 2, agents: 0 })
    expect(normalizeRunRecord(oldRecord(), 5).summary.usage).toMatchObject({ legacy: true, costUsd: 0, costSource: 'none' })
  })

  it('cleans a stored plan graph and staffing and leaves the rest of the record alone (run staffing)', () => {
    const rec = { ...normalizeRunRecord(oldRecord({}, [priced({ id: 'root' }, 'claude-sonnet-4-5', tok(10))]), 4) }
    rec.plan = { goal: 'g', status: 'active', autoContinues: 2, updatedAt: 1, steps: [
      { id: 'p1', title: 'One', status: 'pending', after: ['p2', 'p9'], paths: [' src/a.ts ', ''], staff: { role: '' } },
      { id: 'p2', title: 'Two', status: 'done', after: ['p1'], owner: 'eng' }
    ] }
    rec.staffing = { goal: 'warp' as never, assignments: [{ roleId: 'r', model: 'sonnet', source: 'role', at: 1 }, { roleId: 'r' } as never] }
    const out = normalizeRunRecord(rec, 5)
    expect(out.plan).toEqual({ goal: 'g', status: 'active', autoContinues: 2, updatedAt: 1, steps: [
      { id: 'p1', title: 'One', status: 'pending', paths: ['src/a.ts'] },
      { id: 'p2', title: 'Two', status: 'done', after: ['p1'], owner: 'eng' }
    ] })
    expect(out.staffing).toEqual({ goal: 'balanced', assignments: [{ roleId: 'r', model: 'sonnet', source: 'role', at: 1 }] })
    expect(out.agents.root).toBe(rec.agents.root)
    expect(out.summary).toBe(rec.summary)
    expect(rec.plan!.steps[0].after).toEqual(['p2', 'p9']) // the input is untouched
    expect(normalizeRunRecord(out, 6)).toBe(out)
  })

  it('removes stored staffing that is not an object and keeps a clean one as the same record', () => {
    const fresh: RunRecord = oldRecord({}, [priced({ id: 'root' }, 'claude-sonnet-4-5', tok(10))])
    const junk = normalizeRunRecord({ ...fresh, staffing: 'lots' as never })
    expect('staffing' in junk).toBe(false)
    expect(junk.agents.root).toBe(fresh.agents.root)
    const clean = normalizeRunRecord(fresh)
    const withStaffing: RunRecord = { ...clean, staffing: { goal: 'cost', assignments: [] }, plan: { goal: 'g', status: 'active', autoContinues: 0, updatedAt: 1, steps: [{ id: 'p1', title: 'x', status: 'pending' }] } }
    expect(normalizeRunRecord(withStaffing)).toBe(withStaffing)
  })

  it('is idempotent and leaves current records alone', () => {
    const once = normalizeRunRecord(oldRecord({ totalCostUsd: 1 }, [oldAgent('root', { inputTokens: 10, costUsd: 1 })]), 7)
    expect(normalizeRunRecord(once, 8)).toBe(once)
    const fresh: RunRecord = oldRecord({}, [priced({ id: 'root' }, 'claude-sonnet-4-5', tok(10))])
    const same = normalizeRunRecord(fresh)
    expect(same.agents.root).toBe(fresh.agents.root)
    expect(same.summary.usage?.legacy).toBeUndefined()
  })

  it('does not re-price a legacy agent from the table', () => {
    const u = usageFromLegacyAgent(oldAgent('a', { model: 'claude-sonnet-4-5', inputTokens: 1_000_000, costUsd: 0 }), true)
    expect(u.costUsd).toBeNull()
    expect(usageFromLegacyAgent(oldAgent('b'), false)).toMatchObject({ costSource: 'none', costUsd: 0, models: [] })
    expect(usageFromLegacyAgent(oldAgent('b'), false).legacy).toBeUndefined()
  })
})

describe('buildUsageStats', () => {
  const D = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()
  function usage(over: Partial<RunUsage> = {}): RunUsage {
    return { tokens: tok(100, 10), costUsd: 1, costSource: 'computed', models: [], roles: [], wallMs: 1000, turns: 2, toolCalls: 3, retries: 0, agents: 1, agentsWithoutResult: 0, noResultTokens: 0, nudges: 1, waitingMs: 10, limitHoldMs: 0, idleMs: 0, updatedAt: 0, ...over }
  }
  const run = (id: string, startedAt: number, u: RunUsage | undefined, over: Partial<RunSummary> = {}): RunSummary =>
    runSummary({ id, projectId: 'p1', startedAt, status: 'finished', ...(u ? { usage: u } : {}), ...over })

  it('copies team single from the summary onto the row', () => {
    const s = buildUsageStats([run('a', D(2026, 10, 1), usage(), { team: 'single' }), run('b', D(2026, 10, 2), usage())], { projectId: 'p1' }, 1)
    expect(s.runs.find((r) => r.runId === 'a')?.team).toBe('single')
    expect(s.runs.find((r) => r.runId === 'b')).not.toHaveProperty('team')
  })

  it('filters by project, kind and time, newest first', () => {
    const list = [
      run('a', D(2026, 10, 1), usage()),
      run('b', D(2026, 10, 3), usage()),
      run('c', D(2026, 10, 2), usage(), { kind: 'setup' }),
      run('d', D(2026, 10, 2), usage(), { projectId: 'p2' }),
      run('e', D(2026, 10, 5), usage())
    ]
    const s = buildUsageStats(list, { projectId: 'p1' }, 1)
    expect(s.runs.map((r) => r.runId)).toEqual(['e', 'b', 'a'])
    expect(buildUsageStats(list, { projectId: 'p1', kinds: ['setup', 'work'] }, 1).runs.map((r) => r.runId)).toEqual(['e', 'b', 'c', 'a'])
    expect(buildUsageStats(list, { projectId: 'p1', since: D(2026, 10, 2), until: D(2026, 10, 5) }, 1).runs.map((r) => r.runId)).toEqual(['b'])
    expect(s.projectId).toBe('p1')
    expect(s.generatedAt).toBe(1)
  })

  it('shortens the prompt to one line of at most 120 characters', () => {
    const s = buildUsageStats([run('a', 1, usage(), { prompt: `line one\n\n  line   two ${'x'.repeat(300)}`, title: 'T', resumedFrom: 'z', endedAt: 5 })], { projectId: 'p1' }, 1)
    expect(s.runs[0]!.prompt.startsWith('line one line two x')).toBe(true)
    expect(s.runs[0]!.prompt.length).toBeLessThanOrEqual(120)
    expect(s.runs[0]).toMatchObject({ title: 'T', resumedFrom: 'z', endedAt: 5 })
  })

  it('buckets by local day, oldest first, skipping empty days', () => {
    const list = [
      run('a', D(2026, 10, 1, 9), usage({ costUsd: 1, tokens: tok(10) })),
      run('b', D(2026, 10, 1, 23), usage({ costUsd: 2, tokens: tok(20) })),
      run('c', D(2026, 10, 4, 1), usage({ costUsd: null, costSource: 'unknown', tokens: tok(5) })),
      run('d', D(2026, 10, 4, 2), usage({ costUsd: null, costSource: 'unknown' }))
    ]
    const t = buildUsageStats(list, { projectId: 'p1' }, 1).trend
    expect(t.map((p) => p.bucket)).toEqual(['2026-10-01', '2026-10-04'])
    expect(t[0]).toMatchObject({ runs: 2, costUsd: 3, costUnknownRuns: 0, start: new Date(2026, 9, 1).getTime(), nudges: 2, turns: 4 })
    expect(t[0]!.tokens.input).toBe(30)
    expect(t[1]).toMatchObject({ runs: 2, costUsd: null, costUnknownRuns: 2 })
  })

  it('buckets by ISO week starting Monday', () => {
    // 2026-10-05 is a Monday; Sunday 2026-10-11 belongs to that week, Monday 2026-10-12 starts the next.
    const list = [
      run('a', D(2026, 10, 4), usage({ costUsd: 1 })), // Sunday of the previous week
      run('b', D(2026, 10, 5, 0), usage({ costUsd: 1 })),
      run('c', D(2026, 10, 11, 23), usage({ costUsd: 1 })),
      run('d', D(2026, 10, 12), usage({ costUsd: 1, costPartial: true }))
    ]
    const t = buildUsageStats(list, { projectId: 'p1', bucket: 'week' }, 1).trend
    expect(t.map((p) => [p.bucket, p.runs])).toEqual([['2026-09-28', 1], ['2026-10-05', 2], ['2026-10-12', 1]])
    expect(t[2]!.costUnknownRuns).toBe(1)
    expect(bucketOf(D(2026, 10, 11, 23), 'week').label).toBe('2026-10-05')
    expect(new Date(bucketOf(D(2026, 10, 11, 23), 'week').start).getDay()).toBe(1)
  })

  it('sums roles across runs with a run count, and totals', () => {
    const role = (agents: number, cost: number | null, source: 'computed' | 'unknown') => ({
      roleId: 'r1', roleSlug: 'eng', roleName: 'Eng', agents, tokens: tok(10 * agents), costUsd: cost, costSource: source as 'computed', turns: agents, toolCalls: 0, retries: 0, agentWallMs: 100, agentsWithoutResult: 0, noResultTokens: 0, models: ['m']
    })
    const list = [
      run('a', D(2026, 10, 1), usage({ roles: [role(2, 1, 'computed')], agents: 2, wallMs: 500, models: [{ model: 'm', tokens: tok(20), costUsd: 1, priceSource: 'builtin' }] })),
      run('b', D(2026, 10, 2), usage({ roles: [role(1, null, 'unknown')], agents: 1, wallMs: 700, costUsd: null, costSource: 'unknown', models: [{ model: 'm', tokens: tok(10), costUsd: null, priceSource: 'unknown' }] }))
    ]
    const s = buildUsageStats(list, { projectId: 'p1' }, 5)
    expect(s.roles).toHaveLength(1)
    expect(s.roles[0]).toMatchObject({ roleId: 'r1', agents: 3, runs: 2, costUsd: 1, costSource: 'computed', costPartial: true, models: ['m'], turns: 3, agentWallMs: 200 })
    expect(s.roles[0]!.tokens.input).toBe(30)
    expect(s.totals).toMatchObject({ wallMs: 1200, agents: 3, costUsd: 1, costSource: 'computed', costPartial: true, updatedAt: 5 })
    expect(s.totals.models[0]).toMatchObject({ model: 'm', costUsd: 1, priceSource: 'builtin' })
    expect(s.totals.models[0]!.tokens.input).toBe(30)
  })

  it('reads a run without usage as legacy and handles no runs', () => {
    const s = buildUsageStats([run('a', 1, undefined, { totalCostUsd: 0.25 })], { projectId: 'p1' }, 3)
    expect(s.runs[0]!.usage).toMatchObject({ legacy: true, costUsd: 0.25, costSource: 'provider' })
    expect(s.totals.legacy).toBe(true)
    const none = buildUsageStats([], { projectId: 'p1' }, 3)
    expect(none).toMatchObject({ runs: [], roles: [], trend: [] })
    expect(none.totals).toMatchObject({ costUsd: 0, costSource: 'none' })
  })

  it('fills RunUsage.skills (most loaded first) and merges skills across runs', () => {
    const a = computeRunUsage(runSummary({ startedAt: 1 }), [], inputs({ skills: [{ skillId: 's1', name: 'one', loads: 1, roles: ['eng'] }, { skillId: 's2', name: 'two', loads: 3, roles: ['lead'] }] }))
    expect(a.skills?.map((s) => s.skillId)).toEqual(['s2', 's1'])
    expect(computeRunUsage(runSummary(), [], inputs({})).skills).toBeUndefined()
    const b = { ...a, skills: [{ skillId: 's1', name: 'one', loads: 4, roles: ['eng', 'rev'] }] }
    const total = sumRunUsage([a, b], 9)
    expect(total.skills).toEqual([
      { skillId: 's1', name: 'one', loads: 5, roles: ['eng', 'rev'] },
      { skillId: 's2', name: 'two', loads: 3, roles: ['lead'] }
    ])
    const stats = buildUsageStats([run('a', 1, a), run('b', 2, b)], { projectId: 'p1' }, 3)
    expect(stats.totals.skills?.find((s) => s.skillId === 's1')?.loads).toBe(5)
    expect(sumRunUsage([{ ...a, skills: undefined }], 1).skills).toBeUndefined()
  })

  it('sumRunUsage of nothing is empty', () => {
    expect(sumRunUsage([], 1)).toMatchObject({ costSource: 'none', agents: 0 })
    expect(legacySummaryUsage(runSummary({ totalCostUsd: 0 }), 1)).toMatchObject({ costSource: 'none', costUsd: 0 })
  })
})

describe('RunUsage.knowledge', () => {
  const inputs = { nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, now: 5000 }
  const served = { recalls: 2, autoContexts: 1, itemsServed: 9, charsServed: 3000 }

  it('is set only when something was served, and copied from the inputs', () => {
    const s = runSummary({ startedAt: 1000 })
    expect(computeRunUsage(s, [], { ...inputs, knowledge: served }).knowledge).toEqual(served)
    expect(computeRunUsage(s, [], inputs).knowledge).toBeUndefined()
    expect(computeRunUsage(s, [], { ...inputs, knowledge: { recalls: 0, autoContexts: 0, itemsServed: 0, charsServed: 0 } }).knowledge).toBeUndefined()
  })

  it('cleanKnowledgeUsage accepts whole numbers >= 0 only and never throws', () => {
    expect(cleanKnowledgeUsage({ ...served, extra: 1 })).toEqual(served)
    expect(cleanKnowledgeUsage({ ...served, recalls: 2.9 })).toEqual({ ...served, recalls: 2 })
    for (const junk of [null, undefined, 5, 'x', [], { recalls: 1 }, { ...served, recalls: -1 }, { ...served, charsServed: Number.NaN }, { ...served, itemsServed: Infinity }, { ...served, autoContexts: '1' }]) {
      expect(cleanKnowledgeUsage(junk), JSON.stringify(junk)).toBeUndefined()
    }
  })

  it('sumRunUsage adds it up and skips junk from old records', () => {
    const a = { ...legacySummaryUsage(runSummary(), 1), knowledge: served }
    const b = { ...legacySummaryUsage(runSummary(), 1), knowledge: { recalls: 1, autoContexts: 0, itemsServed: 3, charsServed: 100 } }
    const junk = { ...legacySummaryUsage(runSummary(), 1), knowledge: 'lots' as unknown as RunUsage['knowledge'] }
    expect(sumRunUsage([a, b, junk], 9).knowledge).toEqual({ recalls: 3, autoContexts: 1, itemsServed: 12, charsServed: 3100 })
    expect(sumRunUsage([junk], 9).knowledge).toBeUndefined()
    expect(sumRunUsage([legacySummaryUsage(runSummary(), 1)], 9).knowledge).toBeUndefined()
  })

  it('normalizeRunRecord drops a junk stored value, keeps a good one untouched and is idempotent', () => {
    const base = normalizeRunRecord({ summary: runSummary({ startedAt: 1, endedAt: 2, status: 'finished' }), agents: {}, transcript: [], logs: [] }, 5)
    const withGood: RunRecord = { ...base, summary: { ...base.summary, usage: { ...base.summary.usage!, knowledge: served } } }
    expect(normalizeRunRecord(withGood, 6)).toBe(withGood)
    for (const junk of ['x', 7, { recalls: 'a' }, { recalls: -1, autoContexts: 0, itemsServed: 0, charsServed: 0 }, []]) {
      const rec = { ...base, summary: { ...base.summary, usage: { ...base.summary.usage!, knowledge: junk as unknown as RunUsage['knowledge'] } } }
      const out = normalizeRunRecord(rec, 6)
      expect(out.summary.usage, JSON.stringify(junk)).not.toHaveProperty('knowledge')
      expect(out.summary.usage?.costSource).toBe(base.summary.usage?.costSource)
      expect(normalizeRunRecord(out, 7)).toBe(out)
    }
  })
})


describe('computeRunEfficiency', () => {
  const run = (endedAt?: number): RunSummary => ({ ...runSummary(), startedAt: 0, endedAt })
  const rep = (id: string, startedAt: number, endedAt?: number, parentId = 'root'): AgentInstance => agent({ id, parentId, startedAt, endedAt })
  const root = agent({ id: 'root', parentId: null, startedAt: 0 })

  it('is undefined without a direct report', () => {
    expect(computeRunEfficiency(run(5000), [root], 9000)).toBeUndefined()
    expect(computeRunEfficiency(run(5000), [], 9000)).toBeUndefined()
  })

  it('describes one report', () => {
    expect(computeRunEfficiency(run(1000), [root, rep('a', 100, 600)], 9000)).toEqual({ reports: 1, firstSpawnMs: 100, reportSumMs: 500, reportBusyMs: 500, maxParallel: 1, tailMs: 400, afterLastReportMs: 400 })
  })

  it('has overlap 1 and a tail of everything after the first report for reports in sequence', () => {
    const e = computeRunEfficiency(run(1000), [root, rep('a', 100, 300), rep('b', 400, 900)], 9000)!
    expect(e).toMatchObject({ reports: 2, reportSumMs: 700, reportBusyMs: 700, maxParallel: 1, tailMs: 700 })
  })

  it('reproduces the dashboard run of spec 1.3', () => {
    const agents = [root, rep('a', 54_000, 198_000), rep('b', 54_000, 476_000), rep('c', 604_000, 873_000)]
    expect(computeRunEfficiency(run(1_091_000), agents, 2_000_000)).toEqual({ reports: 3, firstSpawnMs: 54_000, reportSumMs: 835_000, reportBusyMs: 691_000, maxParallel: 2, tailMs: 615_000, afterLastReportMs: 218_000 })
  })

  it('measures after the last report from the last end, not the first wave', () => {
    const e = computeRunEfficiency(run(1000), [root, rep('a', 100, 300), rep('b', 400, 900)], 9000)!
    expect(e.tailMs).toBe(700)
    expect(e.afterLastReportMs).toBe(100)
    expect(computeRunEfficiency(run(undefined), [root, rep('a', 100)], 700)!.afterLastReportMs).toBe(0)
  })

  it('takes reportStartMs as the median first file write of the reports from the transcript', () => {
    const tu = (agentId: string, at: number, name: string): TranscriptEntry => ({ id: `${agentId}${at}`, agentId, at, block: { kind: 'tool_use', id: `${agentId}${at}`, name, input: {} } })
    const agents = [root, rep('a', 100, 900), rep('b', 200, 900), rep('c', 300, 900)]
    const tr = [tu('a', 150, 'Read'), tu('a', 400, 'Edit'), tu('a', 300, 'Write'), tu('b', 700, 'MultiEdit'), tu('root', 50, 'Write'), tu('c', 400, 'Grep')]
    // a: 300-100 = 200, b: 700-200 = 500, c never wrote, root is not a report.
    expect(computeRunEfficiency(run(1000), agents, 9000, tr)!.reportStartMs).toBe(350)
    expect(computeRunEfficiency(run(1000), agents, 9000, [tu('c', 400, 'Grep')])!.reportStartMs).toBeUndefined()
    expect(computeRunEfficiency(run(1000), agents, 9000)!.reportStartMs).toBeUndefined()
  })

  it('cleans the optional afterLastReportMs and reportStartMs like readyIdleMs', () => {
    const ok = { reports: 2, firstSpawnMs: 1, reportSumMs: 5, reportBusyMs: 4, maxParallel: 2, tailMs: 0 }
    expect(cleanRunEfficiency({ ...ok, afterLastReportMs: 7, reportStartMs: 0 })).toEqual({ ...ok, afterLastReportMs: 7, reportStartMs: 0 })
    expect(cleanRunEfficiency({ ...ok, afterLastReportMs: -1, reportStartMs: NaN })).toEqual(ok)
    expect(cleanRunEfficiency({ ...ok, afterLastReportMs: '7' })).toEqual(ok)
  })

  it('ignores grandchildren', () => {
    const agents = [root, rep('a', 100, 500), rep('g', 150, 450, 'a')]
    expect(computeRunEfficiency(run(1000), agents, 9000)).toMatchObject({ reports: 1, reportSumMs: 400, maxParallel: 1 })
  })

  it('counts a live report to now and never goes negative', () => {
    const e = computeRunEfficiency(run(undefined), [root, rep('a', 100)], 700)!
    expect(e).toMatchObject({ reportSumMs: 600, reportBusyMs: 600, tailMs: 0 })
    expect(computeRunEfficiency(run(300), [root, rep('a', 100, 500)], 9000)!.tailMs).toBe(0)
  })

  it('drops garbage persisted values whole and keeps a valid one', () => {
    const ok = { reports: 2, firstSpawnMs: 1, reportSumMs: 5, reportBusyMs: 4, maxParallel: 2, tailMs: 0 }
    expect(cleanRunEfficiency(ok)).toEqual(ok)
    for (const bad of [null, 'x', [], { ...ok, tailMs: -1 }, { ...ok, reportSumMs: NaN }, { ...ok, maxParallel: Infinity }, { ...ok, reports: '2' }, { ...ok, reports: 0 }, { reports: 1 }]) {
      expect(cleanRunEfficiency(bad)).toBeUndefined()
    }
    const rec = (efficiency: unknown): RunRecord => {
      const s = { ...runSummary(), endedAt: 5000 }
      const r = { summary: { ...s, usage: { ...computeRunUsage(s, [], inputs()), efficiency } }, agents: {}, events: [] } as unknown as RunRecord
      return normalizeRunRecord(r, 6000)
    }
    expect(rec({ ...ok, tailMs: -5 }).summary.usage!.efficiency).toBeUndefined()
    expect(rec(ok).summary.usage!.efficiency).toEqual(ok)
  })

  it('keeps a valid readyIdleMs and drops a junk one alone (run staffing)', () => {
    const ok = { reports: 2, firstSpawnMs: 1, reportSumMs: 5, reportBusyMs: 4, maxParallel: 2, tailMs: 0 }
    expect(cleanRunEfficiency({ ...ok, readyIdleMs: 250 })).toEqual({ ...ok, readyIdleMs: 250 })
    expect(cleanRunEfficiency({ ...ok, readyIdleMs: 0 })).toEqual({ ...ok, readyIdleMs: 0 })
    for (const bad of [-1, Number.NaN, Infinity, '5', null]) expect(cleanRunEfficiency({ ...ok, readyIdleMs: bad })).toEqual(ok)
    // Nothing computes it yet.
    expect(computeRunEfficiency({ ...runSummary(), startedAt: 0, endedAt: 1000 }, [root, rep('a', 100, 600)], 1000)!.readyIdleMs).toBeUndefined()
  })

  it('is carried by computeRunUsage and not summed', () => {
    const s = { ...runSummary(), startedAt: 0, endedAt: 1000 }
    const u = computeRunUsage(s, [root, rep('a', 100, 600)], inputs())
    expect(u.efficiency).toMatchObject({ reports: 1, tailMs: 400 })
    expect(computeRunUsage(s, [root], inputs()).efficiency).toBeUndefined()
    expect(sumRunUsage([u, u], 1).efficiency).toBeUndefined()
  })
})
