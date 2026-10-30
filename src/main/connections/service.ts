import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { adapterForProject, builtinModels, connectionProviderLabel, creationConnection, projectConnection } from '@shared/defaults'
import { CONNECTION_IDS } from '@shared/types'
import type {
  AdapterChoice,
  ConnectionEvent,
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
  ProviderConnection,
  ProviderModel,
  RemapModelsInput,
  RemapModelsOutput,
  RemapReason,
  RemapResult,
  UsageStatus
} from '@shared/types'
import { CodexAppServer, codexHomeDir } from '../runtime/codexAppServer'
import type { ProjectStore } from '../store/projects'
import { LITELLM_KEY, type SecretStore } from '../store/secrets'
import type { SettingsStore } from '../store/settings'
import type { RunConnection } from '../runtime/types'
import { anthropicStatus } from './anthropicAuth'
import { autoFillTierModels, makeDiscoveredModel } from './catalog'
import { cancelLogin, listModels, logoutAccount, onLoginCompleted, readAccount, readRateLimits, startLogin, type CodexRpc } from './codexAccount'
import { mapCodexRateLimits } from './codexUsage'
import { fetchLiteLLMModels, normalizeBaseUrl } from './litellm'
import { remapProject } from './remap'

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
  now?: () => number
  /** Probe the Anthropic connection. Default: anthropicAuth.anthropicStatus (runs `claude auth status`). */
  anthropicProbe?: typeof anthropicStatus
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
  private codex: Promise<CodexLease> | null = null
  /** The started lease; cleared synchronously when the server is released or exits. */
  private codexLease: CodexLease | null = null
  private pendingLogins = new Map<string, PendingLogin>()
  private disposed = false

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
      const parsed = JSON.parse(readFileSync(this.modelsFile, 'utf8')) as { models?: Record<string, unknown> }
      for (const id of CONNECTION_IDS) {
        const list = parsed.models?.[id]
        if (Array.isArray(list)) {
          this.discovered[id] = list.filter(
            (m): m is ProviderModel => !!m && typeof m === 'object' && typeof (m as ProviderModel).id === 'string' && (m as ProviderModel).connection === id
          )
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
    writeFileSync(tmp, JSON.stringify({ version: 1, models: this.discovered }, null, 2), 'utf8')
    renameSync(tmp, this.modelsFile)
  }

  // ---------- catalog ----------

  private catalogFor(id: ConnectionId): ProviderModel[] {
    const found = this.discovered[id] ?? []
    if (id === 'anthropic') return builtinModels('anthropic')
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
    if (query?.connection) return this.catalogFor(query.connection)
    const s = this.deps.settings.get()
    return CONNECTION_IDS.filter((id) => s.connections[id].enabled).flatMap((id) => this.catalogFor(id))
  }

  /** Re-discover models (LiteLLM, Codex) and return the new catalog. A failed discovery keeps the old catalog and sets an error status. */
  async refresh(query?: ModelsQuery): Promise<ProviderModel[]> {
    const s = this.deps.settings.get()
    const ids = query?.connection ? [query.connection] : CONNECTION_IDS.filter((id) => s.connections[id].enabled)
    const results: RemapResult[] = []
    for (const id of ids) {
      if (id === 'anthropic') continue
      try {
        const found = await this.discover(id)
        if (found) results.push(...this.applyCatalog(id, found, ['catalog']))
      } catch (e) {
        this.setStatus(id, { state: 'error', detail: this.safeMessage(e), checkedAt: this.now() })
      }
    }
    this.broadcastRemaps(results)
    return this.models(query)
  }

  /** Ask the connection for its models. null = this connection has nothing to discover right now. */
  private async discover(id: ConnectionId): Promise<ProviderModel[] | null> {
    if (id === 'litellm') {
      const conn = this.deps.settings.get().connections.litellm
      const key = this.deps.secrets.get(LITELLM_KEY)
      if (!conn.baseUrl) throw new Error('LiteLLM has no base URL')
      if (!key) throw new Error('LiteLLM has no API key')
      return fetchLiteLLMModels(conn.baseUrl, key, this.deps.fetch ?? fetch)
    }
    if (id === 'openai') {
      if (this.deps.settings.get().connections.openai.auth.kind !== 'chatgpt') return null
      const list = await this.withCodex(async (rpc) => {
        const account = await readAccount(rpc)
        return account.account ? listModels(rpc) : []
      })
      return list.map((m) => makeDiscoveredModel('openai', { id: m.id, label: m.label, family: 'openai', hint: m.description }))
    }
    return null
  }

  /**
   * Store a discovered catalog, refill the tier mapping and remap the connection's projects. Returns the
   * remap results (callers broadcast them). Broadcasts models.updated when the catalog's ids changed.
   * An empty OpenAI list is ignored so the placeholders stay.
   */
  private applyCatalog(id: ConnectionId, found: ProviderModel[], reasons: RemapReason[]): RemapResult[] {
    if (id === 'openai' && found.length === 0) return []
    const beforeIds = this.catalogFor(id).map((m) => m.id).join('\n')
    this.discovered[id] = found
    this.persistModels()
    const catalog = this.catalogFor(id)
    const changed = beforeIds !== catalog.map((m) => m.id).join('\n')
    const conn = this.deps.settings.get().connections[id]
    const previous = conn.tierModels
    const filled = autoFillTierModels(previous, catalog)
    if (!sameTiers(previous, filled)) this.saveConnection({ ...conn, tierModels: filled } as ProviderConnection)
    if (changed) this.deps.broadcast({ type: 'models.updated', connection: id, models: catalog })
    const results: RemapResult[] = []
    for (const reason of reasons) results.push(...this.remapConnectionProjects(id, filled, previous, reason))
    return results
  }

  // ---------- statuses ----------

  private setStatus(id: ConnectionId, status: ConnectionStatus): ConnectionStatus {
    this.statuses[id] = status
    this.deps.broadcast({ type: 'connection.status', connection: id, status })
    return status
  }

  private safeMessage(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e)
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (key) msg = msg.split(key).join('***')
    return msg.slice(0, 200)
  }

  private info(id: ConnectionId): ConnectionInfo {
    const connection = this.deps.settings.get().connections[id]
    return { connection, status: this.statuses[id] ?? { state: 'disconnected' }, modelCount: this.catalogFor(id).length }
  }

  async list(): Promise<ConnectionInfo[]> {
    return CONNECTION_IDS.map((id) => this.info(id))
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
    if (auth.kind === 'apiKey') {
      return this.env(auth.envVar)
        ? { state: 'connected', detail: `Using ${auth.envVar}`, checkedAt }
        : { state: 'disconnected', detail: `${auth.envVar} is not set in OrgAI's environment`, checkedAt }
    }
    const state = await this.withCodex((rpc) => readAccount(rpc))
    const a = state.account
    if (a?.type === 'chatgpt') {
      const account = [a.email, a.planType].filter(Boolean).join(' · ') || 'ChatGPT'
      return { state: 'connected', detail: 'Signed in with ChatGPT', account, checkedAt }
    }
    if (a) return { state: 'connected', detail: 'Signed in to Codex', checkedAt }
    return { state: 'disconnected', detail: 'Not signed in. Sign in with ChatGPT.', checkedAt }
  }

  private async probeLiteLLM(): Promise<ConnectionStatus> {
    const conn = this.deps.settings.get().connections.litellm
    const checkedAt = this.now()
    if (!conn.baseUrl) return { state: 'disconnected', detail: 'Set the proxy base URL.', checkedAt }
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (!key) return { state: 'disconnected', detail: 'Set an API key.', checkedAt }
    const models = await fetchLiteLLMModels(conn.baseUrl, key, this.deps.fetch ?? fetch)
    return { state: 'connected', detail: `${models.length} model${models.length === 1 ? '' : 's'} available`, checkedAt }
  }

  private env(name: string): string | undefined {
    return process.env[name]?.trim() || undefined
  }

  async test(id: ConnectionId): Promise<ConnectionStatus> {
    return this.setStatus(id, await this.probe(id))
  }

  // ---------- settings records ----------

  private saveConnection(c: ProviderConnection): void {
    const current = this.deps.settings.get()
    this.deps.settings.set({ ...current, connections: { ...current.connections, [c.id]: c } })
  }

  async update(c: ProviderConnection): Promise<ConnectionInfo> {
    if (!c || !CONNECTION_IDS.includes(c.id)) throw new Error('Unknown connection')
    const old = this.deps.settings.get().connections[c.id]
    // SettingsStore.set keeps the stored hasApiKey and mirrors Anthropic auth into providerAuth.
    this.saveConnection(c)
    const fresh = this.deps.settings.get().connections[c.id]
    if (c.id === 'litellm' && fresh.id === 'litellm' && old.id === 'litellm' && fresh.baseUrl !== old.baseUrl) {
      this.setStatus('litellm', { state: 'disconnected', detail: 'Changed. Test and connect to apply.', checkedAt: this.now() })
    }
    if (!sameTiers(old.tierModels, fresh.tierModels)) {
      this.broadcastRemaps(this.remapConnectionProjects(c.id, fresh.tierModels, old.tierModels, 'tierModels'))
    }
    return this.info(c.id)
  }

  async setSecret(input: ConnectionSecretInput): Promise<ConnectionInfo> {
    if (input?.id !== 'litellm') throw new Error('Only the LiteLLM connection has a stored secret')
    const key = input.apiKey?.trim() || null
    this.deps.secrets.set(LITELLM_KEY, key)
    this.deps.settings.setLiteLLMKeyStored(!!key)
    this.setStatus('litellm', {
      state: 'disconnected',
      detail: key ? 'Key saved. Test and connect to apply.' : 'Set an API key.',
      checkedAt: this.now()
    })
    return this.info('litellm')
  }

  // ---------- connect / logout ----------

  async connect(id: ConnectionId): Promise<ConnectionInfo> {
    if (!CONNECTION_IDS.includes(id)) throw new Error('Unknown connection')
    const conn = this.deps.settings.get().connections[id]
    if (!conn.enabled) this.saveConnection({ ...conn, enabled: true } as ProviderConnection)
    this.setStatus(id, { state: 'connecting', checkedAt: this.now() })
    const status = this.setStatus(id, await this.probe(id))
    if (status.state === 'connected') {
      try {
        const found = await this.discover(id)
        const results = found ? this.applyCatalog(id, found, ['connected', 'catalog']) : this.reapplyTiers(id)
        this.broadcastRemaps(results)
      } catch (e) {
        this.setStatus(id, { state: 'error', detail: this.safeMessage(e), checkedAt: this.now() })
      }
    }
    return this.info(id)
  }

  /** No discovery (Anthropic, API-key OpenAI): still fill missing tiers from the catalog and remap. */
  private reapplyTiers(id: ConnectionId): RemapResult[] {
    const conn = this.deps.settings.get().connections[id]
    const filled = autoFillTierModels(conn.tierModels, this.catalogFor(id))
    if (!sameTiers(conn.tierModels, filled)) this.saveConnection({ ...conn, tierModels: filled } as ProviderConnection)
    return this.remapConnectionProjects(id, filled, conn.tierModels, 'connected')
  }

  async logout(id: ConnectionId): Promise<ConnectionInfo> {
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
      this.deps.secrets.delete(LITELLM_KEY)
      this.deps.settings.setLiteLLMKeyStored(false)
      this.setStatus('litellm', { state: 'disconnected', detail: 'API key removed', checkedAt })
    } else {
      this.setStatus('anthropic', { state: 'disconnected', detail: 'Marked disconnected', checkedAt })
    }
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
    const settings = this.deps.settings.get()
    const id = creationConnection(settings)
    if (id === 'anthropic') return project
    const provider = { ...project.provider, connection: id, label: connectionProviderLabel(id, settings.providerAuth) }
    return this.remapOne({ ...project, provider }, id, settings.connections[id].tierModels, undefined, 'switched').project
  }

  private withAdapter(project: Project): Project {
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
    const key = this.deps.secrets.get(LITELLM_KEY)
    if (!conn.baseUrl) throw new Error('LiteLLM has no base URL. Set it in Settings > Connections.')
    if (!key) throw new Error('LiteLLM has no API key. Set it in Settings > Connections.')
    const baseUrl = normalizeBaseUrl(conn.baseUrl)
    if (choice.adapter === 'codex') {
      return { ...base, codexAuth: 'apiKey', apiKey: key, openaiBaseUrl: `${baseUrl}/v1`, env: codexHome() }
    }
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key }
    const t = conn.tierModels
    if (t.top) env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.top
    if (t.deep) env.ANTHROPIC_DEFAULT_OPUS_MODEL = t.deep
    if (t.everyday) env.ANTHROPIC_DEFAULT_SONNET_MODEL = t.everyday
    if (t.fast) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.fast
    return { ...base, env }
  }

  /**
   * The fast-tier model for one-shot helpers (run titles) on a run's connection: the connection's tierModels.fast,
   * with 'haiku' as the Anthropic fallback. The mock adapter has none. On LiteLLM + Claude the run's env also maps
   * the haiku alias to the same model (ANTHROPIC_DEFAULT_HAIKU_MODEL).
   */
  fastModel(choice: Pick<AdapterChoice, 'adapter' | 'connection'>): string | undefined {
    if (choice.adapter === 'mock') return undefined
    const fast = this.deps.settings.get().connections[choice.connection]?.tierModels.fast?.trim()
    if (fast) return fast
    return choice.connection === 'anthropic' || choice.adapter === 'claude' ? 'haiku' : undefined
  }

  // ---------- usage, boot, shutdown ----------

  /** Codex (ChatGPT) plan limits, or null when OpenAI is off, not on a ChatGPT login or not signed in. */
  async probeCodexUsage(): Promise<UsageStatus | null> {
    const conn = this.deps.settings.get().connections.openai
    if (!conn.enabled || conn.auth.kind !== 'chatgpt') return null
    try {
      const raw = await this.withCodex(async (rpc) => ((await readAccount(rpc)).account ? readRateLimits(rpc) : null))
      return raw ? mapCodexRateLimits(raw, this.now()) : null
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
    const codex = this.codex
    this.codex = null
    this.pendingLogins.clear()
    void codex?.then((l) => {
      l.offLogin()
      l.server.close()
    }).catch(() => {})
  }
}
