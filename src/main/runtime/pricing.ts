import type { ModelPrice } from '@shared/types'

/**
 * Run cost estimates from per-token prices (LiteLLM /model/info, carried on RunConnection.pricing). Pure helpers
 * shared by the adapters; provider-neutral. Prices are USD per token.
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
 * names another model ("-mini", or "-5" in "claude-sonnet-4-5" against "claude-sonnet-4").
 */
const VERSION_SUFFIX = /^(?:[-@](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{3}|latest|v\d[\w.:-]*)|:\d[\w.-]*)$/

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
