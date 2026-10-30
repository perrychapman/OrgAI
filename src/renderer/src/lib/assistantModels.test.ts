import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { modelDisplayName, modelSettingGroups } from './assistantModels'

const catalog: ProviderModel[] = [
  { id: 'gpt-x', label: 'GPT X', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered', recommended: true },
  { id: 'gpt-y', label: 'GPT Y', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered' }
]

describe('modelDisplayName', () => {
  it('shows tiers (and legacy aliases) as tiers, catalog labels, and unknown ids as written', () => {
    expect(modelDisplayName('deep')).toBe('Deep tier')
    expect(modelDisplayName('opus')).toBe('Deep tier')
    expect(modelDisplayName('gpt-x', catalog)).toBe('GPT X')
    expect(modelDisplayName('gpt-5')).toBe('gpt-5')
  })
})

describe('modelSettingGroups', () => {
  it('lists tiers first, then catalog models with recommended marked, keeping an unknown saved id', () => {
    const groups = modelSettingGroups('mystery', catalog, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'Models', 'Saved'])
    expect(groups[0].options.map((o) => o.value)).toEqual(['top', 'deep', 'everyday', 'fast'])
    expect(groups[1].options[0].label).toBe('GPT X (recommended)')
    expect(groups[2].options[0].value).toBe('mystery')
  })
  it('offers inherit only when allowed', () => {
    expect(modelSettingGroups('deep', undefined, true)[0].options[0].value).toBe('inherit')
    expect(modelSettingGroups('deep', undefined, false).some((g) => g.label === 'Inherit')).toBe(false)
  })
})
