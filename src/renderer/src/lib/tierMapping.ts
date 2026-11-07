import type { ConnectionId, ModelRef, ModelTier, ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { modelForTier } from '@shared/defaults'

export interface EffectiveTier {
  tier: ModelTier
  label: string
  /** The model the tier resolves to on this connection (explicit mapping, else the catalog's automatic pick). */
  model?: ModelRef
  /** True when the tier has no explicit mapping and follows the catalog. */
  automatic: boolean
}

/**
 * What each tier resolves to on a connection, the same way a role resolves it (`modelForTier`). A tier with no explicit
 * mapping is Automatic and shows the model it follows, so a partial mapping never reads as a wiped one.
 */
export function effectiveTiers(
  connection: ConnectionId,
  tierModels: Partial<Record<ModelTier, ModelRef>>,
  catalog: readonly ProviderModel[]
): EffectiveTier[] {
  return MODEL_TIER_OPTIONS.map((o) => {
    const explicit = tierModels[o.value]?.trim()
    const hit = explicit ? undefined : modelForTier(o.value, { connection, tierModels, catalog })
    return { tier: o.value, label: o.label, model: explicit || hit?.model, automatic: !explicit && !!hit?.model }
  })
}
