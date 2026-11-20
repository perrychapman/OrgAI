import { describe, expect, it } from 'vitest'
import type { AgentInstance, AgentState } from '@shared/types'
import { FACTORY_STATUS_WORD, factoryAgent, factoryLamp, factoryRole, factoryWord } from './agentView'

function inst(extra: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: 'a1',
    name: 'Implementer',
    roleSlug: 'implementer',
    handle: 'impl-1',
    parentId: 'root',
    state: 'tool',
    activity: 'Running npm test',
    startedAt: 42,
    ...extra
  } as AgentInstance
}

describe('factoryAgent (live)', () => {
  it('maps an agent with the graph node name, word and activity', () => {
    expect(factoryAgent(inst({ usage: { toolCalls: 3 } as AgentInstance['usage'] }), { session: 'current' })).toEqual({
      id: 'a1',
      name: 'impl-1',
      parentId: 'root',
      roleKey: 'implementer',
      handle: 'impl-1',
      state: 'tool',
      statusWord: 'Running',
      activity: 'Running npm test',
      toolCalls: 3,
      startedAt: 42,
      session: 'current'
    })
  })

  it('every state maps to its word', () => {
    for (const state of Object.keys(FACTORY_STATUS_WORD) as AgentState[]) {
      expect(factoryAgent(inst({ state }), { session: 'current' }).statusWord).toBe(FACTORY_STATUS_WORD[state])
    }
  })

  it('no handle: the name; no usage: 0 tool calls; earlier session kept', () => {
    const a = factoryAgent(inst({ handle: undefined, usage: undefined }), { session: 'earlier' })
    expect(a.name).toBe('Implementer')
    expect(a.handle).toBeUndefined()
    expect(a.toolCalls).toBe(0)
    expect(a.session).toBe('earlier')
  })

  it('worktree: status kept, a missing merge target means main', () => {
    const wt = { path: '/x', branch: 'b', status: 'merged' } as unknown as AgentInstance['worktree']
    expect(factoryAgent(inst({ worktree: wt }), { session: 'current' }).worktree).toEqual({ status: 'merged', mergeTarget: 'main' })
    const wp = { path: '/x', branch: 'b', status: 'conflict', mergeTarget: 'parent' } as unknown as AgentInstance['worktree']
    expect(factoryAgent(inst({ worktree: wp }), { session: 'current' }).worktree).toEqual({ status: 'conflict', mergeTarget: 'parent' })
    expect(factoryAgent(inst(), { session: 'current' }).worktree).toBeUndefined()
  })

  it('a root that ended without a result says so (nodeActivity)', () => {
    const a = factoryAgent(inst({ parentId: null, state: 'idle', activity: 'Waiting for you' }), { session: 'current' })
    expect(a.parentId).toBeNull()
    expect(a.activity).toBe('Waiting for your reply')
  })
})

describe('factoryRole', () => {
  it('maps a role to a static floor worker; index stands in for the start time', () => {
    expect(factoryRole({ id: 'r1', name: 'Architect', reportsTo: 'r0' }, 3)).toEqual({
      id: 'r1',
      name: 'Architect',
      parentId: 'r0',
      roleKey: 'r1',
      state: 'role',
      statusWord: 'Role',
      activity: '',
      toolCalls: 0,
      startedAt: 3,
      session: 'current'
    })
    expect(factoryRole({ id: 'root', name: 'Orchestrator', reportsTo: null }, 0).parentId).toBeNull()
  })
})

describe('factoryLamp and factoryWord', () => {
  const table: [AgentState, boolean, string, string][] = [
    ['starting', false, 'running', 'Running'],
    ['thinking', false, 'running', 'Running'],
    ['tool', false, 'running', 'Running'],
    ['delegating', false, 'running', 'Running'],
    ['waiting', false, 'needs-you', 'Needs you'],
    ['thinking', true, 'needs-you', 'Needs you'],
    ['idle', false, 'off', 'Idle'],
    ['idle', true, 'needs-you', 'Needs you'],
    ['done', false, 'off', 'Finished'],
    ['error', false, 'failed', 'Failed'],
    ['error', true, 'failed', 'Failed']
  ]
  for (const [state, open, lamp, word] of table) {
    it(`${state}${open ? ' with an open decision' : ''}: ${lamp}, ${word}`, () => {
      const a = { id: 'a', state, statusWord: FACTORY_STATUS_WORD[state] }
      const l = factoryLamp(a, new Set(open ? ['a'] : []))
      expect(l).toBe(lamp)
      expect(factoryWord(a, l)).toBe(word)
    })
  }
  it('roles have no lamp and keep their word', () => {
    expect(factoryLamp({ id: 'r', state: 'role' }, new Set(['r']))).toBe('off')
    expect(factoryWord({ statusWord: 'Role' }, 'needs-you')).toBe('Role')
  })
})
