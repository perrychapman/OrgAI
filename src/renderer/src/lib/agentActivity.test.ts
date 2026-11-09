import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { isWorkingAgent, nodeActivity, worktreeLabel } from './agentActivity'

const agent = (over: Partial<AgentInstance>): AgentInstance =>
  ({ id: 'a1', name: 'Worker', roleSlug: 'worker', parentId: 'root', state: 'thinking', activity: 'Reading files', startedAt: 0, ...over }) as AgentInstance

describe('nodeActivity', () => {
  it('returns the agent activity by default', () => {
    expect(nodeActivity(agent({}), { isRoot: false })).toBe('Reading files')
  })
  it('words an idle root waiting as waiting for a reply', () => {
    expect(nodeActivity(agent({ id: 'root', parentId: null, state: 'idle', activity: 'Waiting for you' }), { isRoot: true })).toBe('Waiting for your reply')
  })
  it('keeps "Waiting for you" on a non-root agent', () => {
    expect(nodeActivity(agent({ state: 'idle', activity: 'Waiting for you' }), { isRoot: false })).toBe('Waiting for you')
  })
  it('flags a finished report without result text', () => {
    expect(nodeActivity(agent({ state: 'done', activity: 'Reported back', result: '' }), { isRoot: false })).toBe('Ended without a result')
    expect(nodeActivity(agent({ state: 'done', activity: 'Reported back', result: 'ok' }), { isRoot: false })).toBe('Reported back')
  })
  it('never flags the root', () => {
    expect(nodeActivity(agent({ id: 'root', parentId: null, state: 'done', activity: 'Finished', result: '' }), { isRoot: true })).toBe('Finished')
  })
})

describe('worktreeLabel and isWorkingAgent', () => {
  it('names merges into the parent', () => {
    expect(worktreeLabel({ status: 'merged', mergeTarget: 'parent' })).toBe('merged into parent')
    expect(worktreeLabel({ status: 'conflict' })).toBe('merge conflict')
    expect(worktreeLabel({ status: 'held', heldBy: 'delegation' })).toBe('Held: delegation')
    expect(worktreeLabel({ status: 'held' })).toBe('held for later')
  })
  it('counts starting, thinking, tool and delegating as working', () => {
    expect(['starting', 'thinking', 'tool', 'delegating'].every((s) => isWorkingAgent(s as AgentInstance['state']))).toBe(true)
    expect(isWorkingAgent('idle')).toBe(false)
    expect(isWorkingAgent('waiting')).toBe(false)
  })
})
