import { describe, expect, it } from 'vitest'
import {
  PLAN_STEP_AFTER_MAX,
  PLAN_STEP_PATHS_MAX,
  PLAN_STEP_PATH_MAX_CHARS,
  RUN_STAFFING_ASSIGNMENTS_MAX,
  STAFFING_NOTE_MAX_CHARS,
  cleanPlanStepGraph,
  cleanPlanStepStaff,
  cleanRoleStaffing,
  cleanRunStaffing,
  cleanStaffingAssignment,
  compareEffort,
  compareTier,
  effectiveRoleStaffing,
  lowerEffort,
  lowerTier,
  reviewPolicyOf,
  staffingGoalOf,
  staffingModeOf
} from './defaults'
import { EFFORTS, MODEL_TIERS, isEffort, isReviewPolicy, isStaffingGoal, isStaffingMode, isStaffingSource } from './types'
import type { PlanStep, Role, RunEvent, RunRecord, RunStaffing, StaffingAssignment } from './types'

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({ id, title: `Step ${id}`, status: 'pending', ...over })
const afterOf = (steps: PlanStep[]): Record<string, string[] | undefined> => Object.fromEntries(steps.map((s) => [s.id, s.after]))
const row = (over: Partial<StaffingAssignment> = {}): StaffingAssignment => ({ roleId: 'r-eng', model: 'sonnet', source: 'role', at: 1, ...over })

describe('staffing enums', () => {
  it('guards every value and nothing else', () => {
    for (const v of ['balanced', 'speed', 'cost']) expect(isStaffingGoal(v)).toBe(true)
    for (const v of ['always', 'risk', 'never']) expect(isReviewPolicy(v)).toBe(true)
    for (const v of ['auto', 'fixed']) expect(isStaffingMode(v)).toBe(true)
    for (const v of ['orchestrator', 'profile', 'role', 'clamped', 'plan-guard', 'escalated']) expect(isStaffingSource(v)).toBe(true)
    for (const v of EFFORTS) expect(isEffort(v)).toBe(true)
    for (const junk of ['', 'BALANCED', 'fast', 1, null, undefined, {}, ['auto']]) {
      expect(isStaffingGoal(junk)).toBe(false)
      expect(isReviewPolicy(junk)).toBe(false)
      expect(isStaffingMode(junk)).toBe(false)
      expect(isStaffingSource(junk)).toBe(false)
      expect(isEffort(junk)).toBe(false)
    }
  })
})

describe('tier and effort order', () => {
  it('orders tiers fast < everyday < deep < top', () => {
    expect(compareTier('top', 'fast')).toBeGreaterThan(0)
    expect(compareTier('everyday', 'deep')).toBeLessThan(0)
    expect(compareTier('deep', 'deep')).toBe(0)
    const sorted = [...MODEL_TIERS].sort(compareTier)
    expect(sorted).toEqual(['fast', 'everyday', 'deep', 'top'])
    expect(lowerTier('deep', 'everyday')).toBe('everyday')
    expect(lowerTier('fast', 'top')).toBe('fast')
    expect(lowerTier('deep', 'deep')).toBe('deep')
  })

  it('orders efforts low < medium < high < xhigh < max', () => {
    expect([...EFFORTS].reverse().sort(compareEffort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(compareEffort('max', 'low')).toBeGreaterThan(0)
    expect(compareEffort('medium', 'medium')).toBe(0)
    expect(lowerEffort('high', 'medium')).toBe('medium')
    expect(lowerEffort('low', 'xhigh')).toBe('low')
  })
})

describe('cleanRoleStaffing', () => {
  it('keeps a valid value and drops unknown members and keys', () => {
    expect(cleanRoleStaffing({ mode: 'auto', minTier: 'everyday', maxEffort: 'high' })).toEqual({ mode: 'auto', minTier: 'everyday', maxEffort: 'high' })
    expect(cleanRoleStaffing({ mode: 'fixed' })).toEqual({ mode: 'fixed' })
    expect(cleanRoleStaffing({ mode: 'auto', minTier: 'huge', maxEffort: 'ultra', extra: 1 })).toEqual({ mode: 'auto' })
  })

  it('drops a malformed value whole', () => {
    for (const junk of [undefined, null, 'auto', 3, [], ['auto'], {}, { mode: 'sometimes', minTier: 'fast' }, { minTier: 'fast' }]) {
      expect(cleanRoleStaffing(junk)).toBeUndefined()
    }
  })
})

describe('project staffing defaults', () => {
  it('staffingModeOf: fixed only when set, else auto', () => {
    expect(staffingModeOf({ staffing: 'fixed' })).toBe('fixed')
    expect(staffingModeOf({ staffing: 'auto' })).toBe('auto')
    expect(staffingModeOf({})).toBe('auto')
    expect(staffingModeOf(null)).toBe('auto')
    expect(staffingModeOf({ staffing: 'nope' as never })).toBe('auto')
  })

  it('staffingGoalOf: a valid override, else the project, else balanced', () => {
    expect(staffingGoalOf({})).toBe('balanced')
    expect(staffingGoalOf(undefined)).toBe('balanced')
    expect(staffingGoalOf({ staffingGoal: 'cost' })).toBe('cost')
    expect(staffingGoalOf({ staffingGoal: 'cost' }, 'speed')).toBe('speed')
    expect(staffingGoalOf({ staffingGoal: 'cost' }, 'fastest')).toBe('cost')
    expect(staffingGoalOf({ staffingGoal: 'junk' as never }, undefined)).toBe('balanced')
    expect(staffingGoalOf(null, 'speed')).toBe('speed')
  })

  it('reviewPolicyOf: risk unless a known value is set', () => {
    expect(reviewPolicyOf({})).toBe('risk')
    expect(reviewPolicyOf(null)).toBe('risk')
    expect(reviewPolicyOf({ reviewPolicy: 'always' })).toBe('always')
    expect(reviewPolicyOf({ reviewPolicy: 'never' })).toBe('never')
    expect(reviewPolicyOf({ reviewPolicy: 'sometimes' as never })).toBe('risk')
  })
})

describe('effectiveRoleStaffing', () => {
  const r = (over: Partial<Role>): Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'> => ({ model: 'everyday', tier: 'everyday', ...over })

  it('a tiered role is auto with its tier and effort as the ceiling', () => {
    expect(effectiveRoleStaffing(r({ model: 'claude-sonnet-4-5', tier: 'everyday', effort: 'high' }), {})).toEqual({ mode: 'auto', maxTier: 'everyday', maxEffort: 'high' })
    expect(effectiveRoleStaffing(r({ model: 'deep', tier: 'deep' }), {})).toEqual({ mode: 'auto', maxTier: 'deep' })
  })

  it('a project set to fixed makes every role fixed, even an explicit auto role', () => {
    expect(effectiveRoleStaffing(r({ staffing: { mode: 'auto' } }), { staffing: 'fixed' }).mode).toBe('fixed')
    expect(effectiveRoleStaffing(r({}), { staffing: 'fixed' })).toEqual({ mode: 'fixed', maxTier: 'everyday' })
  })

  it('the role\'s explicit mode wins over the default', () => {
    expect(effectiveRoleStaffing(r({ staffing: { mode: 'fixed' } }), {}).mode).toBe('fixed')
    expect(effectiveRoleStaffing(r({ model: 'gpt-5.1-codex', tier: undefined, staffing: { mode: 'auto' } }), {}).mode).toBe('auto')
  })

  it('with no explicit mode, a concrete model with no tier is fixed (an explicit pick)', () => {
    expect(effectiveRoleStaffing({ model: 'claude-opus-4-1' }, {})).toEqual({ mode: 'fixed' })
    expect(effectiveRoleStaffing({ model: 'claude-opus-4-1', effort: 'low' }, null)).toEqual({ mode: 'fixed', maxEffort: 'low' })
    // A tier name, a legacy alias or 'inherit' is not a concrete pick.
    expect(effectiveRoleStaffing({ model: 'deep' }, {}).mode).toBe('auto')
    expect(effectiveRoleStaffing({ model: 'opus' }, {}).mode).toBe('auto')
    expect(effectiveRoleStaffing({ model: 'inherit' }, {}).mode).toBe('auto')
    expect(effectiveRoleStaffing({ model: '' }, {}).mode).toBe('auto')
  })

  it('maxEffort is staffing.maxEffort, else the role\'s effort', () => {
    expect(effectiveRoleStaffing(r({ effort: 'medium', staffing: { mode: 'auto', maxEffort: 'xhigh' } }), {}).maxEffort).toBe('xhigh')
    expect(effectiveRoleStaffing(r({ effort: 'medium', staffing: { mode: 'auto' } }), {}).maxEffort).toBe('medium')
    expect(effectiveRoleStaffing(r({ effort: 'bogus' as never }), {}).maxEffort).toBeUndefined()
  })

  it('minTier is kept at or below the ceiling and dropped above it', () => {
    expect(effectiveRoleStaffing(r({ tier: 'deep', staffing: { mode: 'auto', minTier: 'everyday' } }), {}).minTier).toBe('everyday')
    expect(effectiveRoleStaffing(r({ tier: 'deep', staffing: { mode: 'auto', minTier: 'deep' } }), {}).minTier).toBe('deep')
    expect(effectiveRoleStaffing(r({ tier: 'everyday', staffing: { mode: 'auto', minTier: 'top' } }), {}).minTier).toBeUndefined()
  })

  it('an inherit role has no tier ceiling and keeps its floor (the resolver resolves it from the parent)', () => {
    expect(effectiveRoleStaffing({ model: 'inherit', staffing: { mode: 'auto', minTier: 'deep' } }, {})).toEqual({ mode: 'auto', minTier: 'deep' })
  })

  it('reads a malformed role staffing as absent', () => {
    expect(effectiveRoleStaffing({ model: 'claude-opus-4-1', staffing: { mode: 'never' } as never }, {}).mode).toBe('fixed')
    expect(effectiveRoleStaffing(r({ effort: 'low', staffing: 'auto' as never }), {})).toEqual({ mode: 'auto', maxTier: 'everyday', maxEffort: 'low' })
  })
})

describe('cleanPlanStepGraph', () => {
  it('leaves a plan without graph fields as it was (new objects, same content)', () => {
    const steps = [step('p1', { owner: 'lead', note: 'n' }), step('p2', { status: 'done' })]
    const out = cleanPlanStepGraph(steps)
    expect(out).toEqual(steps)
    expect(out[0]).not.toBe(steps[0])
  })

  it('keeps only ids of other steps, deduplicated, and removes an empty list', () => {
    const steps = [
      step('p1', { after: ['p1', 'p9', 'p2', 'p2', 3 as never, '', 'p3'] }),
      step('p2', { after: [] }),
      step('p3', { after: 'p1' as never })
    ]
    const out = cleanPlanStepGraph(steps)
    expect(afterOf(out)).toEqual({ p1: ['p2', 'p3'], p2: undefined, p3: undefined })
    expect('after' in out[1]).toBe(false)
    // The input is not changed.
    expect(steps[0].after).toHaveLength(7)
  })

  it('caps after at PLAN_STEP_AFTER_MAX valid ids', () => {
    const many = Array.from({ length: PLAN_STEP_AFTER_MAX + 5 }, (_, i) => step(`q${i}`))
    const first = step('p0', { after: ['nope', ...many.map((s) => s.id)] })
    const out = cleanPlanStepGraph([first, ...many])
    expect(out[0].after).toEqual(many.slice(0, PLAN_STEP_AFTER_MAX).map((s) => s.id))
  })

  it('breaks a two-step cycle: the earlier step stops waiting for the later one', () => {
    const out = cleanPlanStepGraph([step('p1', { after: ['p2'] }), step('p2', { after: ['p1'] })])
    expect(afterOf(out)).toEqual({ p1: undefined, p2: ['p1'] })
  })

  it('breaks a longer cycle deterministically and keeps the rest of the graph', () => {
    const steps = [step('p1', { after: ['p3'] }), step('p2', { after: ['p1'] }), step('p3', { after: ['p2'] }), step('p4', { after: ['p1', 'p3'] })]
    const out = cleanPlanStepGraph(steps)
    expect(afterOf(out)).toEqual({ p1: undefined, p2: ['p1'], p3: ['p2'], p4: ['p1', 'p3'] })
    expect(cleanPlanStepGraph(steps)).toEqual(out)
    // Already acyclic: unchanged on a second pass.
    expect(cleanPlanStepGraph(out)).toEqual(out)
  })

  it('breaks every cycle in a tangled graph and never throws', () => {
    const steps = [
      step('a', { after: ['b', 'c'] }),
      step('b', { after: ['c', 'a'] }),
      step('c', { after: ['a', 'b'] }),
      step('d', { after: ['d', 'e'] }),
      step('e', { after: ['d'] })
    ]
    const out = cleanPlanStepGraph(steps)
    // No cycle remains: a topological order exists.
    const waits = new Map(out.map((s) => [s.id, s.after ?? []]))
    const done = new Set<string>()
    for (let round = 0; round < out.length; round++) {
      for (const [id, deps] of waits) if (!done.has(id) && deps.every((d) => done.has(d))) done.add(id)
    }
    expect(done.size).toBe(out.length)
  })

  it('treats the first step holding a duplicate id as the one it names', () => {
    const out = cleanPlanStepGraph([step('p1'), step('p1', { after: ['p1'] }), step('p2', { after: ['p1'] })])
    expect(out[1].after).toBeUndefined()
    expect(out[2].after).toEqual(['p1'])
  })

  it('handles a long chain without recursion limits', () => {
    const n = 20_000
    const steps = Array.from({ length: n }, (_, i) => step(`s${i}`, i ? { after: [`s${i - 1}`] } : { after: [`s${n - 1}`] }))
    const out = cleanPlanStepGraph(steps)
    expect(out[0].after).toBeUndefined()
    expect(out[n - 1].after).toEqual([`s${n - 2}`])
  })

  it('cleans paths: trimmed, empty, control and over-long entries dropped, deduplicated, capped', () => {
    const long = 'a'.repeat(PLAN_STEP_PATH_MAX_CHARS + 1)
    const ok = 'b'.repeat(PLAN_STEP_PATH_MAX_CHARS)
    const out = cleanPlanStepGraph([step('p1', { paths: ['  src/a.ts ', 'src/a.ts', '', '   ', 7 as never, long, ok, 'bad\npath', 'bad\u0000'] })])
    expect(out[0].paths).toEqual(['src/a.ts', ok])
    const many = Array.from({ length: PLAN_STEP_PATHS_MAX + 3 }, (_, i) => `f${i}`)
    expect(cleanPlanStepGraph([step('p1', { paths: many })])[0].paths).toEqual(many.slice(0, PLAN_STEP_PATHS_MAX))
    const none = cleanPlanStepGraph([step('p1', { paths: ['', '  '] }), step('p2', { paths: 'src' as never })])
    expect('paths' in none[0]).toBe(false)
    expect('paths' in none[1]).toBe(false)
  })

  it('keeps staff only with a non-empty role and drops an unknown tier or effort', () => {
    const out = cleanPlanStepGraph([
      step('p1', { staff: { role: ' implementer ', tier: 'everyday', effort: 'medium' } }),
      step('p2', { staff: { role: 'reviewer', tier: 'giant' as never, effort: 'ultra' as never } }),
      step('p3', { staff: { role: '  ' } }),
      step('p4', { staff: { tier: 'fast' } as never }),
      step('p5', { staff: 'implementer' as never })
    ])
    expect(out.map((s) => s.staff)).toEqual([{ role: 'implementer', tier: 'everyday', effort: 'medium' }, { role: 'reviewer' }, undefined, undefined, undefined])
    expect(cleanPlanStepStaff({ role: 'x', extra: true })).toEqual({ role: 'x' })
  })

  it('passes junk entries through and returns [] for a non-array', () => {
    const junk = [null, 'p0', step('p1', { after: ['p0'] })] as unknown as PlanStep[]
    const out = cleanPlanStepGraph(junk)
    expect(out[0]).toBeNull()
    expect(out[1]).toBe('p0')
    expect(out[2].after).toBeUndefined()
    expect(cleanPlanStepGraph(undefined as never)).toEqual([])
  })
})

describe('cleanStaffingAssignment and cleanRunStaffing', () => {
  it('keeps a valid row with its optional members', () => {
    const full = row({ agentId: 'a1', stepId: 'p1', tier: 'everyday', effort: 'medium', source: 'clamped', note: ' capped by the role ', at: 5 })
    expect(cleanStaffingAssignment(full)).toEqual({ ...full, note: 'capped by the role' })
  })

  it('drops a malformed row and unknown optional members', () => {
    for (const bad of [null, 'x', [], row({ roleId: '' }), row({ model: 3 as never }), row({ source: 'magic' as never }), row({ at: -1 }), row({ at: Number.NaN }), { ...row(), at: undefined }]) {
      expect(cleanStaffingAssignment(bad)).toBeUndefined()
    }
    expect(cleanStaffingAssignment({ ...row(), agentId: '', stepId: 4, tier: 'huge', effort: 'ultra', note: '   ', extra: 1 })).toEqual(row())
  })

  it('cuts a long note at a character boundary', () => {
    const note = `${'n'.repeat(STAFFING_NOTE_MAX_CHARS - 1)}😀tail`
    expect(cleanStaffingAssignment(row({ note }))!.note).toBe('n'.repeat(STAFFING_NOTE_MAX_CHARS - 1))
  })

  it('reads an unknown goal as balanced and a non-object as nothing', () => {
    expect(cleanRunStaffing({ goal: 'speed', assignments: [row()] })).toEqual({ goal: 'speed', assignments: [row()] })
    expect(cleanRunStaffing({ goal: 'fastest', assignments: [] })).toEqual({ goal: 'balanced', assignments: [] })
    expect(cleanRunStaffing({})).toEqual({ goal: 'balanced', assignments: [] })
    expect(cleanRunStaffing({ goal: 'cost', assignments: 'lots' })).toEqual({ goal: 'cost', assignments: [] })
    for (const junk of [undefined, null, 'cost', 1, []]) expect(cleanRunStaffing(junk)).toBeUndefined()
  })

  it('drops malformed rows and keeps the newest RUN_STAFFING_ASSIGNMENTS_MAX', () => {
    const rows: unknown[] = Array.from({ length: RUN_STAFFING_ASSIGNMENTS_MAX + 10 }, (_, i) => row({ at: i }))
    rows.splice(3, 0, { roleId: 'x' }, null)
    const out = cleanRunStaffing({ goal: 'balanced', assignments: rows })!
    expect(out.assignments).toHaveLength(RUN_STAFFING_ASSIGNMENTS_MAX)
    expect(out.assignments[0].at).toBe(10)
    expect(out.assignments.at(-1)!.at).toBe(RUN_STAFFING_ASSIGNMENTS_MAX + 9)
  })
})

describe('run staffing contract is structured-clone safe', () => {
  it('round-trips the record, the event and the plan graph fields unchanged', () => {
    const staffing: RunStaffing = { goal: 'cost', assignments: [row({ agentId: 'a1', stepId: 'p1', tier: 'fast', effort: 'low', source: 'plan-guard', note: 'near the limit' })] }
    const record: RunRecord = {
      summary: { id: 'r1', projectId: 'p1', kind: 'work', prompt: 'x', status: 'finished', startedAt: 1, totalCostUsd: 0, overrides: { goal: 'speed' } },
      agents: {},
      transcript: [],
      logs: [],
      plan: { goal: 'g', status: 'active', autoContinues: 0, updatedAt: 1, steps: [step('p1', { after: [], paths: ['src'], staff: { role: 'implementer', tier: 'everyday', effort: 'medium' } })] },
      staffing
    }
    const event: RunEvent = { type: 'staffing.updated', runId: 'r1', staffing }
    expect(structuredClone(record)).toEqual(record)
    expect(structuredClone(event)).toEqual(event)
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })
})
