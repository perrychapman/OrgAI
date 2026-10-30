import { describe, expect, it } from 'vitest'
import type { AgentUsage, ModelPrice, ModelUsageEntry, ProviderModel, TokenUsage } from '@shared/types'
import { BUILTIN_PRICES, aliasesFor, builtinPrice, costFor, listModelPrices, normalizeModelId, priceAgentUsage, resolvePrice, sanitizeModelPrice, type PricingContext } from './pricing'

const tok = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage => ({ input, output, cacheRead, cacheWrite })
const entry = (model: string, tokens: TokenUsage, providerCostUsd?: number): ModelUsageEntry => ({
  model,
  tokens,
  costUsd: null,
  priceSource: 'unknown',
  ...(providerCostUsd ? { providerCostUsd } : {})
})
const usage = (...models: ModelUsageEntry[]): AgentUsage => ({ tokens: tok(), models, costUsd: null, costSource: 'none', turns: 2, toolCalls: 3, retries: 1 })
const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({ overrides: [], catalog: [], ...over })
const proxyModel = (id: string, price?: ModelPrice, connection: ProviderModel['connection'] = 'litellm'): ProviderModel => ({
  id,
  label: id,
  connection,
  family: 'claude',
  adapter: 'claude',
  ...(price ? { price } : {}),
  source: 'discovered'
})
const MTOK = 1_000_000

describe('normalizeModelId', () => {
  it('lowercases and strips dates, suffixes and provider prefixes', () => {
    expect(normalizeModelId('Claude-Sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('claude-opus-4-5[1m]')).toBe('claude-opus-4-5')
    expect(normalizeModelId('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('anthropic.claude-haiku-4-5-v1:0')).toBe('claude-haiku-4-5')
    expect(normalizeModelId('azure/openai/gpt-5')).toBe('gpt-5')
    expect(normalizeModelId('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('  GPT-5  ')).toBe('gpt-5')
  })
})

describe('builtin table lookup', () => {
  it('matches exact ids, dated ids and longer variants on a - boundary', () => {
    expect(builtinPrice('claude-sonnet-4-5')).toBe(BUILTIN_PRICES['claude-sonnet-4-5'])
    expect(builtinPrice('claude-sonnet-4-5-20250929')).toBe(BUILTIN_PRICES['claude-sonnet-4-5'])
    expect(builtinPrice('claude-opus-4-5-thinking')).toBe(BUILTIN_PRICES['claude-opus-4-5'])
  })
  it('prefers the longest key and never matches across other boundaries', () => {
    expect(builtinPrice('gpt-5-mini')).toBe(BUILTIN_PRICES['gpt-5-mini'])
    expect(builtinPrice('gpt-5-mini-2025-08-07')).toBe(BUILTIN_PRICES['gpt-5-mini'])
    expect(builtinPrice('gpt-5.1-chat-latest')).toBe(BUILTIN_PRICES['gpt-5.1'])
    expect(builtinPrice('gpt-5.1-codex')).toBeNull()
    expect(builtinPrice('o3-mini')).toBeNull()
    expect(builtinPrice('gpt-5.3-codex')).toBe(BUILTIN_PRICES['gpt-5.3-codex'])
    expect(builtinPrice('gpt-5')).toBe(BUILTIN_PRICES['gpt-5'])
    expect(builtinPrice('claude-opus-4-1')).toBe(BUILTIN_PRICES['claude-opus-4-1'])
    expect(builtinPrice('gpt-50')).toBeNull()
  })
  it('leaves unpriced models and bare aliases unknown', () => {
    expect(builtinPrice('gpt-5-codex')).toBeNull()
    expect(builtinPrice('codex-mini-latest')).toBeNull()
    expect(builtinPrice('opus')).toBeNull()
    expect(builtinPrice('')).toBeNull()
    expect(builtinPrice('mock-unpriced')).toBeNull()
  })
  it('has the documented numbers', () => {
    expect(BUILTIN_PRICES['claude-sonnet-4-5']).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 })
    expect(BUILTIN_PRICES['gpt-5']).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 })
  })
})

describe('costFor', () => {
  it('prices each token kind per MTok', () => {
    const price: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
    expect(costFor(tok(MTOK, MTOK, MTOK, MTOK), price)).toBeCloseTo(22.05, 9)
  })
  it('prices missing cache rates at input', () => {
    expect(costFor(tok(0, 0, MTOK, MTOK), { inputPerMTok: 2, outputPerMTok: 8 })).toBeCloseTo(4, 9)
  })
})

describe('resolvePrice', () => {
  const ov = (model: string, input: number, connection?: 'anthropic' | 'openai' | 'litellm') => ({ model, ...(connection ? { connection } : {}), price: { inputPerMTok: input, outputPerMTok: input * 2 } })

  it('orders override > proxy > builtin', () => {
    const c = ctx({ connection: 'litellm', catalog: [proxyModel('claude-sonnet-4-5', { inputPerMTok: 7, outputPerMTok: 8 })] })
    expect(resolvePrice('claude-sonnet-4-5', c)).toMatchObject({ source: 'proxy', price: { inputPerMTok: 7 } })
    expect(resolvePrice('claude-sonnet-4-5', { ...c, overrides: [ov('Claude-Sonnet-4-5-20250929', 1)] })).toMatchObject({ source: 'override', price: { inputPerMTok: 1 } })
    expect(resolvePrice('claude-sonnet-4-5', ctx())).toMatchObject({ source: 'builtin' })
    expect(resolvePrice('mystery', ctx())).toBeNull()
  })

  it('lets a connection-scoped override beat a global one and ignores other connections', () => {
    const overrides = [ov('gpt-5', 9), ov('gpt-5', 4, 'litellm'), ov('gpt-5', 2, 'openai')]
    expect(resolvePrice('gpt-5', ctx({ connection: 'litellm', overrides }))?.price.inputPerMTok).toBe(4)
    expect(resolvePrice('gpt-5', ctx({ connection: 'anthropic', overrides }))?.price.inputPerMTok).toBe(9)
    expect(resolvePrice('gpt-5', ctx({ overrides }))?.price.inputPerMTok).toBe(9)
  })

  it('uses proxy prices only for the run connection', () => {
    const catalog = [proxyModel('llama-3-8b', { inputPerMTok: 1, outputPerMTok: 2 })]
    expect(resolvePrice('llama-3-8b', ctx({ connection: 'litellm', catalog }))).toMatchObject({ source: 'proxy' })
    expect(resolvePrice('llama-3-8b', ctx({ connection: 'openai', catalog }))).toBeNull()
    expect(resolvePrice('llama-3-8b', ctx({ catalog }))).toBeNull()
    // a catalog model with no price never resolves
    expect(resolvePrice('x', ctx({ connection: 'litellm', catalog: [proxyModel('x')] }))).toBeNull()
  })

  it('resolves an alias through the connection mapping first', () => {
    const c = ctx({ aliases: { opus: 'claude-opus-4-5', fast: 'gpt-5-mini' } })
    expect(resolvePrice('Opus', c)?.price).toBe(BUILTIN_PRICES['claude-opus-4-5'])
    expect(resolvePrice('fast', c)?.price).toBe(BUILTIN_PRICES['gpt-5-mini'])
    expect(resolvePrice('sonnet', c)).toBeNull()
  })
})

describe('priceAgentUsage', () => {
  it('prices from the built-in table as computed', () => {
    const u = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK, 0, MTOK))), ctx())
    expect(u.costUsd).toBeCloseTo(3.3, 9)
    expect(u.costSource).toBe('computed')
    expect(u.costPartial).toBeUndefined()
    expect(u.models[0]).toMatchObject({ priceSource: 'builtin' })
    expect(u.tokens).toEqual(tok(MTOK, 0, MTOK))
    expect(u).toMatchObject({ turns: 2, toolCalls: 3, retries: 1 })
  })

  it('prefers the provider cost over proxy and builtin, and an override over the provider cost', () => {
    const catalog = [proxyModel('claude-sonnet-4-5', { inputPerMTok: 100, outputPerMTok: 100 })]
    const c = ctx({ connection: 'litellm', catalog })
    const withProvider = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK), 0.42)), c)
    expect(withProvider.models[0]).toMatchObject({ costUsd: 0.42, priceSource: 'provider' })
    expect(withProvider.costSource).toBe('provider')
    const overridden = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK), 0.42)), { ...c, overrides: [{ model: 'claude-sonnet-4-5', price: { inputPerMTok: 1, outputPerMTok: 1 } }] })
    expect(overridden.models[0]).toMatchObject({ costUsd: 1, priceSource: 'override' })
    expect(overridden.costSource).toBe('computed')
  })

  it('uses proxy prices ahead of the table', () => {
    const c = ctx({ connection: 'litellm', catalog: [proxyModel('claude-sonnet-4-5', { inputPerMTok: 10, outputPerMTok: 20 })] })
    const u = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK, MTOK))), c)
    expect(u.costUsd).toBeCloseTo(30, 9)
    expect(u.models[0]?.priceSource).toBe('proxy')
  })

  it('reports tokens without a price as unknown, never zero', () => {
    const u = priceAgentUsage(usage(entry('mock-unpriced', tok(100, 50))), ctx())
    expect(u.costUsd).toBeNull()
    expect(u.costSource).toBe('unknown')
    expect(u.models[0]).toMatchObject({ costUsd: null, priceSource: 'unknown' })
  })

  it('marks a mix of priced and unpriced models partial', () => {
    const u = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK)), entry('mock-unpriced', tok(500))), ctx())
    expect(u.costUsd).toBeCloseTo(3, 9)
    expect(u.costSource).toBe('computed')
    expect(u.costPartial).toBe(true)
  })

  it('does not let an empty entry turn the total unknown or partial', () => {
    const u = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK)), entry('mock-unpriced', tok())), ctx())
    expect(u.costPartial).toBeUndefined()
    expect(u.costSource).toBe('computed')
    expect(u.models[1]).toMatchObject({ costUsd: 0 })
    const empty = priceAgentUsage(usage(entry('mock-unpriced', tok())), ctx())
    expect(empty).toMatchObject({ costUsd: 0, costSource: 'none' })
    expect(priceAgentUsage(usage(), ctx())).toMatchObject({ costUsd: 0, costSource: 'none' })
  })

  it('reports provider when every priced entry came from the provider', () => {
    const u = priceAgentUsage(usage(entry('a', tok(1), 0.1), entry('b', tok(1), 0.2)), ctx())
    expect(u.costSource).toBe('provider')
    expect(u.costUsd).toBeCloseTo(0.3, 9)
  })

  it('prices an alias-only model through the aliases', () => {
    const u = priceAgentUsage(usage(entry('opus', tok(MTOK))), ctx({ aliases: { opus: 'claude-opus-4-5' } }))
    expect(u.costUsd).toBeCloseTo(5, 9)
  })

  it('returns a new object and never mutates its input', () => {
    const input = usage(entry('claude-sonnet-4-5', tok(10)))
    const before = JSON.stringify(input)
    const out = priceAgentUsage(input, ctx())
    expect(JSON.stringify(input)).toBe(before)
    expect(out).not.toBe(input)
    expect(out.models[0]).not.toBe(input.models[0])
  })

  it('keeps producedNothing and legacy', () => {
    const input = { ...usage(), producedNothing: true as const, legacy: true as const }
    expect(priceAgentUsage(input, ctx())).toMatchObject({ producedNothing: true, legacy: true })
  })
})

describe('aliasesFor', () => {
  it('reads ANTHROPIC_DEFAULT_*_MODEL and falls back to tier names', () => {
    const conn = { connection: 'litellm' as const, adapter: 'claude' as const, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'bedrock/claude-opus-4-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: ' h ', ANTHROPIC_DEFAULT_SONNET_MODEL: '' } }
    expect(aliasesFor(conn, { deep: 'big-model', fast: 'small' })).toEqual({ opus: 'bedrock/claude-opus-4-5', haiku: 'h', deep: 'big-model', fast: 'small' })
    expect(aliasesFor(undefined, undefined)).toEqual({})
  })
})

describe('sanitizeModelPrice', () => {
  it('requires bounded input and output and drops bad cache fields', () => {
    expect(sanitizeModelPrice({ inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: -1, cacheWritePerMTok: 0, extra: 1 })).toEqual({ inputPerMTok: 1, outputPerMTok: 2, cacheWritePerMTok: 0 })
    expect(sanitizeModelPrice({ inputPerMTok: 1 })).toBeUndefined()
    expect(sanitizeModelPrice({ inputPerMTok: Infinity, outputPerMTok: 1 })).toBeUndefined()
    expect(sanitizeModelPrice({ inputPerMTok: 1, outputPerMTok: 10_001 })).toBeUndefined()
    expect(sanitizeModelPrice(null)).toBeUndefined()
    expect(sanitizeModelPrice([])).toBeUndefined()
  })
})

describe('listModelPrices', () => {
  const catalog = [proxyModel('llama', { inputPerMTok: 1, outputPerMTok: 2 }), proxyModel('nopeprice'), proxyModel('gpt-x', { inputPerMTok: 1, outputPerMTok: 2 }, 'openai')]
  const overrides = [
    { model: 'zeta', price: { inputPerMTok: 1, outputPerMTok: 1 } },
    { model: 'alpha', connection: 'litellm' as const, price: { inputPerMTok: 1, outputPerMTok: 1 } },
    { model: 'beta', connection: 'openai' as const, price: { inputPerMTok: 1, outputPerMTok: 1 } }
  ]

  it('lists overrides, then proxy, then builtin rows, sorted by model', () => {
    const rows = listModelPrices(undefined, overrides, catalog)
    const sources = rows.map((r) => r.source)
    expect(sources.indexOf('proxy')).toBeGreaterThan(sources.lastIndexOf('override') - 1)
    expect(sources.indexOf('builtin')).toBeGreaterThan(sources.lastIndexOf('proxy'))
    expect(rows.filter((r) => r.source === 'override').map((r) => r.model)).toEqual(['alpha', 'beta', 'zeta'])
    expect(rows.filter((r) => r.source === 'proxy').map((r) => r.model)).toEqual(['gpt-x', 'llama'])
    expect(rows.find((r) => r.model === 'alpha')?.connection).toBe('litellm')
    expect(rows.find((r) => r.model === 'zeta')?.connection).toBeUndefined()
    expect(rows.find((r) => r.model === 'llama')?.connection).toBe('litellm')
    expect(rows.some((r) => r.model === 'nopeprice')).toBe(false)
  })

  it('filters by connection', () => {
    const a = listModelPrices({ connection: 'anthropic' }, overrides, catalog)
    expect(a.filter((r) => r.source === 'builtin').every((r) => r.model.startsWith('claude'))).toBe(true)
    expect(a.map((r) => r.model)).not.toContain('beta')
    expect(a.map((r) => r.model)).toContain('zeta')
    expect(a.some((r) => r.source === 'proxy')).toBe(false)
    const o = listModelPrices({ connection: 'openai' }, overrides, catalog)
    expect(o.filter((r) => r.source === 'builtin').every((r) => !r.model.startsWith('claude'))).toBe(true)
    expect(o.filter((r) => r.source === 'proxy').map((r) => r.model)).toEqual(['gpt-x'])
    const l = listModelPrices({ connection: 'litellm' }, overrides, catalog)
    expect(l.filter((r) => r.source === 'builtin').length).toBe(Object.keys(BUILTIN_PRICES).length)
  })
})
