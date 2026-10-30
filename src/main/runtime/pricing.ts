import type { AgentUsage, ConnectionId, ModelPrice, ModelPriceInfo, ModelPriceOverride, ModelPricesQuery, PriceSource, ProviderModel, TokenUsage } from '@shared/types'

/**
 * Host-side pricing (vendor-neutral, pure). Resolution per model: user override (AppSettings.modelPrices) >
 * provider-reported cost > 0 (ModelUsageEntry.providerCostUsd) > LiteLLM proxy price (ProviderModel.price in the
 * catalog) > built-in table > unknown. Implemented by the Runtime Engineer; signatures are the contract.
 */

/** Everything pricing needs for one run. */
export interface PricingContext {
  /** The run's connection; scopes overrides and proxy prices. */
  connection?: ConnectionId
  overrides: readonly ModelPriceOverride[]
  /** Catalog models (ProviderModel.price carries proxy prices). */
  catalog: readonly ProviderModel[]
  /**
   * Alias -> model id actually served (from RunConnection.env ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL,
   * else the connection's tierModels), so an agent reported only as 'opus' is priced as the remapped id.
   */
  aliases?: Record<string, string>
}

/** USD for these tokens at this price. */
export function costFor(_tokens: TokenUsage, _price: ModelPrice): number {
  throw new Error('costFor: not implemented')
}

/** The non-provider price for a model (override > proxy > builtin), or null. */
export function resolvePrice(_model: string, _ctx: PricingContext): { price: ModelPrice; source: Exclude<PriceSource, 'provider' | 'unknown'> } | null {
  throw new Error('resolvePrice: not implemented')
}

/** Price every model entry of an agent's usage and fill tokens, costUsd, costSource and costPartial. Returns a new object. */
export function priceAgentUsage(_usage: AgentUsage, _ctx: PricingContext): AgentUsage {
  throw new Error('priceAgentUsage: not implemented')
}

/** models:prices. */
export function listModelPrices(_query: ModelPricesQuery | undefined, _overrides: readonly ModelPriceOverride[], _catalog: readonly ProviderModel[]): ModelPriceInfo[] {
  throw new Error('listModelPrices: not implemented')
}
