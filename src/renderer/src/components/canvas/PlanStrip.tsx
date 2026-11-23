import type { ReactElement } from 'react'
import type { PlanStep, RunPlan } from '@shared/types'
import { planProgress } from '../../lib/layout'
import '../../styles/canvas-chrome.css'

/** More steps than this and the strip shows "Step k of n · title" over one compact bar instead of a label per step. */
export const PLAN_STRIP_LABELLED_MAX = 6

/** The step the strip talks about: the one in progress, else the first blocked or pending one, else the last. */
export function currentStepIndex(steps: readonly Pick<PlanStep, 'status'>[]): number {
  let i = steps.findIndex((s) => s.status === 'in_progress')
  if (i < 0) i = steps.findIndex((s) => s.status === 'blocked')
  if (i < 0) i = steps.findIndex((s) => s.status === 'pending')
  return i < 0 ? steps.length - 1 : i
}

/** "Plan: 1 of 4 steps done, now: Add the cache layer". The text alternative of the whole strip. */
export function planStripSummary(plan: RunPlan): string {
  const { done, total } = planProgress(plan)
  const now = plan.steps[currentStepIndex(plan.steps)]
  const tail = plan.status === 'done' || done === total ? '' : now ? `, now: ${now.title}` : ''
  return `Plan: ${done} of ${total} ${total === 1 ? 'step' : 'steps'} done${tail}`
}

function Segment({ step }: { step: PlanStep }): ReactElement {
  return <span className="plan-strip-seg" data-status={step.status} />
}

/**
 * The glass strip along the bottom of the run canvas: the plan as segments, one per step (done green, in progress cyan
 * with a sheen, blocked amber, pending sunk). Up to six steps each carry their "n · title" label with the current one
 * emphasised; with more it reads "Step k of n · title" over a compact bar. The whole strip is one button that calls
 * `onOpenPlan` (the Plan tab). Renders nothing without a plan. The sheen stops under reduced motion and Pause motion.
 */
export function PlanStrip({ plan, onOpenPlan }: { plan: RunPlan | undefined; onOpenPlan: () => void }): ReactElement | null {
  if (!plan || plan.steps.length === 0) return null
  const steps = plan.steps
  const cur = currentStepIndex(steps)
  const compact = steps.length > PLAN_STRIP_LABELLED_MAX
  const summary = planStripSummary(plan)
  return (
    <button type="button" className="plan-strip" data-testid="plan-strip" data-compact={compact || undefined} data-plan-status={plan.status} onClick={onOpenPlan} title="Show the plan">
      <span className="sr-only">{summary}. Show the plan.</span>
      {compact ? (
        <span className="plan-strip-compact" aria-hidden="true">
          <span className="plan-strip-now">
            Step {cur + 1} of {steps.length} · {steps[cur].title}
          </span>
          <span className="plan-strip-bar" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
            {steps.map((s) => (
              <Segment key={s.id} step={s} />
            ))}
          </span>
        </span>
      ) : (
        <span className="plan-strip-steps" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
          {steps.map((s, i) => (
            <span key={s.id} className="plan-strip-step" data-status={s.status} data-now={i === cur || undefined}>
              <Segment step={s} />
              <span className="plan-strip-label">
                {i + 1} · {s.title}
              </span>
            </span>
          ))}
        </span>
      )}
    </button>
  )
}
