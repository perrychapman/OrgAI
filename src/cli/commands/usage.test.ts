import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostScope, RunUsage, UsageOverview, UsageOverviewQuery, UsageStats, UsageStatsQuery, UsageStatus } from '../../shared/types'
import { fakeContext, FakeHostClient, project, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { byKind, joinCsv, modelRows, monthOf, overviewQueryOf, runUsage, usageQuery, usageStatusLines } from './usage'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const clients = new WeakMap<object, FakeHostClient>()
function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [project('p1', '/work', { name: 'App' }), project('p2', '/other', { name: 'Other' })], ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  clients.set(f, client)
  return { client, f }
}
async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  const c = clients.get(f)
  if (c) c.closed = false
  try {
    return await runUsage(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

const tokens = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }
function usage(extra: Partial<RunUsage> = {}): RunUsage {
  return { tokens, costUsd: 0.5, costSource: 'computed', models: [], roles: [], wallMs: 1000, turns: 2, toolCalls: 3, retries: 0, agents: 1, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, ...extra } as RunUsage
}
function stats(extra: Partial<UsageStats> = {}): UsageStats {
  return {
    projectId: 'p1',
    runs: [
      { runId: 'r1', kind: 'work', status: 'finished', prompt: 'a', startedAt: 1, usage: usage() },
      { runId: 'r2', kind: 'work', team: 'single', status: 'finished', prompt: 'b', startedAt: 2, usage: usage({ costUsd: null, costSource: 'unknown' }) }
    ],
    roles: [{ roleId: 'x', roleSlug: 'coder', roleName: 'Coder', agents: 2, runs: 2, tokens, costUsd: 0.5, costSource: 'computed', costPartial: true, turns: 1, toolCalls: 1, retries: 0, agentWallMs: 1, agentsWithoutResult: 0, noResultTokens: 0, models: [] }],
    trend: [{ bucket: '2026-11-05', start: 1, runs: 2, tokens, costUsd: 0.5, costUnknownRuns: 1, turns: 1, toolCalls: 1, nudges: 0, retries: 0, wallMs: 1, waitingMs: 0, noResultTokens: 0 }],
    totals: usage({ costUsd: 0.5, costPartial: true }),
    generatedAt: 1,
    ...extra
  }
}

describe('usageQuery', () => {
  // Thursday 5 Nov 2026, 15:30 local.
  const now = new Date(2026, 10, 5, 15, 30).getTime()
  it('maps the ranges and --month', () => {
    expect(usageQuery('p1', {}, now)).toMatchObject({ projectId: 'p1', bucket: 'week' })
    expect(usageQuery('p1', {}, now).since).toBeUndefined()
    expect(usageQuery('p1', {}, now).kinds).toEqual(['work', 'setup', 'mcp-assist', 'skill-assist'])
    expect(usageQuery('p1', { range: 'day' }, now).since).toBe(new Date(2026, 10, 5).getTime())
    expect(usageQuery('p1', { range: 'week' }, now).since).toBe(new Date(2026, 10, 2).getTime())
    expect(usageQuery('p1', { range: 'month' }, now)).toMatchObject({ range: { month: '2026-11' }, bucket: 'day' })
    expect(usageQuery('p1', { month: '2026-09', limit: 20 }, now)).toMatchObject({ range: { month: '2026-09' }, limit: 20 })
    expect(monthOf(new Date(2026, 0, 31).getTime())).toBe('2026-01')
    // A Sunday belongs to the week that started the Monday before.
    expect(usageQuery('p1', { range: 'week' }, new Date(2026, 10, 8, 9).getTime()).since).toBe(new Date(2026, 10, 2).getTime())
  })

  it('refuses bad filters with exit 2 before connecting', async () => {
    const { f } = setup({})
    for (const args of [['--range', 'year'], ['--month', '2026-13'], ['--month', '2026-11', '--range', 'day'], ['--limit', '0'], ['--limit', '5000'], ['csv', '--force']]) {
      expect(await run(f, args)).toBe(EXIT.usage)
    }
    expect(f.connectCalls).toEqual([])
  })
})

describe('usage show', () => {
  it('totals, roles, kinds and trend through the cost view: partial is +, unknown never $0', async () => {
    const { f, client } = setup({ 'runs:usageStats': () => stats() })
    expect(await run(f, ['--range', 'week'])).toBe(0)
    const out = f.out()
    expect(out).toContain('App: 2 runs this week')
    expect(out).toContain('Estimated cost: $0.50+')
    expect(out).toMatch(/Coder\s+2\s+2\s+1\.5k\s+\$0\.50\+/)
    expect(out).toMatch(/Run\s+1\s+1\.5k\s+\$0\.50/)
    expect(out).toMatch(/Ask\s+1\s+1\.5k\s+unknown/)
    expect(out).toMatch(/2026-11-05\s+2\s+1\.5k\s+\$0\.50\+/)
    expect(out).not.toMatch(/\$0\.00/)
    const q = (client.callsOf('runs:usageStats')[0] as [UsageStatsQuery])[0]
    expect(q.projectId).toBe('p1')
    expect(typeof q.since).toBe('number')
  })

  it('byKind sums with sumCosts', () => {
    const k = byKind(stats())
    expect(k.map((x) => x.kind)).toEqual(['Run', 'Ask'])
    expect(k[1].cost).toMatchObject({ costUsd: null, costSource: 'unknown' })
  })

  it('--all-projects covers every stored project; json', async () => {
    const { f, client } = setup({ 'runs:usageStats': (p) => stats({ projectId: (p as [UsageStatsQuery])[0].projectId }) }, { globals: { outputFormat: 'json' }, cwd: '/nowhere' })
    expect(await run(f, ['show', '--all-projects'])).toBe(0)
    expect(client.callsOf('runs:usageStats').map((p) => (p as [UsageStatsQuery])[0].projectId)).toEqual(['p1', 'p2'])
    const j = JSON.parse(f.out())
    expect(j.projects).toHaveLength(2)
    expect(j.projects[0].totals.cost).toBe('$0.50+')
    expect(j.total.cost).toBe('$1.00+')
  })

  it('no project here is exit 2', async () => {
    const { f } = setup({}, { cwd: '/nowhere' })
    expect(await run(f, ['show'])).toBe(EXIT.usage)
  })
})

const mtok = { input: 600, output: 400, cacheRead: 0, cacheWrite: 0 }
describe('usage show: by model', () => {
  const two = (): UsageStats =>
    stats({
      runs: [
        { runId: 'r1', kind: 'work', status: 'finished', prompt: 'a', startedAt: 1, usage: usage({ turns: 4, models: [{ model: 'claude-opus-x', tokens: mtok, costUsd: 0.4, priceSource: 'builtin' }] }) },
        { runId: 'r2', kind: 'work', status: 'finished', prompt: 'b', startedAt: 2, usage: usage({ turns: 6, models: [{ model: 'claude-opus-x', tokens: mtok, costUsd: 0.2, priceSource: 'builtin' }, { model: 'mystery-1', tokens: mtok, costUsd: null, priceSource: 'unknown' }] }) }
      ]
    })
  it('modelRows sums per model: requests only from single-model runs (lower bound otherwise), unknown never $0', () => {
    const rows = modelRows(two().runs.map((r) => r.usage))
    expect(rows[0]).toMatchObject({ model: 'claude-opus-x', runs: 2, requests: 4, requestsExact: false })
    expect(rows[0].cost).toMatchObject({ costUsd: expect.closeTo(0.6) })
    expect(rows[1]).toMatchObject({ model: 'mystery-1', requests: null })
    expect(rows[1].cost).toMatchObject({ costUsd: null, costSource: 'unknown' })
  })
  it('text has the project table and per-run lines', async () => {
    const { f } = setup({ 'runs:usageStats': () => two() })
    expect(await run(f, [])).toBe(0)
    const out = f.out()
    expect(out).toContain('By model')
    expect(out).toMatch(/claude-opus-x\s+2\s+4\+\s+2\.0k\s+\$0\.60/)
    expect(out).toMatch(/mystery-1\s+1\s+-\s+1\.0k\s+unknown/)
    expect(out).toContain('By model, per run')
    expect(out).toMatch(/r1 .*\n\s+claude-opus-x: 4 requests, 1\.0k tokens, \$0\.40/)
  })
  it('json carries byModel and runModels', async () => {
    const { f } = setup({ 'runs:usageStats': () => two() }, { globals: { outputFormat: 'json' } })
    expect(await run(f, ['show'])).toBe(0)
    const j = JSON.parse(f.out())
    expect(j.byModel.map((m: { model: string }) => m.model)).toEqual(['claude-opus-x', 'mystery-1'])
    expect(j.byModel[1].cost).toBe('unknown')
    expect(j.runModels[1].models).toHaveLength(2)
  })
})

describe('usage show --overview', () => {
  const rowUsage = (extra: Partial<RunUsage>): RunUsage => usage({ models: [{ model: 'claude-opus-x', tokens: mtok, costUsd: 1, priceSource: 'builtin' }], ...extra })
  const overview = (): UsageOverview =>
    ({
      runs: [
        { runId: 'run-alone', projectId: 'p1', projectName: 'App', projectKind: 'code', kind: 'work', status: 'finished', prompt: 'solo', startedAt: 3, connection: 'anthropic', usage: rowUsage({ costUsd: 1, agents: 1, wallMs: 60_000 }) },
        { runId: 'run-team', projectId: 'p1', projectName: 'App', projectKind: 'code', kind: 'work', status: 'finished', prompt: 'team', startedAt: 2, connection: 'anthropic', usage: rowUsage({ costUsd: 3, agents: 3, wallMs: 300_000, efficiency: { reports: 2 } as RunUsage['efficiency'] }) },
        { runId: 'run-bad', projectId: 'p1', projectName: 'App', projectKind: 'code', kind: 'work', status: 'error', prompt: 'bad', startedAt: 1, connection: 'anthropic', usage: rowUsage({ costUsd: 2, agents: 2, agentsWithoutResult: 1, noResultTokens: 900, noResultCostUsd: 0.7 }) }
      ],
      models: [{ model: 'claude-opus-x', tokens: mtok, costUsd: 6, priceSource: 'builtin', runs: 3, projects: 1, costKnownRuns: 3, costUnknownRuns: 0 }],
      totals: usage({ costUsd: 6, costSource: 'computed' }),
      matchedRuns: 3
    }) as unknown as UsageOverview
  const answers = (): Record<string, Answer> => ({
    'runs:usageOverview': () => overview(),
    'connections:list': () => [{ connection: { id: 'anthropic', tierModels: { top: 'claude-opus-x' } } }]
  })
  it('queries the overview for the project and prints model, tier, lead and worth-a-look sections', async () => {
    const { f, client } = setup(answers())
    expect(await run(f, ['show', '--overview', '--range', 'month'])).toBe(0)
    const q = (client.callsOf('runs:usageOverview')[0] as [UsageOverviewQuery])[0]
    expect(q.projectIds).toEqual(['p1'])
    expect(q.range).toEqual({ month: monthOf(Date.now()) })
    expect(client.callsOf('runs:usageStats')).toHaveLength(0)
    const out = f.out()
    expect(out).toContain('Overview: 3 runs this month')
    expect(out).toContain('Cost by model')
    expect(out).toMatch(/claude-opus-x\s+3\s+1\.0k\s+\$6/)
    expect(out).toContain('Cost by tier')
    expect(out).toMatch(/Top\s+\$3\.00\s+50%/)
    expect(out).toContain('Not tied to a tier')
    expect(out).toMatch(/Lead alone: 1 run, median 1 min/)
    expect(out).toMatch(/With reports: 1 run, median 5 min/)
    expect(out).toContain('Runs worth a look')
    expect(out).toMatch(/run-bad\s+App\s+.*produced no result/)
  })
  it('--all-projects sends no project ids; json', async () => {
    const { f, client } = setup(answers(), { globals: { outputFormat: 'json' } })
    expect(await run(f, ['show', '--overview', '--all-projects'])).toBe(0)
    expect((client.callsOf('runs:usageOverview')[0] as [UsageOverviewQuery])[0].projectIds).toBeUndefined()
    const j = JSON.parse(f.out()).overview
    expect(j.matchedRuns).toBe(3)
    expect(j.leadAlone.runs).toBe(1)
    expect(j.withReports.runs).toBe(1)
    expect(j.byTier[0]).toMatchObject({ tier: 'top', costUsd: 3 })
    expect(j.worthALook[0].runId).toBe('run-bad')
  })
  it('overviewQueryOf maps the filters', () => {
    const now = new Date(2026, 10, 5, 15, 30).getTime()
    expect(overviewQueryOf(['p1'], { month: '2026-10', limit: 5 }, now)).toMatchObject({ projectIds: ['p1'], range: { month: '2026-10' }, limit: 5 })
    expect('projectId' in overviewQueryOf([], {}, now)).toBe(false)
  })
})

describe('usage csv', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'usage-csv-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const CSV = 'project,client,kind\r\n"=App",,work\r\n'

  it('writes the host CSV as-is to stdout', async () => {
    const { f } = setup({ 'runs:usageCsv': () => CSV })
    expect(await run(f, ['csv'])).toBe(0)
    expect(f.out()).toBe(CSV)
    expect(f.err()).toBe('')
  })

  it('warns on stderr when stdout is a terminal', async () => {
    const { f } = setup({ 'runs:usageCsv': () => CSV })
    ;(f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
    expect(await run(f, ['csv'])).toBe(0)
    expect(f.err()).toContain('Raw CSV follows')
  })

  it('strips terminal control sequences on a terminal only; piped output stays byte-exact', async () => {
    const evil = 'project,title\r\nApp,"Fix\x1b]52;c;QUJD\x07 it \x1b[2J now"\r\n'
    const t = setup({ 'runs:usageCsv': () => evil })
    ;(t.f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
    expect(await run(t.f, ['csv'])).toBe(0)
    expect(t.f.out()).not.toContain('\x1b')
    expect(t.f.out()).not.toContain('\x07')
    expect(t.f.out()).toContain('project,title')
    expect(t.f.out()).toContain('now"')
    expect(t.f.out().split('\n')).toHaveLength(3)
    const p = setup({ 'runs:usageCsv': () => evil })
    expect(await run(p.f, ['csv'])).toBe(0)
    expect(p.f.out()).toBe(evil)
  })

  it('--out writes the file and refuses to overwrite without --force', async () => {
    const out = join(dir, 'u.csv')
    const { f } = setup({ 'runs:usageCsv': () => CSV }, { cwd: '/work' })
    expect(await run(f, ['csv', '--out', out])).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(CSV)
    expect(f.out()).toContain('Wrote 1 run')
    writeFileSync(out, 'keep')
    expect(await run(f, ['csv', '--out', out])).toBe(1)
    expect(f.err()).toContain('Pass --force')
    expect(readFileSync(out, 'utf8')).toBe('keep')
    expect(await run(f, ['csv', '--out', out, '--force'])).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(CSV)
    expect(existsSync(out)).toBe(true)
  })

  it('joinCsv keeps one header', () => {
    expect(joinCsv(['h\r\na\r\n', 'h\r\nb\r\n'])).toBe('h\r\na\r\nb\r\n')
    expect(joinCsv(['h\r\n', 'h\r\n'])).toBe('h\r\n')
    expect(joinCsv([])).toBe('')
  })
})

describe('usage refresh', () => {
  const report: UsageStatus = {
    provider: 'claude',
    authMode: 'subscription',
    subscriptionType: 'max',
    available: true,
    windows: { sevenDay: { utilization: 42, resetsAt: Date.UTC(2026, 10, 9) } },
    modelWindows: [{ model: 'Fable', utilization: 10, resetsAt: null }],
    updatedAt: Date.UTC(2026, 10, 5)
  }
  it('prints the plan windows (operate)', async () => {
    const { f } = setup({ 'usage:refresh': () => report })
    expect(await run(f, ['refresh'])).toBe(0)
    expect(f.out()).toContain('Anthropic (max)')
    expect(f.out()).toContain('Seven-day window: 42% used, resets')
    expect(f.out()).toContain('Weekly Fable: 10% used')
    expect(f.out()).toContain('Five-hour window: not reported by your plan right now.')
    expect(f.connectCalls[0].scopes).toEqual(['read', 'operate'])
  })

  it('names a proxy by its display name, else its id', () => {
    const base = { authMode: 'apiKey', subscriptionType: null, available: true, windows: {}, updatedAt: 1 } as const
    expect(usageStatusLines({ ...base, connection: 'proxy-0a1b2c3d' }, { 'proxy-0a1b2c3d': 'Team gateway' })[0]).toMatch(/^Team gateway,/)
    expect(usageStatusLines({ ...base, connection: 'proxy-0a1b2c3d' })[0]).toMatch(/^proxy-0a1b2c3d,/)
  })

  it('LiteLLM spend periods and a null report', async () => {
    const lines = usageStatusLines({ connection: 'litellm', authMode: 'apiKey', subscriptionType: null, available: true, windows: {}, updatedAt: 1, spend: { usd: 3.2, budgetUsd: null, resetsAt: null, budgetDuration: null, keyAlias: null, totalUsd: 31, periods: { day: { usd: 3.2, since: 0 }, week: { usd: 12.4, since: 0 }, month: { usd: 31, since: 0 } } } })
    expect(lines.join('\n')).toContain('$3.20 today, $12.40 this week, $31.00 this month')
    expect(lines.join('\n')).toContain('Lifetime $31.00')
    const { f } = setup({ 'usage:refresh': () => null })
    expect(await run(f, ['refresh'])).toBe(0)
    expect(f.out()).toContain('No plan usage reported.')
  })
})
