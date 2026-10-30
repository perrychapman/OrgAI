import { describe, expect, it } from 'vitest'
import { defaultRunToOpen, waitingItems, type WaitRun } from './needsYou'

const run = (id: string, startedAt: number, status: WaitRun['summary']['status'], extra: Partial<WaitRun> = {}): WaitRun => ({
  summary: { id, status, startedAt },
  agents: { a1: { name: 'Implementer' } },
  ...extra
})

describe('waitingItems', () => {
  it('lists every open decision with the agent name', () => {
    const r = run('r1', 1, 'running', {
      permissions: [{ id: 'p1', agentId: 'a1', toolName: 'Edit' }],
      mergeReviews: [{ id: 'm1', agentName: 'Implementer' }],
      mcpInstalls: [{ id: 'i1', agentId: 'a1' }]
    })
    const items = waitingItems(r)
    expect(items.map((i) => i.kind)).toEqual(['merge', 'permission', 'install'])
    expect(items.find((i) => i.kind === 'permission')?.label).toBe('Implementer wants to use Edit')
  })
  it('is empty for finished runs and for runs with nothing open', () => {
    expect(waitingItems(run('r1', 1, 'finished', { permissions: [{ id: 'p', agentId: 'a1', toolName: 'Edit' }] }))).toEqual([])
    expect(waitingItems(run('r1', 1, 'running'))).toEqual([])
  })
  it('reports a blocked plan when nothing else waits', () => {
    expect(waitingItems(run('r1', 1, 'idle', { plan: { status: 'blocked' } })).map((i) => i.kind)).toEqual(['plan'])
  })
})

describe('defaultRunToOpen', () => {
  const waiting = run('w', 5, 'running', { questions: [{ id: 'q', agentId: 'a1', question: '?' }] })
  it('prefers the run that needs you', () => {
    expect(defaultRunToOpen([run('a', 1, 'running'), waiting], [], 'a')).toBe('w')
  })
  it('then the last viewed run', () => {
    expect(defaultRunToOpen([run('a', 1, 'running'), run('b', 2, 'idle')], [], 'a')).toBe('a')
  })
  it('then the newest open run, then the newest run overall', () => {
    expect(defaultRunToOpen([run('a', 1, 'finished'), run('b', 2, 'idle')], [])).toBe('b')
    expect(
      defaultRunToOpen([], [
        { id: 'old', startedAt: 1 },
        { id: 'new', startedAt: 9 }
      ])
    ).toBe('new')
    expect(defaultRunToOpen([], [])).toBeUndefined()
  })
  it('ignores a last-viewed id that no longer exists', () => {
    expect(defaultRunToOpen([], [{ id: 'h', startedAt: 1 }], 'gone')).toBe('h')
  })
})
