import { adapterForFamily, builtinModels, defaultTierModels, tierForModel } from '@shared/defaults'
import { MODEL_TIERS, isBuiltinConnectionId } from '@shared/types'
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
  if (/(^|[/.])(gpt|o\d|codex|chatgpt)/.test(b)) return 'openai'
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
    if (/(^|\.)(gpt|o\d|chatgpt)/.test(b)) return 'deep'
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
  /** A proxy's `owned_by` (untrusted; kept only when printable, at most 64 chars). */
  ownedBy?: string
}

/** A proxy's owned_by as catalog text: a printable one-line string of at most 64 chars, else undefined. Pure. */
export function cleanOwnedBy(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t || t.length > 64 || !/^[\x20-\x7e]+$/.test(t)) return undefined
  return t
}

export function makeDiscoveredModel(connection: ConnectionId, m: DiscoveredModelInput): ProviderModel {
  // Proxy text is untrusted: bounded here, prices must be within range or they are dropped.
  const cap = (v: string | undefined): string | undefined => v?.slice(0, 200)
  const ownedBy = cleanOwnedBy(m.ownedBy)
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
    ...(upstream ? { upstream } : {}),
    ...(ownedBy ? { ownedBy } : {})
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
    // The concrete model the id resolves to in the CLI now (an alias's native target), kept as `upstream` so a tier
    // mapping can be checked against it (staleClaudeOverride).
    const resolved = info.resolvedModel && validModelId(info.resolvedModel) && info.resolvedModel !== id ? info.resolvedModel : undefined
    const { tier: _inferred, ...entry } = makeDiscoveredModel('anthropic', {
      id,
      label: info.label,
      family: 'claude',
      hint: info.description?.slice(0, 300),
      ...(resolved ? { upstream: resolved } : {})
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
  // A mixed proxy serves Claude-family models on the Claude adapter, which maps tiers through ANTHROPIC_DEFAULT_*_MODEL
  // and runs most roles, so Claude-family ids win a tier when the proxy lists one (stable otherwise: a tier with no
  // Claude model falls back to whatever the catalog suggests). This is auto-fill only: the user may pick a GPT or other
  // id per tier (ProviderModel.family tells the UI which adapter route a pick takes).
  const ordered = isBuiltinConnectionId(connection) ? own : [...own.filter((m) => m.family === 'claude'), ...own.filter((m) => m.family !== 'claude')]
  const out = defaultTierModels(ordered)
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

/**
 * A Claude model id's family and version, for telling an older model of a family from a newer one: 'claude-opus-4-5',
 * 'claude-opus-4-1-20250805', 'anthropic/claude-sonnet-4-5[1m]' and the older 'claude-3-5-sonnet-20241022' order.
 * A trailing date (8 digits) is not part of the version. undefined for an alias, 'inherit' or any other id. Pure.
 */
export function claudeModelVersion(id: string): { family: string; version: number[] } | undefined {
  const b = bare(id).replace(/\[[^\]]*\]$/, '')
  const parts = b.split('-')
  if (parts[0] !== 'claude' || parts.length < 3) return undefined
  const rest = parts.slice(1).filter((p) => !/^\d{8}$/.test(p))
  const nums = (xs: string[]): number[] | undefined => (xs.length && xs.every((x) => /^\d{1,3}$/.test(x)) ? xs.map(Number) : undefined)
  // New order: claude-<family>-<major>[-<minor>]; old order: claude-<major>[-<minor>]-<family>.
  if (/^[a-z]+$/.test(rest[0]!)) {
    const version = nums(rest.slice(1))
    return version ? { family: rest[0]!, version } : undefined
  }
  const family = rest.at(-1)!
  const version = nums(rest.slice(0, -1))
  return version && /^[a-z]+$/.test(family) ? { family, version } : undefined
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * The newest Claude model of `id`'s family the catalog knows (its ids and the models its aliases resolve to,
 * ProviderModel.upstream), when that is newer than `id`; undefined when `id` is the newest known, of another family or
 * not a dated Claude id. Pure.
 */
export function newerClaudeModel(id: string, catalog: readonly Pick<ProviderModel, 'id' | 'upstream'>[]): string | undefined {
  const mine = claudeModelVersion(id)
  if (!mine) return undefined
  let best: { id: string; version: number[] } | undefined
  for (const m of catalog) {
    for (const candidate of [m.id, m.upstream]) {
      if (!candidate) continue
      const v = claudeModelVersion(candidate)
      if (!v || v.family !== mine.family || compareVersions(v.version, mine.version) <= 0) continue
      if (!best || compareVersions(v.version, best.version) > 0) best = { id: bare(candidate).replace(/\[[^\]]*\]$/, ''), version: v.version }
    }
  }
  return best?.id
}
