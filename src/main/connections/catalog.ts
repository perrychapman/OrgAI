import { adapterForFamily, builtinModels, defaultTierModels, tierForModel } from '@shared/defaults'
import { MODEL_TIERS } from '@shared/types'
import { sanitizeModelPrice } from '../runtime/pricing'
import type { AdapterModelInfo } from '../runtime/types'
import { validModelId } from './codexAccount'
import type { ConnectionId, ModelFamily, ModelPrice, ModelRef, ModelTier, ProviderModel } from '@shared/types'

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
  /** The provider marks it as its default or recommended choice. */
  recommended?: boolean
  /** LiteLLM /model/info prices. */
  price?: ModelPrice
  /** LiteLLM litellm_params.model. */
  upstream?: string
}

export function makeDiscoveredModel(connection: ConnectionId, m: DiscoveredModelInput): ProviderModel {
  // Proxy text is untrusted: bounded here, prices must be within range or they are dropped.
  const cap = (v: string | undefined): string | undefined => v?.slice(0, 200)
  const price = sanitizeModelPrice(m.price)
  const upstream = cap(m.upstream)
  m = { ...m, label: cap(m.label), litellmProvider: cap(m.litellmProvider ?? undefined) ?? null }
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
    source: 'discovered',
    ...(m.recommended ? { recommended: true } : {}),
    ...(price ? { price } : {}),
    ...(upstream ? { upstream } : {})
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

/**
 * Heuristic tier from a provider's own description of a model, for families the id does not reveal. The strongest
 * claim wins. undefined when the text says nothing recognisable.
 */
export function tierFromDescription(text: string | undefined): ModelTier | undefined {
  const t = (text ?? '').toLowerCase()
  if (!t) return undefined
  if (/most (capable|intelligent|powerful|advanced)|frontier/.test(t)) return 'top'
  if (/complex|deep reasoning|hardest|difficult/.test(t)) return 'deep'
  if (/everyday|balanced|general[- ]purpose/.test(t)) return 'everyday'
  if (/fastest|quick|cheap|lightweight|simple tasks|low[- ]latency/.test(t)) return 'fast'
  return undefined
}

/**
 * Map the Claude adapter's model list (SDK supportedModels) to anthropic catalog entries. Ids keep their tier by
 * name (tierForModel); a context variant such as 'sonnet[1m]' gets none (listed, never suggested); an unknown family
 * gets a tier from its description when the text says one; otherwise it is listed without a tier.
 */
export function anthropicModelsToCatalog(list: readonly AdapterModelInfo[]): ProviderModel[] {
  const seen = new Set<string>()
  const out: ProviderModel[] = []
  for (const info of list) {
    const id = info.id?.trim()
    if (!id || id === 'default' || seen.has(id) || !validModelId(id)) continue
    seen.add(id)
    const tier = id.includes('[') ? undefined : (tierForModel(id) ?? tierFromDescription(info.description))
    const { tier: _inferred, ...entry } = makeDiscoveredModel('anthropic', {
      id,
      label: info.label,
      family: 'claude',
      hint: info.description?.slice(0, 300)
    })
    out.push(tier ? { ...entry, tier } : entry)
  }
  return out
}

/**
 * The tier mapping a catalog suggests: defaultTierModels (recommended first, then catalog order). On anthropic a
 * bare alias of the tier (/^[a-z]+$/, e.g. 'sonnet') is preferred over a full id so the tier keeps floating to the
 * newest model of its family.
 */
export function suggestTierModels(connection: ConnectionId, catalog: readonly ProviderModel[]): Partial<Record<ModelTier, ModelRef>> {
  const own = catalog.filter((m) => m.connection === connection)
  const out = defaultTierModels(own)
  if (connection === 'anthropic') {
    for (const tier of MODEL_TIERS) {
      const alias = own.find((m) => m.tier === tier && /^[a-z]+$/.test(m.id))
      if (alias) out[tier] = alias.id
    }
  }
  return out
}

/** The connection's builtin default mapping (what a fresh install holds). */
export function builtinTierModels(connection: ConnectionId): Partial<Record<ModelTier, ModelRef>> {
  return defaultTierModels(builtinModels(connection))
}
