/**
 * Running, ready and waiting for the steps of a plan that uses the graph (`after`, `paths`, `staff`). Pure.
 * The definition lives in src/shared/planGraph.ts, shared with the host and the desktop app: a pending step is ready when
 * every step it waits for that exists is done or skipped, and of two parallel steps that share a path the later one
 * waits for the earlier, so the TUI counts the same ready steps the host will start. A cycle cannot hang: its steps
 * just keep waiting on each other.
 */
import type { PlanStepStatus } from '../../shared/types'
import { planUsesGraph, stepViews, type GraphStepLike } from '../../shared/planGraph'

export type GraphStep = GraphStepLike & { status: PlanStepStatus }

export type StepFlow = { state: 'running' } | { state: 'ready' } | { state: 'waiting'; on: string[] }

/** Whether any step uses the graph; other plans render as they always did. */
export function usesGraph(steps: readonly GraphStep[]): boolean {
  return planUsesGraph(steps)
}

/** Flow of each open step (in progress or pending) by step id; done, skipped and blocked steps have none. */
export function stepFlows(steps: readonly GraphStep[]): Map<string, StepFlow> {
  const views = stepViews({ steps })
  const out = new Map<string, StepFlow>()
  steps.forEach((s, i) => {
    const v = views[i]
    if (v.state === 'running') out.set(s.id, { state: 'running' })
    else if (v.state === 'ready') out.set(s.id, { state: 'ready' })
    else if (v.state === 'waiting') out.set(s.id, { state: 'waiting', on: v.waitingOn })
  })
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
