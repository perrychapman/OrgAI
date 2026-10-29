import { describe, expect, it } from 'vitest'
import { builtinModels } from '@shared/defaults'
import type { ProviderModel } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { migrateProject, remapProject } from './remap'

const openai = builtinModels('openai')
const tierModels = { top: 'gpt-5-codex', deep: 'gpt-5', everyday: 'gpt-5-mini', fast: 'gpt-5-nano' }

function chart() {
  return project({
    provider: { id: 'codex', label: 'Codex', auth: { kind: 'subscription' }, connection: 'openai' },
    roles: [
      role({ id: 'a', slug: 'a', model: 'gpt-5', tier: 'deep' }),
      role({ id: 'b', slug: 'b', model: 'inherit', tier: 'fast', reportsTo: 'a' }),
      role({ id: 'c', slug: 'c', model: 'sonnet', reportsTo: 'a' }), // no tier
      role({ id: 'd', slug: 'd', model: 'sonnet', tier: 'everyday', reportsTo: 'a' }),
      role({ id: 'e', slug: 'e', model: 'gpt-5-nano', tier: 'everyday', reportsTo: 'a' }) // explicit pick
    ]
  })
}

describe('remapProject', () => {
  it('maps tiered roles, skips inherit and tierless roles and keeps explicit catalog picks', () => {
    const { project: out, result } = remapProject(chart(), {
      connection: 'openai',
      tierModels,
      catalog: openai,
      previousTierModels: { deep: 'gpt-5', everyday: 'gpt-5-mini' },
      reason: 'tierModels'
    })
    expect(out.roles.map((r) => r.model)).toEqual(['gpt-5', 'inherit', 'sonnet', 'gpt-5-mini', 'gpt-5-nano'])
    expect(result.changes).toEqual([{ roleId: 'd', from: 'sonnet', to: 'gpt-5-mini' }])
    expect(result).toMatchObject({ projectId: 'p1', connection: 'openai', reason: 'tierModels' })
  })

  it('treats a catalog model equal to the previous mapping as not a user pick', () => {
    const p = chart()
    const { result } = remapProject(p, {
      connection: 'openai',
      tierModels: { ...tierModels, deep: 'gpt-5-codex' },
      catalog: openai,
      previousTierModels: { deep: 'gpt-5' },
      reason: 'tierModels'
    })
    expect(result.changes).toContainEqual({ roleId: 'a', from: 'gpt-5', to: 'gpt-5-codex' })
  })

  it('without a previous mapping keeps every valid catalog model', () => {
    const { result } = remapProject(chart(), { connection: 'openai', tierModels, catalog: openai, reason: 'manual' })
    expect(result.changes.map((c) => c.roleId)).toEqual(['d'])
  })

  it("remaps every tiered role on 'switched'", () => {
    const { result, project: out } = remapProject(chart(), { connection: 'openai', tierModels, catalog: openai, reason: 'switched' })
    expect(result.changes.map((c) => c.roleId)).toEqual(['d', 'e'])
    expect(out.roles.find((r) => r.id === 'e')?.model).toBe('gpt-5-mini')
    expect(out.roles.find((r) => r.id === 'b')?.model).toBe('inherit')
    expect(out.roles.find((r) => r.id === 'c')?.model).toBe('sonnet')
  })

  it('leaves a role alone when its tier has no mapping', () => {
    const { result } = remapProject(chart(), { connection: 'openai', tierModels: { deep: 'gpt-5' }, catalog: openai, reason: 'switched' })
    expect(result.changes).toEqual([])
  })

  it('ignores catalog entries from other connections when validating picks', () => {
    const foreign: ProviderModel[] = [{ ...openai[0], connection: 'litellm', id: 'sonnet' }]
    const { result } = remapProject(chart(), { connection: 'openai', tierModels, catalog: foreign, reason: 'connected' })
    expect(result.changes.map((c) => c.roleId)).toContain('d')
  })

  it('does not mutate its input and returns the same project when nothing changed', () => {
    const p = chart()
    const snapshot = JSON.stringify(p)
    remapProject(p, { connection: 'openai', tierModels, catalog: openai, reason: 'switched' })
    expect(JSON.stringify(p)).toBe(snapshot)
    const same = remapProject(p, { connection: 'openai', tierModels: {}, catalog: openai, reason: 'manual' })
    expect(same.project).toBe(p)
  })
})

describe('migrateProject', () => {
  it('sets the connection and the tiers a project lacks', () => {
    const p = project({
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } },
      roles: [role({ id: 'a', slug: 'a', model: 'opus' }), role({ id: 'b', slug: 'b', model: 'inherit' }), role({ id: 'c', slug: 'c', model: 'gpt-5' })]
    })
    const { project: out, changed } = migrateProject(p)
    expect(changed).toBe(true)
    expect(out.provider.connection).toBe('anthropic')
    expect(out.roles.map((r) => r.tier)).toEqual(['deep', undefined, undefined])
  })

  it('maps a codex provider to openai and is idempotent', () => {
    const p = project({ provider: { id: 'codex', label: 'Codex', auth: { kind: 'subscription' } }, roles: [role({ id: 'a', slug: 'a', model: 'haiku' })] })
    const first = migrateProject(p)
    expect(first.project.provider.connection).toBe('openai')
    const second = migrateProject(first.project)
    expect(second.changed).toBe(false)
    expect(second.project).toBe(first.project)
  })
})
