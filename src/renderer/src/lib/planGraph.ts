import type { PlanStep, RunPlan } from '@shared/types'

/**
 * Where each plan step stands against the plan graph. A pure renderer copy of the main process's definition
 * (src/main/runtime/continuation.ts `readySteps`, `pathOverlaps`): a step is ready when it is not started and every step
 * it waits for is done or skipped (an id that names no step is ignored); of two steps that could run together and share
 * a path, the later one waits for the earlier. Keep the two in step. Never throws, never loops on a cycle.
 */

export type StepState = 'running' | 'ready' | 'waiting' | 'blocked' | 'finished'

export interface StepView {
  state: StepState
  /** Ids of the unfinished steps this one waits for (its `after`, then the earlier step it shares a path with). */
  waitingOn: string[]
}

const finished = (s: PlanStep): boolean => s.status === 'done' || s.status === 'skipped'

function normalizePath(p: string): string {
  const parts = p.trim().replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.')
  return parts.length ? parts.join('/') : '.'
}

function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return x === y || x === '.' || y === '.' || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)
}

/** Indexes of the steps each step transitively waits for. Ids that name no step are ignored; a cycle ends at once. */
function ancestors(steps: PlanStep[]): Set<number>[] {
  const index = new Map<string, number>()
  steps.forEach((s, i) => {
    if (!index.has(s.id)) index.set(s.id, i)
  })
  const direct = steps.map((s) => (s.after ?? []).map((id) => index.get(id)).filter((j): j is number => j !== undefined))
  return steps.map((_, i) => {
    const seen = new Set<number>()
    const stack = [...direct[i]]
    while (stack.length) {
      const j = stack.pop() as number
      if (seen.has(j) || j === i) continue
      seen.add(j)
      stack.push(...direct[j])
    }
    return seen
  })
}

/** True when the plan uses the graph at all (a step with `after`, `paths` or `staff`). Without it nothing new is shown. */
export function planHasGraph(plan: RunPlan | undefined): boolean {
  return !!plan?.steps.some((s) => !!s.after?.length || !!s.paths?.length || !!s.staff)
}

/** The state of every step, in plan order. */
export function stepViews(plan: RunPlan): StepView[] {
  const steps = plan.steps
  const done = new Set(steps.filter(finished).map((s) => s.id))
  const byId = new Map<string, PlanStep>()
  for (const s of steps) if (!byId.has(s.id)) byId.set(s.id, s)
  const anc = ancestors(steps)
  return steps.map((s, j) => {
    if (finished(s)) return { state: 'finished', waitingOn: [] }
    if (s.status === 'in_progress') return { state: 'running', waitingOn: [] }
    if (s.status === 'blocked') return { state: 'blocked', waitingOn: [] }
    const waitingOn: string[] = []
    for (const id of s.after ?? []) if (byId.has(id) && !done.has(id) && id !== s.id && !waitingOn.includes(id)) waitingOn.push(id)
    if (s.paths?.length) {
      for (let i = 0; i < j; i++) {
        const a = steps[i]
        if (finished(a) || !a.paths?.length || anc[j].has(i) || anc[i].has(j)) continue
        if (a.id !== s.id && !waitingOn.includes(a.id) && a.paths.some((x) => s.paths!.some((y) => pathsOverlap(x, y)))) waitingOn.push(a.id)
      }
    }
    return { state: waitingOn.length ? 'waiting' : 'ready', waitingOn }
  })
}

/** Steps that can start now, as the harness counts them. */
export function readyStepIds(plan: RunPlan): string[] {
  const views = stepViews(plan)
  return plan.steps.filter((_, i) => views[i].state === 'ready').map((s) => s.id)
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
