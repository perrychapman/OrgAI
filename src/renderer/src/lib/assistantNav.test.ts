import { describe, expect, it } from 'vitest'
import { assistantRunToOpen } from './assistantNav'
import type { WaitRun } from './needsYou'

const run = (id: string, startedAt: number, status: WaitRun['summary']['status']): WaitRun => ({ summary: { id, status, startedAt }, agents: {} })

describe('assistantRunToOpen', () => {
  it('never opens an ended run', () => {
    expect(assistantRunToOpen([run('a', 1, 'finished'), run('b', 2, 'error')], 'a')).toBeUndefined()
  })
  it('prefers the last viewed open run, else the newest open one', () => {
    const runs = [run('a', 1, 'running'), run('b', 2, 'idle')]
    expect(assistantRunToOpen(runs, 'a')).toBe('a')
    expect(assistantRunToOpen(runs)).toBe('b')
  })
  it('opens the run that needs the user first', () => {
    const waiting: WaitRun = { ...run('w', 1, 'running'), questions: [{ id: 'q', agentId: 'x', question: '?' }] }
    expect(assistantRunToOpen([waiting, run('b', 2, 'idle')], 'b')).toBe('w')
  })
})
