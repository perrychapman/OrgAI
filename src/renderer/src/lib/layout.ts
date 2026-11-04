import dagre from '@dagrejs/dagre'
import type { CanvasLayout } from '@shared/types'

export interface LayoutItem {
  id: string
  parentId: string | null
  width: number
  height: number
}

/**
 * Parent map with unknown parents and cycles removed: a role whose reportsTo chain loops back on itself is detached
 * (treated as a root) so dagre never sees a cycle.
 */
export function acyclicParents(items: LayoutItem[]): Map<string, string> {
  const ids = new Set(items.map((i) => i.id))
  const parents = new Map<string, string>()
  for (const item of items) if (item.parentId && item.parentId !== item.id && ids.has(item.parentId)) parents.set(item.id, item.parentId)
  for (const item of items) {
    const seen = new Set<string>([item.id])
    let cur = item.id
    for (;;) {
      const next = parents.get(cur)
      if (!next) break
      if (seen.has(next)) {
        parents.delete(cur)
        break
      }
      seen.add(next)
      cur = next
    }
  }
  return parents
}

/** Ring guides of the radial layout, in flow coordinates (CanvasBackdrop draws them). */
export interface RingGuides {
  cx: number
  cy: number
  radii: number[]
}

export interface CanvasLayoutResult {
  /** Top-left positions keyed by id. */
  positions: Record<string, { x: number; y: number }>
  /** Only for the radial layout. */
  rings?: RingGuides
}

/**
 * Radial layout (docs/design/canvas-themes.md section 3): root centre at (0, 0), depth d on ring d, children within
 * their parent's angular sector.
 *
 * Several roots: the first root (input order) is the centre and every other root is treated as its child, so it
 * sits on ring 1. Ring radius is max(previous + ringStep, n * (widest node + gap) / 2PI) so a full ring never
 * overlaps. Sectors start at 12 o'clock and run clockwise; a child's share is proportional to its leaf count.
 * Positions are top-left (centre minus half size). `rings` are the guides (centre (0, 0), radii of depths 1..n).
 */
export function radialLayout(items: LayoutItem[], opts?: { ringStep?: number; gap?: number; packed?: boolean }): CanvasLayoutResult {
  const rings: RingGuides = { cx: 0, cy: 0, radii: [] }
  if (items.length === 0) return { positions: {}, rings }
  const step = opts?.ringStep ?? 300
  const gap = opts?.gap ?? 24
  const parents = acyclicParents(items)
  const roots = items.filter((i) => !parents.has(i.id))
  const centre = roots[0] ?? items[0]
  const kids = new Map<string, LayoutItem[]>()
  for (const item of items) {
    if (item === centre) continue
    const pid = parents.get(item.id) ?? centre.id
    const list = kids.get(pid)
    if (list) list.push(item)
    else kids.set(pid, [item])
  }
  const leaves = new Map<string, number>()
  const countLeaves = (item: LayoutItem): number => {
    const c = kids.get(item.id)
    const n = c && c.length > 0 ? c.reduce((s, k) => s + countLeaves(k), 0) : 1
    leaves.set(item.id, n)
    return n
  }
  countLeaves(centre)
  // Depth, sector and angle per node.
  const depthOf = new Map<string, number>()
  const angleOf = new Map<string, number>()
  const byDepth: LayoutItem[][] = []
  const place = (item: LayoutItem, depth: number, a0: number, a1: number): void => {
    depthOf.set(item.id, depth)
    angleOf.set(item.id, (a0 + a1) / 2)
    ;(byDepth[depth] ??= []).push(item)
    const c = kids.get(item.id) ?? []
    const total = leaves.get(item.id) ?? 1
    let at = a0
    for (const k of c) {
      const share = ((a1 - a0) * (leaves.get(k.id) ?? 1)) / total
      place(k, depth + 1, at, at + share)
      at += share
    }
  }
  place(centre, 0, 0, 2 * Math.PI)
  const radius: number[] = [0]
  for (let d = 1; d < byDepth.length; d++) {
    const row = byDepth[d]
    const widest = Math.max(...row.map((i) => i.width))
    radius[d] = opts?.packed ? radius[d - 1] + step : Math.max(radius[d - 1] + step, (row.length * (widest + gap)) / (2 * Math.PI))
    rings.radii.push(radius[d])
  }
  const positions: Record<string, { x: number; y: number }> = {}
  for (const item of items) {
    const d = depthOf.get(item.id) ?? 0
    const r = radius[d] ?? 0
    const a = angleOf.get(item.id) ?? 0
    positions[item.id] = { x: r * Math.sin(a) - item.width / 2, y: -r * Math.cos(a) - item.height / 2 }
  }
  return { positions, rings }
}

export interface HoneycombOptions {
  /** Hex tile box (flat-top hexagon). */
  width: number
  height: number
  /** Space between neighbouring cells. */
  gap: number
}

const HONEYCOMB_TIE = 2

/** Centre of lattice cell (col, row): see `honeycombSnap` for the convention. */
export function honeycombCell(col: number, row: number, o: HoneycombOptions): { x: number; y: number } {
  const dy = o.height + o.gap
  const dx = 0.75 * o.width + o.gap * Math.cos(Math.PI / 6)
  return { x: col * dx, y: row * dy + (Math.abs(col) % 2 === 1 ? dy / 2 : 0) }
}

/**
 * Snaps a radial result to a honeycomb (docs/design/canvas-themes.md hex style). Flat-top lattice: column step
 * dx = 0.75 * width + gap * cos 30deg, row step dy = height + gap, odd columns (by absolute index) shifted DOWN by dy / 2,
 * so cell (0, 0) is the radial centre and its six neighbours are (0, +-1), (+-1, 0) and (+-1, -1), all about dy away.
 * Nodes are placed root first, then by distance from the centre (depth), then clockwise from 12 o'clock (the radial
 * order), each on the nearest free cell to where the radial layout put it. Positions are top-left; no `rings`.
 */
export function honeycombSnap(result: CanvasLayoutResult, items: LayoutItem[], opts: HoneycombOptions): CanvasLayoutResult {
  const dy = opts.height + opts.gap
  const dx = 0.75 * opts.width + opts.gap * Math.cos(Math.PI / 6)
  const size = new Map(items.map((i) => [i.id, i]))
  const nodes = items
    .filter((i) => result.positions[i.id])
    .map((i) => {
      const p = result.positions[i.id]
      const x = p.x + i.width / 2
      const y = p.y + i.height / 2
      const angle = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI)
      return { id: i.id, x, y, dist: Math.round(Math.hypot(x, y) * 100) / 100, angle: Math.round(angle * 1e6) / 1e6 }
    })
    .sort((a, b) => a.dist - b.dist || a.angle - b.angle || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const taken = new Set<string>()
  const positions: Record<string, { x: number; y: number }> = {}
  for (const n of nodes) {
    const c0 = Math.round(n.x / dx)
    const r0 = Math.round(n.y / dy)
    let best = null as { col: number; row: number; d: number; turn: number } | null
    for (let k = 1; k <= 400; k++) {
      for (let col = c0 - k; col <= c0 + k; col++) {
        for (let row = r0 - k; row <= r0 + k; row++) {
          if (taken.has(`${col},${row}`)) continue
          const c = honeycombCell(col, row, opts)
          const d = Math.hypot(c.x - n.x, c.y - n.y)
          // Cells within TIE px of each other count as equally near; then the one next clockwise from the node's own
          // angle wins, so a full ring of sector-centred nodes rotates onto its cells instead of colliding.
          const turn = (((Math.atan2(c.x, -c.y) - Math.atan2(n.x, -n.y)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
          const better =
            !best ||
            d < best.d - HONEYCOMB_TIE ||
            (Math.abs(d - best.d) <= HONEYCOMB_TIE && (turn < best.turn - 1e-9 || (Math.abs(turn - best.turn) <= 1e-9 && (col < best.col || (col === best.col && row < best.row)))))
          if (better) best = { col, row, d, turn }
        }
      }
      if (best && best.d <= k * dx) break
    }
    if (!best) continue
    taken.add(`${best.col},${best.row}`)
    const c = honeycombCell(best.col, best.row, opts)
    const it = size.get(n.id)
    positions[n.id] = { x: c.x - (it?.width ?? 0) / 2, y: c.y - (it?.height ?? 0) / 2 }
  }
  return { positions }
}

/**
 * The one entry point every canvas uses: the layout setting picks tree TB, tree LR or radial. `honeycomb` applies to
 * the radial layout only (hex node style): the result is snapped to a honeycomb and has no rings.
 */
export function layoutCanvas(
  layout: CanvasLayout,
  items: LayoutItem[],
  opts?: { nodesep?: number; ranksep?: number; ringStep?: number; honeycomb?: HoneycombOptions }
): CanvasLayoutResult {
  if (layout === 'radial') {
    // `packed` keeps ring d at d * ringStep (no circumference growth): the lattice resolves crowding itself.
    const radial = radialLayout(items, { ringStep: opts?.ringStep, packed: !!opts?.honeycomb })
    return opts?.honeycomb ? honeycombSnap(radial, items, opts.honeycomb) : radial
  }
  return { positions: treeLayout(items, { nodesep: opts?.nodesep, ranksep: opts?.ranksep, rankdir: layout === 'left-right' ? 'LR' : 'TB' }) }
}

/** Tree layout, top-down ('TB', default) or left to right ('LR'). Returns top-left positions keyed by id. */
export function treeLayout(items: LayoutItem[], opts?: { nodesep?: number; ranksep?: number; rankdir?: 'TB' | 'LR' }): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: opts?.rankdir ?? 'TB', nodesep: opts?.nodesep ?? 48, ranksep: opts?.ranksep ?? 96, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  const parents = acyclicParents(items)
  for (const item of items) g.setNode(item.id, { width: item.width, height: item.height })
  for (const item of items) {
    const parent = parents.get(item.id)
    if (parent) g.setEdge(parent, item.id)
  }
  dagre.layout(g)
  const out: Record<string, { x: number; y: number }> = {}
  for (const item of items) {
    const n = g.node(item.id)
    out[item.id] = { x: n.x - item.width / 2, y: n.y - item.height / 2 }
  }
  return out
}

/**
 * Two-letter avatar initials. Pass the other role names shown beside this one; when two share initials
 * ("RE" for Reviewer and Researcher) each keeps its first letter and takes the first later letter of its own
 * name that is free (Reviewer becomes RV, Researcher RS).
 */
export function initials(name: string, others: readonly string[] = []): string {
  const base = baseInitials(name)
  const taken = new Set(others.filter((o) => o !== name).map(baseInitials))
  if (!taken.has(base)) return base
  const letters = name.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '')
  for (let i = 1; i < letters.length; i++) {
    const cand = letters[0] + letters[i]
    if (cand !== base && !taken.has(cand)) return cand
  }
  return base
}

function baseInitials(name: string): string {
  const words = name.replace(/[-_]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** "3h 12m", "12m", "<1m" until `at` (epoch ms). */
/** Plan progress: steps done or skipped, out of all steps. */
export function planProgress(plan: { steps: { status: string }[] }): { done: number; total: number } {
  return { done: plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: plan.steps.length }
}

export function formatUntil(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((at - now) / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h ${mins % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
