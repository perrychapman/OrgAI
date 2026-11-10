import type { PlanStepStatus } from './types'

/**
 * The plan graph, one definition for the main process, the desktop renderer and the terminal UI. Pure: no Node or DOM.
 * A pending step is ready when every step in its `after` that exists is done or skipped (an id that names no step is
 * ignored; a step that names itself waits for itself), and of two otherwise parallel steps (neither waits for the other,
 * directly or through others) whose `paths` overlap, plan order determines the wait unless that would create a cycle. Never throws and
 * never loops on a cycle: the steps in it just keep waiting on each other.
 */

/** The fields of a plan step the graph reads. `PlanStep` fits. */
export interface GraphStepLike {
  id: string
  status: PlanStepStatus
  after?: readonly string[]
  paths?: readonly string[]
  staff?: unknown
}

export interface GraphPlanLike<S extends GraphStepLike = GraphStepLike> {
  steps: readonly S[]
}

export type StepState = 'running' | 'ready' | 'waiting' | 'blocked' | 'finished'

export interface StepView {
  state: StepState
  /** Ids of the unfinished steps this one waits for: its `after` (in order), then steps it shares a path with. Empty unless `waiting`. */
  waitingOn: string[]
}

export interface PathOverlap {
  /** The step which goes first. */
  first: string
  /** The step which waits for `first`. */
  second: string
  /** The path both name (the folder when one is inside the other). */
  path: string
}

const finished = (s: GraphStepLike): boolean => s.status === 'done' || s.status === 'skipped'

/** Whether the plan uses the graph at all (a step with `after`, `paths` or `staff`). Without it nothing graph-related is shown. */
export function planUsesGraph(steps: readonly GraphStepLike[] | undefined): boolean {
  return !!steps?.some((s) => (s.after?.length ?? 0) > 0 || (s.paths?.length ?? 0) > 0 || !!s.staff)
}

/** A path as compared for overlap: '/'-separated, no leading './', no repeated or trailing slashes. '.' = the whole project. */
export function normalizePlanPath(p: string): string {
  const parts = p.trim().replace(/\\/g, '/').split('/').filter((x) => x !== '' && x !== '.')
  return parts.length ? parts.join('/') : '.'
}

/** The path both name when they overlap (equal, or one a folder prefix of the other: the folder), else undefined. */
function overlapOf(a: string, b: string): string | undefined {
  const x = normalizePlanPath(a)
  const y = normalizePlanPath(b)
  if (x === y) return x
  if (x === '.') return y === '.' ? '.' : x
  if (y === '.') return y
  if (y.startsWith(`${x}/`)) return x
  if (x.startsWith(`${y}/`)) return y
  return undefined
}

function firstOverlap(as: readonly string[], bs: readonly string[]): string | undefined {
  for (const x of as) for (const y of bs) {
    const hit = overlapOf(x, y)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Indexes of the steps each step transitively waits for (follows `after`; ids that name no step are ignored). */
function ancestorSets(steps: readonly GraphStepLike[]): Set<number>[] {
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

/**
 * Pairs of unfinished steps that could run together (neither waits for the other, directly or through other steps) and
 * whose `paths` overlap: equal after normalising separators and trailing slashes, or one a folder prefix of the other.
 * Prefer plan order, reversing a path wait when earlier accepted waits would otherwise make a cycle. Pure.
 */
export function pathOverlaps(plan: GraphPlanLike): PathOverlap[] {
  const steps = plan.steps
  const explicit = ancestorSets(steps)
  const anc = explicit.map((set) => new Set(set))
  const out: PathOverlap[] = []
  for (let j = 1; j < steps.length; j++) {
    const b = steps[j]
    if (finished(b) || !b.paths?.length) continue
    for (let i = 0; i < j; i++) {
      const a = steps[i]
      if (finished(a) || !a.paths?.length || explicit[j].has(i) || explicit[i].has(j)) continue
      const hit = firstOverlap(a.paths, b.paths)
      if (hit === undefined) continue
      const [first, second] = anc[i].has(j) ? [j, i] : [i, j]
      out.push({ first: steps[first].id, second: steps[second].id, path: hit })
      // Propagate this wait to every dependent so later edges see the whole combined graph.
      for (let k = 0; k < steps.length; k++) {
        if (k === second || anc[k].has(second)) {
          anc[k].add(first)
          for (const ancestor of anc[first]) anc[k].add(ancestor)
        }
      }
    }
  }
  return out
}

/** The state of every step, in plan order. */
export function stepViews(plan: GraphPlanLike): StepView[] {
  const steps = plan.steps
  const done = new Set(steps.filter(finished).map((s) => s.id))
  const exists = new Set(steps.map((s) => s.id))
  const pathFirsts = new Map<string, string[]>()
  for (const o of pathOverlaps(plan)) {
    const list = pathFirsts.get(o.second) ?? []
    if (!list.includes(o.first)) list.push(o.first)
    pathFirsts.set(o.second, list)
  }
  return steps.map((s) => {
    if (finished(s)) return { state: 'finished', waitingOn: [] }
    if (s.status === 'in_progress') return { state: 'running', waitingOn: [] }
    if (s.status === 'blocked') return { state: 'blocked', waitingOn: [] }
    const waitingOn: string[] = []
    for (const id of [...(s.after ?? []), ...(pathFirsts.get(s.id) ?? [])]) {
      if ((s.after ?? []).includes(id) && !exists.has(id)) continue
      if (!done.has(id) && !waitingOn.includes(id)) waitingOn.push(id)
    }
    return { state: waitingOn.length ? 'waiting' : 'ready', waitingOn }
  })
}

/** Steps that can start now: pending with nothing left to wait for. Pure. */
export function readySteps<S extends GraphStepLike>(plan: { steps: readonly S[] }): S[] {
  const views = stepViews(plan)
  return plan.steps.filter((_, i) => views[i].state === 'ready')
}
