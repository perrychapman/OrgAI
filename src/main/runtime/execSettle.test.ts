import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunPlan } from '@shared/types'
import { defaultEndedBy, execNotQuiescentReason, execOutcomeFor, execQuiescent, isWorkingReport, type ExecSettleInput } from './execSettle'

const settled = { rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true }

const plan = (over: Partial<RunPlan> = {}): RunPlan => ({
  goal: 'g',
  steps: [{ id: 's1', title: 'one', status: 'done' }] as RunPlan['steps'],
  status: 'done',
  autoContinues: 0,
  updatedAt: 0,
  ...over
})

const input = (over: Partial<ExecSettleInput> = {}): ExecSettleInput => ({
  settlement: settled,
  rootTurnGen: 1,
  limitHold: false,
  held: false,
  agents: [{ id: 'root', state: 'idle' }],
  openCards: 0,
  inboxLength: 0,
  flushing: false,
  plan: undefined,
  autoContinue: false,
  ...over
})

describe('execQuiescent', () => {
  it('settles a single / autoContinue-false run after turn 1 without a plan', () => {
    expect(execQuiescent(input())).toBe(true)
  })

  it.each<[string, Partial<ExecSettleInput>]>([
    ['no settlement', { settlement: undefined }],
    ['no turn ended', { rootTurnGen: 0, settlement: { ...settled, rootTurnGen: 0 } }],
    ['root busy', { settlement: { ...settled, rootIdle: false } }],
    ['other generation', { settlement: { ...settled, rootTurnGen: 2 } }],
    ['continuation pending', { settlement: { ...settled, continuationSettled: false } }],
    ['adapter busy', { settlement: { ...settled, quiescent: false } }],
    ['limit hold', { limitHold: true }],
    ['interrupt hold', { held: true }],
    ['open card', { openCards: 1 }],
    ['inbox', { inboxLength: 1 }],
    ['flushing', { flushing: true }]
  ])('blocks on %s', (_name, over) => {
    expect(execQuiescent(input(over))).toBe(false)
    expect(execNotQuiescentReason(input(over))).toBeTruthy()
  })

  it.each(['starting', 'thinking', 'tool', 'waiting', 'delegating'] as const)('blocks on a report in %s', (state) => {
    expect(execQuiescent(input({ agents: [{ id: 'root', state: 'idle' }, { id: 'a1', state }] }))).toBe(false)
  })

  it('ignores finished reports and the root state', () => {
    expect(execQuiescent(input({ agents: [{ id: 'root', state: 'thinking' }, { id: 'a1', state: 'done' }, { id: 'a2', state: 'error' }, { id: 'a3', state: 'idle' }] }))).toBe(true)
    expect(isWorkingReport({ id: 'root', state: 'tool' })).toBe(false)
  })

  it('turn-1 rule: an unplanned run with nudges on waits for the set-plan nudge', () => {
    expect(execQuiescent(input({ autoContinue: true }))).toBe(false)
    expect(execQuiescent(input({ autoContinue: true, settlement: { ...settled, nudgeTurn1Sent: true } }))).toBe(true)
    // With a plan the rule does not apply.
    expect(execQuiescent(input({ autoContinue: true, plan: plan() }))).toBe(true)
  })
})

describe('execOutcomeFor', () => {
  const conflict = { worktree: { path: '/w', branch: 'b', status: 'conflict' as const } }
  it('maps the plan states', () => {
    expect(execOutcomeFor({ plan: undefined, agents: [] })).toEqual({ outcome: 'completed-unplanned' })
    expect(execOutcomeFor({ plan: plan(), agents: [] })).toEqual({ outcome: 'completed' })
    expect(execOutcomeFor({ plan: plan({ status: 'blocked' }), agents: [] })).toEqual({ outcome: 'blocked', endedBy: 'policy' })
    expect(execOutcomeFor({ plan: plan({ status: 'active', steps: [{ id: 's', title: 't', status: 'pending' }] as RunPlan['steps'] }), agents: [] })).toEqual({
      outcome: 'incomplete-plan',
      endedBy: 'policy'
    })
  })

  it('active with no steps left is still incomplete (complete_plan never called)', () => {
    expect(execOutcomeFor({ plan: plan({ status: 'active' }), agents: [] }).outcome).toBe('incomplete-plan')
  })

  it('unmerged conflict branches, unless allowUnmerged', () => {
    const agents = [conflict] as Pick<AgentInstance, 'worktree'>[]
    expect(execOutcomeFor({ plan: plan(), agents })).toEqual({ outcome: 'unmerged-conflicts', endedBy: 'policy' })
    expect(execOutcomeFor({ plan: plan(), agents, allowUnmerged: true })).toEqual({ outcome: 'completed' })
    // Without a plan the conflict rule does not apply (spec table: plan done only).
    expect(execOutcomeFor({ plan: undefined, agents }).outcome).toBe('completed-unplanned')
  })

  it('defaultEndedBy follows the table', () => {
    expect(defaultEndedBy('completed')).toBeUndefined()
    expect(defaultEndedBy('rate-limited')).toBeUndefined()
    expect(defaultEndedBy('failed')).toBeUndefined()
    expect(defaultEndedBy('auth-error')).toBeUndefined()
    expect(defaultEndedBy('stalled')).toBe('policy')
    expect(defaultEndedBy('needs-decision')).toBe('policy')
    expect(defaultEndedBy('budget-exceeded')).toBe('budget')
    expect(defaultEndedBy('interrupted')).toBe('user')
  })
})
