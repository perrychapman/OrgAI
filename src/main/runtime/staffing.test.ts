import { describe, expect, it } from 'vitest'
import { compareEffort, compareTier, effortOptionsFor, RUN_STAFFING_ASSIGNMENTS_MAX, settingTier, STAFFING_NOTE_MAX_CHARS } from '@shared/defaults'
import { EFFORTS, MODEL_TIERS, type Effort, type ModelTier, type PlanStep, type Role, type RunPlan, type RunStaffing, type StaffingAssignment } from '@shared/types'
import {
  appendStaffing,
  CLAUDE_TIER_ALIAS,
  enforcedStaffingFloor,
  isDeepOrTopModelRef,
  recordStaffing,
  resolveStaffing,
  roleModelTier,
  staffingAssignment,
  staffingLabel,
  staffRequestForSpawn,
  type ResolveStaffingInput,
  type StaffingRequest
} from './staffing'

type R = Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'>

const TM: Partial<Record<ModelTier, string>> = { top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' }
const CLAUDE = effortOptionsFor('claude')
const CODEX = effortOptionsFor('codex')
const DEEP: R = { model: 'opus', tier: 'deep', effort: 'high' }
const EVERYDAY: R = { model: 'sonnet', tier: 'everyday' }

function run(over: Partial<ResolveStaffingInput> = {}) {
  return resolveStaffing({ role: DEEP, project: {}, tierModels: TM, adapterEfforts: CLAUDE, ...over })
}

describe('CLAUDE_TIER_ALIAS', () => {
  it('maps every tier to its alias and agrees with defaults.ts CLAUDE_ALIAS_TIERS (through settingTier)', () => {
    expect(CLAUDE_TIER_ALIAS).toEqual({ top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' })
    for (const t of MODEL_TIERS) expect(settingTier(CLAUDE_TIER_ALIAS[t])).toBe(t)
  })
})

describe('isDeepOrTopModelRef (same cases as claude.ts isDeepOrTopModel)', () => {
  it.each<[string | undefined, Partial<Record<ModelTier, string>> | undefined, boolean]>([
    ['opus', undefined, true],
    ['deep', undefined, true],
    ['top', undefined, true],
    ['fable', undefined, true],
    ['claude-fable-1', undefined, true],
    ['claude-opus-4-1', undefined, true],
    ['sonnet', undefined, false],
    ['haiku', undefined, false],
    ['everyday', undefined, false],
    ['gpt-big', { deep: 'gpt-big' }, true],
    ['gpt-big', { top: ' gpt-big ' }, true],
    ['gpt-big', { everyday: 'gpt-big' }, false],
    ['', { deep: '' }, false],
    [undefined, { deep: 'x' }, false],
    ['inherit', undefined, false]
  ])('%s with %j -> %s', (model, tm, want) => {
    expect(isDeepOrTopModelRef(model, tm)).toBe(want)
  })
})

describe('roleModelTier (the one reading of a role\'s tier, shared with claude.ts definitionTier)', () => {
  it.each<[R, boolean, ModelTier | undefined]>([
    [{ model: 'opus', tier: 'everyday' }, false, 'deep'],
    [{ model: 'everyday', tier: 'deep' }, false, 'everyday'],
    [{ model: 'claude-opus-5-1', tier: 'everyday' }, false, 'everyday'],
    [{ model: 'claude-opus-5-1' }, false, undefined],
    [{ model: 'claude-opus-5-1' }, true, 'deep'],
    [{ model: 'inherit', tier: 'deep' }, true, undefined],
    [{ model: '' }, true, undefined]
  ])('%j byFamily=%s -> %s', (r, byFamily, want) => {
    expect(roleModelTier(r, byFamily)).toBe(want)
  })

  it('a role whose alias names a higher tier than role.tier is sized by the alias it runs on', () => {
    const r = run({ role: { model: 'opus', tier: 'everyday' } })
    expect(r).toMatchObject({ mode: 'auto', tier: 'deep', tierChanged: false })
    expect(run({ role: { model: 'opus', tier: 'everyday' }, requested: { tier: 'top' } })).toMatchObject({ tier: 'deep', source: 'clamped' })
    expect(run({ role: { model: 'opus', tier: 'everyday' }, planGuard: true })).toMatchObject({ tier: 'everyday', source: 'plan-guard', tierChanged: true })
  })
})

describe('inheritTier (plan guard of a fixed inherit role)', () => {
  it("steers a fixed 'inherit' role when the tier 'inherit' resolves to is deep, also without parentTier", () => {
    const inherit: R = { model: 'inherit' }
    expect(run({ role: inherit, planGuard: true, inheritTier: 'deep' })).toMatchObject({ mode: 'fixed', tier: 'everyday', source: 'plan-guard' })
    expect(run({ role: inherit, project: { staffing: 'fixed' }, parentTier: 'everyday', planGuard: true, inheritTier: 'top' })).toMatchObject({ tier: 'everyday', source: 'plan-guard' })
    expect(run({ role: inherit, planGuard: true, inheritTier: 'everyday' })).toMatchObject({ mode: 'fixed', source: 'role' })
    expect(run({ role: inherit, inheritTier: 'deep' })).toMatchObject({ mode: 'fixed', source: 'role' })
  })
})

describe('rule 1: fixed roles', () => {
  it('a fixed project runs every role as configured and ignores a request with a note', () => {
    const r = run({ project: { staffing: 'fixed' }, requested: { tier: 'everyday', effort: 'low' } })
    expect(r).toMatchObject({ mode: 'fixed', tier: 'deep', model: 'opus', effort: 'high', source: 'role', overrides: false })
    expect(r.note).toMatch(/the project's staffing is fixed, so the request for everyday \/ low was ignored/i)
    expect(staffingLabel(r)).toBe('opus / high (fixed by the role)')
  })

  it('a role with staffing.mode fixed is fixed', () => {
    const r = run({ role: { ...DEEP, staffing: { mode: 'fixed' } }, requested: { tier: 'fast' } })
    expect(r).toMatchObject({ mode: 'fixed', tier: 'deep', model: 'opus', source: 'role', overrides: false })
  })

  it('a concrete model with no tier is fixed (tier from the model name when it is a Claude id)', () => {
    const r = run({ role: { model: 'claude-sonnet-4-6', effort: 'high' }, requested: { tier: 'deep' } })
    expect(r).toMatchObject({ mode: 'fixed', tier: 'everyday', model: 'claude-sonnet-4-6', effort: 'high', source: 'role', overrides: false })
    expect(staffingLabel({ ...r, model: 'sonnet-4-6' })).toBe('sonnet-4-6 / high (fixed by the role)')
  })

  it('a concrete model no tier describes has no tier', () => {
    const r = run({ role: { model: 'gpt-x' } })
    expect(r).toEqual({ mode: 'fixed', model: 'gpt-x', source: 'role', overrides: false, tierChanged: false, effortChanged: false })
    expect(r.tier).toBeUndefined()
    expect(staffingLabel(r)).toBe('gpt-x (fixed by the role)')
  })

  it('no note without a request; an escalation is refused with a note', () => {
    expect(run({ project: { staffing: 'fixed' } }).note).toBeUndefined()
    expect(run({ project: { staffing: 'fixed' }, escalatedFrom: { tier: 'deep' } }).note).toMatch(/not escalated/)
  })

  it('the plan guard still steers a fixed deep role to everyday', () => {
    const r = run({ project: { staffing: 'fixed' }, planGuard: true })
    expect(r).toMatchObject({ mode: 'fixed', tier: 'everyday', model: 'sonnet', effort: 'high', source: 'plan-guard', overrides: true })
    expect(r.note).toBe('On the everyday tier (sonnet) instead of opus: the weekly usage window is near its limit.')
    expect(staffingLabel(r)).toBe('everyday / high (usage guard)')
  })

  it('the plan guard on a fixed concrete model that is the connection deep model', () => {
    const tierModels = { deep: 'gpt-big', everyday: 'gpt-mid' }
    const r = run({ role: { model: 'gpt-big' }, tierModels, planGuard: true })
    expect(r).toMatchObject({ tier: 'everyday', model: 'gpt-mid', source: 'plan-guard', overrides: true })
  })

  it('the plan guard leaves a fixed fast role, a missing everyday model, and an everyday model equal to the role model', () => {
    expect(run({ role: { model: 'haiku', tier: 'fast', staffing: { mode: 'fixed' } }, planGuard: true }).source).toBe('role')
    expect(run({ project: { staffing: 'fixed' }, planGuard: true, tierModels: { deep: 'opus' } })).toMatchObject({ model: 'opus', source: 'role', overrides: false })
    expect(run({ project: { staffing: 'fixed' }, planGuard: true, tierModels: { deep: 'opus', everyday: 'opus' } }).source).toBe('role')
  })

  it('a fixed role with an empty model falls back to a mapped model (never empty)', () => {
    const r = run({ role: { model: '', tier: 'deep', staffing: { mode: 'fixed' } }, tierModels: { fast: 'haiku' } })
    expect(r.model).toBe('haiku')
  })

  it('a long model id keeps the note within STAFFING_NOTE_MAX_CHARS', () => {
    const r = run({ role: { model: 'x'.repeat(400), staffing: { mode: 'fixed' } }, tierModels: { deep: 'x'.repeat(400), everyday: 'e' }, planGuard: true })
    expect(r.source).toBe('plan-guard')
    expect(r.note!.length).toBeLessThanOrEqual(STAFFING_NOTE_MAX_CHARS)
  })
})

describe('goal cost', () => {
  it('steps an unrequested auto role one tier down and to medium effort, never past the ceiling', () => {
    const base = run({ role: DEEP, goal: 'cost' })
    expect(base.tier).toBe('everyday')
    expect(base.effort).toBe('high') // the role's own effort stays
    const noEffort = run({ role: { model: 'opus', tier: 'deep' }, goal: 'cost' })
    expect(noEffort).toMatchObject({ tier: 'everyday', effort: 'medium' })
    expect(run({ role: { model: 'opus', tier: 'deep', staffing: { mode: 'auto', maxEffort: 'low' } }, goal: 'cost' }).effort).toBe('low')
    expect(run({ role: DEEP, goal: 'balanced' }).tier).toBe('deep')
    expect(run({ role: DEEP }).tier).toBe('deep')
  })
  it('respects minTier, a request, a profile value, fixed roles and fixed projects', () => {
    expect(run({ role: { ...DEEP, staffing: { mode: 'auto', minTier: 'deep' } }, goal: 'cost' }).tier).toBe('deep')
    expect(run({ role: DEEP, goal: 'cost', requested: { tier: 'deep' } }).tier).toBe('deep')
    expect(run({ role: DEEP, goal: 'cost', profile: { tier: 'deep' } }).tier).toBe('deep')
    expect(run({ role: { ...DEEP, staffing: { mode: 'fixed' } }, goal: 'cost' }).tier).toBe('deep')
    expect(run({ role: DEEP, project: { staffing: 'fixed' }, goal: 'cost' }).tier).toBe('deep')
    expect(run({ role: { model: 'haiku', tier: 'fast' }, goal: 'cost' }).tier).toBe('fast')
  })
})

describe('rule 2: ceilings and floors', () => {
  it('inherit with parentTier: the parent tier is the ceiling and the chart tier', () => {
    const role: R = { model: 'inherit' }
    expect(run({ role, parentTier: 'deep' })).toMatchObject({ mode: 'auto', tier: 'deep', model: 'opus', source: 'role', overrides: false })
    expect(run({ role, parentTier: 'deep', requested: { tier: 'everyday' } })).toMatchObject({ tier: 'everyday', source: 'orchestrator', overrides: true })
    const up = run({ role, parentTier: 'everyday', requested: { tier: 'deep' } })
    expect(up).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'clamped', overrides: false })
  })

  it('inherit without parentTier runs as configured (no guess upward)', () => {
    const r = run({ role: { model: 'inherit' }, requested: { tier: 'deep', effort: 'high' } })
    expect(r).toMatchObject({ mode: 'fixed', model: 'inherit', source: 'role', overrides: false })
    expect(r.tier).toBeUndefined()
    expect(r.note).toMatch(/no tier ceiling is known/i)
  })

  it('a legacy alias or tier name model with no tier sets the ceiling', () => {
    expect(run({ role: { model: 'opus' }, requested: { tier: 'top' } })).toMatchObject({ mode: 'auto', tier: 'deep', source: 'clamped' })
    expect(run({ role: { model: 'everyday' }, requested: { tier: 'deep' } })).toMatchObject({ mode: 'auto', tier: 'everyday', source: 'clamped' })
    expect(run({ role: { model: 'opus' } })).toMatchObject({ tier: 'deep', model: 'opus', overrides: false })
  })

  it('an auto role on a concrete model with no tier has no ceiling: treated as fixed', () => {
    const r = run({ role: { model: 'claude-opus-4-1', staffing: { mode: 'auto' } }, requested: { tier: 'fast' } })
    expect(r).toMatchObject({ mode: 'fixed', model: 'claude-opus-4-1', source: 'role', overrides: false })
    expect(r.note).toMatch(/runs as configured/)
  })

  it('minTier is a floor', () => {
    const r = run({ role: { ...DEEP, staffing: { mode: 'auto', minTier: 'everyday' } }, requested: { tier: 'fast' } })
    expect(r).toMatchObject({ tier: 'everyday', source: 'clamped', adjustment: 'floor', asked: { tier: 'fast' } })
    expect(r.note).toBe('The orchestrator asked for fast, the role needs at least everyday.')
    expect(staffingLabel(r)).toBe("everyday / high (raised to the role's minimum: asked for fast)")
  })

  it('a floor above the ceiling is ignored (role tier and inherit parent)', () => {
    expect(run({ role: { ...EVERYDAY, staffing: { mode: 'auto', minTier: 'deep' } }, requested: { tier: 'fast' } })).toMatchObject({ tier: 'fast', source: 'orchestrator' })
    expect(run({ role: { model: 'inherit', staffing: { mode: 'auto', minTier: 'deep' } }, parentTier: 'everyday', requested: { tier: 'fast' } })).toMatchObject({ tier: 'fast', source: 'orchestrator' })
    expect(run({ role: { model: 'inherit', staffing: { mode: 'auto', minTier: 'everyday' } }, parentTier: 'deep', requested: { tier: 'fast' } })).toMatchObject({ tier: 'everyday', source: 'clamped' })
  })

  it('effort ceiling: maxEffort, else role effort, else high', () => {
    expect(run({ role: EVERYDAY, requested: { effort: 'xhigh' } })).toMatchObject({ effort: 'high', source: 'clamped' })
    expect(run({ role: EVERYDAY, requested: { effort: 'high' } })).toMatchObject({ effort: 'high', source: 'orchestrator' })
    expect(run({ role: { ...DEEP, effort: 'xhigh' }, requested: { effort: 'max' } })).toMatchObject({ effort: 'xhigh', source: 'clamped' })
    expect(run({ role: { ...DEEP, effort: 'xhigh' }, requested: { effort: 'xhigh' } })).toMatchObject({ effort: 'xhigh', source: 'orchestrator', overrides: false })
    expect(run({ role: { ...DEEP, staffing: { mode: 'auto', maxEffort: 'max' } }, requested: { effort: 'max' } })).toMatchObject({ effort: 'max', source: 'orchestrator' })
  })

  it("a role effort above its own maxEffort is clamped even with no request", () => {
    const r = run({ role: { ...DEEP, staffing: { mode: 'auto', maxEffort: 'medium' } } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'medium', source: 'clamped', overrides: true })
    expect(r.note).toBe("The role's own setting is high effort, the role allows up to medium.")
  })

  it('no effort set anywhere: no effort is sent', () => {
    const r = run({ role: EVERYDAY })
    expect(r.effort).toBeUndefined()
    expect(r).toMatchObject({ tier: 'everyday', source: 'role', overrides: false })
    expect(staffingLabel(r)).toBe("everyday (the role's setting)")
  })

  it('a cap below the adapter default is sent when nothing else gives an effort (the default would exceed it)', () => {
    // The reviewed defect: no role effort, maxEffort low, nothing requested -> no effort -> the adapter's medium.
    const capped: R = { ...EVERYDAY, staffing: { mode: 'auto', maxEffort: 'low' } }
    const r = run({ role: capped })
    expect(r).toMatchObject({ mode: 'auto', tier: 'everyday', effort: 'low', source: 'role', overrides: true, tierChanged: false, effortChanged: true })
    expect(r.note).toBeUndefined()
    expect(staffingLabel(r)).toBe("everyday / low (the role's setting)")
    // A request or an escalation that gives no effort leaves it to the cap as well.
    expect(run({ role: capped, requested: { tier: 'fast' } })).toMatchObject({ tier: 'fast', effort: 'low', effortChanged: true })
    expect(run({ role: capped, escalatedFrom: {} }).effort).toBe('low')
  })

  it('a cap at or above the adapter default still sends nothing, and so do an adapter with no efforts and a fixed role', () => {
    for (const maxEffort of ['medium', 'high', 'xhigh', 'max'] as const) {
      const r = run({ role: { ...EVERYDAY, staffing: { mode: 'auto', maxEffort } } })
      expect(r.effort, maxEffort).toBeUndefined()
      expect(r, maxEffort).toMatchObject({ overrides: false, effortChanged: false })
    }
    const none = run({ role: { ...EVERYDAY, staffing: { mode: 'auto', maxEffort: 'low' } }, adapterEfforts: [] })
    expect(none.effort).toBeUndefined()
    expect(none).toMatchObject({ effortChanged: false })
    expect(none.note).toBeUndefined()
    expect(run({ role: { ...EVERYDAY, staffing: { mode: 'fixed', maxEffort: 'low' } } }).effort).toBeUndefined()
  })
})

describe('rule 3: pick and source', () => {
  it.each<[StaffingRequest | undefined, StaffingRequest | undefined, string, ModelTier, Effort | undefined]>([
    [undefined, undefined, 'role', 'deep', 'high'],
    [{ tier: 'everyday' }, undefined, 'orchestrator', 'everyday', 'high'],
    [{ effort: 'low' }, undefined, 'orchestrator', 'deep', 'low'],
    [undefined, { tier: 'fast', effort: 'medium' }, 'profile', 'fast', 'medium'],
    [{ tier: 'everyday' }, { tier: 'fast', effort: 'low' }, 'orchestrator', 'everyday', 'low'],
    [{}, { effort: 'low' }, 'profile', 'deep', 'low'],
    [{ tier: 'bogus' as ModelTier, effort: 'nope' as Effort }, undefined, 'role', 'deep', 'high']
  ])('requested %j profile %j -> %s %s %s', (requested, profile, source, tier, effort) => {
    expect(run({ requested, profile })).toMatchObject({ source, tier, effort })
  })

  it('a request equal to the ceiling is honoured, with no override and no note', () => {
    const r = run({ requested: { tier: 'deep', effort: 'high' } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'high', source: 'orchestrator', overrides: false })
    expect(r.note).toBeUndefined()
    expect(staffingLabel(r)).toBe('deep / high (chosen by the orchestrator)')
  })

  it('a pick below the chart says so', () => {
    const r = run({ requested: { tier: 'everyday', effort: 'medium' } })
    expect(r).toMatchObject({ tier: 'everyday', model: 'sonnet', effort: 'medium', source: 'orchestrator', overrides: true })
    expect(r.note).toBe('The orchestrator picked everyday / medium; the role is set to deep / high.')
    expect(staffingLabel(r)).toBe('everyday / medium (chosen by the orchestrator)')
    expect(staffingLabel(run({ profile: { tier: 'fast' } }))).toBe('fast / high (from the project profile)')
  })
})

describe('rule 4: clamp', () => {
  it('a tier above the ceiling comes down, with the asked value named', () => {
    const r = run({ role: EVERYDAY, requested: { tier: 'deep' } })
    expect(r).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'clamped', adjustment: 'ceiling', asked: { tier: 'deep' }, overrides: false })
    expect(r.note).toBe('The orchestrator asked for deep, the role allows up to everyday.')
    expect(staffingLabel(r)).toBe('everyday (capped by the role: asked for deep)')
  })

  it('D9: top only when the ceiling is top', () => {
    expect(run({ requested: { tier: 'top' } })).toMatchObject({ tier: 'deep', source: 'clamped' })
    expect(run({ profile: { tier: 'top' } })).toMatchObject({ tier: 'deep', source: 'clamped' })
    expect(run({ role: { model: 'fable', tier: 'top' }, requested: { tier: 'top' } })).toMatchObject({ tier: 'top', model: 'fable', source: 'orchestrator' })
  })

  it('tier and effort clamped together name both', () => {
    const r = run({ role: EVERYDAY, requested: { tier: 'top', effort: 'max' } })
    expect(r).toMatchObject({ tier: 'everyday', effort: 'high', asked: { tier: 'top', effort: 'max' } })
    expect(staffingLabel(r)).toBe('everyday / high (capped by the role: asked for top / max)')
  })
})

describe('rule 5: escalation', () => {
  it('without a request: effort one step up when there is room', () => {
    const r = run({ escalatedFrom: { tier: 'everyday', effort: 'medium' } })
    expect(r).toMatchObject({ tier: 'everyday', effort: 'high', source: 'escalated' })
    expect(r.note).toMatch(/escalated effort from medium to high/)
    expect(staffingLabel(r)).toBe('everyday / high (escalated after a failed attempt)')
  })

  it('without a request: tier one step up when the effort is at its ceiling', () => {
    expect(run({ escalatedFrom: { tier: 'everyday', effort: 'high' } })).toMatchObject({ tier: 'deep', effort: 'high', source: 'escalated' })
  })

  it('without a request: no room changes nothing and says so', () => {
    const r = run({ escalatedFrom: { tier: 'deep', effort: 'high' } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'high', source: 'escalated' })
    expect(r.note).toMatch(/already at the role's limits/)
  })

  it('without a request: never into top (D9), even under a top ceiling', () => {
    const r = run({ role: { model: 'fable', tier: 'top', effort: 'high' }, escalatedFrom: { tier: 'deep', effort: 'high' } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'high' })
    expect(r.note).toMatch(/already at the role's limits/)
  })

  it('without a request: an unmapped next tier is no room', () => {
    expect(run({ tierModels: { everyday: 'sonnet' }, escalatedFrom: { tier: 'everyday', effort: 'high' } })).toMatchObject({ tier: 'everyday', effort: 'high' })
  })

  it('without a request on Codex: an effort the adapter cannot send is no room, so the tier goes up', () => {
    const r = run({ role: { ...DEEP, effort: 'xhigh' }, adapterEfforts: CODEX, escalatedFrom: { tier: 'everyday', effort: 'high' } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'high' })
  })

  it('without a request: missing previous values are the role default; no effort counts as medium', () => {
    expect(run({ escalatedFrom: {} })).toMatchObject({ tier: 'deep', effort: 'high' })
    const r = run({ role: EVERYDAY, escalatedFrom: { tier: 'fast' } })
    expect(r).toMatchObject({ tier: 'fast', effort: 'high', source: 'escalated' })
    expect(r.note).toMatch(/from the default to high/)
  })

  it('without a request: a previous attempt above today\'s ceiling is clamped first', () => {
    expect(run({ role: EVERYDAY, escalatedFrom: { tier: 'deep', effort: 'low' } })).toMatchObject({ tier: 'everyday', effort: 'medium', source: 'clamped' })
  })

  it.each<[StaffingRequest, StaffingRequest, ModelTier, Effort | undefined, boolean]>([
    // [previous, request, tier, effort, cut note]
    [{ tier: 'fast', effort: 'low' }, { tier: 'deep' }, 'everyday', 'low', true],
    [{ tier: 'everyday', effort: 'medium' }, { tier: 'deep', effort: 'high' }, 'deep', 'medium', true],
    [{ tier: 'everyday', effort: 'low' }, { effort: 'high' }, 'everyday', 'medium', true],
    [{ tier: 'everyday', effort: 'medium' }, { effort: 'high' }, 'everyday', 'high', false],
    [{ tier: 'everyday', effort: 'medium' }, { tier: 'deep' }, 'deep', 'medium', false],
    [{ tier: 'deep', effort: 'high' }, { tier: 'fast', effort: 'low' }, 'fast', 'low', false],
    [{ tier: 'everyday' }, { effort: 'high' }, 'everyday', 'high', false]
  ])('with a request: previous %j, asked %j -> %s / %s', (prev, requested, tier, effort, cut) => {
    const r = run({ role: { ...DEEP, effort: 'max' }, escalatedFrom: prev, requested })
    expect(r).toMatchObject({ tier, effort, source: 'escalated' })
    expect(/at most one step up/.test(r.note ?? '')).toBe(cut)
  })

  it('with a request: a role with no effort and a previous attempt with none counts from medium', () => {
    const r = run({ role: { ...EVERYDAY, staffing: { mode: 'auto', maxEffort: 'max' } }, escalatedFrom: { tier: 'everyday' }, requested: { effort: 'max' } })
    expect(r).toMatchObject({ tier: 'everyday', effort: 'high', source: 'escalated' })
  })

  it('with a request: never into top unless the previous attempt was top', () => {
    const top: R = { model: 'fable', tier: 'top', effort: 'high' }
    const r = run({ role: top, escalatedFrom: { tier: 'deep', effort: 'medium' }, requested: { tier: 'top' } })
    expect(r).toMatchObject({ tier: 'deep', effort: 'medium' })
    expect(r.note).toMatch(/never escalates into the top tier/)
    // The tier step was refused, so an effort step is still allowed.
    expect(run({ role: top, escalatedFrom: { tier: 'deep', effort: 'medium' }, requested: { tier: 'top', effort: 'high' } })).toMatchObject({ tier: 'deep', effort: 'high' })
    expect(run({ role: top, escalatedFrom: { tier: 'top', effort: 'medium' }, requested: { effort: 'high' } })).toMatchObject({ tier: 'top', effort: 'high' })
  })

  it('with a request and a ceiling clamp: source clamped', () => {
    const r = run({ role: EVERYDAY, escalatedFrom: { tier: 'fast', effort: 'low' }, requested: { tier: 'deep' } })
    expect(r).toMatchObject({ tier: 'everyday', effort: 'low', source: 'clamped', adjustment: 'ceiling' })
  })
})

describe('rule 6: plan guard and precedence', () => {
  it('a deep auto result goes to everyday', () => {
    const r = run({ planGuard: true })
    expect(r).toMatchObject({ mode: 'auto', tier: 'everyday', model: 'sonnet', effort: 'high', source: 'plan-guard', overrides: true })
    expect(r.note).toBe('On the everyday tier (sonnet) instead of deep: the weekly usage window is near its limit.')
    expect(staffingLabel({ ...r, effort: undefined })).toBe('everyday (usage guard)')
  })

  it('guard after clamp: plan-guard wins the source', () => {
    expect(run({ planGuard: true, requested: { tier: 'top' } })).toMatchObject({ tier: 'everyday', source: 'plan-guard' })
  })

  it('guard after escalation', () => {
    expect(run({ planGuard: true, escalatedFrom: { tier: 'everyday', effort: 'high' } })).toMatchObject({ tier: 'everyday', source: 'plan-guard' })
  })

  it('guard below the floor (the usage setting outranks minTier)', () => {
    expect(run({ planGuard: true, role: { ...DEEP, staffing: { mode: 'auto', minTier: 'deep' } } })).toMatchObject({ tier: 'everyday', source: 'plan-guard' })
  })

  it('guard changes nothing on everyday or fast, without an everyday model, or when everyday maps to the same model', () => {
    expect(run({ planGuard: true, requested: { tier: 'everyday' } }).source).toBe('orchestrator')
    expect(run({ planGuard: true, tierModels: { deep: 'opus' } })).toMatchObject({ tier: 'deep', model: 'opus', source: 'role' })
    expect(run({ planGuard: true, tierModels: { deep: 'm', everyday: 'm' } })).toMatchObject({ tier: 'deep', model: 'm', source: 'role' })
  })

  it('guard with an unmapped deep tier still goes to everyday', () => {
    expect(run({ planGuard: true, tierModels: { everyday: 'sonnet' } })).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'plan-guard' })
  })
})

describe('rule 7: availability', () => {
  it('no tierModels at all: the role model, source role, with a note', () => {
    const r = run({ tierModels: {} })
    expect(r).toMatchObject({ mode: 'auto', tier: 'deep', model: 'opus', effort: 'high', source: 'role', adjustment: 'unmapped', overrides: false })
    expect(r.note).toMatch(/no model for deep or any tier within the role's limits/)
    expect(staffingLabel(r)).toBe("opus / high (no model mapped within the role's limits)")
  })

  it('the nearest lower mapped tier', () => {
    const r = run({ tierModels: { everyday: 'sonnet', fast: 'haiku' } })
    expect(r).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'clamped', adjustment: 'connection', asked: { tier: 'deep' }, overrides: true })
    expect(staffingLabel(r)).toBe('everyday / high (no deep model on this connection)')
  })

  it('only a higher tier is available (within the ceiling)', () => {
    expect(run({ tierModels: { deep: 'opus' }, requested: { tier: 'fast' } })).toMatchObject({ tier: 'deep', model: 'opus', source: 'clamped' })
  })

  it('a higher tier above the ceiling is never used', () => {
    const r = run({ role: EVERYDAY, tierModels: { deep: 'opus', top: 'fable' } })
    expect(r).toMatchObject({ tier: 'everyday', model: 'sonnet', source: 'role', adjustment: 'unmapped' })
  })

  it('the lower search stops at the floor', () => {
    const r = run({ role: { ...DEEP, staffing: { mode: 'auto', minTier: 'everyday' } }, tierModels: { fast: 'haiku', top: 'fable' } })
    expect(r).toMatchObject({ tier: 'deep', model: 'opus', source: 'role', adjustment: 'unmapped' })
  })

  it('an inherit role with nothing mapped keeps inherit', () => {
    expect(run({ role: { model: 'inherit' }, parentTier: 'deep', tierModels: {} })).toMatchObject({ tier: 'deep', model: 'inherit', source: 'role', overrides: false })
  })

  it('a ceiling clamp keeps its own adjustment when availability also moves the tier', () => {
    const r = run({ requested: { tier: 'top' }, tierModels: { everyday: 'sonnet' } })
    expect(r).toMatchObject({ tier: 'everyday', source: 'clamped', adjustment: 'ceiling', asked: { tier: 'top' } })
    expect(r.note).toMatch(/allows up to deep; the connection has no model for deep, so everyday was used/)
  })
})

describe('rule 8: effort and the adapter', () => {
  it.each<[Effort, Effort]>([
    ['xhigh', 'high'],
    ['max', 'high'],
    ['high', 'high'],
    ['low', 'low']
  ])('Codex: asked %s -> %s', (asked, want) => {
    const r = run({ role: { ...DEEP, effort: 'max' }, adapterEfforts: CODEX, requested: { effort: asked } })
    expect(r.effort).toBe(want)
    expect(r.source).toBe('orchestrator')
    if (asked !== want) expect(r.note).toMatch(new RegExp(`does not support ${asked} effort, so ${want} was used`))
  })

  it("Codex: a role's own xhigh becomes high (and that is an override)", () => {
    expect(run({ role: { ...DEEP, effort: 'xhigh' }, adapterEfforts: CODEX })).toMatchObject({ effort: 'high', source: 'role', overrides: true })
  })

  it('nothing supported at or below: the lowest supported', () => {
    expect(run({ adapterEfforts: ['medium', 'high'], requested: { effort: 'low' } }).effort).toBe('medium')
  })

  it('an empty adapterEfforts never sends an effort', () => {
    const r = run({ adapterEfforts: [] })
    expect(r.effort).toBeUndefined()
    expect(r.overrides).toBe(true)
    expect(staffingLabel(r)).toBe("deep (the role's setting)")
  })
})

describe('rule 9: model and overrides', () => {
  it('model comes from tierModels (trimmed); tiers are compared, not model strings', () => {
    const r = run({ role: { model: 'claude-opus-4-1', tier: 'deep', effort: 'high' }, tierModels: { ...TM, deep: ' opus ' } })
    expect(r).toMatchObject({ model: 'opus', tier: 'deep', overrides: false })
  })

  it('an effort change alone is an override that leaves the tier alone', () => {
    expect(run({ requested: { effort: 'low' } })).toMatchObject({ overrides: true, tierChanged: false, effortChanged: true })
  })

  it('a tier change alone is flagged as such', () => {
    expect(run({ role: { model: 'opus', tier: 'deep', effort: 'high' }, requested: { tier: 'everyday' } })).toMatchObject({ overrides: true, tierChanged: true, effortChanged: false })
  })

  it("an inherit role's chart tier is its parent's: an effort-only pick does not change the tier", () => {
    expect(run({ role: { model: 'inherit' }, parentTier: 'deep', requested: { effort: 'low' } })).toMatchObject({ tier: 'deep', tierChanged: false, effortChanged: true })
    expect(run({ role: { model: 'inherit' }, parentTier: 'deep', requested: { tier: 'fast' } })).toMatchObject({ tier: 'fast', tierChanged: true })
  })

  it('the plan guard on a fixed role is a tier change', () => {
    expect(run({ project: { staffing: 'fixed' }, role: { model: 'opus', tier: 'deep' }, planGuard: true })).toMatchObject({ source: 'plan-guard', tierChanged: true, effortChanged: false })
  })
})

describe('properties over the tier x effort x ceiling grid', () => {
  const efforts: (Effort | undefined)[] = [undefined, ...EFFORTS]
  const tiers: (ModelTier | undefined)[] = [undefined, ...MODEL_TIERS]
  const maps: Partial<Record<ModelTier, string>>[] = [TM, { everyday: 'sonnet' }, { fast: 'haiku', top: 'fable' }, {}]
  const prevs: (StaffingRequest | undefined)[] = [undefined, { tier: 'fast', effort: 'low' }, { tier: 'deep', effort: 'high' }, {}]

  it('never above either ceiling, top only under a top ceiling, model never empty, effort sendable', () => {
    let checked = 0
    const failures: string[] = []
    for (const ceiling of MODEL_TIERS)
      for (const roleEffort of efforts)
        for (const reqTier of tiers)
          for (const reqEffort of efforts)
            for (const planGuard of [false, true])
              for (const adapterEfforts of [CLAUDE, CODEX])
                for (const tierModels of maps)
                  for (const escalatedFrom of prevs) {
                    const role: R = { model: TM[ceiling]!, tier: ceiling, ...(roleEffort ? { effort: roleEffort } : {}) }
                    const requested = reqTier || reqEffort ? { tier: reqTier, effort: reqEffort } : undefined
                    const r = resolveStaffing({ role, project: {}, tierModels, adapterEfforts, planGuard, escalatedFrom, requested })
                    const broken = [
                      r.mode !== 'auto' && 'mode',
                      (!r.tier || compareTier(r.tier, ceiling) > 0) && 'tier above the ceiling',
                      r.tier === 'top' && ceiling !== 'top' && 'top under a lower ceiling',
                      r.effort && compareEffort(r.effort, roleEffort ?? 'high') > 0 && 'effort above the ceiling',
                      r.effort && !adapterEfforts.includes(r.effort) && 'effort the adapter cannot send',
                      !r.model && 'empty model',
                      r.adjustment !== 'unmapped' && r.model !== tierModels[r.tier!] && 'model is not the tier model',
                      r.overrides !== (r.tier !== ceiling || r.effort !== roleEffort) && 'overrides',
                      r.note && r.note.length > STAFFING_NOTE_MAX_CHARS && 'note too long'
                    ].filter(Boolean)
                    if (broken.length) failures.push(JSON.stringify({ broken, ceiling, roleEffort, requested, planGuard, adapterEfforts, tierModels, escalatedFrom, r }))
                    checked++
                  }
    expect(failures.slice(0, 5)).toEqual([])
    expect(checked).toBe(4 * 6 * 5 * 6 * 2 * 2 * 4 * 4)
  })

  it('model is non-empty for an empty-model role whenever tierModels has an entry', () => {
    for (const t of MODEL_TIERS)
      for (const ceiling of MODEL_TIERS) {
        const r = resolveStaffing({ role: { model: '', tier: ceiling }, project: {}, tierModels: { [t]: 'm' }, adapterEfforts: CLAUDE })
        expect(r.model).toBe('m')
      }
  })
})

describe('staffRequestForSpawn', () => {
  const step = (id: string, role: string | undefined, over: Partial<PlanStep> = {}): PlanStep => ({
    id,
    title: id,
    status: 'pending',
    ...(role ? { staff: { role } } : {}),
    ...over
  })
  const plan = (steps: PlanStep[]): RunPlan => ({ goal: 'g', steps, status: 'active', autoContinues: 0, updatedAt: 0 })
  const none = new Set<string>()

  it('no plan or no matching step: the call values, or nothing', () => {
    expect(staffRequestForSpawn(undefined, 'dev', none)).toEqual({})
    expect(staffRequestForSpawn(undefined, 'dev', none, { tier: 'fast' })).toEqual({ requested: { tier: 'fast' } })
    expect(staffRequestForSpawn(plan([step('p1', 'qa')]), 'dev', none, {})).toEqual({})
  })

  it('binds the first ready unbound pending or in-progress step naming the role', () => {
    const p = plan([
      step('p1', 'dev', { status: 'done' }),
      step('p2', 'dev', { status: 'blocked' }),
      step('p3', 'dev', { staff: { role: 'dev', tier: 'everyday', effort: 'low' } }),
      step('p4', 'dev', { status: 'in_progress', staff: { role: 'dev', tier: 'fast' } })
    ])
    expect(staffRequestForSpawn(p, 'dev', none)).toEqual({ stepId: 'p3', requested: { tier: 'everyday', effort: 'low' } })
    expect(staffRequestForSpawn(p, 'dev', new Set(['p3']))).toEqual({ stepId: 'p4', requested: { tier: 'fast' } })
    expect(staffRequestForSpawn(p, 'dev', new Set(['p3', 'p4']))).toEqual({})
  })

  it('skips a step whose after steps are not done or skipped, unless no step is ready', () => {
    const p = plan([
      step('p1', 'qa', { status: 'in_progress' }),
      step('p2', 'dev', { after: ['p1'], staff: { role: 'dev', tier: 'deep' } }),
      step('p3', 'dev', { after: ['p0', 'p5'], staff: { role: 'dev', tier: 'fast' } }),
      step('p5', 'qa', { status: 'skipped' })
    ])
    // p3 waits for an unknown id (satisfied) and a skipped step: ready.
    expect(staffRequestForSpawn(p, 'dev', none).stepId).toBe('p3')
    // With p3 bound, nothing is ready: the first unbound step naming the role.
    expect(staffRequestForSpawn(p, 'dev', new Set(['p3'])).stepId).toBe('p2')
  })

  it('compares trimmed and case-sensitive', () => {
    const p = plan([step('p1', ' dev ')])
    expect(staffRequestForSpawn(p, 'dev ', none)).toEqual({ stepId: 'p1' })
    expect(staffRequestForSpawn(p, 'Dev', none)).toEqual({})
    expect(staffRequestForSpawn(p, '  ', none)).toEqual({})
  })

  it('call values win field by field; invalid values are dropped', () => {
    const p = plan([step('p1', 'dev', { staff: { role: 'dev', tier: 'deep', effort: 'high' } })])
    expect(staffRequestForSpawn(p, 'dev', none, { effort: 'low' })).toEqual({ stepId: 'p1', requested: { tier: 'deep', effort: 'low' } })
    expect(staffRequestForSpawn(p, 'dev', none, { tier: 'fast', effort: 'bad' as Effort })).toEqual({ stepId: 'p1', requested: { tier: 'fast', effort: 'high' } })
  })
})

describe('recording', () => {
  const row = (i: number): StaffingAssignment => ({ roleId: `r${i}`, model: 'sonnet', source: 'role', at: i })

  it('staffingAssignment copies the resolved values and ids', () => {
    const r = run({ requested: { tier: 'top' } })
    expect(staffingAssignment(r, { roleId: 'dev', agentId: 'a1', stepId: 'p2' }, 1234)).toEqual({
      roleId: 'dev',
      agentId: 'a1',
      stepId: 'p2',
      tier: 'deep',
      model: 'opus',
      effort: 'high',
      source: 'clamped',
      note: r.note,
      at: 1234
    })
    expect(staffingAssignment(run({ role: EVERYDAY }), { roleId: 'x' }, 5)).toEqual({ roleId: 'x', tier: 'everyday', model: 'sonnet', source: 'role', at: 5 })
  })

  it('appendStaffing appends, keeps the current goal and the newest rows', () => {
    expect(appendStaffing(undefined, 'speed', row(1))).toEqual({ goal: 'speed', assignments: [row(1)] })
    const current: RunStaffing = { goal: 'cost', assignments: [row(1)] }
    const next = appendStaffing(current, 'speed', row(2))
    expect(next).toEqual({ goal: 'cost', assignments: [row(1), row(2)] })
    expect(current.assignments).toHaveLength(1)
    const full: RunStaffing = { goal: 'balanced', assignments: Array.from({ length: RUN_STAFFING_ASSIGNMENTS_MAX }, (_, i) => row(i)) }
    const capped = appendStaffing(full, 'balanced', row(999))
    expect(capped.assignments).toHaveLength(RUN_STAFFING_ASSIGNMENTS_MAX)
    expect(capped.assignments[0]).toEqual(row(1))
    expect(capped.assignments.at(-1)).toEqual(row(999))
  })

  it('recordStaffing: two un-awaited calls both land', async () => {
    let stored: RunStaffing | undefined
    const ctx = {
      staffingGoal: 'speed' as const,
      getStaffing: () => stored,
      updateStaffing: async (s: RunStaffing) => {
        stored = s
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    const a = recordStaffing(ctx, row(1))
    const b = recordStaffing(ctx, row(2))
    await Promise.all([a, b])
    expect(stored).toEqual({ goal: 'speed', assignments: [row(1), row(2)] })
  })

  it('recordStaffing defaults the goal to balanced', async () => {
    let stored: RunStaffing | undefined
    await recordStaffing({ getStaffing: () => stored, updateStaffing: async (s) => void (stored = s) }, row(1))
    expect(stored?.goal).toBe('balanced')
  })

  describe('recordStaffing marks the bound step in_progress', () => {
    const st = (id: string, status: PlanStep['status']): PlanStep => ({ id, title: id, status })
    const mkPlan = (steps: PlanStep[], over: Partial<RunPlan> = {}): RunPlan => ({ goal: 'g', steps, status: 'active', autoContinues: 2, updatedAt: 0, ...over })
    const setup = (initial: RunPlan | undefined, failPlan = false) => {
      let plan = initial
      let stored: RunStaffing | undefined
      const writes: RunPlan[] = []
      const ctx = {
        getStaffing: () => stored,
        updateStaffing: async (s: RunStaffing) => void (stored = s),
        getPlan: () => plan,
        updatePlan: async (p: RunPlan) => {
          writes.push(p)
          if (failPlan) throw new Error('plan store down')
          plan = p
        }
      }
      return { ctx, writes, plan: () => plan, staffing: () => stored }
    }
    const bound = (i: number, stepId?: string): StaffingAssignment => ({ ...row(i), ...(stepId ? { stepId } : {}) })

    it('a pending step bound by a row becomes in_progress, nothing else changes', async () => {
      const t = setup(mkPlan([st('p1', 'pending'), st('p2', 'pending')]))
      await recordStaffing(t.ctx, bound(1, 'p1'))
      expect(t.plan()!.steps.map((s) => s.status)).toEqual(['in_progress', 'pending'])
      expect(t.plan()).toMatchObject({ goal: 'g', status: 'active', autoContinues: 2 })
      expect(t.staffing()!.assignments).toHaveLength(1)
    })

    it.each(['in_progress', 'done', 'blocked', 'skipped'] as const)('leaves a %s step alone', async (status) => {
      const t = setup(mkPlan([st('p1', status)]))
      await recordStaffing(t.ctx, bound(1, 'p1'))
      expect(t.writes).toEqual([])
    })

    it('leaves the plan alone without a stepId, for an unknown step, with no plan, or without getPlan/updatePlan', async () => {
      const a = setup(mkPlan([st('p1', 'pending')]))
      await recordStaffing(a.ctx, bound(1))
      await recordStaffing(a.ctx, bound(2, 'p9'))
      expect(a.writes).toEqual([])
      const b = setup(undefined)
      await recordStaffing(b.ctx, bound(1, 'p1'))
      expect(b.writes).toEqual([])
      let stored: RunStaffing | undefined
      await recordStaffing({ getStaffing: () => stored, updateStaffing: async (s) => void (stored = s) }, bound(1, 'p1'))
      expect(stored!.assignments).toHaveLength(1)
    })

    it('two rows recorded back to back mark both steps', async () => {
      const t = setup(mkPlan([st('p1', 'pending'), st('p2', 'pending'), st('p3', 'pending')]))
      await Promise.all([recordStaffing(t.ctx, bound(1, 'p1')), recordStaffing(t.ctx, bound(2, 'p2'))])
      expect(t.plan()!.steps.map((s) => s.status)).toEqual(['in_progress', 'in_progress', 'pending'])
      expect(t.staffing()!.assignments).toHaveLength(2)
    })

    it('a failing updatePlan still stores the row and rejects afterwards', async () => {
      const t = setup(mkPlan([st('p1', 'pending')]), true)
      await expect(recordStaffing(t.ctx, bound(1, 'p1'))).rejects.toThrow('plan store down')
      expect(t.staffing()!.assignments).toHaveLength(1)
    })
  })
})

describe('enforcedStaffingFloor (the floor resolveStaffing enforces; shared with team evolution)', () => {
  it('is the role floor only when the role is auto and the floor is not above the ceiling staffing uses', () => {
    expect(enforcedStaffingFloor({ model: 'deep', tier: 'deep', staffing: { mode: 'auto', minTier: 'everyday' } }, {})).toBe('everyday')
    // A tier alias in the model sets the ceiling: sonnet runs on everyday, so a deep floor is not enforced.
    expect(enforcedStaffingFloor({ model: 'sonnet', tier: 'deep', staffing: { mode: 'auto', minTier: 'deep' } }, {})).toBeUndefined()
    expect(enforcedStaffingFloor({ model: 'top', tier: 'fast', staffing: { mode: 'auto', minTier: 'deep' } }, {})).toBeUndefined()
    expect(enforcedStaffingFloor({ model: 'deep', tier: 'deep', staffing: { mode: 'fixed', minTier: 'everyday' } }, {})).toBeUndefined()
    expect(enforcedStaffingFloor({ model: 'deep', tier: 'deep', staffing: { mode: 'auto', minTier: 'everyday' } }, { staffing: 'fixed' })).toBeUndefined()
    expect(enforcedStaffingFloor({ model: 'inherit', staffing: { mode: 'auto', minTier: 'everyday' } }, {}, 'deep')).toBe('everyday')
    expect(enforcedStaffingFloor({ model: 'inherit', staffing: { mode: 'auto', minTier: 'everyday' } }, {})).toBeUndefined()
  })
  it('agrees with resolveStaffing: a request below the floor is raised to it only when the floor is enforced', () => {
    const fast = (role: Partial<Role>) => resolveStaffing({ role: { slug: 'r', ...role } as Role, project: {}, tierModels: TM, adapterEfforts: CLAUDE, requested: { tier: 'fast' } }).tier
    expect(fast({ model: 'deep', tier: 'deep', staffing: { mode: 'auto', minTier: 'everyday' } })).toBe('everyday')
    expect(fast({ model: 'sonnet', tier: 'deep', staffing: { mode: 'auto', minTier: 'deep' } })).toBe('fast')
  })
})
