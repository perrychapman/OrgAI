import { describe, expect, it } from 'vitest'
import type { ConnectionId } from '@shared/types'
import { WEEK_MS } from '../../lib/dashboard'
import {
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
