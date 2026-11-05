import type { KnowledgeAppearance, KnowledgeGraph, KnowledgeInferredResult, KnowledgeNode } from '@shared/types'
import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'
import { keyWords, kindLabel } from './knowledge'
import { KNOWLEDGE_ID_RE } from './knowledgeRun'

/**
 * Pure helpers of the Knowledge tab's neural canvas (docs/design/knowledge-graph-2.md section 1): the data model, the
 * seeded force layout, node size, level of detail, name placement, the keyboard moves, the card's placement and text,
 * and the view maths. No React, no DOM, no I/O; the draw loop lives in components/knowledge/neuralEngine.ts.
 */

// ---------------------------------------------------------------- text

/** Text as it is drawn: hidden, bidi and control characters removed, runs of white space one space. */
export function cleanLabel(s: string | undefined | null): string {
  if (typeof s !== 'string') return ''
  return s.replace(HIDDEN_OR_CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim()
}

/** A name cut to `max` characters with an ellipsis. */
export function cutLabel(s: string, max = 24): string {
  const chars = [...s]
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------- PRNG

/** A string as a 32-bit seed (xmur3). */
export function seedOf(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** mulberry32: a function returning numbers in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- model

export interface NeuralEdge {
  id: string
  /** Node indexes. */
  a: number
  b: number
  relation: string
  retired: boolean
  /** Seeded bend, -1..1 (a fraction of 8% of the length). */
  bend: number
}

export interface NeuralInferred {
  id: string
  a: number
  b: number
  basis: string
  strength: number
}

/** What the canvas draws from a graph: stable order, appearances, recorded edges and inferred links. */
export interface NeuralModel {
  ids: string[]
  index: Map<string, number>
  nodes: KnowledgeNode[]
  /** Cleaned names. */
  names: string[]
  totals: number[]
  appearances: KnowledgeAppearance[]
  edges: NeuralEdge[]
  inferred: NeuralInferred[]
  /** True when the appearances came from the inferred result (else the live edge count). */
  measured: boolean
}

/** Creation order, then name, then id; never by updatedAt (agent writes must not reshuffle). */
export function orderNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  return [...nodes].sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function buildNeuralModel(graph: Pick<KnowledgeGraph, 'nodes' | 'edges'>, inferred: KnowledgeInferredResult | null, seed: string): NeuralModel {
  const nodes = orderNodes(graph.nodes)
  const index = new Map<string, number>()
  nodes.forEach((n, i) => index.set(n.id, i))
  const edges: NeuralEdge[] = []
  const live = new Array<number>(nodes.length).fill(0)
  for (const e of graph.edges) {
    const a = index.get(e.from)
    const b = index.get(e.to)
    if (a === undefined || b === undefined || a === b) continue
    // The bend is drawn from the edge id, so it stays when other edges come and go.
    const bend = (seedOf(`${seed}:${e.id}`) / 4294967296) * 2 - 1
    edges.push({ id: e.id, a, b, relation: e.relation, retired: !!e.retired || !!nodes[a].retired || !!nodes[b].retired, bend })
    if (!e.retired && !nodes[a].retired && !nodes[b].retired) {
      live[a]++
      live[b]++
    }
  }
  const appearances = nodes.map((n, i): KnowledgeAppearance => {
    const found = inferred && Object.hasOwn(inferred.appearances, n.id) ? inferred.appearances[n.id] : undefined
    if (found && Number.isFinite(found.total)) return found
    return { relations: live[i], mentions: 0, notes: 0, total: live[i] }
  })
  const links: NeuralInferred[] = []
  for (const l of inferred?.links ?? []) {
    const a = index.get(l.from)
    const b = index.get(l.to)
    if (a === undefined || b === undefined || a === b) continue
    links.push({ id: l.id, a, b, basis: l.basis, strength: l.strength })
  }
  return {
    ids: nodes.map((n) => n.id),
    index,
    nodes,
    names: nodes.map((n) => cleanLabel(n.name)),
    totals: appearances.map((a) => Math.max(0, a.total)),
    appearances,
    edges,
    inferred: links,
    measured: !!inferred
  }
}

/** Drawn flag per node: live nodes, plus retired ones when `showRetired`. */
export function drawnMask(model: Pick<NeuralModel, 'nodes'>, showRetired: boolean): Uint8Array {
  const out = new Uint8Array(model.nodes.length)
  model.nodes.forEach((n, i) => {
    out[i] = showRetired || !n.retired ? 1 : 0
  })
  return out
}

/** Whether an edge is drawn: both ends drawn, and a retired edge only with the retired switch. */
export const edgeDrawn = (e: NeuralEdge, drawn: Uint8Array, showRetired: boolean): boolean => drawn[e.a] === 1 && drawn[e.b] === 1 && (showRetired || !e.retired)

/** Recorded neighbours (distinct indexes) over the drawn edges. */
export function neighbourLists(model: Pick<NeuralModel, 'nodes' | 'edges'>, drawn: Uint8Array, showRetired: boolean): number[][] {
  const out: number[][] = model.nodes.map(() => [])
  for (const e of model.edges) {
    if (!edgeDrawn(e, drawn, showRetired)) continue
    if (!out[e.a].includes(e.b)) out[e.a].push(e.b)
    if (!out[e.b].includes(e.a)) out[e.b].push(e.a)
  }
  return out
}

// ---------------------------------------------------------------- emphasis

export interface Emphasis {
  /** Per node: 1 full, less when emphasis or the filter dims it (retired nodes are dimmed again when drawn). */
  alpha: Float32Array
  /** 1 for the active node and its recorded neighbours (names, active synapses). */
  near: Uint8Array
  /** 1 for drawn nodes that pass the filter and the search. */
  kept: Uint8Array
  /** The hovered or focused node, else the selected one; -1 for none. */
  active: number
  /** 'hover' (hover or keyboard focus), 'selected', or 'none'. */
  mode: 'hover' | 'selected' | 'none'
  /** A search query is set: kept nodes get a ring. */
  searching: boolean
  /** Number of kept nodes. */
  lit: number
}

export interface EmphasisInput {
  drawn: Uint8Array
  /** Passes the kind, origin and retired filters and the search (indexes into the model). */
  kept: Uint8Array
  nbrs: number[][]
  /** Hovered or focused node index, -1 for none. */
  hover: number
  selected: number
  searching: boolean
  /** The `--neural-dim-opacity` token. */
  dim: number
}

export const SECOND_HOP_HOVER = 0.6
export const SECOND_HOP_SELECTED = 0.75
export const REST_SELECTED = 0.55

/** Section 1.4 "Emphasis, strongest first": hover or focus, then selection, then search and filters. Filtered-out nodes stay dim. */
export function computeEmphasis(input: EmphasisInput): Emphasis {
  const n = input.drawn.length
  const alpha = new Float32Array(n)
  const near = new Uint8Array(n)
  const kept = new Uint8Array(n)
  let lit = 0
  for (let i = 0; i < n; i++) {
    kept[i] = input.drawn[i] === 1 && input.kept[i] === 1 ? 1 : 0
    lit += kept[i]
  }
  const hoverOk = input.hover >= 0 && input.hover < n && input.drawn[input.hover] === 1
  const selOk = input.selected >= 0 && input.selected < n && input.drawn[input.selected] === 1
  const active = hoverOk ? input.hover : selOk ? input.selected : -1
  const mode = active < 0 ? 'none' : hoverOk ? 'hover' : 'selected'
  if (active < 0) {
    for (let i = 0; i < n; i++) alpha[i] = kept[i] === 1 ? 1 : input.dim
    return { alpha, near, kept, active, mode, searching: input.searching, lit }
  }
  const level = new Uint8Array(n).fill(2)
  level[active] = 0
  near[active] = 1
  for (const j of input.nbrs[active]) {
    level[j] = 0
    near[j] = 1
  }
  for (const j of input.nbrs[active]) for (const k of input.nbrs[j]) if (level[k] === 2) level[k] = 1
  const hop2 = mode === 'hover' ? SECOND_HOP_HOVER : SECOND_HOP_SELECTED
  const rest = mode === 'hover' ? input.dim : REST_SELECTED
  for (let i = 0; i < n; i++) {
    const a = level[i] === 0 ? 1 : level[i] === 1 ? hop2 : rest
    alpha[i] = kept[i] === 1 ? a : Math.min(a, input.dim)
  }
  return { alpha, near, kept, active, mode, searching: input.searching, lit }
}

// ---------------------------------------------------------------- size

export const RADIUS_MIN = 6
export const RADIUS_MAX = 34
export const MIN_SCREEN_RADIUS = 3

/** World radius at zoom 1: 6 + 28 * log2(1 + total) / log2(1 + max(maxTotal, 16)), clamped to 6..34. */
export function neuralRadius(total: number, maxTotal: number): number {
  const t = Number.isFinite(total) ? Math.max(0, total) : 0
  const m = Math.max(Number.isFinite(maxTotal) ? maxTotal : 0, 16)
  const r = RADIUS_MIN + (28 * Math.log2(1 + t)) / Math.log2(1 + m)
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, r))
}

/** Radii of every node (world px) over the drawn ones' maximum total. */
export function radiiOf(totals: readonly number[], drawn?: Uint8Array): number[] {
  let max = 0
  for (let i = 0; i < totals.length; i++) if ((!drawn || drawn[i] === 1) && totals[i] > max) max = totals[i]
  return totals.map((t) => neuralRadius(t, max))
}

// ---------------------------------------------------------------- level of detail

export type Lod = 'full' | 'medium' | 'low'

export interface LodSpec {
  /** Nodes with a halo (largest first); Infinity = all. */
  halos: number
  curved: boolean
  /** Nodes that drift. */
  drift: number
  /** Ambient pulses at once. */
  ambient: number
  fps: number
}

export const LOD_SPECS: Record<Lod, LodSpec> = {
  full: { halos: Infinity, curved: true, drift: Infinity, ambient: 12, fps: 30 },
  medium: { halos: 100, curved: false, drift: 100, ambient: 8, fps: 30 },
  low: { halos: 0, curved: false, drift: 0, ambient: 4, fps: 20 }
}

/** The tier for the number of drawn nodes: up to 300 full, 301-800 medium, more low. */
export function lodFor(drawnNodes: number): Lod {
  return drawnNodes <= 300 ? 'full' : drawnNodes <= 800 ? 'medium' : 'low'
}

// ---------------------------------------------------------------- force layout

export const LAYOUT = { repulsion: -220, linkBase: 70, collisionPad: 10, gravity: 0.04, velocityDecay: 0.6, alphaDecay: 0.02, alphaMin: 0.02, maxTicks: 300, theta: 0.9, bhFrom: 200, placeTicks: 60, placeTicksLarge: 20 } as const

export interface LayoutState {
  ids: string[]
  x: Float64Array
  y: Float64Array
  vx: Float64Array
  vy: Float64Array
  /** Radii used for link length and collision. */
  r: Float64Array
  pinned: Uint8Array
  /** Flat pairs of node indexes. */
  links: Uint32Array
  degree: Uint16Array
  alpha: number
  ticks: number
  maxTicks: number
  settled: boolean
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

function linkArray(index: Map<string, number>, links: readonly (readonly [string, string])[]): Uint32Array {
  const flat: number[] = []
  const seen = new Set<number>()
  for (const [from, to] of links) {
    const a = index.get(from)
    const b = index.get(to)
    if (a === undefined || b === undefined || a === b) continue
    const key = a < b ? a * 4194304 + b : b * 4194304 + a
    if (seen.has(key)) continue
    seen.add(key)
    flat.push(a, b)
  }
  return Uint32Array.from(flat)
}

function degreeOf(n: number, links: Uint32Array): Uint16Array {
  const deg = new Uint16Array(n)
  for (let i = 0; i < links.length; i++) deg[links[i]]++
  return deg
}

export interface LayoutInput {
  ids: readonly string[]
  /** Pairs of ids joined by a recorded relation (duplicates and unknown ids are ignored). */
  links: readonly (readonly [string, string])[]
  /** One radius per id. */
  radii: readonly number[]
  /** The project id: every random draw comes from it. */
  seed: string
}

/** A phyllotaxis spiral in the given order (a seeded jitter keeps it from being exactly symmetric), alpha 1, not settled. */
export function initLayout(input: LayoutInput): LayoutState {
  const n = input.ids.length
  const index = new Map<string, number>()
  input.ids.forEach((id, i) => index.set(id, i))
  const rnd = prng(seedOf(`${input.seed}:layout`))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const rad = 26 * Math.sqrt(i + 0.5)
    const ang = i * GOLDEN_ANGLE
    x[i] = rad * Math.cos(ang) + (rnd() - 0.5) * 4
    y[i] = rad * Math.sin(ang) + (rnd() - 0.5) * 4
  }
  const links = linkArray(index, input.links)
  return { ids: [...input.ids], x, y, vx: new Float64Array(n), vy: new Float64Array(n), r: Float64Array.from(input.radii), pinned: new Uint8Array(n), links, degree: degreeOf(n, links), alpha: 1, ticks: 0, maxTicks: LAYOUT.maxTicks, settled: n === 0 }
}

/** A layout from stored positions: settled at once. Ids without a position start at the origin (use `placeNew`). */
export function layoutFromPositions(input: LayoutInput, positions: ReadonlyMap<string, { x: number; y: number }>): LayoutState {
  const s = initLayout(input)
  input.ids.forEach((id, i) => {
    const p = positions.get(id)
    if (p) {
      s.x[i] = p.x
      s.y[i] = p.y
    }
  })
  s.settled = true
  s.alpha = 0
  return s
}

// -- Barnes-Hut quadtree

interface QNode {
  x0: number
  y0: number
  x1: number
  y1: number
  mass: number
  cx: number
  cy: number
  kids: (QNode | null)[] | null
  pts: number[] | null
}

function buildTree(x: Float64Array, y: Float64Array): QNode | null {
  const n = x.length
  if (n === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    if (x[i] < x0) x0 = x[i]
    if (x[i] > x1) x1 = x[i]
    if (y[i] < y0) y0 = y[i]
    if (y[i] > y1) y1 = y[i]
  }
  const side = Math.max(x1 - x0, y1 - y0, 1) + 1
  const root: QNode = { x0, y0, x1: x0 + side, y1: y0 + side, mass: 0, cx: 0, cy: 0, kids: null, pts: [] }
  for (let i = 0; i < n; i++) insert(root, x, y, i, 0)
  accumulate(root, x, y)
  return root
}

function insert(node: QNode, x: Float64Array, y: Float64Array, i: number, depth: number): void {
  if (node.kids === null) {
    if (node.pts!.length === 0 || depth >= 22) {
      node.pts!.push(i)
      return
    }
    const old = node.pts!
    node.pts = null
    node.kids = [null, null, null, null]
    for (const j of old) insert(node, x, y, j, depth)
  }
  const mx = (node.x0 + node.x1) / 2
  const my = (node.y0 + node.y1) / 2
  const q = (x[i] >= mx ? 1 : 0) + (y[i] >= my ? 2 : 0)
  let kid = node.kids![q]
  if (!kid) {
    kid = { x0: q & 1 ? mx : node.x0, x1: q & 1 ? node.x1 : mx, y0: q & 2 ? my : node.y0, y1: q & 2 ? node.y1 : my, mass: 0, cx: 0, cy: 0, kids: null, pts: [] }
    node.kids![q] = kid
  }
  insert(kid, x, y, i, depth + 1)
}

function accumulate(node: QNode, x: Float64Array, y: Float64Array): void {
  if (node.kids === null) {
    let sx = 0
    let sy = 0
    for (const i of node.pts!) {
      sx += x[i]
      sy += y[i]
    }
    node.mass = node.pts!.length
    node.cx = sx / Math.max(1, node.mass)
    node.cy = sy / Math.max(1, node.mass)
    return
  }
  let m = 0
  let sx = 0
  let sy = 0
  for (const k of node.kids) {
    if (!k) continue
    accumulate(k, x, y)
    m += k.mass
    sx += k.cx * k.mass
    sy += k.cy * k.mass
  }
  node.mass = m
  node.cx = sx / Math.max(1, m)
  node.cy = sy / Math.max(1, m)
}

function jiggle(i: number, j: number): number {
  return (((i * 9301 + j * 49297 + 12345) % 233280) / 233280 - 0.5) * 1e-4
}

function repel(s: LayoutState, tree: QNode | null, i: number, alpha: number): void {
  if (!tree) return
  const xi = s.x[i]
  const yi = s.y[i]
  const strength = LAYOUT.repulsion * alpha
  const theta2 = LAYOUT.theta * LAYOUT.theta
  const stack: QNode[] = [tree]
  while (stack.length) {
    const q = stack.pop()!
    if (q.mass === 0) continue
    let dx = q.cx - xi
    let dy = q.cy - yi
    const w = q.x1 - q.x0
    let l = dx * dx + dy * dy
    if (q.kids !== null && (w * w) / theta2 >= l) {
      for (const k of q.kids) if (k) stack.push(k)
      continue
    }
    if (q.kids !== null) {
      if (l < 1) l = 1
      s.vx[i] += (dx * strength * q.mass) / l
      s.vy[i] += (dy * strength * q.mass) / l
      continue
    }
    for (const j of q.pts!) {
      if (j === i) continue
      dx = s.x[j] - xi
      dy = s.y[j] - yi
      if (dx === 0 && dy === 0) {
        dx = jiggle(i, j)
        dy = jiggle(j, i)
      }
      l = dx * dx + dy * dy
      if (l < 1) l = 1
      s.vx[i] += (dx * strength) / l
      s.vy[i] += (dy * strength) / l
    }
  }
}

function repelDirect(s: LayoutState, i: number, alpha: number): void {
  const strength = LAYOUT.repulsion * alpha
  const n = s.x.length
  for (let j = 0; j < n; j++) {
    if (j === i) continue
    let dx = s.x[j] - s.x[i]
    let dy = s.y[j] - s.y[i]
    if (dx === 0 && dy === 0) {
      dx = jiggle(i, j)
      dy = jiggle(j, i)
    }
    let l = dx * dx + dy * dy
    if (l < 1) l = 1
    s.vx[i] += (dx * strength) / l
    s.vy[i] += (dy * strength) / l
  }
}

function collide(s: LayoutState): void {
  const n = s.x.length
  if (n < 2) return
  let maxR = 0
  for (let i = 0; i < n; i++) if (s.r[i] > maxR) maxR = s.r[i]
  const cell = Math.max(20, 2 * maxR + LAYOUT.collisionPad)
  const grid = new Map<number, number[]>()
  const keyOf = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768)
  for (let i = 0; i < n; i++) {
    const k = keyOf(Math.floor(s.x[i] / cell), Math.floor(s.y[i] / cell))
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(s.x[i] / cell)
    const cy = Math.floor(s.y[i] / cell)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const list = grid.get(keyOf(cx + ox, cy + oy))
        if (!list) continue
        for (const j of list) {
          if (j <= i) continue
          if (s.pinned[i] === 1 && s.pinned[j] === 1) continue
          let dx = s.x[j] - s.x[i]
          let dy = s.y[j] - s.y[i]
          if (dx === 0 && dy === 0) {
            dx = jiggle(i, j)
            dy = jiggle(j, i)
          }
          const d = Math.sqrt(dx * dx + dy * dy)
          const min = s.r[i] + s.r[j] + LAYOUT.collisionPad
          if (d >= min) continue
          const push = ((min - d) / d) * 0.7
          dx *= push
          dy *= push
          const ri2 = s.r[i] * s.r[i]
          const rj2 = s.r[j] * s.r[j]
          const wj = rj2 / (ri2 + rj2)
          if (s.pinned[i] === 0) {
            s.vx[i] -= dx * (s.pinned[j] === 1 ? 1 : wj)
            s.vy[i] -= dy * (s.pinned[j] === 1 ? 1 : wj)
          }
          if (s.pinned[j] === 0) {
            s.vx[j] += dx * (s.pinned[i] === 1 ? 1 : 1 - wj)
            s.vy[j] += dy * (s.pinned[i] === 1 ? 1 : 1 - wj)
          }
        }
      }
    }
  }
}

/** One tick of the forces (links, repulsion, collision, gravity), then integration. */
function tick(s: LayoutState): void {
  const n = s.x.length
  const alpha = s.alpha
  // links
  for (let k = 0; k < s.links.length; k += 2) {
    const a = s.links[k]
    const b = s.links[k + 1]
    let dx = s.x[b] + s.vx[b] - s.x[a] - s.vx[a]
    let dy = s.y[b] + s.vy[b] - s.y[a] - s.vy[a]
    if (dx === 0 && dy === 0) {
      dx = jiggle(a, b)
      dy = jiggle(b, a)
    }
    const l = Math.sqrt(dx * dx + dy * dy)
    const want = LAYOUT.linkBase + s.r[a] + s.r[b]
    const strength = 1 / Math.max(1, Math.min(s.degree[a], s.degree[b]))
    const f = ((l - want) / l) * alpha * strength
    dx *= f
    dy *= f
    const bias = s.degree[a] / Math.max(1, s.degree[a] + s.degree[b])
    if (s.pinned[b] === 0) {
      s.vx[b] -= dx * bias
      s.vy[b] -= dy * bias
    }
    if (s.pinned[a] === 0) {
      s.vx[a] += dx * (1 - bias)
      s.vy[a] += dy * (1 - bias)
    }
  }
  // repulsion
  if (n > LAYOUT.bhFrom) {
    const tree = buildTree(s.x, s.y)
    for (let i = 0; i < n; i++) if (s.pinned[i] === 0) repel(s, tree, i, alpha)
  } else {
    for (let i = 0; i < n; i++) if (s.pinned[i] === 0) repelDirect(s, i, alpha)
  }
  collide(s)
  // gravity and integration
  const keep = 1 - LAYOUT.velocityDecay
  for (let i = 0; i < n; i++) {
    if (s.pinned[i] === 1) {
      s.vx[i] = 0
      s.vy[i] = 0
      continue
    }
    s.vx[i] -= s.x[i] * LAYOUT.gravity * alpha
    s.vy[i] -= s.y[i] * LAYOUT.gravity * alpha
    s.vx[i] *= keep
    s.vy[i] *= keep
    s.x[i] += s.vx[i]
    s.y[i] += s.vy[i]
  }
  s.alpha += (0 - s.alpha) * LAYOUT.alphaDecay
  s.ticks++
  if (s.alpha < LAYOUT.alphaMin || s.ticks >= s.maxTicks) s.settled = true
}

/**
 * Runs ticks until the layout settles or `budgetMs` of wall time is used (default 8 ms; Infinity runs to the end). The
 * tick count never depends on the clock, so the same graph and seed always settle on the same positions. Returns the
 * number of ticks run.
 */
export function stepLayout(s: LayoutState, budgetMs = 8, now: () => number = () => performance.now()): number {
  if (s.settled) return 0
  const start = now()
  let run = 0
  do {
    tick(s)
    run++
  } while (!s.settled && (budgetMs === Infinity || now() - start < budgetMs))
  return run
}

export interface PlaceInput {
  id: string
  /** Radius (world px). */
  r: number
}

/**
 * Adds new nodes to a layout: each starts at the centroid of its already placed neighbours plus a seeded 24-unit offset
 * (no neighbour: the layout's rim), then 60 ticks run with every existing node pinned, so nothing else moves. Returns a
 * new settled state; existing positions are copied unchanged.
 */
export function placeNew(prev: LayoutState, adds: readonly PlaceInput[], links: readonly (readonly [string, string])[], seed: string): LayoutState {
  if (adds.length === 0) return prev
  const n0 = prev.ids.length
  const n = n0 + adds.length
  const ids = [...prev.ids, ...adds.map((a) => a.id)]
  const index = new Map<string, number>()
  ids.forEach((id, i) => index.set(id, i))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const r = new Float64Array(n)
  x.set(prev.x)
  y.set(prev.y)
  r.set(prev.r)
  adds.forEach((a, k) => {
    r[n0 + k] = a.r
  })
  const flat = linkArray(index, links)
  // placement
  let cx = 0
  let cy = 0
  for (let i = 0; i < n0; i++) {
    cx += prev.x[i]
    cy += prev.y[i]
  }
  if (n0 > 0) {
    cx /= n0
    cy /= n0
  }
  let rim = 0
  for (let i = 0; i < n0; i++) rim = Math.max(rim, Math.hypot(prev.x[i] - cx, prev.y[i] - cy) + prev.r[i])
  const rnd = prng(seedOf(`${seed}:place:${n0}`))
  for (let k = 0; k < adds.length; k++) {
    const i = n0 + k
    let sx = 0
    let sy = 0
    let count = 0
    for (let p = 0; p < flat.length; p += 2) {
      const a = flat[p]
      const b = flat[p + 1]
      const other = a === i ? b : b === i ? a : -1
      if (other < 0 || other >= i) continue
      sx += x[other]
      sy += y[other]
      count++
    }
    const ang = rnd() * Math.PI * 2
    if (count > 0) {
      x[i] = sx / count + Math.cos(ang) * 24
      y[i] = sy / count + Math.sin(ang) * 24
    } else {
      const d = rim + adds[k].r + 40
      x[i] = cx + Math.cos(ang) * d
      y[i] = cy + Math.sin(ang) * d
    }
  }
  const pinned = new Uint8Array(n)
  for (let i = 0; i < n0; i++) pinned[i] = 1
  const s: LayoutState = { ids, x, y, vx: new Float64Array(n), vy: new Float64Array(n), r, pinned, links: flat, degree: degreeOf(n, flat), alpha: 1, ticks: 0, maxTicks: n > 800 ? LAYOUT.placeTicksLarge : LAYOUT.placeTicks, settled: false }
  while (!s.settled) tick(s)
  s.pinned = new Uint8Array(n)
  s.alpha = 0
  s.ticks = 0
  s.maxTicks = LAYOUT.maxTicks
  s.vx.fill(0)
  s.vy.fill(0)
  return s
}

/** The layout's positions by id. */
export function positionsOf(s: LayoutState): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  s.ids.forEach((id, i) => out.set(id, { x: s.x[i], y: s.y[i] }))
  return out
}

// ---------------------------------------------------------------- stored layout

export const STORED_LAYOUT_MAX = 5000
const COORD_LIMIT = 1_000_000

export const layoutKey = (projectId: string): string => `orgai.knowledgeLayout.${projectId}`

/** The text stored for a settled layout: ids and whole-number coordinates only. */
export function serializeLayout(positions: ReadonlyMap<string, { x: number; y: number }>): string {
  const out: Record<string, [number, number]> = {}
  let n = 0
  for (const [id, p] of positions) {
    if (!KNOWLEDGE_ID_RE.test(id) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    if (n++ >= STORED_LAYOUT_MAX) break
    out[id] = [Math.round(p.x), Math.round(p.y)]
  }
  return JSON.stringify(out)
}

/** Parses stored text: valid ids with two finite whole numbers survive, everything else is ignored. */
export function parseStoredLayout(raw: string | null | undefined): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (typeof raw !== 'string' || raw.length > 2_000_000) return out
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return out
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (out.size >= STORED_LAYOUT_MAX) break
    if (!KNOWLEDGE_ID_RE.test(id) || !Array.isArray(v) || v.length !== 2) continue
    const [x, y] = v
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT) continue
    out.set(id, { x: Math.round(x), y: Math.round(y) })
  }
  return out
}

// ---------------------------------------------------------------- view

export interface View {
  /** Screen = world * k + (x, y). */
  x: number
  y: number
  k: number
}

export const ZOOM_MIN = 0.15
export const ZOOM_MAX = 3
export const FIT_PADDING = 48
export const FIT_ZOOM_MAX = 1.4

export const clampZoom = (k: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(k) ? k : 1))

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The box around discs (world). Null when there are none. */
export function boundsOf(points: readonly { x: number; y: number; r: number }[]): Box | null {
  if (points.length === 0) return null
  const b: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const p of points) {
    b.x0 = Math.min(b.x0, p.x - p.r)
    b.y0 = Math.min(b.y0, p.y - p.r)
    b.x1 = Math.max(b.x1, p.x + p.r)
    b.y1 = Math.max(b.y1, p.y + p.r)
  }
  return b
}

/** The view that fits `box` in the stage with 48 px of padding and zoom 1.4 at most (centred). */
export function fitView(box: Box | null, stage: { w: number; h: number }, pad = FIT_PADDING, maxZoom = FIT_ZOOM_MAX): View {
  if (!box || stage.w <= 0 || stage.h <= 0) return { x: stage.w / 2, y: stage.h / 2, k: 1 }
  const bw = Math.max(1, box.x1 - box.x0)
  const bh = Math.max(1, box.y1 - box.y0)
  const k = clampZoom(Math.min(maxZoom, Math.max(1, stage.w - 2 * pad) / bw, Math.max(1, stage.h - 2 * pad) / bh))
  return { k, x: stage.w / 2 - ((box.x0 + box.x1) / 2) * k, y: stage.h / 2 - ((box.y0 + box.y1) / 2) * k }
}

/** Zoom to `k` keeping the world point under screen point (sx, sy) where it is. */
export function zoomAt(view: View, k: number, sx: number, sy: number): View {
  const nk = clampZoom(k)
  const wx = (sx - view.x) / view.k
  const wy = (sy - view.y) / view.k
  return { k: nk, x: sx - wx * nk, y: sy - wy * nk }
}

/** The smallest pan that keeps a disc (screen) `margin` px inside the stage; the view is returned as is when it already is. */
export function panIntoView(view: View, node: { x: number; y: number; r: number }, stage: { w: number; h: number }, margin = FIT_PADDING): View {
  const sx = node.x * view.k + view.x
  const sy = node.y * view.k + view.y
  const rr = Math.max(node.r * view.k, MIN_SCREEN_RADIUS)
  const m = Math.min(margin, Math.max(0, stage.w / 2 - rr - 1), Math.max(0, stage.h / 2 - rr - 1))
  let dx = 0
  let dy = 0
  if (sx - rr < m) dx = m - (sx - rr)
  else if (sx + rr > stage.w - m) dx = stage.w - m - (sx + rr)
  if (sy - rr < m) dy = m - (sy - rr)
  else if (sy + rr > stage.h - m) dy = stage.h - m - (sy + rr)
  return dx === 0 && dy === 0 ? view : { ...view, x: view.x + dx, y: view.y + dy }
}

export const screenOf = (view: View, wx: number, wy: number): { x: number; y: number } => ({ x: wx * view.k + view.x, y: wy * view.k + view.y })

// ---------------------------------------------------------------- names at rest

/** How many names rest on the stage: floor(area / 40,000) between 4 and 28; 60 at zoom 1.6 or above. */
export function labelBudget(stage: { w: number; h: number }, zoom: number): number {
  if (zoom >= 1.6) return 60
  return Math.min(28, Math.max(4, Math.floor((stage.w * stage.h) / 40000)))
}

export interface LabelCandidate {
  id: string
  /** Screen position and radius. */
  x: number
  y: number
  r: number
  total: number
  /** Creation order. */
  order: number
  /** The text to draw (already cleaned and cut). */
  text: string
  /** Only an obstacle: no name unless it is in `must` or `priority` (dimmed nodes). */
  quiet?: boolean
}

export interface PlacedLabel {
  id: string
  /** Top-left of the box. */
  x: number
  y: number
  w: number
  h: number
  text: string
}

export const LABEL_HEIGHT = 14
const LABEL_PAD = 4

const rectsTouch = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad: number): boolean =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad

function circleHitsRect(cx: number, cy: number, r: number, b: { x: number; y: number; w: number; h: number }, pad: number): boolean {
  const nx = Math.max(b.x - pad, Math.min(cx, b.x + b.w + pad))
  const ny = Math.max(b.y - pad, Math.min(cy, b.y + b.h + pad))
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r
}

/**
 * Chooses the names to draw under their nodes. `must` ids (hovered, selected) are always tried first and are not
 * counted; `priority` ids (search matches, active neighbours) follow, then the rest by total descending and creation
 * order, until the budget is used. A name is skipped when its box plus 4 px hits a placed name or a larger node, or when
 * the node is off the stage.
 */
export function pickLabels(input: {
  candidates: readonly LabelCandidate[]
  stage: { w: number; h: number }
  zoom: number
  measure: (text: string) => number
  must?: readonly string[]
  priority?: readonly string[]
}): PlacedLabel[] {
  const { candidates, stage, measure } = input
  const budget = labelBudget(stage, input.zoom)
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const ordered: { c: LabelCandidate; must: boolean }[] = []
  const used = new Set<string>()
  const take = (id: string, must: boolean): void => {
    const c = byId.get(id)
    if (!c || used.has(id)) return
    used.add(id)
    ordered.push({ c, must })
  }
  for (const id of input.must ?? []) take(id, true)
  for (const id of input.priority ?? []) take(id, false)
  const rest = candidates.filter((c) => !used.has(c.id) && !c.quiet).sort((a, b) => b.total - a.total || a.order - b.order)
  for (const c of rest) ordered.push({ c, must: false })
  const placed: PlacedLabel[] = []
  let counted = 0
  for (const { c, must } of ordered) {
    if (!must && counted >= budget) break
    if (c.x + c.r < 0 || c.x - c.r > stage.w || c.y + c.r < 0 || c.y - c.r > stage.h) continue
    const w = Math.ceil(measure(c.text))
    let x = c.x - w / 2
    x = Math.max(2, Math.min(x, stage.w - w - 2))
    const y = c.y + c.r + 3
    if (y + LABEL_HEIGHT > stage.h) continue
    const box = { x, y, w, h: LABEL_HEIGHT }
    if (placed.some((p) => rectsTouch(p, box, LABEL_PAD))) continue
    let blocked = false
    for (const o of candidates) {
      if (o.id === c.id) continue
      // A larger node keeps 4 px of air. A smaller one may sit under the name (the name's stroke keeps it readable), or a hub in a cluster would never carry its name.
      if (o.r > c.r && circleHitsRect(o.x, o.y, o.r, box, LABEL_PAD)) {
        blocked = true
        break
      }
    }
    if (blocked) continue
    placed.push({ id: c.id, ...box, text: c.text })
    if (!must) counted++
  }
  return placed
}

// ---------------------------------------------------------------- keyboard

export type Direction = 'up' | 'down' | 'left' | 'right'

const VEC: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

export interface Spot {
  id: string
  x: number
  y: number
}

/** The nearest spot inside the 90-degree cone around `dir`; null when the cone is empty. Ties break by id. */
export function spatialTarget(from: { x: number; y: number }, spots: readonly Spot[], dir: Direction): string | null {
  const [ux, uy] = VEC[dir]
  let best: Spot | null = null
  let bestD = Infinity
  for (const s of spots) {
    const dx = s.x - from.x
    const dy = s.y - from.y
    const along = dx * ux + dy * uy
    const across = Math.abs(dx * uy - dy * ux)
    if (along <= 0 || across > along) continue
    const d = Math.hypot(dx, dy)
    if (d < bestD || (d === bestD && best && s.id < best.id)) {
      best = s
      bestD = d
    }
  }
  return best ? best.id : null
}

/** Ctrl/Cmd + arrow among neighbours: the cone first; an empty cone takes the nearest neighbour by angle, so a hub works in every direction. */
export function neighbourTarget(from: { x: number; y: number }, spots: readonly Spot[], dir: Direction): string | null {
  if (spots.length === 0) return null
  const inCone = spatialTarget(from, spots, dir)
  if (inCone) return inCone
  const [ux, uy] = VEC[dir]
  let best: Spot | null = null
  let bestAngle = Infinity
  let bestD = Infinity
  for (const s of spots) {
    const dx = s.x - from.x
    const dy = s.y - from.y
    const d = Math.hypot(dx, dy)
    const angle = d === 0 ? Math.PI : Math.acos(Math.max(-1, Math.min(1, (dx * ux + dy * uy) / d)))
    if (angle < bestAngle - 1e-9 || (Math.abs(angle - bestAngle) <= 1e-9 && (d < bestD || (d === bestD && best && s.id < best.id)))) {
      best = s
      bestAngle = angle
      bestD = d
    }
  }
  return best ? best.id : null
}

export interface NamedSpot {
  id: string
  /** Lower-case cleaned name. */
  name: string
  total: number
  order: number
}

/** Type-ahead: the largest node whose name starts with the typed letters (no regular expression is built from them). */
export function typeAheadTarget(typed: string, spots: readonly NamedSpot[]): string | null {
  const want = typed.toLowerCase()
  if (!want) return null
  let best: NamedSpot | null = null
  for (const s of spots) {
    if (!s.name.startsWith(want)) continue
    if (!best || s.total > best.total || (s.total === best.total && s.order < best.order)) best = s
  }
  return best ? best.id : null
}

/** The largest (by total, then creation order) and smallest of a set of spots, for Home and End. */
export function extremeNode(spots: readonly NamedSpot[], which: 'largest' | 'smallest'): string | null {
  let best: NamedSpot | null = null
  for (const s of spots) {
    if (!best) {
      best = s
      continue
    }
    if (which === 'largest' ? s.total > best.total || (s.total === best.total && s.order < best.order) : s.total < best.total || (s.total === best.total && s.order > best.order)) best = s
  }
  return best ? best.id : null
}

// ---------------------------------------------------------------- card

export const CARD_WIDTH = 280
export const CARD_MAX_HEIGHT = 240
export const CARD_GAP = 12
export const CARD_MARGIN = 8

export interface CardPlacement {
  left: number
  top: number
  side: 'right' | 'left' | 'below' | 'above'
  /** The card's height may not exceed this (a tight stage shortens it). */
  maxHeight: number
}

/**
 * Where the card goes: right of the node with a 12 px gap, then left, below, above; 8 px inside the stage; never over
 * the disc. When no side fits at full height the roomier vertical side is taken and the card is told to shorten.
 */
export function cardPlacement(node: { x: number; y: number; r: number }, card: { w: number; h: number }, stage: { w: number; h: number }, gap = CARD_GAP, margin = CARD_MARGIN): CardPlacement {
  const { x, y, r } = node
  const clampY = (top: number, h: number): number => Math.max(margin, Math.min(top, stage.h - margin - h))
  const clampX = (left: number, w: number): number => Math.max(margin, Math.min(left, stage.w - margin - w))
  const sideMax = Math.max(40, stage.h - 2 * margin)
  const h = Math.min(card.h, sideMax)
  const right = x + r + gap
  if (right + card.w <= stage.w - margin) return { left: right, top: clampY(y - h / 2, h), side: 'right', maxHeight: sideMax }
  const left = x - r - gap - card.w
  if (left >= margin) return { left, top: clampY(y - h / 2, h), side: 'left', maxHeight: sideMax }
  const below = y + r + gap
  if (below + card.h <= stage.h - margin) return { left: clampX(x - card.w / 2, card.w), top: below, side: 'below', maxHeight: stage.h - margin - below }
  const above = y - r - gap - card.h
  if (above >= margin) return { left: clampX(x - card.w / 2, card.w), top: above, side: 'above', maxHeight: y - r - gap - margin }
  const roomBelow = stage.h - margin - below
  const roomAbove = y - r - gap - margin
  if (roomBelow >= roomAbove) return { left: clampX(x - card.w / 2, card.w), top: below, side: 'below', maxHeight: Math.max(0, roomBelow) }
  const maxH = Math.max(0, roomAbove)
  return { left: clampX(x - card.w / 2, card.w), top: Math.max(margin, y - r - gap - Math.min(card.h, maxH)), side: 'above', maxHeight: maxH }
}

/** "Comes up 14 times: 9 relations, 4 mentions, 1 note." Zero parts left out; "once"; nothing: "Not connected to anything yet." */
export function comesUpLine(a: Pick<KnowledgeAppearance, 'relations' | 'mentions' | 'notes' | 'total'>): string {
  if (!(a.total > 0)) return 'Not connected to anything yet.'
  const parts: string[] = []
  if (a.relations > 0) parts.push(plural(a.relations, 'relation', 'relations'))
  if (a.mentions > 0) parts.push(plural(a.mentions, 'mention', 'mentions'))
  if (a.notes > 0) parts.push(plural(a.notes, 'note', 'notes'))
  const head = a.total === 1 ? 'Comes up once' : `Comes up ${a.total} times`
  return parts.length ? `${head}: ${parts.join(', ')}.` : `${head}.`
}

/** The card's excerpt: the summary, else the first live fact, on one line. */
export function cardExcerpt(node: Pick<KnowledgeNode, 'summary' | 'facts'>): string {
  const summary = cleanLabel(node.summary)
  if (summary) return summary
  const fact = node.facts.find((f) => !f.retired)
  return cleanLabel(fact?.text)
}

export interface RelationRow {
  edgeId: string
  /** The other node's index. */
  other: number
  outgoing: boolean
  /** "works at Acme Corp" / "Jane Doe works at this". */
  text: string
}

/** The drawn relations of a node, ordered by the neighbour's total (largest first), then creation order of the edge. */
export function relationRows(model: Pick<NeuralModel, 'edges' | 'names' | 'totals'>, node: number, drawn: Uint8Array, showRetired: boolean): RelationRow[] {
  const rows: RelationRow[] = []
  for (const e of model.edges) {
    if (e.a !== node && e.b !== node) continue
    if (!edgeDrawn(e, drawn, showRetired)) continue
    const outgoing = e.a === node
    const other = outgoing ? e.b : e.a
    const word = keyWords(e.relation)
    rows.push({ edgeId: e.id, other, outgoing, text: outgoing ? `${word} ${model.names[other]}` : `${model.names[other]} ${word} this` })
  }
  return rows.sort((p, q) => model.totals[q.other] - model.totals[p.other] || p.other - q.other)
}

/** The card's relation lines: up to `max` rows, then "and 6 more relations". */
export function topRelationLines(rows: readonly RelationRow[], max = 3): { lines: string[]; more: string | null } {
  const lines = rows.slice(0, max).map((r) => r.text)
  const left = rows.length - lines.length
  return { lines, more: left > 0 ? `and ${plural(left, 'more relation', 'more relations')}` : null }
}

/**
 * Section 2.3: "Also works at Acme Corp: Tom Okafor, Mara Lindqvist and 6 more." The largest neighbour reached through a
 * recorded relation that another item shares in the same direction. Outgoing shares read "Also <relation> <target>:
 * <others>."; incoming ones (this item is the target) read "<source> also <relation> <others>." Null when nothing is shared.
 */
export function sharedNeighbourLine(model: Pick<NeuralModel, 'edges' | 'names' | 'totals'>, node: number, drawn: Uint8Array, showRetired: boolean): string | null {
  type Group = { other: number; relation: string; outgoing: boolean; sharers: Set<number> }
  const groups = new Map<string, Group>()
  const mine = model.edges.filter((e) => (e.a === node || e.b === node) && edgeDrawn(e, drawn, showRetired))
  if (mine.length === 0) return null
  for (const e of mine) {
    const outgoing = e.a === node
    const other = outgoing ? e.b : e.a
    groups.set(`${outgoing ? 'o' : 'i'}|${e.relation}|${other}`, { other, relation: e.relation, outgoing, sharers: new Set() })
  }
  for (const e of model.edges) {
    if (!edgeDrawn(e, drawn, showRetired)) continue
    // Same direction: another item with the same relation to the same target (outgoing) or from the same source (incoming).
    const og = groups.get(`o|${e.relation}|${e.b}`)
    if (og && e.a !== node && e.a !== og.other) og.sharers.add(e.a)
    const ig = groups.get(`i|${e.relation}|${e.a}`)
    if (ig && e.b !== node && e.b !== ig.other) ig.sharers.add(e.b)
  }
  let best: Group | null = null
  for (const g of groups.values()) {
    if (g.sharers.size === 0) continue
    if (!best || model.totals[g.other] > model.totals[best.other] || (model.totals[g.other] === model.totals[best.other] && (g.sharers.size > best.sharers.size || (g.sharers.size === best.sharers.size && g.other < best.other)))) best = g
  }
  if (!best) return null
  const sharers = [...best.sharers].sort((p, q) => model.totals[q] - model.totals[p] || p - q)
  const names = sharers.map((i) => model.names[i])
  const list = names.length <= 3 ? (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  const word = keyWords(best.relation)
  return best.outgoing ? `Also ${word} ${model.names[best.other]}: ${list}.` : `${model.names[best.other]} also ${word}: ${list}.`
}

/**
 * The option's spoken name (section 1.8): "Acme Corp, organisation. Comes up 14 times: 9 relations, 4 mentions, 1 note.
 * Top relations: Jane Doe works at this, owns Billing platform. Press Enter to open." Retired adds ", retired".
 */
export function spokenName(input: { name: string; kind: string; retired: boolean; appearance: KnowledgeAppearance; relations: readonly string[] }): string {
  const kind = cleanLabel(kindLabel(input.kind)).toLowerCase()
  const head = `${input.name}, ${kind}${input.retired ? ', retired' : ''}.`
  const rel = input.relations.length ? ` Top relations: ${input.relations.join(', ')}.` : ''
  return `${head} ${comesUpLine(input.appearance)}${rel} Press Enter to open.`
}

// ---------------------------------------------------------------- recall bursts

export const RECALL_BURST_MS = 2000
export const RECALL_IDS_MAX = 12

/** One burst per 2 s per run; ids that arrive between bursts merge into the next (newest 12 kept). */
export class RecallGate {
  private last = new Map<string, number>()
  private pending = new Map<string, string[]>()

  /** Returns the ids to fire now, or the delay until the merged burst may fire. */
  push(runId: string, ids: readonly string[], now: number): { fire: string[] } | { wait: number } {
    const merged = [...(this.pending.get(runId) ?? []), ...ids]
    const last = this.last.get(runId)
    if (last === undefined || now - last >= RECALL_BURST_MS) {
      this.pending.delete(runId)
      this.last.set(runId, now)
      return { fire: newestIds(merged) }
    }
    this.pending.set(runId, merged)
    return { wait: last + RECALL_BURST_MS - now }
  }

  /** The merged burst of a run whose wait is over (empty when nothing is pending). */
  flush(runId: string, now: number): string[] {
    const merged = this.pending.get(runId)
    this.pending.delete(runId)
    if (!merged || merged.length === 0) return []
    this.last.set(runId, now)
    return newestIds(merged)
  }
}

/** Distinct ids, the newest `RECALL_IDS_MAX`, in arrival order. */
export function newestIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = ids.length - 1; i >= 0; i--) {
    if (seen.has(ids[i])) continue
    seen.add(ids[i])
    out.unshift(ids[i])
    if (out.length >= RECALL_IDS_MAX) break
  }
  return out
}

// ---------------------------------------------------------------- node colour

/** `data-id` / `data-kind` are written only after these checks. */
export const safeNodeId = (id: string): string | undefined => (KNOWLEDGE_ID_RE.test(id) ? id : undefined)
