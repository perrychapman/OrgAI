import { describe, expect, it } from 'vitest'
import type { Project, ProviderModel, Role } from '@shared/types'
import { builtinModels, newProject } from '@shared/defaults'
import { describeRemap, familyMismatches, previewRemap, roleTier } from './remap'

function project(models: Record<string, string>): Project {
  const p = newProject({ name: 'Demo', path: '/tmp/demo', brief: '' })
  const roles: Role[] = p.roles.map((r, i) => ({ ...r, model: Object.values(models)[i] ?? r.model, tier: undefined }))
  return { ...p, roles }
}

const openai: ProviderModel[] = builtinModels('openai')

describe('remap preview', () => {
  it('maps tiered roles to the new connection on a switch', () => {
    const p = project({ a: 'fable', b: 'sonnet', c: 'haiku', d: 'inherit' })
    const res = previewRemap({
      project: p,
      connection: 'openai',
      tierModels: { top: 'gpt-5-codex', everyday: 'gpt-5-mini', fast: 'gpt-5-nano' },
      catalog: openai,
      switching: true
    })
    expect(res.changes.map((c) => c.to)).toEqual(['gpt-5-codex', 'gpt-5-mini', 'gpt-5-nano'])
    expect(res.changes.every((c) => c.from !== 'inherit')).toBe(true)
  })

  it('keeps explicit catalog picks when only the tier mapping changes', () => {
    const p = project({ a: 'gpt-5', b: 'gpt-5-mini' })
    const res = previewRemap({
      project: p,
      connection: 'openai',
      tierModels: { deep: 'gpt-5', everyday: 'gpt-5-nano' },
      previousTierModels: { deep: 'gpt-5', everyday: 'gpt-5-mini' },
      catalog: openai,
      switching: false
    })
    // gpt-5-mini was the old Everyday default but the role has no stored tier: tierForModel finds none, so nothing moves.
    expect(res.changes).toEqual([])
  })

  it('derives the tier from the model when the role has none', () => {
    expect(roleTier({ model: 'opus' })).toBe('deep')
    expect(roleTier({ model: 'inherit', tier: 'top' })).toBeUndefined()
    expect(roleTier({ model: 'gpt-5', tier: 'deep' })).toBe('deep')
  })

  it('names roles in describeRemap and skips empty results', () => {
    const p = project({ a: 'fable' })
    const rows = describeRemap(
      [
        { projectId: p.id, connection: 'openai', reason: 'connected', changes: [{ roleId: p.roles[0].id, from: 'fable', to: 'gpt-5-codex' }] },
        { projectId: 'other', connection: 'openai', reason: 'connected', changes: [] }
      ],
      [p]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].changes[0].roleName).toBe(p.roles[0].name)
  })

  it('finds roles from the other family under litellm', () => {
    const p = project({ a: 'claude-opus-4', b: 'gpt-5', c: 'claude-sonnet-4' })
    const mismatches = familyMismatches(p, [], { everyday: 'claude-sonnet-4' })
    expect(mismatches.map((m) => m.from)).toEqual(['gpt-5'])
  })
})
