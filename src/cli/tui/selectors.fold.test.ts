import { describe, expect, it } from 'vitest'
import type { AgentInstance, PermissionRequest, RunEvent } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { cardsByAgent, collapseTarget, orgTreeRows, resolveSelectedRow, trayCards } from './selectors'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import { treeCounts } from './treeRows'
import type { TuiState } from './types'

const P = project('p1', '/work', { name: 'Shop' })

const agent = (id: string, parentId: string | null, extra: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id,
  name: 'Worker',
  parentId,
  spawnToolUseId: null,
  state: 'thinking',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...extra
})

const NOW = 1_000_000
const OLD = NOW - 60_000

/** [mock:deep-tree]: root -> mock-lead -> two reports that finished long ago; the lead is still thinking. */
function deepTree(extra: Record<string, AgentInstance> = {}, over: { reportsEndedAt?: number } = {}): TuiState {
  const endedAt = over.reportsEndedAt ?? OLD
  const agents: Record<string, AgentInstance> = {
    root: agent('root', null, { name: 'Orchestrator', state: 'delegating' }),
    lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', startedAt: 2 }),
    r1: agent('r1', 'lead', { name: 'Reporter', handle: 'mock-lead-report-1', state: 'done', startedAt: 3, endedAt, costUsd: 0.01 }),
    r2: agent('r2', 'lead', { name: 'Reporter', handle: 'mock-lead-report-2', state: 'done', startedAt: 4, endedAt, costUsd: 0.02 }),
    ...extra
  }
  let s: TuiState = { ...createInitialState('/work'), project: P }
  s = applyRecord(s, { ...record(summary('r1run', { status: 'running' })), agents })
  return setActiveRun(s, 'r1run')
}

const perm = (id: string, agentId: string): PermissionRequest => ({ id, runId: 'r1run', agentId, toolName: 'Bash', input: { command: 'npm test' }, summary: 'npm test' }) as PermissionRequest
let seq = 0
const withCard = (s: TuiState, request: PermissionRequest): TuiState =>
  applyEvent(s, { seq: ++seq, event: { type: 'permission.request', runId: 'r1run', request } as RunEvent })

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id)

describe('orgTreeRows: Hide finished (F1)', () => {
  it('without options nothing folds (the flat tree)', () => {
    expect(ids(orgTreeRows(deepTree()))).toEqual(['root', 'lead', 'r1', 'r2'])
  })

  it('deep tree after settle: three rows, the finished reports are one "2 done" group under the lead', () => {
    const rows = orgTreeRows(deepTree(), { collapse: true, now: NOW })
    expect(rows.map((r) => [r.kind, r.label, r.depth])).toEqual([
      ['agent', 'Orchestrator', 0],
      ['agent', 'mock-lead', 1],
      ['group', '2 done', 2]
    ])
    const group = rows[2]
    expect(group).toMatchObject({ count: 2, failed: 0, groupKey: 'lead', members: ['r1', 'r2'], parentId: 'lead', costText: '$0.03' })
    expect(group.activity).toBe('mock-lead-report-1, mock-lead-report-2')
  })

  it('inside the 6 s grace the reports are still shown', () => {
    const s = deepTree({}, { reportsEndedAt: NOW - 1000 })
    expect(ids(orgTreeRows(s, { collapse: true, now: NOW }))).toEqual(['root', 'lead', 'r1', 'r2'])
    expect(ids(orgTreeRows(s, { collapse: true, now: NOW + 6000 }))).toEqual(['root', 'lead', 'group:r1run:lead'])
  })

  it('an agent with an open card is never folded, even when its state says done', () => {
    const s = withCard(deepTree(), perm('c1', 'r2'))
    const rows = orgTreeRows(s, { collapse: true, now: NOW })
    expect(ids(rows)).toEqual(['root', 'lead', 'r2', 'group:r1run:lead'])
    expect(rows[2]).toMatchObject({ waiting: 1 })
    expect(rows[3]).toMatchObject({ count: 1 })
  })

  it('failed agents are counted in the group, never hidden entirely', () => {
    const s = deepTree({ w: agent('w', 'root', { state: 'error', startedAt: 5, endedAt: OLD, handle: 'writer-1' }), d: agent('d', 'root', { state: 'done', startedAt: 6, endedAt: OLD }) })
    const rows = orgTreeRows(s, { collapse: true, now: NOW })
    const g = rows.find((r) => r.groupKey === 'root')!
    expect(g).toMatchObject({ kind: 'group', count: 2, failed: 1, stateWord: '(1 failed)', depth: 1 })
    expect(g.label).toBe('2 done')
  })

  it('expanding a group shows its reports; a number keeps only the ones finished by then', () => {
    const open = orgTreeRows(deepTree(), { collapse: true, expanded: { lead: true }, now: NOW })
    expect(ids(open)).toEqual(['root', 'lead', 'r1', 'r2'])
    // Expanded at NOW-30 s: both reports ended 60 s ago, so they stay shown.
    expect(ids(orgTreeRows(deepTree(), { collapse: true, expanded: { lead: NOW - 30_000 }, now: NOW }))).toEqual(['root', 'lead', 'r1', 'r2'])
    // Expanded before one finished: that one folds again.
    const later = deepTree({ r2: agent('r2', 'lead', { state: 'done', startedAt: 4, endedAt: NOW - 20_000, handle: 'mock-lead-report-2' }) })
    expect(ids(orgTreeRows(later, { collapse: true, expanded: { lead: NOW - 30_000 }, now: NOW }))).toEqual(['root', 'lead', 'r1', 'group:r1run:lead'])
  })

  it('folds a whole finished subtree into one group under the nearest visible ancestor', () => {
    const s = deepTree({ lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', startedAt: 2, state: 'done', endedAt: OLD }) })
    const rows = orgTreeRows(s, { collapse: true, now: NOW })
    expect(rows.map((r) => [r.label, r.count])).toEqual([['Orchestrator', undefined], ['3 done', 3]])
  })

  it('earlier sessions fold into one row until opened', () => {
    let s = deepTree()
    s = applyRecord(s, { ...record(summary('old', { status: 'finished', startedAt: 1, endedAt: 2, sessionId: 'x' })), agents: { root: agent('root', null, { state: 'done' }), o1: agent('o1', 'root', { state: 'done', handle: 'old-1' }) } })
    s = setActiveRun(s, 'r1run', ['old', 'r1run'])
    const folded = orgTreeRows(s, { collapse: true, now: NOW })
    const earlier = folded.filter((r) => r.earlier)
    expect(earlier.map((r) => [r.kind, r.label, r.groupKey])).toEqual([['group', '1 done', 'earlier:old']])
    const open = orgTreeRows(s, { collapse: true, expanded: { 'earlier:old': NOW }, now: NOW }).filter((r) => r.earlier)
    expect(open.map((r) => [r.id, r.earlierKey])).toEqual([['old:o1', 'earlier:old']])
    expect(collapseTarget(orgTreeRows(s, { collapse: true, expanded: { 'earlier:old': NOW }, now: NOW }), 'old:o1', { 'earlier:old': NOW })).toBe('earlier:old')
  })
})

describe('row facts (F2, F5, F10)', () => {
  it('drops a role the label already carries and keeps one it does not', () => {
    const s = deepTree({ w: agent('w', 'root', { name: 'Implementer', handle: 'implementer-1', startedAt: 9 }), x: agent('x', 'root', { name: 'Designer', handle: 'pixel-1', startedAt: 10 }) })
    const rows = orgTreeRows(s)
    expect(rows.find((r) => r.id === 'w')!.roleShown).toBe(false)
    expect(rows.find((r) => r.id === 'x')!.roleShown).toBeUndefined()
    expect(rows.find((r) => r.id === 'root')!.roleShown).toBe(false)
  })

  it('worktree chips: files while open, review / conflict / held states, nothing once merged', () => {
    const wt = (status: string, files: number) => ({ path: '/wt', branch: 'b', status, baseRef: 'x', mergeTarget: 'main', changedFiles: Array.from({ length: files }, (_, i) => `f${i}`) }) as never
    const s = deepTree({
      a: agent('a', 'root', { startedAt: 11, worktree: wt('active', 2) }),
      b: agent('b', 'root', { startedAt: 12, worktree: wt('review', 3) }),
      c: agent('c', 'root', { startedAt: 13, worktree: wt('conflict', 1) }),
      d: agent('d', 'root', { startedAt: 14, worktree: wt('held', 1) }),
      e: agent('e', 'root', { startedAt: 15, worktree: wt('merged', 1) }),
      f: agent('f', 'root', { startedAt: 16, worktree: wt('active', 0) })
    })
    const chip = (id: string): string | undefined => orgTreeRows(s).find((r) => r.id === id)!.worktreeChip
    expect([chip('a'), chip('b'), chip('c'), chip('d'), chip('e'), chip('f')]).toEqual(['2f', 'review', 'conflict', 'held', undefined, undefined])
  })
})

describe('cardsByAgent and selection', () => {
  it('maps open cards to their agent; a card naming an unknown agent goes to the root', () => {
    let s = deepTree()
    s = withCard(s, perm('c1', 'r2'))
    s = withCard(s, perm('c2', 'r2'))
    s = withCard(s, perm('c3', 'ghost'))
    const by = cardsByAgent(s)
    expect(Object.keys(by).sort()).toEqual(['r2', 'root'])
    expect(by.r2).toHaveLength(2)
    expect(by.root).toHaveLength(1)
    const cards = trayCards(s)
    expect(cards.every((c) => typeof c.agentId === 'string' && typeof c.agentLabel === 'string')).toBe(true)
    expect(cards.find((c) => c.agentId === 'r2')!.agentLabel).toBe('mock-lead-report-2')
    expect(by.r2).toEqual(cards.filter((c) => c.agentId === 'r2').map((c) => c.key))
  })

  it('selection survives a fold: a folded agent resolves to the group row that holds it', () => {
    const s = deepTree()
    const folded = orgTreeRows(s, { collapse: true, now: NOW })
    expect(resolveSelectedRow(folded, 'r1')).toBe('group:r1run:lead')
    expect(resolveSelectedRow(folded, 'lead')).toBe('lead')
    expect(resolveSelectedRow(folded, 'nobody')).toBeUndefined()
    expect(resolveSelectedRow(folded, undefined)).toBeUndefined()
    const open = orgTreeRows(s, { collapse: true, expanded: { lead: NOW }, now: NOW })
    expect(resolveSelectedRow(open, 'r1')).toBe('r1')
  })

  it('collapseTarget: Left on a report folds the group its parent opened; a group row and a closed tree do nothing', () => {
    const open = orgTreeRows(deepTree(), { collapse: true, expanded: { lead: NOW }, now: NOW })
    expect(collapseTarget(open, 'r1', { lead: NOW })).toBe('lead')
    expect(collapseTarget(open, 'lead', { lead: NOW })).toBe('lead')
    expect(collapseTarget(open, 'root', { lead: NOW })).toBeUndefined()
    const folded = orgTreeRows(deepTree(), { collapse: true, now: NOW })
    expect(collapseTarget(folded, 'group:r1run:lead', {})).toBeUndefined()
  })

  it('treeCounts: folded agents count in the total, only live ones as working, open cards as waiting', () => {
    const s = withCard(deepTree({ w: agent('w', 'root', { state: 'waiting', startedAt: 9 }) }), perm('c1', 'w'))
    expect(treeCounts(orgTreeRows(s, { collapse: true, now: NOW }))).toEqual({ total: 5, working: 2, waiting: 1 })
  })
})
