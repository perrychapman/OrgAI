import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { ASSISTANT_MODEL_FALLBACK, assistantModelLabel, modelDisplayName, modelSettingDescription, modelSettingGroups, modelSources, runsOnText } from './assistantModels'
import type { ModelSource } from './assistantModels'

const catalog: ProviderModel[] = [
  { id: 'gpt-x', label: 'GPT X', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered', recommended: true, tier: 'deep' },
  { id: 'gpt-y', label: 'GPT Y', connection: 'openai', family: 'openai', adapter: 'codex', source: 'discovered' }
]
const sources: ModelSource[] = [
  { id: 'anthropic', name: 'Anthropic', tierModels: { deep: 'opus' } },
  { id: 'openai', name: 'OpenAI', tierModels: {}, catalog }
]

describe('ASSISTANT_MODEL_FALLBACK', () => {
  it('shows deep for the Skill assistant and everyday for Chat when a setting is missing', () => {
    expect(ASSISTANT_MODEL_FALLBACK.skillAssistModel).toBe('deep')
    expect(ASSISTANT_MODEL_FALLBACK.quickRunModel).toBe('everyday')
  })
})

describe('modelDisplayName', () => {
  it('shows tiers (and legacy aliases) as tiers, catalog labels, and unknown ids as written', () => {
    expect(modelDisplayName('deep')).toBe('Deep tier')
    expect(modelDisplayName('opus')).toBe('Deep tier')
    expect(modelDisplayName('gpt-x', catalog)).toBe('GPT X')
    expect(modelDisplayName('gpt-5')).toBe('gpt-5')
  })
})

describe('assistant model lines (ux-review-config-2 N5)', () => {
  it('names the tier with the model it resolves to on the default connection', () => {
    const on = { id: 'anthropic' as const, tierModels: { everyday: 'sonnet' } }
    expect(assistantModelLabel('everyday', on)).toBe('Everyday tier (sonnet)')
    expect(assistantModelLabel('gpt-5')).toBe('gpt-5')
    expect(assistantModelLabel('')).toBe('the configured model')
    expect(runsOnText(assistantModelLabel('everyday', on), 'Anthropic')).toBe('Runs on Everyday tier (sonnet) via Anthropic')
    expect(runsOnText('Deep tier')).toBe('Runs on Deep tier')
  })
})

describe('modelSources', () => {
  it('always includes anthropic and only other connections that are enabled', () => {
    expect(modelSources(null, {}).map((s) => s.id)).toEqual(['anthropic'])
  })
})

describe('modelSettingGroups', () => {
  it('lists plain tier labels, then one Exact model group with recommended marked, keeping an unknown saved id', () => {
    const groups = modelSettingGroups('mystery', sources, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'Exact model'])
    expect(groups[0].options.map((o) => o.label)).toEqual(['Top tier', 'Deep tier', 'Everyday tier', 'Fast tier'])
    expect(groups[1].options.map((o) => o.label)).toEqual(['GPT X (recommended)', 'GPT Y', 'mystery'])
    expect(groups[1].options[2].value).toBe('mystery')
  })
  it('labels each tier with the model it resolves to on the given connection', () => {
    const groups = modelSettingGroups('deep', sources, false, sources[0])
    expect(groups[0].options.find((o) => o.value === 'deep')?.label).toBe('Deep tier (opus)')
    expect(groups[0].options.find((o) => o.value === 'fast')?.label).toBe('Fast tier (haiku)')
  })
  it('names the connection on exact models only when several connections offer models', () => {
    const both: ModelSource[] = [...sources, { id: 'litellm', name: 'LiteLLM', tierModels: {}, catalog: [{ ...catalog[0], id: 'lite-1', label: 'Lite 1', connection: 'litellm' }] }]
    expect(modelSettingGroups('deep', both, false)[1].options.map((o) => o.label)).toContain('Lite 1 (recommended) · LiteLLM')
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
