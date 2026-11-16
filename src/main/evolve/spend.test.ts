import { describe, expect, it } from 'vitest'
import type { EvolutionPlan, EvolutionRolePatch, TeamEvolutionDiagnosis } from '../../shared/types'
import { project, role } from './fixtures'
import { validateEvolutionPlan } from './ratchet'
import { holdSpendRaises, spendRaisesOf } from './spend'

const under = (slug: string): Pick<TeamEvolutionDiagnosis, 'findings'> => ({ findings: [{ kind: 'tier_underprovisioned', roleSlug: slug, severity: 30, summary: 's', evidence: [] }] })
const throttled: Pick<TeamEvolutionDiagnosis, 'findings'> = { findings: [{ kind: 'serial_bottleneck', severity: 30, summary: 's', evidence: [], data: { limitThrottled: 1, peakReady: 6, limit: 2 } }] }

const raw = (rolePatches: EvolutionRolePatch[], extra: Partial<EvolutionPlan> = {}): EvolutionPlan =>
  ({ strategy: 'deterministic', fingerprint: '', rolePatches, newSkills: [], pruneSkillIds: [], rationale: '', expectedImpact: {}, gate: { ok: true, violations: [] }, promptChars: { before: 0, after: 0, limit: 0 }, empty: false, ...extra }) as EvolutionPlan

/** dev on everyday / medium, so a one-step raise is allowed by the gate when under-provisioned. */
const proj = (over = {}) =>
  project(over, [
    role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev'], tier: 'deep', model: 'deep' }),
    role('dev', { id: 'r_dev', name: 'Developer', tools: ['Read', 'Edit', 'Bash'], tier: 'everyday', model: 'everyday', effort: 'medium' }),
    role('docs', { id: 'r_docs', tier: 'deep', model: 'deep', effort: 'high', prompt: 'You are the docs. You are the docs.' })
  ])

describe('spendRaisesOf', () => {
  it('names a tier raise, an effort raise and a staffing ceiling raise with the team files gate sentences', () => {
    const p = proj()
    expect(spendRaisesOf(p, { rolePatches: [{ slug: 'dev', tier: 'deep', reason: 'r' }] })).toEqual([{ roleSlug: 'dev', field: 'tier', summary: expect.stringContaining('Developer') }])
    expect(spendRaisesOf(p, { rolePatches: [{ slug: 'dev', effort: 'high', reason: 'r' }] })).toEqual([{ roleSlug: 'dev', field: 'effort', summary: expect.stringContaining('may spend more') }])
    const staffing = spendRaisesOf(p, { rolePatches: [{ slug: 'dev', staffing: { mode: 'auto', maxEffort: 'max' }, reason: 'r' }] })
    expect(staffing.map((r) => r.field)).toEqual(['staffing'])
  })
  it('a lower tier, a lower effort, a prompt or a tool change raises nothing', () => {
    const p = proj()
    expect(spendRaisesOf(p, { rolePatches: [{ slug: 'docs', tier: 'everyday', effort: 'medium', reason: 'r' }] })).toEqual([])
    expect(spendRaisesOf(p, { rolePatches: [{ slug: 'dev', prompt: 'x', addTools: ['Grep'], reason: 'r' }] })).toEqual([])
  })
  it('judges the model by the tier the role really runs on when model and tier disagree (review H-1)', () => {
    // Runs on everyday (the model wins), although `tier` reads deep: patched to deep it moves to the deep model.
    const up = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { id: 'r_dev', model: 'everyday', tier: 'deep' })])
    expect(spendRaisesOf(up, { rolePatches: [{ slug: 'dev', tier: 'deep', reason: 'r' }] })).toEqual([{ roleSlug: 'dev', field: 'tier', summary: expect.stringContaining('from the everyday tier to the deep tier') }])
    const alias = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { id: 'r_dev', model: 'haiku', tier: 'top' })])
    expect(spendRaisesOf(alias, { rolePatches: [{ slug: 'dev', tier: 'everyday', reason: 'r' }] }).map((r) => r.field)).toEqual(['tier'])
    // The other way round: runs on deep, `tier` reads everyday; a cut to everyday is not a raise.
    const down = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { id: 'r_dev', model: 'deep', tier: 'everyday' })])
    expect(spendRaisesOf(down, { rolePatches: [{ slug: 'dev', tier: 'everyday', reason: 'r' }] })).toEqual([])
    // An alias-only role (no tier field) cut one step is not held (review L-8).
    const bare = project({}, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { id: 'r_dev', model: 'opus', tier: undefined })])
    expect(spendRaisesOf(bare, { rolePatches: [{ slug: 'dev', tier: 'everyday', reason: 'r' }] })).toEqual([])
  })
  it('the gate plus holdSpendRaises never lands a raise on a mismatched role', () => {
    const p = project({}, [role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev'] }), role('dev', { id: 'r_dev', model: 'everyday', tier: 'deep', effort: 'medium' })])
    const gate = { diagnosis: under('dev') }
    const plan = validateEvolutionPlan(p, raw([{ slug: 'dev', tier: 'deep', reason: 'r' }]), gate)
    expect(plan.rolePatches[0]?.tier).toBe('deep')
    const out = holdSpendRaises(p, plan, gate)
    expect(out.held.map((h) => h.field)).toEqual(['tier'])
    expect(out.plan.empty).toBe(true)
  })
  it('a higher effective concurrency limit is a raise, an equal or lower one is not', () => {
    const p = proj({ maxConcurrentSubagents: 2 })
    expect(spendRaisesOf(p, { rolePatches: [], maxConcurrentSubagents: 4 })).toEqual([{ field: 'concurrency', summary: expect.stringContaining('from 2 to 4') }])
    expect(spendRaisesOf(p, { rolePatches: [], maxConcurrentSubagents: 2 })).toEqual([])
    expect(spendRaisesOf(p, { rolePatches: [], maxConcurrentSubagents: 1 })).toEqual([])
  })
})

describe('holdSpendRaises', () => {
  it('takes out every raise, keeps the rest, re-gates and reports each held part as spend_held', () => {
    const p = proj({ maxConcurrentSubagents: 2 })
    const gate = { diagnosis: { findings: [...under('dev').findings, ...throttled.findings] } }
    const plan = validateEvolutionPlan(p, raw([{ slug: 'dev', tier: 'deep', reason: 'r' }, { slug: 'docs', effort: 'medium', reason: 'cheaper' }], { maxConcurrentSubagents: 4 }), gate)
    expect(plan.gate.ok).toBe(true)
    expect(plan.rolePatches.find((x) => x.slug === 'dev')?.tier).toBe('deep')
    expect(plan.maxConcurrentSubagents).toBe(4)
    expect(spendRaisesOf(p, plan).map((r) => r.field).sort()).toEqual(['concurrency', 'tier'])
    const out = holdSpendRaises(p, plan, gate)
    expect(out.held.map((h) => `${h.roleSlug ?? '-'}:${h.field}`).sort()).toEqual(['-:concurrency', 'dev:tier'])
    expect(out.plan.rolePatches).toEqual([expect.objectContaining({ slug: 'docs', effort: 'medium' })])
    expect(out.plan.maxConcurrentSubagents).toBeUndefined()
    expect(spendRaisesOf(p, out.plan)).toEqual([])
    expect(out.plan.gate.ok).toBe(true)
    const heldRules = out.plan.gate.violations.filter((v) => v.rule === 'spend_held')
    expect(heldRules).toHaveLength(2)
    expect(heldRules.every((v) => v.action === 'trimmed')).toBe(true)
    expect(out.plan.fingerprint).not.toBe(plan.fingerprint)
  })
  it('a plan that only raises spend becomes empty', () => {
    const p = proj()
    const gate = { diagnosis: under('dev') }
    const plan = validateEvolutionPlan(p, raw([{ slug: 'dev', effort: 'high', reason: 'r' }]), gate)
    expect(plan.rolePatches).toHaveLength(1)
    const out = holdSpendRaises(p, plan, gate)
    expect(out.plan.empty).toBe(true)
    expect(out.held).toEqual([{ roleSlug: 'dev', field: 'effort', summary: expect.any(String) }])
  })
})
