import { describe, expect, it } from 'vitest'
import { mergeOrgChart } from '../setup/orgMerge'
import { project, role } from '../runtime/testHelpers'
import { resolveDraftModel, revisedRoleModel, toRoles, type DraftModelContext, type DraftRole } from './draft'

const d = (name: string, model: string | undefined, reportsTo: string | null = 'Lead'): DraftRole => ({
  name,
  description: '',
  responsibilities: [],
  prompt: '',
  tools: ['Read'],
  ...(model === undefined ? {} : { model }),
  canSpawn: false,
  spawnable: [],
  reportsTo
})

const proxy: DraftModelContext = {
  connection: 'litellm',
  tierModels: { deep: 'gw/big', everyday: 'gw/mid' },
  models: ['gw/big', 'gw/mid', 'gw/other']
}
const nothingMapped: DraftModelContext = { connection: 'litellm', tierModels: {}, models: [] }
const current = { model: 'claude-opus-4-5', tier: 'deep' as const }

describe('resolveDraftModel', () => {
  it('is strict: inherit, a mapped tier, a listed id; everything else is undefined', () => {
    expect(resolveDraftModel('inherit', proxy)).toEqual({ model: 'inherit' })
    expect(resolveDraftModel('everyday', proxy)).toEqual({ model: 'gw/mid', tier: 'everyday' })
    expect(resolveDraftModel('top', proxy)).toEqual({ model: 'gw/big', tier: 'deep' })
    expect(resolveDraftModel('gw/other', proxy)).toEqual({ model: 'gw/other' })
    expect(resolveDraftModel('unlisted-model', proxy)).toBeUndefined()
    expect(resolveDraftModel('', proxy)).toBeUndefined()
    expect(resolveDraftModel(undefined, proxy)).toBeUndefined()
    expect(resolveDraftModel('deep', nothingMapped)).toBeUndefined()
  })
})

describe('revisedRoleModel keeps the current model of a matched role', () => {
  it.each([
    ['omitted', undefined],
    ['blank', '  '],
    ['inherit', 'inherit'],
    ['the same id', ' claude-opus-4-5 '],
    ['the same tier', 'deep'],
    ['an alias of the same tier', 'opus'],
    ['an unlisted id', 'mystery-model']
  ])('%s', (_label, raw) => {
    expect(revisedRoleModel(raw, current, proxy)).toEqual(current)
  })

  it('a tier nothing maps keeps the model', () => {
    expect(revisedRoleModel('fast', current, nothingMapped)).toEqual(current)
  })

  it("a tier that falls back to the role's own tier keeps the pinned model", () => {
    // 'top' is unmapped on the proxy and resolves to deep, which the role already is.
    expect(revisedRoleModel('top', current, proxy)).toEqual(current)
  })

  it('a current model without a tier stays without one', () => {
    expect(revisedRoleModel(undefined, { model: 'weird' }, proxy)).toEqual({ model: 'weird' })
    expect('tier' in revisedRoleModel('inherit', { model: 'weird' }, proxy)).toBe(false)
  })
})

describe('revisedRoleModel changes the model', () => {
  it('to a different tier that resolves', () => {
    expect(revisedRoleModel('everyday', current, proxy)).toEqual({ model: 'gw/mid', tier: 'everyday' })
  })

  it('to a listed id that differs', () => {
    expect(revisedRoleModel('gw/other', current, proxy)).toEqual({ model: 'gw/other' })
  })

  it('and a role without a tier takes the tier of the new value', () => {
    expect(revisedRoleModel('deep', { model: 'weird' }, proxy)).toEqual({ model: 'gw/big', tier: 'deep' })
  })
})

describe('keeping and the tier through mergeOrgChart', () => {
  it('drops the tier the proposal has none for and keeps the one it has', () => {
    const lead = role({ id: 'r1', slug: 'lead', name: 'Lead', model: 'claude-opus-4-5', tier: 'deep' })
    const p = project({ roles: [lead] })
    const converted = toRoles({ rationale: '', roles: [d('Lead', undefined, null)] }, proxy)
    const r = revisedRoleModel(undefined, lead, proxy)
    converted[0].model = r.model
    if (r.tier) converted[0].tier = r.tier
    else delete converted[0].tier
    expect(mergeOrgChart(p, converted).roles[0]).toMatchObject({ id: 'r1', model: 'claude-opus-4-5', tier: 'deep' })
    const noTier = { ...lead, model: 'weird' }
    delete (noTier as { tier?: string }).tier
    const c2 = toRoles({ rationale: '', roles: [d('Lead', undefined, null)] }, proxy)
    const r2 = revisedRoleModel(undefined, noTier, proxy)
    c2[0].model = r2.model
    if (r2.tier) c2[0].tier = r2.tier
    else delete c2[0].tier
    const merged = mergeOrgChart(project({ roles: [noTier] }), c2).roles[0]
    expect(merged.model).toBe('weird')
    expect(merged.tier).toBeUndefined()
  })
})

describe('a new role whose model maps nothing', () => {
  const claudeIds = ['claude-sonnet-4-5', 'claude-opus-4-5']

  it('takes a listed model of the nearest tier', () => {
    const ctx: DraftModelContext = { connection: 'litellm', tierModels: {}, models: claudeIds }
    const roles = toRoles({ rationale: '', roles: [d('Lead', 'fast', null), d('A', 'top'), d('B', undefined)] }, ctx)
    expect(roles.map((r) => [r.model, r.tier])).toEqual([
      ['claude-sonnet-4-5', 'everyday'],
      ['claude-opus-4-5', 'deep'],
      ['claude-sonnet-4-5', 'everyday']
    ])
  })

  it('never picks an unrelated listed model', () => {
    const ctx: DraftModelContext = { connection: 'litellm', tierModels: {}, models: ['gw/other'], fallback: { model: 'gw/root', tier: 'deep' } }
    expect(toRoles({ rationale: '', roles: [d('Lead', 'fast', null)] }, ctx)[0]).toMatchObject({ model: 'gw/root', tier: 'deep' })
  })

  it('falls back to the chart root model', () => {
    const ctx: DraftModelContext = { ...nothingMapped, fallback: { model: 'gw/root' } }
    const [a, b] = toRoles({ rationale: '', roles: [d('Lead', 'deep', null), d('X', 'zzz')] }, ctx)
    expect(a.model).toBe('gw/root')
    expect(a.tier).toBeUndefined()
    expect(b.model).toBe('gw/root')
  })

  it('is inherit only when nothing at all is available', () => {
    expect(toRoles({ rationale: '', roles: [d('Lead', 'deep', null)] }, nothingMapped)[0].model).toBe('inherit')
  })

  it('an explicit inherit stays inherit', () => {
    const ctx: DraftModelContext = { ...proxy, fallback: { model: 'gw/root' } }
    expect(toRoles({ rationale: '', roles: [d('Lead', 'inherit', null)] }, ctx)[0].model).toBe('inherit')
  })

  it('an inherit fallback is ignored', () => {
    const ctx: DraftModelContext = { ...nothingMapped, fallback: { model: 'inherit' } }
    expect(toRoles({ rationale: '', roles: [d('Lead', 'deep', null)] }, ctx)[0].model).toBe('inherit')
  })
})
