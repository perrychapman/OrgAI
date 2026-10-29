import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'

/** Token counts of one assistant message, split the way Anthropic prices them. */
export interface TokenMix {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/**
 * Relative price of each token category, in units of one uncached input token. These ratios hold across
 * the current Claude price list (output 5x, cache read 0.1x, 5-minute cache write 1.25x). ModelUsage only
 * reports a per-model costUSD, not per-category rates, so the ratios split that cost across the mix.
 */
const WEIGHTS: TokenMix = { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 }

export function weighted(mix: TokenMix): number {
  return (
    mix.input * WEIGHTS.input +
    mix.output * WEIGHTS.output +
    mix.cacheRead * WEIGHTS.cacheRead +
    mix.cacheCreation * WEIGHTS.cacheCreation
  )
}

/** USD per weighted token, per model id, derived from the latest result message. */
export interface CostRates {
  byModel: Map<string, number>
  /** Fallback for models the result did not list: total cost over all weighted tokens. */
  blended: number
}

const stripDate = (m: string): string => m.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')

/**
 * Effective rates from SDKResultMessage.modelUsage. Returns null when the result carries no usable cost
 * (crash results may be zeroed); callers then keep their previous rates.
 */
export function ratesFromModelUsage(modelUsage: Record<string, ModelUsage> | undefined): CostRates | null {
  if (!modelUsage) return null
  const byModel = new Map<string, number>()
  let cost = 0
  let tokens = 0
  for (const [key, u] of Object.entries(modelUsage)) {
    const w = weighted({
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cacheReadInputTokens ?? 0,
      cacheCreation: u.cacheCreationInputTokens ?? 0
    })
    if (!(w > 0) || !(u.costUSD > 0)) continue
    const rate = u.costUSD / w
    byModel.set(key, rate)
    if (u.canonicalModel && !byModel.has(u.canonicalModel)) byModel.set(u.canonicalModel, rate)
    cost += u.costUSD
    tokens += w
  }
  if (!byModel.size) return null
  return { byModel, blended: cost / tokens }
}

export function rateFor(rates: CostRates, model: string | undefined): number {
  if (!model) return rates.blended
  const exact = rates.byModel.get(model)
  if (exact !== undefined) return exact
  const want = stripDate(model)
  for (const [key, rate] of rates.byModel) {
    const k = stripDate(key)
    if (k === want || k.startsWith(want) || want.startsWith(k)) return rate
  }
  return rates.blended
}

/** Cost of an agent's messages: each message's weighted tokens at its model's rate. */
export function costOf(messages: Iterable<{ model?: string; mix: TokenMix }>, rates: CostRates): number {
  let usd = 0
  for (const m of messages) usd += weighted(m.mix) * rateFor(rates, m.model)
  return usd
}
