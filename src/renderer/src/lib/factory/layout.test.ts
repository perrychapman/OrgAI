import { describe, expect, it } from 'vitest'
import {
  EMPTY_LAYOUT_MEMORY,
  GANTRY_MIN_Z,
  HEAD_W,
  STATION_SIZE,
  layoutFloor,
  layoutTeam,
  lineSigns,
  machineVariant,
  stableHash
} from './layout'
import type { FactoryAgentInput, FloorLayout, LayoutMemory, Vec2 } from './types'

function agent(id: string, parentId: string | null, startedAt: number, extra: Partial<FactoryAgentInput> = {}): FactoryAgentInput {
  return {
    id,
    name: id,
    parentId,
    roleKey: 'role',
    state: 'thinking',
    statusWord: 'Running',
    activity: '',
    toolCalls: 0,
    startedAt,
    session: 'current',
    ...extra
  }
}

const lay = (agents: FactoryAgentInput[], memory: LayoutMemory = EMPTY_LAYOUT_MEMORY, runKey = 'run-1') => layoutFloor({ runKey, agents }, memory)
const xz = (l: FloorLayout, id: string): [number, number] => [l.stations[id].center.x, l.stations[id].center.z]
const size = (l: FloorLayout): [number, number] => [l.hall.maxX - l.hall.minX, l.hall.maxZ - l.hall.minZ]

/** Builds `n` reports of `parent` named `${prefix}1..n`, starting at time `t`; returns the agents and the next time. */
function reports(parent: string, prefix: string, n: number, t: number): [FactoryAgentInput[], number] {
  const out: FactoryAgentInput[] = []
  for (let i = 1; i <= n; i++) out.push(agent(`${prefix}${i}`, parent, t++))
  return [out, t]
}

describe('layoutFloor: section 3.3 worked examples', () => {
  it('1 agent: booth only, 30 x 12 m hall', () => {
    const { layout } = lay([agent('root', null, 0)])
    expect(layout.order).toEqual(['root'])
    expect(layout.stations.root).toMatchObject({ kind: 'booth', line: 0, row: -1, center: { x: 7, z: -6 } })
    expect(layout.hall).toEqual({ minX: 0, maxX: 30, minZ: -10, maxZ: 2 })
    expect(size(layout)).toEqual([30, 12])
    expect(layout.lines).toEqual([])
    expect(layout.booth).toEqual({ x: 7, z: -6 })
  })

  it('no root: an empty hall with the gantry only', () => {
    const { layout } = lay([])
    expect(layout.order).toEqual([])
    expect(layout.booth).toBeNull()
    expect(layout.hall).toEqual({ minX: 0, maxX: 30, minZ: -10, maxZ: 2 })
  })

  it('5 agents: two leads, one report each', () => {
    const { layout } = lay([agent('root', null, 0), agent('A', 'root', 1), agent('B', 'root', 2), agent('A1', 'A', 3), agent('B1', 'B', 4)])
    expect(xz(layout, 'A')).toEqual([6, 1.5])
    expect(xz(layout, 'B')).toEqual([10, 1.5])
    expect(xz(layout, 'A1')).toEqual([6, 8.5])
    expect(xz(layout, 'B1')).toEqual([6, 15.5])
    expect(layout.lines.map((l) => [l.number, l.leadId, l.rows])).toEqual([[1, 'root', [0]], [2, 'A', [1]], [3, 'B', [2]]])
    expect(size(layout)).toEqual([30, 32])
    expect(layout.stations.A.kind).toBe('lead')
    expect(layout.stations.A1.kind).toBe('bench')
    expect(layout.order).toEqual(['root', 'A', 'B', 'A1', 'B1'])
  })

  it('15 agents: three leads with 4, 4 and 3 reports', () => {
    const [a, t1] = reports('A', 'a', 4, 4)
    const [b, t2] = reports('B', 'b', 4, t1)
    const [c] = reports('C', 'c', 3, t2)
    const { layout } = lay([agent('root', null, 0), agent('A', 'root', 1), agent('B', 'root', 2), agent('C', 'root', 3), ...a, ...b, ...c])
    expect([xz(layout, 'A'), xz(layout, 'B'), xz(layout, 'C')]).toEqual([[6, 1.5], [10, 1.5], [14, 1.5]])
    expect(a.map((x) => xz(layout, x.id))).toEqual([[6, 8.5], [10, 8.5], [14, 8.5], [18, 8.5]])
    expect(b.map((x) => xz(layout, x.id))).toEqual([[6, 15.5], [10, 15.5], [14, 15.5], [18, 15.5]])
    expect(c.map((x) => xz(layout, x.id))).toEqual([[6, 22.5], [10, 22.5], [14, 22.5]])
    expect(size(layout)).toEqual([30, 39])
  })

  it('40 flat: root and 39 reports on line 1, rows of 8, 8, 8, 8, 7', () => {
    const [r] = reports('root', 'w', 39, 1)
    const { layout } = lay([agent('root', null, 0), ...r])
    const perRow = [0, 1, 2, 3, 4].map((row) => r.filter((x) => layout.stations[x.id].row === row).length)
    expect(perRow).toEqual([8, 8, 8, 8, 7])
    expect(layout.lines.map((l) => [l.number, l.rows])).toEqual([[1, [0, 1, 2, 3, 4]]])
    expect(xz(layout, 'w8')).toEqual([34, 1.5])
    expect(xz(layout, 'w9')).toEqual([6, 8.5])
    expect(xz(layout, 'w39')).toEqual([30, 29.5])
    expect(size(layout)).toEqual([38, 46])
  })

  it('40 deep: lines 1 to 6, line 5 continued on row 5', () => {
    const list = [agent('root', null, 0), agent('A', 'root', 1)]
    let t = 2
    const chain: [string, string, number][] = [['A', 'B', 6], ['B', 'C', 7], ['C', 'D', 8], ['D', 'E', 9], ['E', 'F', 8]]
    for (const [lead, first, n] of chain) {
      list.push(agent(first, lead, t++))
      for (let i = 2; i <= n; i++) list.push(agent(`${lead}-r${i}`, lead, t++))
    }
    expect(list).toHaveLength(40)
    const { layout } = lay(list)
    expect(layout.lines.map((l) => [l.number, l.leadId, l.rows, l.count])).toEqual([
      [1, 'root', [0], 1],
      [2, 'A', [1], 6],
      [3, 'B', [2], 7],
      [4, 'C', [3], 8],
      [5, 'D', [4, 5], 9],
      [6, 'E', [6], 8]
    ])
    expect(xz(layout, 'A')).toEqual([6, 1.5])
    expect(xz(layout, 'E')).toEqual([6, 29.5])
    expect(xz(layout, 'D-r9')).toEqual([6, 36.5])
    expect(xz(layout, 'F')).toEqual([6, 43.5])
    expect(size(layout)).toEqual([38, 60])
    const signs = lineSigns(layout)
    expect(signs.filter((s) => s.line === 5).map((s) => [s.row, s.continued])).toEqual([[4, false], [5, true]])
  })

  it('arrival mid-run appends; removal leaves a vacant slot; nothing moves; a returning id gets its slot back', () => {
    const base = [agent('root', null, 0), agent('A', 'root', 1), agent('B', 'root', 2), agent('A1', 'A', 3)]
    const first = lay(base)
    const second = lay([...base, agent('B1', 'B', 10)], first.memory)
    for (const id of ['A', 'B', 'A1']) expect(xz(second.layout, id)).toEqual(xz(first.layout, id))
    expect(xz(second.layout, 'B1')).toEqual([6, 15.5])
    const third = lay([...base.filter((a) => a.id !== 'B'), agent('B1', 'B', 10)], second.memory)
    expect(third.layout.stations.B).toBeUndefined()
    expect(third.layout.vacant).toEqual([{ id: 'B', line: 1, row: 0, slot: 1, center: { x: 10, z: 1.5 } }])
    // B1 keeps its line (led by the now vacant B) and its place.
    expect(xz(third.layout, 'B1')).toEqual([6, 15.5])
    expect(size(third.layout)).toEqual(size(second.layout))
    const fourth = lay([...base, agent('B1', 'B', 10), agent('C', 'root', 20)], third.memory)
    expect(xz(fourth.layout, 'B')).toEqual([10, 1.5])
    expect(xz(fourth.layout, 'C')).toEqual([14, 1.5])
  })

  it('earlier-session agents never appear; an agent whose parent is off the floor sits on the root line', () => {
    const { layout } = lay([agent('root', null, 0), agent('old', null, -5, { session: 'earlier' }), agent('x', 'old', 1), agent('y', 'missing', 2)])
    expect(layout.order).toEqual(['root', 'x', 'y'])
    expect(layout.stations.x.line).toBe(1)
    expect(layout.stations.y.line).toBe(1)
  })

  it('picks the earliest parentless agent as root, then the smallest id; other parentless agents report to it', () => {
    const { layout } = lay([agent('b', null, 1), agent('a', null, 1), agent('c', null, 0.5)])
    expect(layout.order[0]).toBe('c')
    expect(layout.stations.a).toMatchObject({ line: 1, slot: 0 })
    expect(layout.stations.b).toMatchObject({ line: 1, slot: 1 })
  })

  it('resets memory when the run key changes', () => {
    const first = lay([agent('root', null, 0), agent('A', 'root', 1), agent('B', 'root', 2)])
    const other = lay([agent('root2', null, 0), agent('B', 'root2', 5)], first.memory, 'run-2')
    expect(xz(other.layout, 'B')).toEqual([6, 1.5])
    expect(other.layout.vacant).toEqual([])
    expect(other.memory.runKey).toBe('run-2')
  })

  it('does not mutate the memory it is given', () => {
    const first = lay([agent('root', null, 0), agent('A', 'root', 1)])
    const snapshot = JSON.stringify(first.memory)
    lay([agent('root', null, 0), agent('A', 'root', 1), agent('B', 'A', 2)], first.memory)
    expect(JSON.stringify(first.memory)).toBe(snapshot)
  })

  it('content bounds frame booth, dock, board and stations', () => {
    const { layout } = lay([agent('root', null, 0), ...reports('root', 'w', 9, 1)[0]])
    expect(layout.content).toEqual({ minX: 4, maxX: 35.5, minZ: -10, maxZ: 10 })
  })

  it('machine variant is a stable hash of roleKey', () => {
    expect(stableHash('implementer')).toBe(stableHash('implementer'))
    expect(machineVariant('implementer')).toBe(stableHash('implementer') % 4)
    const { layout } = lay([agent('root', null, 0), agent('a', 'root', 1, { roleKey: 'k1' }), agent('b', 'root', 2, { roleKey: 'k1' })])
    expect(layout.stations.a.variant).toBe(layout.stations.b.variant)
    const variants = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'reviewer', 'tester'].map(machineVariant))
    expect(variants.size).toBeGreaterThan(1)
  })
})

// ---- invariants ----

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AISLE = (z: number): boolean => Math.abs(((z - 5.5) / 7) - Math.round((z - 5.5) / 7)) < 1e-9

/** Overlap, hall and route invariants of one layout. */
function checkInvariants(layout: FloorLayout): void {
  const all: Vec2[] = [...Object.values(layout.stations).filter((s) => s.kind !== 'booth').map((s) => s.center), ...layout.vacant.map((v) => v.center)]
  const keys = new Set(all.map((c) => `${c.x},${c.z}`))
  expect(keys.size).toBe(all.length)
  const h = STATION_SIZE / 2
  for (const c of all) {
    expect(c.x - h).toBeGreaterThanOrEqual(layout.hall.minX + HEAD_W)
    expect(c.x + h).toBeLessThanOrEqual(layout.hall.maxX)
    expect(c.z - h).toBeGreaterThanOrEqual(0)
    expect(c.z + h).toBeLessThanOrEqual(layout.hall.maxZ)
  }
  for (const r of layout.routes) {
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]
      const b = r.points[i]
      const inHead = a.x >= 0 && a.x <= HEAD_W && b.x >= 0 && b.x <= HEAD_W
      const alongAisle = a.z === b.z && (AISLE(a.z) || (r.line === 1 && a.z === -3.5))
      expect(inHead || alongAisle, `route of line ${r.line}: ${JSON.stringify([a, b])}`).toBe(true)
      expect(a.z).toBeGreaterThanOrEqual(GANTRY_MIN_Z)
      expect(Math.max(a.z, b.z)).toBeLessThanOrEqual(layout.hall.maxZ)
      expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(layout.hall.maxX)
    }
  }
}

describe('layoutFloor: invariants', () => {
  it('seeded property: 500 sequences, up to 60 agents, depth 8; no placed centre ever changes', () => {
    for (let seq = 0; seq < 500; seq++) {
      const rnd = mulberry32(1000 + seq)
      const depth = new Map<string, number>([['root', 0]])
      const present = new Map<string, FactoryAgentInput>([['root', agent('root', null, 0)]])
      const removed = new Map<string, FactoryAgentInput>()
      const firstCentre = new Map<string, string>()
      let memory: LayoutMemory = EMPTY_LAYOUT_MEMORY
      let t = 1
      let made = 0
      const steps = 20 + Math.floor(rnd() * 80)
      for (let step = 0; step < steps; step++) {
        const roll = rnd()
        if (roll < 0.7 && made < 59) {
          const parents = [...depth.keys()].filter((id) => (depth.get(id) ?? 0) < 8)
          const parent = parents[Math.floor(rnd() * parents.length)]
          const id = `a${++made}`
          depth.set(id, (depth.get(parent) ?? 0) + 1)
          present.set(id, agent(id, parent, t++, { roleKey: `r${Math.floor(rnd() * 5)}` }))
        } else if (roll < 0.9) {
          const ids = [...present.keys()].filter((id) => id !== 'root')
          if (ids.length) {
            const id = ids[Math.floor(rnd() * ids.length)]
            removed.set(id, present.get(id)!)
            present.delete(id)
          }
        } else if (removed.size) {
          const ids = [...removed.keys()]
          const id = ids[Math.floor(rnd() * ids.length)]
          present.set(id, removed.get(id)!)
          removed.delete(id)
        }
        const r = lay([...present.values()], memory)
        memory = r.memory
        const seen: [string, Vec2][] = [
          ...Object.values(r.layout.stations).map((s) => [s.id, s.center] as [string, Vec2]),
          ...r.layout.vacant.map((v) => [v.id, v.center] as [string, Vec2])
        ]
        for (const [id, c] of seen) {
          const key = `${c.x},${c.z}`
          const before = firstCentre.get(id)
          if (before === undefined) firstCentre.set(id, key)
          else expect(key, `seq ${seq} step ${step}: ${id} moved`).toBe(before)
        }
        if (step % 5 === 0) checkInvariants(r.layout)
      }
    }
  })

  it('folding upserts one at a time in startedAt order equals the one-shot layout', () => {
    for (let seq = 0; seq < 60; seq++) {
      const rnd = mulberry32(77 + seq)
      const list = [agent('root', null, 0)]
      const n = 1 + Math.floor(rnd() * 59)
      for (let i = 1; i <= n; i++) list.push(agent(`a${i}`, list[Math.floor(rnd() * list.length)].id, i))
      let memory: LayoutMemory = EMPTY_LAYOUT_MEMORY
      let folded: FloorLayout | null = null
      for (let i = 1; i <= list.length; i++) {
        const r = lay(list.slice(0, i), memory)
        memory = r.memory
        folded = r.layout
      }
      const once = lay(list)
      expect(folded).toEqual(once.layout)
      expect(memory).toEqual(once.memory)
      checkInvariants(once.layout)
    }
  })

  it('the worked examples satisfy the overlap, hall and route rules', () => {
    const [r] = reports('root', 'w', 39, 1)
    checkInvariants(lay([agent('root', null, 0), ...r]).layout)
  })

  it('routes: line 1 from the booth front, other lines from the lead aisle in their lane, continuation rows', () => {
    const [many] = reports('A', 'a', 9, 3)
    const { layout } = lay([agent('root', null, 0), agent('A', 'root', 1), ...many])
    expect(layout.routes).toEqual([
      { line: 1, lane: 0, points: [{ x: 7, z: -3.5 }, { x: 1, z: -3.5 }, { x: 1, z: 1.5 }, { x: 2, z: 1.5 }] },
      { line: 2, lane: 0, points: [{ x: 6, z: 5.5 }, { x: 1, z: 5.5 }, { x: 1, z: 8.5 }, { x: 2, z: 8.5 }] },
      { line: 2, lane: 0, points: [{ x: 1, z: 8.5 }, { x: 1, z: 15.5 }, { x: 2, z: 15.5 }] }
    ])
  })
})

describe('layoutTeam: preorder', () => {
  const role = (id: string, reportsTo: string | null, i: number): FactoryAgentInput =>
    agent(id, reportsTo, i, { roleKey: id, state: 'role', statusWord: 'Role' })
  const ROLES = [
    role('orch', null, 0),
    role('arch', 'orch', 1),
    role('dev1', 'lead-dev', 2),
    role('lead-dev', 'orch', 3),
    role('qa', 'orch', 4),
    role('dev2', 'lead-dev', 5),
    role('rev', 'arch', 6),
    role('docs', 'orch', 7),
    role('tester', 'qa', 8),
    role('dev3', 'lead-dev', 9),
    role('sec', 'arch', 10),
    role('ops', null, 11)
  ]

  it('a 12-role fixture gives a fixed coordinate table', () => {
    const { layout } = layoutTeam(ROLES, 'team:p1')
    const table = layout.order.map((id) => {
      const s = layout.stations[id]
      return [id, s.kind, s.line, s.row, s.slot, s.center.x, s.center.z]
    })
    expect(table).toEqual([
      ['orch', 'booth', 0, -1, 0, 7, -6],
      ['arch', 'lead', 1, 0, 0, 6, 1.5],
      ['lead-dev', 'lead', 1, 0, 1, 10, 1.5],
      ['qa', 'lead', 1, 0, 2, 14, 1.5],
      ['docs', 'bench', 1, 0, 3, 18, 1.5],
      ['ops', 'bench', 1, 0, 4, 22, 1.5],
      ['rev', 'bench', 2, 1, 0, 6, 8.5],
      ['sec', 'bench', 2, 1, 1, 10, 8.5],
      ['dev1', 'bench', 3, 2, 0, 6, 15.5],
      ['dev2', 'bench', 3, 2, 1, 10, 15.5],
      ['dev3', 'bench', 3, 2, 2, 14, 15.5],
      ['tester', 'bench', 4, 3, 0, 6, 22.5]
    ])
    expect(layout.vacant).toEqual([])
    checkInvariants(layout)
  })

  it('recomputes from scratch: removing a role closes its gap', () => {
    const { layout } = layoutTeam(ROLES.filter((r) => r.id !== 'lead-dev' && !r.id.startsWith('dev')), 'team:p1')
    expect(layout.stations.qa.center).toEqual({ x: 10, z: 1.5 })
    expect(layout.vacant).toEqual([])
  })

  it('survives a reportsTo cycle', () => {
    const { layout } = layoutTeam([role('r', null, 0), role('x', 'y', 1), role('y', 'x', 2)], 'team:p2')
    expect(Object.keys(layout.stations).sort()).toEqual(['r', 'x', 'y'])
    checkInvariants(layout)
  })
})
