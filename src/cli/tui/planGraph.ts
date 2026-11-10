/**
 * Running, ready and waiting for the steps of a plan that uses the graph (`after`, `paths`, `staff`). Pure.
 * A pending step is ready when every step it waits for that exists is done or skipped; an id that is not in the plan
 * is ignored. The host's `readySteps` also orders steps that share a path; the TUI does not see that and ignores it.
 * No traversal happens, so a dependency cycle cannot hang: the steps in it just keep waiting on each other.
 */
import type { PlanStepStatus } from '../../shared/types'

export interface GraphStep {
  id: string
  status: PlanStepStatus
  after?: readonly string[]
  paths?: readonly string[]
  staff?: unknown
}

export type StepFlow = { state: 'running' } | { state: 'ready' } | { state: 'waiting'; on: string[] }

/** Whether any step uses the graph; other plans render as they always did. */
export function usesGraph(steps: readonly GraphStep[]): boolean {
  return steps.some((s) => (s.after?.length ?? 0) > 0 || (s.paths?.length ?? 0) > 0 || !!s.staff)
}

/** Flow of each open step (in progress or pending) by step id; done, skipped and blocked steps have none. */
export function stepFlows(steps: readonly GraphStep[]): Map<string, StepFlow> {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const out = new Map<string, StepFlow>()
  for (const s of steps) {
    if (s.status === 'in_progress') out.set(s.id, { state: 'running' })
    else if (s.status === 'pending') {
      const on = [...new Set(s.after ?? [])].filter((id) => {
        const d = byId.get(id)
        return !!d && d.status !== 'done' && d.status !== 'skipped'
      })
      out.set(s.id, on.length > 0 ? { state: 'waiting', on } : { state: 'ready' })
    }
  }
  return out
}

export function readyCount(steps: readonly GraphStep[]): number {
  let n = 0
  for (const f of stepFlows(steps).values()) if (f.state === 'ready') n++
  return n
}

/** "Draft, Review and 2 more": at most two names, then the count of the rest. */
export function namesText(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  const rest = names.length - 2
  return `${names[0]}, ${names[1]} and ${rest} more`
}
