import { describe, expect, it } from 'vitest'
import { effortOptionsFor } from '@shared/defaults'
import type { ModelTier, PlanStep, RunPlan } from '@shared/types'
import {
  STAFFING_BOOK_AGENTS_MAX,
  STAFFING_BOOK_PENDING_MAX,
  STAFFING_BOOK_STEP_ATTEMPTS_MAX,
  STAFFING_BOOK_STEPS_MAX,
  STAFFING_ESCALATIONS_MAX,
  StaffingBook,
  type StaffingBookDeps,
  type StaffingDecideInput
} from './staffingBook'

type BookRole = StaffingDecideInput['role']

const TM: Partial<Record<ModelTier, string>> = { top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' }
const DEV: BookRole = { id: 'r-dev', slug: 'dev', model: 'opus', tier: 'deep', effort: 'high' }
const QA: BookRole = { id: 'r-qa', slug: 'qa', model: 'sonnet', tier: 'everyday', effort: 'medium' }
const HELPER: BookRole = { id: 'r-helper', slug: 'helper', model: 'inherit' }
const OPS_FIXED: BookRole = { id: 'r-ops', slug: 'ops', model: 'claude-sonnet-4-6', effort: 'high' }

const step = (id: string, role: string | undefined, over: Partial<PlanStep> = {}): PlanStep => ({
  id,
  title: `title ${id}`,
  status: 'pending',
  ...(role ? { staff: { role } } : {}),
  ...over
})

/** A book over a mutable plan; `plan` is read live, like RuntimeContext.getPlan. */
function setup(steps: PlanStep[] | undefined, over: Partial<StaffingBookDeps> = {}) {
  const box: { plan: RunPlan | undefined } = {
    plan: steps ? { goal: 'g', steps, status: 'active', autoContinues: 0, updatedAt: 0 } : undefined
  }
  const book = new StaffingBook({
    project: {},
    rootTier: 'deep',
    tierModels: () => TM,
    adapterEfforts: effortOptionsFor('claude'),
    plan: () => box.plan,
    ...over
  })
  const patch = (id: string, over2: Partial<PlanStep>): void => {
    box.plan = { ...box.plan!, steps: box.plan!.steps.map((s) => (s.id === id ? { ...s, ...over2 } : s)) }
  }
  const replace = (next: PlanStep[]): void => {
    box.plan = { goal: 'g', steps: next, status: 'active', autoContinues: 0, updatedAt: 1 }
  }
  let n = 0
  /** decide + started + ended in one go (the attempt fails unless `failed` is false); returns the decision. */
  const runOnce = (input: Omit<StaffingDecideInput, 'key'>, failed = true) => {
    const key = `k${++n}`
    const d = book.decide({ key, ...input })
    book.started(key, `a${n}`, n)
    book.ended(`a${n}`, { failed })
    return d
  }
  return { book, box, patch, replace, runOnce }
}

/** Internal sizes, for the bounded-memory tests only. */
function sizes(book: StaffingBook) {
  const b = book as unknown as {
    pending: Map<string, unknown>
    agents: Map<string, unknown>
    steps: Map<string, { attempts: unknown[] }>
  }
  return { pending: b.pending.size, agents: b.agents.size, steps: b.steps.size, attempts: (id: string) => b.steps.get(id)?.attempts.length }
}

describe('StaffingBook: no plan', () => {
  it('no plan and no call values: the role resolves to its own setting, no step, not a retry', () => {
    const { book } = setup(undefined)
    const d = book.decide({ key: 'k1', role: DEV })
    expect(d.stepId).toBeUndefined()
    expect(d.retry).toBe(false)
    expect(d.resolved).toMatchObject({ mode: 'auto', tier: 'deep', model: 'opus', effort: 'high', source: 'role', overrides: false })
    expect(d.label).toBe('deep / high (the role\'s setting)')
  })

  it('no plan: values on the call are the request', () => {
    const { book } = setup(undefined)
    const d = book.decide({ key: 'k1', role: DEV, onCall: { tier: 'everyday', effort: 'low' } })
    expect(d.resolved).toMatchObject({ tier: 'everyday', model: 'sonnet', effort: 'low', source: 'orchestrator', overrides: true })
    expect(d.label).toBe('everyday / low (chosen by the orchestrator)')
  })

  it('no plan: a spawn never counts as a retry', () => {
    const { runOnce } = setup(undefined)
    runOnce({ role: DEV })
    const d = runOnce({ role: DEV })
    expect(d.retry).toBe(false)
    expect(d.resolved.source).toBe('role')
  })
})

describe('StaffingBook: binding', () => {
  it('a. binds the first never-attempted step and applies its staff', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'medium' } })])
    const d = book.decide({ key: 'k1', role: DEV })
    expect(d).toMatchObject({ stepId: 'p1', retry: false })
    expect(d.resolved).toMatchObject({ tier: 'everyday', effort: 'medium', source: 'orchestrator' })
  })

  it('a. two decisions in the same tick bind two different ready steps', () => {
    const { book } = setup([
      step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday' } }),
      step('p2', 'dev', { staff: { role: 'dev', tier: 'fast' } })
    ])
    const one = book.decide({ key: 'k1', role: DEV })
    const two = book.decide({ key: 'k2', role: DEV })
    expect([one.stepId, two.stepId]).toEqual(['p1', 'p2'])
    expect([one.resolved.tier, two.resolved.tier]).toEqual(['everyday', 'fast'])
  })

  it('a. a ready step goes before a waiting one; a step for another role is never bound', () => {
    const { book } = setup([
      step('p1', 'qa', { status: 'in_progress' }),
      step('p2', 'dev', { after: ['p1'] }),
      step('p3', 'dev')
    ])
    expect(book.decide({ key: 'k1', role: DEV }).stepId).toBe('p3')
    expect(book.decide({ key: 'k2', role: DEV }).stepId).toBe('p2')
  })

  it('order: never attempted, then retry, then fan-out, then no step', () => {
    const { book } = setup([step('p1', 'dev'), step('p2', 'dev')])
    book.decide({ key: 'k1', role: DEV })
    book.started('k1', 'a1', 1)
    book.ended('a1', { failed: true })
    // p1 has ended, p2 was never attempted: p2 first.
    const two = book.decide({ key: 'k2', role: DEV })
    expect(two).toMatchObject({ stepId: 'p2', retry: false })
    book.started('k2', 'a2', 2)
    // p1 is a retry candidate, p2 is live: the retry first.
    const three = book.decide({ key: 'k3', role: DEV })
    expect(three).toMatchObject({ stepId: 'p1', retry: true })
    book.started('k3', 'a3', 3)
    // Both are live: fan-out onto the first.
    const four = book.decide({ key: 'k4', role: DEV })
    expect(four).toMatchObject({ stepId: 'p1', retry: false })
    expect(four.resolved.source).toBe('role')
    // A role no step names: no step.
    expect(book.decide({ key: 'k5', role: QA }).stepId).toBeUndefined()
  })

  it('c. fan-out: the call wins over the shared step staff field by field', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })])
    book.decide({ key: 'k1', role: DEV })
    const d = book.decide({ key: 'k2', role: DEV, onCall: { effort: 'high' } })
    expect(d).toMatchObject({ stepId: 'p1', retry: false })
    expect(d.resolved).toMatchObject({ tier: 'everyday', effort: 'high', source: 'orchestrator' })
  })

  it('a. values on the call win over the step staff field by field', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })])
    const d = book.decide({ key: 'k1', role: DEV, onCall: { tier: 'fast' } })
    expect(d.resolved).toMatchObject({ tier: 'fast', effort: 'low' })
    const e = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })]).book.decide({ key: 'k1', role: DEV, onCall: { effort: 'medium' } })
    expect(e.resolved).toMatchObject({ tier: 'everyday', effort: 'medium' })
  })

  it('closed steps are ignored without cleanup: done, skipped, blocked', () => {
    const { book, patch, runOnce } = setup([step('p1', 'dev'), step('p2', 'dev')])
    runOnce({ role: DEV })
    patch('p1', { status: 'done' })
    expect(book.decide({ key: 'x1', role: DEV }).stepId).toBe('p2')
    book.cancel('x1')
    patch('p2', { status: 'skipped' })
    const none = book.decide({ key: 'x2', role: DEV })
    expect(none.stepId).toBeUndefined()
    expect(none.retry).toBe(false)
    book.cancel('x2')
    // A done step that is reopened is a retry again.
    patch('p1', { status: 'in_progress' })
    expect(book.decide({ key: 'x3', role: DEV })).toMatchObject({ stepId: 'p1', retry: true })
  })

  it('a step that leaves the plan, or whose id now names another step, is forgotten', () => {
    const { book, replace, patch, runOnce } = setup([step('p1', 'dev')])
    runOnce({ role: DEV })
    // set_plan reuses p1 for another step: a first attempt, not a retry.
    replace([step('p1', 'dev', { title: 'something else' })])
    expect(book.decide({ key: 'x1', role: DEV })).toMatchObject({ stepId: 'p1', retry: false })
    book.started('x1', 'b1', 1)
    book.ended('b1')
    // The step's role is edited to qa: a qa spawn makes a first attempt.
    patch('p1', { staff: { role: 'qa' } })
    expect(book.decide({ key: 'x2', role: QA })).toMatchObject({ stepId: 'p1', retry: false })
    // The plan goes away entirely.
    replace([])
    expect(book.decide({ key: 'x3', role: QA }).stepId).toBeUndefined()
  })
})

describe('StaffingBook: retries', () => {
  const staffed = () => [step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })]

  it('a retry escalates one step at a time and stops at STAFFING_ESCALATIONS_MAX', () => {
    expect(STAFFING_ESCALATIONS_MAX).toBe(2)
    const { runOnce } = setup(staffed())
    expect(runOnce({ role: DEV }).resolved).toMatchObject({ tier: 'everyday', effort: 'low', source: 'orchestrator' })
    // The unchanged step staff is not passed again: the resolver raises effort by one.
    const r1 = runOnce({ role: DEV })
    expect(r1).toMatchObject({ stepId: 'p1', retry: true })
    expect(r1.resolved).toMatchObject({ tier: 'everyday', effort: 'medium', source: 'escalated' })
    expect(r1.label).toBe('everyday / medium (escalated after a failed attempt)')
    const r2 = runOnce({ role: DEV })
    expect(r2.resolved).toMatchObject({ tier: 'everyday', effort: 'high', source: 'escalated' })
    // The limit: the last attempt's values, with a note.
    const r3 = runOnce({ role: DEV })
    expect(r3).toMatchObject({ stepId: 'p1', retry: true })
    expect(r3.resolved).toMatchObject({ tier: 'everyday', effort: 'high' })
    expect(r3.resolved.source).toBe('escalated')
    expect(r3.label).toBe('everyday / high (escalated after a failed attempt)')
    expect(r3.resolved.note).toMatch(/^Retry limit reached/)
    const r4 = runOnce({ role: DEV })
    expect(r4.resolved).toMatchObject({ tier: 'everyday', effort: 'high' })
    expect(r4.resolved.note).toMatch(/^Retry limit reached/)
  })

  it('at the limit a value on the call may lower the last attempt, never raise it', () => {
    const { runOnce } = setup(staffed())
    runOnce({ role: DEV })
    runOnce({ role: DEV })
    runOnce({ role: DEV })
    expect(runOnce({ role: DEV, onCall: { tier: 'deep', effort: 'max' } }).resolved).toMatchObject({ tier: 'everyday', effort: 'high' })
    expect(runOnce({ role: DEV, onCall: { tier: 'fast' } }).resolved).toMatchObject({ tier: 'fast', effort: 'high' })
  })

  it('an edited step staff is passed on a retry (only the changed field)', () => {
    const { runOnce, patch } = setup(staffed())
    runOnce({ role: DEV })
    patch('p1', { staff: { role: 'dev', tier: 'deep', effort: 'low' } })
    const r = runOnce({ role: DEV })
    expect(r.retry).toBe(true)
    // requested { tier: deep } over escalatedFrom everyday / low: one tier step, effort kept.
    expect(r.resolved).toMatchObject({ tier: 'deep', effort: 'low', source: 'escalated' })
  })

  it('an unchanged step staff does not pull an escalated tier back down', () => {
    const { runOnce, patch } = setup(staffed())
    runOnce({ role: DEV })
    patch('p1', { staff: { role: 'dev', tier: 'deep', effort: 'low' } })
    expect(runOnce({ role: DEV }).resolved).toMatchObject({ tier: 'deep', effort: 'low' })
    // Staff unchanged since the last attempt: no request, the effort goes up from deep / low.
    expect(runOnce({ role: DEV }).resolved).toMatchObject({ tier: 'deep', effort: 'medium', source: 'escalated' })
  })

  it('values on the call are passed on a retry', () => {
    const { runOnce } = setup(staffed())
    runOnce({ role: DEV })
    expect(runOnce({ role: DEV, onCall: { tier: 'deep' } }).resolved).toMatchObject({ tier: 'deep', effort: 'low', source: 'escalated' })
  })

  it('a retry waits until every attempt of the step has ended', () => {
    const { book } = setup(staffed())
    book.decide({ key: 'k1', role: DEV })
    book.started('k1', 'a1', 1)
    book.decide({ key: 'k2', role: DEV })
    book.started('k2', 'a2', 2)
    book.ended('a1', { failed: true })
    expect(book.decide({ key: 'k3', role: DEV }).retry).toBe(false)
    book.cancel('k3')
    book.ended('a2', { failed: true })
    expect(book.decide({ key: 'k4', role: DEV }).retry).toBe(true)
  })

  it('a fixed role binds and retries without escalating', () => {
    const { runOnce } = setup([step('p1', 'ops', { staff: { role: 'ops', tier: 'deep' } })])
    const first = runOnce({ role: OPS_FIXED })
    expect(first).toMatchObject({ stepId: 'p1', retry: false })
    expect(first.resolved).toMatchObject({ mode: 'fixed', model: 'claude-sonnet-4-6', effort: 'high', source: 'role', overrides: false })
    expect(first.resolved.note).toMatch(/role is fixed/i)
    const retry = runOnce({ role: OPS_FIXED })
    expect(retry.retry).toBe(true)
    expect(retry.resolved).toMatchObject({ mode: 'fixed', source: 'role', overrides: false })
    expect(retry.resolved.note).toMatch(/not escalated/)
    runOnce({ role: OPS_FIXED })
    const limit = runOnce({ role: OPS_FIXED })
    expect(limit.resolved).toMatchObject({ mode: 'fixed', model: 'claude-sonnet-4-6', effort: 'high' })
    expect(limit.resolved.note).toBe(
      `Retry limit reached (${STAFFING_ESCALATIONS_MAX} escalations on this step), so it runs on the last attempt's tier and effort.`
    )
  })

  it('a fixed project runs every role as configured', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'fast' } })], { project: { staffing: 'fixed' } })
    expect(book.decide({ key: 'k1', role: DEV }).resolved).toMatchObject({ mode: 'fixed', tier: 'deep', model: 'opus', overrides: false })
  })
})

describe('StaffingBook: started, cancel, ended', () => {
  it('started returns the row once; unknown keys give undefined', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday' } })])
    const d = book.decide({ key: 'k1', role: DEV })
    expect(book.started('k1', 'a1', 1234)).toEqual({
      roleId: 'r-dev',
      agentId: 'a1',
      stepId: 'p1',
      tier: 'everyday',
      model: 'sonnet',
      effort: 'high',
      source: 'orchestrator',
      note: d.resolved.note,
      at: 1234
    })
    expect(book.started('k1', 'a1', 2)).toBeUndefined()
    expect(book.started('nope', 'a9', 2)).toBeUndefined()
    expect(book.tierOf('a1')).toBe('everyday')
  })

  it('a row without a step has no stepId', () => {
    const { book } = setup(undefined)
    book.decide({ key: 'k1', role: QA })
    expect(book.started('k1', 'a1', 5)).toEqual({ roleId: 'r-qa', agentId: 'a1', tier: 'everyday', model: 'sonnet', effort: 'medium', source: 'role', at: 5 })
  })

  it('cancel of a first attempt leaves the step unattempted', () => {
    const { book } = setup([step('p1', 'dev')])
    expect(book.decide({ key: 'k1', role: DEV }).stepId).toBe('p1')
    book.cancel('k1')
    expect(book.started('k1', 'a1', 1)).toBeUndefined()
    expect(book.decide({ key: 'k2', role: DEV })).toMatchObject({ stepId: 'p1', retry: false })
  })

  it('cancel of a retry does not count toward the limit', () => {
    const { book, runOnce } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })])
    runOnce({ role: DEV })
    runOnce({ role: DEV }) // retry 1: medium
    expect(book.decide({ key: 'c1', role: DEV }).resolved.effort).toBe('high')
    book.cancel('c1')
    expect(book.decide({ key: 'c2', role: DEV }).resolved.effort).toBe('high')
    book.cancel('c2')
    // Still escalating (the cancelled ones did not count), then the limit.
    expect(runOnce({ role: DEV }).resolved).toMatchObject({ effort: 'high', source: 'escalated' })
    expect(runOnce({ role: DEV }).resolved.note).toMatch(/^Retry limit reached/)
  })

  it('cancel of a fan-out leaves the live attempt as the last one', () => {
    const { book } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })])
    book.decide({ key: 'k1', role: DEV })
    book.started('k1', 'a1', 1)
    expect(book.decide({ key: 'k2', role: DEV, onCall: { effort: 'high' } })).toMatchObject({ stepId: 'p1', retry: false })
    book.cancel('k2')
    book.ended('a1', { failed: true })
    // The retry escalates from a1 (everyday / low), not from the cancelled everyday / high.
    expect(book.decide({ key: 'k3', role: DEV }).resolved).toMatchObject({ tier: 'everyday', effort: 'medium', source: 'escalated' })
  })

  it('cancel after started, or of an unknown key, does nothing', () => {
    const { book } = setup([step('p1', 'dev')])
    book.decide({ key: 'k1', role: DEV })
    book.started('k1', 'a1', 1)
    book.cancel('k1')
    book.cancel('nope')
    expect(book.tierOf('a1')).toBe('deep')
    // p1 is still attempted (live): the next spawn fans out.
    expect(book.decide({ key: 'k2', role: DEV })).toMatchObject({ stepId: 'p1', retry: false })
  })

  it('deciding again under a pending key replaces the earlier decision', () => {
    const { book } = setup([step('p1', 'dev'), step('p2', 'dev')])
    book.decide({ key: 'k1', role: DEV })
    expect(book.decide({ key: 'k1', role: DEV }).stepId).toBe('p1')
    expect(book.decide({ key: 'k2', role: DEV }).stepId).toBe('p2')
  })

  it('ended on an unknown agent does nothing', () => {
    const { book } = setup([step('p1', 'dev')])
    book.ended('ghost')
    expect(book.decide({ key: 'k1', role: DEV }).stepId).toBe('p1')
  })
})

describe('StaffingBook: parent tier', () => {
  it("tierOf feeds an inherit child's ceiling: a child never exceeds its parent's resolved tier", () => {
    const { book } = setup(undefined)
    book.decide({ key: 'k1', role: DEV, onCall: { tier: 'everyday' } })
    book.started('k1', 'a1', 1)
    expect(book.tierOf('a1')).toBe('everyday')
    const child = book.decide({ key: 'k2', role: HELPER, parentAgentId: 'a1', onCall: { tier: 'deep' } })
    expect(child.resolved).toMatchObject({ mode: 'auto', tier: 'everyday', model: 'sonnet', source: 'clamped' })
    const plain = book.decide({ key: 'k3', role: HELPER, parentAgentId: 'a1' })
    expect(plain.resolved).toMatchObject({ tier: 'everyday', source: 'role', overrides: false })
  })

  it('no parent agent: the root tier; an unknown parent: no tier (runs as configured)', () => {
    const { book } = setup(undefined, { rootTier: 'deep' })
    expect(book.decide({ key: 'k1', role: HELPER }).resolved).toMatchObject({ mode: 'auto', tier: 'deep' })
    const unknown = book.decide({ key: 'k2', role: HELPER, parentAgentId: 'ghost', onCall: { tier: 'fast' } })
    expect(unknown.resolved).toMatchObject({ mode: 'fixed', model: 'inherit', source: 'role' })
    expect(unknown.resolved.tier).toBeUndefined()
    expect(setup(undefined, { rootTier: undefined }).book.decide({ key: 'k1', role: HELPER }).resolved.mode).toBe('fixed')
  })

  it('tierOf survives the agent ending (until the cap) and is undefined before started', () => {
    const { book } = setup(undefined)
    book.decide({ key: 'k1', role: QA })
    expect(book.tierOf('a1')).toBeUndefined()
    book.started('k1', 'a1', 1)
    book.ended('a1')
    expect(book.tierOf('a1')).toBe('everyday')
  })
})

describe('StaffingBook: pass-through', () => {
  it('the plan guard reaches the resolver', () => {
    const { book } = setup([step('p1', 'dev')])
    const d = book.decide({ key: 'k1', role: DEV, planGuard: true })
    expect(d.resolved).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'plan-guard', overrides: true })
    expect(d.label).toBe('everyday / high (usage guard)')
  })

  it('the profile is asked by role id and used when nothing is requested', () => {
    const asked: string[] = []
    const { book } = setup(undefined, {
      profile: (roleId) => {
        asked.push(roleId)
        return { tier: 'everyday', effort: 'medium' }
      }
    })
    expect(book.decide({ key: 'k1', role: DEV }).resolved).toMatchObject({ tier: 'everyday', effort: 'medium', source: 'profile' })
    expect(asked).toEqual(['r-dev'])
  })

  it('tierModels is read at every decision', () => {
    let tm: Partial<Record<ModelTier, string>> = TM
    const { book } = setup(undefined, { tierModels: () => tm })
    expect(book.decide({ key: 'k1', role: DEV }).resolved.model).toBe('opus')
    tm = { ...TM, deep: 'opus-next' }
    expect(book.decide({ key: 'k2', role: DEV }).resolved.model).toBe('opus-next')
  })

  it('the adapter efforts reach the resolver', () => {
    const { book } = setup(undefined, { adapterEfforts: [] })
    expect(book.decide({ key: 'k1', role: DEV }).resolved.effort).toBeUndefined()
  })
})

describe('StaffingBook: bounded memory', () => {
  it(`keeps at most ${STAFFING_BOOK_STEP_ATTEMPTS_MAX} attempts per step, always the newest`, () => {
    const { book, runOnce } = setup([step('p1', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } })])
    for (let i = 0; i < STAFFING_BOOK_STEP_ATTEMPTS_MAX + 15; i++) runOnce({ role: DEV })
    expect(sizes(book).attempts('p1')).toBe(STAFFING_BOOK_STEP_ATTEMPTS_MAX)
    // The escalation count and the last attempt survive the trimming.
    const d = runOnce({ role: DEV })
    expect(d.resolved).toMatchObject({ tier: 'everyday', effort: 'high' })
    expect(d.resolved.note).toMatch(/^Retry limit reached/)
  })

  it(`keeps at most ${STAFFING_BOOK_AGENTS_MAX} agents, dropping the oldest ended and never a live one`, () => {
    const { book, runOnce } = setup(undefined)
    book.decide({ key: 'live', role: QA })
    book.started('live', 'live-agent', 0)
    for (let i = 0; i < STAFFING_BOOK_AGENTS_MAX + 50; i++) runOnce({ role: DEV })
    expect(sizes(book).agents).toBe(STAFFING_BOOK_AGENTS_MAX)
    expect(book.tierOf('live-agent')).toBe('everyday')
    expect(book.tierOf('a1')).toBeUndefined()
    expect(book.tierOf(`a${STAFFING_BOOK_AGENTS_MAX + 50}`)).toBe('deep')
  })

  it(`keeps at most ${STAFFING_BOOK_PENDING_MAX} pending decisions, cancelling the oldest`, () => {
    const { book } = setup([step('p1', 'dev')])
    for (let i = 0; i <= STAFFING_BOOK_PENDING_MAX; i++) book.decide({ key: `k${i}`, role: DEV })
    expect(sizes(book).pending).toBe(STAFFING_BOOK_PENDING_MAX)
    expect(book.started('k0', 'a0', 0)).toBeUndefined()
    expect(book.started(`k${STAFFING_BOOK_PENDING_MAX}`, 'aN', 0)).toBeDefined()
  })

  it(`keeps at most ${STAFFING_BOOK_STEPS_MAX} steps, dropping closed ended steps first, least recently touched first`, () => {
    const count = STAFFING_BOOK_STEPS_MAX + 20
    const { book, patch, runOnce } = setup(Array.from({ length: count }, (_, i) => step(`p${i + 1}`, 'dev')))
    for (let i = 0; i < count; i++) {
      expect(runOnce({ role: DEV }).stepId).toBe(`p${i + 1}`)
      // p1 stays open (its attempt ended without finishing it); every other step is done.
      if (i > 0) patch(`p${i + 1}`, { status: 'done' })
    }
    expect(sizes(book).steps).toBe(STAFFING_BOOK_STEPS_MAX)
    // p2 (closed, oldest) was forgotten: reopened, it counts as never attempted.
    patch('p2', { status: 'pending' })
    expect(book.decide({ key: 'x1', role: DEV })).toMatchObject({ stepId: 'p2', retry: false })
    book.cancel('x1')
    patch('p2', { status: 'done' })
    // p1 (open, older still) was kept: a retry.
    expect(book.decide({ key: 'x2', role: DEV })).toMatchObject({ stepId: 'p1', retry: true })
  })
})

describe('StaffingBook: failed versus finished attempts, and the escalation count', () => {
  const ENG: BookRole = { id: 'r-eng', slug: 'engineer', model: 'sonnet', tier: 'everyday', staffing: { mode: 'auto', maxEffort: 'max' } }
  const stepLow = (title = 'Implement'): PlanStep => ({ id: 'p1', title, status: 'in_progress', staff: { role: 'engineer', effort: 'low' } })

  it('B1 a re-spawn after an attempt that ended without failure is a plain new attempt, not an escalation', () => {
    const { book, runOnce } = setup([stepLow()])
    const first = runOnce({ role: ENG }, false)
    expect(first.resolved.effort).toBe('low')
    const second = book.decide({ key: 'again', role: ENG })
    expect(second).toMatchObject({ stepId: 'p1', retry: false })
    expect(second.resolved.effort).toBe('low')
    expect(second.resolved.source).not.toBe('escalated')
  })

  it('a plain new attempt takes the pick on the call, else the step staff, and never counts as an escalation', () => {
    const { book, runOnce } = setup([stepLow()])
    runOnce({ role: ENG }, false)
    expect(runOnce({ role: ENG, onCall: { effort: 'high' } }, false).resolved).toMatchObject({ effort: 'high', source: 'orchestrator' })
    // Then failures: both escalations are still available, so the step has not used any.
    expect(runOnce({ role: ENG }, true).resolved.effort).toBe('low')
    expect(runOnce({ role: ENG }).resolved).toMatchObject({ effort: 'medium', source: 'escalated' })
    expect(runOnce({ role: ENG }).resolved).toMatchObject({ effort: 'high', source: 'escalated' })
    expect(runOnce({ role: ENG }).resolved.note).toMatch(/^Retry limit reached/)
  })

  it('a re-spawn after a failed attempt escalates one step', () => {
    const { runOnce } = setup([stepLow()])
    runOnce({ role: ENG }, true)
    const d = runOnce({ role: ENG }, true)
    expect(d).toMatchObject({ retry: true })
    expect(d.resolved).toMatchObject({ effort: 'medium', source: 'escalated' })
  })

  it('an attempt that fails and a later one that succeeds: the next spawn is plain again, on the escalated values', () => {
    const { book, runOnce } = setup([stepLow()])
    runOnce({ role: ENG }, true) // low, fails
    expect(runOnce({ role: ENG }, false).resolved.effort).toBe('medium') // escalated, succeeds
    const third = book.decide({ key: 'k3', role: ENG })
    expect(third.retry).toBe(false)
    expect(third.resolved.source).not.toBe('escalated')
    expect(third.resolved.effort).toBe('low') // the step's own staff again; nothing raised
  })

  it('plain attempts still count toward the attempts cap', () => {
    const { book, runOnce } = setup([stepLow()])
    for (let i = 0; i < STAFFING_BOOK_STEP_ATTEMPTS_MAX + 3; i++) runOnce({ role: ENG }, false)
    const b = book as unknown as { steps: Map<string, { attempts: unknown[] }> }
    expect(b.steps.get('p1')!.attempts.length).toBe(STAFFING_BOOK_STEP_ATTEMPTS_MAX)
  })

  it('a cancelled spawn gives back its step (and an escalation it would have used)', () => {
    const { book, runOnce } = setup([stepLow()])
    runOnce({ role: ENG }, true)
    book.decide({ key: 'c1', role: ENG }) // retry 1, cancelled
    book.cancel('c1')
    expect(runOnce({ role: ENG }, true).resolved).toMatchObject({ effort: 'medium', source: 'escalated' })
    expect(runOnce({ role: ENG }, true).resolved).toMatchObject({ effort: 'high', source: 'escalated' })
  })

  it('B2 retitling the step, or switching its role and back, does not reset the escalation limit', () => {
    const { box, patch, runOnce } = setup([stepLow()])
    const efforts: (string | undefined)[] = []
    const attempt = () => efforts.push(runOnce({ role: ENG }, true).resolved.effort)
    attempt() // low
    attempt() // medium (escalation 1)
    attempt() // high (escalation 2)
    attempt() // high (limit)
    box.plan = { ...box.plan!, steps: [{ ...stepLow('Implement it'), staff: { role: 'engineer', effort: 'high' } }] } // same id, new title
    attempt() // first attempt of the changed step: high
    attempt() // still at the limit: not raised
    patch('p1', { staff: { role: 'other', effort: 'high' } })
    attempt() // a spawn of another role in between would be a different role; here none matches, so no step
    patch('p1', { staff: { role: 'engineer', effort: 'high' } })
    attempt()
    attempt()
    expect(efforts.slice(0, 4)).toEqual(['low', 'medium', 'high', 'high'])
    expect(efforts).not.toContain('xhigh')
    expect(efforts).not.toContain('max')
  })

  it('the escalation count lasts while the id is in the plan and goes with the step', () => {
    const { replace, runOnce } = setup([stepLow()])
    runOnce({ role: ENG }, true)
    runOnce({ role: ENG }, true)
    runOnce({ role: ENG }, true)
    replace([{ id: 'p2', title: 'Other', status: 'pending', staff: { role: 'engineer', effort: 'low' } }])
    runOnce({ role: ENG }, true) // forces the book to see the plan without p1
    replace([stepLow()]) // p1 is a new step now
    expect(runOnce({ role: ENG }, true).resolved.effort).toBe('low')
    expect(runOnce({ role: ENG }, true).resolved).toMatchObject({ effort: 'medium', source: 'escalated' })
  })

  it('the escalation counts are bounded', () => {
    const { book, replace, runOnce } = setup([])
    const steps: PlanStep[] = Array.from({ length: STAFFING_BOOK_STEPS_MAX + 20 }, (_, i) => ({ id: `s${i}`, title: `t${i}`, status: 'pending' as const, staff: { role: 'engineer' } }))
    replace(steps)
    for (let i = 0; i < steps.length; i++) {
      runOnce({ role: ENG }, true)
      runOnce({ role: ENG }, true)
    }
    expect((book as unknown as { escalations: Map<string, number> }).escalations.size).toBeLessThanOrEqual(STAFFING_BOOK_STEPS_MAX)
  })
})
