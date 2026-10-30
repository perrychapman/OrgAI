import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { breakParentCycles, resolveParent, wouldCycle } from './agentTree'

function agent(id: string, parentId: string | null, startedAt = 0): AgentInstance {
  return {
    id,
    roleId: null,
    roleSlug: id,
    name: id,
    parentId,
    spawnToolUseId: null,
    state: 'done',
    activity: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt
  }
}

function tree(...list: AgentInstance[]): Record<string, AgentInstance> {
  return Object.fromEntries(list.map((a) => [a.id, a]))
}

/** Every chain ends at null or a missing agent, without revisiting a node. */
function acyclic(agents: Record<string, AgentInstance>): boolean {
  return Object.keys(agents).every((id) => {
    const seen = new Set<string>()
    let cur: string | null = id
    while (cur !== null && agents[cur]) {
      if (seen.has(cur)) return false
      seen.add(cur)
      cur = agents[cur].parentId
    }
    return true
  })
}

describe('wouldCycle', () => {
  const agents = tree(agent('root', null), agent('a', 'root'), agent('b', 'a'), agent('c', 'b'))

  it('detects self-parenting and descendants', () => {
    expect(wouldCycle(agents, 'a', 'a')).toBe(true)
    expect(wouldCycle(agents, 'a', 'c')).toBe(true)
    expect(wouldCycle(agents, 'a', 'b')).toBe(true)
  })

  it('allows ancestors, siblings and unknown parents', () => {
    expect(wouldCycle(agents, 'c', 'root')).toBe(false)
    expect(wouldCycle(agents, 'c', 'a')).toBe(false)
    expect(wouldCycle(agents, 'x', 'c')).toBe(false)
    expect(wouldCycle(agents, 'c', 'unknown')).toBe(false)
  })

  it('terminates on already-cyclic input and accepts a Map', () => {
    const loop = new Map([
      ['p', agent('p', 'q')],
      ['q', agent('q', 'p')]
    ])
    expect(wouldCycle(loop, 'z', 'p')).toBe(false)
    expect(wouldCycle(loop, 'p', 'q')).toBe(true)
  })
})

describe('resolveParent', () => {
  const agents = tree(agent('root', null), agent('lead', 'root'), agent('child', 'lead'))

  it('keeps the parent of a known agent (a task_started for it is a resume)', () => {
    expect(resolveParent(agents, 'lead', 'child', 'root')).toBe('root')
    expect(resolveParent(agents, 'child', 'root', 'root')).toBe('lead')
  })

  it('gives the root no parent', () => {
    expect(resolveParent(agents, 'root', 'lead', 'root')).toBeNull()
  })

  it('takes the candidate for a new agent, including one not seen yet', () => {
    expect(resolveParent(agents, 'new', 'child', 'root')).toBe('child')
    expect(resolveParent(agents, 'new', 'not-yet-seen', 'root')).toBe('not-yet-seen')
  })

  it('falls back to the root for a missing, self or cyclic candidate', () => {
    expect(resolveParent(agents, 'new', undefined, 'root')).toBe('root')
    expect(resolveParent(agents, 'new', 'new', 'root')).toBe('root')
    const orphan = tree(agent('root', null), agent('o', null), agent('k', 'o'))
    expect(resolveParent(orphan, 'o', 'k', 'root')).toBe('root')
    expect(resolveParent(orphan, 'o', 'root', 'root')).toBe('root')
  })
})

describe('breakParentCycles', () => {
  it('returns the same object when there is no cycle', () => {
    const chain = [agent('root', null)]
    for (let i = 1; i <= 50; i++) chain.push(agent(`n${i}`, i === 1 ? 'root' : `n${i - 1}`, i))
    const agents = tree(...chain)
    expect(breakParentCycles(agents, 'root')).toBe(agents)
  })

  it('leaves a dangling parent alone', () => {
    const agents = tree(agent('root', null), agent('a', 'gone'))
    expect(breakParentCycles(agents, 'root')).toBe(agents)
  })

  it('breaks a self-parent without mutating the input', () => {
    const agents = tree(agent('root', null), agent('a', 'a'))
    const out = breakParentCycles(agents, 'root')
    expect(out.a.parentId).toBe('root')
    expect(agents.a.parentId).toBe('a')
  })

  it('breaks a 2-cycle and a 3-cycle at the earliest-started member', () => {
    const two = breakParentCycles(tree(agent('root', null), agent('a', 'b', 2), agent('b', 'a', 1)), 'root')
    expect(two.b.parentId).toBe('root')
    expect(two.a.parentId).toBe('b')
    const three = breakParentCycles(
      tree(agent('root', null), agent('x', 'z', 5), agent('y', 'x', 3), agent('z', 'y', 4)),
      'root'
    )
    expect(three.y.parentId).toBe('root')
    expect(three.z.parentId).toBe('y')
    expect(three.x.parentId).toBe('z')
    expect(acyclic(three)).toBe(true)
  })

  it('uses null when there is no root', () => {
    const out = breakParentCycles(tree(agent('a', 'b', 1), agent('b', 'a', 2)), 'root')
    expect(out.a.parentId).toBeNull()
    expect(out.b.parentId).toBe('a')
  })

  it('repairs the persisted run shape and is idempotent', () => {
    // run_mvu37llxrwm72owl: the Simulation Lead (22:02) was re-parented under the report it spawned at 23:27.
    const agents = tree(
      agent('root', null, 0),
      agent('a5b1989edd8ccc8a6', 'a2b81960cb9cf066f', 2202),
      agent('a2b81960cb9cf066f', 'a5b1989edd8ccc8a6', 2327),
      agent('a7e2', 'a5b1989edd8ccc8a6', 2300)
    )
    const out = breakParentCycles(agents, 'root')
    expect(out).not.toBe(agents)
    expect(out.a5b1989edd8ccc8a6.parentId).toBe('root')
    expect(out.a2b81960cb9cf066f.parentId).toBe('a5b1989edd8ccc8a6')
    expect(out.a7e2.parentId).toBe('a5b1989edd8ccc8a6')
    expect(acyclic(out)).toBe(true)
    expect(agents.a5b1989edd8ccc8a6.parentId).toBe('a2b81960cb9cf066f')
    expect(breakParentCycles(out, 'root')).toBe(out)
  })
})
