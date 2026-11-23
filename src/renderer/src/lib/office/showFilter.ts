// Pocket Office "Show" filter (UI overhaul, Office board): All, Working or Waiting. Pure. The filter only changes
// emphasis: people outside it are dimmed and leave the Find a person list; nobody moves, hides or loses their button.
import { officeState } from './cues'

export type OfficeShow = 'all' | 'working' | 'waiting'

export interface OfficeShowCounts { all: number; working: number; waiting: number }

/** Counts per filter from agent statuses (the same states the cues read). */
export function showCounts(statuses: readonly string[]): OfficeShowCounts {
  let working = 0
  let waiting = 0
  for (const status of statuses) {
    const state = officeState(status)
    if (state === 'running') working++
    else if (state === 'waiting') waiting++
  }
  return { all: statuses.length, working, waiting }
}

/** Whether a person with this status is inside the filter. */
export function inShow(show: OfficeShow, status: string): boolean {
  if (show === 'all') return true
  const state = officeState(status)
  return show === 'working' ? state === 'running' : state === 'waiting'
}
