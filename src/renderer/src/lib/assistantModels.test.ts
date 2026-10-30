import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { modelDisplayName, modelSettingDescription, modelSettingGroups, modelSources } from './assistantModels'
import type { ModelSource } from './assistantModels'

const catalog: ProviderModel[] = [
  { id: 'gpt-x', label: 'GPT X', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered', recommended: true, tier: 'deep' },
  { id: 'gpt-y', label: 'GPT Y', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered' }
]
const sources: ModelSource[] = [
  { id: 'anthropic', name: 'Anthropic', tierModels: { deep: 'opus' } },
  { id: 'openai', name: 'OpenAI', tierModels: {}, catalog }
]

describe('modelDisplayName', () => {
  it('shows tiers (and legacy aliases) as tiers, catalog labels, and unknown ids as written', () => {
    expect(modelDisplayName('deep')).toBe('Deep tier')
    expect(modelDisplayName('opus')).toBe('Deep tier')
    expect(modelDisplayName('gpt-x', catalog)).toBe('GPT X')
    expect(modelDisplayName('gpt-5')).toBe('gpt-5')
  })
})

describe('modelSources', () => {
  it('always includes anthropic and only other connections that are enabled', () => {
    expect(modelSources(null, {}).map((s) => s.id)).toEqual(['anthropic'])
  })
})

describe('modelSettingGroups', () => {
  it('lists short tier labels, then a group per connection with recommended marked, keeping an unknown saved id', () => {
    const groups = modelSettingGroups('mystery', sources, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'OpenAI', 'Saved'])
    expect(groups[0].options.map((o) => o.label)).toEqual(['Top tier', 'Deep tier', 'Everyday tier', 'Fast tier'])
    expect(groups[1].options[0].label).toBe('GPT X (recommended)')
    expect(groups[2].options[0].value).toBe('mystery')
  })
  it('offers inherit only when allowed', () => {
    expect(modelSettingGroups('deep', [], true)[0].options[0].value).toBe('inherit')
    expect(modelSettingGroups('deep', [], false).some((g) => g.label === 'Inherit')).toBe(false)
  })
})

describe('modelSettingDescription', () => {
  it('shows what a tier resolves to on each usable connection', () => {
    expect(modelSettingDescription('deep', sources)).toBe('Deep → Anthropic: opus · OpenAI: gpt-x')
  })
  it('names the connection of a concrete model', () => {
    expect(modelSettingDescription('gpt-y', sources)).toBe('OpenAI only.')
  })
})
