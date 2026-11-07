import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  adapterForFamily,
  adapterForProject,
  builtinModels,
  connectionConfigured,
  connectionIds,
  connectionInUse,
  connectionName,
  connectionProviderLabel,
  connectionRecord,
  connectionUsable,
  creationConnection,
  effectiveDefaultConnection,
  isConnectionId,
  isKnownConnection,
  modelFamily,
  modelForTier,
  projectConnection,
  proxyModelsUrl,
  proxyOf,
  proxyOpenAIBase
} from '@shared/defaults'
import { MODEL_TIERS, PROXIES_MAX, PROXY_KINDS, isBuiltinConnectionId, isProxyConnection } from '@shared/types'
import type {
  ProxyConnection,
  ProxyCreateInput,
  ProxyRemoveResult,
  ModelPriceInfo,
  ModelPricesQuery,
  AdapterChoice,
  ConnectionEvent,
  AppSettings,
  ConnectionChecks,
  ConnectionDefaultInput,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginMethod,
  ConnectionLoginStart,
  ConnectionLoginUpdate,
  ConnectionSecretInput,
  ConnectionStatus,
  ModelRef,
  ModelTier,
  ModelsQuery,
  Project,
  ProviderAuth,
  ProviderConnection,
  ProviderModel,
  RemapModelsInput,
  RemapModelsOutput,
  RemapReason,
  RemapResult,
  UsageStatus
} from '@shared/types'
import { CodexAppServer, codexHomeDir } from '../runtime/codexAppServer'
import { checkCodexRuntime, type CodexRuntimeCheck } from '../runtime/codexBinary'
import { listModelPrices, sanitizeModelPrice } from '../runtime/pricing'
import type { ProjectStore } from '../store/projects'
import { proxySecretKey, type SecretStore } from '../store/secrets'
import type { SettingsStore } from '../store/settings'
import type { AdapterModelInfo, RunConnection } from '../runtime/types'
import { anthropicStatus } from './anthropicAuth'
import { anthropicModelsToCatalog, builtinTierModels, makeDiscoveredModel, suggestTierModels, tierFromDescription } from './catalog'
import { cancelLogin, listModels, validModelId, MODEL_TEXT_MAX, logoutAccount, onLoginCompleted, readAccount, readRateLimits, startLogin, type CodexRpc } from './codexAccount'
import { mapCodexRateLimits } from './codexUsage'
import { LITELLM_MAX_MODELS, fetchLiteLLMKeyInfo, fetchLiteLLMSpend, fetchProxyModels, normalizeBaseUrl } from './litellm'
import { pricingFromCatalog } from '../runtime/pricing'
import { remapProject } from './remap'
import { defaultRefusal, withoutReplaced } from './defaultPick'
import { cleanProxyKey, cleanProxyName, isMockProxyUrl, newProxyId, normalizeProxyUrl } from './proxy'

export interface ConnectionServiceDeps {
  dataDir: string
  settings: SettingsStore
  projects: ProjectStore
  secrets: SecretStore
  broadcast(e: ConnectionEvent): void
  openExternal(url: string): Promise<void>
  fetch?: typeof fetch
  /** Create the (not yet started) Codex app-server client. Default: a CodexAppServer with OrgAI's CODEX_HOME. */
  codexFactory?: () => CodexAppServer
  /**
   * Where Codex is and whether its version is supported (cli-standalone 6.2), checked by the OpenAI probe for every
   * auth kind. Default: codexBinary.ts checkCodexRuntime (a file-system lookup plus a cached `codex --version`).
   */
  codexRuntime?: () => Promise<CodexRuntimeCheck>
  now?: () => number
  /** Info-level log line (default console.info; index.ts passes the main log). */
  logInfo?: (message: string) => void
  /** Probe the Anthropic connection. Default: anthropicAuth.anthropicStatus (runs `claude auth status`). */
  anthropicProbe?: typeof anthropicStatus
  /**
   * The models the Claude login offers right now (the adapter's listModels / SDK supportedModels). null = could not
   * say; the catalog is kept. Missing = no Anthropic discovery (builtin aliases only).
   */
  anthropicModels?: (auth: ProviderAuth) => Promise<AdapterModelInfo[] | null>
  /**
   * Called when effectiveDefault() may have moved (a status change, also in chosen mode, a key removed, a connection
   * turned off). index.ts re-broadcasts settings:changed when the effective default differs from the last one sent.
   */
  onDefaultChanged?: () => void
}

/** startDiscovery options. */
export interface DiscoveryOptions {
  /** Wait before the first check after boot. Default 20 s. */
  bootDelayMs?: number
  /** Time between checks. Default 60 minutes. */
  checkEveryMs?: number
  /** A connection whose last successful discovery is older than this is refreshed. Default 24 h. */
  staleAfterMs?: number
}

interface CodexLease {
  server: CodexAppServer
  leases: number
  offLogin: () => void
}

interface PendingLogin {
  lease: CodexLease
  method: ConnectionLoginMethod
}

type Tiers = Partial<Record<ModelTier, ModelRef>>

const sameTiers = (a: Tiers, b: Tiers): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const sortKeys = (o: Tiers): [string, string | undefined][] => Object.entries(o).sort(([x], [y]) => x.localeCompare(y))

/** `{ baseUrl }` for a proxy model: claude family -> the Anthropic base URL, else the OpenAI base; {} when that is empty. */
function withBaseUrl(proxy: ProxyConnection, m: Pick<ProviderModel, 'family'>): { baseUrl?: string } {
  const url = m.family === 'claude' ? proxy.anthropicBaseUrl.trim().replace(/\/+$/, '') : proxyOpenAIBase(proxy)
  return url ? { baseUrl: url } : {}
}

/** discover(): a ChatGPT connection with no signed-in account has nothing to discover (not an error). */
const SIGNED_OUT = 'signed-out' as const

/** The provider label a project stores for a connection ('Claude', 'Codex (ChatGPT)' or the proxy's name). */
function providerLabelFor(id: ConnectionId, v: Pick<AppSettings, 'proxies'>): string {
  return id === 'anthropic' ? 'Claude' : id === 'openai' ? 'Codex (ChatGPT)' : connectionName(id, v)
}

/** Origins (scheme + host + port) that receive a proxy's key: base, effective OpenAI base and effective models URL. */
function proxyOrigins(p: ProxyConnection): Set<string> {
  const out = new Set<string>()
  for (const u of [p.anthropicBaseUrl, p.openaiBaseUrl || p.anthropicBaseUrl, p.modelsUrl || p.anthropicBaseUrl]) {
    if (!u) continue
    try {
      out.add(new URL(u).origin)
    } catch {
      // an unparsable stored value never counts as an origin
    }
  }
  return out
}

/**
 * Connections and the model catalog: probes, logins, discovery, tier mapping, project remaps and the per-run
 * model access (RunConnection). Proxy connections (AppSettings.proxies) are any number; each has its own key in the
 * SecretStore. Nothing here ever returns, broadcasts or logs a proxy key.
 * Statuses are cached; init(), test() and connect() refresh them, list() answers from the cache.
 */
export class ConnectionService {
  private statuses: Partial<Record<ConnectionId, ConnectionStatus>> = {}
  private discovered: Partial<Record<ConnectionId, ProviderModel[]>> = {}
  private modelsFile: string
  /** When each connection's discovery last succeeded (epoch ms), persisted in models.json. */
  private refreshedAt: Partial<Record<ConnectionId, number>> = {}
  /** The last scheduled-discovery failure per connection (cleared by a success). */
  private modelsErrors: Partial<Record<ConnectionId, string>> = {}
  private discoveryTimers: ReturnType<typeof setTimeout>[] = []
  private discoveryBusy = false
  private codex: Promise<CodexLease> | null = null
  /** The started lease; cleared synchronously when the server is released or exits. */
  private codexLease: CodexLease | null = null
  private pendingLogins = new Map<string, PendingLogin>()
  /** Activity (activeOAuthFlows): provider logins (ChatGPT browser / device code) still waiting for the user. */
  pendingLoginCount(): number { return this.pendingLogins.size }
  private disposed = false
  /** Aborts in-flight `claude auth status` children at dispose (they hold a cwd under the data folder). */
  private stopSignal = new AbortController()
  /**
   * Connections whose current 'disconnected' status is tentative (a LiteLLM base URL change or a saved key waiting
   * for Test and connect): effectiveDefault reads them as 'unknown', so they never move the default. Cleared by the
   * next definite status.
   */
  private tentative = new Set<ConnectionId>()
  /** Proxy ids removed in this session; a new id never reuses one (a run record or usage row may still name it). */
  private removedProxyIds = new Set<string>()

  constructor(private deps: ConnectionServiceDeps) {
    this.modelsFile = join(deps.dataDir, 'models.json')
    this.loadModels()
  }

  private settingsNow(): AppSettings {
    return this.deps.settings.get()
  }

  /** The record of a built-in or existing proxy connection, or undefined. */
  private record(id: ConnectionId): ProviderConnection | undefined {
    return connectionRecord(this.settingsNow(), id)
  }

  /** The record of a known connection; throws "Unknown connection" for anything else (prototype keys included). */
  private need(id: unknown): ProviderConnection {
    const rec = isKnownConnection(this.settingsNow(), id) ? this.record(id) : undefined
    if (!rec) throw new Error('Unknown connection')
    return rec
  }

  private allIds(): ConnectionId[] {
    return connectionIds(this.settingsNow())
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ---------- persistence of discovered catalogs ----------

  private loadModels(): void {
    try {
      if (!existsSync(this.modelsFile)) return
      const parsed = JSON.parse(readFileSync(this.modelsFile, 'utf8')) as { models?: Record<string, unknown>; refreshedAt?: Record<string, unknown> }
      // Only connections that exist now: entries of a removed proxy (or junk ids) in an old file are left behind.
      for (const id of this.allIds()) {
        const at = parsed.refreshedAt?.[id]
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) this.refreshedAt[id] = at
        const list = parsed.models?.[id]
        if (Array.isArray(list)) {
          this.discovered[id] = list
            .slice(0, LITELLM_MAX_MODELS)
            .filter((m): m is ProviderModel => !!m && typeof m === 'object' && typeof (m as ProviderModel).id === 'string' && validModelId((m as ProviderModel).id) && (m as ProviderModel).connection === id)
            .map((m) => {
              // A stored price is untrusted file data: keep it only when it is valid, as a fresh object.
              const { price: stored, ...rest } = m
              const price = sanitizeModelPrice(stored)
              const capped: ProviderModel = {
                ...rest,
                ...(typeof rest.label === 'string' ? { label: rest.label.slice(0, MODEL_TEXT_MAX) } : {}),
                ...(typeof rest.hint === 'string' ? { hint: rest.hint.slice(0, MODEL_TEXT_MAX) } : {})
              }
              return price ? { ...capped, price } : capped
            })
        }
      }
    } catch (e) {
      console.error('Failed to read models.json, starting empty:', (e as Error).message)
      this.discovered = {}
    }
  }

  private persistModels(): void {
    mkdirSync(dirname(this.modelsFile), { recursive: true })
    const tmp = `${this.modelsFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, models: this.discovered, refreshedAt: this.refreshedAt }, null, 2), 'utf8')
    renameSync(tmp, this.modelsFile)
  }

  // ---------- catalog ----------

  private catalogFor(id: ConnectionId): ProviderModel[] {
    const found = this.discovered[id] ?? []
    if (id === 'anthropic') {
      // Discovered entries first (newest or recommended first), then any builtin alias discovery did not list: saved
      // roles keep working with their alias.
      const listed = new Set(found.map((m) => m.id))
      return [...found.map((m) => ({ ...m })), ...builtinModels('anthropic').filter((m) => !listed.has(m.id))]
    }
    // OpenAI placeholders stand in until model/list has answered.
    if (id === 'openai') return found.length ? found.map((m) => ({ ...m })) : builtinModels('openai')
    // Proxy models: baseUrl is derived here, at read time, from the proxy's current URLs (so a URL change shows at
    // once, without rediscovery); discovery stamps the same value into the stored entries.
    const proxy = proxyOf(this.settingsNow(), id)
    return found.map((m) => {
      const { baseUrl: _stale, ...rest } = m
      return proxy ? { ...rest, ...withBaseUrl(proxy, m) } : rest
    })
  }

  /** Every connection's catalog, for adapterForProject. */
  catalog(): ProviderModel[] {
    return this.allIds().flatMap((id) => this.catalogFor(id))
  }

  /** The catalog of one connection, or of every enabled connection. */
  models(query?: ModelsQuery): ProviderModel[] {
    if (query?.connection !== undefined) this.need(query.connection)
    if (query?.connection) return this.catalogFor(query.connection)
    return this.allIds().filter((id) => this.record(id)?.enabled).flatMap((id) => this.catalogFor(id))
  }

  /** models:prices: user overrides, proxy prices from the catalogs and the built-in table (pricing.ts listModelPrices). */
  prices(query?: ModelPricesQuery): ModelPriceInfo[] {
    return listModelPrices(query, this.deps.settings.get().modelPrices ?? [], this.allIds().flatMap((id) => this.catalogFor(id)))
  }

  /** Re-discover models (proxies, Codex) and return the new catalog. A failed discovery keeps the old catalog and sets an error status. */
  async refresh(query?: ModelsQuery): Promise<ProviderModel[]> {
    if (query?.connection !== undefined) this.need(query.connection)
    const ids = query?.connection ? [query.connection] : this.allIds().filter((id) => this.record(id)?.enabled)
    const results: RemapResult[] = []
    for (const id of ids) {
      try {
        const found = await this.discover(id)
        if (Array.isArray(found)) results.push(...this.applyCatalog(id, found, ['catalog']))
        else if (found === SIGNED_OUT) delete this.modelsErrors[id]
      } catch (e) {
        this.setStatus(id, { state: 'error', detail: this.safeMessage(e), checkedAt: this.now() })
      }
    }
    this.broadcastRemaps(results)
    return this.models(query)
  }

  /**
   * Ask the connection for its models, keeping only entries whose id passes validModelId (every provider's ids are
   * untrusted and flow into options.model and ANTHROPIC_DEFAULT_*_MODEL). null = nothing was discovered;
   * SIGNED_OUT = a ChatGPT connection without an account (nothing to discover, not an error).
   */
  private async discover(id: ConnectionId): Promise<ProviderModel[] | null | typeof SIGNED_OUT> {
    const found = await this.discoverRaw(id)
    return Array.isArray(found) ? found.filter((m) => validModelId(m.id)) : found
  }

  private async discoverRaw(id: ConnectionId): Promise<ProviderModel[] | null | typeof SIGNED_OUT> {
    const proxy = proxyOf(this.settingsNow(), id)
    if (proxy) {
      if (!proxy.anthropicBaseUrl) throw new Error(`${proxy.name} has no base URL`)
      const key = this.proxyKey(proxy, `${proxy.name} has no API key`)
      const models = await fetchProxyModels(proxyModelsUrl(proxy), key, this.deps.fetch ?? fetch, { kind: proxy.kind, connection: proxy.id, baseUrl: proxy.anthropicBaseUrl })
      return models.map((m) => ({ ...m, ...withBaseUrl(proxy, m) }))
    }
    if (id === 'openai') {
      if (this.deps.settings.get().connections.openai.auth.kind !== 'chatgpt') return null
      const list = await this.withCodex(async (rpc) => {
        const account = await readAccount(rpc)
        return account.account ? listModels(rpc) : null
      })
      if (!list) return SIGNED_OUT
      return list.map((m) => {
        const base = makeDiscoveredModel('openai', { id: m.id, label: m.label, family: 'openai', hint: m.description })
        // The id gives a tier for the known families; otherwise the provider's description, and its recommended
        // model never stays tierless.
        const tier = base.tier ?? tierFromDescription(m.description) ?? (m.isDefault ? 'deep' : undefined)
        return makeDiscoveredModel('openai', { id: m.id, label: m.label, family: 'openai', hint: m.description, recommended: m.isDefault, ...(tier ? { tier } : {}) })
      })
    }
    const list = await this.deps.anthropicModels?.(this.deps.settings.get().connections.anthropic.auth)
    if (!list?.length) return null
    const found = anthropicModelsToCatalog(list)
    return found.length ? found : null
  }

  /**
   * Store a discovered catalog, refill the tier mapping and remap the connection's projects. Returns the
   * remap results (callers broadcast them). Broadcasts models.updated when the catalog's ids changed.
   * An empty OpenAI list is ignored so the placeholders stay.
   */
  private applyCatalog(id: ConnectionId, found: ProviderModel[], reasons: RemapReason[]): RemapResult[] {
    // Central id check (discover() already filters; this guards any other caller).
    found = found.filter((m) => validModelId(m.id))
    if (id === 'openai' && found.length === 0) return []
    const before = this.catalogFor(id)
    const beforeIds = before.map((m) => m.id).join('\n')
    const previousSuggestion = suggestTierModels(id, before)
    this.discovered[id] = found
    const refreshedAt = this.now()
    this.refreshedAt[id] = refreshedAt
    delete this.modelsErrors[id]
    this.persistModels()
    const catalog = this.catalogFor(id)
    const changed = beforeIds !== catalog.map((m) => m.id).join('\n')
    const { previous, next } = this.retier(id, catalog, previousSuggestion)
    this.deps.broadcast({ type: 'models.updated', connection: id, models: catalog, changed, refreshedAt })
    const results: RemapResult[] = []
    for (const reason of reasons) results.push(...this.remapConnectionProjects(id, next, previous, reason))
    return results
  }

  /** Tiers whose mapping follows the catalog's suggestion: autoTiers, else derived from the stored mapping. */
  private autoTiersOf(id: ConnectionId, tierModels: Tiers, stored: ModelTier[] | undefined, suggestion: Tiers): Set<ModelTier> {
    if (stored) return new Set(stored)
    const builtin = builtinTierModels(id)
    const out = new Set<ModelTier>()
    for (const tier of MODEL_TIERS) {
      const cur = tierModels[tier]?.trim()
      if (!cur || cur === builtin[tier] || cur === suggestion[tier]) out.add(tier)
    }
    return out
  }

  /**
   * Re-derive the tier mapping against a catalog and save it with autoTiers when either changed. An auto tier
   * follows the catalog's suggestion; a user tier is kept while its model is still listed, else it falls back to the
   * suggestion and becomes auto. Returns the mapping before and after.
   */
  private retier(id: ConnectionId, catalog: readonly ProviderModel[], previousSuggestion: Tiers): { previous: Tiers; next: Tiers } {
    const conn = this.need(id)
    const previous = conn.tierModels
    const suggestion = suggestTierModels(id, catalog)
    const ids = new Set(catalog.map((m) => m.id))
    const auto = this.autoTiersOf(id, previous, conn.autoTiers, previousSuggestion)
    const next: Tiers = {}
    for (const tier of MODEL_TIERS) {
      const cur = previous[tier]?.trim()
      const want = suggestion[tier]
      if (!cur) {
        if (want) {
          next[tier] = want
          auto.add(tier)
        }
      } else if (auto.has(tier)) {
        const keep = want ?? (ids.has(cur) ? cur : undefined)
        if (keep) next[tier] = keep
        else auto.delete(tier)
      } else if (ids.has(cur)) next[tier] = cur
      else if (want) {
        next[tier] = want
        auto.add(tier)
      }
    }
    const autoTiers = MODEL_TIERS.filter((t) => auto.has(t) && next[t])
    if (!sameTiers(previous, next) || JSON.stringify(conn.autoTiers) !== JSON.stringify(autoTiers)) {
      this.saveConnection({ ...conn, tierModels: next, autoTiers } as ProviderConnection)
    }
    return { previous, next }
  }

  // ---------- statuses ----------

  /**
   * Store and broadcast a status. A definite status (probe results, logout, a removed key) may rewrite the automatic
   * default; `definite: false` (a base URL change, a saved key waiting for Test and connect) never does, and
   * effectiveDefault reads that status as 'unknown' until the next definite one.
   */
  private setStatus(id: ConnectionId, status: ConnectionStatus, opts: { definite?: boolean } = {}): ConnectionStatus {
    this.need(id)
    const before = this.effectiveDefault()
    this.statuses[id] = status
    if (opts.definite === false) this.tentative.add(id)
    else this.tentative.delete(id)
    this.deps.broadcast({ type: 'connection.status', connection: id, status })
    if (opts.definite !== false && (status.state === 'connected' || status.state === 'disconnected' || status.state === 'error')) this.rewriteDefault()
    this.defaultMayHaveMoved(before)
    return status
  }

  /** Tell index.ts (onDefaultChanged) when the effective default differs from `before`. */
  private defaultMayHaveMoved(before: ConnectionId): void {
    if (this.effectiveDefault() === before) return
    try {
      this.deps.onDefaultChanged?.()
    } catch (e) {
      console.warn(`Default connection listener failed: ${this.safeMessage(e)}`)
    }
  }

  /**
   * While the user has not picked a default, keep the stored default equal to the effective one. effectiveDefault
   * moves only after a definite 'disconnected' (or a connection turned off), never on 'error', 'connecting' or
   * 'unknown'. The first rewrite remembers what it replaced (AppSettings.defaultConnectionReplaced); when that
   * connection reports 'connected' again the default moves back and the field is cleared. Writes chosen false.
   */
  private rewriteDefault(): void {
    let s = this.deps.settings.get()
    if (s.defaultConnectionChosen === true) return
    // A replaced connection that is no longer configured can never be moved back to: forget it.
    const old = s.defaultConnectionReplaced
    if (old !== undefined && !(isConnectionId(old) && connectionConfigured(old, s))) {
      s = this.deps.settings.set({ ...withoutReplaced(s), defaultConnectionChosen: false })
    }
    const next = this.effectiveDefault()
    const replaced = s.defaultConnectionReplaced
    if (next === s.defaultConnection) {
      if (replaced === next) this.deps.settings.set({ ...withoutReplaced(s), defaultConnectionChosen: false })
      return
    }
    const back = next === replaced
    this.deps.settings.set(
      back
        ? { ...withoutReplaced(s), defaultConnection: next, defaultConnectionChosen: false }
        : { ...s, defaultConnection: next, defaultConnectionChosen: false, defaultConnectionReplaced: replaced ?? s.defaultConnection }
    )
    const label = (id: ConnectionId): string => connectionName(id, s)
    const why = back ? `${label(next)} is connected again` : `${label(s.defaultConnection)} is not connected`
    ;(this.deps.logInfo ?? ((m) => console.info(m)))(`Default connection is now ${label(next)} (automatic: ${why})`)
  }

  /** Whether a connection can be the default now (configured and connected). */
  isUsable(id: ConnectionId): boolean {
    return connectionUsable(id, this.settingsNow(), this.statuses[id]?.state)
  }

  /** The refusal for making an unusable connection the default, or null when it is usable. */
  defaultRefusalFor(id: ConnectionId): string | null {
    return this.isUsable(id) ? null : defaultRefusal(id, this.settingsNow())
  }

  /** Settings as consumers should see them: defaultConnection is the effective default. */
  effectiveSettings(): AppSettings {
    const s = this.deps.settings.get()
    const eff = this.effectiveDefault()
    return eff === s.defaultConnection ? s : { ...s, defaultConnection: eff }
  }

  /** Pick the default connection (an id) or go back to automatic (null). */
  async setDefault(input: ConnectionDefaultInput): Promise<ConnectionInfo[]> {
    const s = this.deps.settings.get()
    if (input === null) {
      this.deps.settings.set({ ...withoutReplaced(s), defaultConnectionChosen: false })
      this.rewriteDefault()
    } else {
      this.need(input)
      // Re-choosing the stored default needs only that it is still configured (its live state may be anything);
      // any other connection must be usable now.
      const refusal =
        input === s.defaultConnection
          ? connectionConfigured(input, s) ? null : defaultRefusal(input, s)
          : this.defaultRefusalFor(input)
      if (refusal) throw new Error(refusal)
      this.deps.settings.set({ ...withoutReplaced(s), defaultConnection: input, defaultConnectionChosen: true })
    }
    return this.list()
  }

  /**
   * The stored key of a proxy connection, else a throw: a key that is stored but cannot be read here says why with the store's reason
   * (Wave 7, 5.4: saved by the OrgAI app and not yet shared, a locked or damaged vault), never "no API key" (which would
   * send the user to type it again); `missing` is the sentence for a key that is not stored at all.
   */
  private proxyKey(proxy: ProxyConnection, missing: string): string {
    const stored = this.deps.secrets.status(proxySecretKey(proxy.id))
    if (typeof stored === 'object') throw new Error(`The ${proxy.name} API key cannot be read here: ${stored.unreadable.replace(/[.\s]+$/, '')}.`)
    const key = this.deps.secrets.get(proxySecretKey(proxy.id))
    if (!key) throw new Error(missing)
    return key
  }

  private safeMessage(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e)
    for (const p of this.settingsNow().proxies) {
      const key = this.deps.secrets.get(proxySecretKey(p.id))
      if (key) msg = msg.split(key).join('***')
    }
    return msg.slice(0, 200)
  }

  /**
   * The effective default connection (defaults.ts effectiveDefaultConnection) over the stored setting and the live
   * statuses of the configured connections ('unknown' before their first probe). Every consumer of the default reads
   * this, never AppSettings.defaultConnection alone.
   */
  effectiveDefault(): ConnectionId {
    const s = this.deps.settings.get()
    const states: Partial<Record<ConnectionId, ConnectionStatus['state'] | 'unknown'>> = {}
    for (const id of connectionIds(s)) {
      if (!connectionConfigured(id, s)) continue
      states[id] = this.tentative.has(id) ? 'unknown' : (this.statuses[id]?.state ?? 'unknown')
    }
    return effectiveDefaultConnection({ stored: s.defaultConnection, chosen: s.defaultConnectionChosen === true, replaced: s.defaultConnectionReplaced, proxies: s.proxies, states })
  }

  private info(id: ConnectionId, effective: ConnectionId = this.effectiveDefault()): ConnectionInfo {
    const connection = this.need(id)
    const refreshed = this.refreshedAt[id]
    const error = this.modelsErrors[id]
    const users = isProxyConnection(connection)
      ? this.deps.projects
          .list()
          .filter((p) => projectConnection(p) === id)
          .slice(0, 50)
          .map((p) => ({ id: p.id, name: p.name }))
      : undefined
    return {
      connection,
      status: this.statuses[id] ?? { state: 'disconnected' },
      modelCount: this.catalogFor(id).length,
      isDefault: id === effective,
      ...(users ? { usedBy: users } : {}),
      ...(refreshed ? { modelsRefreshedAt: refreshed } : {}),
      ...(error ? { modelsError: error } : {})
    }
  }

  async list(): Promise<ConnectionInfo[]> {
    const effective = this.effectiveDefault()
    return this.allIds().map((id) => this.info(id, effective))
  }

  /** Probe one connection without touching its catalog or enabled flag. Returns the status (not stored). */
  private async probe(id: ConnectionId): Promise<ConnectionStatus> {
    const s = this.deps.settings.get()
    try {
      if (id === 'anthropic') {
        const probe = this.deps.anthropicProbe ?? anthropicStatus
        return { ...(await probe(s.connections.anthropic.auth, process.env, { dataDir: this.deps.dataDir, signal: this.stopSignal.signal })), checkedAt: this.now() }
      }
      if (id === 'openai') return await this.probeOpenAI()
      const proxy = proxyOf(s, id)
      if (!proxy) return { state: 'disconnected', detail: 'This connection no longer exists.', checkedAt: this.now() }
      return await this.probeProxy(proxy)
    } catch (e) {
      return { state: 'error', detail: this.safeMessage(e), checkedAt: this.now() }
    }
  }

  private async probeOpenAI(): Promise<ConnectionStatus> {
    const auth = this.deps.settings.get().connections.openai.auth
    const checkedAt = this.now()
    // Every auth kind runs through the Codex CLI: no supported Codex is an error (never a definite disconnect, which
    // would move an automatic default connection), so the probe and runs agree (cli-standalone 6.2).
    const runtime = await (this.deps.codexRuntime ?? (() => checkCodexRuntime()))()
    if (!runtime.ok) return { state: 'error', detail: runtime.reason, checkedAt }
    const note = runtime.warning ? ` ${runtime.warning}` : ''
    if (auth.kind === 'apiKey') {
      return this.env(auth.envVar)
        ? { state: 'connected', detail: `Using ${auth.envVar}${note ? `.${note}` : ''}`, checkedAt }
        : { state: 'disconnected', detail: `${auth.envVar} is not set in OrgAI's environment`, checkedAt }
    }
    const state = await this.withCodex((rpc) => readAccount(rpc))
    const a = state.account
    if (a?.type === 'chatgpt') {
      const account = [a.email, a.planType].filter(Boolean).join(' · ') || 'ChatGPT'
      return { state: 'connected', detail: `Signed in with ChatGPT${note ? `.${note}` : ''}`, account, checkedAt }
    }
    if (a) return { state: 'connected', detail: `Signed in to Codex${note ? `.${note}` : ''}`, checkedAt }
    return { state: 'disconnected', detail: 'Not signed in. Sign in with ChatGPT.', checkedAt }
  }

  private async probeProxy(conn: ProxyConnection): Promise<ConnectionStatus> {
    const checkedAt = this.now()
    if (!conn.anthropicBaseUrl) return { state: 'disconnected', detail: 'Set the proxy base URL.', checkedAt }
    // A key that is stored but cannot be read here (Wave 7, 5.4: saved by the app and not yet shared, a locked or damaged
    // vault, safeStorage failure) is an error with the store's reason, not a definite disconnect: it must not move the
    // automatic default, and "set it again" would be the wrong advice.
    const stored = this.deps.secrets.status(proxySecretKey(conn.id))
    if (typeof stored === 'object') return { state: 'error', detail: stored.unreadable, checkedAt }
    const key = this.deps.secrets.get(proxySecretKey(conn.id))
    if (!key && conn.hasApiKey) return { state: 'error', detail: 'The stored key could not be read. Set the API key again.', checkedAt }
    if (!key) return { state: 'disconnected', detail: 'Set an API key.', checkedAt }
    // The list alone answers "reachable and the key works"; prices (LiteLLM /model/info) wait for discovery.
    let models: ProviderModel[]
    try {
      models = await fetchProxyModels(proxyModelsUrl(conn), key, this.deps.fetch ?? fetch, { kind: conn.kind, connection: conn.id, listOnly: true })
    } catch (e) {
      const detail = this.safeMessage(e)
      const refused = /invalid key|\(40[13]\)|\b40[13] from/i.test(detail)
      const unreachable = !refused && /Could not reach|Timed out|redirected/i.test(detail)
      const checks: ConnectionChecks = { reached: !unreachable, keyAccepted: refused ? false : null, modelCount: null, reportsPrices: null, reportsSpend: null }
      return { state: 'error', detail, checkedAt, checks }
    }
    // Prices are only known after discovery: until a catalog exists they are undetermined (null).
    const known = this.discovered[conn.id]
    const mock = isMockProxyUrl(conn.anthropicBaseUrl) || isMockProxyUrl(proxyModelsUrl(conn))
    const reportsPrices = mock ? false : known?.length ? known.some((m) => m.price !== undefined) : null
    let reportsSpend: boolean | null = false
    if (mock) reportsSpend = false
    else if (conn.kind === 'litellm') {
      try {
        reportsSpend = (await fetchLiteLLMKeyInfo(conn.anthropicBaseUrl, key, this.deps.fetch ?? fetch)) !== null
      } catch {
        reportsSpend = false
      }
    }
    return {
      state: 'connected',
      detail: `${models.length} model${models.length === 1 ? '' : 's'} available`,
      checkedAt,
      checks: { reached: true, keyAccepted: true, modelCount: models.length, reportsPrices, reportsSpend }
    }
  }

  private env(name: string): string | undefined {
    return process.env[name]?.trim() || undefined
  }

  async test(id: ConnectionId): Promise<ConnectionStatus> {
    this.need(id)
    return this.setStatus(id, await this.probe(id))
  }

  // ---------- settings records ----------

  private saveConnection(c: ProviderConnection): void {
    const current = this.deps.settings.get()
    if (isProxyConnection(c)) {
      if (!proxyOf(current, c.id)) throw new Error('Unknown connection')
      this.deps.settings.setProxies(current.proxies.map((p) => (p.id === c.id ? c : p)))
      return
    }
    if (!isBuiltinConnectionId(c.id)) throw new Error('Unknown connection')
    this.deps.settings.set({ ...current, connections: { ...current.connections, [c.id]: c } })
  }

  /** A proxy record from the renderer, validated over the stored one: id, kind and hasApiKey cannot change. */
  private editedProxy(old: ProxyConnection, c: unknown): ProxyConnection {
    const i = (c && typeof c === 'object' ? c : {}) as Partial<ProxyConnection>
    const others = this.settingsNow().proxies.filter((p) => p.id !== old.id).map((p) => p.name)
    const optional = (v: unknown, label: string): string | undefined => {
      if (v === undefined || v === null) return undefined
      if (typeof v === 'string' && !v.trim()) return undefined
      return normalizeProxyUrl(v, label)
    }
    const baseRaw = typeof i.anthropicBaseUrl === 'string' ? i.anthropicBaseUrl : old.anthropicBaseUrl
    const anthropicBaseUrl = baseRaw.trim() ? normalizeProxyUrl(baseRaw, 'Base URL') : ''
    const openaiBaseUrl = optional(i.openaiBaseUrl, 'OpenAI base URL')
    const modelsUrl = optional(i.modelsUrl, 'Models URL')
    const { openaiBaseUrl: _o, modelsUrl: _m, ...rest } = old
    return {
      ...rest,
      name: cleanProxyName(i.name ?? old.name, others),
      anthropicBaseUrl,
      ...(openaiBaseUrl ? { openaiBaseUrl } : {}),
      ...(modelsUrl ? { modelsUrl } : {}),
      enabled: typeof i.enabled === 'boolean' ? i.enabled : old.enabled,
      tierModels: i.tierModels && typeof i.tierModels === 'object' ? { ...i.tierModels } : { ...old.tierModels }
    }
  }

  async update(c: ProviderConnection): Promise<ConnectionInfo> {
    if (!c || typeof c !== 'object') throw new Error('Unknown connection')
    const old = this.need(c.id)
    const before = this.effectiveDefault()
    const wasConfigured = connectionConfigured(c.id, this.settingsNow())
    let incoming: ProviderConnection = c
    if (isProxyConnection(old)) incoming = this.editedProxy(old, c)
    else if (isProxyConnection(c)) throw new Error('Unknown connection')
    // autoTiers is main-owned (the renderer's copy is ignored): a tier the caller changed is the user's from now on.
    const wasAuto = this.autoTiersOf(c.id, old.tierModels, old.autoTiers, suggestTierModels(c.id, this.catalogFor(c.id)))
    for (const tier of MODEL_TIERS) if ((incoming.tierModels?.[tier] ?? '') !== (old.tierModels[tier] ?? '')) wasAuto.delete(tier)
    // The settings store keeps the stored hasApiKey and mirrors Anthropic auth into providerAuth.
    this.saveConnection({ ...incoming, autoTiers: MODEL_TIERS.filter((t) => wasAuto.has(t)) } as ProviderConnection)
    const fresh = this.need(c.id)
    if (isProxyConnection(old) && isProxyConnection(fresh)) {
      const moved = (['name', 'anthropicBaseUrl', 'openaiBaseUrl', 'modelsUrl'] as const).some((k) => (old[k] ?? '') !== (fresh[k] ?? ''))
      const oldOrigins = proxyOrigins(old)
      const newHost = [...proxyOrigins(fresh)].some((o) => !oldOrigins.has(o))
      if (newHost && fresh.hasApiKey) {
        // The saved key must never travel to a host the user did not enter it for.
        this.deps.secrets.delete(proxySecretKey(fresh.id))
        this.deps.settings.setProxyKeyStored(fresh.id, false)
        this.setStatus(
          old.id,
          { state: 'disconnected', detail: 'The address moved to another host, so the saved key was removed. Enter the key again.', checkedAt: this.now() },
          { definite: false }
        )
      } else if (moved) {
        this.setStatus(old.id, { state: 'disconnected', detail: 'Changed. Test and connect to apply.', checkedAt: this.now() }, { definite: false })
      }
    }
    if (!sameTiers(old.tierModels, fresh.tierModels)) {
      this.broadcastRemaps(this.remapConnectionProjects(c.id, fresh.tierModels, old.tierModels, 'tierModels'))
    }
    // Turning a connection off (Anthropic's Disconnect) or on, or clearing / setting a proxy's base URL, changes what
    // is configured: a definite change.
    if (old.enabled !== fresh.enabled || wasConfigured !== connectionConfigured(c.id, this.settingsNow())) this.rewriteDefault()
    this.defaultMayHaveMoved(before)
    if (isProxyConnection(fresh)) this.deps.broadcast({ type: 'connections.changed' })
    return this.info(c.id)
  }

  /** Throws SecretStore.clearRefusal's sentence for the LiteLLM key (vault damaged; app-only key on a Node host). */
  private refuseClear(key: string): void {
    const refusal = this.deps.secrets.clearRefusal(key)
    if (refusal) throw new Error(refusal)
  }

  async setSecret(input: ConnectionSecretInput): Promise<ConnectionInfo> {
    const id = input?.id
    const proxy = typeof id === 'string' ? proxyOf(this.settingsNow(), id) : undefined
    if (!proxy) {
      if (isBuiltinConnectionId(id)) throw new Error('Only proxy connections have a stored secret')
      throw new Error('Unknown connection')
    }
    const key = cleanProxyKey(input.apiKey)
    // An explicit clear is checked before anything changes (Wave 7, 5.5 Deletes).
    if (!key) this.refuseClear(proxySecretKey(proxy.id))
    const before = this.effectiveDefault()
    this.deps.secrets.set(proxySecretKey(proxy.id), key)
    this.deps.settings.setProxyKeyStored(proxy.id, !!key)
    // A saved key waits for Test and connect (tentative); a removed key is a definite disconnect.
    this.setStatus(
      proxy.id,
      { state: 'disconnected', detail: key ? 'Key saved. Test and connect to apply.' : 'Set an API key.', checkedAt: this.now() },
      { definite: !key }
    )
    this.defaultMayHaveMoved(before)
    this.deps.broadcast({ type: 'connections.changed' })
    return this.info(proxy.id)
  }

  /**
   * Add a proxy connection. Enabled and not yet connected: the caller connects or tests next. Refused with a readable
   * message at PROXIES_MAX, on a duplicate or invalid name, or on an invalid URL / kind / key. The key (optional) is
   * stored like setSecret and never returned.
   */
  async createProxy(input: ProxyCreateInput): Promise<ConnectionInfo> {
    if (!input || typeof input !== 'object') throw new Error('Give the connection a name and a base URL.')
    const s = this.settingsNow()
    if (s.proxies.length >= PROXIES_MAX) throw new Error(`You can add at most ${PROXIES_MAX} proxy connections. Remove one first.`)
    const name = cleanProxyName(input.name, s.proxies.map((p) => p.name))
    const kind = input.kind === undefined ? 'openai-compatible' : PROXY_KINDS.find((k) => k === input.kind)
    if (!kind) throw new Error('Unknown proxy kind')
    const anthropicBaseUrl = normalizeProxyUrl(input.anthropicBaseUrl, 'Base URL')
    const openaiBaseUrl = input.openaiBaseUrl?.trim() ? normalizeProxyUrl(input.openaiBaseUrl, 'OpenAI base URL') : undefined
    const modelsUrl = input.modelsUrl?.trim() ? normalizeProxyUrl(input.modelsUrl, 'Models URL') : undefined
    const key = cleanProxyKey(input.apiKey)
    const id = newProxyId([...s.proxies.map((p) => p.id), ...this.removedProxyIds])
    const before = this.effectiveDefault()
    if (key) this.deps.secrets.set(proxySecretKey(id), key)
    try {
      this.deps.settings.setProxies([
        ...s.proxies,
        { id, name, kind, anthropicBaseUrl, ...(openaiBaseUrl ? { openaiBaseUrl } : {}), ...(modelsUrl ? { modelsUrl } : {}), enabled: true, hasApiKey: !!key, tierModels: {} }
      ])
    } catch (e) {
      this.deps.secrets.delete(proxySecretKey(id))
      throw e
    }
    this.setStatus(id, { state: 'disconnected', detail: 'Not connected yet. Test and connect.', checkedAt: this.now() }, { definite: false })
    this.defaultMayHaveMoved(before)
    this.deps.broadcast({ type: 'connections.changed' })
    return this.info(id)
  }

  /**
   * Delete a proxy connection: its record, stored key, catalog entries and status. Refused while any project's
   * connection is this proxy. A chosen default pointing at it returns to automatic. Run records and usage rows that
   * name the id are kept.
   */
  async removeProxy(id: string): Promise<ProxyRemoveResult> {
    const proxy = typeof id === 'string' ? proxyOf(this.settingsNow(), id) : undefined
    if (!proxy) throw new Error('Unknown connection')
    const users = this.deps.projects.list().filter((p) => projectConnection(p) === proxy.id)
    if (users.length) {
      const shown = users.slice(0, 5).map((p) => p.name)
      const more = users.length > 5 ? ` and ${users.length - 5} more` : ''
      throw new Error(`${proxy.name} is used by ${shown.join(', ')}${more}. Move those projects to another connection first.`)
    }
    const before = this.effectiveDefault()
    const s = this.settingsNow()
    this.deps.settings.setProxies(s.proxies.filter((p) => p.id !== proxy.id))
    this.deps.secrets.delete(proxySecretKey(proxy.id))
    delete this.discovered[proxy.id]
    delete this.refreshedAt[proxy.id]
    delete this.modelsErrors[proxy.id]
    delete this.statuses[proxy.id]
    this.tentative.delete(proxy.id)
    this.removedProxyIds.add(proxy.id)
    this.persistModels()
    this.rewriteDefault()
    this.defaultMayHaveMoved(before)
    this.deps.broadcast({ type: 'connections.changed' })
    return { connections: await this.list() }
  }

  // ---------- connect / logout ----------

  async connect(id: ConnectionId): Promise<ConnectionInfo> {
    const conn = this.need(id)
    if (!conn.enabled) this.saveConnection({ ...conn, enabled: true } as ProviderConnection)
    this.setStatus(id, { state: 'connecting', checkedAt: this.now() })
    const status = this.setStatus(id, await this.probe(id))
    if (status.state === 'connected') {
      try {
        const found = await this.discover(id)
        const results = Array.isArray(found) ? this.applyCatalog(id, found, ['connected', 'catalog']) : this.reapplyTiers(id)
        if (Array.isArray(found) && status.checks) {
          // Discovery knows what the list-only probe could not: whether any model carries a price.
          this.setStatus(id, { ...status, checks: { ...status.checks, modelCount: found.length, reportsPrices: found.some((m) => m.price !== undefined) } })
        }
        this.broadcastRemaps(results)
      } catch (e) {
        this.setStatus(id, { state: 'error', detail: this.safeMessage(e), checkedAt: this.now() })
      }
    }
    return this.info(id)
  }

  /** No discovery (Anthropic, API-key OpenAI): still fill missing tiers from the catalog and remap. */
  private reapplyTiers(id: ConnectionId): RemapResult[] {
    const catalog = this.catalogFor(id)
    const { previous, next } = this.retier(id, catalog, suggestTierModels(id, catalog))
    return this.remapConnectionProjects(id, next, previous, 'connected')
  }

  async logout(id: ConnectionId): Promise<ConnectionInfo> {
    this.need(id)
    const before = this.effectiveDefault()
    const checkedAt = this.now()
    if (id === 'openai') {
      if (this.deps.settings.get().connections.openai.auth.kind === 'chatgpt') {
        try {
          await this.withCodex((rpc) => logoutAccount(rpc))
        } catch (e) {
          this.setStatus('openai', { state: 'error', detail: `Could not sign out: ${this.safeMessage(e)}`, checkedAt })
          return this.info('openai')
        }
      }
      this.setStatus('openai', { state: 'disconnected', detail: 'Signed out', checkedAt })
    } else if (!isBuiltinConnectionId(id)) {
      // Removing the key is the user's explicit clear (5.5): refused before anything changes when it cannot be recorded.
      this.refuseClear(proxySecretKey(id))
      this.deps.secrets.clear(proxySecretKey(id))
      this.deps.settings.setProxyKeyStored(id, false)
      this.setStatus(id, { state: 'disconnected', detail: 'API key removed', checkedAt })
      this.deps.broadcast({ type: 'connections.changed' })
    } else {
      this.setStatus('anthropic', { state: 'disconnected', detail: 'Marked disconnected', checkedAt })
    }
    this.defaultMayHaveMoved(before)
    return this.info(id)
  }

  // ---------- Codex app-server and ChatGPT login ----------

  private createCodex(): CodexAppServer {
    if (this.deps.codexFactory) return this.deps.codexFactory()
    const home = codexHomeDir(this.deps.dataDir)
    mkdirSync(home, { recursive: true })
    return new CodexAppServer({ cwd: this.deps.dataDir, env: { CODEX_HOME: home } })
  }

  private acquireCodex(): Promise<CodexLease> {
    if (this.disposed) return Promise.reject(new Error('Connections are shutting down'))
    if (!this.codex) {
      this.codex = (async () => {
        const server = this.createCodex()
        const lease: CodexLease = { server, leases: 0, offLogin: () => {} }
        await server.start()
        lease.offLogin = onLoginCompleted(server as CodexRpc, (r) => this.onLoginCompleted(lease, r))
        server.onExit(() => this.onCodexExit(lease))
        this.codexLease = lease
        return lease
      })()
      this.codex.catch(() => {
        this.codex = null
      })
    }
    return this.codex.then((lease) => {
      lease.leases++
      return lease
    })
  }

  private releaseCodex(lease: CodexLease): void {
    lease.leases = Math.max(0, lease.leases - 1)
    if (lease.leases > 0) return
    lease.offLogin()
    lease.server.close()
    this.forgetCodex(lease)
  }

  private forgetCodex(lease: CodexLease): void {
    if (this.codexLease !== lease) return
    this.codexLease = null
    this.codex = null
  }

  private async withCodex<T>(fn: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const lease = await this.acquireCodex()
    try {
      return await fn(lease.server as CodexRpc)
    } finally {
      this.releaseCodex(lease)
    }
  }

  private onCodexExit(lease: CodexLease): void {
    this.forgetCodex(lease)
    for (const [loginId, p] of [...this.pendingLogins]) {
      if (p.lease !== lease) continue
      this.pendingLogins.delete(loginId)
      this.emitLogin({ loginId, connection: 'openai', state: 'error', detail: 'The Codex process stopped before the sign-in finished.' })
    }
    lease.leases = 0
  }

  private emitLogin(login: ConnectionLoginUpdate): void {
    this.deps.broadcast({ type: 'connection.login', login })
  }

  async login(id: 'openai', method: ConnectionLoginMethod = 'browser'): Promise<ConnectionLoginStart> {
    if (id !== 'openai') throw new Error('Only the OpenAI connection has a sign-in')
    const lease = await this.acquireCodex() // the lease is held until the login ends
    let started
    try {
      started = await startLogin(lease.server as CodexRpc, method)
    } catch (e) {
      this.releaseCodex(lease)
      throw e
    }
    this.pendingLogins.set(started.loginId, { lease, method })
    this.emitLogin({ loginId: started.loginId, connection: 'openai', state: 'pending' })
    if (started.method === 'browser') {
      try {
        await this.deps.openExternal(started.authUrl)
      } catch {
        // The renderer also gets authUrl and can show it.
      }
      return { loginId: started.loginId, connection: 'openai', method: 'browser', authUrl: started.authUrl }
    }
    return {
      loginId: started.loginId,
      connection: 'openai',
      method: 'deviceCode',
      verificationUrl: started.verificationUrl,
      userCode: started.userCode,
      ...(started.expiresAt ? { expiresAt: started.expiresAt } : {})
    }
  }

  private onLoginCompleted(lease: CodexLease, r: { loginId: string | null; success: boolean; error: string | null }): void {
    const mine = [...this.pendingLogins].filter(([, p]) => p.lease === lease)
    const loginId = r.loginId && this.pendingLogins.has(r.loginId) ? r.loginId : mine.length === 1 ? mine[0][0] : null
    if (!loginId) return
    this.pendingLogins.delete(loginId)
    void (async () => {
      try {
        if (!r.success) {
          this.emitLogin({ loginId, connection: 'openai', state: 'error', detail: r.error ?? 'Sign-in failed' })
          return
        }
        // Refresh status and models while the lease is still held, then report success.
        const info = await this.connect('openai')
        this.emitLogin({ loginId, connection: 'openai', state: 'success', account: info.status.account })
      } catch (e) {
        this.emitLogin({ loginId, connection: 'openai', state: 'error', detail: this.safeMessage(e) })
      } finally {
        this.releaseCodex(lease)
      }
    })()
  }

  async cancelLogin(loginId: string): Promise<void> {
    const p = this.pendingLogins.get(loginId)
    if (!p) return
    this.pendingLogins.delete(loginId)
    try {
      await cancelLogin(p.lease.server as CodexRpc, loginId)
    } catch {
      // the login may already be over
    } finally {
      this.releaseCodex(p.lease)
    }
    this.emitLogin({ loginId, connection: 'openai', state: 'cancelled' })
  }

  // ---------- remaps ----------

  private broadcastRemaps(results: RemapResult[]): void {
    const changed = results.filter((r) => r.changes.length)
    if (changed.length) this.deps.broadcast({ type: 'projects.remapped', results: changed })
  }

  /** Apply a remap to a project and keep provider.id on the adapter its models need. */
  private remapOne(project: Project, id: ConnectionId, tierModels: Tiers, previous: Tiers | undefined, reason: RemapReason): { project: Project; result: RemapResult } {
    const out = remapProject(project, { connection: id, tierModels, previousTierModels: previous, catalog: this.catalogFor(id), reason })
    let next = out.project
    if (reason === 'switched' || out.result.changes.length) {
      next = this.withAdapter(next)
    }
    return { project: next, result: out.result }
  }

  /**
   * Put a freshly built project on settings.defaultConnection (when usable): provider fields, tier models of that
   * connection and the adapter its models need. Nothing is saved or broadcast.
   */
  prepareNewProject(project: Project): Project {
    const settings = this.effectiveSettings()
    const id = creationConnection(settings)
    if (id === 'anthropic') return project
    const tierModels = this.record(id)?.tierModels ?? {}
    // A tiered role without a mapping would keep its Anthropic alias, which the other connection cannot serve.
    // Stay on Anthropic then; the user maps the tier in Settings > Connections and switches the project.
    const unmapped = project.roles.some((r) => r.tier && r.model !== 'inherit' && !tierModels[r.tier]?.trim())
    if (unmapped) {
      console.warn(`New project stays on Anthropic: the ${id} connection has no model for every tier the roles use.`)
      return project
    }
    const provider = { ...project.provider, connection: id, label: connectionProviderLabel(id, settings.providerAuth, settings) }
    return this.remapOne({ ...project, provider }, id, tierModels, undefined, 'switched').project
  }

  /** The agent importer's view of a connection: its catalog and tier mapping (src/main/setup/import/model.ts). */
  importModelContext(id: ConnectionId): { connection: ConnectionId; connectionName: string; catalog: ProviderModel[]; tierModels: Tiers } {
    return { connection: id, connectionName: connectionName(id, this.deps.settings.get()), catalog: this.catalogFor(id), tierModels: { ...(this.record(id)?.tierModels ?? {}) } }
  }

  /** Keep provider.id on the adapter the project's models need (mock projects are left alone). Pure. */
  withAdapter(project: Project): Project {
    if (project.provider.id === 'mock') return project
    const adapter = adapterForProject(project, this.catalog()).adapter
    return adapter === project.provider.id ? project : { ...project, provider: { ...project.provider, id: adapter } }
  }

  private remapConnectionProjects(id: ConnectionId, tierModels: Tiers, previous: Tiers | undefined, reason: RemapReason): RemapResult[] {
    const results: RemapResult[] = []
    for (const p of this.deps.projects.list()) {
      if (projectConnection(p) !== id) continue
      const { project, result } = this.remapOne(p, id, tierModels, previous, reason)
      if (!result.changes.length) continue
      this.deps.projects.save(project)
      results.push(result)
    }
    return results
  }

  /** The remap projects:remapModels would apply, without saving anything. */
  private computeRemap(input: RemapModelsInput): { project: Project; result: RemapResult } {
    const stored = this.deps.projects.get(input.projectId)
    if (!stored) throw new Error('Project not found')
    const connection = input.connection
    if (connection !== undefined) this.need(connection)
    const id = connection ?? projectConnection(stored)
    let project = stored
    if (connection) {
      project = { ...stored, provider: { ...stored.provider, connection, label: providerLabelFor(connection, this.settingsNow()) } }
    }
    const tierModels = this.need(id).tierModels
    return this.remapOne(project, id, tierModels, undefined, connection ? 'switched' : 'manual')
  }

  remapModels(input: RemapModelsInput): RemapModelsOutput {
    const out = this.computeRemap(input)
    const saved = this.deps.projects.save(out.project)
    return { result: out.result, project: saved }
  }

  /** projects:previewRemap: the same RemapResult as remapModels, with nothing saved or broadcast. */
  previewRemap(input: RemapModelsInput): RemapResult {
    return this.computeRemap(input).result
  }

  // ---------- per-run model access ----------

  runConnection(project: Project | undefined, choice: AdapterChoice): RunConnection {
    const built = { ...this.buildRunConnection(project, choice), name: connectionName(choice.connection, this.deps.settings.get()) }
    if (choice.adapter === 'mock') return built
    const id = choice.connection
    return {
      ...built,
      tierModels: { ...(this.record(id)?.tierModels ?? {}) },
      models: this.catalogFor(id).map((m) => m.id)
    }
  }

  private buildRunConnection(project: Project | undefined, choice: AdapterChoice): RunConnection {
    const id = choice.connection
    const base: RunConnection = { connection: id, adapter: choice.adapter }
    if (choice.adapter === 'mock') return base
    const settings = this.deps.settings.get()
    const codexHome = (): Record<string, string> => ({ CODEX_HOME: codexHomeDir(this.deps.dataDir) })
    if (id === 'anthropic') {
      // Lets one-shot completions get the key even when the env var is not literally ANTHROPIC_API_KEY.
      const auth = project?.provider.auth ?? settings.connections.anthropic.auth
      const key = auth.kind === 'apiKey' ? this.env(auth.envVar) : undefined
      return { ...base, env: key ? { ANTHROPIC_API_KEY: key } : {} }
    }
    if (id === 'openai') {
      const auth = settings.connections.openai.auth
      if (auth.kind === 'chatgpt') return { ...base, codexAuth: 'chatgpt', env: codexHome() }
      const apiKey = this.env(auth.envVar)
      if (!apiKey) throw new Error(`${auth.envVar} is not set in OrgAI's environment.`)
      return { ...base, codexAuth: 'apiKey', apiKey, env: codexHome() }
    }
    const conn = proxyOf(settings, id)
    if (!conn) throw new Error('This connection no longer exists. Pick another one for the project in Settings > Connections.')
    if (!conn.anthropicBaseUrl) throw new Error(`${conn.name} has no base URL. Set it in Settings > Connections.`)
    const key = this.proxyKey(conn, `${conn.name} has no API key. Set it in Settings > Connections.`)
    const baseUrl = normalizeBaseUrl(conn.anthropicBaseUrl)
    // Prices from the catalog (LiteLLM /model/info only); runs on models without one get no estimate.
    const pricing = pricingFromCatalog(this.catalogFor(conn.id))
    const priced = pricing ? { pricing } : {}
    if (choice.adapter === 'codex') {
      return { ...base, codexAuth: 'apiKey', apiKey: key, openaiBaseUrl: proxyOpenAIBase(conn), env: codexHome(), ...priced }
    }
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key }
    const t = conn.tierModels
    if (t.top) env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.top
    if (t.deep) env.ANTHROPIC_DEFAULT_OPUS_MODEL = t.deep
    if (t.everyday) env.ANTHROPIC_DEFAULT_SONNET_MODEL = t.everyday
    if (t.fast) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.fast
    return { ...base, env, ...priced }
  }

  /**
   * The fast-tier model for one-shot helpers (run titles) on a run's connection: the connection's tierModels.fast,
   * else the catalog's suggestion for the nearest tier (modelForTier), if it runs on the run's adapter. undefined =
   * the adapter's default model. The mock adapter has none.
   */
  fastModel(choice: Pick<AdapterChoice, 'adapter' | 'connection'>): string | undefined {
    if (choice.adapter === 'mock') return undefined
    const conn = this.record(choice.connection)
    if (!conn) return undefined
    const fast = conn.tierModels.fast?.trim()
    if (fast) return fast
    const catalog = this.catalogFor(choice.connection)
    const hit = modelForTier('fast', { connection: choice.connection, tierModels: conn.tierModels, catalog })
    if (!hit) return undefined
    const family = catalog.find((m) => m.id === hit.model)?.family ?? modelFamily(hit.model)
    return adapterForFamily(family) === choice.adapter ? hit.model : undefined
  }

  // ---------- scheduled discovery ----------

  private configured(id: ConnectionId): boolean {
    const conn = this.record(id)
    if (!conn?.enabled) return false
    if (id === 'anthropic') return true
    if (id === 'openai') return !isProxyConnection(conn) && conn.id === 'openai' && conn.auth.kind === 'chatgpt'
    return isProxyConnection(conn) && !!conn.anthropicBaseUrl && !!this.deps.secrets.get(proxySecretKey(conn.id))
  }

  /**
   * Refresh each configured, enabled connection whose last successful discovery is older than staleAfterMs. One run
   * at a time. A failure keeps the last good catalog, leaves the status alone, records modelsError and logs once.
   */
  async discoverStale(staleAfterMs = 24 * 3600_000): Promise<void> {
    if (this.disposed || this.discoveryBusy) return
    this.discoveryBusy = true
    try {
      const results: RemapResult[] = []
      for (const id of this.allIds()) {
        if (this.disposed) break
        if (!this.configured(id)) continue
        const at = this.refreshedAt[id]
        // A timestamp in the future (clock skew, a tampered file) counts as never refreshed.
        const now = this.now()
        if (at && at <= now && now - at < staleAfterMs) continue
        try {
          const found = await this.discover(id)
          if (this.disposed) continue
          if (found === SIGNED_OUT) delete this.modelsErrors[id]
          else if (found?.length) results.push(...this.applyCatalog(id, found, ['catalog']))
          else this.modelsErrors[id] = 'No models returned'
        } catch (e) {
          const message = this.safeMessage(e)
          if (this.modelsErrors[id] !== message) console.warn(`Model discovery for ${id} failed: ${message}`)
          this.modelsErrors[id] = message
        }
      }
      this.broadcastRemaps(results)
    } finally {
      this.discoveryBusy = false
    }
  }

  /** Discover models after a boot delay and then on every check (unref'd timers; dispose() clears them). */
  startDiscovery(opts: DiscoveryOptions = {}): void {
    if (this.disposed) return
    const { bootDelayMs = 20_000, checkEveryMs = 60 * 60_000, staleAfterMs = 24 * 3600_000 } = opts
    const tick = (): void => void this.discoverStale(staleAfterMs)
    const boot = setTimeout(() => {
      tick()
      const every = setInterval(tick, checkEveryMs)
      every.unref?.()
      this.discoveryTimers.push(every)
    }, bootDelayMs)
    boot.unref?.()
    this.discoveryTimers.push(boot)
  }

  // ---------- usage, boot, shutdown ----------

  /**
   * Codex (ChatGPT) plan limits, or null when OpenAI is off, not on a ChatGPT login, not in use (neither the default
   * connection nor any project's, `connectionInUse`; checked before the app-server is spawned) or not signed in.
   */
  async probeCodexUsage(): Promise<UsageStatus | null> {
    const settings = this.effectiveSettings()
    const conn = settings.connections.openai
    if (!conn.enabled || conn.auth.kind !== 'chatgpt') return null
    if (!connectionInUse('openai', settings, this.deps.projects.list())) return null
    try {
      const raw = await this.withCodex(async (rpc) => ((await readAccount(rpc)).account ? readRateLimits(rpc) : null))
      return raw ? mapCodexRateLimits(raw, this.now()) : null
    } catch {
      return null
    }
  }

  /**
   * One UsageStatus per enabled, configured, in-use proxy of kind 'litellm': the virtual key's spend and budget (GET
   * /key/info) plus its spend by UTC calendar period (the daily activity routes, keyed by the key's hash; a failure
   * there only sets `spend.periodsNote`). `connection` is that proxy's id. A proxy that is off, has no base URL or key,
   * is not in use (neither the default connection nor any project's, `connectionInUse`), is 'openai-compatible', is the
   * ORGAI_MOCK=1 mock host, or whose /key/info gave no spend (no DB, refused, timeout, junk) yields nothing. Never
   * throws; no key is logged. `updatedAt` is the instant the periods were computed from.
   */
  async probeProxyUsages(): Promise<UsageStatus[]> {
    const settings = this.effectiveSettings()
    const out: UsageStatus[] = []
    for (const conn of settings.proxies) {
      if (conn.kind !== 'litellm' || !conn.enabled || !conn.anthropicBaseUrl) continue
      if (isMockProxyUrl(conn.anthropicBaseUrl) || isMockProxyUrl(proxyModelsUrl(conn))) continue
      if (!connectionInUse(conn.id, settings, this.deps.projects.list())) continue
      const key = this.deps.secrets.get(proxySecretKey(conn.id))
      if (!key) continue
      try {
        const now = this.now()
        const spend = await fetchLiteLLMSpend(conn.anthropicBaseUrl, key, this.deps.fetch ?? fetch, now)
        if (spend) out.push({ connection: conn.id, authMode: 'apiKey', subscriptionType: null, available: true, windows: {}, spend, updatedAt: now })
      } catch {
        // a proxy that cannot report spend simply shows none
      }
    }
    return out
  }

  /** Kick off background status probes for enabled connections. Never blocks or throws. */
  init(): void {
    for (const id of this.allIds()) {
      if (!this.record(id)?.enabled) continue
      this.statuses[id] = { state: 'connecting' }
      void this.probe(id).then((status) => {
        if (!this.disposed) this.setStatus(id, status)
      })
    }
  }

  /**
   * Boot migration of stored projects (provider.connection, Role.tier). ProjectStore already runs it when it
   * loads, so this is a no-op safety net that returns how many projects it changed.
   */
  migrateProjects(): number {
    return this.deps.projects.migrateAll()
  }

  /** Host drain: stop the `claude auth status` children and start no more (the drain then waits for their exit). */
  abortProbes(): void {
    this.stopSignal.abort()
  }

  dispose(): void {
    this.disposed = true
    this.stopSignal.abort()
    for (const t of this.discoveryTimers.splice(0)) {
      clearTimeout(t)
      clearInterval(t)
    }
    const codex = this.codex
    this.codex = null
    this.pendingLogins.clear()
    void codex?.then((l) => {
      l.offLogin()
      l.server.close()
    }).catch(() => {})
  }
}
