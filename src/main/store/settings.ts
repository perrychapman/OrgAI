import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AppearanceSettings,
  AppSettings,
  ConnectionId,
  ModelPriceOverride,
  ModelRef,
  ModelTier,
  OpenAIAuth,
  ProviderAuth,
  ProviderConnections
} from '@shared/types'
import { CANVAS_EDGE_STYLES, CANVAS_LAYOUTS, CANVAS_NODE_STYLES, CANVAS_PATTERNS, CONNECTION_IDS, THEME_MODES, isModelTier, isPermissionMode } from '@shared/types'
import { DEFAULT_APPEARANCE, DEFAULT_APP_SETTINGS, MAX_AUTO_CONTINUES_LIMIT, MODEL_PRICE_ID_MAX_CHARS, MODEL_PRICE_OVERRIDES_MAX, defaultConnections, isConnectionId } from '@shared/defaults'
import { normalizeModelId, sanitizeModelPrice } from '../runtime/pricing'
import { validModelId } from '../connections/codexAccount'

const oneOf = <T extends string>(options: readonly T[], v: unknown, fallback: T): T =>
  (options as readonly unknown[]).includes(v) ? (v as T) : fallback

/**
 * Appearance from disk or the renderer over DEFAULT_APPEARANCE. Settings saved before it existed get the
 * defaults; unknown enum values fall back field by field; an accent that is not '#rrggbb' (or '#rgb') falls back.
 */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const d = DEFAULT_APPEARANCE
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppearanceSettings, unknown>>
  const c = (r.canvas && typeof r.canvas === 'object' ? r.canvas : {}) as Partial<Record<keyof AppearanceSettings['canvas'], unknown>>
  const accent = (): string => {
    if (typeof r.accent !== 'string') return d.accent
    const hex = r.accent.trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(hex)) return hex
    if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((x) => x + x).join('')}`
    return d.accent
  }
  return {
    theme: oneOf(THEME_MODES, r.theme, d.theme),
    accent: accent(),
    canvas: {
      pattern: oneOf(CANVAS_PATTERNS, c.pattern, d.canvas.pattern),
      tint: typeof c.tint === 'boolean' ? c.tint : d.canvas.tint,
      edges: oneOf(CANVAS_EDGE_STYLES, c.edges, d.canvas.edges),
      layout: oneOf(CANVAS_LAYOUTS, c.layout, d.canvas.layout),
      nodeStyle: oneOf(CANVAS_NODE_STYLES, c.nodeStyle, d.canvas.nodeStyle),
      minimap: typeof c.minimap === 'boolean' ? c.minimap : d.canvas.minimap
    },
    reduceMotion: oneOf(['system', 'on'] as const, r.reduceMotion, d.reduceMotion)
  }
}

/**
 * AppSettings.modelPrices from disk or the renderer: an array only; invalid entries are dropped; duplicates (same
 * normalized model and connection) keep the last; capped at MODEL_PRICE_OVERRIDES_MAX. Fresh plain objects only.
 */
export function normalizeModelPrices(raw: unknown): ModelPriceOverride[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ModelPriceOverride>()
  // Bound the work on a hostile settings file: a few times the cap is plenty to find MODEL_PRICE_OVERRIDES_MAX valid ones.
  for (const item of raw.slice(0, MODEL_PRICE_OVERRIDES_MAX * 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const model = typeof o.model === 'string' ? o.model.trim() : ''
    if (!model || model.length > MODEL_PRICE_ID_MAX_CHARS) continue
    const price = sanitizeModelPrice(o.price)
    if (!price) continue
    let connection: ConnectionId | undefined
    if (o.connection !== undefined && o.connection !== null) {
      if (!(CONNECTION_IDS as readonly unknown[]).includes(o.connection)) continue
      connection = o.connection as ConnectionId
    }
    const key = `${connection ?? '*'}|${normalizeModelId(model)}`
    byKey.delete(key) // last wins, and moves to the end
    byKey.set(key, connection ? { model, connection, price } : { model, price })
  }
  return [...byKey.values()].slice(0, MODEL_PRICE_OVERRIDES_MAX)
}

type RawConnection =Partial<{
  enabled: unknown
  auth: unknown
  tierModels: unknown
  autoTiers: unknown
  baseUrl: unknown
  hasApiKey: unknown
}>

/** ConnectionBase.autoTiers: known tiers, each once; anything else (or a non-array) is undefined (derived later). */
function autoTiers(v: unknown): { autoTiers?: ModelTier[] } {
  if (!Array.isArray(v)) return {}
  return { autoTiers: [...new Set(v.filter((t): t is ModelTier => isModelTier(t)))] }
}

function tierModels(v: unknown, fallback: Partial<Record<ModelTier, ModelRef>>): Partial<Record<ModelTier, ModelRef>> {
  if (!v || typeof v !== 'object') return { ...fallback }
  const out: Partial<Record<ModelTier, ModelRef>> = {}
  for (const [tier, model] of Object.entries(v as Record<string, unknown>)) {
    // Renderer or file data that becomes options.model / ANTHROPIC_DEFAULT_*_MODEL: invalid ids are dropped.
    const id = typeof model === 'string' ? model.trim() : ''
    if (isModelTier(tier) && id && validModelId(id)) out[tier] = id
  }
  return out
}

/**
 * Connection records from disk or the renderer, over the defaults. Settings saved before connections existed
 * get the defaults, with the Anthropic connection taking the legacy providerAuth.
 */
export function normalizeConnections(raw: unknown, legacyAuth: ProviderAuth): ProviderConnections {
  const d = defaultConnections(legacyAuth)
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<ConnectionId, RawConnection>>
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  const a = r.anthropic ?? {}
  const o = r.openai ?? {}
  const l = r.litellm ?? {}
  const anthropicAuth = (): ProviderAuth => {
    const x = a.auth as Partial<{ kind: string; envVar: string }> | undefined
    if (x?.kind === 'apiKey') return { kind: 'apiKey', envVar: typeof x.envVar === 'string' && x.envVar.trim() ? x.envVar.trim() : 'ANTHROPIC_API_KEY' }
    if (x?.kind === 'subscription') return { kind: 'subscription' }
    return { ...d.anthropic.auth }
  }
  const openaiAuth = (): OpenAIAuth => {
    const x = o.auth as Partial<{ kind: string; envVar: string }> | undefined
    if (x?.kind === 'apiKey') return { kind: 'apiKey', envVar: typeof x.envVar === 'string' && x.envVar.trim() ? x.envVar.trim() : 'OPENAI_API_KEY' }
    return { kind: 'chatgpt' }
  }
  return {
    anthropic: {
      id: 'anthropic',
      enabled: bool(a.enabled, d.anthropic.enabled),
      auth: anthropicAuth(),
      tierModels: tierModels(a.tierModels, d.anthropic.tierModels),
      ...autoTiers(a.autoTiers)
    },
    openai: { id: 'openai', enabled: bool(o.enabled, d.openai.enabled), auth: openaiAuth(), tierModels: tierModels(o.tierModels, d.openai.tierModels), ...autoTiers(o.autoTiers) },
    litellm: {
      id: 'litellm',
      enabled: bool(l.enabled, d.litellm.enabled),
      baseUrl: typeof l.baseUrl === 'string' ? l.baseUrl.trim() : d.litellm.baseUrl,
      hasApiKey: bool(l.hasApiKey, d.litellm.hasApiKey),
      tierModels: tierModels(l.tierModels, d.litellm.tierModels),
      ...autoTiers(l.autoTiers)
    }
  }
}

const sameAuth = (x: ProviderAuth | undefined, y: ProviderAuth | undefined): boolean =>
  x?.kind === y?.kind && (x?.kind !== 'apiKey' || x.envVar === (y as { envVar?: string }).envVar)

/**
 * Keep the legacy providerAuth and connections.anthropic.auth in step on settings:set. If the caller changed
 * only providerAuth (older UI), it wins and is copied into the connection; otherwise the connection's auth
 * wins and normalizeSettings mirrors it back into providerAuth.
 */
export function reconcileAnthropicAuth(prev: AppSettings, next: Partial<AppSettings>): Partial<AppSettings> {
  const legacyChanged = next.providerAuth !== undefined && !sameAuth(next.providerAuth, prev.providerAuth)
  const connAuth = next.connections?.anthropic?.auth
  const connChanged = connAuth !== undefined && !sameAuth(connAuth, prev.connections.anthropic.auth)
  if (legacyChanged && !connChanged && next.providerAuth) {
    const connections = next.connections ?? prev.connections
    return { ...next, connections: { ...connections, anthropic: { ...connections.anthropic, auth: { ...next.providerAuth } } } }
  }
  return next
}

/**
 * Keep defaultPreferEverydayNearLimit and its deprecated mirror defaultPreferSonnetNearLimit in step on settings:set:
 * an older renderer changes only the legacy field, which then wins; otherwise the new field wins.
 */
export function reconcileNearLimit(prev: AppSettings, next: Partial<AppSettings>): Partial<AppSettings> {
  const legacy = next.defaultPreferSonnetNearLimit
  const fresh = next.defaultPreferEverydayNearLimit
  const legacyChanged = typeof legacy === 'boolean' && legacy !== prev.defaultPreferSonnetNearLimit
  const freshChanged = typeof fresh === 'boolean' && fresh !== prev.defaultPreferEverydayNearLimit
  if (legacyChanged && !freshChanged) return { ...next, defaultPreferEverydayNearLimit: legacy }
  return next
}

/**
 * Model settings saved while the defaults were Claude aliases: a value equal to that old default becomes its tier
 * (defaultRootModel / setupModel / mcpAssistModel / skillAssistModel 'opus' -> 'deep', defaultReportModel 'sonnet' -> 'everyday').
 * Any other value, aliases included, is kept (a legacy alias still stands for its tier at resolution).
 */
const LEGACY_MODEL_DEFAULTS = { root: ['opus', 'deep'], report: ['sonnet', 'everyday'], builtin: ['opus', 'deep'] } as const
function migrateModelDefault(value: string, kind: keyof typeof LEGACY_MODEL_DEFAULTS): string {
  const [old, tier] = LEGACY_MODEL_DEFAULTS[kind]
  return value === old ? tier : value
}

/** Merge whatever is on disk (or sent by the renderer) over the defaults, dropping anything malformed. */
export function normalizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const d = DEFAULT_APP_SETTINGS
  const r = raw ?? {}
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const auth = (v: unknown): ProviderAuth => {
    const a = v as Partial<{ kind: string; envVar: string }> | undefined
    if (a?.kind === 'apiKey') return { kind: 'apiKey', envVar: str(a.envVar, 'ANTHROPIC_API_KEY') }
    if (a?.kind === 'subscription') return { kind: 'subscription' }
    return { ...d.providerAuth }
  }
  // A model id: one line of printable characters without spaces, at most 200 long; anything else is the default.
  const modelRef = (v: unknown, fallback: string): string => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t && t !== 'inherit' && t.length <= 200 && /^[!-~]+$/.test(t) ? t : fallback
  }
  const budget = r.defaultMaxBudgetUsd
  const keep = Number(r.defaultKeepRuns)
  const threshold = Number(r.opusGuardThreshold)
  const maxContinues = Number(r.defaultMaxAutoContinues)
  const connections = normalizeConnections(r.connections, auth(r.providerAuth))
  const nearLimit =
    typeof r.defaultPreferEverydayNearLimit === 'boolean'
      ? r.defaultPreferEverydayNearLimit
      : typeof r.defaultPreferSonnetNearLimit === 'boolean'
        ? r.defaultPreferSonnetNearLimit
        : d.defaultPreferEverydayNearLimit
  const defaultConnection: ConnectionId = isConnectionId(r.defaultConnection) ? r.defaultConnection : d.defaultConnection
  // Explicit booleans are kept. A file saved before the field existed: a default other than anthropic was the user's
  // pick (the old code never changed it on its own), anthropic is automatic. Automatic writes always store false.
  const defaultConnectionChosen = typeof r.defaultConnectionChosen === 'boolean' ? r.defaultConnectionChosen : defaultConnection !== 'anthropic'
  const replaced =
    !defaultConnectionChosen && isConnectionId(r.defaultConnectionReplaced) && r.defaultConnectionReplaced !== defaultConnection
      ? r.defaultConnectionReplaced
      : undefined
  return {
    defaultPermissionMode: isPermissionMode(r.defaultPermissionMode) ? r.defaultPermissionMode : d.defaultPermissionMode,
    defaultMaxBudgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : d.defaultMaxBudgetUsd,
    defaultKeepRuns: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : d.defaultKeepRuns,
    defaultIsolateWriters: typeof r.defaultIsolateWriters === 'boolean' ? r.defaultIsolateWriters : d.defaultIsolateWriters,
    defaultRootModel: migrateModelDefault(modelRef(r.defaultRootModel, d.defaultRootModel), 'root'),
    defaultReportModel: migrateModelDefault(modelRef(r.defaultReportModel, d.defaultReportModel), 'report'),
    setupModel: migrateModelDefault(modelRef(r.setupModel, d.setupModel), 'builtin'),
    mcpAssistModel: migrateModelDefault(modelRef(r.mcpAssistModel, d.mcpAssistModel), 'builtin'),
    skillAssistModel: migrateModelDefault(modelRef(r.skillAssistModel, d.skillAssistModel ?? 'deep'), 'builtin'),
    quickRunModel: modelRef(r.quickRunModel, d.quickRunModel ?? 'everyday'),
    // The connection is authoritative; the legacy field mirrors it (see reconcileAnthropicAuth).
    providerAuth: { ...connections.anthropic.auth },
    connections,
    defaultConnection,
    defaultConnectionChosen,
    ...(replaced !== undefined ? { defaultConnectionReplaced: replaced } : {}),
    notifications: typeof r.notifications === 'boolean' ? r.notifications : d.notifications,
    appearance: normalizeAppearance(r.appearance),
    modelPrices: normalizeModelPrices(r.modelPrices),
    opusGuardThreshold:
      r.opusGuardThreshold != null && Number.isFinite(threshold) && threshold >= 1 && threshold <= 100 ? threshold : d.opusGuardThreshold,
    defaultPreferEverydayNearLimit: nearLimit,
    defaultPreferSonnetNearLimit: nearLimit,
    communityPrices: typeof r.communityPrices === 'boolean' ? r.communityPrices : d.communityPrices,
    defaultAutoContinue: typeof r.defaultAutoContinue === 'boolean' ? r.defaultAutoContinue : d.defaultAutoContinue,
    defaultMaxAutoContinues:
      r.defaultMaxAutoContinues != null && Number.isFinite(maxContinues) && maxContinues >= 0
        ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.floor(maxContinues))
        : d.defaultMaxAutoContinues,
    // Only an explicit boolean true opens the terminal server.
    terminalServer: r.terminalServer === true
  }
}

/** Global app settings, stored as settings.json next to projects.json. */
export class SettingsStore {
  private file: string
  private settings: AppSettings = normalizeSettings(null)
  private listeners = new Set<(settings: AppSettings) => void>()

  constructor(readonly dataDir: string) {
    this.file = join(dataDir, 'settings.json')
    // Exists up front so "Open folder" works before anything has been saved.
    mkdirSync(dataDir, { recursive: true })
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { settings?: Partial<AppSettings> }
        this.settings = normalizeSettings(parsed.settings)
      }
    } catch (e) {
      console.error('Failed to read settings.json, using defaults:', e)
      this.settings = normalizeSettings(null)
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, settings: this.settings }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  /**
   * Save settings from the renderer. LiteLLM's hasApiKey is owned by the main process and kept as stored.
   * appearance merges over the stored value, so a caller that leaves it out (or sends part of it) keeps the rest.
   */
  set(next: Partial<AppSettings>): AppSettings {
    // A partial appearance (or none, from an older renderer) is merged over the stored one, not the defaults.
    const stored = this.settings.appearance
    const given = (next.appearance ?? {}) as Partial<AppearanceSettings>
    const appearance = { ...stored, ...given, canvas: { ...stored.canvas, ...(given.canvas ?? {}) } }
    // modelPrices left out (an older renderer) keeps the stored overrides; an array (even empty) replaces them.
    const modelPrices = next.modelPrices !== undefined ? next.modelPrices : this.settings.modelPrices
    const normalized = normalizeSettings(reconcileNearLimit(this.settings, reconcileAnthropicAuth(this.settings, { ...next, appearance, modelPrices })))
    normalized.connections.litellm.hasApiKey = this.settings.connections.litellm.hasApiKey
    this.settings = normalized
    this.persist()
    const saved = this.get()
    for (const listener of this.listeners) {
      try {
        listener(saved)
      } catch (e) {
        console.error('Settings listener failed:', e)
      }
    }
    return saved
  }

  /** Called with the saved settings after every set(). Returns an unsubscribe function. */
  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Record whether a LiteLLM key is stored in safeStorage (called by the secret store, never the renderer). */
  setLiteLLMKeyStored(stored: boolean): AppSettings {
    this.settings.connections.litellm.hasApiKey = stored
    this.persist()
    return this.get()
  }
}
