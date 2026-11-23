import { describe, expect, it } from 'vitest'
import { AGENT_BRIEF_MAX_CHARS } from '@shared/types'
import { agentBriefOf, spawnCapCounts, spawnCapRefusal, type SpawnCapAgent } from './spawnCaps'

const roles = [
  { id: 'r-eng', slug: 'engineer', name: 'Engineer', maxConcurrent: 2 },
  { id: 'r-help', slug: 'helper', name: 'Helper' }
]
const ag = (id: string, roleId: string, state: SpawnCapAgent['state'] = 'thinking'): SpawnCapAgent => ({ id, roleId, state })
const root = ag('root', 'r-lead')

describe('spawnCapRefusal', () => {
  it('no caps: never refuses', () => {
    const agents = Array.from({ length: 50 }, (_, i) => ag(`a${i}`, 'r-help'))
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-help', agents })).toBeUndefined()
  })

  it('refuses the N+1th live agent of a role and counts only live ones of that role', () => {
    const agents = [root, ag('a1', 'r-eng'), ag('a2', 'r-eng', 'delegating'), ag('a3', 'r-help')]
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents })).toMatch(/Concurrent limit for engineer reached \(2 running at once\)/)
    // Another role has no cap.
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-help', agents })).toBeUndefined()
    // One ended (done or error): a slot is free.
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents: [root, ag('a1', 'r-eng', 'done'), ag('a2', 'r-eng')] })).toBeUndefined()
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents: [root, ag('a1', 'r-eng', 'error'), ag('a2', 'r-eng')] })).toBeUndefined()
  })

  it('refuses beyond the run total, counting ended agents but never the root', () => {
    const agents = [root, ag('a1', 'r-help', 'done'), ag('a2', 'r-help', 'done')]
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 3 }, roles, roleId: 'r-help', agents })).toBeUndefined()
    const text = spawnCapRefusal({ project: { maxAgentsPerRun: 2 }, roles, roleId: 'r-help', agents })
    expect(text).toContain('Agent limit reached (this run may start 2 agents in total and 2 have started)')
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 1 }, roles, roleId: 'r-help', agents: [root] })).toBeUndefined()
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 1 }, roles, roleId: 'r-help', agents: [root, ag('a1', 'r-help')] })).toContain('1 agent in total and 1 has started')
  })

  it('the total is checked before the role cap', () => {
    const agents = [ag('a1', 'r-eng'), ag('a2', 'r-eng')]
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 2 }, roles, roleId: 'r-eng', agents })).toContain('Agent limit reached')
  })

  it('pending spawns (approved, no agent yet) count for both caps; one without a role only for the total', () => {
    const agents = [ag('a1', 'r-eng')]
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents, pending: ['r-eng'] })).toContain('Concurrent limit for engineer')
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents, pending: ['r-help', undefined] })).toBeUndefined()
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 3 }, roles, roleId: 'r-help', agents, pending: ['r-help', undefined] })).toContain('Agent limit reached')
  })

  it('an unknown role has no per-role cap; stray values never refuse everything', () => {
    const agents = [ag('a1', 'r-x'), ag('a2', 'r-x')]
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-x', agents })).toBeUndefined()
    for (const bad of [0, -1, 1.5, NaN, '3' as unknown as number]) {
      expect(spawnCapRefusal({ project: { maxAgentsPerRun: bad }, roles: [{ id: 'r-x', slug: 'x', name: 'X', maxConcurrent: bad }], roleId: 'r-x', agents })).toBeUndefined()
    }
  })

  it('counts as given (no state kept): the same input gives the same answer', () => {
    const agents = [ag('a1', 'r-eng')]
    const a = spawnCapRefusal({ project: { maxAgentsPerRun: 1 }, roles, roleId: 'r-eng', agents })
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 1 }, roles, roleId: 'r-eng', agents })).toBe(a)
    expect(spawnCapCounts({ roleId: 'r-eng', agents, pending: ['r-eng'] })).toEqual({ started: 2, liveOfRole: 2 })
  })
})

describe('spawnCapRefusal with extraAgents (the run\'s agents outside the session)', () => {
  it('counts extra agents toward the total and the role cap, ended ones toward the total only', () => {
    const extra = [ag('ag_b', 'r-oa'), ag('ag_b:e1', 'r-eng'), ag('ag_b:e2', 'r-eng', 'done')]
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 3 }, roles, roleId: 'r-help', agents: [root], extraAgents: extra })).toMatch(/Agent limit reached \(this run may start 3 agents in total and 3 have started\)/)
    expect(spawnCapRefusal({ project: { maxAgentsPerRun: 4 }, roles, roleId: 'r-help', agents: [root], extraAgents: extra })).toBeUndefined()
    // One live engineer outside plus one inside: the role cap of 2 holds across both.
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents: [ag('n1', 'r-eng')], extraAgents: extra })).toMatch(/Concurrent limit for engineer reached \(2 running at once\)/)
    expect(spawnCapRefusal({ project: {}, roles, roleId: 'r-eng', agents: [], extraAgents: extra })).toBeUndefined()
  })

  it('an extra agent with the same id as an own agent is the same agent: counted once, the own record wins', () => {
    expect(spawnCapCounts({ roleId: 'r-eng', agents: [ag('x', 'r-eng', 'done')], extraAgents: [ag('x', 'r-eng', 'thinking'), ag('y', 'r-eng')] })).toEqual({ started: 2, liveOfRole: 1 })
  })

  it('skips the root in the extra list, and adds pending spawns on top', () => {
    expect(spawnCapCounts({ roleId: 'r-eng', agents: [], extraAgents: [root, ag('y', 'r-eng')], pending: ['r-help'] })).toEqual({ started: 2, liveOfRole: 1 })
  })

  it('without extraAgents nothing changes', () => {
    expect(spawnCapCounts({ roleId: 'r-eng', agents: [ag('a', 'r-eng')] })).toEqual({ started: 1, liveOfRole: 1 })
  })
})

describe('agentBriefOf', () => {
  it('trims, cuts to AGENT_BRIEF_MAX_CHARS and drops empty or non-text input', () => {
    expect(agentBriefOf('  Do the thing  ')).toBe('Do the thing')
    expect(agentBriefOf('a'.repeat(AGENT_BRIEF_MAX_CHARS))).toHaveLength(AGENT_BRIEF_MAX_CHARS)
    expect(agentBriefOf('a'.repeat(AGENT_BRIEF_MAX_CHARS + 1))).toHaveLength(AGENT_BRIEF_MAX_CHARS)
    for (const v of ['', '   ', undefined, null, 42, {}]) expect(agentBriefOf(v)).toBeUndefined()
  })
})
