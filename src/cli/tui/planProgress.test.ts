import { describe, expect, it } from 'vitest'
import { observePlan, planProgress } from './planProgress'
import type { PlanView } from './types'
const plan: PlanView = {
  goal: 'Build', status: 'active', statusWord: 'In progress', runStatus: 'running', startedAt: 1000,
  done: 1, total: 3, steps: [
    { id: '1', title: 'Read', status: 'done' }, { id: '2', title: 'Build', status: 'in_progress' },
    { id: '3', title: 'Review', status: 'pending' }
  ]
}
describe('plan progress and rough step-pace ETA', () => {
  it('waits for fresh completions in a continued run, including a late attachment', () => {
    const resumed = { ...plan, runId: 'r2', continued: true, done: 5, total: 8 }
    expect(planProgress(resumed, 11_000).eta).toBe('Estimating…')
    const baseline = observePlan(resumed, 61_000)
    expect(planProgress(resumed, 121_000, baseline).eta).toBe('Estimating…')
    const progressed = { ...resumed, done: 6 }
    expect(observePlan(progressed, 121_000, baseline)).toBe(baseline)
    expect(planProgress(progressed, 121_000, baseline).eta).toBe('ETA ~2m')
  })
  it('resets the observation on a different run, replacement plan, or regressed progress', () => {
    const resumed = { ...plan, runId: 'r2', continued: true }
    const baseline = observePlan(resumed, 1000)
    for (const changed of [{ ...resumed, runId: 'r3' }, { ...resumed, goal: 'New work' }, { ...resumed, done: 0 }]) {
      expect(observePlan(changed, 5000, baseline)?.startedAt).toBe(5000)
    }
    expect(observePlan(plan, 5000, baseline)).toBeUndefined()
  })

  it('estimates remaining work and rounds rather than showing false second precision', () => {
    expect(planProgress(plan, 61_000)).toEqual({ percent: 33, eta: 'ETA ~2m' })
    expect(planProgress({ ...plan, done: 2 }, 61_000)).toEqual({ percent: 67, eta: 'ETA ~30s' })
  })
  it('waits for real progress and enough elapsed time', () => {
    for (const p of [{ ...plan, done: 0 }, { ...plan, startedAt: undefined }, { ...plan, startedAt: NaN }, { ...plan, startedAt: 100_000 }]) {
      expect(planProgress(p, 61_000).eta).toBe('Estimating…')
    }
    expect(planProgress(plan, 5000).eta).toBe('Estimating…')
  })
  it.each([
    [{ status: 'blocked' }, 'Blocked'], [{ waiting: true }, 'Waiting for you'],
    [{ runStatus: 'paused' }, 'Paused'], [{ runStatus: 'idle' }, 'Idle'],
    [{ runStatus: 'error' }, 'Run failed'], [{ runStatus: 'finished' }, 'Run ended']
  ] as const)('does not show an ETA when progress is stopped: %j', (over, expected) => {
    expect(planProgress({ ...plan, ...over }, 61_000).eta).toBe(expected)
  })
  it('counts skipped steps in progress without using them to inflate the observed pace', () => {
    const skipped = { ...plan, steps: [...plan.steps.slice(0, 2), { ...plan.steps[2], status: 'skipped' as const }] }
    expect(planProgress(skipped, 61_000)).toEqual({ percent: 67, eta: 'ETA ~1m' })
    expect(planProgress({ ...skipped, status: 'done' }, 61_000)).toEqual({ percent: 100, eta: 'Complete' })
    expect(planProgress({ ...plan, done: 3 }, 61_000).eta).toBe('Wrapping up')
  })
})
