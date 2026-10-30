import { describe, expect, it } from 'vitest'
import { anthropicModelsToCatalog, suggestTierModels, tierFromDescription } from './catalog'

describe('tierFromDescription', () => {
  it('reads tier claims from the provider text', () => {
    expect(tierFromDescription('Our most capable model for frontier work')).toBe('top')
    expect(tierFromDescription('Best for complex reasoning')).toBe('deep')
    expect(tierFromDescription('Balanced for everyday tasks')).toBe('everyday')
    expect(tierFromDescription('Fastest model for simple tasks')).toBe('fast')
    expect(tierFromDescription('A model')).toBeUndefined()
    expect(tierFromDescription(undefined)).toBeUndefined()
  })
})

describe('anthropicModelsToCatalog', () => {
  const list = [
    { id: 'default', label: 'Default' },
    { id: 'opus', label: 'Opus', description: 'Powerful' },
    { id: 'sonnet[1m]', label: 'Sonnet 1M' },
    { id: 'claude-haiku-9', label: 'Haiku 9' },
    { id: 'mythos', label: 'Mythos', description: 'Our most capable model' },
    { id: 'mystery', label: 'Mystery', description: 'Does things' },
    { id: 'opus' }
  ]
  const out = anthropicModelsToCatalog(list)

  it('maps ids by name, variants get no tier, unknown families use the description', () => {
    expect(out.map((m) => m.id)).toEqual(['opus', 'sonnet[1m]', 'claude-haiku-9', 'mythos', 'mystery'])
    expect(Object.fromEntries(out.map((m) => [m.id, m.tier]))).toEqual({
      opus: 'deep',
      'sonnet[1m]': undefined,
      'claude-haiku-9': 'fast',
      mythos: 'top',
      mystery: undefined
    })
    expect(out[0]).toMatchObject({ connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'discovered', hint: 'Powerful' })
  })

  it('suggests a bare alias over a full id', () => {
    const catalog = anthropicModelsToCatalog([{ id: 'claude-opus-9' }, { id: 'opus' }, { id: 'claude-haiku-9' }])
    expect(suggestTierModels('anthropic', catalog)).toEqual({ deep: 'opus', fast: 'claude-haiku-9' })
  })
})
