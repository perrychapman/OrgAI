import { describe, expect, it } from 'vitest'
import { adapterForProject, defaultRoles } from '../../shared/defaults'
import { project, role } from './fixtures'
import { applyPlan, effectiveConcurrency, nextModelFor, patchFingerprint, planFingerprint, planSummary, stepEffort, stepTier, touchedFields } from './plan'

const plan = (over = {}) => ({ rolePatches: [{ slug: 'dev', effort: 'low' as const, reason: 'a' }], newSkills: [], pruneSkillIds: [], ...over })

describe('plan helpers', () => {
  it('fingerprints ignore reasons and ordering, and change with the mutation', () => {
    const a = plan({ rolePatches: [{ slug: 'dev', effort: 'low', reason: 'a' }, { slug: 'review', tier: 'fast', reason: 'b' }] })
    const b = plan({ rolePatches: [{ slug: 'review', tier: 'fast', reason: 'other' }, { slug: 'dev', effort: 'low', reason: 'z' }] })
    expect(planFingerprint(a)).toBe(planFingerprint(b))
    expect(planFingerprint(a)).not.toBe(planFingerprint(plan()))
    expect(planFingerprint(plan({ maxConcurrentSubagents: 4 }))).not.toBe(planFingerprint(plan()))
    expect(patchFingerprint({ slug: 'x', addTools: ['Read', 'Glob'], reason: '1' })).toBe(patchFingerprint({ slug: 'x', addTools: ['Glob', 'Read'], reason: '2' }))
  })
  it('applyPlan keeps ids, positions and edges, and never mutates its input', () => {
    const p = project()
    const snap = structuredClone(p)
    const out = applyPlan(p, plan({ rolePatches: [{ slug: 'dev', effort: 'low', tier: 'everyday', removeTools: ['Bash'], addTools: ['Grep'], reason: '' }], maxConcurrentSubagents: 5 }))
    expect(p).toEqual(snap)
    const dev = out.roles.find((r) => r.slug === 'dev')!
    expect(dev).toMatchObject({ id: 'r_dev', effort: 'low', tier: 'everyday', model: 'everyday', reportsTo: 'r_lead', position: { x: 0, y: 0 } })
    expect(dev.tools).toEqual(['Read', 'Edit', 'Write', 'Grep'])
    expect(out.maxConcurrentSubagents).toBe(5)
    expect(out.roles.find((r) => r.slug === 'lead')).toBe(p.roles[0])
  })
  it('tier changes move the model only when it names a tier or alias, preserving Claude aliases for adapterForProject', () => {
    expect(nextModelFor({ model: 'deep' }, 'fast')).toBe('fast')
    expect(nextModelFor({ model: 'opus' }, 'fast')).toBe('haiku')
    expect(nextModelFor({ model: 'opus' }, 'everyday')).toBe('sonnet')
    expect(nextModelFor({ model: 'sonnet' }, 'deep')).toBe('opus')
    expect(nextModelFor({ model: 'claude-x-9' }, 'fast')).toBeUndefined()
    expect(nextModelFor({ model: 'deep' }, 'deep')).toBeUndefined()
    expect(nextModelFor({ model: 'opus' }, 'deep')).toBeUndefined()
    expect(touchedFields({ slug: 'dev', tier: 'fast', reason: '' }, role('dev', { model: 'deep' }))).toEqual(['tier', 'model'])

    const realClaude = project({ provider: { id: 'claude', connection: 'anthropic', auth: { kind: 'subscription' } } as never }, defaultRoles())
    const evolved = applyPlan(realClaude, {
      rolePatches: [
        { slug: 'implementer', tier: 'everyday', reason: '' },
        { slug: 'researcher', tier: 'fast', reason: '' }
      ],
      maxConcurrentSubagents: undefined
    })
    expect(adapterForProject(evolved, []).mismatched).toEqual([])
    expect(evolved.roles.find((r) => r.slug === 'implementer')?.model).toBe('sonnet')
    expect(evolved.roles.find((r) => r.slug === 'researcher')?.model).toBe('haiku')
  })
  it('steps and summaries', () => {
    expect(stepTier('deep', -1)).toBe('everyday')
    expect(stepTier('fast', -1)).toBeUndefined()
    expect(stepTier('deep', 1)).toBe('top')
    expect(stepEffort('high', -1)).toBe('medium')
    expect(planSummary(plan({ maxConcurrentSubagents: 4 }))).toContain('concurrency 4')
    expect(effectiveConcurrency({})).toBe(8)
    expect(effectiveConcurrency({ maxConcurrentSubagents: 99 })).toBe(32)
  })
})
