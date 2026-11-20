// Factory Floor keyboard (docs/design/factory-floor.md sections 6.3 and 2). Pure: which worker an arrow key goes to,
// the floor's single Tab stop, and what a key press on a worker button means.
import type { FloorLayout } from './types'

/** The plan board's id in the focus order (reached by Up from the booth when the floor has a board button). */
export const PLAN_BOARD_ID = '__factory-plan-board__'

export type FocusKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export interface NavOptions {
  /** The plan board button exists (live, with a plan). */
  board?: boolean
}

interface Rows {
  boothId: string | null
  /** Placed stations by hall row, north to south, each west to east (vacant slots are not in the layout's order). */
  rows: { row: number; ids: string[] }[]
}

function rowsOf(layout: FloorLayout): Rows {
  let boothId: string | null = null
  const byRow = new Map<number, string[]>()
  for (const id of layout.order) {
    const s = layout.stations[id]
    if (!s) continue
    if (s.kind === 'booth') {
      boothId = id
      continue
    }
    const list = byRow.get(s.row)
    if (list) list.push(id)
    else byRow.set(s.row, [id])
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([row, ids]) => ({ row, ids: ids.sort((a, b) => layout.stations[a].center.x - layout.stations[b].center.x) }))
  return { boothId, rows }
}

/** The nearest station by x in a row (ties go west). */
function nearestIn(layout: FloorLayout, ids: readonly string[], x: number): string {
  let best = ids[0]
  let bestD = Infinity
  for (const id of ids) {
    const d = Math.abs(layout.stations[id].center.x - x)
    if (d < bestD) {
      best = id
      bestD = d
    }
  }
  return best
}

/**
 * Where a key moves focus from `id` (section 6.3), or null to stay:
 * - Left / Right: previous / next in reading order (past a row's end, the next row's first slot).
 * - Up / Down: the station in the row above / below with the nearest x; Up from row 0 goes to the booth, Up from the
 *   booth to the plan board (when there is one); Down from the booth goes to row 0's first station, from the board to the booth.
 * - Home: the booth (else the first station). End: the last placed station.
 */
export function nextFocus(layout: FloorLayout, id: string, key: FocusKey, opts: NavOptions = {}): string | null {
  const order = layout.order
  const { boothId, rows } = rowsOf(layout)
  const first = order[0] ?? null
  if (key === 'Home') return boothId ?? first
  if (key === 'End') return order.length ? order[order.length - 1] : null
  if (id === PLAN_BOARD_ID) {
    if (!opts.board) return null
    if (key === 'ArrowDown' || key === 'ArrowRight') return boothId ?? first
    return null
  }
  const at = order.indexOf(id)
  if (at < 0) return null
  if (key === 'ArrowLeft') return at > 0 ? order[at - 1] : null
  if (key === 'ArrowRight') return at < order.length - 1 ? order[at + 1] : null
  if (id === boothId) {
    if (key === 'ArrowUp') return opts.board ? PLAN_BOARD_ID : null
    return rows.length ? rows[0].ids[0] : null
  }
  const s = layout.stations[id]
  const ri = rows.findIndex((r) => r.row === s.row)
  if (key === 'ArrowUp') {
    if (ri <= 0) return boothId
    return nearestIn(layout, rows[ri - 1].ids, s.center.x)
  }
  // ArrowDown
  if (ri < 0 || ri >= rows.length - 1) return null
  return nearestIn(layout, rows[ri + 1].ids, s.center.x)
}

/** The floor's one Tab stop: the selected worker, else the booth, else the first station; null on an empty floor. */
export function tabStop(layout: FloorLayout, selectedId?: string | null): string | null {
  if (selectedId && layout.stations[selectedId]) return selectedId
  for (const id of layout.order) if (layout.stations[id]?.kind === 'booth') return id
  return layout.order[0] ?? null
}

export interface KeyInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type FloorKeyAction =
  | { type: 'focus'; key: FocusKey }
  | { type: 'pan'; dx: number; dz: number }
  | { type: 'zoom'; direction: 'in' | 'out' }
  | { type: 'fit' }
  | { type: 'remove' }

/** Shift+Arrow pans this many metres (section 2). */
export const KEY_PAN_METRES = 4

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

/**
 * What a key pressed on a worker button does (sections 2 and 6.3), or null to leave it to the browser (Enter and Space
 * activate the native button; Tab leaves the floor; shortcuts with Ctrl, Cmd or Alt belong to the app).
 * Delete and Backspace remove a role in team mode only; never in live mode.
 */
export function floorKeyAction(e: KeyInput, mode: 'live' | 'team'): FloorKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const arrow = ARROWS[e.key]
  if (arrow) {
    if (e.shiftKey) return { type: 'pan', dx: arrow[0] * KEY_PAN_METRES, dz: arrow[1] * KEY_PAN_METRES }
    return { type: 'focus', key: e.key as FocusKey }
  }
  if (e.shiftKey && (e.key === 'Home' || e.key === 'End')) return null
  if (e.key === 'Home' || e.key === 'End') return { type: 'focus', key: e.key }
  if (e.key === '+' || e.key === '=') return { type: 'zoom', direction: 'in' }
  if (e.key === '-' || e.key === '_') return { type: 'zoom', direction: 'out' }
  if (e.key === '0' && !e.shiftKey) return { type: 'fit' }
  if (e.key === 'Delete' || e.key === 'Backspace') return mode === 'team' ? { type: 'remove' } : null
  return null
}
