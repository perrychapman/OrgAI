import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AppearanceSettings,
  AppSettings,
  ConnectionId,
  ModelRef,
  ModelTier,
  OpenAIAuth,
  ProviderAuth,
  ProviderConnections
} from '@shared/types'
import { CANVAS_EDGE_STYLES, CANVAS_PATTERNS, CONNECTION_IDS, THEME_MODES, isModelTier, isPermissionMode } from '@shared/types'
import { DEFAULT_APPEARANCE, DEFAULT_APP_SETTINGS, MAX_AUTO_CONTINUES_LIMIT, defaultConnections } from '@shared/defaults'

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
      minimap: typeof c.minimap === 'boolean' ? c.minimap : d.canvas.minimap
    },
    reduceMotion: oneOf(['system', 'on'] as const, r.reduceMotion, d.reduceMotion)
  }
}

type RawConnection = Partial<{
  enabled: unknown
  auth: unknown
  tierModels: unknown
  baseUrl: unknown
  hasApiKey: unknown
}>

function tierModels(v: unknown, fallback: Partial<Record<ModelTier, ModelRef>>): Partial<Record<ModelTier, ModelRef>> {
  if (!v || typeof v !== 'object') return { ...fallback }
  const out: Partial<Record<ModelTier, ModelRef>> = {}
  for (const [tier, model] of Object.entries(v as Record<string, unknown>)) {
    if (isModelTier(tier) && typeof model === 'string' && model.trim()) out[tier] = model.trim()
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
    anthropic: { id: 'anthropic', enabled: bool(a.enabled, d.anthropic.enabled), auth: anthropicAuth(), tierModels: tierModels(a.tierModels, d.anthropic.tierModels) },
    openai: { id: 'openai', enabled: bool(o.enabled, d.openai.enabled), auth: openaiAuth(), tierModels: tierModels(o.tierModels, d.openai.tierModels) },
    litellm: {
      id: 'litellm',
      enabled: bool(l.enabled, d.litellm.enabled),
      baseUrl: typeof l.baseUrl === 'string' ? l.baseUrl.trim() : d.litellm.baseUrl,
      hasApiKey: bool(l.hasApiKey, d.litellm.hasApiKey),
      tierModels: tierModels(l.tierModels, d.litellm.tierModels)
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
  return {
    defaultPermissionMode: isPermissionMode(r.defaultPermissionMode) ? r.defaultPermissionMode : d.defaultPermissionMode,
    defaultMaxBudgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : d.defaultMaxBudgetUsd,
    defaultKeepRuns: Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : d.defaultKeepRuns,
    defaultIsolateWriters: typeof r.defaultIsolateWriters === 'boolean' ? r.defaultIsolateWriters : d.defaultIsolateWriters,
    defaultRootModel: str(r.defaultRootModel, d.defaultRootModel),
    defaultReportModel: str(r.defaultReportModel, d.defaultReportModel),
    setupModel: modelRef(r.setupModel, d.setupModel),
    mcpAssistModel: modelRef(r.mcpAssistModel, d.mcpAssistModel),
    // The connection is authoritative; the legacy field mirrors it (see reconcileAnthropicAuth).
    providerAuth: { ...connections.anthropic.auth },
    connections,
    defaultConnection: (CONNECTION_IDS as readonly unknown[]).includes(r.defaultConnection) ? (r.defaultConnection as ConnectionId) : d.defaultConnection,
    notifications: typeof r.notifications === 'boolean' ? r.notifications : d.notifications,
    appearance: normalizeAppearance(r.appearance),
    opusGuardThreshold:
      r.opusGuardThreshold != null && Number.isFinite(threshold) && threshold >= 1 && threshold <= 100 ? threshold : d.opusGuardThreshold,
    defaultPreferSonnetNearLimit:
      typeof r.defaultPreferSonnetNearLimit === 'boolean' ? r.defaultPreferSonnetNearLimit : d.defaultPreferSonnetNearLimit,
    defaultAutoContinue: typeof r.defaultAutoContinue === 'boolean' ? r.defaultAutoContinue : d.defaultAutoContinue,
    defaultMaxAutoContinues:
      r.defaultMaxAutoContinues != null && Number.isFinite(maxContinues) && maxContinues >= 0
        ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.floor(maxContinues))
        : d.defaultMaxAutoContinues
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
    const normalized = normalizeSettings(reconcileAnthropicAuth(this.settings, { ...next, appearance }))
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
