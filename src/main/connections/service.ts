import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { adapterForFamily, adapterForProject, builtinModels, connectionConfigured, connectionInUse, connectionProviderLabel, connectionUsable, creationConnection, effectiveDefaultConnection, isConnectionId, modelFamily, modelForTier, projectConnection } from '@shared/defaults'
import { CONNECTION_IDS, MODEL_TIERS } from '@shared/types'
import type {
  ModelPriceInfo,
  ModelPricesQuery,
  AdapterChoice,
  ConnectionEvent,
  AppSettings,
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
import { LITELLM_KEY, type SecretStore } from '../store/secrets'
import type { SettingsStore } from '../store/settings'
import type { AdapterModelInfo, RunConnection } from '../runtime/types'
import { anthropicStatus } from './anthropicAuth'
import { anthropicModelsToCatalog, builtinTierModels, makeDiscoveredModel, suggestTierModels, tierFromDescription } from './catalog'
import { cancelLogin, listModels, validModelId, MODEL_TEXT_MAX, logoutAccount, onLoginCompleted, readAccount, readRateLimits, startLogin, type CodexRpc } from './codexAccount'
import { mapCodexRateLimits } from './codexUsage'
import { LITELLM_MAX_MODELS, fetchLiteLLMModels, fetchLiteLLMSpend, normalizeBaseUrl } from './litellm'
import { pricingFromCatalog } from '../runtime/pricing'
import { remapProject } from './remap'
import { CONNECTION_LABELS, defaultRefusal, withoutReplaced } from './defaultPick'

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

/** discover(): a ChatGPT connection with no signed-in account has nothing to discover (not an error). */
const SIGNED_OUT = 'signed-out' as const

const PROVIDER_LABEL: Record<ConnectionId, string> = { anthropic: 'Claude', openai: 'Codex (ChatGPT)', litellm: 'LiteLLM' }

/**
 * Connections and the model catalog: probes, logins, discovery, tier mapping, project remaps and the per-run
 * model access (RunConnection). Nothing here ever returns, broadcasts or logs the LiteLLM key.
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
  /**
   * Connections whose current 'disconnected' status is tentative (a LiteLLM base URL change or a saved key waiting
   * for Test and connect): effectiveDefault reads them as 'unknown', so they never move the default. Cleared by the
   * next definite status.
   */
  private tentative = new Set<ConnectionId>()

  constructor(private deps: ConnectionServiceDeps) {
    this.modelsFile = join(deps.dataDir, 'models.json')
    this.loadModels()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ---------- persistence of discovered catalogs ----------

  private loadModels(): void {
    try {
      if (!existsSync(this.modelsFile)) return
      const parsed = JSON.parse(readFileSync(this.modelsFile, 'utf8')) as { models?: Record<string, unknown>; refreshedAt?: Record<string, unknown> }
      for (const id of CONNECTION_IDS) {
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
    return found.map((m) => ({ ...m }))
  }

  /** Every connection's catalog, for adapterForProject. */
  catalog(): ProviderModel[] {
    return CONNECTION_IDS.flatMap((id) => this.catalogFor(id))
  }

  /** The catalog of one connection, or of every enabled connection. */
  models(query?: ModelsQuery): ProviderModel[] {
    if (query?.connection !== undefined && !isConnectionId(query.connection)) throw new Error('Unknown connection')
    if (query?.connection) return this.catalogFor(query.connection)
    const s = this.deps.settings.get()
    return CONNECTION_IDS.filter((id) => s.connections[id].enabled).flatMap((id) => this.catalogFor(id))
  }

  /** models:prices: user overrides, LiteLLM proxy prices and the built-in table (pricing.ts listModelPrices). */
  prices(query?: ModelPricesQuery): ModelPriceInfo[] {
    return listModelPrices(query, this.deps.settings.get().modelPrices ?? [], CONNECTION_IDS.flatMap((id) => this.catalogFor(id)))
  }

  /** Re-discover models (LiteLLM, Codex) and return the new catalog. A failed discovery keeps the old catalog and sets an error status. */
  async refresh(query?: ModelsQuery): Promise<ProviderModel[]> {
    if (query?.connection !== undefined && !isConnectionId(query.connection)) throw new Error('Unknown connection')
    const s = this.deps.settings.get()
    const ids = query?.connection ? [query.connection] : CONNECTION_IDS.filter((id) => s.connections[id].enabled)
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
    if (id === 'litellm') {
      const conn = this.deps.settings.get().connections.litellm
      if (!conn.baseUrl) throw new Error('LiteLLM has no base URL')
      const key = this.litellmKey('LiteLLM has no API key')
      return fetchLiteLLMModels(conn.baseUrl, key, this.deps.fetch ?? fetch)
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
    const conn = this.deps.settings.get().connections[id]
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
    if (!isConnectionId(id)) throw new Error('Unknown connection')
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
    if (old !== undefined && !(isConnectionId(old) && connectionConfigured(old, s.connections))) {
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
    const why = back ? `${CONNECTION_LABELS[next]} is connected again` : `${CONNECTION_LABELS[s.defaultConnection]} is not connected`
    ;(this.deps.logInfo ?? ((m) => console.info(m)))(`Default connection is now ${CONNECTION_LABELS[next]} (automatic: ${why})`)
  }

  /** Whether a connection can be the default now (configured and connected). */
  isUsable(id: ConnectionId): boolean {
    return connectionUsable(id, this.deps.settings.get().connections, this.statuses[id]?.state)
  }

  /** The refusal for making an unusable connection the default, or null when it is usable. */
  defaultRefusalFor(id: ConnectionId): string | null {
    return this.isUsable(id) ? null : defaultRefusal(id, this.deps.settings.get().connections)
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
      if (!isConnectionId(input)) throw new Error('Unknown connection')
      // Re-choosing the stored default needs only that it is still configured (its live state may be anything);
      // any other connection must be usable now.
      const refusal =
        input === s.defaultConnection
          ? connectionConfigured(input, s.connections) ? null : defaultRefusal(input, s.connections)
          : this.defaultRefusalFor(input)
      if (refusal) throw new Error(refusal)
      this.deps.settings.set({ ...withoutReplaced(s), defaultConnection: input, defaultConnectionChosen: true })
    }
    return this.list()
  }

  /**
   * The stored LiteLLM key, else a throw: a key that is stored but cannot be read here says why with the store's reason
   * (Wave 7, 5.4: saved by the OrgAI app and not yet shared, a locked or damaged vault), never "no API key" (which would
   * send the user to type it again); `missing` is the sentence for a key that is not stored at all.
   */
  private litellmKey(missing: string): string {
    const stored = this.deps.secrets.status(LITELLM_KEY)
    if (typeof stored === 'object') throw new Error(`The LiteLLM API key cannot be read here: ${stored.unreadable.replace(/[.\s]+$/, '')}.`)
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (!key) throw new Error(missing)
    return key
  }

  private safeMessage(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e)
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (key) msg = msg.split(key).join('***')
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
    for (const id of CONNECTION_IDS) {
      if (!connectionConfigured(id, s.connections)) continue
      states[id] = this.tentative.has(id) ? 'unknown' : (this.statuses[id]?.state ?? 'unknown')
    }
    return effectiveDefaultConnection({ stored: s.defaultConnection, chosen: s.defaultConnectionChosen === true, replaced: s.defaultConnectionReplaced, states })
  }

  private info(id: ConnectionId, effective: ConnectionId = this.effectiveDefault()): ConnectionInfo {
    const connection = this.deps.settings.get().connections[id]
    const refreshed = this.refreshedAt[id]
    const error = this.modelsErrors[id]
    return {
      connection,
      status: this.statuses[id] ?? { state: 'disconnected' },
      modelCount: this.catalogFor(id).length,
      isDefault: id === effective,
      ...(refreshed ? { modelsRefreshedAt: refreshed } : {}),
      ...(error ? { modelsError: error } : {})
    }
  }

  async list(): Promise<ConnectionInfo[]> {
    const effective = this.effectiveDefault()
    return CONNECTION_IDS.map((id) => this.info(id, effective))
  }

  /** Probe one connection without touching its catalog or enabled flag. Returns the status (not stored). */
  private async probe(id: ConnectionId): Promise<ConnectionStatus> {
    const s = this.deps.settings.get()
    try {
      if (id === 'anthropic') {
        const probe = this.deps.anthropicProbe ?? anthropicStatus
        return { ...(await probe(s.connections.anthropic.auth)), checkedAt: this.now() }
      }
      if (id === 'openai') return await this.probeOpenAI()
      return await this.probeLiteLLM()
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

  private async probeLiteLLM(): Promise<ConnectionStatus> {
    const conn = this.deps.settings.get().connections.litellm
    const checkedAt = this.now()
    if (!conn.baseUrl) return { state: 'disconnected', detail: 'Set the proxy base URL.', checkedAt }
    // A key that is stored but cannot be read here (Wave 7, 5.4: saved by the app and not yet shared, a locked or damaged
    // vault, safeStorage failure) is an error with the store's reason, not a definite disconnect: it must not move the
    // automatic default, and "set it again" would be the wrong advice.
    const stored = this.deps.secrets.status(LITELLM_KEY)
    if (typeof stored === 'object') return { state: 'error', detail: stored.unreadable, checkedAt }
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (!key && conn.hasApiKey) return { state: 'error', detail: 'The stored key is gone. Set the API key again.', checkedAt }
    if (!key) return { state: 'disconnected', detail: 'Set an API key.', checkedAt }
    const models = await fetchLiteLLMModels(conn.baseUrl, key, this.deps.fetch ?? fetch)
    return { state: 'connected', detail: `${models.length} model${models.length === 1 ? '' : 's'} available`, checkedAt }
  }

  private env(name: string): string | undefined {
    return process.env[name]?.trim() || undefined
  }

  async test(id: ConnectionId): Promise<ConnectionStatus> {
    if (!isConnectionId(id)) throw new Error('Unknown connection')
    return this.setStatus(id, await this.probe(id))
  }

  // ---------- settings records ----------

  private saveConnection(c: ProviderConnection): void {
    const current = this.deps.settings.get()
    this.deps.settings.set({ ...current, connections: { ...current.connections, [c.id]: c } })
  }

  async update(c: ProviderConnection): Promise<ConnectionInfo> {
    if (!c || !isConnectionId(c.id)) throw new Error('Unknown connection')
    const before = this.effectiveDefault()
    const old = this.deps.settings.get().connections[c.id]
    const wasConfigured = connectionConfigured(c.id, this.deps.settings.get().connections)
    // autoTiers is main-owned (the renderer's copy is ignored): a tier the caller changed is the user's from now on.
    const wasAuto = this.autoTiersOf(c.id, old.tierModels, old.autoTiers, suggestTierModels(c.id, this.catalogFor(c.id)))
    for (const tier of MODEL_TIERS) if ((c.tierModels?.[tier] ?? '') !== (old.tierModels[tier] ?? '')) wasAuto.delete(tier)
    // SettingsStore.set keeps the stored hasApiKey and mirrors Anthropic auth into providerAuth.
    this.saveConnection({ ...c, autoTiers: MODEL_TIERS.filter((t) => wasAuto.has(t)) } as ProviderConnection)
    const fresh = this.deps.settings.get().connections[c.id]
    if (c.id === 'litellm' && fresh.id === 'litellm' && old.id === 'litellm' && fresh.baseUrl !== old.baseUrl) {
      this.setStatus('litellm', { state: 'disconnected', detail: 'Changed. Test and connect to apply.', checkedAt: this.now() }, { definite: false })
    }
    if (!sameTiers(old.tierModels, fresh.tierModels)) {
      this.broadcastRemaps(this.remapConnectionProjects(c.id, fresh.tierModels, old.tierModels, 'tierModels'))
    }
    // Turning a connection off (Anthropic's Disconnect) or on, or clearing / setting LiteLLM's base URL, changes what
    // is configured: a definite change.
    if (old.enabled !== fresh.enabled || wasConfigured !== connectionConfigured(c.id, this.deps.settings.get().connections)) this.rewriteDefault()
    this.defaultMayHaveMoved(before)
    return this.info(c.id)
  }

  /** Throws SecretStore.clearRefusal's sentence for the LiteLLM key (vault damaged; app-only key on a Node host). */
  private refuseClear(): void {
    const refusal = this.deps.secrets.clearRefusal(LITELLM_KEY)
    if (refusal) throw new Error(refusal)
  }

  async setSecret(input: ConnectionSecretInput): Promise<ConnectionInfo> {
    if (input?.id !== 'litellm') throw new Error('Only the LiteLLM connection has a stored secret')
    const key = input.apiKey?.trim() || null
    // An explicit clear is checked before anything changes (Wave 7, 5.5 Deletes).
    if (!key) this.refuseClear()
    const before = this.effectiveDefault()
    this.deps.secrets.set(LITELLM_KEY, key)
    this.deps.settings.setLiteLLMKeyStored(!!key)
    // A saved key waits for Test and connect (tentative); a removed key is a definite disconnect.
    this.setStatus(
      'litellm',
      { state: 'disconnected', detail: key ? 'Key saved. Test and connect to apply.' : 'Set an API key.', checkedAt: this.now() },
      { definite: !key }
    )
    this.defaultMayHaveMoved(before)
    return this.info('litellm')
  }

  // ---------- connect / logout ----------

  async connect(id: ConnectionId): Promise<ConnectionInfo> {
    if (!isConnectionId(id)) throw new Error('Unknown connection')
    const conn = this.deps.settings.get().connections[id]
    if (!conn.enabled) this.saveConnection({ ...conn, enabled: true } as ProviderConnection)
    this.setStatus(id, { state: 'connecting', checkedAt: this.now() })
    const status = this.setStatus(id, await this.probe(id))
    if (status.state === 'connected') {
      try {
        const found = await this.discover(id)
        const results = Array.isArray(found) ? this.applyCatalog(id, found, ['connected', 'catalog']) : this.reapplyTiers(id)
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
    if (!isConnectionId(id)) throw new Error('Unknown connection')
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
    } else if (id === 'litellm') {
      // Removing the key is the user's explicit clear (5.5): refused before anything changes when it cannot be recorded.
      this.refuseClear()
      this.deps.secrets.clear(LITELLM_KEY)
      this.deps.settings.setLiteLLMKeyStored(false)
      this.setStatus('litellm', { state: 'disconnected', detail: 'API key removed', checkedAt })
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
    const tierModels = settings.connections[id].tierModels
    // A tiered role without a mapping would keep its Anthropic alias, which the other connection cannot serve.
    // Stay on Anthropic then; the user maps the tier in Settings > Connections and switches the project.
    const unmapped = project.roles.some((r) => r.tier && r.model !== 'inherit' && !tierModels[r.tier]?.trim())
    if (unmapped) {
      console.warn(`New project stays on Anthropic: the ${id} connection has no model for every tier the roles use.`)
      return project
    }
    const provider = { ...project.provider, connection: id, label: connectionProviderLabel(id, settings.providerAuth) }
    return this.remapOne({ ...project, provider }, id, tierModels, undefined, 'switched').project
  }

  /** The agent importer's view of a connection: its catalog and tier mapping (src/main/setup/import/model.ts). */
  importModelContext(id: ConnectionId): { connection: ConnectionId; catalog: ProviderModel[]; tierModels: Tiers } {
    return { connection: id, catalog: this.catalogFor(id), tierModels: { ...this.deps.settings.get().connections[id].tierModels } }
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
    if (connection && !CONNECTION_IDS.includes(connection)) throw new Error('Unknown connection')
    const id = connection ?? projectConnection(stored)
    let project = stored
    if (connection) {
      project = { ...stored, provider: { ...stored.provider, connection, label: PROVIDER_LABEL[connection] } }
    }
    const tierModels = this.deps.settings.get().connections[id].tierModels
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
    const built = this.buildRunConnection(project, choice)
    if (choice.adapter === 'mock') return built
    const id = choice.connection
    return {
      ...built,
      tierModels: { ...this.deps.settings.get().connections[id].tierModels },
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
    const conn = settings.connections.litellm
    if (!conn.baseUrl) throw new Error('LiteLLM has no base URL. Set it in Settings > Connections.')
    const key = this.litellmKey('LiteLLM has no API key. Set it in Settings > Connections.')
    const baseUrl = normalizeBaseUrl(conn.baseUrl)
    // Prices from /model/info (catalog); runs on models without one get no estimate.
    const pricing = pricingFromCatalog(this.catalogFor('litellm'))
    const priced = pricing ? { pricing } : {}
    if (choice.adapter === 'codex') {
      return { ...base, codexAuth: 'apiKey', apiKey: key, openaiBaseUrl: `${baseUrl}/v1`, env: codexHome(), ...priced }
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
    const conn = this.deps.settings.get().connections[choice.connection]
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
    const conn = this.deps.settings.get().connections[id]
    if (!conn.enabled) return false
    if (id === 'anthropic') return true
    if (id === 'openai') return conn.id === 'openai' && conn.auth.kind === 'chatgpt'
    return !!(conn as { baseUrl?: string }).baseUrl && !!this.deps.secrets.get(LITELLM_KEY)
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
      for (const id of CONNECTION_IDS) {
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
   * The LiteLLM virtual key's spend and budget (GET /key/info) plus its spend by UTC calendar period (the daily
   * activity routes, keyed by the key's hash; a failure there only sets `spend.periodsNote`), or null when LiteLLM
   * is off, has no base URL or key, is not in use (neither the default connection nor any project's,
   * `connectionInUse`) or the proxy did not answer /key/info with a spend (no DB, refused, timeout, junk). Never
   * throws; the key is never logged. `updatedAt` is the instant the periods were computed from.
   */
  async probeLiteLLMUsage(): Promise<UsageStatus | null> {
    const settings = this.effectiveSettings()
    const conn = settings.connections.litellm
    if (!conn.enabled || !conn.baseUrl) return null
    if (!connectionInUse('litellm', settings, this.deps.projects.list())) return null
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (!key) return null
    try {
      const now = this.now()
      const spend = await fetchLiteLLMSpend(conn.baseUrl, key, this.deps.fetch ?? fetch, now)
      if (!spend) return null
      return { connection: 'litellm', authMode: 'apiKey', subscriptionType: null, available: true, windows: {}, spend, updatedAt: now }
    } catch {
      return null
    }
  }

  /** Kick off background status probes for enabled connections. Never blocks or throws. */
  init(): void {
    const s = this.deps.settings.get()
    for (const id of CONNECTION_IDS) {
      if (!s.connections[id].enabled) continue
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

  dispose(): void {
    this.disposed = true
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
