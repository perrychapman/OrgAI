import { describe, expect, it } from 'vitest'
import type { ConnectionInfo, ProviderModel } from '@shared/types'
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
  it('lists every enabled proxy by its own name, in list order, and skips disabled ones', () => {
    const info = (c: object): ConnectionInfo => ({ connection: c, status: { state: 'connected' } }) as unknown as ConnectionInfo
    const list = [
      info({ id: 'anthropic', enabled: true, tierModels: { deep: 'opus' } }),
      info({ id: 'px_1', kind: 'litellm', name: 'Work gateway', anthropicBaseUrl: 'x', enabled: true, tierModels: { everyday: 'gpt-5' } }),
      info({ id: 'px_2', kind: 'openai-compatible', name: 'Spare', anthropicBaseUrl: 'x', enabled: false, tierModels: {} }),
      info({ id: 'openai', enabled: false, tierModels: {} })
    ]
    const s = modelSources(list, {})
    expect(s.map((x) => [x.id, x.name])).toEqual([['anthropic', 'Anthropic'], ['px_1', 'Work gateway']])
    expect(s[1].tierModels).toEqual({ everyday: 'gpt-5' })
  })
})

describe('modelSettingGroups', () => {
  it('lists plain tier labels, then one Exact model group with recommended marked, keeping an unknown saved id', () => {
    const groups = modelSettingGroups('mystery', sources, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'OpenAI', 'Saved value'])
    expect(groups[0].options.map((o) => o.label)).toEqual(['Top tier', 'Deep tier', 'Everyday tier', 'Fast tier'])
    expect(groups[1].options.map((o) => o.label)).toEqual(['GPT X (recommended)', 'GPT Y'])
    expect(groups[2].options[0]).toEqual({ value: 'mystery', label: 'mystery' })
  })
  it('labels each tier with the model it resolves to on the given connection', () => {
    const groups = modelSettingGroups('deep', sources, false, sources[0])
    expect(groups[0].options.find((o) => o.value === 'deep')?.label).toBe('Deep tier (opus)')
    expect(groups[0].options.find((o) => o.value === 'fast')?.label).toBe('Fast tier (haiku)')
  })
  it('groups by connection name and shows the family only where a connection serves several', () => {
    const mixed: ProviderModel[] = [
      { ...catalog[0], id: 'claude-a', label: 'claude-a', connection: 'px_1', family: 'claude', adapter: 'claude', recommended: false },
      { ...catalog[0], id: 'gpt-5', label: 'gpt-5', connection: 'px_1', family: 'openai', recommended: false },
      { ...catalog[0], id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', connection: 'px_1', family: 'other', recommended: false }
    ]
    const both: ModelSource[] = [...sources, { id: 'px_1', name: 'Work gateway', tierModels: {}, catalog: mixed }]
    const groups = modelSettingGroups('deep', both, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'OpenAI', 'Work gateway'])
    expect(groups[1].options.map((o) => o.label)).toEqual(['GPT X (recommended)', 'GPT Y'])
    expect(groups[2].options.map((o) => o.label)).toEqual(['claude-a · Claude', 'gpt-5 · GPT', 'gemini-2.5-pro · Other'])
  })
  it('lists an id shared by two connections once and never renders an empty group', () => {
    const a = { ...catalog[0], id: 'same', label: 'same', connection: 'px_1' as const, recommended: false }
    const b = { ...a, connection: 'px_2' as const }
    const two: ModelSource[] = [
      { id: 'px_1', name: 'Work', tierModels: {}, catalog: [a] },
      { id: 'px_2', name: 'Lite', tierModels: {}, catalog: [b] }
    ]
    const groups = modelSettingGroups('deep', two, false)
    expect(groups.map((g) => g.label)).toEqual(['Tiers', 'Work'])
    expect(groups.every((g) => g.options.length > 0)).toBe(true)
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
