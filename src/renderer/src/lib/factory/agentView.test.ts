import { describe, expect, it } from 'vitest'
import type { AgentState } from '@shared/types'
import { FACTORY_STATUS_WORD, factoryLamp, factoryRole, factoryWord } from './agentView'

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
