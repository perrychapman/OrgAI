import { describe, expect, it } from 'vitest'
import type { PlanStep, RunPlan, StaffingAssignment } from '@shared/types'
import { WAITING_NOTE, waitingNote, waitingNoteExcluded, type WaitingNoteInput } from './waitingNote'

const step = (id: string, status: PlanStep['status'], after?: string[]): PlanStep => ({ id, title: id, status, ...(after ? { after } : {}) })
const plan = (steps: PlanStep[], status: RunPlan['status'] = 'active'): RunPlan => ({ goal: 'g', steps, status, autoContinues: 0, updatedAt: 0 })
const row = (agentId: string, stepId: string): StaffingAssignment => ({ agentId, stepId, roleId: 'r-eng', model: 'm', source: 'orchestrator', at: 0 })

/** The P2c shape: p1 handed to the one report (bound, in_progress), p2 ready, the lead doing nothing. */
const base = (over: Partial<WaitingNoteInput> = {}): WaitingNoteInput => ({
  callerIsRoot: true,
  callerRunningReports: 1,
  spawnedRoleId: 'r-eng',
  requiredRoleIds: [],
  plan: plan([step('p1', 'in_progress'), step('p2', 'pending'), step('p3', 'pending', ['p1', 'p2'])]),
  assignments: [row('a1', 'p1')],
  runningAgentIds: new Set(['a1']),
  shown: false,
  excludedRun: false,
  ...over
})

describe('one-report-and-waiting note', () => {
  it('is given when one report runs, the lead does nothing and a step is ready', () => {
    expect(waitingNote(base())).toBe(WAITING_NOTE)
    expect(WAITING_NOTE).toBe('You are waiting on one report. Take a ready step yourself, or hand out the rest; waiting is slower than doing this alone.')
  })

  it('is not given when the lead works on a step itself (in_progress, no running report bound)', () => {
    const p = plan([step('p1', 'in_progress'), step('p2', 'in_progress'), step('p3', 'pending')])
    expect(waitingNote(base({ plan: p }))).toBeUndefined()
    // A step bound to a report that already finished counts as the lead's.
    expect(waitingNote(base({ runningAgentIds: new Set(['a9']) }))).toBeUndefined()
  })

  it('only for the root, only with exactly one running report, never for a required report', () => {
    expect(waitingNote(base({ callerIsRoot: false }))).toBeUndefined()
    expect(waitingNote(base({ callerRunningReports: 2 }))).toBeUndefined()
    expect(waitingNote(base({ callerRunningReports: 0 }))).toBeUndefined()
    expect(waitingNote(base({ requiredRoleIds: ['r-eng'] }))).toBeUndefined()
    expect(waitingNote(base({ requiredRoleIds: ['r-other'] }))).toBe(WAITING_NOTE)
  })

  it('needs an active plan with a ready step', () => {
    expect(waitingNote(base({ plan: undefined }))).toBeUndefined()
    expect(waitingNote(base({ plan: plan([step('p1', 'in_progress'), step('p2', 'pending')], 'done') }))).toBeUndefined()
    // Nothing ready: the verify step waits for the report's step, so waiting is all there is.
    expect(waitingNote(base({ plan: plan([step('p1', 'in_progress'), step('p2', 'pending', ['p1'])]) }))).toBeUndefined()
  })

  it('at most once per run, and never on excluded runs', () => {
    expect(waitingNote(base({ shown: true }))).toBeUndefined()
    expect(waitingNote(base({ excludedRun: true }))).toBeUndefined()
    expect(waitingNoteExcluded({ kind: 'work' }, true)).toBe(true)
    expect(waitingNoteExcluded({ kind: 'work', quick: {} }, false)).toBe(true)
    expect(waitingNoteExcluded({ kind: 'work', team: 'single' }, false)).toBe(true)
    expect(waitingNoteExcluded({ kind: 'work' }, false)).toBe(false)
  })
})
