import type { RunSurface } from '@shared/types'

/** True for a run hosted by the Team tab's assistant tray (kept off the Live strip, History and run counts). */
export function isTeamSurfaceRun(run: { surface?: RunSurface } | null | undefined): boolean {
  return run?.surface === 'team'
}
