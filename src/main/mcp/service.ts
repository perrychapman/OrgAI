import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, basename } from 'node:path'
import type {
  McpAuthStatus,
  McpAuthTarget,
  McpAuthorizeInput,
  McpLibraryEntry,
  McpLibraryInfo,
  McpLibrarySecretInput,
  McpLinkLibraryInput,
  McpMutationResult,
  McpOAuthConfig,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpSecretInput,
  McpServerInfo,
  McpServerSource,
  McpServerSpec,
  McpServersProposalPayload,
  McpTestResult,
  McpUpsertInput,
  PluginSpec,
  PluginUpsertInput,
  Project
} from '@shared/types'
import { MCP_OAUTH_REFRESH_SKEW_MS, libraryEntryFromSpec, linkedSpec, mcpSupportsOAuth, newId } from '@shared/defaults'
import type { ProjectStore } from '../store/projects'
import type { McpLibraryStore } from '../store/mcpLibrary'
import {
  mcpLibraryPrefix,
  mcpOwnerOAuthKey,
  mcpOwnerPrefix,
  mcpOwnerSecretKey,
  mcpProjectPrefix,
  mcpSecretPrefix,
  type McpSecretOwner,
  type SecretStore
} from '../store/secrets'
import type { ResolvedMcpServer } from '../runtime/types'
import { searchRegistry } from './registry'
import { testServer } from './probe'
import { OAuthError, authStatusFrom, canonicalResource, redactOAuth, refreshTokens, runAuthorization } from './oauth'
import { LIBRARY_ID, assertValidLibraryEntry, assertValidSpec, sameDefinition, validateLibraryEntry, validateSpec } from './validate'

/** The OAuth functions McpService calls; tests inject fakes. */
export interface McpOAuthFns {
  runAuthorization: typeof runAuthorization
  refreshTokens: typeof refreshTokens
}

/** What the OAuth methods act on: a library entry or a project-only server, with how to persist its OAuth config. */
interface AuthRef {
  owner: McpSecretOwner
  /** The definition the tokens belong to. */
  spec: McpServerSpec | McpLibraryEntry
  library: boolean
  saveOAuth(config: McpOAuthConfig | undefined): void
}

const SOURCES: McpServerSource[] = ['user', 'registry', 'agent']
const normalSource = (s: McpServerSource | undefined): McpServerSource => (s && SOURCES.includes(s) ? s : 'user')

function withOAuth<T extends { oauth?: McpOAuthConfig }>(x: T, config: McpOAuthConfig | undefined): T {
  const { oauth: _old, ...rest } = x
  return (config ? { ...rest, oauth: config } : rest) as T
}

/** Same endpoint = the stored OAuth registration still applies. */
function sameEndpoint(a: { transport: string; url?: string }, b: { transport: string; url?: string }): boolean {
  return mcpSupportsOAuth(a as McpServerSpec) && mcpSupportsOAuth(b as McpServerSpec) && (a.url ?? '').trim() === (b.url ?? '').trim()
}

/** The canonical resource of a server URL, or undefined when it is not a valid URL. */
function resourceOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return canonicalResource(url.trim())
  } catch {
    return undefined
  }
}

/** The OAuth config applies to this definition: its resource is the canonical form of the server URL. */
function oauthMatches(spec: { url?: string }, config: McpOAuthConfig | undefined): boolean {
  const r = resourceOf(spec.url)
  return !!config && !!r && config.resource === r
}

/** Where a definition connects: transport plus url, or command plus args. A change retargets its secrets. */
function sameTarget(a: McpServerSpec | McpLibraryEntry, b: McpServerSpec | McpLibraryEntry): boolean {
  if (a.transport !== b.transport) return false
  if (a.transport === 'stdio') return (a.command ?? '') === (b.command ?? '') && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
  return (a.url ?? '').trim() === (b.url ?? '').trim()
}

const isSecretKind = (k: unknown): k is 'env' | 'header' => k === 'env' || k === 'header'

/**
 * The main-process side of MCP servers, the app-wide library and OAuth: persists Project.mcpServers /
 * Project.plugins and the library, keeps secret values and tokens in the SecretStore and nowhere else, and hands
 * resolved servers to runs. The lead wires the public methods 1:1 into the mcp:*, mcpLibrary:* and plugins:* IPC
 * channels. No method returns or logs a secret value.
 */
export class McpService {
  private projects: ProjectStore
  private secrets: SecretStore
  private library?: McpLibraryStore
  private fetchImpl: typeof fetch
  private openExternal: (url: string) => Promise<void>
  private onLibraryChanged?: (entries: McpLibraryInfo[]) => void
  private onProjectChanged?: (project: Project) => void
  private oauth: McpOAuthFns
  private now: () => number
  /** One interactive authorization per owner; a new call aborts the previous. */
  private flows = new Map<string, AbortController>()
  /** In-flight refreshes per owner: refresh tokens rotate, so a second concurrent refresh would be fatal. */
  private refreshing = new Map<string, Promise<void>>()
  /** The last failed authorization per owner, shown as state 'error' until it succeeds or is revoked. */
  private lastErrors = new Map<string, McpAuthStatus>()

  constructor(deps: {
    projects: ProjectStore
    secrets: SecretStore
    /** The app-wide library store. Missing = an empty, read-only library (older tests). index.ts always passes it. */
    library?: McpLibraryStore
    fetch?: typeof fetch
    /** Opens an authorization URL in the system browser (index.ts: shell.openExternal). Tests pass a fake. */
    openExternal?: (url: string) => Promise<void>
    /** Called with the refreshed list after every library or authorization change (index.ts broadcasts it). */
    onLibraryChanged?: (entries: McpLibraryInfo[]) => void
    /** Called with each project a library change saved (unlink on remove, promote), for project.updated pushes. */
    onProjectChanged?: (project: Project) => void
    /** Tests inject fakes for the OAuth flow and refresh. */
    oauth?: Partial<McpOAuthFns>
    now?: () => number
  }) {
    this.projects = deps.projects
    this.secrets = deps.secrets
    this.library = deps.library
    this.fetchImpl = deps.fetch ?? fetch
    this.openExternal = deps.openExternal ?? (async () => { throw new Error('No browser is available to open the authorization page.') })
    this.onLibraryChanged = deps.onLibraryChanged
    this.onProjectChanged = deps.onProjectChanged
    this.oauth = { runAuthorization, refreshTokens, ...deps.oauth }
    this.now = deps.now ?? Date.now
  }

  // ---------- shared helpers ----------

  private project(projectId: string): Project {
    const p = this.projects.get(projectId)
    if (!p) throw new Error('Project not found')
    return p
  }

  private lib(): McpLibraryStore {
    if (!this.library) throw new Error('The MCP library is not available.')
    return this.library
  }

  private ownerOf(projectId: string, spec: McpServerSpec): McpSecretOwner {
    return spec.libraryId ? { libraryId: spec.libraryId } : { projectId, serverId: spec.id }
  }

  /** The project with every linked server refreshed from the library; links whose entry is gone are listed in `missing`. */
  private refreshed(project: Project): { project: Project; missing: Set<string> } {
    const missing = new Set<string>()
    if (!project.mcpServers?.some((s) => s.libraryId)) return { project, missing }
    const mcpServers = project.mcpServers.map((s) => {
      if (!s.libraryId) return s
      const entry = this.library?.get(s.libraryId)
      if (!entry) {
        missing.add(s.id)
        return s
      }
      return linkedSpec(entry, s)
    })
    return { project: { ...project, mcpServers }, missing }
  }

  /** Re-save every project that links the entry with a fresh snapshot (and tell the windows). */
  private relinkProjects(entry: McpLibraryEntry): void {
    for (const p of this.projects.list()) {
      if (!p.mcpServers?.some((s) => s.libraryId === entry.id)) continue
      const saved = this.projects.save({ ...p, mcpServers: p.mcpServers.map((s) => (s.libraryId === entry.id ? linkedSpec(entry, s) : s)) })
      this.onProjectChanged?.(saved)
    }
  }

  private notifyLibrary(): void {
    if (this.onLibraryChanged) this.onLibraryChanged(this.libraryList())
  }

  private hasToken(owner: McpSecretOwner, slot: 'accessToken' | 'refreshToken' | 'clientSecret'): boolean {
    return this.secrets.has(mcpOwnerOAuthKey(owner, slot))
  }

  // ---------- library ----------

  libraryEntries(): McpLibraryEntry[] {
    return this.library?.list() ?? []
  }

  private libraryInfo(entry: McpLibraryEntry, all: Project[]): McpLibraryInfo {
    const owner: McpSecretOwner = { libraryId: entry.id }
    const envSet = (entry.secretEnv ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'env', n)))
    const headersSet = (entry.secretHeaders ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'header', n)))
    const missingSecrets = [...(entry.secretEnv ?? []).filter((n) => !envSet.includes(n)), ...(entry.secretHeaders ?? []).filter((n) => !headersSet.includes(n))]
    return {
      entry,
      envSet,
      headersSet,
      missingSecrets,
      auth: this.statusFor(owner, entry.oauth),
      usedBy: all.filter((p) => p.mcpServers?.some((s) => s.libraryId === entry.id)).map((p) => ({ projectId: p.id, projectName: p.name }))
    }
  }

  libraryList(): McpLibraryInfo[] {
    const all = this.projects.list()
    return this.libraryEntries().map((e) => this.libraryInfo(e, all))
  }

  /** Validate and persist one entry (no broadcasts). Linked projects are re-saved by the caller. */
  private commitEntry(incoming: McpLibraryEntry, opts: { applied?: boolean } = {}): McpLibraryEntry {
    const lib = this.lib()
    const prev = lib.get(incoming.id)
    const entry: McpLibraryEntry = withOAuth({ ...incoming, source: normalSource(incoming.source) }, undefined)
    const owner: McpSecretOwner = { libraryId: entry.id }
    if (prev) this.retarget(owner, prev, entry, opts.applied === true)
    if (prev?.oauth && sameEndpoint(prev, entry)) entry.oauth = prev.oauth
    if (prev) this.dropOrphanSecrets(owner, prev, entry)
    return lib.save(entry)
  }

  /**
   * An existing definition is replaced. A changed endpoint aborts the owner's in-flight authorization and drops its
   * OAuth tokens. When an approved proposal (not the user's own edit) changes where it connects, the stored env and
   * header values are dropped too: the user re-enters them for the new target. Returns whether values were dropped.
   */
  private retarget(owner: McpSecretOwner, before: McpServerSpec | McpLibraryEntry, after: McpServerSpec | McpLibraryEntry, applied: boolean): boolean {
    const key = mcpOwnerPrefix(owner)
    if (!sameEndpoint(before, after)) {
      if (before.transport !== after.transport || (before.url ?? '').trim() !== (after.url ?? '').trim()) {
        this.flows.get(key)?.abort()
        this.lastErrors.delete(key)
      }
      if (before.oauth || this.secrets.keys(`${key}oauth:`).length) this.secrets.deletePrefix(`${key}oauth:`)
    }
    if (!applied || sameTarget(before, after)) return false
    const had = this.secrets.keys(`${key}env:`).length + this.secrets.keys(`${key}header:`).length > 0
    this.secrets.deletePrefix(`${key}env:`)
    this.secrets.deletePrefix(`${key}header:`)
    return had
  }

  libraryUpsert(entry: McpLibraryEntry): McpLibraryInfo[] {
    const lib = this.lib()
    const others = lib.list().filter((e) => e.id !== entry?.id)
    assertValidLibraryEntry(entry, others)
    const saved = this.commitEntry(entry)
    this.relinkProjects(saved)
    this.notifyLibrary()
    return this.libraryList()
  }

  /** Delete one entry, its secrets, every link to it and the grants to those links (no broadcasts of the library). */
  private removeEntry(libraryId: string): void {
    this.lib().remove(libraryId)
    this.secrets.deletePrefix(mcpLibraryPrefix(libraryId))
    this.flows.get(mcpLibraryPrefix(libraryId))?.abort()
    this.lastErrors.delete(mcpLibraryPrefix(libraryId))
    for (const p of this.projects.list()) {
      const links = (p.mcpServers ?? []).filter((s) => s.libraryId === libraryId).map((s) => s.id)
      if (!links.length) continue
      const roles = p.roles.map((r) => (r.mcpServers?.some((id) => links.includes(id)) ? { ...r, mcpServers: r.mcpServers.filter((id) => !links.includes(id)) } : r))
      const saved = this.projects.save({ ...p, roles, mcpServers: (p.mcpServers ?? []).filter((s) => s.libraryId !== libraryId) })
      this.onProjectChanged?.(saved)
    }
  }

  libraryRemove(input: { libraryId: string }): McpLibraryInfo[] {
    if (!this.lib().get(input.libraryId)) throw new Error('Library entry not found')
    this.removeEntry(input.libraryId)
    this.notifyLibrary()
    return this.libraryList()
  }

  librarySetSecret(input: McpLibrarySecretInput): McpLibraryInfo[] {
    const entry = this.lib().get(input.libraryId)
    if (!entry) throw new Error('Library entry not found')
    if (!isSecretKind(input?.kind)) throw new Error('Unknown secret kind.')
    const slots = input.kind === 'env' ? entry.secretEnv : entry.secretHeaders
    if (!slots?.includes(input.name)) throw new Error(`"${input.name}" is not a secret ${input.kind === 'env' ? 'environment variable' : 'header'} of ${entry.name}.`)
    if (typeof input.value === 'string' && input.kind === 'header' && /[\r\n]/.test(input.value)) throw new Error('A header value must be a single line.')
    this.secrets.set(mcpOwnerSecretKey({ libraryId: entry.id }, input.kind, input.name), input.value)
    this.notifyLibrary()
    return this.libraryList()
  }

  async libraryTest(input: { libraryId: string }): Promise<McpTestResult> {
    const entry = this.lib().get(input.libraryId)
    if (!entry) throw new Error('Library entry not found')
    await this.refreshIfNeeded({ libraryId: entry.id })
    return testServer(this.resolveSpec({ libraryId: entry.id }, { ...entry, enabled: true }), 20_000, this.fetchImpl)
  }

  // ---------- project servers ----------

  private info(projectId: string, spec: McpServerSpec, missing = false): McpServerInfo {
    const owner = this.ownerOf(projectId, spec)
    const envSet = (spec.secretEnv ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'env', n)))
    const headersSet = (spec.secretHeaders ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'header', n)))
    const missingSecrets = [...(spec.secretEnv ?? []).filter((n) => !envSet.includes(n)), ...(spec.secretHeaders ?? []).filter((n) => !headersSet.includes(n))]
    const auth: McpAuthStatus = missing ? { state: spec.oauth ? 'notAuthorized' : 'notRequired' } : this.statusFor(owner, spec.oauth)
    return { spec, envSet, headersSet, missingSecrets, auth, ...(missing ? { libraryMissing: true as const } : {}) }
  }

  private infos(project: Project): McpServerInfo[] {
    const r = this.refreshed(project)
    return (r.project.mcpServers ?? []).map((s) => this.info(project.id, s, r.missing.has(s.id)))
  }

  list(projectId: string): McpServerInfo[] {
    return this.infos(this.project(projectId))
  }

  private result(project: Project): McpMutationResult {
    return { project: this.refreshed(project).project, servers: this.infos(project) }
  }

  /** The project with linked snapshots refreshed from the library; links whose entry is gone are disabled in this copy. */
  withLibrary(project: Project): Project {
    const r = this.refreshed(project)
    if (!r.missing.size) return r.project
    return { ...r.project, mcpServers: (r.project.mcpServers ?? []).map((s) => (r.missing.has(s.id) ? { ...s, enabled: false } : s)) }
  }

  upsert(input: McpUpsertInput): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    const stored = existing.find((s) => s.id === input.spec?.id)
    if (stored?.libraryId) {
      // A linked server: only the project-owned fields change; edit the library entry for the rest.
      const { roles: _roles, ...base } = stored
      const next: McpServerSpec = { ...base, enabled: input.spec.enabled !== false, ...(Array.isArray(input.spec.roles) ? { roles: input.spec.roles } : {}) }
      return this.result(this.projects.save({ ...project, mcpServers: existing.map((s) => (s.id === stored.id ? next : s)) }))
    }
    if (input.spec?.libraryId || input.spec?.source === 'library') throw new Error('Use mcp:linkLibrary to add a server from the library.')
    assertValidSpec(input.spec, existing)
    const spec: McpServerSpec = withOAuth({ ...input.spec, source: normalSource(input.spec.source) }, undefined)
    if (stored) this.retarget({ projectId: project.id, serverId: stored.id }, stored, spec, false)
    if (stored?.oauth && sameEndpoint(stored, spec)) spec.oauth = stored.oauth
    const next = stored ? existing.map((s) => (s.id === spec.id ? spec : s)) : [...existing, spec]
    if (stored) this.dropOrphanSecrets({ projectId: project.id, serverId: stored.id }, stored, spec)
    return this.result(this.projects.save({ ...project, mcpServers: next }))
  }

  /** Delete stored values of secret slots an edit removed. */
  private dropOrphanSecrets(owner: McpSecretOwner, before: McpServerSpec | McpLibraryEntry, after: McpServerSpec | McpLibraryEntry): void {
    for (const n of before.secretEnv ?? []) if (!(after.secretEnv ?? []).includes(n)) this.secrets.delete(mcpOwnerSecretKey(owner, 'env', n))
    for (const n of before.secretHeaders ?? []) if (!(after.secretHeaders ?? []).includes(n)) this.secrets.delete(mcpOwnerSecretKey(owner, 'header', n))
  }

  remove(input: { projectId: string; serverId: string }): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    const spec = existing.find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    // A linked server is only unlinked: its secrets and tokens belong to the library entry.
    if (!spec.libraryId) {
      this.secrets.deletePrefix(mcpSecretPrefix(project.id, input.serverId))
      this.flows.get(mcpSecretPrefix(project.id, input.serverId))?.abort()
    }
    const roles = project.roles.map((r) => (r.mcpServers?.includes(input.serverId) ? { ...r, mcpServers: r.mcpServers.filter((id) => id !== input.serverId) } : r))
    return this.result(this.projects.save({ ...project, roles, mcpServers: existing.filter((s) => s.id !== input.serverId) }))
  }

  setSecret(input: McpSecretInput): McpMutationResult {
    const project = this.project(input.projectId)
    const spec = (project.mcpServers ?? []).find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    if (spec.libraryId) throw new Error(`${spec.name} comes from your MCP library. Set its secret on the library entry instead.`)
    if (!isSecretKind(input?.kind)) throw new Error('Unknown secret kind.')
    const slots = input.kind === 'env' ? spec.secretEnv : spec.secretHeaders
    if (!slots?.includes(input.name)) throw new Error(`"${input.name}" is not a secret ${input.kind === 'env' ? 'environment variable' : 'header'} of ${spec.name}.`)
    if (typeof input.value === 'string' && input.kind === 'header' && /[\r\n]/.test(input.value)) throw new Error('A header value must be a single line.')
    this.secrets.set(mcpOwnerSecretKey({ projectId: project.id, serverId: spec.id }, input.kind, input.name), input.value)
    return this.result(project)
  }

  /** Start the saved server (with its stored secrets) and list its tools. */
  async test(input: { projectId: string; serverId: string }): Promise<McpTestResult> {
    const project = this.refreshed(this.project(input.projectId))
    const spec = (project.project.mcpServers ?? []).find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    if (project.missing.has(spec.id)) throw new Error(`${spec.name} was removed from your MCP library.`)
    await this.refreshIfNeeded(this.ownerOf(input.projectId, spec))
    return testServer(this.resolve(input.projectId, spec), 20_000, this.fetchImpl)
  }

  registrySearch(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> {
    return searchRegistry(input, this.fetchImpl)
  }

  linkLibrary(input: McpLinkLibraryInput): McpMutationResult {
    const entry = this.lib().get(input.libraryId)
    if (!entry) throw new Error('Library entry not found')
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    if (existing.some((s) => s.libraryId === entry.id)) throw new Error(`${entry.name} is already linked to this project.`)
    const link = linkedSpec(entry, {
      id: newId('mcp'),
      enabled: input.enabled !== false,
      ...(input.roles?.length ? { roles: [...input.roles] } : {}),
      addedAt: new Date(this.now()).toISOString()
    })
    assertValidSpec(link, existing)
    return this.result(this.projects.save({ ...project, mcpServers: [...existing, link] }))
  }

  /** Move a project-only server into the library (secrets and tokens move with it) and relink it under the same id. */
  promote(input: { projectId: string; serverId: string }): McpMutationResult {
    const lib = this.lib()
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    const spec = existing.find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    if (spec.libraryId) throw new Error(`${spec.name} is already part of your MCP library.`)
    const entry = libraryEntryFromSpec({ ...spec, source: normalSource(spec.source) }, newId('mcpl'))
    assertValidLibraryEntry(entry, lib.list())
    const from = mcpSecretPrefix(project.id, spec.id)
    const to = mcpLibraryPrefix(entry.id)
    // An authorization in flight would save its tokens under the old owner: stop it.
    this.flows.get(from)?.abort()
    this.lastErrors.delete(from)
    for (const key of this.secrets.keys(from)) {
      const value = this.secrets.get(key)
      if (value !== undefined) this.secrets.set(`${to}${key.slice(from.length)}`, value)
    }
    let out: Project
    try {
      const saved = lib.save(entry)
      const link = linkedSpec(saved, spec)
      out = this.projects.save({ ...project, mcpServers: existing.map((s) => (s.id === spec.id ? link : s)) })
    } catch (e) {
      // Nothing moved: drop the copies (and the entry if it was saved) and keep the source secrets.
      this.secrets.deletePrefix(to)
      if (lib.get(entry.id)) lib.remove(entry.id)
      throw e
    }
    this.secrets.deletePrefix(from)
    this.notifyLibrary()
    return this.result(out)
  }

  // ---------- OAuth ----------

  private statusFor(owner: McpSecretOwner, config: McpOAuthConfig | undefined): McpAuthStatus {
    const base = authStatusFrom(config, { accessToken: this.hasToken(owner, 'accessToken'), refreshToken: this.hasToken(owner, 'refreshToken') }, this.now())
    const failed = this.lastErrors.get(mcpOwnerPrefix(owner))
    if (failed && (base.state === 'notAuthorized' || base.state === 'notRequired')) return { ...failed }
    return base
  }

  private libraryRef(libraryId: string): AuthRef {
    const lib = this.lib()
    const entry = lib.get(libraryId)
    if (!entry) throw new Error('Library entry not found')
    return {
      owner: { libraryId },
      spec: entry,
      library: true,
      saveOAuth: (config) => {
        const cur = lib.get(libraryId)
        if (cur) lib.save(withOAuth(cur, config))
      }
    }
  }

  private projectRef(projectId: string, serverId: string): AuthRef {
    const project = this.project(projectId)
    const spec = (project.mcpServers ?? []).find((s) => s.id === serverId)
    if (!spec) throw new Error('MCP server not found')
    if (spec.libraryId) return this.libraryRef(spec.libraryId)
    return {
      owner: { projectId, serverId },
      spec,
      library: false,
      saveOAuth: (config) => {
        const cur = this.projects.get(projectId)
        if (!cur) return
        this.projects.save({ ...cur, mcpServers: (cur.mcpServers ?? []).map((s) => (s.id === serverId ? withOAuth(s, config) : s)) })
      }
    }
  }

  private targetRef(target: McpAuthTarget): AuthRef {
    if (target && 'libraryId' in target && typeof target.libraryId === 'string') return this.libraryRef(target.libraryId)
    if (target && 'projectId' in target) return this.projectRef(target.projectId, target.serverId)
    throw new Error('Unknown authorization target.')
  }

  private refFromOwner(owner: McpSecretOwner): AuthRef | null {
    try {
      return 'libraryId' in owner ? this.libraryRef(owner.libraryId) : this.projectRef(owner.projectId, owner.serverId)
    } catch {
      return null
    }
  }

  authStatus(target: McpAuthTarget): McpAuthStatus {
    const ref = this.targetRef(target)
    return this.statusFor(ref.owner, ref.spec.oauth)
  }

  async authorize(input: McpAuthorizeInput): Promise<McpAuthStatus> {
    const ref = this.targetRef(input)
    if (!mcpSupportsOAuth(ref.spec)) throw new Error('Only http and sse servers can use OAuth.')
    const key = mcpOwnerPrefix(ref.owner)
    this.flows.get(key)?.abort()
    const ac = new AbortController()
    this.flows.set(key, ac)
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
    const enteredSecret = typeof input.clientSecret === 'string' && input.clientSecret ? input.clientSecret : undefined
    const secretOf = (): string | undefined => this.secrets.get(mcpOwnerOAuthKey(ref.owner, 'clientSecret'))
    try {
      if (clientId || enteredSecret) {
        if (enteredSecret) this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'clientSecret'), enteredSecret)
        const cur = ref.spec.oauth
        ref.saveOAuth({
          ...(cur ?? {}),
          ...(clientId ? { clientId, clientSource: 'manual' as const } : {}),
          ...(enteredSecret ? { hasClientSecret: true } : {})
        })
      }
      const config = this.refFromOwner(ref.owner)?.spec.oauth
      // Only a newly entered secret goes as clientSecret; the stored one is reused only for its own authorization server.
      const storedSecret = enteredSecret ? undefined : secretOf()
      const result = await this.oauth.runAuthorization({
        url: ref.spec.url ?? '',
        ...(config ? { config } : {}),
        ...(clientId ? { clientId } : {}),
        ...(enteredSecret ? { clientSecret: enteredSecret } : {}),
        ...(storedSecret ? { storedClientSecret: storedSecret } : {}),
        fetch: this.fetchImpl,
        openExternal: this.openExternal,
        signal: ac.signal,
        now: this.now
      })
      if (ac.signal.aborted) throw new OAuthError('callback', 'Authorization was cancelled.')
      // Re-read the owner: the entry may have been edited while the browser was open.
      const live = this.refFromOwner(ref.owner)
      if (!live) throw new OAuthError('token', 'The server was removed while it was being authorized.')
      // The URL may have changed while the browser was open: tokens for another resource are discarded.
      if (!mcpSupportsOAuth(live.spec) || resourceOf(live.spec.url) !== result.config.resource) {
        throw new OAuthError('token', 'The server address changed while it was being authorized. Authorize it again.')
      }
      live.saveOAuth({ ...result.config })
      this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'accessToken'), result.tokens.accessToken)
      this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'refreshToken'), result.tokens.refreshToken ?? null)
      if (result.clientSecret) this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'clientSecret'), result.clientSecret)
      this.lastErrors.delete(key)
      return this.statusFor(ref.owner, result.config)
    } catch (e) {
      const secrets = [enteredSecret ?? '', secretOf() ?? '']
      const cancelled = ac.signal.aborted
      const message = cancelled ? 'Authorization was cancelled.' : redactOAuth(e instanceof Error ? e.message : String(e), secrets)
      const status: McpAuthStatus = {
        state: 'error',
        error: message,
        ...(e instanceof OAuthError && e.needsClientId ? { needsClientId: true as const } : {})
      }
      if (!cancelled) this.lastErrors.set(key, status)
      return status
    } finally {
      if (this.flows.get(key) === ac) this.flows.delete(key)
      if (ref.library) this.notifyLibrary()
    }
  }

  cancelAuthorize(target: McpAuthTarget): void {
    this.flows.get(mcpOwnerPrefix(this.targetRef(target).owner))?.abort()
  }

  revokeAuth(target: McpAuthTarget): McpAuthStatus {
    const ref = this.targetRef(target)
    this.secrets.delete(mcpOwnerOAuthKey(ref.owner, 'accessToken'))
    this.secrets.delete(mcpOwnerOAuthKey(ref.owner, 'refreshToken'))
    this.lastErrors.delete(mcpOwnerPrefix(ref.owner))
    const cfg = ref.spec.oauth
    const next = cfg ? ((): McpOAuthConfig => { const { authorizedAt: _a, expiresAt: _e, account: _c, ...keep } = cfg; return keep })() : undefined
    if (next) ref.saveOAuth(next)
    if (ref.library) this.notifyLibrary()
    return this.statusFor(ref.owner, next)
  }

  /**
   * Refresh the access token when it is expired or about to be. Concurrent calls for one owner share a single
   * request (a rotated refresh token makes a second refresh fatal). Failures are logged without secrets and
   * swallowed: the server then starts without a usable token and the run warns.
   */
  refreshIfNeeded(owner: McpSecretOwner): Promise<void> {
    const key = mcpOwnerPrefix(owner)
    const running = this.refreshing.get(key)
    if (running) return running
    const p = this.doRefresh(owner).finally(() => {
      if (this.refreshing.get(key) === p) this.refreshing.delete(key)
    })
    this.refreshing.set(key, p)
    return p
  }

  private async doRefresh(owner: McpSecretOwner): Promise<void> {
    const ref = this.refFromOwner(owner)
    const cfg = ref?.spec.oauth
    if (!ref || !cfg) return
    const refreshToken = this.secrets.get(mcpOwnerOAuthKey(owner, 'refreshToken'))
    if (!refreshToken) return
    const expires = cfg.expiresAt ? Date.parse(cfg.expiresAt) : NaN
    if (!Number.isFinite(expires) || expires - this.now() > MCP_OAUTH_REFRESH_SKEW_MS) return
    const clientSecret = this.secrets.get(mcpOwnerOAuthKey(owner, 'clientSecret'))
    try {
      const tokens = await this.oauth.refreshTokens(cfg, { refreshToken, ...(clientSecret ? { clientSecret } : {}) }, this.fetchImpl, this.now)
      this.secrets.set(mcpOwnerOAuthKey(owner, 'accessToken'), tokens.accessToken)
      if (tokens.refreshToken) this.secrets.set(mcpOwnerOAuthKey(owner, 'refreshToken'), tokens.refreshToken)
      const { expiresAt: _old, ...rest } = cfg
      ref.saveOAuth({ ...rest, ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}), authorizedAt: new Date(this.now()).toISOString() })
      this.lastErrors.delete(mcpOwnerPrefix(owner))
    } catch (e) {
      const text = redactOAuth(e instanceof Error ? e.message : String(e), [refreshToken, clientSecret ?? ''])
      console.warn(`MCP OAuth refresh failed for "${ref.spec.name}": ${text}`)
    }
  }

  /** A stored access token that has not expired, or undefined. */
  private usableToken(owner: McpSecretOwner, config: McpOAuthConfig | undefined): string | undefined {
    const token = this.secrets.get(mcpOwnerOAuthKey(owner, 'accessToken'))
    if (!token) return undefined
    const expires = config?.expiresAt ? Date.parse(config.expiresAt) : NaN
    if (Number.isFinite(expires) && expires <= this.now()) return undefined
    return token
  }

  /**
   * Refresh the OAuth servers a run is about to start. Returns the names of those still without a usable token
   * (never authorized, expired with no working refresh, or a failed authorization).
   */
  async prepareForRun(projectId: string, specs: McpServerSpec[]): Promise<string[]> {
    const names: string[] = []
    for (const raw of specs) {
      const spec = this.currentSpec(raw)
      if (!spec.oauth || !mcpSupportsOAuth(spec)) continue
      const owner = this.ownerOf(projectId, spec)
      await this.refreshIfNeeded(owner)
      const cfg = this.refFromOwner(owner)?.spec.oauth ?? spec.oauth
      if (!this.usableToken(owner, cfg)) names.push(spec.name)
    }
    return names
  }

  private currentSpec(spec: McpServerSpec): McpServerSpec {
    if (!spec.libraryId) return spec
    const entry = this.library?.get(spec.libraryId)
    return entry ? linkedSpec(entry, spec) : spec
  }

  // ---------- plugins ----------

  upsertPlugin(input: PluginUpsertInput): Project {
    const project = this.project(input.projectId)
    const plugin = { ...input.plugin }
    if (typeof plugin.path !== 'string' || !isAbsolute(plugin.path)) throw new Error('The plugin path must be an absolute path.')
    const manifest = join(plugin.path, '.claude-plugin', 'plugin.json')
    if (!existsSync(manifest)) throw new Error('No plugin manifest found: expected .claude-plugin/plugin.json in that folder.')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch {
      throw new Error('The plugin manifest .claude-plugin/plugin.json is not valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The plugin manifest must be a JSON object.')
    const declared = (parsed as { name?: unknown }).name
    if (!plugin.name?.trim()) plugin.name = typeof declared === 'string' && declared.trim() ? declared.trim() : basename(plugin.path)
    const existing = project.plugins ?? []
    const idx = existing.findIndex((p) => p.id === plugin.id)
    const next: PluginSpec[] = idx === -1 ? [...existing, plugin] : existing.map((p, i) => (i === idx ? plugin : p))
    return this.projects.save({ ...project, plugins: next })
  }

  removePlugin(input: { projectId: string; pluginId: string }): Project {
    const project = this.project(input.projectId)
    return this.projects.save({ ...project, plugins: (project.plugins ?? []).filter((p) => p.id !== input.pluginId) })
  }

  /** Forget every stored secret of one project-only server. */
  removeServerSecrets(projectId: string, serverId: string): void {
    this.flows.get(mcpSecretPrefix(projectId, serverId))?.abort()
    this.secrets.deletePrefix(mcpSecretPrefix(projectId, serverId))
  }

  /** The project is being deleted: forget every secret of its MCP servers (library entries keep theirs). */
  removeProjectSecrets(projectId: string): void {
    this.secrets.deletePrefix(mcpProjectPrefix(projectId))
  }

  // ---------- for RunManager ----------

  /** Enabled servers whose library entry (if linked) still exists, with linked snapshots refreshed. */
  enabledServers(project: Project): McpServerSpec[] {
    const r = this.refreshed(project)
    return (r.project.mcpServers ?? []).filter((s) => s.enabled && !r.missing.has(s.id))
  }

  private resolveSpec(owner: McpSecretOwner, spec: McpServerSpec, extra: Record<string, string> = {}): ResolvedMcpServer {
    const env: Record<string, string> = { ...(spec.env ?? {}) }
    const headers: Record<string, string> = { ...(spec.headers ?? {}) }
    for (const n of spec.secretEnv ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpOwnerSecretKey(owner, 'env', n))
      if (v) env[n] = v
    }
    for (const n of spec.secretHeaders ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpOwnerSecretKey(owner, 'header', n))
      if (v) headers[n] = v
    }
    if (spec.oauth && mcpSupportsOAuth(spec) && oauthMatches(spec, spec.oauth)) {
      const token = this.usableToken(owner, spec.oauth)
      if (token) {
        for (const h of Object.keys(headers)) if (h.toLowerCase() === 'authorization') delete headers[h]
        headers.Authorization = `Bearer ${token}`
      }
    }
    return { spec, env, headers }
  }

  /**
   * The spec with secret values filled in from the SecretStore. `extra` holds run-scoped values by slot
   * name (a server approved for this run only); it wins over stored values. A linked server uses its library
   * entry's definition, secrets and OAuth token.
   */
  resolve(projectId: string, spec: McpServerSpec, extra: Record<string, string> = {}): ResolvedMcpServer {
    const current = this.currentSpec(spec)
    return this.resolveSpec(this.ownerOf(projectId, current), current, extra)
  }

  /** Save an approved install: 'project' as a project-only server, 'library' as a new library entry linked to the project. */
  persistInstall(projectId: string, spec: McpServerSpec, secrets: Record<string, string> = {}, scope: 'project' | 'library' = 'project'): Project {
    const project = this.project(projectId)
    const existing = project.mcpServers ?? []
    if (spec?.libraryId || (spec as { projectOnly?: unknown })?.projectOnly !== undefined) throw new Error('An installed server cannot carry a library link.')
    if (existing.some((s) => s.id === spec?.id) || this.library?.get(spec?.id)) throw new Error('A server with that id already exists.')
    assertValidSpec(spec, existing)
    // OAuth configs are written by the main process only, after an authorization; an install never brings one.
    const saved: McpServerSpec = withOAuth({ ...spec, source: spec.source === 'registry' ? 'registry' : 'agent' }, undefined)
    if (scope === 'library') {
      const lib = this.lib()
      const entry = libraryEntryFromSpec(saved, newId('mcpl'))
      assertValidLibraryEntry(entry, lib.list())
      const owner: McpSecretOwner = { libraryId: entry.id }
      lib.save(entry)
      const link = linkedSpec(entry, { id: saved.id, enabled: saved.enabled, ...(saved.roles ? { roles: saved.roles } : {}), addedAt: saved.addedAt })
      let out: Project
      try {
        out = this.projects.save({ ...project, mcpServers: [...existing, link] })
      } catch (e) {
        lib.remove(entry.id)
        throw e
      }
      // Secrets only after both saves, so a failed save leaves none behind.
      for (const n of entry.secretEnv ?? []) if (secrets[n]) this.secrets.set(mcpOwnerSecretKey(owner, 'env', n), secrets[n])
      for (const n of entry.secretHeaders ?? []) if (secrets[n]) this.secrets.set(mcpOwnerSecretKey(owner, 'header', n), secrets[n])
      this.notifyLibrary()
      return out
    }
    const owner: McpSecretOwner = { projectId, serverId: saved.id }
    const out = this.projects.save({ ...project, mcpServers: [...existing, saved] })
    for (const n of saved.secretEnv ?? []) if (secrets[n]) this.secrets.set(mcpOwnerSecretKey(owner, 'env', n), secrets[n])
    for (const n of saved.secretHeaders ?? []) if (secrets[n]) this.secrets.set(mcpOwnerSecretKey(owner, 'header', n), secrets[n])
    return out
  }

  // ---------- applying MCP proposals (SetupService) ----------

  /**
   * Apply an approved library-scope proposal (the harness-level assistant): upsert entries (matched by id, else by
   * name) and remove entries by id. Everything is validated first; nothing is saved on any problem.
   */
  applyLibraryProposal(p: McpServersProposalPayload): void {
    const lib = this.lib()
    const removeIds = new Set((Array.isArray(p.remove) ? p.remove : []).filter((id): id is string => typeof id === 'string'))
    let planned = lib.list().filter((e) => !removeIds.has(e.id))
    const now = new Date(this.now()).toISOString()
    const problems: string[] = []
    const commits: McpLibraryEntry[] = []
    for (const raw of Array.isArray(p.upsert) ? p.upsert : []) {
      const base = libraryEntryFromSpec({ ...raw, enabled: true, source: normalSource(raw.source === 'library' ? 'user' : raw.source) }, raw.id)
      const match = planned.find((e) => e.id === raw.id) ?? planned.find((e) => e.name === raw.name)
      const id = match?.id ?? (typeof raw.id === 'string' && LIBRARY_ID.test(raw.id) ? raw.id : newId('mcpl'))
      const entry: McpLibraryEntry = withOAuth({ ...base, id, addedAt: match?.addedAt ?? (raw.addedAt || now) }, undefined)
      const errors = validateLibraryEntry(entry, planned.filter((e) => e.id !== id))
      if (errors.length) {
        problems.push(`${typeof raw.name === 'string' ? raw.name : 'server'}: ${errors.join(' ')}`)
        continue
      }
      planned = planned.some((e) => e.id === id) ? planned.map((e) => (e.id === id ? entry : e)) : [...planned, entry]
      commits.push(entry)
    }
    if (problems.length) throw new Error(`Invalid MCP server: ${problems.join(' ')}`)
    for (const id of removeIds) if (lib.get(id)) this.removeEntry(id)
    for (const entry of commits) this.relinkProjects(this.commitEntry(entry, { applied: true }))
    this.notifyLibrary()
  }

  /**
   * Apply an approved project-scope proposal. Items with libraryId link that entry; projectOnly items stay in the
   * project; any other new server becomes a library entry and is linked under the item's id. Everything is
   * validated first; nothing is saved on any problem.
   */
  applyProposal(projectId: string, p: McpServersProposalPayload): Project {
    if (p.scope === 'library') throw new Error('A library proposal cannot be applied to a project.')
    const lib = this.library
    const project = this.project(projectId)
    const removeIds = new Set((Array.isArray(p.remove) ? p.remove : []).filter((id): id is string => typeof id === 'string'))
    const removed = (project.mcpServers ?? []).filter((s) => removeIds.has(s.id))
    let servers = (project.mcpServers ?? []).filter((s) => !removeIds.has(s.id))
    let entries = lib?.list() ?? []
    const newEntries: McpLibraryEntry[] = []
    /** Project-only servers this proposal redefines: [before, after]. */
    const redefined: Array<[McpServerSpec, McpServerSpec]> = []
    const problems: string[] = []
    const now = new Date(this.now()).toISOString()
    const put = (s: McpServerSpec): void => {
      servers = servers.some((x) => x.id === s.id) ? servers.map((x) => (x.id === s.id ? s : x)) : [...servers, s]
    }
    for (const raw of Array.isArray(p.upsert) ? p.upsert : []) {
      const label = typeof raw?.name === 'string' && raw.name ? raw.name : (raw?.libraryId ?? 'server')
      const fail = (msg: string): void => void problems.push(`${label}: ${msg}`)
      const roles = Array.isArray(raw.roles) ? raw.roles : undefined
      const enabled = raw.enabled !== false
      if (raw.libraryId) {
        const entry = entries.find((e) => e.id === raw.libraryId)
        if (!entry) {
          fail('that library entry does not exist.')
          continue
        }
        const link = servers.find((s) => s.libraryId === entry.id)
        if (link) {
          put({ ...link, enabled, ...(roles ? { roles } : {}) })
          continue
        }
        const id = typeof raw.id === 'string' && raw.id && !servers.some((s) => s.id === raw.id) ? raw.id : newId('mcp')
        const spec = linkedSpec(entry, { id, enabled, ...(roles ? { roles } : {}), addedAt: now })
        const errors = validateSpec(spec, servers)
        if (errors.length) fail(errors.join(' '))
        else put(spec)
        continue
      }
      const current = servers.find((s) => s.id === raw.id)
      if (current?.libraryId) {
        // A linked server: the definition belongs to the library entry, only the project-owned fields change.
        put({ ...current, enabled, ...(roles ? { roles } : {}) })
        continue
      }
      const spec: McpServerSpec = withOAuth(
        { ...raw, enabled, ...(roles ? { roles } : {}), source: normalSource(raw.source), addedAt: current?.addedAt ?? (raw.addedAt || now) } as McpServerSpec,
        current && sameEndpoint(current, raw) ? current.oauth : undefined
      )
      delete (spec as { projectOnly?: boolean }).projectOnly
      delete spec.libraryId
      if (raw.projectOnly || current || !lib) {
        const errors = validateSpec(spec, servers.filter((s) => s.id !== spec.id))
        if (errors.length) fail(errors.join(' '))
        else {
          put(spec)
          if (current) redefined.push([current, spec])
        }
        continue
      }
      // A new server: save it to the library and link it under the item's id (proposal secrets refer to that id).
      const errors = validateSpec(spec, servers.filter((s) => s.id !== spec.id))
      if (errors.length) {
        fail(errors.join(' '))
        continue
      }
      const candidate = libraryEntryFromSpec(spec, newId('mcpl'))
      const same = entries.find((e) => e.name === candidate.name)
      let entry = candidate
      if (same) {
        if (!sameDefinition(same, candidate)) {
          fail(`the MCP library already has a different "${candidate.name}". Link it with libraryId, or mark this server projectOnly.`)
          continue
        }
        entry = same
      } else {
        const libErrors = validateLibraryEntry(candidate, entries)
        if (libErrors.length) {
          fail(libErrors.join(' '))
          continue
        }
        entries = [...entries, candidate]
        newEntries.push(candidate)
      }
      const link = linkedSpec(entry, { id: spec.id, enabled, ...(roles ? { roles } : {}), addedAt: spec.addedAt })
      put(link)
    }
    if (problems.length) throw new Error(`Invalid MCP server: ${problems.join(' ')}`)
    for (const entry of newEntries) lib?.save(entry)
    const roles = project.roles.map((r) => (r.mcpServers?.some((id) => removeIds.has(id)) ? { ...r, mcpServers: r.mcpServers.filter((id) => !removeIds.has(id)) } : r))
    const saved = this.projects.save({ ...project, roles, mcpServers: servers })
    for (const [before, after] of redefined) this.retarget({ projectId: project.id, serverId: before.id }, before, after, true)
    for (const s of removed) if (!s.libraryId) this.removeServerSecrets(project.id, s.id)
    if (newEntries.length) this.notifyLibrary()
    return saved
  }
}
