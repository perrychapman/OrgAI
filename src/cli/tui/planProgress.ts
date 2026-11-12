import type { PlanView } from './types'

export interface PlanObservation { runId?: string; goal: string; runStartedAt?: number; startedAt: number; done: number }

/** Continued plans carry old completions. Establish a fresh baseline when this pane first observes one. */
export function observePlan(plan: PlanView | undefined, now: number, previous?: PlanObservation): PlanObservation | undefined {
  if (!plan?.continued) return undefined
  if (previous && previous.runId === plan.runId && previous.goal === plan.goal
    && previous.runStartedAt === plan.startedAt && plan.done >= previous.done) return previous
  return { runId: plan.runId, goal: plan.goal, runStartedAt: plan.startedAt, startedAt: now, done: plan.done }
}

/** A rough step-pace estimate, not a prediction of differently sized tasks. */
export function planProgress(plan: PlanView, now: number, observation?: PlanObservation): { percent: number; eta: string } {
  const skipped = plan.steps.filter(step => step.status === 'skipped').length
  const resolved = Math.min(plan.total, plan.done + skipped)
  const percent = plan.status === 'done' ? 100 : plan.total > 0 ? Math.max(0, Math.min(100, Math.round(resolved / plan.total * 100))) : 0
  if (plan.status === 'done') return { percent, eta: 'Complete' }
  if (plan.status === 'blocked' || plan.steps.some(step => step.status === 'blocked')) return { percent, eta: 'Blocked' }
  if (plan.waiting) return { percent, eta: 'Waiting for you' }
  const stopped = { idle: 'Idle', paused: 'Paused', stopping: 'Stopping', finished: 'Run ended', error: 'Run failed' }
  if (plan.runStatus && plan.runStatus in stopped) return { percent, eta: stopped[plan.runStatus as keyof typeof stopped] }
  const remaining = plan.total - resolved
  if (plan.total > 0 && remaining <= 0) return { percent, eta: 'Wrapping up' }
  const baseline = plan.continued ? observation : undefined
  const startedAt = plan.continued ? baseline?.startedAt : plan.startedAt
  const workDone = plan.done - (baseline?.done ?? 0)
  const elapsed = startedAt === undefined ? NaN : now - startedAt
  if (workDone < 1 || !Number.isFinite(elapsed) || elapsed < 10_000 || remaining <= 0) return { percent, eta: 'Estimating…' }
  // Skipped steps resolve progress but must not make the observed work rate look faster.
  const seconds = elapsed / 1000 / workDone * remaining
  const duration = seconds < 60 ? `${Math.max(10, Math.ceil(seconds / 10) * 10)}s`
    : seconds < 3600 ? `${Math.ceil(seconds / 60)}m` : `${Math.ceil(seconds / 3600)}h`
  return { percent, eta: `ETA ~${duration}` }
}
