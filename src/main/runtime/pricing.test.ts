import { describe, expect, it } from 'vitest'
import type { ModelPrice } from '@shared/types'
import { cleanPrice, costFromPrice, normalizeModelKey, openAiMix, priceFor, pricingFromCatalog } from './pricing'

const sonnet: ModelPrice = { inputPerToken: 3e-6, outputPerToken: 1.5e-5, cacheReadPerToken: 3e-7, cacheCreationPerToken: 3.75e-6 }

describe('costFromPrice', () => {
  it('prices each token category', () => {
    const usd = costFromPrice({ input: 1000, output: 100, cacheRead: 10_000, cacheCreation: 2000 }, sonnet)
    expect(usd).toBeCloseTo(1000 * 3e-6 + 100 * 1.5e-5 + 10_000 * 3e-7 + 2000 * 3.75e-6, 12)
  })
  it('falls back to the input price for missing cache prices and ignores junk counts', () => {
    expect(costFromPrice({ input: 0, output: 0, cacheRead: 100, cacheCreation: 100 }, { inputPerToken: 1e-6, outputPerToken: 2e-6 })).toBeCloseTo(2e-4, 12)
    expect(costFromPrice({ input: -5, output: Number.NaN, cacheRead: 0, cacheCreation: 0 }, sonnet)).toBe(0)
    expect(costFromPrice({ input: 100, output: 100, cacheRead: 0, cacheCreation: 0 }, { inputPerToken: 0, outputPerToken: 0 })).toBe(0)
  })
})

describe('openAiMix', () => {
  it('splits cached input out of the input total', () => {
    expect(openAiMix(1200, 200, 300)).toEqual({ input: 1000, output: 300, cacheRead: 200, cacheCreation: 0 })
    expect(openAiMix(100, 500, 0)).toEqual({ input: 0, output: 0, cacheRead: 100, cacheCreation: 0 })
  })
})

describe('priceFor', () => {
  const pricing = { 'claude-sonnet-4-5': sonnet, 'gpt-5': { inputPerToken: 1.25e-6, outputPerToken: 1e-5 } }
  it('matches exactly, then by normalized name and version suffix', () => {
    expect(priceFor(pricing, 'claude-sonnet-4-5')).toBe(sonnet)
    expect(priceFor(pricing, 'claude-sonnet-4-5-20250929')).toBe(sonnet)
    expect(priceFor(pricing, 'anthropic/Claude-Sonnet-4-5')).toBe(sonnet)
    expect(priceFor(pricing, 'claude-sonnet-4-5[1m]')).toBe(sonnet)
    expect(priceFor(pricing, 'claude-sonnet-4-5-v2')).toBe(sonnet)
    expect(priceFor(pricing, 'gpt-5-2025-08-07')).toBe(pricing['gpt-5'])
  })
  it('never prices a different model by prefix', () => {
    expect(priceFor(pricing, 'gpt-5-mini')).toBeUndefined()
    expect(priceFor(pricing, 'claude-sonnet-4')).toBeUndefined()
    expect(priceFor(pricing, undefined)).toBeUndefined()
    expect(priceFor(undefined, 'gpt-5')).toBeUndefined()
    expect(priceFor(pricing, 'constructor')).toBeUndefined()
    const sizes = { llama3: sonnet, foo: sonnet }
    expect(priceFor(sizes, 'llama3:8b')).toBeUndefined()
    expect(priceFor(sizes, 'foo-405')).toBeUndefined()
    expect(priceFor(sizes, 'llama3:0')).toBe(sonnet)
    expect(priceFor(sizes, 'foo-001')).toBe(sonnet)
  })
  it('normalizes keys', () => {
    expect(normalizeModelKey(' Bedrock/anthropic.claude-x-20250101 ')).toBe('anthropic.claude-x')
  })
})

describe('pricingFromCatalog', () => {
  it('keys by id plus the bare upstream name, never overriding an id', () => {
    const cheap = { inputPerToken: 1e-7, outputPerToken: 1e-7 }
    const out = pricingFromCatalog([
      { id: 'sonnet-alias', price: sonnet, upstream: 'anthropic/claude-sonnet-4-5' },
      { id: 'claude-sonnet-4-5', price: cheap },
      { id: 'free-llama' },
      { id: 'bad', price: { inputPerToken: Number.NaN, outputPerToken: 1 } }
    ])
    expect(out).toEqual({ 'sonnet-alias': sonnet, 'claude-sonnet-4-5': cheap })
    expect(pricingFromCatalog([{ id: 'x' }])).toBeUndefined()
  })
  it('cleanPrice drops non-finite and negative rates', () => {
    expect(cleanPrice({ inputPerToken: 1, outputPerToken: 2, cacheReadPerToken: -1 })).toEqual({ inputPerToken: 1, outputPerToken: 2 })
    expect(cleanPrice({ inputPerToken: '1' as unknown as number, outputPerToken: 2 })).toBeUndefined()
    expect(cleanPrice(undefined)).toBeUndefined()
  })
})
