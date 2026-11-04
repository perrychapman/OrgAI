import type { RunEvent } from '@shared/types'

/**
 * The project whose saved permission rules an event may have changed, or null. A project-scope grant on a resolved rules
 * card writes the rules file; a saved project (a settings proposal can add allow rules) may have too.
 * `projectOfRun` maps a run id to its project id (undefined when the run is unknown).
 */
export function rulesChangedProject(e: RunEvent, projectOfRun: (runId: string) => string | undefined): string | null {
  if (e.type === 'project.updated') return e.project.id
  if (e.type === 'rules.resolved') {
    if (e.cancelled || e.decision.behavior !== 'grant' || e.decision.scope !== 'project') return null
    return projectOfRun(e.runId) ?? null
  }
  return null
}
