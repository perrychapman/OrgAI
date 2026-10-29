import { describe, expect, it } from 'vitest'
import type { ProviderModel } from '@shared/types'
import { autoFillTierModels, classifyFamily, inferTier, makeDiscoveredModel } from './catalog'

describe('classifyFamily', () => {
  it('uses litellm_provider first', () => {
    expect(classifyFamily('x', 'anthropic')).toBe('claude')
    expect(classifyFamily('anthropic.claude-3', 'bedrock')).toBe('claude')
    expect(classifyFamily('claude-3', 'vertex_ai-anthropic_models')).toBe('claude')
    expect(classifyFamily('my-model', 'openai')).toBe('openai')
    expect(classifyFamily('my-model', 'azure')).toBe('openai')
    expect(classifyFamily('llama', 'ollama')).toBe('other')
  })
  it('falls back to the id', () => {
    expect(classifyFamily('anthropic/claude-opus-4-5')).toBe('claude')
    expect(classifyFamily('gpt-5-mini')).toBe('openai')
    expect(classifyFamily('o3')).toBe('openai')
    expect(classifyFamily('mistral-large')).toBe('other')
  })
})

describe('inferTier', () => {
  it('claude by name', () => {
    expect(inferTier('claude-fable-1', 'claude')).toBe('top')
    expect(inferTier('anthropic/claude-opus-4-5', 'claude')).toBe('deep')
    expect(inferTier('claude-sonnet-4-5', 'claude')).toBe('everyday')
    expect(inferTier('claude-haiku-4-5', 'claude')).toBe('fast')
    expect(inferTier('claude-instant', 'claude')).toBeUndefined()
  })
  it('openai by suffix', () => {
    expect(inferTier('gpt-5-nano', 'openai')).toBe('fast')
    expect(inferTier('gpt-5-mini', 'openai')).toBe('everyday')
    expect(inferTier('gpt-5-codex', 'openai')).toBe('top')
    expect(inferTier('gpt-5', 'openai')).toBe('deep')
    expect(inferTier('o3', 'openai')).toBe('deep')
  })
  it('other by size hints', () => {
    expect(inferTier('llama-3-8b', 'other')).toBe('fast')
    expect(inferTier('qwen-32b', 'other')).toBe('everyday')
    expect(inferTier('llama-3.1-70b', 'other')).toBe('deep')
    expect(inferTier('foo-flash', 'other')).toBe('fast')
    expect(inferTier('foo', 'other')).toBeUndefined()
  })
})

describe('makeDiscoveredModel', () => {
  it('builds a discovered model with adapter, tier and context window', () => {
    expect(makeDiscoveredModel('litellm', { id: 'claude-opus-4-5', litellmProvider: 'anthropic', contextWindow: 200000 })).toEqual({
      id: 'claude-opus-4-5',
      label: 'claude-opus-4-5',
      connection: 'litellm',
      family: 'claude',
      adapter: 'claude',
      tier: 'deep',
      contextWindow: 200000,
      source: 'discovered'
    })
    const g = makeDiscoveredModel('openai', { id: 'gpt-5', family: 'openai', label: 'GPT-5' })
    expect(g).toMatchObject({ adapter: 'codex', label: 'GPT-5', tier: 'deep' })
    expect(g.contextWindow).toBeUndefined()
  })
})

describe('autoFillTierModels', () => {
  const m = (id: string, tier?: ProviderModel['tier']): ProviderModel => makeDiscoveredModel('litellm', { id, tier, family: 'other' })
  const models = [m('a', 'top'), m('b', 'deep'), m('c', 'deep'), m('d', 'fast')]
  it('fills an empty mapping from the catalog', () => {
    expect(autoFillTierModels({}, models)).toEqual({ top: 'a', deep: 'b', fast: 'd' })
  })
  it('keeps valid entries and replaces vanished ones', () => {
    expect(autoFillTierModels({ deep: 'c', top: 'gone', everyday: 'gone2' }, models)).toEqual({ top: 'a', deep: 'c', fast: 'd' })
  })
})
