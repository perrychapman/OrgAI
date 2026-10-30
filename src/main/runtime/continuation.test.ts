import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanStep, RunPlan } from '@shared/types'
import {
  ContinuationDriver,
  SET_PLAN_NUDGE,
  SET_PLAN_SUMMARY,
  continueNudgeText,
  continueSummary,
  describePlanChange,
  limitReachedText,
  nextNudge,
  nextStep,
  nudgeBlocked,
  planProgressLabel,
  remainingSteps,
  stepActivity,
  type ContinuationHost,
  type NudgeInput
} from './continuation'

const step = (id: string, title: string, status: PlanStep['status'] = 'pending', extra: Partial<PlanStep> = {}): PlanStep => ({ id, title, status, ...extra })

function plan(over: Partial<RunPlan> = {}): RunPlan {
  return {
    goal: 'Ship the feature',
    steps: [step('p1', 'Read the code', 'done'), step('p2', 'Implement it', 'in_progress'), step('p3', 'Verify: build and tests')],
    status: 'active',
    autoContinues: 0,
    updatedAt: 0,
    ...over
  }
}

function input(over: Partial<NudgeInput> = {}): NudgeInput {
  return {
    plan: plan(),
    kind: 'work',
    autoContinue: true,
    maxAutoContinues: 40,
    liveReports: 0,
    pendingInteractions: 0,
    rateLimited: false,
    stopping: false,
    turnsWithoutPlan: 0,
    ...over
  }
}

describe('nextNudge', () => {
  it('continues an active plan with steps left, with the exact reminder text', () => {
    const d = nextNudge(input())
    expect(d.kind).toBe('continue')
    expect(d.text).toBe(
      'Harness: plan 1 of 3 done. Remaining: p2 Implement it (in progress); p3 Verify: build and tests. ' +
        'Continue with the next step; mark steps with update_plan as you go. ' +
        "When all are done, run the project's verification (build/tests) and call complete_plan. " +
        'Stop only for a real decision: ask_user, or mark_blocked with the reason.'
    )
    expect(d.summary).toBe('Continuing: 1 of 3 steps done, next "Implement it".')
  })

  it('summarises a nudge in one human line', () => {
    expect(continueSummary(plan({ steps: [step('p1', 'A', 'done'), step('p2', 'B', 'pending')] }))).toBe('Continuing: 1 of 2 steps done, next "B".')
    expect(continueSummary(plan({ steps: [step('p1', 'A', 'done')] }))).toBe('Continuing: 1 of 1 step done, asked the orchestrator to verify and complete the plan.')
    const long = 'x'.repeat(120)
    expect(continueSummary(plan({ steps: [step('p1', long, 'pending')] }))).toBe(`Continuing: 0 of 1 step done, next "${'x'.repeat(79)}…".`)
    expect(limitReachedText(40)).toBe(
      'Automatic continues paused: this run reached its limit of 40. Reply to keep going, or raise "Max automatic continues per run" in project settings.'
    )
  })

  it('counts skipped steps as finished and marks blocked steps in the list', () => {
    const p = plan({ steps: [step('p1', 'A', 'skipped'), step('p2', 'B', 'blocked'), step('p3', 'C', 'done')] })
    expect(continueNudgeText(p)).toContain('plan 2 of 3 done. Remaining: p2 B (blocked).')
  })

  it('asks for verification and complete_plan when every step is done but the plan is still active', () => {
    const d = nextNudge(input({ plan: plan({ steps: [step('p1', 'A', 'done'), step('p2', 'B', 'skipped')] }) }))
    expect(d.kind).toBe('continue')
    expect(d.text).toContain('plan 2 of 2 done but not completed')
    expect(d.text).toContain('call complete_plan with a summary')
  })

  it('asks for a plan once, after the first completed turn without one', () => {
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 1 }))).toEqual({ kind: 'set-plan', text: SET_PLAN_NUDGE, summary: SET_PLAN_SUMMARY })
    expect(SET_PLAN_NUDGE).toBe('Harness: before continuing, call set_plan with the goal and the concrete steps, then start on step 1.')
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 2 })).kind).toBe('none')
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 0 })).kind).toBe('none')
  })

  it('stays quiet for finished and blocked plans', () => {
    expect(nextNudge(input({ plan: plan({ status: 'done' }) })).kind).toBe('none')
    expect(nextNudge(input({ plan: plan({ status: 'blocked', blockedReason: 'Pick a database' }) })).kind).toBe('none')
  })

  it('stops at the automatic-continue limit and says so', () => {
    expect(nextNudge(input({ plan: plan({ autoContinues: 39 }) })).kind).toBe('continue')
    expect(nextNudge(input({ plan: plan({ autoContinues: 40 }) }))).toEqual({ kind: 'none', limitReached: true })
    expect(nextNudge(input({ maxAutoContinues: 0 }))).toEqual({ kind: 'none', limitReached: true })
  })

  it.each([
    ['setup runs', { kind: 'setup' as const }],
    ['autoContinue off', { autoContinue: false }],
    ['live reports', { liveReports: 2 }],
    ['pending cards', { pendingInteractions: 1 }],
    ['rate limits', { rateLimited: true }],
    ['stopping', { stopping: true }],
    ['a busy orchestrator', { orchestratorBusy: true }]
  ])('never nudges for %s', (_label, over) => {
    expect(nextNudge(input(over))).toEqual({ kind: 'none' })
    expect(nextNudge(input({ ...over, plan: undefined, turnsWithoutPlan: 1 }))).toEqual({ kind: 'none' })
    expect(nudgeBlocked(input(over))).not.toBeNull()
  })

  it('a blocked condition wins over the limit', () => {
    expect(nextNudge(input({ liveReports: 1, plan: plan({ autoContinues: 99 }) }))).toEqual({ kind: 'none' })
  })
})

describe('plan helpers', () => {
  it('reports progress, the next step and the step in progress', () => {
    const p = plan()
    expect(planProgressLabel(p)).toBe('1/3 steps')
    expect(remainingSteps(p).map((s) => s.id)).toEqual(['p2', 'p3'])
    expect(nextStep(p)?.id).toBe('p2')
    expect(nextStep(plan({ steps: [step('p1', 'A', 'done'), step('p2', 'B')] }))?.id).toBe('p2')
    expect(stepActivity(p)).toBe('Implement it')
    expect(stepActivity(plan({ status: 'done' }))).toBeUndefined()
    expect(stepActivity(undefined)).toBeUndefined()
  })

  it('describes plan changes and ignores bookkeeping', () => {
    const p = plan()
    expect(describePlanChange(undefined, p)).toBe('Plan set: Ship the feature (3 steps).')
    expect(describePlanChange(p, { ...p, autoContinues: 3, updatedAt: 9 })).toBeNull()
    expect(describePlanChange(p, { ...p, steps: p.steps.map((s) => ({ ...s, status: 'done' as const })) })).toBe('Plan updated: 3 of 3 steps done.')
    expect(describePlanChange(p, { ...p, status: 'done' })).toBe('Plan complete: 1 of 3 steps done.')
    expect(describePlanChange(p, { ...p, status: 'blocked', blockedReason: 'Need a key' })).toBe('Plan blocked: Need a key')
    expect(describePlanChange({ ...p, status: 'blocked' }, p)).toBe('Plan active again: 1 of 3 steps done.')
  })
})

describe('ContinuationDriver', () => {
  let current: RunPlan | undefined
  let host: ContinuationHost & { nudges: [string, string, string][]; told: string[]; logs: [string, string][] }

  beforeEach(() => {
    vi.useFakeTimers()
    current = plan()
    const nudges: [string, string, string][] = []
    const told: string[] = []
    const logs: [string, string][] = []
    host = {
      kind: 'work',
      autoContinue: true,
      maxAutoContinues: 2,
      delayMs: 1500,
      getPlan: () => current,
      updatePlan: vi.fn(async (p: RunPlan) => {
        current = p
      }),
      liveReports: () => 0,
      pendingInteractions: () => 0,
      rateLimited: () => false,
      stopping: () => false,
      orchestratorBusy: () => false,
      nudge: (text, activity, summary) => nudges.push([text, activity, summary]),
      log: (level, message) => logs.push([level, message]),
      tellUser: (text) => told.push(text),
      nudges,
      told,
      logs
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the delay, then counts the continue and names the next step', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded()
    await vi.advanceTimersByTimeAsync(1400)
    expect(host.nudges).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(host.nudges).toHaveLength(1)
    expect(host.nudges[0][0]).toContain('Harness: plan 1 of 3 done.')
    expect(host.nudges[0][1]).toBe('Continuing: Implement it')
    expect(host.nudges[0][2]).toBe('Continuing: 1 of 3 steps done, next "Implement it".')
    expect(current?.autoContinues).toBe(1)
    expect(host.logs.some(([l, m]) => l === 'info' && m.startsWith('Automatic continue 1 of 2'))).toBe(true)
  })

  it('re-checks the conditions after the delay', async () => {
    let busy = false
    host.orchestratorBusy = () => busy
    const d = new ContinuationDriver(host)
    d.turnEnded()
    busy = true // a report landed and woke the orchestrator meanwhile
    await vi.advanceTimersByTimeAsync(2000)
    expect(host.nudges).toHaveLength(0)
  })

  it('warns once at the limit and tells the user', async () => {
    current = plan({ autoContinues: 2 })
    const d = new ContinuationDriver(host)
    expect(await d.evaluate()).toEqual({ kind: 'none', limitReached: true })
    await d.evaluate()
    expect(host.told).toEqual([limitReachedText(2)])
    expect(host.logs.filter(([l]) => l === 'warn')).toHaveLength(1)
    expect(host.nudges).toHaveLength(0)
  })

  it('asks for a plan once when there is none', async () => {
    current = undefined
    const d = new ContinuationDriver(host)
    expect((await d.evaluate()).kind).toBe('set-plan')
    expect(host.nudges[0]).toEqual([SET_PLAN_NUDGE, 'Planning the work…', SET_PLAN_SUMMARY])
    expect((await d.evaluate()).kind).toBe('none')
    expect(host.updatePlan).not.toHaveBeenCalled()
  })

  it('a blocked first turn does not use up the set-plan reminder', async () => {
    current = undefined
    let reports = 1
    host.liveReports = () => reports
    const d = new ContinuationDriver(host)
    expect((await d.evaluate()).kind).toBe('none')
    reports = 0
    expect((await d.evaluate()).kind).toBe('set-plan')
  })

  it('hold stops nudges until the user speaks; userMessage cancels a pending check', async () => {
    const d = new ContinuationDriver(host)
    d.hold()
    expect((await d.evaluate()).kind).toBe('none')
    d.userMessage()
    d.turnEnded()
    d.userMessage()
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.nudges).toHaveLength(0)
    expect((await d.evaluate()).kind).toBe('continue')
  })

  it('does nothing for setup runs, with autoContinue off, or after dispose', async () => {
    for (const over of [{ kind: 'setup' as const }, { autoContinue: false }]) {
      const d = new ContinuationDriver({ ...host, ...over })
      d.turnEnded()
      await vi.advanceTimersByTimeAsync(2000)
    }
    const d = new ContinuationDriver(host)
    d.turnEnded()
    d.dispose()
    await vi.advanceTimersByTimeAsync(2000)
    expect(host.nudges).toHaveLength(0)
  })
})
