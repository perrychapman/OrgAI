import type { AgentUsage, ConnectionId, ModelPrice, ModelPriceInfo, ModelPriceOverride, ModelPricesQuery, ModelTier, ModelUsageEntry, PriceSource, ProviderModel, TokenUsage } from '@shared/types'
import { MODEL_PRICE_MAX_PER_TOKEN, emptyTokens, totalTokens } from '@shared/defaults'
import type { RunConnection } from './types'

/**
 * Host-side pricing (vendor-neutral, pure). Prices are USD per token (ModelPrice).
 *
 * One resolution path per model, applied by RunManager to every agent (priceAgentUsage): user override
 * (AppSettings.modelPrices) > provider-reported cost > 0 (ModelUsageEntry.providerCostUsd) > LiteLLM proxy price
 * (RunConnection.pricing from /model/info, looked up with priceFor) > built-in table (BUILTIN_PRICES) > unknown (null).
 * The adapters' own LiteLLM estimates (costFromPrice / priceFor on RunConnection.pricing) only feed the legacy
 * AgentInstance.costUsd and run.cost fields; RunManager overwrites AgentInstance.costUsd with the priced result.
 *
 * The LiteLLM per-request cost header (x-litellm-response-cost) is not used: the SDK route exposes no response
 * headers, so proxy prices come only from /model/info.
 */

/**
 * Token counts priced separately. `input` is UNCACHED input only (Anthropic usage semantics). An adapter whose
 * provider reports input including cached tokens (OpenAI / Codex) subtracts the cached count first
 * (see `openAiMix`).
 */
export interface PricedTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** USD for a token mix at one price. Missing cache prices fall back to the input price. */
export function costFromPrice(mix: PricedTokens, price: ModelPrice): number {
  const input = price.inputPerToken
  const usd =
    finite(mix.input) * input +
    finite(mix.output) * price.outputPerToken +
    finite(mix.cacheRead) * (price.cacheReadPerToken ?? input) +
    finite(mix.cacheCreation) * (price.cacheCreationPerToken ?? input)
  return Number.isFinite(usd) && usd > 0 ? usd : 0
}

/** A Codex / OpenAI style total (input includes cached input) as PricedTokens. */
export function openAiMix(input: number, cachedInput: number, output: number): PricedTokens {
  const cached = Math.min(finite(cachedInput), finite(input))
  return { input: finite(input) - cached, output: finite(output), cacheRead: cached, cacheCreation: 0 }
}

/** Lower-case, no "provider/" prefix, no "-YYYYMMDD" date or "[1m]"-style suffix. */
export function normalizeModelKey(model: string): string {
  let m = model.trim().toLowerCase()
  m = m.slice(m.lastIndexOf('/') + 1)
  return m.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').replace(/@\d{8}$/, '')
}

/**
 * A suffix that only versions a model ("-v2", "-2024-08-06", "-20250929", "-001", ":0", "-latest"), never one that
 * names another model ("-mini", "-5" in "claude-sonnet-4-5" against "claude-sonnet-4", ":8b", "-405").
 */
const VERSION_SUFFIX = /^(?:[-@](?:\d{8}|\d{4}-\d{2}-\d{2}|00\d|latest|v\d+(?:[.:]\d+)*)|:\d+)$/

/** True when one key is the other plus a version suffix. */
function sameModelVersioned(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return long.startsWith(short) && VERSION_SUFFIX.test(long.slice(short.length))
}

/**
 * The price of `model`: an exact key first, then keys equal after normalizeModelKey, then the longest key that
 * differs from the model only by a version suffix (e.g. "claude-sonnet-4-5" vs "claude-sonnet-4-5-v2"; never
 * "gpt-5" for "gpt-5-mini"). undefined when nothing matches or there is no pricing.
 */
export function priceFor(pricing: Record<string, ModelPrice> | undefined, model: string | undefined): ModelPrice | undefined {
  if (!pricing || !model) return undefined
  if (Object.prototype.hasOwnProperty.call(pricing, model)) return pricing[model]
  const want = normalizeModelKey(model)
  if (!want) return undefined
  let best: { len: number; price: ModelPrice } | undefined
  for (const [key, price] of Object.entries(pricing)) {
    const k = normalizeModelKey(key)
    if (!k) continue
    if (k === want) return price
    if (sameModelVersioned(k, want)) {
      const len = Math.min(k.length, want.length)
      if (!best || len > best.len) best = { len, price }
    }
  }
  return best?.price
}

/**
 * The pricing map for a connection's catalog: every model with a price under its id. Models are given as
 * { id, price, upstream? }; `upstream` (litellm_params.model) adds a second key, its bare name, unless a model id
 * already uses that key. Returns undefined when no model has a price.
 */
export function pricingFromCatalog(
  models: readonly { id: string; price?: ModelPrice; upstream?: string }[]
): Record<string, ModelPrice> | undefined {
  const out: Record<string, ModelPrice> = Object.create(null) as Record<string, ModelPrice>
  const priced = models.flatMap((m) => {
    const price = cleanPrice(m.price)
    return price && typeof m.id === 'string' ? [{ id: m.id, price, upstream: m.upstream }] : []
  })
  for (const m of priced) out[m.id] = { ...m.price }
  for (const m of priced) {
    if (typeof m.upstream !== 'string') continue
    const bare = m.upstream.slice(m.upstream.lastIndexOf('/') + 1).trim()
    if (bare && !Object.prototype.hasOwnProperty.call(out, bare)) out[bare] = { ...m.price }
  }
  return Object.keys(out).length ? { ...out } : undefined
}

const rate = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** A price with only finite, non-negative numbers (models.json is re-read from disk); undefined when unusable. */
export function cleanPrice(p: ModelPrice | undefined): ModelPrice | undefined {
  if (!p || typeof p !== 'object') return undefined
  const input = rate(p.inputPerToken)
  const output = rate(p.outputPerToken)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = rate(p.cacheReadPerToken)
  const cacheCreation = rate(p.cacheCreationPerToken)
  return {
    inputPerToken: input,
    outputPerToken: output,
    ...(cacheRead !== undefined ? { cacheReadPerToken: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationPerToken: cacheCreation } : {})
  }
}

// ---------- host-side resolution (RunManager, models:prices, settings) ----------

/** Everything pricing needs for one run. */
export interface PricingContext {
  /** The run's connection; scopes overrides and proxy prices. */
  connection?: ConnectionId
  overrides: readonly ModelPriceOverride[]
  /**
   * The run's proxy prices (RunConnection.pricing, LiteLLM only). When absent, proxy prices are read from `catalog`
   * (models of `connection` with ProviderModel.price).
   */
  pricing?: Record<string, ModelPrice>
  /** Catalog models (ProviderModel.price carries proxy prices). Used when `pricing` is absent. */
  catalog?: readonly ProviderModel[]
  /**
   * Alias -> model id actually served (from RunConnection.env ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL,
   * else the connection's tierModels), so an agent reported only as 'opus' is priced as the remapped id.
   */
  aliases?: Record<string, string>
}

type ResolvedSource = Exclude<PriceSource, 'provider' | 'unknown'>

/** Table rows are written per million tokens and stored per token. */
const perToken = (perMTok: number): number => Math.round(perMTok * 1e6) / 1e12
function p(input: number, output: number, cacheRead: number, cacheWrite: number): ModelPrice {
  return { inputPerToken: perToken(input), outputPerToken: perToken(output), cacheReadPerToken: perToken(cacheRead), cacheCreationPerToken: perToken(cacheWrite) }
}
/** OpenAI lists input / cached input / output and no cache write: cache writes are priced at the input rate. */
function oa(input: number, cached: number, output: number): ModelPrice {
  return p(input, output, cached, input)
}

/**
 * Built-in prices, written in USD per million tokens and stored per token (cache write = the 5-minute rate).
 * Sources: platform.claude.com/docs/en/about-claude/pricing and developers.openai.com/api/docs/pricing, read 2026-10-30.
 * API id strings for 5.x models are unverified guesses. claude-haiku-5-5 is the price for prompts up to 100k tokens;
 * the above-100k tier (0.5 / 2.5 / 0.05 / 0.625) is not modelled. gpt-5-codex and codex-mini have no official price
 * and are deliberately absent (unknown unless overridden or proxy-priced).
 */
export const BUILTIN_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4': p(15, 75, 1.5, 18.75),
  'claude-opus-4-1': p(15, 75, 1.5, 18.75),
  'claude-opus-4-5': p(5, 25, 0.5, 6.25),
  'claude-opus-4-6': p(5, 25, 0.5, 6.25),
  'claude-opus-4-7': p(5, 25, 0.5, 6.25),
  'claude-opus-4-8': p(5, 25, 0.5, 6.25),
  'claude-opus-5': p(5, 25, 0.5, 6.25),
  'claude-opus-5-5': p(4, 20, 0.2, 5),
  'claude-sonnet-4': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4-5': p(3, 15, 0.3, 3.75),
  'claude-sonnet-4-6': p(3, 15, 0.3, 3.75),
  'claude-sonnet-5': p(2, 10, 0.2, 2.5),
  'claude-sonnet-5-5': p(2, 10, 0.1, 2.5),
  'claude-haiku-4-5': p(1, 5, 0.1, 1.25),
  'claude-3-5-haiku': p(0.8, 4, 0.08, 1),
  'claude-haiku-5-5': p(0.1, 0.5, 0.01, 0.125),
  'claude-fable-5': p(10, 50, 1, 12.5),
  'claude-fable-5-1': p(10, 50, 0.25, 12.5),
  'gpt-5': oa(1.25, 0.125, 10),
  'gpt-5.1': oa(1.25, 0.125, 10),
  'gpt-5-mini': oa(0.25, 0.025, 2),
  'gpt-5-nano': oa(0.05, 0.005, 0.4),
  'gpt-5.2': oa(1.75, 0.175, 14),
  'gpt-5.3-codex': oa(1.75, 0.175, 14),
  'gpt-5.4': oa(2.5, 0.25, 15),
  'gpt-5.4-mini': oa(0.75, 0.075, 4.5),
  'gpt-5.4-nano': oa(0.2, 0.02, 1.25),
  'gpt-5.5': oa(5, 0.5, 30),
  'gpt-4.1': oa(2, 0.5, 8),
  'gpt-4o': oa(2.5, 1.25, 10),
  o3: oa(2, 0.5, 8),
  'o4-mini': oa(1.1, 0.275, 4.4)
}

/**
 * Canonical form for matching: lowercase; a [1m]-style suffix, a provider prefix up to the last '/', a Bedrock
 * 'anthropic.' (optionally region-prefixed) prefix, a '-v1:0' suffix and a trailing -YYYYMMDD / @YYYYMMDD date stamp
 * are removed.
 */
export function normalizeModelId(id: string): string {
  let s = String(id ?? '').trim().toLowerCase()
  s = s.replace(/\[[^\]]*\]\s*$/, '')
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
  s = s.replace(/-v\d+:\d+$/, '')
  s = s.replace(/[-@]\d{8}$/, '')
  return s
}

const VARIANT_WORDS: ReadonlySet<string> = new Set(['codex', 'mini', 'nano', 'pro'])
const BUILTIN_KEYS =Object.keys(BUILTIN_PRICES).sort((a, b) => b.length - a.length)

/** Table lookup: exact normalized id, else the longest key that prefixes it on a '-' boundary. */
export function builtinPrice(model: string): ModelPrice | null {
  const id = normalizeModelId(model)
  if (!id) return null
  if (Object.hasOwn(BUILTIN_PRICES, id)) return BUILTIN_PRICES[id]!
  for (const key of BUILTIN_KEYS) {
    if (!id.startsWith(key + '-')) continue
    // A variant of a different price class (gpt-5-codex, o3-mini, gpt-5-pro) is not the base model: stays unknown
    // unless the table lists it itself.
    if (id.slice(key.length + 1).split('-').some((part) => VARIANT_WORDS.has(part))) continue
    return BUILTIN_PRICES[key]!
  }
  return null
}

/** USD for these tokens at this price (costFromPrice with TokenUsage). */
export function costFor(tokens: TokenUsage, price: ModelPrice): number {
  return costFromPrice({ input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheCreation: tokens.cacheWrite }, price)
}

function applyAlias(model: string, ctx: PricingContext): string {
  const aliases = ctx.aliases
  if (!aliases) return model
  const key = model.trim().toLowerCase()
  return Object.hasOwn(aliases, key) && aliases[key] ? aliases[key]! : model
}

function overrideFor(id: string, ctx: PricingContext): ModelPrice | null {
  let global: ModelPrice | null = null
  let scoped: ModelPrice | null = null
  for (const o of ctx.overrides) {
    if (normalizeModelId(o.model) !== id) continue
    if (o.connection === undefined) global = o.price
    else if (o.connection === ctx.connection) scoped = o.price
  }
  return scoped ?? global
}

function proxyFor(served: string, id: string, ctx: PricingContext): ModelPrice | null {
  if (ctx.pricing) return priceFor(ctx.pricing, served) ?? null
  if (!ctx.connection || !ctx.catalog) return null
  for (const m of ctx.catalog) {
    if (m.connection === ctx.connection && m.price && normalizeModelId(m.id) === id) return m.price
  }
  return null
}

/** The non-provider price for a model (override > proxy > builtin), or null. */
export function resolvePrice(model: string, ctx: PricingContext): { price: ModelPrice; source: ResolvedSource } | null {
  const served = applyAlias(model, ctx)
  const id = normalizeModelId(served)
  if (!id) return null
  const override = overrideFor(id, ctx)
  if (override) return { price: override, source: 'override' }
  const proxy = proxyFor(served, id, ctx)
  if (proxy) return { price: proxy, source: 'proxy' }
  const builtin = builtinPrice(served)
  if (builtin) return { price: builtin, source: 'builtin' }
  return null
}

/** Cost summary over priced entries; shared by agent and run aggregation. */
export interface CostRollup {
  costUsd: number | null
  costSource: AgentUsage['costSource']
  costPartial?: true
}

/**
 * Roll entries up. An entry is active when it has tokens or a provider cost; inactive entries never affect the
 * source or partial flag. `unpricedTokens` is true when the entry list has tokens but none are priced.
 */
export function rollupCosts(entries: readonly Pick<ModelUsageEntry, 'tokens' | 'costUsd' | 'priceSource' | 'providerCostUsd'>[]): CostRollup {
  let active = 0
  let priced = 0
  let allProvider = true
  let sum = 0
  for (const e of entries) {
    if (totalTokens(e.tokens) <= 0 && !(e.providerCostUsd && e.providerCostUsd > 0)) continue
    active++
    if (e.costUsd === null) continue
    priced++
    sum += e.costUsd
    if (e.priceSource !== 'provider') allProvider = false
  }
  if (active === 0) return { costUsd: 0, costSource: 'none' }
  if (priced === 0) return { costUsd: null, costSource: 'unknown' }
  const out: CostRollup = { costUsd: sum, costSource: allProvider ? 'provider' : 'computed' }
  if (priced < active) out.costPartial = true
  return out
}

/** Price every model entry of an agent's usage and fill tokens, costUsd, costSource and costPartial. Returns a new object. */
export function priceAgentUsage(usage: AgentUsage, ctx: PricingContext): AgentUsage {
  const models: ModelUsageEntry[] = usage.models.map((m) => {
    const entry: ModelUsageEntry = { ...m, tokens: { ...m.tokens } }
    const resolved = resolvePrice(m.model, ctx)
    const provider = m.providerCostUsd !== undefined && Number.isFinite(m.providerCostUsd) && m.providerCostUsd > 0 ? m.providerCostUsd : 0
    if (resolved?.source === 'override') {
      entry.costUsd = costFor(m.tokens, resolved.price)
      entry.priceSource = 'override'
    } else if (provider > 0) {
      entry.costUsd = provider
      entry.priceSource = 'provider'
    } else if (resolved) {
      entry.costUsd = costFor(m.tokens, resolved.price)
      entry.priceSource = resolved.source
    } else if (totalTokens(m.tokens) <= 0) {
      entry.costUsd = 0
      entry.priceSource = 'unknown'
    } else {
      entry.costUsd = null
      entry.priceSource = 'unknown'
    }
    return entry
  })
  const tokens = models.reduce<TokenUsage>((acc, m) => ({ input: acc.input + m.tokens.input, output: acc.output + m.tokens.output, cacheRead: acc.cacheRead + m.tokens.cacheRead, cacheWrite: acc.cacheWrite + m.tokens.cacheWrite }), emptyTokens())
  const roll = rollupCosts(models)
  const out: AgentUsage = { ...usage, tokens, models, costUsd: roll.costUsd, costSource: roll.costSource }
  if (roll.costPartial) out.costPartial = true
  else delete out.costPartial
  return out
}

const ALIAS_ENV: Record<string, string> = {
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku'
}

/** Alias map for a run: ANTHROPIC_DEFAULT_*_MODEL from the connection env, plus tier names from tierModels. */
export function aliasesFor(connection: RunConnection | undefined, tierModels?: Partial<Record<ModelTier, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [envKey, alias] of Object.entries(ALIAS_ENV)) {
    const v = connection?.env?.[envKey]
    if (typeof v === 'string' && v.trim()) out[alias] = v.trim()
  }
  if (tierModels) {
    for (const [tier, id] of Object.entries(tierModels)) {
      if (typeof id === 'string' && id.trim() && !Object.hasOwn(out, tier)) out[tier] = id.trim()
    }
  }
  return out
}

function validPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MODEL_PRICE_MAX_PER_TOKEN
}

/**
 * A fresh ModelPrice from untrusted data (settings, a stored catalog), or undefined. Input and output are required;
 * cache prices are kept when valid and dropped when not.
 */
export function sanitizeModelPrice(raw: unknown): ModelPrice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!validPrice(r.inputPerToken) || !validPrice(r.outputPerToken)) return undefined
  const out: ModelPrice = { inputPerToken: r.inputPerToken, outputPerToken: r.outputPerToken }
  if (validPrice(r.cacheReadPerToken)) out.cacheReadPerToken = r.cacheReadPerToken
  if (validPrice(r.cacheCreationPerToken)) out.cacheCreationPerToken = r.cacheCreationPerToken
  return out
}

const SOURCE_ORDER: Record<ResolvedSource, number> = { override: 0, proxy: 1, builtin: 2, community: 3 }

/** models:prices. */
export function listModelPrices(query: ModelPricesQuery | undefined, overrides: readonly ModelPriceOverride[], catalog: readonly ProviderModel[]): ModelPriceInfo[] {
  const conn = query?.connection
  const rows: ModelPriceInfo[] = []
  for (const o of overrides) {
    if (conn && o.connection && o.connection !== conn) continue
    const row: ModelPriceInfo = { model: o.model, price: o.price, source: 'override' }
    if (o.connection) row.connection = o.connection
    rows.push(row)
  }
  for (const m of catalog) {
    if (!m.price) continue
    if (conn && m.connection !== conn) continue
    rows.push({ model: m.id, connection: m.connection, price: m.price, source: 'proxy' })
  }
  for (const [model, price] of Object.entries(BUILTIN_PRICES)) {
    const anthropic = model.startsWith('claude')
    if (conn === 'anthropic' && !anthropic) continue
    if (conn === 'openai' && anthropic) continue
    rows.push({ model, price, source: 'builtin' })
  }
  return rows.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.model.localeCompare(b.model))
}
