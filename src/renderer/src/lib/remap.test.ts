import { describe, expect, it } from 'vitest'
import type { Project, ProviderModel, Role } from '@shared/types'
import { builtinModels, mixedFamilyRefusal, newProject } from '@shared/defaults'
import { describeRemap, otherFamilyRoles, proxyFamilyNotice, previewRemap, roleTier, routeLines, startRefusal, tierMappingLines } from './remap'

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
    const p = project({ a: 'gpt-5', b: 'gpt-5-mini', c: 'gpt-5-mini', d: 'gpt-5' })
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
    expect(otherFamilyRoles(p, []).map((m) => m.model)).toEqual(['gpt-5'])
  })

  it('words one informational notice', () => {
    expect(proxyFamilyNotice('claude', 2)).toBe('Claude orchestrator; 2 roles on other model families run through the proxy.')
    expect(proxyFamilyNotice('openai', 1)).toBe('OpenAI orchestrator; 1 role on another model family runs through the proxy.')
    expect(proxyFamilyNotice('claude', 0)).toBeNull()
  })
})

describe('tier mapping lines', () => {
  const roles = [
    { model: 'opus', tier: 'deep' as const },
    { model: 'sonnet', tier: 'everyday' as const },
    { model: 'haiku', tier: 'everyday' as const }
  ]
  it('lists every tier and says what a missing one does to its roles', () => {
    const lines = tierMappingLines({ everyday: 'model-e', deep: 'model-d' }, roles, 'Team gateway')
    expect(lines.map((l) => l.text)).toEqual([
      'Top is not mapped on Team gateway. No role uses it; pick a model under Model tiers on its card in App settings > Connections if you want one.',
      'Deep: model-d',
      'Everyday: model-e',
      'Fast is not mapped on Team gateway. No role uses it; pick a model under Model tiers on its card in App settings > Connections if you want one.'
    ])
    const none = tierMappingLines({ everyday: 'model-e' }, roles, 'Team gateway')
    expect(none[1].text).toBe(
      'Deep is not mapped on Team gateway, so the role on Deep keeps its current model. To change that, pick a Deep model under Model tiers on its card in App settings > Connections.'
    )
  })
  it('names the route per family from the catalog', () => {
    const catalog = [
      { id: 'c-1', family: 'claude', baseUrl: 'https://a.example' },
      { id: 'g-1', family: 'openai', baseUrl: 'https://b.example/v1' }
    ] as ProviderModel[]
    expect(routeLines({ deep: 'c-1', everyday: 'g-1' }, catalog)).toEqual([
      { route: 'claude', text: 'Claude models use the Anthropic URL.', url: 'https://a.example' },
      { route: 'other', text: 'GPT and other models use the OpenAI URL.', url: 'https://b.example/v1' }
    ])
    expect(routeLines({ deep: 'c-1' }, catalog).map((l) => l.route)).toEqual(['claude'])
    expect(routeLines({}, catalog)).toEqual([])
  })
})

describe('startRefusal', () => {
  it('is the shared mixedFamilyRefusal rule main applies', () => {
    expect(startRefusal).toBe(mixedFamilyRefusal)
  })
  it('mirrors the shared mixedFamilyRefusal rule', () => {
    expect(startRefusal({ connection: 'litellm', family: 'claude', mismatched: ['a'] })).toBeNull()
    expect(startRefusal({ connection: 'litellm', family: undefined, mismatched: ['a'] })).toBe('no-root-family')
    expect(startRefusal({ connection: 'anthropic', family: 'claude', mismatched: ['a'] })).toBe('single-family-connection')
    expect(startRefusal({ connection: 'openai', family: 'openai', mismatched: [] })).toBeNull()
  })
})
