import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { earlierKey, isEarlierKey } from './chainView'
import { COLLAPSE_GRACE_MS, SETTLE_TIMER_FLOOR_MS, foldFinished, groupParentOf, isSettledAt, nextSettleAt, settleTimerDelay, type FoldResult } from './foldFinished'

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

  it('a live leaf at the bottom of a deep chain keeps the whole chain on the canvas; settling it folds the chain', () => {
    const chain = (leaf: string): AgentInstance[] => [ag('root', null, 'idle'), ag('c1', 'root'), ag('c2', 'c1'), ag('c3', 'c2'), ag('leaf', 'c3', leaf)]
    const live = foldFinished({ agents: chain('working'), isSettled: settled, expanded: {}, collapse: true })
    expect(ids(live.visibleAgents)).toEqual(['root', 'c1', 'c2', 'c3', 'leaf'])
    expect(live.groups.size).toBe(0)
    const done = foldFinished({ agents: chain('done'), isSettled: settled, expanded: {}, collapse: true })
    expect(ids(done.visibleAgents)).toEqual(['root'])
    expect(ids(done.groups.get('root'))).toEqual(['c1', 'c2', 'c3', 'leaf'])
    expectAttached(done, 'root')
    // A live side branch stops only its own path from folding.
    const mixed = [...chain('done'), ag('side', 'c1', 'working')]
    const m = foldFinished({ agents: mixed, isSettled: settled, expanded: {}, collapse: true })
    expect(ids(m.visibleAgents)).toEqual(['root', 'c1', 'side'])
    expect(ids(m.groups.get('c1'))).toEqual(['c2', 'c3', 'leaf'])
    expectAttached(m, 'root')
  })

  it('an agent whose parent id is unknown is a root: it is never folded and its reports fold under it', () => {
    const agents = [ag('root', null, 'idle'), ag('orphan', 'ghost'), ag('o1', 'orphan'), ag('kid', 'root')]
    const r = foldFinished({ agents, isSettled: settled, expanded: {}, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'orphan'])
    expect(ids(r.groups.get('orphan'))).toEqual(['o1'])
    expect(ids(r.groups.get('root'))).toEqual(['kid'])
    expectAttached(r, 'root')
  })

  it('earlier-session groups and folded subtrees together keep every agent exactly once', () => {
    const earlier = [
      { key: earlierKey('r1'), agents: [ag('r1/a', 'root'), ag('r1/b', 'r1/a')] },
      { key: earlierKey('r2'), agents: [ag('r2/a', 'root')] }
    ]
    const closed = foldFinished({ agents: deep(), isSettled: settled, expanded: {}, earlier, collapse: true })
    expect([...closed.groups.keys()].sort()).toEqual([earlierKey('r1'), earlierKey('r2'), 'root'].sort())
    expectAttached(closed, 'root')
    // Open one earlier group and one lead's parent: the other earlier group stays folded, the opened one is drawn.
    const open = foldFinished({ agents: deep(), isSettled: settled, expanded: { root: true, [earlierKey('r1')]: true }, earlier, collapse: true })
    expect(ids(open.visibleAgents)).toEqual(['root', 'leadA', 'leadB', 'solo', 'r1/a', 'r1/b'])
    expect(open.groups.has(earlierKey('r1'))).toBe(false)
    expect(ids(open.groups.get(earlierKey('r2')))).toEqual(['r2/a'])
    expect(ids(open.groups.get('leadA'))).toEqual(['a1', 'a2'])
    expectAttached(open, 'root')
    // Collapse off shows the earlier agents too and builds no group.
    const off = foldFinished({ agents: deep(), isSettled: settled, expanded: {}, earlier, collapse: false })
    expect(off.visibleAgents).toHaveLength(8 + 3)
    expect(off.groups.size).toBe(0)
  })

  it('an expanded key survives its agent folding and applies again when the agent returns', () => {
    const expanded = { leadB: true }
    // leadB is folded away (root not expanded): its key does nothing.
    const hidden = foldFinished({ agents: deep(), isSettled: settled, expanded, collapse: true })
    expect(ids(hidden.visibleAgents)).toEqual(['root'])
    // The user opens the root group: leadB comes back already expanded, its reports shown.
    const back = foldFinished({ agents: deep(), isSettled: settled, expanded: { ...expanded, root: true }, collapse: true })
    expect(ids(back.visibleAgents)).toContain('b1')
    expect(back.groups.has('leadB')).toBe(false)
    // A report that goes live again pulls its lead out of the fold, and an old key for a gone agent is ignored.
    const agents = deep().map((a) => (a.id === 'a2' ? ag('a2', 'leadA', 'working') : a))
    const live = foldFinished({ agents, isSettled: settled, expanded: { gone: true }, collapse: true })
    expect(ids(live.visibleAgents)).toEqual(['root', 'leadA', 'a2'])
    expect(ids(live.groups.get('leadA'))).toEqual(['a1'])
    expect(ids(live.groups.get('root'))).toEqual(['leadB', 'solo', 'b1', 'b1x'])
    expectAttached(live, 'root')
  })

  it('survives a cycle without dropping agents', () => {
    const agents = [ag('root', null), ag('a', 'b'), ag('b', 'a')]
    const r = foldFinished({ agents, isSettled: settled, expanded: {}, collapse: true })
    const folded = [...r.groups.values()].reduce((n, g) => n + g.length, 0)
    expect(r.visibleAgents.length + folded).toBe(3)
  })
})

const ended = (id: string, parentId: string | null, endedAt: number | undefined, extra: Partial<AgentInstance> = {}): AgentInstance =>
  ({ id, parentId, state: 'done', endedAt, ...extra }) as unknown as AgentInstance

describe('isSettledAt', () => {
  it('settles a finished agent once the grace period has passed', () => {
    const a = ended('a', 'root', 1000)
    expect(isSettledAt(a, 1000 + COLLAPSE_GRACE_MS - 1)).toBe(false)
    expect(isSettledAt(a, 1000 + COLLAPSE_GRACE_MS)).toBe(true)
  })
  it('never settles a working agent or one whose worktree is still integrating', () => {
    expect(isSettledAt(ended('a', 'root', 0, { state: 'thinking' } as Partial<AgentInstance>), 1e9)).toBe(false)
    expect(isSettledAt(ended('a', 'root', 0, { worktree: { status: 'active' } } as unknown as Partial<AgentInstance>), 1e9)).toBe(false)
    expect(isSettledAt(ended('a', 'root', 0, { worktree: { status: 'merged' } } as unknown as Partial<AgentInstance>), 1e9)).toBe(true)
  })
  it('settles a finished agent with no endedAt at once (nothing to time the grace from)', () => {
    expect(isSettledAt(ended('a', 'root', undefined), 0)).toBe(true)
  })
})

describe('nextSettleAt', () => {
  it('is undefined when nothing is waiting out its grace period', () => {
    expect(nextSettleAt([], 0)).toBeUndefined()
    expect(nextSettleAt([ended('a', 'root', undefined), ended('b', 'root', 0, { state: 'thinking' } as Partial<AgentInstance>)], 0)).toBeUndefined()
    // Already settled at the fold time: no timer for it.
    expect(nextSettleAt([ended('a', 'root', 0)], COLLAPSE_GRACE_MS)).toBeUndefined()
  })
  it('picks the earliest moment still ahead among several pending agents', () => {
    const agents = [ended('a', 'root', 5000), ended('b', 'root', 2000), ended('c', 'root', 0), ended('d', 'root', 3000)]
    // c settled at 6000 (not ahead of 7000); b at 8000 is the earliest still ahead.
    expect(nextSettleAt(agents, 7000)).toBe(2000 + COLLAPSE_GRACE_MS)
  })
  it('skips an agent whose worktree is not settled yet (its next event re-checks)', () => {
    expect(nextSettleAt([ended('a', 'root', 0, { worktree: { status: 'active' } } as unknown as Partial<AgentInstance>)], 0)).toBeUndefined()
  })
  it('moves past a moment once the fold is computed at it, so the timer re-arms for the next one', () => {
    const agents = [ended('a', 'root', 0), ended('b', 'root', 1000)]
    const due = nextSettleAt(agents, -1) as number
    expect(due).toBe(COLLAPSE_GRACE_MS)
    expect(nextSettleAt(agents, due)).toBe(1000 + COLLAPSE_GRACE_MS)
  })
  it('does not depend on how often events arrive: the same agents give the same moment', () => {
    const agents = [ended('a', 'root', 1000)]
    expect(nextSettleAt(agents, 0)).toBe(nextSettleAt([...agents], 0))
  })
})

describe('settleTimerDelay', () => {
  it('waits until the moment, never less than the floor', () => {
    expect(settleTimerDelay(5000, 1000)).toBe(4000)
    expect(settleTimerDelay(1100, 1000)).toBe(SETTLE_TIMER_FLOOR_MS)
  })
  it('re-checks at once (the floor) when the moment is already past', () => {
    expect(settleTimerDelay(1000, 9000)).toBe(SETTLE_TIMER_FLOOR_MS)
  })
})

describe('foldFinished with a timed expansion', () => {
  it('keeps the reports finished before the expansion and folds the ones that finish after it', () => {
    const agents = [ag('root', null, 'running'), ended('old', 'root', 100), ended('new', 'root', 900), ag('busy', 'root', 'running')]
    const r = foldFinished({ agents, isSettled: settled, expanded: { root: 500 }, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'old', 'busy'])
    expect(ids(r.groups.get('root'))).toEqual(['new'])
    expectAttached(r, 'root')
  })
  it('shows every report with a plain true expansion', () => {
    const agents = [ag('root', null, 'running'), ended('old', 'root', 100), ended('new', 'root', 900)]
    const r = foldFinished({ agents, isSettled: settled, expanded: { root: true }, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'old', 'new'])
    expect(r.groups.size).toBe(0)
  })
  it('keeps a report with no endedAt shown under a timed expansion', () => {
    const agents = [ag('root', null, 'running'), ended('x', 'root', undefined)]
    const r = foldFinished({ agents, isSettled: settled, expanded: { root: 500 }, collapse: true })
    expect(ids(r.visibleAgents)).toEqual(['root', 'x'])
  })
})
