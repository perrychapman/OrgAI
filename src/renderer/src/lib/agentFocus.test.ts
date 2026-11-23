import { describe, expect, it } from 'vitest'
import type { AgentInstance, TranscriptEntry } from '@shared/types'
import { agentInitials, agentSiblings, entriesOfAgent, extractBrief, focusState, positionLabel, whereItSits } from './agentFocus'

const mk = (id: string, parentId: string | null, over: Partial<AgentInstance> = {}): AgentInstance =>
  ({ id, roleId: null, roleSlug: id, name: id, parentId, spawnToolUseId: null, state: 'idle', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over }) as AgentInstance

const byId = (list: AgentInstance[]): Record<string, AgentInstance> => Object.fromEntries(list.map((a) => [a.id, a]))

const team = byId([
  mk('root', null, { name: 'Orchestrator' }),
  mk('lead', 'root', { name: 'Build' }),
  mk('i1', 'lead', { name: 'Implementer 1' }),
  mk('i2', 'lead', { name: 'Implementer 2' }),
  mk('i3', 'i2', { name: 'Helper' }),
  mk('qa', 'root', { name: 'QA' })
])

describe('agentSiblings', () => {
  it('lists the group of the lead and everyone below it', () => {
    const s = agentSiblings(team, 'i2')
    expect(s.group).toBe('Build')
    expect(s.ids).toEqual(['lead', 'i1', 'i2', 'i3'])
    expect(s.position).toBe(3)
    expect(s.total).toBe(4)
    expect(s.prevId).toBe('i1')
    expect(s.nextId).toBe('i3')
    expect(positionLabel(s)).toBe('3 of 4 in Build')
  })
  it('stops at the ends', () => {
    expect(agentSiblings(team, 'lead').prevId).toBeUndefined()
    expect(agentSiblings(team, 'i3').nextId).toBeUndefined()
  })
  it('puts a lone lead in its own group and the root in none', () => {
    expect(agentSiblings(team, 'qa')).toMatchObject({ group: 'QA', position: 1, total: 1 })
    const r = agentSiblings(team, 'root')
    expect(r.group).toBeUndefined()
    expect(positionLabel(r)).toBe('')
  })
})

describe('whereItSits', () => {
  it('runs root to the agent and marks the agent', () => {
    const c = whereItSits(team, 'i3')
    expect(c.map((l) => l.id)).toEqual(['root', 'lead', 'i2', 'i3'])
    expect(c.map((l) => l.self)).toEqual([false, false, false, true])
  })
  it('is just the root for the root, and skips a missing parent', () => {
    expect(whereItSits(team, 'root').map((l) => l.id)).toEqual(['root'])
    expect(whereItSits({ x: mk('x', 'gone') }, 'x').map((l) => l.id)).toEqual(['x'])
    expect(whereItSits(team, 'nope')).toEqual([])
  })
})

const use = (id: string, input: unknown, agentId = 'lead'): TranscriptEntry => ({ id: `e-${id}`, agentId, at: 5, block: { kind: 'tool_use', id, name: 'Agent', input } })

describe('extractBrief', () => {
  it('reads the prompt of the call that spawned the agent', () => {
    const b = extractBrief([use('t0', { prompt: 'other' }), use('t1', { description: 'short', prompt: '  Write the tests.  ' })], { spawnToolUseId: 't1' })
    expect(b).toEqual({ text: 'Write the tests.', fromId: 'lead', at: 5 })
  })
  it('falls back to other text fields and plain strings', () => {
    expect(extractBrief([use('t1', { description: 'Do it' })], { spawnToolUseId: 't1' })?.text).toBe('Do it')
    expect(extractBrief([use('t1', 'raw')], { spawnToolUseId: 't1' })?.text).toBe('raw')
  })
  it('is undefined without a spawn call, a match or text', () => {
    expect(extractBrief([use('t1', { prompt: 'x' })], { spawnToolUseId: null })).toBeUndefined()
    expect(extractBrief([use('t1', { prompt: 'x' })], { spawnToolUseId: 'zz' })).toBeUndefined()
    expect(extractBrief([use('t1', { prompt: '  ' })], { spawnToolUseId: 't1' })).toBeUndefined()
    expect(extractBrief([use('t1', 7)], { spawnToolUseId: 't1' })).toBeUndefined()
  })
})

describe('focusState and small helpers', () => {
  it('lets waiting win over working', () => {
    expect(focusState({ id: 'a', state: 'tool' }, new Set(['a']))).toBe('waiting')
    expect(focusState({ id: 'a', state: 'tool' }, new Set())).toBe('working')
    expect(focusState({ id: 'a', state: 'error' }, new Set())).toBe('failed')
    expect(focusState({ id: 'a', state: 'done' }, new Set())).toBe('done')
    expect(focusState({ id: 'a', state: 'idle' }, new Set())).toBe('idle')
  })
  it('makes initials', () => {
    expect(agentInitials('Implementer 2')).toBe('I2')
    expect(agentInitials('Lead implementer')).toBe('LI')
    expect(agentInitials('qa')).toBe('Q')
    expect(agentInitials('  ')).toBe('?')
  })
  it('keeps one agent entries', () => {
    expect(entriesOfAgent([use('a', {}, 'x'), use('b', {}, 'y')], 'y').map((e) => e.id)).toEqual(['e-b'])
  })
})
