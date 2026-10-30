import { describe, expect, it } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, OPENAI_PLACEHOLDER_MODELS, defaultTierModels } from '@shared/defaults'
import type { ProviderModel } from '@shared/types'
import { mapChosenModel, mapImportedModel, type ModelContext } from './model'

const anthropic: ModelContext = { connection: 'anthropic', catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) }
const openai: ModelContext = { connection: 'openai', catalog: OPENAI_PLACEHOLDER_MODELS, tierModels: defaultTierModels(OPENAI_PLACEHOLDER_MODELS) }
const litellmCatalog: ProviderModel[] = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet', connection: 'litellm', family: 'claude', adapter: 'claude', tier: 'everyday', source: 'discovered' },
  { id: 'claude-opus-4-1', label: 'Opus', connection: 'litellm', family: 'claude', adapter: 'claude', tier: 'deep', source: 'discovered' },
  { id: 'gpt-5-mini', label: 'mini', connection: 'litellm', family: 'openai', adapter: 'codex', tier: 'everyday', source: 'discovered' }
]
const litellm: ModelContext = { connection: 'litellm', catalog: litellmCatalog, tierModels: { deep: 'claude-opus-4-1', everyday: 'claude-sonnet-4-5' } }

describe('mapImportedModel', () => {
  it('anthropic: every model ends up a Claude alias', () => {
    expect(mapImportedModel('sonnet', anthropic)).toEqual({ model: 'sonnet', tier: 'everyday', reason: 'kept' })
    expect(mapImportedModel('claude-opus-4-1[1m]', anthropic)).toMatchObject({ model: 'opus', tier: 'deep', reason: 'tier' })
    expect(mapImportedModel('openai/gpt-5-nano', anthropic)).toMatchObject({ model: 'haiku', tier: 'fast', reason: 'tier' })
    expect(mapImportedModel('google/gemini-2.5-pro', anthropic)).toMatchObject({ model: 'opus', tier: 'deep', reason: 'tier' })
  })
  it('inherit stays inherit', () => {
    expect(mapImportedModel('inherit', openai)).toEqual({ model: 'inherit', reason: 'inherit' })
  })
  it('openai: keeps catalog models, maps Claude tiers to the connection', () => {
    expect(mapImportedModel('gpt-5-mini', openai)).toMatchObject({ model: 'gpt-5-mini', reason: 'kept' })
    expect(mapImportedModel('opus', openai)).toMatchObject({ model: 'gpt-5', tier: 'deep', reason: 'tier' })
    expect(mapImportedModel('haiku', openai)).toMatchObject({ model: 'gpt-5-nano', tier: 'fast', reason: 'tier' })
  })
  it('missing and unknown models get the everyday tier with a note', () => {
    expect(mapImportedModel(undefined, openai)).toMatchObject({ model: 'gpt-5-mini', tier: 'everyday', reason: 'default' })
    const unknown = mapImportedModel('llama-3-70b', anthropic)
    expect(unknown).toMatchObject({ model: 'sonnet', tier: 'everyday', reason: 'default', unknown: true })
    expect(unknown.note).toContain('not recognised')
  })
  it('litellm: kept, mapped, and the nearest mapped tier when one is missing', () => {
    expect(mapImportedModel('claude-sonnet-4-5', litellm)).toMatchObject({ model: 'claude-sonnet-4-5', reason: 'kept' })
    expect(mapImportedModel('opus', litellm)).toMatchObject({ model: 'claude-opus-4-1', tier: 'deep', reason: 'tier' })
    const fast = mapImportedModel('haiku', litellm)
    expect(fast).toMatchObject({ model: 'claude-sonnet-4-5', tier: 'everyday', reason: 'tier' })
    expect(fast.note).toContain('No fast model')
  })
  it('a connection with no tier mapping inherits', () => {
    expect(mapImportedModel('opus', { connection: 'litellm', catalog: [], tierModels: {} })).toMatchObject({ model: 'inherit', reason: 'inherit' })
  })
  it('an OrgAI export tier wins over the classifier', () => {
    expect(mapImportedModel('custom-model', anthropic, 'top')).toMatchObject({ model: 'fable', tier: 'top', reason: 'tier' })
  })
})

describe('mapChosenModel', () => {
  it('accepts inherit, catalog models and tier names', () => {
    expect(mapChosenModel('inherit', anthropic, 'A')).toMatchObject({ model: 'inherit', reason: 'chosen' })
    expect(mapChosenModel('gpt-5', openai, 'A')).toMatchObject({ model: 'gpt-5', tier: 'deep', reason: 'chosen' })
    expect(mapChosenModel('fast', anthropic, 'A')).toMatchObject({ model: 'haiku', tier: 'fast', reason: 'chosen' })
  })
  it('refuses models the connection does not have, and unmapped tiers', () => {
    expect(() => mapChosenModel('gpt-5', anthropic, 'Builder')).toThrow(/not a model of the anthropic connection/)
    expect(() => mapChosenModel('fast', litellm, 'Builder')).toThrow(/Builder/)
  })
})
