import { describe, expect, it } from 'vitest'
import type { RunUsage, UsageOverview, UsageOverviewRow } from '@shared/types'
import {
  autoBucket,
  bucketChipText,
  bucketPickOf,
  bucketRefusal,
  clearedFilters,
  defaultUsageFilters,
  effectiveBucket,
  narrowFilters,
  needsClientFold,
  overviewQuery,
  parseStoredUsage,
  periodLabel,
  periodSpan,
  pickMonths,
  previousQuery,
  previousSpan,
  storedUsage,
  usageChips,
  usageData,
  usageKindOf,
  withoutChip,
  type UsageFilters
} from './usageOverview'

const NOW = new Date(2026, 10, 5, 14, 2).getTime() // Thu 5 Nov 2026 14:02 local
const DAY = 86_400_000

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    costUsd: 1,
    costSource: 'computed',
    models: [{ model: 'sonnet-x', tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, priceSource: 'builtin' }],
    roles: [
      { roleId: 'r1', roleSlug: 'lead', roleName: 'Lead', agents: 1, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, costSource: 'computed', turns: 2, toolCalls: 1, retries: 0, agentWallMs: 10, agentsWithoutResult: 0, noResultTokens: 0, models: ['sonnet-x'] }
    ],
    wallMs: 1000,
    turns: 2,
    toolCalls: 1,
    retries: 0,
    agents: 1,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: NOW,
    ...over
  }
}

function row(id: string, over: Partial<UsageOverviewRow> = {}): UsageOverviewRow {
  return { runId: id, kind: 'work', status: 'finished', prompt: id, startedAt: NOW - DAY, usage: usage(), projectId: 'p1', projectName: 'Billing', projectKind: 'code', connection: 'anthropic', ...over }
}

function overview(rows: UsageOverviewRow[], over: Partial<UsageOverview> = {}): UsageOverview {
  return {
    runs: rows,
    projects: [],
    models: [],
    roles: [],
    connections: [],
    trend: [],
    totals: usage({ costUsd: 99 }),
    matchedRuns: rows.length,
    query: { kinds: [], bucket: 'day', limit: 2000 },
    generatedAt: NOW,
    costKnownRuns: rows.length,
    costUnknownRuns: 0,
    ...over
  }
}

const names = { project: (id: string) => (id === 'p1' ? 'Billing' : id), connection: (id: string) => id }
const conn = (id: string | null): string => id ?? 'Unknown connection'

describe('period and bucket', () => {
  it('spans presets in local days', () => {
    const s30 = periodSpan({ kind: 'days', days: 30 }, NOW)
    expect(new Date(s30.since).getDate()).toBe(7)
    expect(new Date(s30.since).getMonth()).toBe(9)
    expect(s30.days).toBe(30)
    const tm = periodSpan({ kind: 'this-month' }, NOW)
    expect(new Date(tm.since).getDate()).toBe(1)
    expect(tm.days).toBe(5)
    const lm = periodSpan({ kind: 'last-month' }, NOW)
    expect(new Date(lm.since).getMonth()).toBe(9)
    expect(lm.days).toBe(31)
    const ms = periodSpan({ kind: 'months', from: '2026-08', to: '2026-10' }, NOW)
    expect(ms.days).toBe(92)
  })
  it('gives the equal previous span', () => {
    const prev = previousSpan({ kind: 'days', days: 7 }, NOW)
    expect(prev.until).toBe(periodSpan({ kind: 'days', days: 7 }, NOW).since)
    expect(prev.days).toBe(7)
    expect(new Date(previousSpan({ kind: 'this-month' }, NOW).since).getMonth()).toBe(9)
    expect(new Date(previousSpan({ kind: 'months', from: '2026-09', to: '2026-10' }, NOW).since).getMonth()).toBe(6)
  })
  it('picks and refuses buckets by span', () => {
    expect(autoBucket(30)).toBe('day')
    expect(autoBucket(62)).toBe('week')
    expect(autoBucket(120)).toBe('month')
    expect(bucketRefusal('day', 93)).toMatch(/92/)
    expect(bucketRefusal('month', 30)).toMatch(/60/)
    expect(bucketRefusal('week', 30)).toBeNull()
    expect(effectiveBucket({ period: { kind: 'days', days: 30 }, bucket: 'month' }, NOW)).toBe('day')
    expect(effectiveBucket({ period: { kind: 'days', days: 30 }, bucket: 'week' }, NOW)).toBe('week')
  })
  it('moves To up when From passes it', () => {
    const r = pickMonths({ kind: 'months', from: '2026-08', to: '2026-09' }, 'from', '2026-10', NOW)
    expect(r.period).toEqual({ kind: 'months', from: '2026-10', to: '2026-10' })
    expect(r.moved).toMatch(/^To month moved to /)
  })
  it('labels the period', () => {
    expect(periodLabel({ kind: 'days', days: 30 }, NOW)).toBe('7 Oct to 5 Nov 2026 (30 days)')
  })
  it('persists period and bucket only, refusing junk', () => {
    const f: UsageFilters = { ...defaultUsageFilters(), period: { kind: 'last-month' }, bucket: 'week', projectIds: ['p1'] }
    expect(parseStoredUsage(storedUsage(f), NOW)).toEqual({ period: { kind: 'last-month' }, bucket: 'week' })
    expect(parseStoredUsage('{"period":{"kind":"days","days":9}}', NOW).period).toEqual({ kind: 'days', days: 30 })
    expect(parseStoredUsage('nope', NOW).bucket).toBeNull()
  })
})

describe('query', () => {
  it('sends period, kinds and projects only', () => {
    const q = overviewQuery({ ...defaultUsageFilters(), kinds: ['ask', 'setup'], projectIds: ['p1'], model: 'm' }, NOW)
    expect(q.kinds?.sort()).toEqual(['setup', 'work'])
    expect(q.projectIds).toEqual(['p1'])
    expect(q.limit).toBe(2000)
    expect(q.bucket).toBe('day')
    expect(overviewQuery(defaultUsageFilters(), NOW).kinds).toBeUndefined()
    expect(previousQuery(defaultUsageFilters(), NOW).until).toBe(periodSpan({ kind: 'days', days: 30 }, NOW).since)
  })
  it('knows the page kinds', () => {
    expect(usageKindOf(row('a'))).toBe('work')
    expect(usageKindOf(row('a', { team: 'single' }))).toBe('ask')
    expect(usageKindOf(row('a', { projectId: 'quick', team: 'single' }))).toBe('chat')
    expect(usageKindOf(row('a', { kind: 'mcp-assist' }))).toBe('assistants')
    expect(usageKindOf(row('a', { kind: 'setup' }))).toBe('setup')
  })
  it('folds on the client only for narrowings main does not cover', () => {
    expect(needsClientFold(defaultUsageFilters())).toBe(false)
    expect(needsClientFold({ ...defaultUsageFilters(), projectIds: ['p1'] })).toBe(false)
    expect(needsClientFold({ ...defaultUsageFilters(), kinds: ['setup'] })).toBe(false)
    expect(needsClientFold({ ...defaultUsageFilters(), kinds: ['ask'] })).toBe(true)
    expect(needsClientFold({ ...defaultUsageFilters(), model: 'x' })).toBe(true)
  })
})

describe('usageData', () => {
  const rows = [
    row('a'),
    row('b', { projectId: 'p2', projectName: 'Docs', usage: usage({ costUsd: null, costSource: 'unknown', models: [{ model: 'mystery', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: null, priceSource: 'unknown' }] }) }),
    row('c', { team: 'single', startedAt: NOW - 3 * DAY, usage: usage({ costUsd: 2, costPartial: true }) })
  ]
  it('uses the server rollups without a narrowing', () => {
    const d = usageData(overview(rows), defaultUsageFilters(), conn)
    expect(d.folded).toBe(false)
    expect(d.totals.cost.costUsd).toBe(99)
    expect(d.rows).toHaveLength(3)
  })
  it('folds rows for a model: model cost, coverage and a partial total', () => {
    const d = usageData(overview(rows), { ...defaultUsageFilters(), model: 'sonnet-x' }, conn)
    expect(d.folded).toBe(true)
    expect(d.modelCost).toBe(true)
    expect(d.rows.map((r) => r.runId)).toEqual(['a', 'c'])
    expect(d.totals.cost.costUsd).toBe(2)
    expect(d.models.map((m) => m.model)).toEqual(['sonnet-x'])
  })
  it('never turns unknown into zero and marks a lower bound', () => {
    const d = usageData(overview(rows), { ...defaultUsageFilters(), kinds: ['work', 'ask'] }, conn)
    expect(d.totals.costUnknownRuns).toBe(2)
    expect(d.totals.costKnownRuns).toBe(1)
    expect(d.totals.cost.costPartial).toBe(true)
    const docs = d.projects.find((p) => p.projectId === 'p2')!
    expect(docs.costUsd).toBeNull()
    expect(d.projects[0]!.projectId).toBe('p1')
    const unpriced = usageData(overview(rows), { ...defaultUsageFilters(), model: 'mystery' }, conn)
    expect(unpriced.totals.cost.costUsd).toBeNull()
  })
  it('narrows to a bucket and to Ask runs', () => {
    const pick = bucketPickOf({ start: NOW - 3 * DAY }, 'day')
    expect(usageData(overview(rows), { ...defaultUsageFilters(), bucketPick: pick }, conn).rows.map((r) => r.runId)).toEqual(['c'])
    expect(usageData(overview(rows), { ...defaultUsageFilters(), kinds: ['ask'] }, conn).rows.map((r) => r.runId)).toEqual(['c'])
    const d = usageData(overview(rows), { ...defaultUsageFilters(), noPrice: true }, conn)
    expect(d.rows.map((r) => r.runId)).toEqual(['b', 'c'])
    expect(d.trend.length).toBe(2)
  })
  it('marks folded figures of a truncated overview as a lower bound', () => {
    expect(usageData(overview(rows, { truncated: true }), { ...defaultUsageFilters(), noPrice: true }, conn).lowerBound).toBe(true)
  })
  it('folds roles per project and role', () => {
    const d = usageData(overview(rows), { ...defaultUsageFilters(), role: { projectId: 'p1', roleKey: 'r1', label: 'Billing / Lead' } }, conn)
    expect(d.rows.map((r) => r.runId)).toEqual(['a', 'c'])
    expect(d.roles).toHaveLength(1)
    expect(d.roles[0]!.runs).toBe(2)
  })
})

describe('chips', () => {
  it('lists one chip per narrowing and removes them one by one', () => {
    const f = narrowFilters({ ...defaultUsageFilters(), period: { kind: 'last-month' } }, { projectId: 'p1', model: 'sonnet-x', noPrice: true })
    const chips = usageChips(f, names)
    expect(chips.map((c) => c.text)).toEqual(['Project: Billing', 'Model: sonnet-x', 'Cost: no price', 'Period: Last month'])
    expect(chips[0]!.removeLabel).toBe('Remove filter: Project Billing')
    let g = f
    for (const c of chips) g = withoutChip(g, c)
    expect(usageChips(g, names)).toEqual([])
    expect(clearedFilters(f).period).toEqual({ kind: 'last-month' })
    expect(clearedFilters(f).projectIds).toEqual([])
  })
  it('words bucket chips', () => {
    const d = new Date(2026, 10, 3).getTime()
    expect(bucketChipText({ start: d, size: 'day' })).toBe('Day: Tue 3 Nov')
    expect(bucketChipText({ start: new Date(2026, 10, 2).getTime(), size: 'week' })).toBe('Week of 2 Nov')
    expect(bucketChipText({ start: new Date(2026, 9, 1).getTime(), size: 'month' })).toBe('Month: Oct 2026')
  })
})
