import { describe, expect, it } from 'vitest'
import { assistantRunToOpen } from './assistantNav'
import type { WaitRun } from './needsYou'

const run = (id: string, startedAt: number, status: WaitRun['summary']['status']): WaitRun => ({ summary: { id, status, startedAt }, agents: {} })

describe('assistantRunToOpen', () => {
  it('reopens the last viewed run even when its session ended', () => {
    expect(assistantRunToOpen([run('a', 1, 'finished'), run('b', 2, 'error')], 'a')).toBe('a')
    expect(assistantRunToOpen([run('a', 1, 'finished'), run('b', 2, 'idle')], 'a')).toBe('a')
  })
  it('counts a last viewed run that is only in history (not loaded yet)', () => {
    expect(assistantRunToOpen([run('b', 2, 'finished')], 'old', { history: [{ id: 'old' }] })).toBe('old')
    expect(assistantRunToOpen([run('b', 2, 'finished')], 'gone', { history: [{ id: 'old' }] })).toBeUndefined()
  })
  it('with no last viewed run: the newest open run, else the start page (never an arbitrary ended run)', () => {
    const runs = [run('a', 1, 'running'), run('b', 2, 'idle')]
    expect(assistantRunToOpen(runs, 'a')).toBe('a')
    expect(assistantRunToOpen(runs)).toBe('b')
    expect(assistantRunToOpen([run('a', 1, 'finished'), run('b', 2, 'error')])).toBeUndefined()
  })
  it('stays on the start page the user left it on, unless a run needs the user', () => {
    expect(assistantRunToOpen([run('a', 1, 'idle')], 'a', { startPage: true })).toBeUndefined()
    const waiting: WaitRun = { ...run('w', 1, 'running'), questions: [{ id: 'q', agentId: 'x', question: '?' }] }
    expect(assistantRunToOpen([waiting], 'a', { startPage: true })).toBe('w')
  })
  it('opens the run that needs the user first', () => {
    const waiting: WaitRun = { ...run('w', 1, 'running'), questions: [{ id: 'q', agentId: 'x', question: '?' }] }
    expect(assistantRunToOpen([waiting, run('b', 2, 'idle')], 'b')).toBe('w')
  })
})
