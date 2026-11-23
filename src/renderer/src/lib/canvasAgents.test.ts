import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { agentBucket, agentCounts, agentCountsLabel, groupAgents, groupLabels, groupLeadId, matchesAgentFilter, matchesAgentQuery, sortAgents, waitingAgentIds } from './canvasAgents'

const agent = (id: string, over: Partial<AgentInstance> = {}): AgentInstance =>
  ({ id, name: id, roleSlug: 'worker', parentId: 'root', state: 'idle', activity: '', startedAt: 0, ...over }) as AgentInstance

const root = agent('root', { name: 'Orchestrator', parentId: null, state: 'thinking' })

describe('agentBucket and agentCounts', () => {
  it('puts an agent with an open decision in waiting even while its state reads tool', () => {
    expect(agentBucket(agent('a', { state: 'tool' }), new Set(['a']))).toBe('waiting')
    expect(agentBucket(agent('a', { state: 'waiting' }), new Set())).toBe('waiting')
  })
  it('buckets working, failed, done and idle', () => {
    const none = new Set<string>()
    expect(agentBucket(agent('a', { state: 'delegating' }), none)).toBe('working')
    expect(agentBucket(agent('a', { state: 'error' }), none)).toBe('failed')
    expect(agentBucket(agent('a', { state: 'done' }), none)).toBe('done')
    expect(agentBucket(agent('a', { state: 'idle' }), none)).toBe('other')
  })
  it('counts every agent once', () => {
    const list = [root, agent('w', { state: 'tool' }), agent('p', { state: 'tool' }), agent('d', { state: 'done' }), agent('e', { state: 'error' }), agent('i')]
    expect(agentCounts(list, new Set(['p']))).toEqual({ all: 6, working: 2, waiting: 1, done: 1, failed: 1 })
  })
  it('words the counts for a screen reader', () => {
    expect(agentCountsLabel({ all: 16, working: 7, waiting: 1, done: 0, failed: 0 })).toBe('16 agents: 7 working, 1 waiting for you')
    expect(agentCountsLabel({ all: 1, working: 0, waiting: 0, done: 1, failed: 0 })).toBe('1 agent: 0 working, 0 waiting for you, 1 done')
  })
})

describe('matchesAgentFilter', () => {
  const waiting = new Set(['p'])
  it('all matches everything and each filter matches its bucket', () => {
    expect(matchesAgentFilter(agent('a', { state: 'done' }), 'all', waiting)).toBe(true)
    expect(matchesAgentFilter(agent('a', { state: 'done' }), 'done', waiting)).toBe(true)
    expect(matchesAgentFilter(agent('a', { state: 'done' }), 'working', waiting)).toBe(false)
    expect(matchesAgentFilter(agent('p', { state: 'tool' }), 'waiting', waiting)).toBe(true)
    expect(matchesAgentFilter(agent('p', { state: 'tool' }), 'working', waiting)).toBe(false)
  })
})

describe('matchesAgentQuery', () => {
  const a = agent('x', { name: 'Implementer', handle: 'impl-2', roleSlug: 'implementer', activity: 'Editing Cache.js' })
  it('matches name, handle, role slug and activity without regard to case', () => {
    expect(matchesAgentQuery(a, 'IMPLEMENTER')).toBe(true)
    expect(matchesAgentQuery(a, 'impl-2')).toBe(true)
    expect(matchesAgentQuery(a, 'cache.JS')).toBe(true)
    expect(matchesAgentQuery(a, '  ')).toBe(true)
    expect(matchesAgentQuery(a, 'reviewer')).toBe(false)
  })
  it('matches the extra text the list passes (the group)', () => {
    expect(matchesAgentQuery(a, 'build', ['Build'])).toBe(true)
    expect(matchesAgentQuery(a, 'build')).toBe(false)
  })
})

describe('sortAgents', () => {
  const list = [agent('d', { state: 'done' }), agent('b', { state: 'tool' }), agent('a', { state: 'tool' }), agent('w', { state: 'tool' }), agent('f', { state: 'error' }), agent('i')]
  it('puts waiting first, then working, failed, idle and done last, by name inside a bucket', () => {
    expect(sortAgents(list, new Set(['w'])).map((x) => x.id)).toEqual(['w', 'a', 'b', 'f', 'i', 'd'])
  })
  it('sorts by name with numbers in order', () => {
    const l = [agent('x10', { name: 'Impl 10' }), agent('x2', { name: 'Impl 2' })]
    expect(sortAgents(l, new Set(), 'name').map((x) => x.id)).toEqual(['x2', 'x10'])
  })
  it('sorts by group, then name', () => {
    const l = [agent('a'), agent('b'), agent('c')]
    const g: Record<string, string> = { a: 'Quality', b: 'Build', c: 'Build' }
    expect(sortAgents(l, new Set(), 'group', (x) => g[x.id]).map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })
  it('does not change its input', () => {
    const copy = list.slice()
    sortAgents(list, new Set())
    expect(list).toEqual(copy)
  })
})

describe('grouping', () => {
  const lead1 = agent('l1', { name: 'Lead builder' })
  const lead2 = agent('l2', { name: 'Lead checker', state: 'tool' })
  const list = [
    root,
    lead1,
    lead2,
    agent('b1', { parentId: 'l1', state: 'tool' }),
    agent('b2', { parentId: 'l1', state: 'done' }),
    agent('deep', { parentId: 'b1', state: 'tool' }),
    agent('c1', { parentId: 'l2', state: 'tool' })
  ]
  const byId = Object.fromEntries(list.map((a) => [a.id, a]))
  it('finds the lead below the root for each agent', () => {
    expect(groupLeadId(byId, 'root')).toBeUndefined()
    expect(groupLeadId(byId, 'l1')).toBe('l1')
    expect(groupLeadId(byId, 'b1')).toBe('l1')
    expect(groupLeadId(byId, 'deep')).toBe('l1')
    expect(groupLeadId(byId, 'c1')).toBe('l2')
  })
  it('labels every agent with its group', () => {
    const labels = groupLabels(list)
    expect(labels.get('root')).toBeUndefined()
    expect(labels.get('deep')).toBe('Lead builder')
    expect(labels.get('c1')).toBe('Lead checker')
  })
  it('makes a group per direct report with counts, the group needing you first', () => {
    const { roots, groups } = groupAgents(list, new Set(['c1']))
    expect(roots.map((r) => r.id)).toEqual(['root'])
    expect(groups.map((g) => g.leadId)).toEqual(['l2', 'l1'])
    expect(groups[1].agents.map((a) => a.id)).toEqual(['b1', 'deep', 'l1', 'b2'])
    expect(groups[1].counts).toEqual({ all: 4, working: 2, waiting: 0, done: 1, failed: 0 })
    expect(groups[0].counts.waiting).toBe(1)
  })
  it('survives a parent cycle and a missing parent', () => {
    const odd = [agent('x', { parentId: 'y' }), agent('y', { parentId: 'x' }), agent('z', { parentId: 'gone' })]
    expect(() => groupAgents(odd, new Set())).not.toThrow()
    // Nothing is lost: an agent under an unknown parent leads its own group.
    const { roots, groups } = groupAgents(odd, new Set())
    expect(roots.length + groups.reduce((n, g) => n + g.agents.length, 0)).toBe(3)
  })
  it('scales to a 121-agent run as a handful of groups', () => {
    const many: AgentInstance[] = [root]
    for (let g = 0; g < 6; g++) {
      many.push(agent(`lead${g}`, { name: `Lead ${g}` }))
      for (let i = 0; i < 19; i++) many.push(agent(`a${g}-${i}`, { parentId: `lead${g}`, state: 'tool' }))
    }
    expect(many).toHaveLength(121)
    const { groups } = groupAgents(many, new Set())
    expect(groups).toHaveLength(6)
    expect(groups.every((g) => g.agents.length === 20)).toBe(true)
  })
})

describe('waitingAgentIds', () => {
  it('collects the agent of every open card', () => {
    const ids = waitingAgentIds({ permissions: [{ agentId: 'a' }], questions: [{ agentId: 'b' }], mergeReviews: [{ agentId: 'a' }], mcpInstalls: [], ruleRequests: [{ agentId: 'c' }] })
    expect([...ids].sort()).toEqual(['a', 'b', 'c'])
    expect(waitingAgentIds({}).size).toBe(0)
  })
})
