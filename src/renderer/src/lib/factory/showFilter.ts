// Factory Floor "Show" filter (UI overhaul, Factory board): All, Working or Waiting, read from the stack lamp each
// worker lights. Pure. It changes emphasis only: nameplates outside it are not placed (the selected, focused or hovered
// worker keeps theirs), floor plan tiles outside it are dimmed and Find a worker lists only the workers inside it.
// Nothing moves on the floor, no station hides and every worker button stays in the mirror.
import type { Lamp } from './types'

export type FactoryShow = 'all' | 'working' | 'waiting'

export interface FactoryShowCounts { all: number; working: number; waiting: number }

export function showCounts(lamps: readonly Lamp[]): FactoryShowCounts {
  let working = 0
  let waiting = 0
  for (const lamp of lamps) {
    if (lamp === 'running') working++
    else if (lamp === 'needs-you') waiting++
  }
  return { all: lamps.length, working, waiting }
}

export function inShow(show: FactoryShow, lamp: Lamp): boolean {
  if (show === 'all') return true
  return show === 'working' ? lamp === 'running' : lamp === 'needs-you'
}

/** Ids whose nameplates the filter keeps off the floor, minus the workers the user is pointing at. */
export function filteredOut(
  show: FactoryShow,
  workers: readonly { id: string; lamp: Lamp }[],
  keep: readonly (string | null | undefined)[]
): Set<string> {
  const out = new Set<string>()
  if (show === 'all') return out
  for (const w of workers) if (!inShow(show, w.lamp) && !keep.includes(w.id)) out.add(w.id)
  return out
}
