import { describe, expect, it } from 'vitest'
import { builtinModels } from '@shared/defaults'
import type { Project } from '@shared/types'
import { project } from '../runtime/testHelpers'
import type { RuntimeAdapter } from '../runtime/types'
import { draftOrgChart, toRoles, type DraftModelContext, type DraftRole } from './draft'

const d = (name: string, model: string, reportsTo: string | null = 'Lead'): DraftRole => ({
  name,
  description: '',
  responsibilities: [],
  prompt: '',
  tools: ['Read'],
  model,
  canSpawn: false,
  spawnable: [],
  reportsTo
})
const chart = (models: string[]) => ({ rationale: '', roles: models.map((m, i) => d(i === 0 ? 'Lead' : `R${i}`, m, i === 0 ? null : 'Lead')) })

const lite: DraftModelContext = {
  connection: 'litellm',
  tierModels: { deep: 'gw/big', everyday: 'gw/mid', fast: 'gw/small' },
  models: ['gw/big', 'gw/mid', 'gw/small', 'gw/other']
}

describe('toRoles model mapping', () => {
  it('without a context maps tiers and legacy aliases through the anthropic builtins and sets the tier', () => {
    const roles = toRoles(chart(['deep', 'sonnet', 'fast', 'top', 'inherit', 'gpt-9']))
    expect(roles.map((r) => [r.model, r.tier])).toEqual([
      ['opus', 'deep'],
      ['sonnet', 'everyday'],
      ['haiku', 'fast'],
      ['fable', 'top'],
      ['inherit', undefined],
      ['sonnet', 'everyday']
    ])
  })

  it('maps tiers and aliases onto the connection, never emitting a Claude alias', () => {
    const roles = toRoles(chart(['opus', 'everyday', 'haiku', 'top']), lite)
    expect(roles.map((r) => [r.model, r.tier])).toEqual([
      ['gw/big', 'deep'],
      ['gw/mid', 'everyday'],
      ['gw/small', 'fast'],
      ['gw/big', 'deep']
    ])
  })

  it('keeps a listed id, and sends anything else to the everyday tier', () => {
    const roles = toRoles(chart(['gw/other', 'gpt-9', 'claude-opus-4-5']), lite)
    expect(roles.map((r) => r.model)).toEqual(['gw/other', 'gw/mid', 'gw/mid'])
  })

  it('uses inherit when the connection maps nothing', () => {
    const roles = toRoles(chart(['deep', 'weird']), { connection: 'litellm', tierModels: {}, models: [] })
    expect(roles.map((r) => [r.model, r.tier])).toEqual([
      ['inherit', undefined],
      ['inherit', undefined]
    ])
  })
})

describe('draftOrgChart', () => {
  const reply = JSON.stringify(chart(['deep', 'everyday']))
  const make = (seen: { model?: string; system?: string }): RuntimeAdapter =>
    ({ complete: async (o: { model?: string; system: string }) => ((seen.model = o.model), (seen.system = o.system), reply) }) as unknown as RuntimeAdapter
  const p: Project = project()

  it('drafts on the connection\'s deep tier and maps the result', async () => {
    const seen: { model?: string; system?: string } = {}
    const out = await draftOrgChart(make(seen), p, { projectId: p.id, instruction: 'x', mode: 'new' } as never, { connection: 'litellm', tierModels: lite.tierModels, catalog: [] })
    expect(seen.model).toBe('gw/big')
    expect(out.roles.map((r) => r.model)).toEqual(['gw/big', 'gw/mid'])
  })

  it('uses the adapter default without a context, and the prompt names tiers, not vendor models', async () => {
    const seen: { model?: string; system?: string } = {}
    await draftOrgChart(make(seen), p, { projectId: p.id, instruction: 'x', mode: 'new' } as never)
    expect(seen.model).toBeUndefined()
    expect(seen.system).toContain('"everyday"')
    expect(seen.system).not.toMatch(/opus|sonnet|haiku|fable/i)
  })

  it('anthropic context resolves the deep tier to the connection mapping', async () => {
    const seen: { model?: string } = {}
    await draftOrgChart(make(seen), p, { projectId: p.id, instruction: 'x', mode: 'new' } as never, { connection: 'anthropic', tierModels: { deep: 'claude-opus-9' }, catalog: builtinModels('anthropic') })
    expect(seen.model).toBe('claude-opus-9')
  })
})
