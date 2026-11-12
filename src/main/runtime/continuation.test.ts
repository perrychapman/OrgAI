import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanStep, RunPlan } from '@shared/types'
import {
  ContinuationDriver,
  continuationWaitMs,
  SET_PLAN_NUDGE,
  SET_PLAN_SUMMARY,
  continueNudgeText,
  continueSummary,
  describePlanChange,
  limitReachedText,
  nextNudge,
  nextStep,
  nudgeBlocked,
  peerDeliveryBlocked,
  planNudgesApply,
  pathOverlaps,
  planProgressLabel,
  readyLine,
  readyReports,
  readySteps,
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
    // A pure direct answer on turn 1 needs no plan; later turns and live reports are unaffected.
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 1, directAnswerOnly: true }))).toEqual({ kind: 'none' })
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 1, directAnswerOnly: false }))).toEqual({ kind: 'set-plan', text: SET_PLAN_NUDGE, summary: SET_PLAN_SUMMARY })
    expect(nextNudge(input({ plan: undefined, turnsWithoutPlan: 1, directAnswerOnly: true, pendingInteractions: 1 })).kind).toBe('none')
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

describe('peerDeliveryBlocked', () => {
  const ok = { held: false, rateLimited: false, pendingInteractions: 0 }
  it('allows delivery to a run that is not waiting on its user', () => {
    expect(peerDeliveryBlocked(ok)).toBeNull()
  })
  it('holds messages for an interrupted, rate-limited or waiting run, the user stop first', () => {
    expect(peerDeliveryBlocked({ ...ok, held: true })).toBe('held')
    expect(peerDeliveryBlocked({ ...ok, rateLimited: true })).toBe('rate limited')
    expect(peerDeliveryBlocked({ ...ok, pendingInteractions: 2 })).toBe('waiting for the user')
    expect(peerDeliveryBlocked({ held: true, rateLimited: true, pendingInteractions: 1 })).toBe('held')
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

  it('isHeld is true from hold until the next user message', () => {
    const d = new ContinuationDriver(host)
    expect(d.isHeld()).toBe(false)
    d.hold()
    expect(d.isHeld()).toBe(true)
    d.turnEnded()
    expect(d.isHeld()).toBe(true)
    d.userMessage()
    expect(d.isHeld()).toBe(false)
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

describe('planNudgesApply (UX M5: a single-assistant Chat is a conversation)', () => {
  const quick = (team: 'single' | 'default') => ({ folder: '/w', team, allowEdits: false, gitRepo: false })

  it('applies to work runs and Chats with the default team only', () => {
    expect(planNudgesApply({ kind: 'work' })).toBe(true)
    expect(planNudgesApply({ kind: 'work', quick: quick('default') })).toBe(true)
    expect(planNudgesApply({ kind: 'work', quick: quick('single') })).toBe(false)
    expect(planNudgesApply({ kind: 'setup' })).toBe(false)
    expect(planNudgesApply({ kind: 'mcp-assist' })).toBe(false)
  })

  it('is off for a single-agent work run of a stored project (RunSummary.team)', () => {
    expect(planNudgesApply({ kind: 'work', team: 'single' })).toBe(false)
  })

  function driverFor(run: Parameters<typeof planNudgesApply>[0], current: RunPlan | undefined) {
    const nudges: string[] = []
    const d = new ContinuationDriver({
      kind: run.kind,
      autoContinue: planNudgesApply(run),
      delayMs: 10,
      getPlan: () => current,
      updatePlan: async () => {},
      liveReports: () => 0,
      pendingInteractions: () => 0,
      rateLimited: () => false,
      stopping: () => false,
      orchestratorBusy: () => false,
      nudge: (text) => nudges.push(text),
      log: () => {},
      tellUser: () => {}
    })
    return { d, nudges }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('single: no set-plan or continue nudge at turn end, and the interrupt hold still works', async () => {
    for (const current of [undefined, plan()]) {
      const { d, nudges } = driverFor({ kind: 'work', quick: quick('single') }, current)
      d.turnEnded()
      await vi.advanceTimersByTimeAsync(100)
      expect(nudges).toEqual([])
      expect((await d.evaluate()).kind).toBe('none')
      d.hold()
      expect(d.isHeld()).toBe(true)
      d.userMessage()
      expect(d.isHeld()).toBe(false)
      d.dispose()
    }
  })

  it('default team: unchanged (asks for a plan, then continues one)', async () => {
    const first = driverFor({ kind: 'work', quick: quick('default') }, undefined)
    first.d.turnEnded()
    await vi.advanceTimersByTimeAsync(100)
    expect(first.nudges).toEqual([SET_PLAN_NUDGE])
    const second = driverFor({ kind: 'work', quick: quick('default') }, plan())
    second.d.turnEnded()
    await vi.advanceTimersByTimeAsync(100)
    expect(second.nudges).toHaveLength(1)
    expect(second.nudges[0]).toContain('Harness: plan 1 of 3 done.')
  })
})

describe('nudge wording per project kind', () => {
  it('code keeps the verification wording, engagements review the deliverables', () => {
    const code = nextNudge(input())
    expect(code.text).toContain("run the project's verification (build/tests)")
    const eng = nextNudge(input({ projectKind: 'engagement' }))
    expect(eng.text).toContain('review the deliverables against the brief')
    expect(eng.text).not.toMatch(/build\/tests|verification/)
    const done = plan({ steps: [step('p1', 'A', 'done')] })
    expect(nextNudge(input({ plan: done })).text).toContain("Run the project's verification (build/tests)")
    const finish = nextNudge(input({ plan: done, projectKind: 'engagement' })).text
    expect(finish).toContain('Review the deliverables against the brief and call complete_plan')
    expect(finish).not.toMatch(/build\/tests/)
  })

  it('the driver passes the host project kind to the decision and the activity line', async () => {
    vi.useFakeTimers()
    try {
      const nudges: [string, string, string][] = []
      const done = plan({ steps: [step('p1', 'A', 'done')] })
      const d = new ContinuationDriver({
        kind: 'work',
        maxAutoContinues: 5,
        delayMs: 10,
        projectKind: 'engagement',
        getPlan: () => done,
        updatePlan: async () => {},
        liveReports: () => 0,
        pendingInteractions: () => 0,
        rateLimited: () => false,
        stopping: () => false,
        orchestratorBusy: () => false,
        nudge: (text, activity, summary) => nudges.push([text, activity, summary]),
        log: () => {},
        tellUser: () => {}
      })
      d.turnEnded()
      await vi.advanceTimersByTimeAsync(50)
      expect(nudges).toHaveLength(1)
      expect(nudges[0][0]).toContain('Review the deliverables')
      expect(nudges[0][1]).toBe('Continuing: review')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ContinuationDriver turn-generation settlement (cli-spec 6.2(2))', () => {
  let current: RunPlan | undefined
  let host: ContinuationHost & { nudges: string[]; settled: number[] }

  beforeEach(() => {
    vi.useFakeTimers()
    current = plan()
    const nudges: string[] = []
    const settled: number[] = []
    host = {
      kind: 'work',
      autoContinue: true,
      maxAutoContinues: 5,
      delayMs: 1500,
      getPlan: () => current,
      updatePlan: async (p: RunPlan) => {
        current = p
      },
      liveReports: () => 0,
      pendingInteractions: () => 0,
      rateLimited: () => false,
      stopping: () => false,
      orchestratorBusy: () => false,
      nudge: (text) => nudges.push(text),
      log: () => undefined,
      tellUser: () => undefined,
      onSettled: (gen) => settled.push(gen),
      nudges,
      settled
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles at once when the driver is off (setup run, autoContinue false)', () => {
    for (const over of [{ kind: 'setup' as const }, { autoContinue: false }]) {
      const settled: number[] = []
      const d = new ContinuationDriver({ ...host, ...over, onSettled: (g) => settled.push(g) })
      expect(d.isSettledForTurn(1)).toBe(false)
      d.turnEnded(1)
      expect(d.isSettledForTurn(1)).toBe(true)
      expect(settled).toEqual([1])
      d.turnEnded(2)
      expect(d.isSettledForTurn(2)).toBe(true)
      expect(d.isSettledForTurn(1)).toBe(false)
    }
  })

  it('a missing turnGen counts up from the previous one', () => {
    const d = new ContinuationDriver({ ...host, autoContinue: false })
    d.turnEnded()
    d.turnEnded()
    expect(d.turnGen).toBe(2)
    expect(d.isSettledForTurn(2)).toBe(true)
  })

  it('is not settled while the timer is pending and settles after a none evaluation', async () => {
    current = plan({ status: 'done' })
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    expect(d.isSettledForTurn(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(1400)
    expect(d.isSettledForTurn(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(d.isSettledForTurn(1)).toBe(true)
    expect(host.settled).toEqual([1])
    expect(host.nudges).toHaveLength(0)
  })

  it('is not settled while evaluate runs; a nudged turn stays unsettled', async () => {
    let release!: () => void
    host.updatePlan = (p: RunPlan) =>
      new Promise<void>((r) => {
        current = p
        release = r
      })
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    // The continue decision waits on updatePlan: the evaluation is in flight.
    expect(d.isSettledForTurn(1)).toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.nudges).toHaveLength(1)
    expect(d.isSettledForTurn(1)).toBe(false)
    expect(host.settled).toEqual([])
  })

  it('a nudged turn stays unsettled until the next generation settles', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    expect(d.isSettledForTurn(1)).toBe(false)
    current = { ...current!, status: 'done' }
    d.turnEnded(2)
    expect(d.isSettledForTurn(2)).toBe(false)
    await vi.advanceTimersByTimeAsync(1600)
    expect(d.isSettledForTurn(2)).toBe(true)
    expect(host.settled).toEqual([2])
  })

  it('a limit-reached evaluation settles the generation', async () => {
    current = plan({ autoContinues: 5 })
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(0)
    expect(d.isSettledForTurn(1)).toBe(true)
  })

  it('skipTurn settles a failed or interrupted turn without a timer or a nudge', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    d.skipTurn(2)
    expect(d.isSettledForTurn(2)).toBe(true)
    expect(host.settled).toEqual([2])
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.nudges).toHaveLength(0)
    expect(d.turnGen).toBe(2)
  })

  it('a turn-1 pure direct answer (no tools, no reports, no cards) gets no set-plan nudge and settles', async () => {
    current = undefined
    host.directAnswerTurn = () => true
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(0)
    expect(d.isSettledForTurn(1)).toBe(true)
    expect(d.nudgeTurn1Sent).toBe(true)
  })

  it('after a turn-1 direct answer, the next plan-less work turn still gets the set-plan nudge', async () => {
    current = undefined
    let direct = true
    host.directAnswerTurn = () => direct
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(0)
    // The user asks for work; the orchestrator uses tools and stops without a plan.
    d.userMessage()
    expect(d.nudgeTurn1Sent).toBe(false)
    direct = false
    d.turnEnded(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    expect(d.nudgeTurn1Sent).toBe(true)
    delete host.directAnswerTurn
  })

  it('a turn-1 answer that used tools, or a host without the signal, still gets the set-plan nudge', async () => {
    current = undefined
    host.directAnswerTurn = () => false
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    delete host.directAnswerTurn
    current = undefined
    const d2 = new ContinuationDriver(host)
    expect(d2.nudgeTurn1Sent).toBe(false)
  })

  it('nudgeTurn1Sent turns true once the set-plan nudge is sent', async () => {
    current = undefined
    const d = new ContinuationDriver(host)
    expect(d.nudgeTurn1Sent).toBe(false)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(d.nudgeTurn1Sent).toBe(true)
    expect(d.isSettledForTurn(1)).toBe(false)
    d.turnEnded(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    expect(d.isSettledForTurn(2)).toBe(true)
  })

  it('userMessage cancels a pending timer and unsettles the generation', async () => {
    current = plan({ status: 'done' })
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(d.isSettledForTurn(1)).toBe(true)
    d.userMessage()
    expect(d.isSettledForTurn(1)).toBe(false)
    d.turnEnded(2)
    d.userMessage()
    await vi.advanceTimersByTimeAsync(3000)
    expect(d.isSettledForTurn(2)).toBe(false)
    expect(host.settled).toEqual([1])
  })

  it('hold with a pending timer settles that generation', () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    d.hold()
    expect(d.isSettledForTurn(1)).toBe(true)
  })

  it('reads autoContinue and maxAutoContinues through getters at every check', async () => {
    let auto = true
    let max = 5
    const live: ContinuationHost = {
      ...host,
      get autoContinue() {
        return auto
      },
      get maxAutoContinues() {
        return max
      }
    }
    const d = new ContinuationDriver(live)
    max = 0
    expect(await d.evaluate()).toEqual({ kind: 'none', limitReached: true })
    max = 5
    expect((await d.evaluate()).kind).toBe('continue')
    auto = false
    d.turnEnded(3)
    expect(d.isSettledForTurn(3)).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.nudges).toHaveLength(1)
  })
})

describe('continuationWaitMs', () => {
  const base = { delayMs: 1500, liveReports: 0, now: 100_000, known: true }
  it('waits the full delay when the host does not report report end times', () => {
    expect(continuationWaitMs({ ...base, known: false })).toBe(1500)
    expect(continuationWaitMs({ ...base, known: false, lastReportEndedAt: 100_000 })).toBe(1500)
  })
  it('waits 0 when no report ever ended', () => {
    expect(continuationWaitMs({ ...base })).toBe(0)
  })
  it('waits 0 when the newest report ended at least delayMs ago (boundary included)', () => {
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_000 - 1500 })).toBe(0)
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_000 - 9000 })).toBe(0)
  })
  it('waits the remainder of the window after a recent report', () => {
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_000 - 400 })).toBe(1100)
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_000 - 1499 })).toBe(1)
  })
  it('waits the full delay when a report ended this very moment', () => {
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_000 })).toBe(1500)
  })
  it('waits the full delay with live reports, even when none ended', () => {
    expect(continuationWaitMs({ ...base, liveReports: 1 })).toBe(1500)
    expect(continuationWaitMs({ ...base, liveReports: 2, lastReportEndedAt: 1 })).toBe(1500)
  })
  it('waits the full delay when the clock went backwards (end time in the future)', () => {
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 100_001 })).toBe(1500)
    expect(continuationWaitMs({ ...base, lastReportEndedAt: 500_000 })).toBe(1500)
  })
  it('keeps a host delay of 0 at 0', () => {
    expect(continuationWaitMs({ ...base, delayMs: 0 })).toBe(0)
    expect(continuationWaitMs({ ...base, delayMs: 0, liveReports: 3 })).toBe(0)
    expect(continuationWaitMs({ ...base, delayMs: 0, lastReportEndedAt: 100_001 })).toBe(0)
    expect(continuationWaitMs({ ...base, delayMs: 0, known: false })).toBe(0)
  })
})

describe('ContinuationDriver wait after the last report', () => {
  let current: RunPlan | undefined
  let nudges: string[]
  let live = 0
  let host: ContinuationHost

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    current = plan()
    nudges = []
    live = 0
    host = {
      kind: 'work',
      autoContinue: true,
      maxAutoContinues: 5,
      delayMs: 1500,
      getPlan: () => current,
      updatePlan: async (p: RunPlan) => {
        current = p
      },
      liveReports: () => live,
      lastReportEndedAt: () => undefined,
      pendingInteractions: () => 0,
      rateLimited: () => false,
      stopping: () => false,
      orchestratorBusy: () => false,
      nudge: (text) => nudges.push(text),
      log: () => undefined,
      tellUser: () => undefined
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a host without lastReportEndedAt still waits the full delay', async () => {
    const { lastReportEndedAt: _omit, ...legacy } = host
    const d = new ContinuationDriver(legacy)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1499)
    expect(nudges).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(nudges).toHaveLength(1)
  })

  it('no report ever ended and none live: evaluates on the next timer tick and delivers a due nudge', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    expect(nudges).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(nudges).toHaveLength(1)
  })

  it('a report that ended 400 ms ago leaves only the rest of the window', async () => {
    host.lastReportEndedAt = () => Date.now() - 400
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1099)
    expect(nudges).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(nudges).toHaveLength(1)
  })

  it('live reports keep the full delay', async () => {
    live = 1
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1499)
    expect(d.isSettledForTurn(1)).toBe(false)
    live = 0
    await vi.advanceTimersByTimeAsync(1)
    expect(nudges).toHaveLength(1)
  })

  it('is unsettled until the zero-delay evaluation ran, settled after it when no nudge was sent', async () => {
    current = plan({ status: 'done' })
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    expect(d.isSettledForTurn(1)).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(d.isSettledForTurn(1)).toBe(true)
    expect(nudges).toHaveLength(0)
  })

  it('userMessage, hold and dispose before the zero-delay tick still cancel it', async () => {
    for (const cancel of ['userMessage', 'hold', 'dispose'] as const) {
      const d = new ContinuationDriver(host)
      d.turnEnded(1)
      d[cancel]()
      await vi.advanceTimersByTimeAsync(2000)
      expect(nudges, cancel).toHaveLength(0)
      // userMessage unsettles; hold and dispose settle a turn end that was still waiting (as before this change).
      expect(d.isSettledForTurn(1), cancel).toBe(cancel !== 'userMessage')
    }
  })
})

const ids = (steps: PlanStep[]): string[] => steps.map((s) => s.id)
const mk = (steps: PlanStep[], over: Partial<RunPlan> = {}): RunPlan => plan({ steps, ...over })

describe('readySteps', () => {
  it('a step with no after is ready; done, in-progress, blocked and skipped steps are not', () => {
    const p = mk([step('p1', 'a', 'done'), step('p2', 'b', 'in_progress'), step('p3', 'c', 'blocked'), step('p4', 'd', 'skipped'), step('p5', 'e'), step('p6', 'f')])
    expect(ids(readySteps(p))).toEqual(['p5', 'p6'])
  })

  it('a chain releases one step at a time; done or skipped dependencies release', () => {
    const chain = (a: PlanStep['status'], b: PlanStep['status']): RunPlan => mk([step('p1', 'a', a), step('p2', 'b', b, { after: ['p1'] }), step('p3', 'c', 'pending', { after: ['p2'] })])
    expect(ids(readySteps(chain('pending', 'pending')))).toEqual(['p1'])
    expect(ids(readySteps(chain('in_progress', 'pending')))).toEqual([])
    expect(ids(readySteps(chain('done', 'pending')))).toEqual(['p2'])
    expect(ids(readySteps(chain('skipped', 'done')))).toEqual(['p3'])
  })

  it('a diamond releases both middle steps together, the join only after both', () => {
    const d = (b: PlanStep['status']): RunPlan =>
      mk([step('p1', 'a', 'done'), step('p2', 'b', b, { after: ['p1'] }), step('p3', 'c', 'pending', { after: ['p1'] }), step('p4', 'd', 'pending', { after: ['p2', 'p3'] })])
    expect(ids(readySteps(d('pending')))).toEqual(['p2', 'p3'])
    expect(ids(readySteps(d('done')))).toEqual(['p3'])
  })

  it('a cycle already broken by the cleaner leaves the earlier step ready', () => {
    const p = mk([step('p1', 'a'), step('p2', 'b', 'pending', { after: ['p1'] })])
    expect(ids(readySteps(p))).toEqual(['p1'])
  })

  it('orders steps that could run together and share a path by plan order', () => {
    const p = mk([step('p1', 'a', 'pending', { paths: ['src/api/'] }), step('p2', 'b', 'pending', { paths: ['./src\\api'] }), step('p3', 'c', 'pending', { paths: ['docs'] })])
    expect(ids(readySteps(p))).toEqual(['p1', 'p3'])
    p.steps[0].status = 'in_progress'
    expect(ids(readySteps(p))).toEqual(['p3'])
    p.steps[0].status = 'done'
    expect(ids(readySteps(p))).toEqual(['p2', 'p3'])
    p.steps[0].status = 'skipped'
    expect(ids(readySteps(p))).toEqual(['p2', 'p3'])
  })

  it('a folder is a prefix of the files inside it, but not of a sibling that merely starts with its name', () => {
    const p = mk([step('p1', 'a', 'pending', { paths: ['src/api'] }), step('p2', 'b', 'pending', { paths: ['src/api/routes.ts'] }), step('p3', 'c', 'pending', { paths: ['src/api-docs'] })])
    expect(ids(readySteps(p))).toEqual(['p1', 'p3'])
  })

  it('steps ordered by after (directly or through others) do not count as overlapping', () => {
    const p = mk([step('p1', 'a', 'pending', { paths: ['src'] }), step('p2', 'b', 'pending', { after: ['p1'] }), step('p3', 'c', 'pending', { after: ['p2'], paths: ['src/x.ts'] })])
    expect(pathOverlaps(p)).toEqual([])
    expect(ids(readySteps(p))).toEqual(['p1'])
  })
})

describe('pathOverlaps', () => {
  it('lists each pair once with the earlier step first and the shared folder', () => {
    const p = mk([step('p1', 'a', 'pending', { paths: ['src/api'] }), step('p2', 'b', 'pending', { paths: ['src/api/x.ts', 'web'] }), step('p3', 'c', 'pending', { paths: ['web/'] })])
    expect(pathOverlaps(p)).toEqual([
      { first: 'p1', second: 'p2', path: 'src/api' },
      { first: 'p2', second: 'p3', path: 'web' }
    ])
  })

  it('ignores finished steps and steps without paths', () => {
    const p = mk([step('p1', 'a', 'done', { paths: ['src'] }), step('p2', 'b', 'pending', { paths: ['src'] }), step('p3', 'c')])
    expect(pathOverlaps(p)).toEqual([])
  })
})

describe('readyReports and readyLine', () => {
  const staffed = mk([step('p1', 'lead work'), step('p2', 'a', 'pending', { staff: { role: 'implementer' } }), step('p3', 'b', 'pending', { staff: { role: 'Lead' } }), step('p4', 'c', 'pending', { staff: { role: 'researcher' } })])
  it('lists only ready steps that name a report other than the caller own role', () => {
    expect(ids(readyReports(staffed, ['lead', 'Lead']))).toEqual(['p2', 'p4'])
    expect(ids(readyReports(staffed))).toEqual(['p2', 'p3', 'p4'])
  })

  it('formats none, one, several, more than the free slots, and no free slot', () => {
    const [a, b, c] = readyReports(staffed)
    expect(readyLine([], { free: 3, limit: 8 })).toBe('')
    expect(readyLine([a], { free: 3, limit: 8 })).toBe('Ready now: p2 (implementer).')
    expect(readyLine([a, b, c], { free: 6, limit: 8 })).toBe('Ready now: p2 (implementer), p3 (Lead), p4 (researcher). 6 of 8 agent slots are free. Start them in one message: calls in one message run together.')
    expect(readyLine([a, b, c], { free: 2, limit: 8 })).toBe('Ready now: p2 (implementer), p3 (Lead), p4 (researcher). 2 of 8 agent slots are free, so only 2 fit now. Start those in one message: calls in one message run together.')
    expect(readyLine([a], { free: 0, limit: 8 })).toBe('Ready now: p2 (implementer). 0 of 8 agent slots are free; start it when a report ends.')
  })
})

describe('a staffed step is not ready', () => {
  const staffedPlan = mk([step('p1', 'a', 'in_progress', { staff: { role: 'implementer' } }), step('p2', 'b', 'pending', { staff: { role: 'implementer' } })])
  it('readyReports and readyLine skip the in_progress step and keep the unbound one', () => {
    expect(ids(readyReports(staffedPlan))).toEqual(['p2'])
    expect(readyLine(readyReports(staffedPlan), { free: 3, limit: 8 })).toContain('p2')
    expect(readyLine(readyReports(staffedPlan), { free: 3, limit: 8 })).not.toContain('p1')
  })
  it('the ready nudge is silent when only the staffed step is left, and names only the unbound one otherwise', () => {
    const only = mk([step('p1', 'a', 'in_progress', { staff: { role: 'implementer' } })])
    expect(nextNudge(input({ plan: only, liveReports: 1, slots: { free: 6, limit: 8 }, ownRoles: ['lead'] })).kind).toBe('none')
    const d = nextNudge(input({ plan: staffedPlan, liveReports: 1, slots: { free: 6, limit: 8 }, ownRoles: ['lead'] }))
    expect(d.kind).toBe('ready')
    expect(d.readySignature).toBe('p2')
  })
})

describe('nextNudge: ready', () => {
  const rp = (over: Partial<RunPlan> = {}): RunPlan =>
    mk([step('p1', 'Design', 'done'), step('p2', 'Build API', 'pending', { staff: { role: 'implementer' } }), step('p3', 'Build UI', 'pending', { staff: { role: 'implementer' } }), step('p4', 'Own work', 'pending')], over)
  const ri = (over: Partial<NudgeInput> = {}): NudgeInput => input({ plan: rp(), liveReports: 2, slots: { free: 6, limit: 8 }, ownRoles: ['lead', 'Lead'], ...over })

  it('fires while reports run, naming the ready reports and the free slots', () => {
    const d = nextNudge(ri())
    expect(d.kind).toBe('ready')
    expect(d.readySignature).toBe('p2,p3')
    expect(d.text).toBe(
      'Harness: Ready now: p2 (implementer), p3 (implementer). 6 of 8 agent slots are free. Start them in one message (calls in one message run together), or call update_plan if they should wait.'
    )
    expect(d.summary).toBe('Continuing: p2, p3 ready, asked the orchestrator to start them.')
  })

  it('says how many fit when more steps are ready than slots are free', () => {
    expect(nextNudge(ri({ slots: { free: 1, limit: 8 } })).text).toContain('1 of 8 agent slots are free, so only 1 fit now. Start the first 1 in one message')
  })

  it('stays silent without slots info, without a free slot, without ready reports, or for the same set', () => {
    expect(nextNudge(ri({ slots: undefined })).kind).toBe('none')
    expect(nextNudge(ri({ slots: { free: 0, limit: 8 } })).kind).toBe('none')
    expect(nextNudge(ri({ plan: mk([step('p1', 'a', 'in_progress', { staff: { role: 'implementer' } }), step('p2', 'b', 'pending')]) })).kind).toBe('none')
    expect(nextNudge(ri({ plan: mk([step('p1', 'a', 'pending', { staff: { role: 'lead' } })]) })).kind).toBe('none')
    expect(nextNudge(ri({ lastReadySignature: 'p2,p3' })).kind).toBe('none')
    expect(nextNudge(ri({ lastReadySignature: 'p2' })).kind).toBe('ready')
  })

  it('respects every other blocker', () => {
    for (const over of [{ kind: 'setup' as const }, { autoContinue: false }, { stopping: true }, { rateLimited: true }, { pendingInteractions: 1 }, { orchestratorBusy: true }, { plan: rp({ status: 'blocked' }) }, { plan: rp({ status: 'done' }) }, { plan: undefined }]) {
      expect(nextNudge(ri(over)).kind, JSON.stringify(over)).toBe('none')
    }
  })

  it('counts against the limit: at the limit it sends nothing and reports the limit once the set is new', () => {
    const d = nextNudge(ri({ plan: rp({ autoContinues: 40 }) }))
    expect(d).toEqual({ kind: 'none', limitReached: true })
    expect(nextNudge(ri({ plan: rp({ autoContinues: 40 }), lastReadySignature: 'p2,p3' }))).toEqual({ kind: 'none' })
  })

  it('with no report running the continue decision keeps precedence', () => {
    expect(nextNudge(ri({ liveReports: 0 })).kind).toBe('continue')
    expect(nextNudge(ri({ liveReports: 0, plan: undefined, turnsWithoutPlan: 1 })).kind).toBe('set-plan')
  })
})

describe('ContinuationDriver: ready nudge', () => {
  let current: RunPlan | undefined
  let live: number
  let host: ContinuationHost & { nudges: [string, string, string][]; settled: number[]; told: string[] }
  const readyPlan = (): RunPlan => mk([step('p1', 'Design', 'done'), step('p2', 'API', 'pending', { staff: { role: 'implementer' } }), step('p3', 'UI', 'pending', { staff: { role: 'implementer' } })])

  beforeEach(() => {
    vi.useFakeTimers()
    current = readyPlan()
    live = 1
    const nudges: [string, string, string][] = []
    const settled: number[] = []
    const told: string[] = []
    host = {
      kind: 'work',
      autoContinue: true,
      maxAutoContinues: 2,
      delayMs: 1500,
      getPlan: () => current,
      updatePlan: async (p: RunPlan) => {
        current = p
      },
      liveReports: () => live,
      slots: () => ({ free: 7, limit: 8 }),
      ownRoles: () => ['lead'],
      pendingInteractions: () => 0,
      rateLimited: () => false,
      stopping: () => false,
      orchestratorBusy: () => false,
      nudge: (t, a, s) => nudges.push([t, a, s]),
      log: () => undefined,
      tellUser: (t) => told.push(t),
      onSettled: (g) => settled.push(g),
      nudges,
      settled,
      told
    }
  })
  afterEach(() => vi.useRealTimers())

  it('nudges once per ready set while a report runs, counts it, and leaves the turn unsettled', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    expect(host.nudges[0][0]).toContain('Ready now: p2 (implementer), p3 (implementer). 7 of 8 agent slots are free.')
    expect(host.nudges[0][1]).toBe('Starting ready steps: p2,p3')
    expect(current?.autoContinues).toBe(1)
    expect(d.isSettledForTurn(1)).toBe(false)
    expect(host.settled).toEqual([])
    d.turnEnded(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(1)
    expect(current?.autoContinues).toBe(1)
    expect(host.settled).toEqual([2])
    expect(d.isSettledForTurn(2)).toBe(true)
  })

  it('nudges again for a different ready set, up to the limit, then tells the user once', async () => {
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    current = { ...current!, steps: [...current!.steps, step('p4', 'Docs', 'pending', { staff: { role: 'researcher' } })] }
    d.turnEnded(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(2)
    expect(current?.autoContinues).toBe(2)
    current = { ...current!, steps: [...current!.steps, step('p5', 'More', 'pending', { staff: { role: 'researcher' } })] }
    d.turnEnded(3)
    await vi.advanceTimersByTimeAsync(1600)
    d.turnEnded(4)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(2)
    expect(host.told).toEqual([limitReachedText(2)])
  })

  it('does not fire without a slots member', async () => {
    const d = new ContinuationDriver({ ...host, slots: undefined })
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges).toHaveLength(0)
  })

  it('with no report running the continue nudge applies instead', async () => {
    live = 0
    const d = new ContinuationDriver(host)
    d.turnEnded(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(host.nudges[0][0]).toContain('Harness: plan 1 of 3 done.')
  })
})
