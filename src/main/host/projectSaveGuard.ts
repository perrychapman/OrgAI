import type { Project } from '@shared/types'
import { cleanProjectLimits } from '../store/projects'

/**
 * UI overhaul: spend and command settings only the desktop window may widen.
 *
 * A project save from any other surface (a socket client, the in-process CLI / TUI) is the whole project object, so
 * it carries these fields too. This compares the incoming copy with the stored project (after the same cleaning
 * ProjectStore applies, so a junk value counts as "removed") and names every field the save would change beyond
 * narrowing. The dispatcher refuses such a save (scope_denied) before anything is stored.
 *
 * - `maxDailyUsd`, `maxMonthlyUsd`: the cap may be set where there was none, kept, or lowered; never raised or removed.
 * - `schedulesNearPlanLimit`: may be turned off or kept; never turned on.
 * - `onSpendLimit`, `requireTestsPass`, `testCommand`: never changed (a test command is a shell command the user
 *   chose in the window; a gate is not waived from a terminal; pause / stop decides what a limit does).
 *
 * Other new fields (`maxAgentsPerRun`, `Role.maxConcurrent`) only narrow what a run may do, so they are not guarded.
 * Team files never carry any of these (teamFiles/parse.ts ignores unknown team.json keys), and the settings proposal
 * lists (PROJECT_SETTINGS_PROPOSABLE_FIELDS) do not name them. Pure.
 */
export function desktopOnlyProjectChanges(stored: Project, incoming: Project): string[] {
  const was = cleanProjectLimits(stored)
  const now = cleanProjectLimits(incoming)
  const refused: string[] = []
  for (const key of ['maxDailyUsd', 'maxMonthlyUsd'] as const) {
    const before = was[key]
    const after = now[key]
    if (before === undefined) continue // there was no cap: setting one (or none) only narrows
    if (after === undefined || after > before) refused.push(key)
  }
  if (now.schedulesNearPlanLimit === true && was.schedulesNearPlanLimit !== true) refused.push('schedulesNearPlanLimit')
  if ((now.onSpendLimit ?? 'pause') !== (was.onSpendLimit ?? 'pause')) refused.push('onSpendLimit')
  if ((now.requireTestsPass === true) !== (was.requireTestsPass === true)) refused.push('requireTestsPass')
  if (now.testCommand !== was.testCommand) refused.push('testCommand')
  return refused
}

/** The plain refusal sentence for the names desktopOnlyProjectChanges returned. */
export function desktopOnlyProjectMessage(fields: readonly string[]): string {
  return `These project settings can be changed in the OrgAI window only: ${fields.join(', ')}. Spend caps can be lowered from here, not raised or removed.`
}
