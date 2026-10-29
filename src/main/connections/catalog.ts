import { adapterForFamily, defaultTierModels } from '@shared/defaults'
import { MODEL_TIERS } from '@shared/types'
import type { ConnectionId, ModelFamily, ModelRef, ModelTier, ProviderModel } from '@shared/types'

/** Pure helpers that turn discovered model ids into catalog entries. */

/**
 * Lineage from the id and (for LiteLLM) the `litellm_provider` field. anthropic / bedrock / vertex serving a
 * claude model => claude; openai / azure => openai; anything else falls back to the id, then 'other'.
 */
export function classifyFamily(id: string, litellmProvider?: string | null): ModelFamily {
  const p = (litellmProvider ?? '').toLowerCase()
  const b = id.trim().toLowerCase()
  const claudeId = b.includes('claude')
  if (p === 'anthropic' || p.startsWith('anthropic')) return 'claude'
  if ((p.includes('bedrock') || p.includes('vertex')) && claudeId) return 'claude'
  if (p === 'openai' || p === 'text-completion-openai' || p.startsWith('azure')) return 'openai'
  if (claudeId) return 'claude'
  if (/(^|\/)(gpt|o\d|codex|chatgpt)/.test(b)) return 'openai'
  return 'other'
}

function bare(id: string): string {
  const s = id.trim().toLowerCase()
  return s.slice(s.lastIndexOf('/') + 1)
}

/** Heuristic tier from the model id. undefined when nothing in the id hints at one. */
export function inferTier(id: string, family: ModelFamily): ModelTier | undefined {
  const b = bare(id)
  if (family === 'claude') {
    if (b.includes('fable')) return 'top'
    if (b.includes('opus')) return 'deep'
    if (b.includes('sonnet')) return 'everyday'
    if (b.includes('haiku')) return 'fast'
    return undefined
  }
  if (family === 'openai') {
    if (/nano/.test(b)) return 'fast'
    if (/mini/.test(b)) return 'everyday'
    if (/codex/.test(b) || /(^|-)pro($|-)/.test(b)) return 'top'
    if (/^(gpt|o\d|chatgpt)/.test(b)) return 'deep'
    return undefined
  }
  const size = /(?:^|[^\d.])(\d+(?:\.\d+)?)b(?:$|[^a-z])/.exec(b)
  if (size) {
    const n = Number(size[1])
    return n <= 14 ? 'fast' : n < 40 ? 'everyday' : 'deep'
  }
  if (/(tiny|small|lite|flash|mini|nano)/.test(b)) return 'fast'
  if (/medium/.test(b)) return 'everyday'
  if (/(large|big|ultra)/.test(b)) return 'deep'
  return undefined
}

export interface DiscoveredModelInput {
  id: string
  label?: string
  litellmProvider?: string | null
  contextWindow?: number
  hint?: string
  /** Force a family (Codex model/list is always openai). */
  family?: ModelFamily
  tier?: ModelTier
}

export function makeDiscoveredModel(connection: ConnectionId, m: DiscoveredModelInput): ProviderModel {
  const family = m.family ?? classifyFamily(m.id, m.litellmProvider)
  const tier = m.tier ?? inferTier(m.id, family)
  return {
    id: m.id,
    label: m.label?.trim() || m.id,
    connection,
    family,
    adapter: adapterForFamily(family),
    ...(tier ? { tier } : {}),
    ...(m.contextWindow && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    ...(m.hint ? { hint: m.hint } : {}),
    source: 'discovered'
  }
}

/**
 * Keep the user's mapping where it still points at a catalog model; fill empty tiers and replace tiers whose
 * model disappeared with the catalog's default for that tier (defaultTierModels). A tier the catalog cannot
 * fill is left out.
 */
export function autoFillTierModels(
  current: Partial<Record<ModelTier, ModelRef>>,
  models: readonly ProviderModel[]
): Partial<Record<ModelTier, ModelRef>> {
  const ids = new Set(models.map((m) => m.id))
  const defaults = defaultTierModels(models)
  const out: Partial<Record<ModelTier, ModelRef>> = {}
  for (const tier of MODEL_TIERS) {
    const cur = current[tier]
    if (cur && ids.has(cur)) out[tier] = cur
    else if (defaults[tier]) out[tier] = defaults[tier]
  }
  return out
}
