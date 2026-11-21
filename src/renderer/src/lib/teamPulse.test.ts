import { describe, expect, it } from 'vitest'
import type { AgentInstance, Project } from '@shared/types'
import {
  PAGE_BREATHING_MAX,
  PULSE_MAX_NODES,
  PULSE_MAX_SIGNALS,
  SIGNAL_LEGS,
  SIGNAL_WINDOW_MS,
  pulseBreathBudget,
  pulseInput,
  pulseModel,
  signalStops,
  type PulseGroup,
  type PulseInput,
  type PulseItem,
  type PulseNodeState,
  type PulseState
} from './teamPulse'

const NOW = 1_000_000

function item(id: string, parentId: string | null, state: PulseNodeState = 'idle', order = 0, color = '#336699'): PulseItem {
  return { id, parentId, state, label: id, color, order }
}

function group(key: string, items: PulseItem[], messages: PulseGroup['messages'] = []): PulseGroup {
  return { key, items, messages }
}

function input(groups: PulseGroup[], extra: Partial<PulseInput> = {}): PulseInput {
  return { groups, rest: null, now: NOW, since: 0, ...extra }
}

function model(groups: PulseGroup[], extra: Partial<PulseInput> = {}) {
  const m = pulseModel(input(groups, extra))
  if (!m) throw new Error('expected a model')
  return m
}

/** root + `n` children of root. */
function fan(key: string, n: number, state: PulseState = 'idle'): PulseGroup {
  const items = [item('root', null, 'working', 0)]
  for (let i = 0; i < n; i++) items.push(item(`c${String(i).padStart(2, '0')}`, 'root', state, i + 1))
  return group(key, items)
}

describe('pulseModel: empty', () => {
  it('is null with no run and no rest team', () => {
    expect(pulseModel(input([]))).toBeNull()
    expect(pulseModel(input([group('r', [])]))).toBeNull()
    expect(pulseModel(input([], { rest: group('rest:p', []) }))).toBeNull()
  })
})

describe('pulseModel: one tree', () => {
  it('lays a root over its children, level by level, deterministically', () => {
    const g = group('r1', [item('root', null, 'working', 0), item('a', 'root', 'working', 1), item('b', 'root', 'waiting', 2), item('c', 'a', 'done', 3)])
    const m = model([g])
    expect(m.mode).toBe('live')
    const at = (id: string) => m.nodes.find((n) => n.id === id)!
    expect(at('root').depth).toBe(0)
    expect(at('a').y).toBeGreaterThan(at('root').y)
    expect(at('c').y).toBeGreaterThan(at('a').y)
    expect(at('b').y).toBe(at('a').y)
    // the parent sits over its first and last child; leaves take distinct slots left to right
    expect(at('a').x).toBeLessThan(at('b').x)
    expect(at('root').x).toBe((at('a').x + at('b').x) / 2)
    expect(at('c').x).toBe(at('a').x)
    expect(model([g])).toEqual(m)
    expect(m.lines).toHaveLength(3)
    // roles colour the fill, the parent's colour draws the line
    expect(m.lines.every((l) => l.color === '#336699' && l.d.startsWith('M'))).toBe(true)
    expect(m.width).toBeGreaterThan(0)
    expect(m.height).toBeGreaterThanOrEqual(at('c').y)
  })

  it('draws an elbow: down, across, down', () => {
    const m = model([group('r', [item('root', null, 'working', 0), item('a', 'root', 'idle', 1), item('b', 'root', 'idle', 2)])])
    for (const l of m.lines) expect(l.d).toMatch(/^M[\d.]+ [\d.]+ V[\d.]+ H[\d.]+ V[\d.]+$/)
  })

  it('draws a single agent', () => {
    const m = model([group('r', [item('root', null, 'working')])])
    expect(m.nodes).toHaveLength(1)
    expect(m.lines).toHaveLength(0)
    expect(m.more).toBe(0)
    expect(m.caption.text).toBe('1 agent in 1 run: 1 working.')
  })

  it('hangs a dangling or looping agent under the root so every agent has a place', () => {
    const m = model([group('r', [item('root', null, 'working', 0), item('x', 'ghost', 'idle', 1), item('p', 'q', 'idle', 2), item('q', 'p', 'idle', 3)])])
    expect(m.nodes).toHaveLength(4)
    expect(m.lines).toHaveLength(3)
    expect(m.nodes.filter((n) => n.depth === 1)).toHaveLength(3)
  })

  it('handles a deep chain with tighter rows and no overlap', () => {
    const items = [item('n0', null, 'working', 0)]
    for (let i = 1; i < 8; i++) items.push(item(`n${i}`, `n${i - 1}`, 'working', i))
    const m = model([group('r', items)])
    expect(m.nodes).toHaveLength(8)
    const ys = m.nodes.map((n) => n.y)
    expect(new Set(ys).size).toBe(8)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    // 8 levels use the tight row, so the picture stays compact
    expect(m.height).toBeLessThan(8 * 44)
    expect(m.nodes[0].r).toBeGreaterThan(m.nodes[7].r)
  })
})

describe('pulseModel: several runs', () => {
  it('puts roots side by side with a gap, never overlapping', () => {
    const a = fan('a', 2)
    const b = fan('b', 2)
    const m = model([a, b])
    const roots = m.nodes.filter((n) => n.depth === 0)
    expect(roots).toHaveLength(2)
    expect(roots[0].y).toBe(roots[1].y)
    const left = m.nodes.filter((n) => n.group === 'a')
    const right = m.nodes.filter((n) => n.group === 'b')
    expect(Math.max(...left.map((n) => n.x))).toBeLessThan(Math.min(...right.map((n) => n.x)))
    expect(m.caption.text).toBe('6 agents in 2 runs: 2 working, 4 idle.')
    expect(new Set(m.nodes.map((n) => n.key)).size).toBe(6)
  })

  it('keeps the same agent id in two runs apart', () => {
    const m = model([group('a', [item('root', null)]), group('b', [item('root', null)])])
    expect(m.nodes.map((n) => n.key)).toEqual(['a:root', 'b:root'])
  })
})

describe('pulseModel: node cap and fold count', () => {
  it('draws at most 12 and folds the rest into the caption', () => {
    const m = model([fan('r', 16)])
    expect(m.nodes).toHaveLength(PULSE_MAX_NODES)
    expect(m.more).toBe(5)
    expect(m.caption.text).toBe('17 agents in 1 run: 1 working, 16 idle. +5 more not drawn.')
    expect(m.caption.tail).toBe('+5 more not drawn.')
  })

  it('keeps what needs the person and what works, and drops finished agents first', () => {
    const items = [item('root', null, 'working', 0)]
    for (let i = 0; i < 10; i++) items.push(item(`d${i}`, 'root', 'done', 1 + i))
    items.push(item('w1', 'root', 'working', 20), item('w2', 'root', 'waiting', 21), item('w3', 'root', 'working', 22), item('w4', 'root', 'failed', 23))
    const m = model([group('r', items)])
    expect(m.nodes).toHaveLength(12)
    const ids = new Set(m.nodes.map((n) => n.id))
    for (const id of ['w1', 'w2', 'w3', 'w4']) expect(ids.has(id)).toBe(true)
    expect(m.nodes.filter((n) => n.state === 'done')).toHaveLength(7)
    expect(m.more).toBe(3)
  })

  it('keeps the ancestors of a kept agent, so no node floats', () => {
    const items = [item('root', null, 'idle', 0)]
    for (let i = 0; i < 12; i++) items.push(item(`s${i}`, 'root', 'idle', 1 + i))
    items.push(item('deep', 's11', 'waiting', 99))
    const m = model([group('r', items)])
    expect(m.nodes).toHaveLength(12)
    const ids = new Set(m.nodes.map((n) => n.id))
    expect(ids.has('deep')).toBe(true)
    expect(ids.has('s11')).toBe(true)
    expect(m.lines).toHaveLength(11)
  })

  it('folds a thirteenth root when the runs alone fill the cap', () => {
    const m = model(Array.from({ length: 14 }, (_, i) => group(`r${String(i).padStart(2, '0')}`, [item('root', null, 'working')])))
    expect(m.nodes).toHaveLength(12)
    expect(m.more).toBe(2)
    expect(m.caption.lead).toBe('14 agents in 14 runs:')
  })

  it('breathes only working nodes, at most 12, staggered by index', () => {
    const m = model([fan('r', 16, 'working')])
    const breathing = m.nodes.filter((n) => n.breath !== undefined)
    expect(breathing).toHaveLength(12)
    expect(breathing.map((n) => n.breath)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    const idle = model([fan('r', 3, 'idle')])
    expect(idle.nodes.filter((n) => n.breath !== undefined)).toHaveLength(1)
  })

  it('splits the page budget of 12: Right now breathes first, Team pulse with what is left', () => {
    expect(PAGE_BREATHING_MAX).toBe(12)
    expect(pulseBreathBudget(0)).toBe(12)
    expect(pulseBreathBudget(5)).toBe(7)
    expect(pulseBreathBudget(11)).toBe(1)
    expect(pulseBreathBudget(12)).toBe(0)
    expect(pulseBreathBudget(40)).toBe(0)
    expect(pulseBreathBudget(-3)).toBe(12)
    expect(pulseBreathBudget(2.9)).toBe(10)
    // The two parts of the page never add up to more than 12.
    for (let band = 0; band <= 16; band++) expect(Math.min(band, 12) + pulseBreathBudget(Math.min(band, 12))).toBeLessThanOrEqual(12)
  })

  it('breathes at most the budget it is given, in index order; the rest keep the static halo', () => {
    const m = model([fan('r', 8, 'working')], { breathBudget: 3 })
    expect(m.nodes.filter((n) => n.breath !== undefined).map((n) => n.breath)).toEqual([0, 1, 2])
    expect(m.nodes.filter((n) => n.state === 'working')).toHaveLength(9)
    expect(model([fan('r', 8, 'working')], { breathBudget: 0 }).nodes.some((n) => n.breath !== undefined)).toBe(false)
    expect(model([fan('r', 16, 'working')], { breathBudget: 99 }).nodes.filter((n) => n.breath !== undefined)).toHaveLength(12)
  })

  it('pulseInput carries the budget, and a full band leaves none', () => {
    expect(pulseInput([], [], {}, null, NOW, 0, 4).breathBudget).toBe(4)
    expect(pulseInput([], [], {}, null, NOW, 0).breathBudget).toBe(PULSE_MAX_NODES)
  })
})

describe('signalStops (transform-only signal route)', () => {
  const legsOf = (s: [number, number][]): number => s.length - 1
  it('keeps the corners and splits the longest legs up to exactly SIGNAL_LEGS legs', () => {
    const route: [number, number][] = [[10, 10], [10, 30], [90, 30], [90, 50]]
    const stops = signalStops(route)!
    expect(legsOf(stops)).toBe(SIGNAL_LEGS)
    expect(stops[0]).toEqual([10, 10])
    expect(stops[stops.length - 1]).toEqual([90, 50])
    for (const corner of route) expect(stops.some((s) => s[0] === corner[0] && s[1] === corner[1])).toBe(true)
    // Every leg stays on the route (orthogonal: x or y never changes within a leg).
    for (let i = 0; i < stops.length - 1; i++) expect(stops[i][0] === stops[i + 1][0] || stops[i][1] === stops[i + 1][1]).toBe(true)
    // The long horizontal leg took most of the splits, so the speed is near even.
    const lens = stops.slice(1).map((s, i) => Math.hypot(s[0] - stops[i][0], s[1] - stops[i][1]))
    expect(Math.max(...lens) / Math.min(...lens)).toBeLessThan(2.5)
  })
  it('drops the cheapest corners of a route with too many legs and still ends where it started and ends', () => {
    const route: [number, number][] = []
    for (let i = 0; i < 30; i++) route.push([i * 10, i % 2 === 0 ? 0 : 20])
    const stops = signalStops(route)!
    expect(legsOf(stops)).toBe(SIGNAL_LEGS)
    expect(stops[0]).toEqual(route[0])
    expect(stops[stops.length - 1]).toEqual(route[route.length - 1])
  })
  it('ignores repeated points and refuses a route that does not move', () => {
    expect(signalStops([[1, 1], [1, 1], [1, 1]])).toBeNull()
    expect(signalStops([[1, 1]])).toBeNull()
    expect(legsOf(signalStops([[0, 0], [0, 0], [0, 8]])!)).toBe(SIGNAL_LEGS)
  })
  it('gives every signal of a model exactly SIGNAL_LEGS + 1 stops, starting and ending on its nodes', () => {
    const items = [item('root', null, 'working', 0), item('a', 'root', 'working', 1), item('b', 'root', 'working', 2), item('c', 'a', 'working', 3)]
    const m = model([group('r', items, [{ from: 'c', to: 'b', at: NOW - 1000 }])])
    expect(m.signals).toHaveLength(1)
    const sig = m.signals[0]
    expect(sig.stops).toHaveLength(SIGNAL_LEGS + 1)
    const at = (id: string) => m.nodes.find((n) => n.id === id)!
    expect(sig.stops[0]).toEqual([at(sig.from).x, at(sig.from).y])
    expect(sig.stops[SIGNAL_LEGS]).toEqual([at(sig.to).x, at(sig.to).y])
  })
})

describe('pulseModel: caption', () => {
  it('names the states in a fixed order and omits empty ones', () => {
    const items = [item('root', null, 'working', 0), item('a', 'root', 'waiting', 1), item('b', 'root', 'working', 2), item('c', 'root', 'working', 3)]
    const m = model([group('r', items), group('s', [item('root', null, 'done')])])
    expect(m.caption.text).toBe('5 agents in 2 runs: 3 working, 1 needs you, 1 finished.')
    expect(m.caption.parts.map((p) => p.state)).toEqual(['working', 'waiting', 'done'])
  })
})

describe('pulseModel: signals', () => {
  const tree = (messages: PulseGroup['messages']) => group('r', [item('root', null, 'working', 0), item('a', 'root', 'working', 1), item('b', 'root', 'working', 2), item('c', 'a', 'idle', 3)], messages)

  it('draws a signal for a fresh message, along the lines between the two agents', () => {
    const m = model([tree([{ from: 'a', to: 'b', at: NOW - 500 }])])
    expect(m.signals).toHaveLength(1)
    const a = m.nodes.find((n) => n.id === 'a')!
    const b = m.nodes.find((n) => n.id === 'b')!
    const sig = m.signals[0]
    expect(sig.d.startsWith(`M${a.x} ${a.y}`)).toBe(true)
    expect(sig.d.endsWith(`L${b.x} ${b.y}`)).toBe(true)
    // up to the root's elbow and down again: orthogonal legs only
    expect(sig.d).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/)
  })

  it('travels a parent-to-child line directly', () => {
    const m = model([tree([{ from: 'root', to: 'c', at: NOW - 10 }])])
    expect(m.signals).toHaveLength(1)
    const root = m.nodes.find((n) => n.id === 'root')!
    const c = m.nodes.find((n) => n.id === 'c')!
    // one fixed direction per pair (smaller id first): 'c' then 'root'
    expect(m.signals[0].d.startsWith(`M${c.x} ${c.y}`)).toBe(true)
    expect(m.signals[0].d.endsWith(`L${root.x} ${root.y}`)).toBe(true)
  })

  it('keeps one signal, with one key and one path, for a back-and-forth conversation', () => {
    const one = model([tree([{ from: 'a', to: 'b', at: NOW - 3000 }])]).signals[0]
    const pingPong = model([tree([{ from: 'a', to: 'b', at: NOW - 3000 }, { from: 'b', to: 'a', at: NOW - 2000 }, { from: 'a', to: 'b', at: NOW - 100 }])]).signals
    expect(pingPong).toHaveLength(1)
    expect(pingPong[0].key).toBe(one.key)
    expect(pingPong[0].d).toBe(one.d)
    expect(pingPong[0].at).toBe(NOW - 100)
  })

  it('never replays an old message, or one sent before the pulse mounted', () => {
    expect(model([tree([{ from: 'a', to: 'b', at: NOW - SIGNAL_WINDOW_MS - 1 }])]).signals).toHaveLength(0)
    expect(model([tree([{ from: 'a', to: 'b', at: NOW - 1000 }])], { since: NOW - 500 }).signals).toHaveLength(0)
    expect(model([tree([{ from: 'a', to: 'b', at: NOW - 1000 }])], { since: NOW - 1500 }).signals).toHaveLength(1)
  })

  it('ignores messages to the user, to an unknown agent, to itself or to an agent not drawn', () => {
    const m = model([tree([{ from: 'a', to: null, at: NOW - 1 }, { from: 'a', to: 'ghost', at: NOW - 1 }, { from: 'a', to: 'a', at: NOW - 1 }])])
    expect(m.signals).toHaveLength(0)
    const big = fan('r', 16)
    big.messages.push({ from: 'c00', to: 'c15', at: NOW - 1 })
    expect(model([big]).signals).toHaveLength(0)
  })

  it('shows each pair once, newest first, at most three at a time', () => {
    const items = [item('root', null, 'working', 0)]
    for (let i = 0; i < 6; i++) items.push(item(`k${i}`, 'root', 'working', i + 1))
    const msgs = [
      { from: 'k0', to: 'k1', at: NOW - 4000 },
      { from: 'k1', to: 'k0', at: NOW - 3000 },
      { from: 'k2', to: 'k3', at: NOW - 2000 },
      { from: 'k4', to: 'k5', at: NOW - 1000 },
      { from: 'k0', to: 'k5', at: NOW - 500 }
    ]
    const m = model([group('r', items, msgs)])
    expect(m.signals).toHaveLength(PULSE_MAX_SIGNALS)
    expect(m.signals.map((s) => `${s.from}>${s.to}`)).toEqual(['k0>k5', 'k4>k5', 'k2>k3'])
    expect(new Set(m.signals.map((s) => s.key)).size).toBe(3)
  })

  it('keeps messages of one run on that run', () => {
    const a = group('a', [item('root', null), item('x', 'root')], [{ from: 'root', to: 'x', at: NOW - 1 }])
    const b = group('b', [item('root', null), item('x', 'root')])
    const m = model([a, b])
    expect(m.signals).toHaveLength(1)
    expect(m.signals[0].key.startsWith('a:')).toBe(true)
  })
})

describe('pulseModel: at rest', () => {
  const roles = group('rest:p', [item('ceo', null, 'rest', 0), item('dev', 'ceo', 'rest', 1), item('qa', 'ceo', 'rest', 2), item('ops', 'dev', 'rest', 3), item('doc', 'dev', 'rest', 4)])

  it('draws the team with no halo, no signal and no breathing', () => {
    const m = model([], { rest: roles })
    expect(m.mode).toBe('rest')
    expect(m.nodes).toHaveLength(5)
    expect(m.nodes.every((n) => n.state === 'rest' && n.breath === undefined)).toBe(true)
    expect(m.signals).toHaveLength(0)
    expect(m.caption.text).toBe('Your team: 5 roles. Nothing is running.')
  })

  it('says role for one role, and folds a big team into the caption', () => {
    expect(model([], { rest: group('rest:p', [item('solo', null, 'rest')]) }).caption.text).toBe('Your team: 1 role. Nothing is running.')
    const big = group('rest:p', [item('r', null, 'rest', 0), ...Array.from({ length: 14 }, (_, i) => item(`x${i}`, 'r', 'rest', i + 1))])
    const m = model([], { rest: big })
    expect(m.nodes).toHaveLength(12)
    expect(m.caption.text).toBe('Your team: 15 roles, +3 more not drawn. Nothing is running.')
  })

  it('is replaced by the live picture as soon as a run has agents', () => {
    expect(model([group('r', [item('root', null, 'working')])], { rest: roles }).mode).toBe('live')
    expect(model([group('r', [])], { rest: roles }).mode).toBe('rest')
  })
})

function agent(id: string, parentId: string | null, over: Partial<AgentInstance> = {}): AgentInstance {
  return { id, roleId: null, roleSlug: id, name: id, parentId, spawnToolUseId: null, state: 'idle', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1, ...over }
}

describe('pulseInput', () => {
  const project = {
    id: 'p1',
    name: 'P',
    roles: [
      { id: 'r1', slug: 'lead', name: 'Lead', color: '#111111', reportsTo: null },
      { id: 'r2', slug: 'dev', name: 'Dev', color: '#222222', reportsTo: 'r1' }
    ]
  } as unknown as Project

  it('reads run state: colour by role, state words, order and messages', () => {
    const run = {
      id: 'run1',
      projectId: 'p1',
      startedAt: 5,
      agents: {
        root: agent('root', null, { roleId: 'r1', state: 'delegating', startedAt: 1 }),
        w: agent('w', 'root', { roleId: 'r2', state: 'tool', startedAt: 2 }),
        n: agent('n', 'root', { roleSlug: 'nobody', state: 'waiting', startedAt: 3 })
      },
      messages: [{ from: 'root', to: 'w', toHandle: 'w', text: 'hi', at: 9 }]
    }
    const inp = pulseInput([run], [project], {}, null, 10, 0)
    expect(inp.groups).toHaveLength(1)
    const items = inp.groups[0].items
    expect(items.find((i) => i.id === 'root')).toMatchObject({ state: 'working', color: '#111111' })
    expect(items.find((i) => i.id === 'w')).toMatchObject({ state: 'working', color: '#222222', parentId: 'root' })
    expect(items.find((i) => i.id === 'n')).toMatchObject({ state: 'waiting', color: 'var(--text-tertiary)' })
    expect(inp.groups[0].messages).toEqual([{ from: 'root', to: 'w', at: 9 }])
    expect(inp.rest).toBeNull()
  })

  it('prefers the run roster over the project roles', () => {
    const run = {
      id: 'run1',
      projectId: 'p1',
      startedAt: 5,
      roster: [{ id: 'r1', slug: 'lead', name: 'Lead', color: '#abcdef' }] as never,
      agents: { root: agent('root', null, { roleId: 'r1' }) }
    }
    expect(pulseInput([run], [project], {}, null, 10, 0).groups[0].items[0].color).toBe('#abcdef')
  })

  it('orders runs oldest first, drops a run without agents and builds the rest team from reportsTo', () => {
    const mk = (id: string, startedAt: number, agents: Record<string, AgentInstance>) => ({ id, projectId: 'p1', startedAt, agents })
    const inp = pulseInput([mk('b', 9, { root: agent('root', null) }), mk('a', 2, { root: agent('root', null) }), mk('c', 1, {})], [project], {}, 'p1', 10, 0)
    expect(inp.groups.map((g) => g.key)).toEqual(['a', 'b'])
    expect(inp.rest?.items).toEqual([
      { id: 'r1', parentId: null, state: 'rest', label: 'Lead', color: '#111111', order: 0 },
      { id: 'r2', parentId: 'r1', state: 'rest', label: 'Dev', color: '#222222', order: 1 }
    ])
    expect(pulseInput([], [project], {}, 'missing', 10, 0).rest).toBeNull()
    expect(pulseInput([], [project], {}, null, 10, 0).rest).toBeNull()
  })
})
