import { describe, expect, it } from 'vitest'
import type { AgentUsage, ModelPrice, ModelUsageEntry, ProviderModel, TokenUsage } from '@shared/types'
import { BUILTIN_PRICES, aliasesFor, cleanPrice, costFromPrice, normalizeModelKey, openAiMix, priceFor, pricingFromCatalog, builtinPrice, costFor, listModelPrices, normalizeModelId, priceAgentUsage, resolvePrice, sanitizeModelPrice, type PricingContext } from './pricing'

/** USD per MTok written as the stored per-token price (same rounding as the table). */
const pt = (perMTok: number): number => Math.round(perMTok * 1e6) / 1e12
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
    expect(BUILTIN_PRICES['claude-sonnet-4-5']).toEqual({ inputPerToken: pt(3), outputPerToken: pt(15), cacheReadPerToken: pt(0.3), cacheCreationPerToken: pt(3.75) })
    expect(BUILTIN_PRICES['gpt-5']).toEqual({ inputPerToken: pt(1.25), outputPerToken: pt(10), cacheReadPerToken: pt(0.125), cacheCreationPerToken: pt(1.25) })
  })
})

describe('costFor', () => {
  it('prices each token kind per MTok', () => {
    const price: ModelPrice = { inputPerToken: pt(3), outputPerToken: pt(15), cacheReadPerToken: pt(0.3), cacheCreationPerToken: pt(3.75) }
    expect(costFor(tok(MTOK, MTOK, MTOK, MTOK), price)).toBeCloseTo(22.05, 9)
  })
  it('prices missing cache rates at input', () => {
    expect(costFor(tok(0, 0, MTOK, MTOK), { inputPerToken: pt(2), outputPerToken: pt(8) })).toBeCloseTo(4, 9)
  })
})

describe('resolvePrice', () => {
  const ov = (model: string, input: number, connection?: 'anthropic' | 'openai' | 'litellm') => ({ model, ...(connection ? { connection } : {}), price: { inputPerToken: pt(input), outputPerToken: pt(input * 2) } })

  it('orders override > proxy > builtin', () => {
    const c = ctx({ connection: 'litellm', catalog: [proxyModel('claude-sonnet-4-5', { inputPerToken: pt(7), outputPerToken: pt(8) })] })
    expect(resolvePrice('claude-sonnet-4-5', c)).toMatchObject({ source: 'proxy', price: { inputPerToken: pt(7) } })
    expect(resolvePrice('claude-sonnet-4-5', { ...c, overrides: [ov('Claude-Sonnet-4-5-20250929', 1)] })).toMatchObject({ source: 'override', price: { inputPerToken: pt(1) } })
    expect(resolvePrice('claude-sonnet-4-5', ctx())).toMatchObject({ source: 'builtin' })
    expect(resolvePrice('mystery', ctx())).toBeNull()
  })

  it('lets a connection-scoped override beat a global one and ignores other connections', () => {
    const overrides = [ov('gpt-5', 9), ov('gpt-5', 4, 'litellm'), ov('gpt-5', 2, 'openai')]
    expect(resolvePrice('gpt-5', ctx({ connection: 'litellm', overrides }))?.price.inputPerToken).toBe(pt(4))
    expect(resolvePrice('gpt-5', ctx({ connection: 'anthropic', overrides }))?.price.inputPerToken).toBe(pt(9))
    expect(resolvePrice('gpt-5', ctx({ overrides }))?.price.inputPerToken).toBe(pt(9))
  })

  it('uses proxy prices only for the run connection', () => {
    const catalog = [proxyModel('llama-3-8b', { inputPerToken: pt(1), outputPerToken: pt(2) })]
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
    const catalog = [proxyModel('claude-sonnet-4-5', { inputPerToken: pt(100), outputPerToken: pt(100) })]
    const c = ctx({ connection: 'litellm', catalog })
    const withProvider = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK), 0.42)), c)
    expect(withProvider.models[0]).toMatchObject({ costUsd: 0.42, priceSource: 'provider' })
    expect(withProvider.costSource).toBe('provider')
    const overridden = priceAgentUsage(usage(entry('claude-sonnet-4-5', tok(MTOK), 0.42)), { ...c, overrides: [{ model: 'claude-sonnet-4-5', price: { inputPerToken: pt(1), outputPerToken: pt(1) } }] })
    expect(overridden.models[0]).toMatchObject({ costUsd: 1, priceSource: 'override' })
    expect(overridden.costSource).toBe('computed')
  })

  it('uses proxy prices ahead of the table', () => {
    const c = ctx({ connection: 'litellm', catalog: [proxyModel('claude-sonnet-4-5', { inputPerToken: pt(10), outputPerToken: pt(20) })] })
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
    expect(sanitizeModelPrice({ inputPerToken: pt(1), outputPerToken: pt(2), cacheReadPerToken: pt(-1), cacheCreationPerToken: pt(0), extra: 1 })).toEqual({ inputPerToken: pt(1), outputPerToken: pt(2), cacheCreationPerToken: pt(0) })
    expect(sanitizeModelPrice({ inputPerToken: pt(1) })).toBeUndefined()
    expect(sanitizeModelPrice({ inputPerToken: pt(Infinity), outputPerToken: pt(1) })).toBeUndefined()
    expect(sanitizeModelPrice({ inputPerToken: pt(1), outputPerToken: pt(10_001) })).toBeUndefined()
    expect(sanitizeModelPrice(null)).toBeUndefined()
    expect(sanitizeModelPrice([])).toBeUndefined()
  })
})

describe('listModelPrices', () => {
  const catalog = [proxyModel('llama', { inputPerToken: pt(1), outputPerToken: pt(2) }), proxyModel('nopeprice'), proxyModel('gpt-x', { inputPerToken: pt(1), outputPerToken: pt(2) }, 'openai')]
  const overrides = [
    { model: 'zeta', price: { inputPerToken: pt(1), outputPerToken: pt(1) } },
    { model: 'alpha', connection: 'litellm' as const, price: { inputPerToken: pt(1), outputPerToken: pt(1) } },
    { model: 'beta', connection: 'openai' as const, price: { inputPerToken: pt(1), outputPerToken: pt(1) } }
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

// ---------- per-token helpers shared with the adapters ----------

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
    expect(cleanPrice({ inputPerToken: 0.001, outputPerToken: 0.002, cacheReadPerToken: -1 })).toEqual({ inputPerToken: 0.001, outputPerToken: 0.002 })
    expect(cleanPrice({ inputPerToken: '1' as unknown as number, outputPerToken: 2 })).toBeUndefined()
    expect(cleanPrice(undefined)).toBeUndefined()
  })
})

describe('price bounds', () => {
  const huge = { inputPerToken: 1e300, outputPerToken: 1e300 }
  const ok = { inputPerToken: 0.000003, outputPerToken: 0.000015 }
  it('drops out-of-range prices from a catalog, a proxy map and the price list', () => {
    expect(pricingFromCatalog([{ id: 'x', price: huge }])).toBeUndefined()
    expect(cleanPrice(huge)).toBeUndefined()
    expect(resolvePrice('big', { overrides: [], pricing: { big: huge } })).toBeNull()
    const rows = listModelPrices({ connection: 'litellm' }, [], [
      { id: 'big', label: 'big', connection: 'litellm', family: 'other', adapter: 'claude', source: 'discovered', price: huge },
      { id: 'fine', label: 'fine', connection: 'litellm', family: 'other', adapter: 'claude', source: 'discovered', price: ok }
    ] as never)
    expect(rows.filter((r) => r.source === 'proxy').map((r) => r.model)).toEqual(['fine'])
  })
  it('reports a non-finite sum as unknown, never 0', () => {
    const usage = { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, models: [{ model: 'm', tokens: { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, priceSource: 'unknown' as const }], costUsd: null, costSource: 'none' as const, turns: 0, toolCalls: 0, retries: 0 }
    const out = priceAgentUsage(usage, { overrides: [{ model: 'm', price: { inputPerToken: 10, outputPerToken: 10 } }] })
    expect(out.costUsd).toBeNull()
    expect(out.costSource).toBe('unknown')
  })
  it('memoizes priceFor per pricing record', () => {
    const pricing = { 'claude-sonnet-4-5-v2': ok }
    expect(priceFor(pricing, 'claude-sonnet-4-5')).toBe(ok)
    expect(priceFor(pricing, 'claude-sonnet-4-5')).toBe(ok)
    expect(priceFor(pricing, 'claude-sonnet-4')).toBeUndefined()
  })
})
