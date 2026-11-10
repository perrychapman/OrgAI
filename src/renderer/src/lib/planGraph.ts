import type { RunPlan } from '@shared/types'
import { planUsesGraph, readySteps, stepViews, type StepState, type StepView } from '@shared/planGraph'

/**
 * Where each plan step stands against the plan graph. The definition lives in src/shared/planGraph.ts (shared with the
 * main process and the TUI); this module re-exports it under the names the components use and keeps the presentation helpers.
 */

export { stepViews }
export type { StepState, StepView }

/** True when the plan uses the graph at all (a step with `after`, `paths` or `staff`). Without it nothing new is shown. */
export function planHasGraph(plan: RunPlan | undefined): boolean {
  return planUsesGraph(plan?.steps)
}

/** Steps that can start now, as the harness counts them. */
export function readyStepIds(plan: RunPlan): string[] {
  return readySteps(plan).map((s) => s.id)
}

/** A step title cut to `max` characters for "waiting on" lists. */
export function shortTitle(title: string, max = 28): string {
  const t = title.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** "Waiting on: A, B and 2 more". Titles of the first `show` steps, shortened. */
export function waitingOnText(plan: RunPlan, ids: string[], show = 2): string {
  const title = new Map<string, string>()
  for (const s of plan.steps) if (!title.has(s.id)) title.set(s.id, s.title)
  const names = ids.map((id) => shortTitle(title.get(id) ?? id))
  const shown = names.slice(0, show).join(', ')
  const more = names.length - show
  return `Waiting on ${shown}${more > 0 ? ` and ${more} more` : ''}`
}

export interface StaffingCounts {
  working: number
  ready: number
}

/**
 * The run strip's numbers: agents working now and plan steps ready to start. Both are 0 for a run with no staffing data
 * and a plan without the graph, so older runs show nothing new.
 */
export function staffingCounts<S extends string>(input: {
  agents: { state: S }[]
  isWorking: (state: S) => boolean
  plan?: RunPlan
  hasAssignments: boolean
}): StaffingCounts {
  const graph = planHasGraph(input.plan)
  if (!graph && !input.hasAssignments) return { working: 0, ready: 0 }
  const working = input.agents.filter((a) => input.isWorking(a.state)).length
  const ready = graph && input.plan ? readyStepIds(input.plan).length : 0
  return { working, ready }
}
