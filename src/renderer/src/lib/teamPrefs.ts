/**
 * Team tab preferences kept in localStorage (docs/design/team-tab-overhaul.md 1.1 and 1.5). Pure over a Storage-like
 * object so tests need no DOM. A throwing or missing store (private mode) behaves as "nothing saved".
 */

export type TeamLayoutDirection = 'top-down' | 'left-right'

/** The Team editor's own direction, independent of the Live canvas and App settings. */
export const TEAM_LAYOUT_KEY = 'orgai.teamLayout'
/** Set once the first-visit hint of the notice row was dismissed; once per app, not per project. */
export const TEAM_HINT_KEY = 'orgai.teamHintSeen'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function readTeamLayout(storage: StorageLike | undefined): TeamLayoutDirection {
  try {
    const value = storage?.getItem(TEAM_LAYOUT_KEY)
    return value === 'left-right' ? 'left-right' : 'top-down'
  } catch {
    return 'top-down'
  }
}

export function writeTeamLayout(storage: StorageLike | undefined, value: TeamLayoutDirection): void {
  try {
    storage?.setItem(TEAM_LAYOUT_KEY, value)
  } catch {
    // Not saved: the choice still applies for this visit.
  }
}

export function readTeamHintSeen(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(TEAM_HINT_KEY) === '1'
  } catch {
    return false
  }
}

export function writeTeamHintSeen(storage: StorageLike | undefined): void {
  try {
    storage?.setItem(TEAM_HINT_KEY, '1')
  } catch {
    // The hint comes back next visit; nothing else depends on it.
  }
}
