import { describe, expect, it } from 'vitest'
import type { ConnectionId } from '@shared/types'
import { WEEK_MS } from '../../lib/dashboard'
import { NEUTRAL_ROLE_COLOR } from '../../lib/dashboardBand'
import {
  branchesWaiting,
  continueLabel,
  newestSummary,
  tileChips,
  tileRunCaption,
  captionText,
  tileStatusLine,
  statusParts,
  tileTeam,
  openLabel,
  worktreeTargets,
  connectionProblems,
  costInWindow,
  filterProjects,
  idAfterRemoval,
  mergeSummaries,
  plural,
  topProjectCosts,
  usageIsStale,
  windowLabel,
  type CostSummary
} from './dashboardProjects'

const NOW = 10 * WEEK_MS

function run(id: string, projectId: string, ageMs: number, cost: number | null, partial = false): CostSummary {
  return {
    id,
    projectId,
    startedAt: NOW - ageMs,
    totalCostUsd: cost ?? 0,
    usage: { costUsd: cost, costSource: cost === null ? 'unknown' : 'provider', ...(partial ? { costPartial: true } : {}) }
  } as CostSummary
}

describe('plural', () => {
  it('picks the form', () => {
    expect(plural(1, 'run', 'runs')).toBe('1 run')
    expect(plural(0, 'run', 'runs')).toBe('0 runs')
    expect(plural(3, 'run', 'runs')).toBe('3 runs')
  })
})

describe('mergeSummaries', () => {
  it('keeps each id once and prefers the live copy', () => {
    const merged = mergeSummaries([{ id: 'a', v: 'live' }], [[{ id: 'a', v: 'old' }, { id: 'b', v: 'old' }], [{ id: 'b', v: 'older' }]])
    expect(merged).toEqual([{ id: 'a', v: 'live' }, { id: 'b', v: 'old' }])
  })
})

describe('costInWindow', () => {
  it('counts only runs of the last 7 days', () => {
    const r = costInWindow([run('1', 'p', 1000, 0.5), run('2', 'p', WEEK_MS + 1000, 9)], NOW)
    expect(r.runs).toBe(1)
    expect(r.cost.costUsd).toBe(0.5)
  })
  it('never turns an unknown cost into zero', () => {
    const r = costInWindow([run('1', 'p', 1000, null)], NOW)
    expect(r.cost.costUsd).toBeNull()
  })
  it('marks a sum with an unknown part as a lower bound', () => {
    const r = costInWindow([run('1', 'p', 1000, 0.5), run('2', 'p', 2000, null)], NOW)
    expect(r.cost.costPartial).toBe(true)
  })
  it('has no runs for an empty window', () => {
    expect(costInWindow([], NOW).runs).toBe(0)
  })
})

describe('topProjectCosts', () => {
  const name = (id: string): string => id.toUpperCase()
  it('ranks by known cost, keeps three and leaves out nothing-spent projects', () => {
    const rows = topProjectCosts(
      [run('1', 'a', 10, 1), run('2', 'b', 10, 5), run('3', 'c', 10, 3), run('4', 'd', 10, 2), { ...run('5', 'e', 10, 0), usage: undefined }],
      NOW,
      name
    )
    expect(rows.map((r) => r.projectId)).toEqual(['b', 'c', 'd'])
  })
  it('puts unknown costs after known ones', () => {
    const rows = topProjectCosts([run('1', 'a', 10, null), run('2', 'b', 10, 0.01)], NOW, name)
    expect(rows.map((r) => r.projectId)).toEqual(['b', 'a'])
  })
  it('ignores runs older than a week', () => {
    expect(topProjectCosts([run('1', 'a', WEEK_MS + 5, 4)], NOW, name)).toEqual([])
  })
})

describe('filterProjects', () => {
  const list = [
    { name: 'Notes API', path: 'C:\\code\\notes-api' },
    { name: 'Site', path: '/home/me/web' }
  ]
  it('matches the name or the folder name', () => {
    expect(filterProjects(list, 'notes')).toHaveLength(1)
    expect(filterProjects(list, 'WEB')[0].name).toBe('Site')
    expect(filterProjects(list, '  ')).toHaveLength(2)
    expect(filterProjects(list, 'zzz')).toHaveLength(0)
  })
  it('does not match the parent folders', () => {
    expect(filterProjects(list, 'code')).toHaveLength(0)
  })
})

describe('idAfterRemoval', () => {
  it('prefers the next, then the previous, then nothing', () => {
    expect(idAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(idAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(idAfterRemoval(['a'], 'a')).toBeNull()
    expect(idAfterRemoval(['a'], 'x')).toBeNull()
  })
})

describe('usageIsStale', () => {
  it('is stale with no report or an old newest one', () => {
    expect(usageIsStale([], NOW)).toBe(true)
    expect(usageIsStale([{ updatedAt: NOW - 61_000 }, { updatedAt: NOW - 300_000 }], NOW)).toBe(true)
  })
  it('is fresh when any report is recent', () => {
    expect(usageIsStale([{ updatedAt: NOW - 5_000 }, { updatedAt: NOW - 300_000 }], NOW)).toBe(false)
  })
})

describe('windowLabel', () => {
  it('words the windows', () => {
    expect(windowLabel('Five-hour')).toBe('5-hour window')
    expect(windowLabel('Seven-day')).toBe('7-day window')
    expect(windowLabel('Opus weekly')).toBe('Opus weekly window')
  })
})

describe('connectionProblems', () => {
  const info = (id: ConnectionId, state: 'connected' | 'disconnected' | 'error' | 'connecting') => ({ connection: { id }, status: { state } }) as never
  const proj = (connection: ConnectionId) => ({ provider: { id: 'x', connection } }) as never
  it('names a disconnected connection in use and counts its projects', () => {
    const out = connectionProblems([info('anthropic', 'connected'), info('openai', 'disconnected')], new Set<ConnectionId>(['anthropic', 'openai']), [proj('openai'), proj('openai'), proj('anthropic')])
    expect(out).toEqual([{ id: 'openai', text: 'OpenAI is not connected. 2 projects use it.' }])
  })
  it('says "1 project uses it" and skips connections not in use or fine', () => {
    const out = connectionProblems([info('openai', 'error'), info('litellm', 'disconnected')], new Set<ConnectionId>(['openai']), [proj('openai')])
    expect(out).toEqual([{ id: 'openai', text: 'OpenAI has a problem. 1 project uses it.' }])
  })
  it('is empty while the list is loading', () => {
    expect(connectionProblems(null, new Set<ConnectionId>(['anthropic']), [])).toEqual([])
  })
})

describe('tile signals', () => {
  it('counts branches with commits ahead or uncommitted files only', () => {
    expect(branchesWaiting([{ commitsAhead: 0, uncommittedFiles: 0 }, { commitsAhead: 1, uncommittedFiles: 0 }, { commitsAhead: 0, uncommittedFiles: 2 }])).toBe(2)
    expect(branchesWaiting(null)).toBe(0)
  })
  it('lists worktree targets: code projects only', () => {
    expect(worktreeTargets([{ id: 'a', kind: 'code' }, { id: 'b', kind: 'engagement' }, { id: 'c' }])).toEqual(['a', 'c'])
  })
  it('renders only non-zero chips, branches for code projects only', () => {
    expect(tileChips({ projectName: 'P', code: true, branches: 0, suggestions: 0, untrusted: false })).toEqual([])
    const all = tileChips({ projectName: 'Billing API', code: true, branches: 3, suggestions: 1, untrusted: true })
    expect(all.map((c) => c.kind)).toEqual(['branches', 'suggestions', 'folder-trust'])
    expect(all[0]).toEqual({ kind: 'branches', text: '3 branches waiting', name: '3 branches waiting in Billing API' })
    expect(all[1].text).toBe('1 team suggestion')
    expect(all[2].text).toBe('Folder settings to review')
    expect(tileChips({ projectName: 'E', code: false, branches: 4, suggestions: 0, untrusted: false })).toEqual([])
    expect(tileChips({ projectName: 'P', code: true, branches: 1, suggestions: 0, untrusted: false })[0].text).toBe('1 branch waiting')
  })
  it('picks the newest run, the first copy winning a tie in id order', () => {
    expect(newestSummary([])).toBeUndefined()
    expect(newestSummary([{ id: 'a', startedAt: 1 }, { id: 'b', startedAt: 3 }, { id: 'c', startedAt: 2 }])?.id).toBe('b')
  })
  it('cuts the Continue label at 32 characters', () => {
    expect(continueLabel('Short')).toBe('Continue Short')
    expect(continueLabel('x'.repeat(40))).toBe(`Continue ${'x'.repeat(31)}…`)
  })
  it('words the newest run caption', () => {
    expect(tileRunCaption({ live: true, statusWord: 'Running', step: 'Write the tests' })).toEqual({ text: 'Running · Write the tests' })
    expect(tileRunCaption({ live: true, statusWord: 'Running' })).toEqual({ text: 'Running' })
    expect(tileRunCaption({ live: true, statusWord: 'Needs you', decisionLine: 'Allow: Run npm test', step: 'x' })).toEqual({ lead: 'Needs you', text: 'Allow: Run npm test' })
    expect(captionText({ lead: 'Needs you', text: 'Allow: Run npm test' })).toBe('Needs you · Allow: Run npm test')
  })
  it('says an ended run once: the age in the status line, the outcome in the caption', () => {
    expect(tileRunCaption({ live: false, statusWord: 'Ended when OrgAI closed', decisionLine: 'Allow: x', step: 'y' })).toEqual({ text: 'Ended when OrgAI closed' })
    const now = 10 * 86_400_000
    const line = tileStatusLine({ subtitle: 'Last run 9 d ago · Ended when OrgAI closed', open: 0, decisions: 0, newestStartedAt: now - 9 * 86_400_000, now })
    expect(line).toBe('Last run 9 d ago')
    expect(tileStatusLine({ subtitle: '1 decision · 1 run', open: 1, decisions: 1, newestStartedAt: 0, now })).toBe('1 decision · 1 run')
    expect(tileStatusLine({ subtitle: '', open: 0, decisions: 0, now })).toBe('No runs yet')
  })
  it('splits the decision part of the status line', () => {
    expect(statusParts('2 decisions · 1 run', 2)).toEqual({ decision: '2 decisions', rest: ' · 1 run' })
    expect(statusParts('1 open', 0)).toEqual({ rest: '1 open' })
  })
  it('orders the team row breadth first, root first, capped at 8', () => {
    const r = (id: string, reportsTo: string | null, color = '#fff') => ({ id, name: id.toUpperCase(), color, reportsTo })
    const roles = [r('c1', 'a'), r('b1', 'a'), r('a', null), r('c2', 'b1'), r('d', 'c1')]
    const t = tileTeam(roles)
    expect(t.marks.map((m) => m.id)).toEqual(['a', 'c1', 'b1', 'd', 'c2'])
    expect(t.more).toBe(0)
    expect(t.total).toBe(5)
    const many = [r('root', null), ...Array.from({ length: 10 }, (_, i) => r(`k${i}`, 'root'))]
    const big = tileTeam(many)
    expect(big.marks).toHaveLength(8)
    expect(big.marks[0].id).toBe('root')
    expect(big.more).toBe(3)
    expect(tileTeam([]).marks).toEqual([])
    expect(tileTeam(undefined).total).toBe(0)
    expect(tileTeam([r('solo', null, '')]).marks[0].color).toBe(NEUTRAL_ROLE_COLOR)
    // A dangling or cyclic reportsTo still shows every role once.
    expect(tileTeam([r('a', null), r('x', 'y'), r('y', 'x')]).marks.map((m) => m.id)).toEqual(['a', 'x', 'y'])
  })
  it('names the team in the Open button', () => {
    const team = { total: 9, names: ['Orchestrator', 'Implementer', 'Reviewer', 'Tester'] }
    expect(openLabel({ name: 'Billing API', statusLine: '1 decision · 1 run', team, newestName: 'Fix login' })).toBe('Open Billing API, 1 decision · 1 run, team of 9: Orchestrator, Implementer, Reviewer and 6 more, Fix login')
    expect(openLabel({ name: 'P', statusLine: 'No runs yet', team: { total: 0, names: [] }, setupPending: true })).toBe('Open P, No runs yet, setup pending')
    expect(openLabel({ name: 'P', statusLine: 's', team: { total: 1, names: ['Boss'] } })).toBe('Open P, s, team of 1: Boss')
  })
})
