import { describe, expect, it } from 'vitest'
import type { RunUsage, UsageOverview, UsageOverviewRow, UsageProjectRollup } from '@shared/types'
import {
  anyLiveRow,
  cacheHit,
  costCoverage,
  dataNotes,
  emptyModel,
  endedRefetchDelay,
  filterAnnouncement,
  figuresSentence,
  filterOptions,
  kindsButtonText,
  liveNote,
  livePollDue,
  loadedAnnouncement,
  median,
  percentDelta,
  pointsDelta,
  projectOptionGroups,
  projectsButtonText,
  scopeLine,
  showConnectionSelect,
  staleRunIds,
  summaryModel,
  toggleSelection
} from './usagePage'
import { defaultUsageFilters, usageChips, usageData, type UsageFilters } from './usageOverview'

const NOW = new Date(2026, 10, 5, 14, 2).getTime()
const DAY = 86_400_000

function usage(over: Partial<RunUsage> = {}): RunUsage {
  return {
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    costUsd: 1,
    costSource: 'computed',
    models: [{ model: 'sonnet-x', tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, priceSource: 'builtin' }],
    roles: [],
    wallMs: 60_000,
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
  const cost = rows.reduce((a, r) => a + (r.usage.costUsd ?? 0), 0)
  return {
    runs: rows,
    projects: [],
    models: [],
    roles: [],
    connections: [],
    trend: [],
    totals: usage({ costUsd: cost, tokens: rows.reduce((a, r) => ({ input: a.input + r.usage.tokens.input, output: a.output + r.usage.tokens.output, cacheRead: a.cacheRead + r.usage.tokens.cacheRead, cacheWrite: a.cacheWrite + r.usage.tokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), wallMs: rows.length * 60_000 }),
    matchedRuns: rows.length,
    query: { kinds: [], bucket: 'day', limit: 2000 },
    generatedAt: NOW,
    costKnownRuns: rows.length,
    costUnknownRuns: 0,
    ...over
  }
}

const conn = (id: string | null): string => id ?? 'Unknown connection'
const pname = (id: string): string => (id === 'p1' ? 'Billing' : id)
const f0 = defaultUsageFilters()
const data = (rows: UsageOverviewRow[], over: Partial<UsageOverview> = {}, f: UsageFilters = f0) => usageData(overview(rows, over), f, conn)

describe('scope line', () => {
  it('names everything, one project, several, or the kinds', () => {
    expect(scopeLine(f0, 212, pname, NOW)).toBe('All projects and chats, 7 Oct to 5 Nov 2026 · 212 runs')
    expect(scopeLine({ ...f0, projectIds: ['p1'] }, 1, pname, NOW)).toBe('Billing, 7 Oct to 5 Nov 2026 · 1 run')
    expect(scopeLine({ ...f0, projectIds: ['a', 'b', 'c'] }, null, pname, NOW)).toBe('3 projects, 7 Oct to 5 Nov 2026')
    expect(scopeLine({ ...f0, kinds: ['work', 'setup'] }, 4, pname, NOW)).toContain('Work runs and Setup')
    expect(scopeLine({ ...f0, projectIds: ['p1'], kinds: ['chat'] }, 4, pname, NOW)).toContain('Billing, Chat')
  })
})

describe('figures', () => {
  it('cache hit is a share, and never 0 when nothing was reported', () => {
    expect(cacheHit({ input: 100, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(cacheHit({ input: 20, output: 5, cacheRead: 70, cacheWrite: 10 })).toBeCloseTo(0.7)
    expect(cacheHit({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })
  it('takes a median', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 10])).toBe(2.5)
  })
  it('words deltas and omits unusable ones', () => {
    expect(percentDelta(112, 100, 'the previous 30 days')).toBe('up 12% on the previous 30 days')
    expect(percentDelta(80, 100, 'x')).toBe('down 20% on x')
    expect(percentDelta(100.2, 100, 'x')).toBe('about the same as x')
    expect(percentDelta(5, 0, 'x')).toBeNull()
    expect(percentDelta(5, Number.NaN, 'x')).toBeNull()
    expect(pointsDelta(0.5, 0.46, 'x')).toBe('up 4 points on x')
    expect(pointsDelta(0.5, 0.5, 'x')).toBe('about the same as x')
  })
  it('counts coverage and phrases the no-price link', () => {
    expect(costCoverage({ runs: 4, costKnownRuns: 4, costUnknownRuns: 0 })).toBeNull()
    expect(costCoverage({ runs: 4, costKnownRuns: 3, costUnknownRuns: 1 })).toEqual({ line: 'from 3 of 4 runs', noPrice: 1, noPriceLabel: '1 run has no price' })
    expect(costCoverage({ runs: 4, costKnownRuns: 0, costUnknownRuns: 4 })?.line).toBe('from 0 of 4 runs')
    expect(costCoverage({ runs: 4, costKnownRuns: 2, costUnknownRuns: 2 })?.noPriceLabel).toBe('2 runs have no price')
  })
  it('words the live note', () => {
    expect(liveNote(0)).toBeNull()
    expect(liveNote(1)).toBe('1 run is still going; its figures will grow.')
    expect(liveNote(3)).toBe('3 runs are still going; their figures will grow.')
  })
})

describe('summary model', () => {
  const opts = { truncated: false, words: 'the previous 30 days', model: null }
  it('builds five figures with deltas from the previous span', () => {
    const cur = data([row('a', { usage: usage({ costUsd: 6 }) }), row('b', { usage: usage({ costUsd: 4 }) })])
    const prev = data([row('c', { usage: usage({ costUsd: 5 }) })])
    const m = summaryModel(cur, { data: prev, truncated: false }, opts)
    expect(m.map((i) => i.signal)).toEqual(['cost', 'runs', 'cost-per-run', 'cache', 'wall'])
    expect(m[0]!.label).toBe('Estimated cost')
    expect(m[0]!.delta).toBe('up 100% on the previous 30 days')
    expect(m[1]!.text).toBe('2')
    expect(m[1]!.delta).toBe('up 100% on the previous 30 days')
    expect(m[2]!.cost?.costUsd).toBe(5)
    expect(m[2]!.delta).toBe('about the same as the previous 30 days')
    expect(m[3]!.text).toBe('Not reported')
    expect(m[3]!.delta).toBeNull()
    expect(m[4]!.text).toBe('2m 00s')
  })
  it('omits deltas without a previous span, and never invents a zero', () => {
    const cur = data([row('a')])
    expect(summaryModel(cur, null, opts).every((i) => i.delta === null)).toBe(true)
    const empty = data([])
    expect(summaryModel(cur, { data: empty, truncated: false }, opts).every((i) => i.delta === null)).toBe(true)
  })
  it('does not compare a partial cost', () => {
    const partial = row('p', { usage: usage({ costUsd: 2, costPartial: true }) })
    const cur = data([partial], { costUnknownRuns: 1, costKnownRuns: 0, totals: usage({ costUsd: 2, costPartial: true }) })
    const prev = data([row('c')])
    expect(summaryModel(cur, { data: prev, truncated: false }, opts)[0]!.delta).toBeNull()
  })
  it('reads a Model cost view and no price', () => {
    const unknown = row('u', { usage: usage({ costUsd: null, costSource: 'unknown', models: [{ model: 'x', tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: null, priceSource: 'unknown' }] }) })
    const d = data([unknown], { costKnownRuns: 0, costUnknownRuns: 1, totals: usage({ costUsd: null, costSource: 'unknown' }) })
    const m = summaryModel(d, null, opts)
    expect(m[0]!.noPriceText).toBe('No price')
    expect(m[2]!.noPriceText).toBe('No price')
    const chip = { ...f0, model: 'sonnet-x' }
    const md = data([row('a')], {}, chip)
    const mm = summaryModel(md, null, { ...opts, model: 'sonnet-x' })
    expect(mm[0]!.label).toBe('Model cost')
    expect(mm[0]!.title).toMatch(/this model only/)
    expect(mm[2]!.label).toBe('Model cost per run')
  })
  it('marks folded truncated figures as a lower bound', () => {
    const f = { ...f0, noPrice: true }
    const r = row('a', { usage: usage({ costUsd: 2, costPartial: true }) })
    const d = data([r], { truncated: true, matchedRuns: 3000 }, f)
    const m = summaryModel(d, null, { ...opts, truncated: true })
    expect(d.lowerBound).toBe(true)
    expect(m[0]!.atLeast).toBe(true)
    expect(m[0]!.cost?.costPartial).toBe(true)
    expect(m[1]!.atLeast).toBe(true)
    expect(m[2]!.title).toMatch(/newest 2,000/)
  })
})

describe('notes', () => {
  const base = { truncated: false, matchedRuns: 4, spanDays: 30, now: NOW }
  it('words truncation against the contract, with the cut date', () => {
    const d = data([row('a')], { truncated: true, matchedRuns: 2430, oldestIncludedAt: new Date(2026, 9, 12).getTime() })
    const n = dataNotes({ ...base, data: d, truncated: true, matchedRuns: 2430, oldestIncludedAt: new Date(2026, 9, 12).getTime(), spanDays: 90 })
    expect(n.truncated?.text).toContain('newest 2,000 of 2,430 runs')
    expect(n.truncated?.text).toContain('Runs before 12 Oct are not listed.')
    expect(n.truncated?.text).toContain('Totals and charts still count every run.')
    expect(n.truncated?.offerThirtyDays).toBe(true)
    const folded = data([row('a')], { truncated: true }, { ...f0, noPrice: true })
    expect(dataNotes({ ...base, data: folded, truncated: true }).truncated?.text).toContain('at least these amounts')
    expect(dataNotes({ ...base, data: d, truncated: true, spanDays: 30 }).truncated?.offerThirtyDays).toBe(false)
  })
  it('words partial, unpriced and legacy notes', () => {
    const partial = data([row('a'), row('b', { usage: usage({ costUsd: null, costSource: 'unknown' }) })], { costKnownRuns: 1, costUnknownRuns: 1, totals: usage({ costUsd: 1, costPartial: true }) })
    expect(dataNotes({ ...base, data: partial }).partial).toBe('1 run has no known price, so costs are at least these figures.')
    const unpriced = data([row('u', { usage: usage({ costUsd: null, costSource: 'unknown' }) })], { costKnownRuns: 0, costUnknownRuns: 1, totals: usage({ costUsd: null, costSource: 'unknown' }), models: [{ model: 'x', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: null, priceSource: 'unknown', runs: 1, projects: 1, costKnownRuns: 0, costUnknownRuns: 1 }] })
    const n = dataNotes({ ...base, data: unpriced })
    expect(n.unpriced).toBe('No price is known for 1 model, so cost cannot be shown. Tokens are counted.')
    expect(n.partial).toBeNull()
    const legacy = data([row('l', { legacy: true, usage: usage({ legacy: true }) })])
    expect(dataNotes({ ...base, data: legacy }).legacy).toBe('1 run is from before OrgAI measured usage. Their tokens and cost are rough, and they have no efficiency figures.')
    expect(dataNotes({ ...base, data: data([row('a')]) })).toEqual({ truncated: null, partial: null, unpriced: null, legacy: null })
  })
})

describe('empty state', () => {
  it('names the period and the most recent run', () => {
    const e = emptyModel({ ...f0, period: { kind: 'days', days: 7 } }, [], new Date(2026, 9, 28).getTime(), NOW)
    expect(e.title).toBe('No runs match these filters')
    expect(e.description).toBe('No runs in the last 7 days. The most recent run was on 28 Oct.')
    expect(e.canUseThirtyDays).toBe(true)
    expect(e.canClear).toBe(false)
  })
  it('names a narrowing before the period', () => {
    const f = { ...f0, model: 'opus-x' }
    const chips = usageChips(f, { project: pname, connection: conn })
    const e = emptyModel(f, chips, null, NOW)
    expect(e.description).toBe('No runs in the last 30 days match Model: opus-x.')
    expect(e.canClear).toBe(true)
    expect(e.canUseThirtyDays).toBe(false)
    const p = emptyModel({ ...f0, projectIds: ['p1'] }, usageChips({ ...f0, projectIds: ['p1'] }, { project: pname, connection: conn }), null, NOW)
    expect(p.description).toContain('projects or kinds you chose')
  })
})

describe('announcements', () => {
  const cost = { costUsd: 42.1, costSource: 'computed' as const, sourceMixed: true }
  it('says counts and the estimate', () => {
    expect(loadedAnnouncement(212, cost)).toBe('Usage loaded. 212 runs, estimated $42.10.')
    expect(filterAnnouncement('added', 'Project: Billing', 14, { ...cost, costUsd: 6.1 })).toBe('Filter added: Project: Billing. 14 runs, estimated $6.10.')
    expect(filterAnnouncement('cleared', null, 1, cost)).toBe('Filters cleared. 1 run, estimated $42.10.')
    expect(filterAnnouncement('removed', 'Model: x', 3, { costUsd: null, costSource: 'unknown' })).toBe('Filter removed: Model: x. 3 runs, cost unknown.')
    expect(figuresSentence(0, { costUsd: 0, costSource: 'none' })).toBe('0 runs.')
  })
})

describe('live policy', () => {
  const rows = [row('live', { live: true }), row('done')]
  it('finds runs that ended or paused since the overview', () => {
    const facts = [
      { id: 'live', status: 'finished' as const, startedAt: NOW - 1000 },
      { id: 'done', status: 'finished' as const, startedAt: NOW - DAY },
      { id: 'new', status: 'paused' as const, startedAt: NOW - 500, endedAt: NOW + 100 },
      { id: 'old', status: 'finished' as const, startedAt: NOW - 500, endedAt: NOW - 100 },
      { id: 'out', status: 'finished' as const, startedAt: NOW - 100 * DAY, endedAt: NOW + 100 }
    ]
    expect(staleRunIds(rows, facts, NOW, NOW - 30 * DAY)).toEqual(['live', 'new'])
  })
  it('ignores runs that are still live in the store', () => {
    expect(staleRunIds(rows, [{ id: 'live', status: 'running', startedAt: NOW }], NOW, 0)).toEqual([])
    expect(staleRunIds(rows, [{ id: 'live', status: 'idle', startedAt: NOW }], NOW, 0)).toEqual([])
  })
  it('finds a live run the overview never listed that started after it was generated', () => {
    const facts = [
      { id: 'fresh', status: 'running' as const, startedAt: NOW + 500 },
      { id: 'just-before', status: 'starting' as const, startedAt: NOW - 1000 },
      { id: 'old-live', status: 'running' as const, startedAt: NOW - 60_000 },
      { id: 'out', status: 'running' as const, startedAt: NOW - 100 * DAY }
    ]
    expect(staleRunIds(rows, facts, NOW, NOW - 30 * DAY)).toEqual(['fresh', 'just-before'])
  })
  it('polls only while live, focused and visible', () => {
    expect(anyLiveRow(rows)).toBe(true)
    expect(anyLiveRow([row('x')])).toBe(false)
    expect(livePollDue({ anyLive: true, focused: true, visible: true })).toBe(true)
    expect(livePollDue({ anyLive: false, focused: true, visible: true })).toBe(false)
    expect(livePollDue({ anyLive: true, focused: false, visible: true })).toBe(false)
    expect(livePollDue({ anyLive: true, focused: true, visible: false })).toBe(false)
  })
  it('throttles the ended refetch to once per 5 s, never under 500 ms', () => {
    expect(endedRefetchDelay(NOW - 60_000, NOW)).toBe(500)
    expect(endedRefetchDelay(NOW - 1000, NOW)).toBe(4000)
    expect(endedRefetchDelay(NOW, NOW)).toBe(5000)
  })
})

describe('filter bar helpers', () => {
  const stats = new Map<string, UsageProjectRollup>([
    ['p1', rollup('p1', 'Billing', 3, 5)],
    ['gone', { ...rollup('gone', 'Removed project', 1, 1), projectRemoved: true }],
    ['quick', { ...rollup('quick', 'Chat', 2, 0.5), projectKind: 'assistant' }]
  ])
  function rollup(id: string, name: string, runs: number, cost: number): UsageProjectRollup {
    return {
      projectId: id, projectName: name, projectKind: 'code', runs, runsByKind: {}, firstStartedAt: 0, lastStartedAt: 0,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: cost, costSource: 'computed', turns: 0, toolCalls: 0, retries: 0, nudges: 0,
      wallMs: 0, waitingMs: 0, idleMs: 0, limitHoldMs: 0, agents: 0, agentsWithoutResult: 0, noResultTokens: 0, noResultCostUsd: 0, connections: [], costKnownRuns: runs, costUnknownRuns: 0
    }
  }
  it('groups projects, dims the unused and puts removed ones last', () => {
    const groups = projectOptionGroups(
      [
        { id: 'p0', name: 'Aaa unused' },
        { id: 'p1', name: 'Billing' },
        { id: 'e1', name: 'Audit', kind: 'engagement', client: 'Acme' }
      ],
      stats
    )
    expect(groups.map((g) => g.label)).toEqual(['Code projects', 'Engagements', 'Assistants', 'Removed projects'])
    expect(groups[0]!.options.map((o) => o.id)).toEqual(['p1', 'p0'])
    expect(groups[0]!.options[1]!.runs).toBe(0)
    expect(groups[2]!.options.map((o) => o.id)).toEqual(['quick', 'harness', 'skills'])
    expect(groups[3]!.options[0]).toMatchObject({ id: 'gone', removed: true, name: 'Removed project' })
  })
  it('splits engagements under two or more clients', () => {
    const groups = projectOptionGroups(
      [
        { id: 'e1', name: 'Audit', kind: 'engagement', client: 'Acme' },
        { id: 'e2', name: 'Review', kind: 'engagement', client: 'Beta' },
        { id: 'e3', name: 'Loose', kind: 'engagement' }
      ],
      new Map()
    )
    expect(groups.map((g) => g.label)).toEqual(['Engagements: Acme', 'Engagements: Beta', 'Engagements: no client', 'Assistants'])
  })
  it('toggles a no-ids-means-all selection', () => {
    const all = ['a', 'b', 'c']
    expect(toggleSelection([], all, 'b', false)).toEqual(['a', 'c'])
    expect(toggleSelection(['a', 'c'], all, 'b', true)).toEqual([])
    expect(toggleSelection(['a'], all, 'c', true)).toEqual(['a', 'c'])
    expect(toggleSelection(['a'], all, 'a', false)).toEqual(['a'])
  })
  it('words the buttons and searches by name', () => {
    expect(projectsButtonText({ projectIds: [] }, pname)).toBe('All projects')
    expect(projectsButtonText({ projectIds: ['p1'] }, pname)).toBe('Billing')
    expect(projectsButtonText({ projectIds: ['a', 'b'] }, pname)).toBe('2 projects')
    expect(kindsButtonText({ kinds: [] })).toBe('All kinds')
    expect(kindsButtonText({ kinds: ['chat'] })).toBe('Chat')
    expect(kindsButtonText({ kinds: ['chat', 'ask'] })).toBe('2 kinds')
    const opts = projectOptionGroups([{ id: 'p1', name: 'Billing' }, { id: 'p2', name: 'Docs' }], new Map())[0]!.options
    expect(filterOptions(opts, 'bil').map((o) => o.id)).toEqual(['p1'])
    expect(filterOptions(opts, ' ').length).toBe(2)
  })
  it('shows the connection select only with a choice', () => {
    expect(showConnectionSelect([{ connection: 'anthropic' }], null)).toBe(false)
    expect(showConnectionSelect([{ connection: 'anthropic' }, { connection: 'openai' }], null)).toBe(true)
    expect(showConnectionSelect([{ connection: 'anthropic' }], 'openai')).toBe(true)
  })
})
