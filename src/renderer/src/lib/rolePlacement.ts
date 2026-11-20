// Where a new role goes on the Team chart (Team tab phase 1, D2). Pure: no React Flow, no DOM. A new role takes a free
// slot beside its manager's other direct reports, never on top of another node and never by re-laying out the chart.

export interface PlacementNode {
  id: string
  position: { x: number; y: number }
  reportsTo: string | null
}

export interface PlacementSize {
  width: number
  height: number
}

export interface PlacementOptions {
  /** `left-right` puts reports to the right of the manager and stacks siblings downward; radial counts as top-down. */
  layout?: 'top-down' | 'left-right' | 'radial' | string
  /** Space kept between boxes. */
  gap?: number
  /** Space between the manager and its first report, along the layout's main axis. */
  rank?: number
  /** Measured size of an existing node (falls back to `size`). */
  sizeOf?: (id: string) => PlacementSize | undefined
}

const DEFAULT_GAP = 40
const DEFAULT_RANK = 110
/** Slots tried along one row (or column) before the search moves to the next one. */
const SLOTS_PER_LINE = 8
const MAX_LINES = 200

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const overlaps = (a: Box, b: Box, gap: number): boolean => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap

/**
 * The top-left position for a new role under `managerId` (null: the first role, which becomes the root).
 * First report: directly below the manager (right of it in left-right). Next reports: the same row, right of the
 * rightmost sibling (below the lowest sibling in left-right). A taken slot is skipped: the search steps along the row,
 * then to the next row, until the box with its gap overlaps no existing node.
 */
export function placeNewRole(roles: readonly PlacementNode[], managerId: string | null, size: PlacementSize, opts: PlacementOptions = {}): { x: number; y: number } {
  const gap = opts.gap ?? DEFAULT_GAP
  const rank = opts.rank ?? DEFAULT_RANK
  const leftRight = opts.layout === 'left-right'
  const sizeOf = (r: PlacementNode): PlacementSize => opts.sizeOf?.(r.id) ?? size
  const boxes: Box[] = roles.map((r) => {
    const s = sizeOf(r)
    return { x: r.position.x, y: r.position.y, w: s.width, h: s.height }
  })
  const manager = managerId ? roles.find((r) => r.id === managerId) : undefined
  const siblings = manager ? roles.filter((r) => r.reportsTo === manager.id) : []

  // The first candidate slot, and the step along a line and between lines.
  let start: { x: number; y: number }
  if (!manager) start = { x: 0, y: 0 }
  else if (siblings.length === 0) {
    const m = sizeOf(manager)
    start = leftRight
      ? { x: manager.position.x + m.width + rank, y: manager.position.y + (m.height - size.height) / 2 }
      : { x: manager.position.x + (m.width - size.width) / 2, y: manager.position.y + m.height + rank }
  } else if (leftRight) {
    const low = siblings.reduce((a, b) => (b.position.y + sizeOf(b).height > a.position.y + sizeOf(a).height ? b : a))
    start = { x: low.position.x, y: low.position.y + sizeOf(low).height + gap }
  } else {
    const right = siblings.reduce((a, b) => (b.position.x + sizeOf(b).width > a.position.x + sizeOf(a).width ? b : a))
    start = { x: right.position.x + sizeOf(right).width + gap, y: right.position.y }
  }
  // Along a line: right (top-down) or down (left-right). Between lines: down (top-down) or right (left-right).
  const along = leftRight ? { x: 0, y: size.height + gap } : { x: size.width + gap, y: 0 }
  const across = leftRight ? { x: size.width + gap, y: 0 } : { x: 0, y: size.height + gap }
  // Later lines start from the first sibling's column or row, so a full row wraps back under its own reports.
  const first = siblings[0]
  const lineOrigin = first ? (leftRight ? { x: first.position.x, y: first.position.y } : { x: first.position.x, y: start.y }) : start

  for (let line = 0; line < MAX_LINES; line++) {
    for (let slot = 0; slot < SLOTS_PER_LINE; slot++) {
      const base = line === 0 ? start : lineOrigin
      const x = base.x + along.x * slot + across.x * line
      const y = base.y + along.y * slot + across.y * line
      const box: Box = { x, y, w: size.width, h: size.height }
      if (!boxes.some((b) => overlaps(box, b, gap))) return { x, y }
    }
  }
  // Unreachable in practice (a thousand nodes): fall back to a spot beyond everything.
  const far = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0)
  return { x: start.x, y: far + gap }
}

/** A box in stage pixels (x, y from the stage's top-left corner). */
export interface StageRect {
  x: number
  y: number
  w: number
  h: number
}

const overlapsBy = (a: StageRect, b: StageRect, gap: number): boolean =>
  a.x < b.x + b.w + gap && b.x - gap < a.x + a.w && a.y < b.y + b.h + gap && b.y - gap < a.y + a.h

/**
 * How far to pan (never zoom) so a new role's box is inside the stage, `margin` from its edges, and clear of every
 * obstacle by `gap` (the zoom controls and the minimap sit over the stage's bottom corners; QA S1). Moves the box up,
 * left or right out of an obstacle, whichever is shortest and keeps it inside the stage and clear of the others; up
 * when none does.
 */
export function revealShift(
  node: StageRect,
  stage: { w: number; h: number },
  margin: { top: number; right: number; bottom: number; left: number },
  obstacles: readonly StageRect[] = [],
  gap = 8
): { dx: number; dy: number } {
  let dx = 0
  let dy = 0
  if (node.x + node.w > stage.w - margin.right) dx = stage.w - margin.right - (node.x + node.w)
  if (node.x + dx < margin.left) dx = margin.left - node.x
  if (node.y + node.h > stage.h - margin.bottom) dy = stage.h - margin.bottom - (node.y + node.h)
  if (node.y + dy < margin.top) dy = margin.top - node.y
  const fits = (n: StageRect): boolean =>
    n.x >= margin.left - 0.5 && n.y >= margin.top - 0.5 && n.x + n.w <= stage.w - margin.right + 0.5 && n.y + n.h <= stage.h - margin.bottom + 0.5
  for (let round = 0; round <= obstacles.length; round++) {
    const n = { ...node, x: node.x + dx, y: node.y + dy }
    const hit = obstacles.find((o) => overlapsBy(n, o, gap))
    if (!hit) break
    const moves = [
      { dx: 0, dy: hit.y - gap - (n.y + n.h) },
      { dx: hit.x - gap - (n.x + n.w), dy: 0 },
      { dx: hit.x + hit.w + gap - n.x, dy: 0 }
    ]
    const moved = (m: { dx: number; dy: number }): StageRect => ({ ...n, x: n.x + m.dx, y: n.y + m.dy })
    const ok = moves.filter((m) => fits(moved(m)) && !obstacles.some((o) => overlapsBy(moved(m), o, gap)))
    const pick = (ok.length > 0 ? ok : moves.slice(0, 1)).reduce((a, b) => (Math.abs(a.dx) + Math.abs(a.dy) <= Math.abs(b.dx) + Math.abs(b.dy) ? a : b))
    dx += pick.dx
    dy += pick.dy
  }
  return { dx, dy }
}
