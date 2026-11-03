import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { earlierKey, isEarlierKey } from './chainView'
import { foldFinished, groupParentOf, type FoldResult } from './foldFinished'

const ag = (id: string, parentId: string | null, state = 'done'): AgentInstance => ({ id, parentId, state }) as unknown as AgentInstance
const settled = (a: AgentInstance): boolean => a.state === 'done' || a.state === 'error'
const isEarlier = isEarlierKey
const ids = (list: AgentInstance[] | undefined): string[] => (list ?? []).map((a) => a.id)

/** Invariant: every group hangs under an agent on the canvas, and no agent is both shown and folded. */
function expectAttached(r: FoldResult, rootId: string | undefined): void {
  const shown = new Set(r.visibleAgents.map((a) => a.id))
  for (const key of r.groups.keys()) {
    const parent = groupParentOf(key, rootId, isEarlier)
    expect(parent !== null && shown.has(parent), `group ${key} has no parent on the canvas`).toBe(true)
  }
  for (const members of r.groups.values()) for (const m of members) expect(shown.has(m.id), `${m.id} shown and folded`).toBe(false)
}

// The R54 shape: root, two finished leads with their own finished reports, one finished direct report.
const deep = (): AgentInstance[] => [
  ag('root', null, 'idle'),
  ag('leadA', 'root'),
  ag('a1', 'leadA'),
  ag('a2', 'leadA'),
  ag('leadB', 'root'),
  ag('b1', 'leadB'),
  ag('b1x', 'b1', 'error'),
  ag('solo', 'root')
]

describe('foldFinished', () => {
  it('folds a settled subtree into one group under the nearest visible ancestor', () => {
    const r = foldFinished({ agents: deep(), isSettled: settled, expanded: {}, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root'])
    expect([...r.groups.keys()]).toEqual(['root'])
    const members = r.groups.get('root') ?? []
    expect(members).toHaveLength(7)
    // Direct reports first.
    expect(ids(members.slice(0, 3)).sort()).toEqual(['leadA', 'leadB', 'solo'])
    expectAttached(r, 'root')
  })

  it('expanding the root group shows the leads, each with its own group', () => {
    const r = foldFinished({ agents: deep(), isSettled: settled, expanded: { root: true }, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'leadA', 'leadB', 'solo'])
    expect(ids(r.groups.get('leadA'))).toEqual(['a1', 'a2'])
    expect(ids(r.groups.get('leadB'))).toEqual(['b1', 'b1x'])
    expect(r.groups.has('root')).toBe(false)
    expectAttached(r, 'root')
  })

  it('expanding a lead shows its reports; the grandchild folds under its own parent', () => {
    const r = foldFinished({ agents: deep(), isSettled: settled, expanded: { root: true, leadB: true }, collapse: true })
    expect(ids(r.visibleAgents)).toContain('b1')
    expect(ids(r.groups.get('b1'))).toEqual(['b1x'])
    expect(r.groups.has('leadB')).toBe(false)
    expectAttached(r, 'root')
  })

  it('an expanded key under a folded agent has no effect', () => {
    const r = foldFinished({ agents: deep(), isSettled: settled, expanded: { leadA: true }, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root'])
    expect(r.groups.get('root')).toHaveLength(7)
    expectAttached(r, 'root')
  })

  it('keeps a lead with a live report on the canvas and folds its settled reports under it', () => {
    const agents = [ag('root', null, 'working'), ag('lead', 'root'), ag('l1', 'lead'), ag('l2', 'lead', 'working'), ag('x', 'l1')]
    const r = foldFinished({ agents, isSettled: settled, expanded: {}, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'lead', 'l2'])
    expect(ids(r.groups.get('lead'))).toEqual(['l1', 'x'])
    expectAttached(r, 'root')
  })

  it('never folds the root, and shows everything when collapse is off', () => {
    const r1 = foldFinished({ agents: [ag('root', null)], isSettled: settled, expanded: {}, collapse: true })
    expect(ids(r1.visibleAgents)).toEqual(['root'])
    const r2 = foldFinished({ agents: deep(), isSettled: settled, expanded: {}, collapse: false })
    expect(r2.visibleAgents).toHaveLength(8)
    expect(r2.groups.size).toBe(0)
  })

  it('earlier-session groups hang under the root, or show their agents when expanded', () => {
    const earlier = [{ key: earlierKey('r1'), agents: [ag('r1/a', 'root')] }]
    const r = foldFinished({ agents: deep(), isSettled: settled, expanded: {}, earlier, collapse: true })
    expect(ids(r.groups.get(earlierKey('r1')))).toEqual(['r1/a'])
    expectAttached(r, 'root')
    const open = foldFinished({ agents: deep(), isSettled: settled, expanded: { [earlierKey('r1')]: true }, earlier, collapse: true })
    expect(ids(open.visibleAgents)).toContain('r1/a')
    expect(open.groups.has(earlierKey('r1'))).toBe(false)
    expectAttached(open, 'root')
  })

  it('holds the invariant over every expand combination of a random tree', () => {
    let seed = 7
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let t = 0; t < 40; t++) {
      const agents: AgentInstance[] = [ag('n0', null, rnd() < 0.5 ? 'idle' : 'done')]
      for (let i = 1; i < 14; i++) agents.push(ag(`n${i}`, `n${Math.floor(rnd() * i)}`, rnd() < 0.8 ? 'done' : 'working'))
      const expanded: Record<string, boolean> = {}
      for (const a of agents) if (rnd() < 0.4) expanded[a.id] = true
      const r = foldFinished({ agents, isSettled: settled, expanded, collapse: true })
      expectAttached(r, 'n0')
      const folded = [...r.groups.values()].reduce((n, g) => n + g.length, 0)
      expect(r.visibleAgents.length + folded).toBe(agents.length)
      // A live agent is never folded.
      for (const g of r.groups.values()) for (const m of g) expect(m.state).not.toBe('working')
    }
  })

  it('survives a cycle without dropping agents', () => {
    const agents = [ag('root', null), ag('a', 'b'), ag('b', 'a')]
    const r = foldFinished({ agents, isSettled: settled, expanded: {}, collapse: true })
    const folded = [...r.groups.values()].reduce((n, g) => n + g.length, 0)
    expect(r.visibleAgents.length + folded).toBe(3)
  })
})
