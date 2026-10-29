import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AppSettings,
  ConnectionId,
  ModelRef,
  ModelTier,
  OpenAIAuth,
  ProviderAuth,
  ProviderConnections
} from '@shared/types'
import { CONNECTION_IDS, isModelTier, isPermissionMode } from '@shared/types'
import { DEFAULT_APP_SETTINGS, MAX_AUTO_CONTINUES_LIMIT, defaultConnections } from '@shared/defaults'

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
    // The connection is authoritative; the legacy field mirrors it (see reconcileAnthropicAuth).
    providerAuth: { ...connections.anthropic.auth },
    connections,
    defaultConnection: (CONNECTION_IDS as readonly unknown[]).includes(r.defaultConnection) ? (r.defaultConnection as ConnectionId) : d.defaultConnection,
    notifications: typeof r.notifications === 'boolean' ? r.notifications : d.notifications,
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

  /** Save settings from the renderer. LiteLLM's hasApiKey is owned by the main process and kept as stored. */
  set(next: Partial<AppSettings>): AppSettings {
    const normalized = normalizeSettings(reconcileAnthropicAuth(this.settings, next))
    normalized.connections.litellm.hasApiKey = this.settings.connections.litellm.hasApiKey
    this.settings = normalized
    this.persist()
    return this.get()
  }

  /** Record whether a LiteLLM key is stored in safeStorage (called by the secret store, never the renderer). */
  setLiteLLMKeyStored(stored: boolean): AppSettings {
    this.settings.connections.litellm.hasApiKey = stored
    this.persist()
    return this.get()
  }
}
