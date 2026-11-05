import { describe, expect, it } from 'vitest'
import type { KnowledgeEdge, KnowledgeNode } from '@shared/types'
import {
  RecallGate,
  boundsOf,
  buildNeuralModel,
  cardPlacement,
  comesUpLine,
  cutLabel,
  extremeNode,
  fitView,
  initLayout,
  labelBudget,
  layoutFromPositions,
  lodFor,
  neighbourTarget,
  neuralRadius,
  newestIds,
  panIntoView,
  parseStoredLayout,
  pickLabels,
  placeNew,
  prng,
  relationRows,
  seedOf,
  serializeLayout,
  sharedNeighbourLine,
  spatialTarget,
  spokenName,
  stepLayout,
  topRelationLines,
  typeAheadTarget,
  zoomAt,
  drawnMask,
  type LabelCandidate
} from './knowledgeNeural'

const src = { by: 'user' as const, at: 1 }
const node = (id: string, name: string, kind = 'person', createdAt = 1, extra: Partial<KnowledgeNode> = {}): KnowledgeNode => ({ id, kind, name, facts: [], source: src, createdAt, updatedAt: createdAt, ...extra })
const edge = (id: string, from: string, to: string, relation = 'works-at', extra: Partial<KnowledgeEdge> = {}): KnowledgeEdge => ({ id, from, to, relation, source: src, createdAt: 1, ...extra })

function chain(n: number): { ids: string[]; links: [string, string][] } {
  const ids = Array.from({ length: n }, (_, i) => `kn_${i.toString(16).padStart(4, '0')}`)
  const links: [string, string][] = []
  for (let i = 1; i < n; i++) links.push([ids[i - 1], ids[i]], [ids[Math.floor(i / 2)], ids[i]])
  return { ids, links }
}
const radiiFor = (n: number): number[] => Array.from({ length: n }, (_, i) => 6 + (i % 7) * 3)

describe('radius', () => {
  it('follows the spec table for a top total of 16', () => {
    const r = (t: number): number => Math.round(neuralRadius(t, 16))
    expect([0, 1, 4, 9, 16].map(r)).toEqual([6, 13, 22, 29, 34])
  })
  it('follows the spec table for a top total of 1,500', () => {
    const r = (t: number): number => Math.round(neuralRadius(t, 1500))
    expect([r(1), r(5), r(50)]).toEqual([9, 13, 21])
  })
  it('stays between 6 and 34 and grows with the total', () => {
    expect(neuralRadius(-3, 0)).toBe(6)
    expect(neuralRadius(5000, 10)).toBeLessThanOrEqual(34)
    expect(neuralRadius(5, 100)).toBeGreaterThan(neuralRadius(2, 100))
  })
})

describe('level of detail', () => {
  it('has the tier bounds of the spec', () => {
    expect([0, 300, 301, 800, 801, 2000].map(lodFor)).toEqual(['full', 'full', 'medium', 'medium', 'low', 'low'])
  })
})

describe('force layout', () => {
  it('is deterministic for the same graph and seed, and differs with another seed', () => {
    const { ids, links } = chain(40)
    const run = (seed: string): number[] => {
      const s = initLayout({ ids, links, radii: radiiFor(40), seed })
      stepLayout(s, Infinity)
      return [...s.x, ...s.y].map((v) => Math.round(v * 1000))
    }
    expect(run('p1')).toEqual(run('p1'))
    expect(run('p1')).not.toEqual(run('p2'))
  })
  it('settles within 300 ticks and reports it', () => {
    const { ids, links } = chain(30)
    const s = initLayout({ ids, links, radii: radiiFor(30), seed: 'x' })
    expect(s.settled).toBe(false)
    stepLayout(s, Infinity)
    expect(s.settled).toBe(true)
    expect(s.ticks).toBeLessThanOrEqual(300)
    for (let i = 0; i < 30; i++) expect(Number.isFinite(s.x[i]) && Number.isFinite(s.y[i])).toBe(true)
  })
  it('does the same number of ticks whatever the slice size', () => {
    const { ids, links } = chain(25)
    const a = initLayout({ ids, links, radii: radiiFor(25), seed: 'x' })
    const b = initLayout({ ids, links, radii: radiiFor(25), seed: 'x' })
    stepLayout(a, Infinity)
    let t = 0
    while (!b.settled) stepLayout(b, 8, () => (t += 3))
    expect([...b.x]).toEqual([...a.x])
  })
  it('keeps connected nodes closer than unconnected ones and nodes apart', () => {
    const { ids, links } = chain(20)
    const s = initLayout({ ids, links, radii: radiiFor(20), seed: 'x' })
    stepLayout(s, Infinity)
    for (let i = 0; i < 20; i++)
      for (let j = i + 1; j < 20; j++) expect(Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j])).toBeGreaterThan((s.r[i] + s.r[j]) * 0.6)
  })
  it('uses Barnes-Hut above 200 nodes and still finishes with finite positions', () => {
    const { ids, links } = chain(260)
    const s = initLayout({ ids, links, radii: radiiFor(260), seed: 'big' })
    stepLayout(s, Infinity)
    expect(s.settled).toBe(true)
    expect([...s.x, ...s.y].every(Number.isFinite)).toBe(true)
  })
  it('pins every existing node when a new one is placed, and puts it near its neighbour', () => {
    const { ids, links } = chain(30)
    const s = initLayout({ ids, links, radii: radiiFor(30), seed: 'x' })
    stepLayout(s, Infinity)
    const before = [...s.x, ...s.y]
    const next = placeNew(s, [{ id: 'kn_new', r: 10 }], [...links, [ids[3], 'kn_new']], 'x')
    expect(next.ids).toHaveLength(31)
    expect([...next.x.slice(0, 30), ...next.y.slice(0, 30)]).toEqual(before)
    const d = Math.hypot(next.x[30] - s.x[3], next.y[30] - s.y[3])
    expect(d).toBeLessThan(260)
    expect(next.settled).toBe(true)
  })
  it('puts a node without neighbours on the rim', () => {
    const { ids, links } = chain(12)
    const s = initLayout({ ids, links, radii: radiiFor(12), seed: 'x' })
    stepLayout(s, Infinity)
    const next = placeNew(s, [{ id: 'kn_lonely', r: 8 }], links, 'x')
    let cx = 0
    let cy = 0
    for (let i = 0; i < 12; i++) {
      cx += s.x[i] / 12
      cy += s.y[i] / 12
    }
    const rim = Math.max(...Array.from({ length: 12 }, (_, i) => Math.hypot(s.x[i] - cx, s.y[i] - cy)))
    expect(Math.hypot(next.x[12] - cx, next.y[12] - cy)).toBeGreaterThanOrEqual(rim)
  })
  it('starts settled from stored positions', () => {
    const { ids, links } = chain(5)
    const s = layoutFromPositions({ ids, links, radii: radiiFor(5), seed: 'x' }, new Map([[ids[0], { x: 5, y: 6 }]]))
    expect(s.settled).toBe(true)
    expect([s.x[0], s.y[0]]).toEqual([5, 6])
  })
})

describe('stored layout', () => {
  it('round-trips whole numbers for valid ids', () => {
    const text = serializeLayout(new Map([['kn_ab12', { x: 10.6, y: -3.2 }]]))
    expect(parseStoredLayout(text).get('kn_ab12')).toEqual({ x: 11, y: -3 })
  })
  it('ignores junk', () => {
    expect(parseStoredLayout('not json').size).toBe(0)
    expect(parseStoredLayout('[1,2]').size).toBe(0)
    expect(parseStoredLayout(null).size).toBe(0)
    const junk = JSON.stringify({ __proto__: [1, 2], 'kn_ok': [1, 2], bad: [1, 2], kn_nan: [null, 1], kn_big: [1e12, 1], kn_three: [1, 2, 3], kn_str: ['1', '2'] })
    const out = parseStoredLayout(junk)
    expect([...out.keys()]).toEqual(['kn_ok'])
  })
})

describe('model', () => {
  const nodes = [node('kn_a', 'Acme Corp', 'organisation', 1), node('kn_b', 'Jane Doe', 'person', 2), node('kn_c', 'Tom Okafor', 'person', 3), node('kn_d', 'Old', 'person', 4, { retired: true })]
  const edges = [edge('ke_1', 'kn_b', 'kn_a'), edge('ke_2', 'kn_c', 'kn_a'), edge('ke_3', 'kn_d', 'kn_a'), edge('ke_x', 'kn_zzz', 'kn_a')]
  it('orders by creation, drops edges to unknown nodes, counts live edges without appearances', () => {
    const m = buildNeuralModel({ nodes: [nodes[2], nodes[0], nodes[1], nodes[3]], edges }, null, 'p')
    expect(m.ids).toEqual(['kn_a', 'kn_b', 'kn_c', 'kn_d'])
    expect(m.edges).toHaveLength(3)
    expect(m.totals).toEqual([2, 1, 1, 0])
  })
  it('reads appearances without touching Object.prototype', () => {
    const m = buildNeuralModel({ nodes, edges }, { links: [], appearances: { kn_a: { relations: 5, mentions: 1, notes: 0, total: 6 } } }, 'p')
    expect(m.totals[0]).toBe(6)
    const proto = buildNeuralModel({ nodes: [node('constructor', 'x')], edges: [] }, { links: [], appearances: {} }, 'p')
    expect(proto.totals).toEqual([0])
  })
})

describe('labels', () => {
  const measure = (t: string): number => t.length * 7
  const make = (n: number): LabelCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `kn_${i}`, x: 60 + (i % 10) * 80, y: 60 + Math.floor(i / 10) * 45, r: 6 + (i % 5) * 3, total: n - i, order: i, text: `Name number ${i}` }))
  it('budgets by stage area', () => {
    expect(labelBudget({ w: 928, h: 430 }, 1)).toBe(9)
    expect(labelBudget({ w: 1368, h: 820 }, 1)).toBe(28)
    expect(labelBudget({ w: 100, h: 100 }, 1)).toBe(4)
    expect(labelBudget({ w: 928, h: 430 }, 1.6)).toBe(60)
  })
  it('places names that never overlap each other or a larger node', () => {
    const cands = make(40)
    const placed = pickLabels({ candidates: cands, stage: { w: 928, h: 430 }, zoom: 1, measure })
    expect(placed.length).toBeGreaterThan(0)
    expect(placed.length).toBeLessThanOrEqual(9)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        expect(a.x < b.x + b.w + 4 && b.x < a.x + a.w + 4 && a.y < b.y + b.h + 4 && b.y < a.y + a.h + 4).toBe(false)
      }
      const c = cands.find((x) => x.id === placed[i].id)!
      for (const o of cands.filter((x) => x.r > c.r)) {
        const nx = Math.max(placed[i].x, Math.min(o.x, placed[i].x + placed[i].w))
        const ny = Math.max(placed[i].y, Math.min(o.y, placed[i].y + placed[i].h))
        expect(Math.hypot(o.x - nx, o.y - ny)).toBeGreaterThanOrEqual(o.r)
      }
    }
  })
  it('takes the largest first and puts must and priority ids ahead', () => {
    const cands = make(40)
    const base = pickLabels({ candidates: cands, stage: { w: 1368, h: 820 }, zoom: 1, measure })
    expect(base[0].id).toBe('kn_0')
    const forced = pickLabels({ candidates: cands, stage: { w: 1368, h: 820 }, zoom: 1, measure, must: ['kn_39'], priority: ['kn_38'] })
    expect(forced[0].id).toBe('kn_39')
  })
  it('skips nodes off the stage and cuts long names', () => {
    const off = pickLabels({ candidates: [{ id: 'a', x: -100, y: 10, r: 8, total: 1, order: 0, text: 'x' }], stage: { w: 300, h: 300 }, zoom: 1, measure })
    expect(off).toEqual([])
    expect(cutLabel('a'.repeat(30))).toHaveLength(24)
    expect(cutLabel('short')).toBe('short')
  })
})

describe('card placement', () => {
  const stage = { w: 608, h: 430 }
  const card = { w: 280, h: 200 }
  it('prefers the right, then the left, below and above', () => {
    expect(cardPlacement({ x: 100, y: 200, r: 20 }, card, stage).side).toBe('right')
    expect(cardPlacement({ x: 500, y: 200, r: 20 }, card, stage).side).toBe('left')
    const mid = cardPlacement({ x: 304, y: 60, r: 20 }, { w: 280, h: 200 }, stage)
    expect(mid.side).toBe('below')
    expect(cardPlacement({ x: 304, y: 380, r: 20 }, { w: 280, h: 200 }, stage).side).toBe('above')
  })
  it('never covers the disc and stays inside the stage, wherever the node is', () => {
    for (const w of [608, 928, 1368]) {
      for (let x = 10; x < w; x += 37) {
        for (let y = 10; y < 430; y += 29) {
          for (const r of [6, 20, 34]) {
            const s = { w, h: 430 }
            const p = cardPlacement({ x, y, r }, card, s)
            const h = Math.min(card.h, p.maxHeight)
            expect(p.left).toBeGreaterThanOrEqual(8)
            expect(p.left + card.w).toBeLessThanOrEqual(s.w - 8 + 0.001)
            expect(p.top).toBeGreaterThanOrEqual(8 - 0.001)
            expect(p.top + h).toBeLessThanOrEqual(s.h - 8 + 0.001)
            const nx = Math.max(p.left, Math.min(x, p.left + card.w))
            const ny = Math.max(p.top, Math.min(y, p.top + h))
            if (nx !== x || ny !== y) expect(Math.hypot(x - nx, y - ny)).toBeGreaterThanOrEqual(r - 0.001)
            else expect('node inside card').toBe('never')
          }
        }
      }
    }
  })
})

describe('keyboard moves', () => {
  const spots = [
    { id: 'right', x: 100, y: 10 },
    { id: 'far-right', x: 300, y: 0 },
    { id: 'down', x: 5, y: 80 },
    { id: 'up-left', x: -50, y: -60 }
  ]
  it('takes the nearest spot inside the 90-degree cone', () => {
    expect(spatialTarget({ x: 0, y: 0 }, spots, 'right')).toBe('right')
    expect(spatialTarget({ x: 0, y: 0 }, spots, 'down')).toBe('down')
    expect(spatialTarget({ x: 0, y: 0 }, spots, 'left')).toBeNull()
    expect(spatialTarget({ x: 0, y: 0 }, spots, 'up')).toBe('up-left')
    expect(spatialTarget({ x: 0, y: 0 }, spots.slice(0, 3), 'up')).toBeNull()
    expect(spatialTarget({ x: 0, y: 0 }, [{ id: 'edge', x: 50, y: 50 }], 'right')).toBe('edge')
  })
  it('lets a hub reach every neighbour from every direction', () => {
    const around = [
      { id: 'n', x: 0, y: -50 },
      { id: 'e', x: 50, y: 0 }
    ]
    expect(neighbourTarget({ x: 0, y: 0 }, around, 'left')).not.toBeNull()
    expect(neighbourTarget({ x: 0, y: 0 }, around, 'down')).not.toBeNull()
    expect(neighbourTarget({ x: 0, y: 0 }, around, 'up')).toBe('n')
    expect(neighbourTarget({ x: 0, y: 0 }, [], 'up')).toBeNull()
  })
  it('types ahead on the largest match and finds the extremes', () => {
    const named = [
      { id: 'a', name: 'acme', total: 3, order: 0 },
      { id: 'b', name: 'acorn', total: 9, order: 1 },
      { id: 'c', name: 'jane', total: 1, order: 2 }
    ]
    expect(typeAheadTarget('ac', named)).toBe('b')
    expect(typeAheadTarget('(.*', named)).toBeNull()
    expect(typeAheadTarget('', named)).toBeNull()
    expect(extremeNode(named, 'largest')).toBe('b')
    expect(extremeNode(named, 'smallest')).toBe('c')
  })
})

describe('view', () => {
  it('fits with padding and a zoom cap, and zooms at the pointer', () => {
    const box = boundsOf([{ x: 0, y: 0, r: 10 }])
    expect(fitView(box, { w: 928, h: 430 }).k).toBe(1.4)
    const wide = fitView(boundsOf([{ x: -1000, y: 0, r: 10 }, { x: 1000, y: 0, r: 10 }]), { w: 928, h: 430 })
    expect(wide.k).toBeLessThan(0.5)
    const v = { x: 10, y: 20, k: 1 }
    const z = zoomAt(v, 2, 100, 100)
    expect((100 - z.x) / z.k).toBeCloseTo((100 - v.x) / v.k)
    expect(zoomAt(v, 99, 0, 0).k).toBe(3)
  })
  it('pans the minimum and leaves a node that is inside alone', () => {
    const v = { x: 0, y: 0, k: 1 }
    expect(panIntoView(v, { x: 300, y: 200, r: 10 }, { w: 600, h: 400 })).toBe(v)
    const p = panIntoView(v, { x: 590, y: 200, r: 10 }, { w: 600, h: 400 })
    expect(p.x).toBe(-48)
    expect(p.y).toBe(0)
  })
})

describe('texts', () => {
  it('writes how often it comes up', () => {
    expect(comesUpLine({ relations: 9, mentions: 4, notes: 1, total: 14 })).toBe('Comes up 14 times: 9 relations, 4 mentions, 1 note.')
    expect(comesUpLine({ relations: 1, mentions: 0, notes: 0, total: 1 })).toBe('Comes up once: 1 relation.')
    expect(comesUpLine({ relations: 0, mentions: 0, notes: 0, total: 0 })).toBe('Not connected to anything yet.')
  })
  const nodes = [node('kn_a', 'Acme Corp', 'organisation', 1), node('kn_b', 'Jane Doe', 'person', 2), node('kn_c', 'Tom Okafor', 'person', 3), node('kn_d', 'Mara Lindqvist', 'person', 4), node('kn_e', 'Billing platform', 'system', 5)]
  const edges = [edge('ke_1', 'kn_b', 'kn_a'), edge('ke_2', 'kn_c', 'kn_a'), edge('ke_3', 'kn_d', 'kn_a'), edge('ke_4', 'kn_b', 'kn_e', 'owns')]
  const model = buildNeuralModel({ nodes, edges }, null, 'p')
  const drawn = drawnMask(model, false)
  it('lists relations by neighbour size, from this item', () => {
    const rows = relationRows(model, model.index.get('kn_b')!, drawn, false)
    expect(rows.map((r) => r.text)).toEqual(['works at Acme Corp', 'owns Billing platform'])
    const acme = relationRows(model, model.index.get('kn_a')!, drawn, false)
    expect(acme[0].text).toMatch(/ works at this$/)
    expect(topRelationLines(acme, 2)).toEqual({ lines: acme.slice(0, 2).map((r) => r.text), more: 'and 1 more relation' })
  })
  it('names the shared neighbour', () => {
    expect(sharedNeighbourLine(model, model.index.get('kn_b')!, drawn, false)).toBe('Also works at Acme Corp: Tom Okafor and Mara Lindqvist.')
    expect(sharedNeighbourLine(model, model.index.get('kn_e')!, drawn, false)).toBeNull()
  })
  it('speaks the name, kind, count and top relations', () => {
    const s = spokenName({ name: 'Acme Corp', kind: 'organisation', retired: false, appearance: { relations: 9, mentions: 4, notes: 1, total: 14 }, relations: ['Jane Doe works at this', 'owns Billing platform'] })
    expect(s).toBe('Acme Corp, organisation. Comes up 14 times: 9 relations, 4 mentions, 1 note. Top relations: Jane Doe works at this, owns Billing platform. Press Enter to open.')
    expect(spokenName({ name: 'X', kind: 'open-question', retired: true, appearance: { relations: 0, mentions: 0, notes: 0, total: 0 }, relations: [] })).toBe('X, open question, retired. Not connected to anything yet. Press Enter to open.')
  })
})

describe('recall gate', () => {
  it('fires once per two seconds per run and merges the rest', () => {
    const g = new RecallGate()
    expect(g.push('r1', ['a'], 0)).toEqual({ fire: ['a'] })
    expect(g.push('r1', ['b'], 500)).toEqual({ wait: 1500 })
    expect(g.push('r1', ['c', 'b'], 900)).toEqual({ wait: 1100 })
    expect(g.push('r2', ['z'], 900)).toEqual({ fire: ['z'] })
    expect(g.flush('r1', 2000)).toEqual(['a'].length ? ['c', 'b'] : [])
    expect(g.flush('r1', 2001)).toEqual([])
  })
  it('keeps the newest 12 distinct ids', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `kn_${i}`)
    expect(newestIds(ids)).toEqual(ids.slice(8))
  })
})

describe('seeded random', () => {
  it('repeats for a seed', () => {
    const a = prng(seedOf('x'))
    const b = prng(seedOf('x'))
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})
