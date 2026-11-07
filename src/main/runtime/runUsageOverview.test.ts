import { describe, expect, it } from 'vitest'
import type { ModelUsageEntry, RoleUsage, RunSummary, RunUsage, TokenUsage } from '@shared/types'
import { USAGE_CSV_COLUMNS, USAGE_OVERVIEW_CSV_COLUMNS, USAGE_REMOVED_PROJECT_NAME, USAGE_STATS_MAX_LIMIT } from '@shared/types'
import { runSummary } from './testHelpers'
import { buildUsageOverview, buildUsageOverviewCsv, overviewBucketOf, sanitizeUsageOverviewQuery, type UsageOverviewNames } from './runUsage'

const tok = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage => ({ input, output, cacheRead, cacheWrite })
const D = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime()

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return { tokens: tok(100, 10), costUsd: 1, costSource: 'computed', models: [], roles: [], wallMs: 1000, turns: 2, toolCalls: 3, retries: 0, agents: 1, agentsWithoutResult: 0, noResultTokens: 0, nudges: 1, waitingMs: 10, limitHoldMs: 0, idleMs: 5, updatedAt: 0, ...over }
}
const model = (name: string, t: TokenUsage, costUsd: number | null): ModelUsageEntry => ({ model: name, tokens: t, costUsd, priceSource: costUsd === null ? 'unknown' : 'builtin' })
const role = (roleId: string, costUsd: number | null): RoleUsage => ({
  roleId, roleSlug: roleId, roleName: roleId, agents: 1, tokens: tok(10), costUsd, costSource: costUsd === null ? 'unknown' : 'computed', turns: 1, toolCalls: 1, retries: 0, agentWallMs: 1, agentsWithoutResult: 0, noResultTokens: 0, models: []
})
const run = (id: string, projectId: string, startedAt: number, u: RunUsage | undefined, over: Partial<RunSummary> = {}): RunSummary =>
  runSummary({ id, projectId, startedAt, status: 'finished', ...(u ? { usage: u } : {}), ...over })

const names: UsageOverviewNames = {
  project: (id) =>
    id === 'p1' ? { name: 'Alpha', kind: 'code' }
    : id === 'p2' ? { name: 'Beta', kind: 'engagement', client: 'Acme' }
    : id === 'quick' ? { name: 'Chat', kind: 'assistant' }
    : null,
  connection: (id) => (id === 'anthropic' ? 'Anthropic' : id === 'openai' ? 'OpenAI' : 'Removed proxy')
}
const q = (raw: unknown = {}) => sanitizeUsageOverviewQuery(raw)

describe('sanitizeUsageOverviewQuery', () => {
  it('defaults to every kind, day buckets, the default limit and no project filter', () => {
    expect(q(undefined)).toEqual({ kinds: ['work', 'setup', 'mcp-assist', 'skill-assist'], bucket: 'day', limit: 500 })
    expect(q(null)).toEqual(q({}))
  })

  it('keeps known values, clamps the limit and drops unknown fields and kinds', () => {
    const s = q({ kinds: ['setup', 'bogus', 'setup'], bucket: 'month', limit: 99999, since: 5, until: Infinity, extra: 1, projectIds: ['p1', 'p1', 'quick'] })
    expect(s).toEqual({ kinds: ['setup'], bucket: 'month', limit: USAGE_STATS_MAX_LIMIT, since: 5, projectIds: ['p1', 'quick'] })
    expect(q({ limit: -3 }).limit).toBe(1)
    expect(q({ bucket: 'year' }).bucket).toBe('day')
    expect(q({ projectIds: [] })).not.toHaveProperty('projectIds')
  })

  it('turns a month into since / until and refuses a malformed one', () => {
    const s = q({ range: { month: '2026-02' }, since: 1, until: 2 })
    expect(s.since).toBe(new Date(2026, 1, 1).getTime())
    expect(s.until).toBe(new Date(2026, 2, 1).getTime())
    expect(() => q({ range: { month: '2026-13' } })).toThrow('Invalid month')
    expect(() => q({ range: 'x' })).toThrow('Invalid month')
  })

  it('refuses bad project id lists and non-object queries', () => {
    expect(() => q({ projectIds: 'p1' })).toThrow('Invalid project ids')
    expect(() => q({ projectIds: ['../x'] })).toThrow('Invalid project ids')
    expect(() => q({ projectIds: [1] })).toThrow('Invalid project ids')
    expect(() => q({ projectIds: Array.from({ length: 201 }, (_, i) => `p${i}`) })).toThrow('Invalid project ids')
    expect(q({ projectIds: Array.from({ length: 200 }, (_, i) => `p${i}`) }).projectIds).toHaveLength(200)
    expect(() => q('p1')).toThrow('Invalid usage query')
    expect(() => q([])).toThrow('Invalid usage query')
  })
})

describe('overviewBucketOf', () => {
  it('labels a month bucket with its local 1st', () => {
    expect(overviewBucketOf(D(2026, 11, 30, 23), 'month')).toEqual({ start: new Date(2026, 10, 1).getTime(), label: '2026-11-01' })
    expect(overviewBucketOf(D(2026, 11, 4), 'day').label).toBe('2026-11-04')
    expect(overviewBucketOf(D(2026, 11, 4), 'week').label).toBe('2026-11-02')
  })
})

describe('buildUsageOverview', () => {
  const list = (): RunSummary[] => [
    run('a', 'p1', D(2026, 10, 1), usage({ costUsd: 2, models: [model('sonnet', tok(50, 5), 2)], roles: [role('r1', 2)] }), { connection: 'anthropic' }),
    run('b', 'p1', D(2026, 10, 20), usage({ costUsd: null, costSource: 'unknown', models: [model('gpt-x', tok(70), null)], roles: [role('r1', null)] }), { connection: 'openai' }),
    run('c', 'p2', D(2026, 11, 2), usage({ costUsd: 3, costPartial: true, models: [model('sonnet', tok(10), 3), model('gpt-x', tok(5), null)] }), { connection: 'anthropic', team: 'single' }),
    run('d', 'quick', D(2026, 11, 3), usage({ costUsd: 0, costSource: 'none', tokens: tok() }), {}),
    run('e', 'gone', D(2026, 11, 4), usage({ costUsd: 0.5 }), { kind: 'setup', connection: 'proxy-x' })
  ]

  it('lists every project newest first with its own names, removed projects included', () => {
    const o = buildUsageOverview(list(), q(), names, 7)
    expect(o.runs.map((r) => r.runId)).toEqual(['e', 'd', 'c', 'b', 'a'])
    const e = o.runs[0]!
    expect(e).toMatchObject({ projectId: 'gone', projectName: USAGE_REMOVED_PROJECT_NAME, projectKind: 'code', projectRemoved: true, connection: 'proxy-x' })
    expect(o.runs.find((r) => r.runId === 'c')).toMatchObject({ projectName: 'Beta', projectKind: 'engagement', client: 'Acme', team: 'single' })
    expect(o.runs.find((r) => r.runId === 'd')).toMatchObject({ projectName: 'Chat', projectKind: 'assistant' })
    expect(o.runs.find((r) => r.runId === 'd')).not.toHaveProperty('connection')
    expect(o.matchedRuns).toBe(5)
    expect(o.generatedAt).toBe(7)
    expect(o).not.toHaveProperty('truncated')
  })

  it('rolls projects up, keeping unknown as null and partial as a lower bound', () => {
    const o = buildUsageOverview(list(), q(), names, 7)
    const p1 = o.projects.find((p) => p.projectId === 'p1')!
    expect(p1).toMatchObject({ projectName: 'Alpha', runs: 2, costUsd: 2, costSource: 'computed', costPartial: true, costUnknownRuns: 1, firstStartedAt: D(2026, 10, 1), lastStartedAt: D(2026, 10, 20) })
    expect(p1.connections).toEqual(['anthropic', 'openai'])
    expect(p1.runsByKind).toEqual({ work: 2 })
    expect(p1.tokens).toEqual(tok(200, 20))
    expect(p1.idleMs).toBe(10)
    const p2 = o.projects.find((p) => p.projectId === 'p2')!
    expect(p2.runsByKind).toEqual({ ask: 1 })
    expect(p2.costPartial).toBe(true)
    expect(o.projects.find((p) => p.projectId === 'quick')).toMatchObject({ costUsd: 0, costSource: 'none' })
    expect(o.projects.find((p) => p.projectId === 'gone')).toMatchObject({ projectRemoved: true, runsByKind: { setup: 1 } })
    // Highest known cost first: p2 (3), p1 (2), gone (0.5), quick (0).
    expect(o.projects.map((p) => p.projectId)).toEqual(['p2', 'p1', 'gone', 'quick'])
  })

  it('a project with only unknown cost stays null, never 0', () => {
    const o = buildUsageOverview([run('x', 'p1', 1, usage({ costUsd: null, costSource: 'unknown' }))], q(), names, 1)
    expect(o.projects[0]).toMatchObject({ costUsd: null, costSource: 'unknown' })
    expect(o.totals.costUsd).toBeNull()
    expect(o.trend[0]!.costUsd).toBeNull()
    expect(o.trend[0]!.byProject[0]!.costUsd).toBeNull()
  })

  it('merges models across runs with run and project counts and partial cost', () => {
    const o = buildUsageOverview(list(), q(), names, 7)
    const sonnet = o.models.find((m) => m.model === 'sonnet')!
    expect(sonnet).toMatchObject({ costUsd: 5, runs: 2, projects: 2, priceSource: 'builtin' })
    expect(sonnet).not.toHaveProperty('costPartial')
    const gpt = o.models.find((m) => m.model === 'gpt-x')!
    expect(gpt).toMatchObject({ costUsd: null, runs: 2, projects: 2, priceSource: 'unknown', tokens: tok(75) })
    expect(o.models.map((m) => m.model)).toEqual(['gpt-x', 'sonnet'])
    const mixed = buildUsageOverview([run('a', 'p1', 1, usage({ models: [model('m', tok(1), 1)] })), run('b', 'p1', 2, usage({ models: [model('m', tok(1), null)] }))], q(), names, 1)
    expect(mixed.models[0]).toMatchObject({ costUsd: 1, costPartial: true })
  })

  it('keys roles by project and role', () => {
    const o = buildUsageOverview(
      [...list(), run('f', 'p2', D(2026, 11, 5), usage({ roles: [role('r1', 4)] }))],
      q(),
      names,
      7
    )
    const r1 = o.roles.filter((r) => r.roleId === 'r1')
    expect(r1.map((r) => [r.projectId, r.projectName, r.runs, r.costUsd, r.costPartial])).toEqual([
      ['p2', 'Beta', 1, 4, undefined],
      ['p1', 'Alpha', 2, 2, true]
    ])
  })

  it('splits multi-provider runs per connection and names connections', () => {
    const multi = usage({ costUsd: 3, agents: 3, connections: { anthropic: { costUsd: 1, agents: 1 }, openai: { costUsd: null, agents: 2 } } })
    const o = buildUsageOverview([...list(), run('m', 'p1', D(2026, 11, 6), multi, { connection: 'anthropic' })], q(), names, 7)
    const by = Object.fromEntries(o.connections.map((c) => [c.name, c]))
    expect(by.Anthropic).toMatchObject({ connection: 'anthropic', runs: 3, agents: 3, costUsd: 6, costSource: 'computed' })
    expect(by.OpenAI).toMatchObject({ connection: 'openai', runs: 2, agents: 3, costUsd: null, costSource: 'unknown' })
    expect(by['Removed proxy']).toMatchObject({ connection: 'proxy-x', runs: 1, costUsd: 0.5 })
    expect(by['Unknown connection']).toMatchObject({ connection: null, runs: 1 })
    expect(o.connections[0]!.name).toBe('Anthropic')
  })

  it('ignores junk in RunUsage.connections', () => {
    const junk = usage({ connections: { anthropic: { costUsd: Number.NaN, agents: -1 }, 'bad id!': { costUsd: 1, agents: 1 } } as never })
    const o = buildUsageOverview([run('j', 'p1', 1, junk, { connection: 'openai' })], q(), names, 1)
    expect(o.connections).toEqual([{ connection: 'anthropic', name: 'Anthropic', kind: 'builtin', runs: 1, agents: 0, costUsd: null, costSource: 'unknown', costKnownRuns: 0, costUnknownRuns: 1 }])
  })

  it('keeps a connection\'s partial cost a lower bound (review M1)', () => {
    const multi = usage({ costUsd: 3, costPartial: true, agents: 3, connections: { anthropic: { costUsd: 1, agents: 1, costPartial: true }, openai: { costUsd: 2, agents: 2 } } })
    const o = buildUsageOverview([run('m', 'p1', 1, multi, { connection: 'anthropic' })], q(), names, 1)
    expect(o.connections.find((c) => c.connection === 'anthropic')).toMatchObject({ costUsd: 1, costPartial: true })
    expect(o.connections.find((c) => c.connection === 'openai')).not.toHaveProperty('costPartial')
  })

  it('survives malformed stored usage in one run (review M2)', () => {
    const junk = [
      run('j1', 'p1', 1, {} as RunUsage),
      run('j2', 'p1', 2, { tokens: 'x', models: 'y', roles: [{ roleSlug: 'r', models: 'z', tokens: null }, null], costUsd: 'free', costSource: 'bogus', agents: '3' } as never),
      run('j3', 'p1', 3, { ...usage(), skills: [{ skillId: 's', name: 'S', loads: 1, roles: 'nope' }, { skillId: 's2', name: 'S2', loads: 2, roles: ['a'] }] } as never),
      run('nan', 'p1', Number.NaN, usage()),
      run('ok', 'p2', 4, usage())
    ]
    const o = buildUsageOverview(junk, q(), names, 1)
    expect(o.runs.map((r) => r.runId)).toEqual(['ok', 'j3', 'j2', 'j1'])
    expect(o.trend.every((t) => Number.isFinite(t.start) && !t.bucket.includes('NaN'))).toBe(true)
    const j2 = o.runs.find((r) => r.runId === 'j2')!.usage
    expect(j2).toMatchObject({ tokens: tok(), models: [], costUsd: null, costSource: 'unknown', agents: 0 })
    expect(j2.roles).toHaveLength(1)
    expect(o.totals.skills?.map((s) => s.skillId)).toEqual(['s2'])
    expect(Number.isFinite(o.totals.agents)).toBe(true)
    expect(() => buildUsageOverviewCsv(o)).not.toThrow()
  })

  it('refuses a sparse project id list (review L1)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => q({ projectIds: [, 'p1'] })).toThrow('Invalid project ids')
  })

  it('buckets by local month with a per-project breakdown', () => {
    const o = buildUsageOverview(list(), q({ bucket: 'month' }), names, 7)
    expect(o.trend.map((t) => [t.bucket, t.runs])).toEqual([['2026-10-01', 2], ['2026-11-01', 3]])
    const nov = o.trend[1]!
    expect(nov.byProject.map((p) => p.projectId)).toEqual(['p2', 'gone', 'quick'])
    expect(nov.byProject[0]).toEqual({ projectId: 'p2', runs: 1, tokens: tok(100, 10), costUsd: 3, costKnownRuns: 0, costUnknownRuns: 1, wallMs: 1000, waitingMs: 10 })
    expect(nov).toMatchObject({ costKnownRuns: 2, costUnknownRuns: 1 })
    expect(nov.costUsd).toBe(3.5)
    expect(nov.costUnknownRuns).toBe(1)
    expect(o.trend[0]!.byProject.find((p) => p.projectId === 'p1')).toMatchObject({ runs: 2, costUsd: 2, costUnknownRuns: 1 })
  })

  it('filters by project ids, kinds and time', () => {
    expect(buildUsageOverview(list(), q({ projectIds: ['p1', 'gone'] }), names, 1).runs.map((r) => r.runId)).toEqual(['e', 'b', 'a'])
    expect(buildUsageOverview(list(), q({ kinds: ['setup'] }), names, 1).runs.map((r) => r.runId)).toEqual(['e'])
    expect(buildUsageOverview(list(), q({ range: { month: '2026-10' } }), names, 1).runs.map((r) => r.runId)).toEqual(['b', 'a'])
    expect(buildUsageOverview(list(), q({ projectIds: ['nobody'] }), names, 1)).toMatchObject({ runs: [], projects: [], trend: [], matchedRuns: 0, totals: { costUsd: 0, costSource: 'none' } })
  })

  it('cuts rows at the limit but rolls up every matched run', () => {
    const o = buildUsageOverview(list(), q({ limit: 2 }), names, 1)
    expect(o.runs.map((r) => r.runId)).toEqual(['e', 'd'])
    expect(o.truncated).toBe(true)
    expect(o.matchedRuns).toBe(5)
    expect(o.projects).toHaveLength(4)
    expect(o.totals.agents).toBe(5)
    expect(o.query.limit).toBe(2)
  })

  it('reads a summary without usage as legacy and survives a throwing name lookup', () => {
    const throwing: UsageOverviewNames = { project: () => { throw new Error('boom') }, connection: () => { throw new Error('boom') } }
    const o = buildUsageOverview([run('l', 'p1', 1, undefined, { totalCostUsd: 0.25, connection: 'anthropic' })], q(), throwing, 1)
    expect(o.runs[0]!.usage.legacy).toBe(true)
    expect(o.runs[0]!.projectName).toBe(USAGE_REMOVED_PROJECT_NAME)
    expect(o.connections[0]!.name).toBe('Removed proxy')
  })

  it('writes CSV rows with each row\'s own project and client', () => {
    const o = buildUsageOverview(list(), q(), names, 1)
    const csv = buildUsageOverviewCsv(o, { offsetMinutes: () => 0 })
    const lines = csv.replace(/^﻿/, '').split('\r\n')
    expect(lines[0]!.startsWith('project,client,started')).toBe(true)
    expect(lines).toHaveLength(6)
    expect(lines[1]!.startsWith(`${USAGE_REMOVED_PROJECT_NAME},,`)).toBe(true)
    expect(lines[3]!.startsWith('Beta,Acme,')).toBe(true)
    expect(lines[3]).toContain(',ask,')
    expect(lines[4]!.split(',')[13]).toBe('')
  })

  it('quotes formula-like project names in CSV', () => {
    const evil: UsageOverviewNames = { ...names, project: () => ({ name: '=HYPERLINK("x")', kind: 'engagement', client: '+1' }) }
    const csv = buildUsageOverviewCsv(buildUsageOverview([run('a', 'p1', 1, usage())], q(), evil, 1))
    expect(csv.split('\r\n')[1]!.startsWith(`"'=HYPERLINK(""x"")",'+1,`)).toBe(true)
  })

  it('stays fast for 2,000 runs across 50 projects', () => {
    const many: RunSummary[] = []
    for (let i = 0; i < 2000; i++) {
      many.push(run(`r${i}`, `p${i % 50}`, D(2026, 1, 1) + i * 3_600_000, usage({ models: [model(`m${i % 7}`, tok(100, 10), i % 3 ? 1 : null)], roles: [role(`role${i % 5}`, 1), role(`x${i % 3}`, null)] }), { connection: i % 2 ? 'anthropic' : 'openai' }))
    }
    const t0 = performance.now()
    const o = buildUsageOverview(many, q({ limit: 2000, bucket: 'week' }), { project: (id) => ({ name: id, kind: 'code' }), connection: (id) => id }, 1)
    const ms = performance.now() - t0
    console.log(`buildUsageOverview: 2,000 runs / 50 projects in ${ms.toFixed(1)} ms`)
    expect(o.runs).toHaveLength(2000)
    expect(o.projects).toHaveLength(50)
    // Project k sees role `role${k % 5}` and the three `x` roles.
    expect(o.roles).toHaveLength(200)
    expect(ms).toBeLessThan(2000)
  })
})

describe('buildUsageOverview: spec section 14 fields', () => {
  it('marks live rows, copies endedBy, quick and legacy, and names the oldest included row', () => {
    const list = [
      run('live', 'p1', 30, usage(), { status: 'running', endedAt: 99 }),
      run('ended', 'p1', 20, usage(), { endedBy: 'user', endedAt: 25 }),
      run('chat', 'quick', 10, usage({ legacy: true }), { quick: { folder: null, team: 'single', allowEdits: false, gitRepo: false } as never }),
      run('old', 'p1', 5, usage())
    ]
    const o = buildUsageOverview(list, q({ limit: 3 }), names, 1, new Set(['live']))
    expect(o.runs[0]).toMatchObject({ runId: 'live', live: true })
    expect(o.runs[0]).not.toHaveProperty('endedAt')
    expect(o.runs[1]).toMatchObject({ endedBy: 'user', endedAt: 25 })
    expect(o.runs[1]).not.toHaveProperty('live')
    expect(o.runs[2]).toMatchObject({ quick: { team: 'single' }, legacy: true })
    expect(o).toMatchObject({ truncated: true, oldestIncludedAt: 10 })
    expect(buildUsageOverview([], q(), names, 1)).not.toHaveProperty('oldestIncludedAt')
  })

  it('counts cost coverage per project, model, role, connection, bucket and overall', () => {
    const list = [
      run('a', 'p1', 1, usage({ costUsd: 1, models: [model('m', tok(1), 1)], roles: [role('r', 1)] }), { connection: 'anthropic' }),
      run('b', 'p1', 2, usage({ costUsd: 1, costPartial: true, models: [model('m', tok(1), null)], roles: [role('r', null)] }), { connection: 'anthropic' }),
      run('c', 'p1', 3, usage({ costUsd: 0, costSource: 'none', tokens: tok() }), { connection: 'my-proxy' })
    ]
    const o = buildUsageOverview(list, q(), names, 1)
    expect(o).toMatchObject({ costKnownRuns: 2, costUnknownRuns: 1 })
    expect(o.projects[0]).toMatchObject({ costKnownRuns: 2, costUnknownRuns: 1 })
    expect(o.models[0]).toMatchObject({ model: 'm', costKnownRuns: 1, costUnknownRuns: 1 })
    expect(o.roles[0]).toMatchObject({ roleId: 'r', costKnownRuns: 1, costUnknownRuns: 1 })
    expect(o.connections.find((c) => c.connection === 'anthropic')).toMatchObject({ kind: 'builtin', costKnownRuns: 1, costUnknownRuns: 1 })
    expect(o.connections.find((c) => c.connection === 'my-proxy')).toMatchObject({ kind: 'proxy', costKnownRuns: 1, costUnknownRuns: 0 })
    expect(o.trend[0]).toMatchObject({ costKnownRuns: 2, costUnknownRuns: 1 })
  })

  it('sums the cost of agents without a result per project; older records count as unknown', () => {
    const agentRow = { agentId: 'a1', name: 'w-1', roleName: 'Worker', tokens: tok(5), costUsd: 0.2 }
    const list = [
      run('a', 'p1', 1, usage({ agentsWithoutResult: 1, noResultTokens: 5, noResultCostUsd: 0.2, noResultAgents: [agentRow] })),
      run('b', 'p1', 2, usage({ agentsWithoutResult: 1, noResultTokens: 5 })),
      run('c', 'p2', 3, usage())
    ]
    const o = buildUsageOverview(list, q(), names, 1)
    expect(o.projects.find((p) => p.projectId === 'p1')).toMatchObject({ noResultCostUsd: 0.2, noResultCostPartial: true })
    expect(o.projects.find((p) => p.projectId === 'p2')).toMatchObject({ noResultCostUsd: 0 })
    expect(o.runs.find((r) => r.runId === 'a')!.usage).toMatchObject({ noResultCostUsd: 0.2, noResultAgents: [agentRow] })
    expect(o.runs.find((r) => r.runId === 'b')!.usage).not.toHaveProperty('noResultCostUsd')
  })

  it('never shows spend under \'none\' as $0 nor a junk cost as computed (review N1, N2)', () => {
    const list = [
      run('n1', 'p1', 1, usage({ costUsd: 0.5, costSource: 'none' })),
      run('n2', 'p1', 2, usage({ costUsd: null as never, costSource: 'none' })),
      run('n3', 'p1', 3, usage({ costUsd: Number.NaN, costSource: 'computed' })),
      run('n4', 'p1', 4, usage({ roles: [{ ...role('r', 1), costUsd: -1 }] }))
    ]
    const o = buildUsageOverview(list, q(), names, 1)
    const u = (id: string) => o.runs.find((r) => r.runId === id)!.usage
    expect(u('n1')).toMatchObject({ costUsd: 0.5, costSource: 'computed', costPartial: true })
    expect(u('n2')).toMatchObject({ costUsd: null, costSource: 'unknown' })
    expect(u('n3')).toMatchObject({ costUsd: null, costSource: 'unknown' })
    expect(u('n4').roles[0]).toMatchObject({ costUsd: null, costSource: 'unknown' })
    expect(o.projects[0]!.costUnknownRuns).toBe(3)
  })

  it('treats parts of an older partial multi-provider run as lower bounds (review N3)', () => {
    const old = usage({ costUsd: 2, costPartial: true, connections: { anthropic: { costUsd: 1, agents: 1 }, openai: { costUsd: 1, agents: 1 } } })
    const o = buildUsageOverview([run('m', 'p1', 1, old, { connection: 'anthropic' })], q(), names, 1)
    expect(o.connections.every((c) => c.costPartial === true)).toBe(true)
  })

  it('writes the overview CSV with its own columns', () => {
    const o = buildUsageOverview([run('a', 'p2', 1, usage({ retries: 2, nudges: 3, noResultTokens: 4, idleMs: 5.4 }), { connection: 'anthropic' })], q(), names, 1)
    const [head, row] = buildUsageOverviewCsv(o, { offsetMinutes: () => 0 }).replace(/^﻿/, '').split('\r\n')
    expect(head).toBe(`${USAGE_CSV_COLUMNS.join(',')},project_kind,connection,retries,nudges,no_result_tokens,idle_ms`)
    expect(head!.split(',')).toEqual([...USAGE_OVERVIEW_CSV_COLUMNS])
    expect(row!.split(',').slice(-6)).toEqual(['engagement', 'anthropic', '2', '3', '4', '5'])
  })
})
