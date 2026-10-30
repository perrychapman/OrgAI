import { ANTHROPIC_BUILTIN_MODELS, importTierForModel } from '@shared/defaults'
import type { AgentImportModelReason, ConnectionId, ModelRef, ModelTier, ProviderModel } from '@shared/types'
import { MODEL_TIERS, isModelTier } from '@shared/types'

/** What the model mapping needs from the project's connection (ConnectionService). */
export interface ModelContext {
  connection: ConnectionId
  /** The connection's catalog (builtin plus discovered). Entries of other connections are ignored. */
  catalog: readonly ProviderModel[]
  /** The connection's tier mapping. */
  tierModels: Partial<Record<ModelTier, ModelRef>>
}

export interface MappedModel {
  model: ModelRef
  tier?: ModelTier
  reason: AgentImportModelReason
  /** A readable note for the preview, when something was not straightforward. */
  note?: string
  /** The original was given but not recognised (it fell back to the everyday tier). */
  unknown?: boolean
}

/** Tiers ordered by closeness to `tier`, the tier itself first. */
function nearestTiers(tier: ModelTier): ModelTier[] {
  const i = MODEL_TIERS.indexOf(tier)
  return [...MODEL_TIERS].sort((a, b) => Math.abs(MODEL_TIERS.indexOf(a) - i) - Math.abs(MODEL_TIERS.indexOf(b) - i))
}

/**
 * The model a tier gets on the connection: its tierModels entry; on anthropic the builtin alias when the mapping
 * lacks it; otherwise the nearest mapped tier. undefined when the connection maps no tier at all.
 */
export function modelForTier(tier: ModelTier, ctx: ModelContext): { model: ModelRef; tier: ModelTier } | undefined {
  for (const t of nearestTiers(tier)) {
    const mapped = ctx.tierModels[t]?.trim()
    if (mapped) return { model: mapped, tier: t }
    if (ctx.connection === 'anthropic') {
      const alias = ANTHROPIC_BUILTIN_MODELS.find((m) => m.tier === t)?.id
      if (alias) return { model: alias, tier: t }
    }
  }
  return undefined
}

function catalogEntry(model: string, ctx: ModelContext): ProviderModel | undefined {
  return ctx.catalog.find((m) => m.connection === ctx.connection && m.id === model)
}

function viaTier(tier: ModelTier, ctx: ModelContext, reason: AgentImportModelReason, note?: string): MappedModel {
  const hit = modelForTier(tier, ctx)
  if (!hit) {
    return { model: 'inherit', reason: 'inherit', note: `No model is mapped for any tier on the ${ctx.connection} connection, so it inherits. Map tiers in App settings > Connections.` }
  }
  const moved = hit.tier !== tier ? `No ${tier} model on ${ctx.connection}; using the ${hit.tier} tier.` : undefined
  return { model: hit.model, tier: hit.tier, reason, note: [note, moved].filter(Boolean).join(' ') || undefined }
}

/**
 * Map an imported agent's model to the project's connection:
 * - 'inherit' stays inherit;
 * - a model that is in the connection's catalog is kept (tier from the catalog entry or the classifier);
 * - otherwise the tier (the export's tier, else importTierForModel) picks the connection's tier model;
 * - a missing or unrecognised model gets the 'everyday' tier, with a note.
 */
export function mapImportedModel(original: string | undefined, ctx: ModelContext, exportTier?: ModelTier): MappedModel {
  const raw = original?.trim() ?? ''
  if (raw.toLowerCase() === 'inherit') return { model: 'inherit', reason: 'inherit' }
  if (raw) {
    const hit = catalogEntry(raw, ctx)
    if (hit) return { model: hit.id, tier: hit.tier ?? importTierForModel(raw) ?? exportTier, reason: 'kept' }
  }
  const tier = (isModelTier(exportTier) ? exportTier : undefined) ?? importTierForModel(raw)
  if (tier) return viaTier(tier, ctx, 'tier')
  if (!raw) return viaTier('everyday', ctx, 'default', 'No model given; using the everyday tier.')
  return { ...viaTier('everyday', ctx, 'default', `Model "${raw.slice(0, 80)}" is not recognised; using the everyday tier.`), unknown: true }
}

/**
 * A user's model choice (AgentImportChoice.model): 'inherit', a catalog model of the connection, or a tier name
 * mapped there. Throws a readable error for anything else.
 */
export function mapChosenModel(choice: string, ctx: ModelContext, roleName: string): MappedModel {
  const value = typeof choice === 'string' ? choice.trim() : ''
  if (value === 'inherit') return { model: 'inherit', reason: 'chosen' }
  const hit = value ? catalogEntry(value, ctx) : undefined
  if (hit) return { model: hit.id, tier: hit.tier ?? importTierForModel(value), reason: 'chosen' }
  if (isModelTier(value)) {
    const t = modelForTier(value, ctx)
    if (t && t.tier === value) return { model: t.model, tier: value, reason: 'chosen' }
  }
  throw new Error(`"${value.slice(0, 80)}" is not a model of the ${ctx.connection} connection, so ${roleName.slice(0, 80)} cannot use it. Pick a model from the list.`)
}
