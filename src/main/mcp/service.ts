import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, basename } from 'node:path'
import type {
  McpAuthStatus,
  McpAuthTarget,
  McpAuthorizeInput,
  McpCopyFromLibraryInput,
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
import { proposalSecretKey } from '@shared/types'
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
import { OAuthError, authStatusFrom, canonicalResource, onRegistrableDomain, redactOAuth, refreshTokens, runAuthorization } from './oauth'
import { LIBRARY_ID, assertValidLibraryEntry, assertValidSpec, cleanOverrides, perProjectEnvProblems, sameDefinition, validateLibraryEntry, validateSpec } from './validate'
import { CONNECTORS, connectorById, connectorVariant } from '@shared/connectors'
import {
  MOCK_CONNECTOR_ACCOUNT,
  MOCK_CONNECTOR_TOKEN,
  buildConnectorEntry,
  connectorOf,
  connectorState,
  mockConnectorTest,
  oauthPresetFor,
  tokenHeaderValue
} from './connectors'
import { insideWorkspace, removeBuildDir, rewritePath, stageBuild, type InstalledBuild } from './builds'
import { scratchDirFor } from '../quick/scratch'
import { log } from '../log'
import type { ConnectorAddInput, ConnectorInfo, ConnectorPresetRemoveInput, ConnectorState, ConnectorTokenInput, ConnectorDef, ConnectorVariant, McpProjectOverridesInput, UserConnectorDef } from '@shared/types'
import { USER_CONNECTOR_PRESETS_MAX } from '@shared/types'
import { presetVariantRefusal } from '../kit/format'
import { ConnectorPresetStore, buildPresetEntry, presetConnectorDef, validateUserPreset } from './presets'

/** Connector fields and buildDigest are written by the main process only: drop whatever an input carries. */
function noConnector<T extends { connectorId?: string; connectorVariant?: string }>(x: T): T {
  if (!x || typeof x !== 'object' || (!('connectorId' in x) && !('connectorVariant' in x) && !('connectedAt' in x) && !('buildDigest' in x) && !('connectorCustom' in x))) return x
  const { connectorId: _c, connectorVariant: _v, connectedAt: _at, buildDigest: _bd, connectorCustom: _cc, ...rest } = x as T & { connectedAt?: number; buildDigest?: string; connectorCustom?: true }
  return rest as T
}

/**
 * The per-project fields are the user's to set on a library entry (mcpLibrary:upsert) and a linked server's overrides
 * the user's to set through mcp:upsert. Proposals, installs and project-only servers never carry them: drop whatever
 * an input has. (commitEntry with applied === true then carries the stored entry's flags over.)
 */
function noProjectScope<T extends object>(x: T): T {
  if (!x || typeof x !== 'object') return x
  if (!('perProjectSecrets' in x) && !('perProjectEnv' in x) && !('envOverrides' in x) && !('headerOverrides' in x)) return x
  const { perProjectSecrets: _ps, perProjectEnv: _pe, envOverrides: _eo, headerOverrides: _ho, ...rest } = x as T & {
    perProjectSecrets?: unknown
    perProjectEnv?: unknown
    envOverrides?: unknown
    headerOverrides?: unknown
  }
  return rest as T
}

/**
 * A user upsert's per-project fields against the stored entry: perProjectSecrets true sets, false clears, absent keeps;
 * perProjectEnv an array replaces ([] clears, no empty list is stored), absent keeps. Only a literal true is stored.
 */
function mergePerProject(
  prev: McpLibraryEntry | undefined,
  incoming: McpLibraryEntry
): { perProjectSecrets?: true; perProjectEnv?: string[] } {
  const out: { perProjectSecrets?: true; perProjectEnv?: string[] } = {}
  const ps = incoming.perProjectSecrets
  if (ps === undefined ? prev?.perProjectSecrets === true : ps === true) out.perProjectSecrets = true
  const pe: unknown = incoming.perProjectEnv
  if (pe === undefined) {
    if (prev?.perProjectEnv?.length) out.perProjectEnv = [...prev.perProjectEnv]
  } else if (!Array.isArray(pe)) out.perProjectEnv = pe as string[]
  else if (pe.length) out.perProjectEnv = pe as string[]
  return out
}

/** Overrides merged over a base map; header names replace an existing header of any letter case. */
function mergeOverrides(base: Record<string, string> | undefined, overrides: Record<string, string>, headers: boolean): Record<string, string> {
  const out: Record<string, string> = { ...(base ?? {}) }
  for (const [k, v] of Object.entries(overrides)) {
    if (k === '__proto__') continue
    if (headers) for (const h of Object.keys(out)) if (h.toLowerCase() === k.toLowerCase()) delete out[h]
    out[k] = v
  }
  return out
}

/** The entry with connectedAt set to `at`, or removed when `at` is undefined. */
function withConnectedAt(entry: McpLibraryEntry, at: number | undefined): McpLibraryEntry {
  const { connectedAt: _old, ...rest } = entry
  return at === undefined ? rest : { ...rest, connectedAt: at }
}

/** The OAuth functions McpService calls; tests inject fakes. */
/**
 * Options for McpService.applyLibraryProposal. buildWorkspace: the proposing run was an allowBuild MCP assistant
 * session (RunSummary.buildWorkspace); a stdio server whose command or args point into it is copied to
 * `<data>/mcp-builds/<entryId>/` on approval and its entry gets buildDigest (review M5).
 */
export interface LibraryProposalOptions {
  buildWorkspace?: string
}

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

const SOURCES: McpServerSource[] = ['user', 'registry', 'agent', 'local']
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

/**
 * sameTarget plus the same plain env and header names and values: NODE_OPTIONS=--require, NPM_CONFIG_REGISTRY or a
 * *_PROXY change what runs or where it connects, so an approved change to them retargets the stored secrets too.
 */
function sameLaunch(a: McpServerSpec | McpLibraryEntry, b: McpServerSpec | McpLibraryEntry): boolean {
  const pairs = (r: Record<string, string> | undefined): string => JSON.stringify(Object.entries(r ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
  return sameTarget(a, b) && pairs(a.env) === pairs(b.env) && pairs(a.headers) === pairs(b.headers)
}

const isSecretKind = (k: unknown): k is 'env' | 'header' => k === 'env' || k === 'header'

/** The abort reason of a fixed-port sign-in that a newer one replaced. */
const SUPERSEDED = 'orgai:superseded-sign-in'
/** The placeholder client id older mock builds stored for DCR connectors; ignored outside mock mode. */
const MOCK_CLIENT_ID = 'mock-client'
const CLIENT_ID_MAX = 512
const CLIENT_SECRET_MAX = 4000

/** mcp:authorize input checks: one line, no control characters, bounded length. Throws a plain Error. */
function checkClientCredential(value: string, label: string, max: number): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`The ${label} must be a single line without control characters.`)
  if (value.length > max) throw new Error(`The ${label} is too long (at most ${max} characters).`)
}

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
  /** ORGAI_MOCK=1: connector entries authorize and test without network (see mockAuthorize). Never set otherwise. */
  private mock: boolean
  private dataDir?: string
  /** Custom connector presets (<data>/connector-presets.json); undefined = none available (older tests). */
  private presets?: ConnectorPresetStore
  /** One interactive authorization per owner; a new call aborts the previous. */
  private flows = new Map<string, AbortController>()
  /**
   * The pending flow on a connector's fixed loopback port (one at a time across owners): a newer one aborts it
   * with SUPERSEDED and waits for `done` (the port released) before listening.
   */
  private fixedPortFlow?: { ac: AbortController; done: Promise<void> }
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
    /** The data dir: built servers are kept in `<dataDir>/mcp-builds/<entryId>/` (index.ts passes dataDir). */
    dataDir?: string
    /** index.ts passes process.env.ORGAI_MOCK === '1': connector authorize/test then run without network. */
    mock?: boolean
    /** The custom connector preset store. Missing = one in `dataDir`, else none. */
    presets?: ConnectorPresetStore
  }) {
    this.mock = deps.mock === true
    this.dataDir = deps.dataDir
    if (!deps.dataDir) log.warn('McpService has no dataDir: built MCP servers cannot be staged and custom connector presets are unavailable (unless a presets store is passed).')
    this.presets =deps.presets ?? (deps.dataDir ? new ConnectorPresetStore(deps.dataDir) : undefined)
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

  /**
   * Whose env / header secret VALUES a server reads and writes. A linked server whose library entry (read from the
   * store, not the snapshot) sets perProjectSecrets uses this project's own keys and never the entry's (no fallback);
   * any other link uses the entry's; a project-only server its own. OAuth tokens stay with ownerOf.
   * Turning perProjectSecrets on or off keeps both stores untouched: only the active scope is read, so toggling back
   * finds the earlier values again.
   */
  private secretOwnerOf(projectId: string, spec: McpServerSpec): McpSecretOwner {
    if (spec.libraryId && this.library?.get(spec.libraryId)?.perProjectSecrets === true) return { projectId, serverId: spec.id }
    return this.ownerOf(projectId, spec)
  }

  /** The owners of every project link to an entry whose secret values live in the project scope's keys. */
  private linkOwners(libraryId: string): McpSecretOwner[] {
    const out: McpSecretOwner[] = []
    for (const p of this.projects.list()) for (const s of p.mcpServers ?? []) if (s.libraryId === libraryId) out.push({ projectId: p.id, serverId: s.id })
    return out
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

  /** A custom preset's ConnectorDef projection by id; passed to connectorOf / oauthPresetFor. */
  private customDef = (id: string): ConnectorDef | undefined => {
    const stored = this.presets?.get(id)
    return stored ? presetConnectorDef(stored) : undefined
  }

  private notifyLibrary(): void {
    if (this.onLibraryChanged) this.onLibraryChanged(this.libraryList())
  }

  private hasToken(owner: McpSecretOwner, slot: 'accessToken' | 'refreshToken' | 'clientSecret'): boolean {
    if (slot === 'accessToken' && !this.mock) return this.realAccessToken(owner) !== undefined
    return this.secrets.has(mcpOwnerOAuthKey(owner, slot))
  }

  /** The stored access token, except the ORGAI_MOCK=1 stand-in outside mock mode (a data dir shared across modes). */
  private realAccessToken(owner: McpSecretOwner): string | undefined {
    const token = this.secrets.get(mcpOwnerOAuthKey(owner, 'accessToken'))
    return token && (this.mock || token !== MOCK_CONNECTOR_TOKEN) ? token : undefined
  }

  // ---------- library ----------

  libraryEntries(): McpLibraryEntry[] {
    return this.library?.list() ?? []
  }

  private libraryInfo(entry: McpLibraryEntry, all: Project[]): McpLibraryInfo {
    const owner: McpSecretOwner = { libraryId: entry.id }
    // A per-project entry holds no env / header values of its own (projectSecrets carries the per-project state).
    const own = entry.perProjectSecrets !== true
    const envSet = own ? (entry.secretEnv ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'env', n))) : []
    const headersSet = own ? (entry.secretHeaders ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(owner, 'header', n))) : []
    const missingSecrets = own ? [...(entry.secretEnv ?? []).filter((n) => !envSet.includes(n)), ...(entry.secretHeaders ?? []).filter((n) => !headersSet.includes(n))] : []
    const projectSecrets =
      entry.perProjectSecrets === true
        ? all.flatMap((p) =>
            (p.mcpServers ?? [])
              .filter((s) => s.libraryId === entry.id)
              .map((s) => ({
                projectId: p.id,
                projectName: p.name,
                serverId: s.id,
                missingSecrets: this.slotsWithoutValue({ projectId: p.id, serverId: s.id }, entry)
              }))
          )
        : undefined
    return {
      entry,
      envSet,
      headersSet,
      missingSecrets,
      auth: this.statusFor(owner, entry.oauth),
      usedBy: all.filter((p) => p.mcpServers?.some((s) => s.libraryId === entry.id)).map((p) => ({ projectId: p.id, projectName: p.name })),
      ...(projectSecrets ? { projectSecrets } : {})
    }
  }

  /** Secret slot names (env, then headers) of a definition with no stored value under `owner`. */
  private slotsWithoutValue(owner: McpSecretOwner, spec: { secretEnv?: string[]; secretHeaders?: string[] }): string[] {
    return [
      ...(spec.secretEnv ?? []).filter((n) => !this.secrets.has(mcpOwnerSecretKey(owner, 'env', n))),
      ...(spec.secretHeaders ?? []).filter((n) => !this.secrets.has(mcpOwnerSecretKey(owner, 'header', n)))
    ]
  }

  libraryList(): McpLibraryInfo[] {
    const all = this.projects.list()
    return this.libraryEntries().map((e) => this.libraryInfo(e, all))
  }

  /** Validate and persist one entry (no broadcasts). Linked projects are re-saved by the caller. */
  private commitEntry(incoming: McpLibraryEntry, opts: { applied?: boolean; buildDigest?: string } = {}): McpLibraryEntry {
    const lib = this.lib()
    const prev = lib.get(incoming.id)
    // Link-side overrides never belong on an entry.
    const { envOverrides: _eo, headerOverrides: _ho, ...incomingEntry } = incoming as McpLibraryEntry & { envOverrides?: unknown; headerOverrides?: unknown }
    const entry: McpLibraryEntry = withOAuth({ ...noConnector(incomingEntry), source: normalSource(incoming.source) }, undefined)
    if (opts.applied !== true) {
      const merged = mergePerProject(prev, entry)
      if (merged.perProjectSecrets === true) entry.perProjectSecrets = true
      else delete entry.perProjectSecrets
      if (merged.perProjectEnv) entry.perProjectEnv = merged.perProjectEnv
      else delete entry.perProjectEnv
    }
    if (opts.applied === true) {
      // An approved proposal or install never sets or clears the per-project fields: the stored entry's stay.
      delete entry.perProjectSecrets
      delete entry.perProjectEnv
      if (prev?.perProjectSecrets === true) entry.perProjectSecrets = true
      if (prev?.perProjectEnv?.length) {
        const carried = { ...entry, perProjectEnv: [...prev.perProjectEnv] }
        // A redefinition can turn a listed name into a secret slot or change the transport: then the list goes.
        if (!perProjectEnvProblems(carried).length) entry.perProjectEnv = carried.perProjectEnv
      }
    }
    // A connector entry stays one only while it still connects exactly as its preset says.
    const keepsConnector = !!prev?.connectorId && sameDefinition(prev, entry)
    if (prev?.connectorId && keepsConnector) {
      entry.connectorId = prev.connectorId
      if (prev.connectorVariant) entry.connectorVariant = prev.connectorVariant
      if (prev.connectorCustom) entry.connectorCustom = true
      if (prev.connectedAt !== undefined) entry.connectedAt = prev.connectedAt
    }
    // buildDigest is main-only: an edit keeps it while the command and args are unchanged, else it is dropped.
    if (prev?.buildDigest && sameTarget(prev, entry)) entry.buildDigest = prev.buildDigest
    else if (opts.buildDigest) entry.buildDigest = opts.buildDigest
    const owner: McpSecretOwner = { libraryId: entry.id }
    // Turning per-project secrets on: the entry's own env / header values go (OAuth tokens stay).
    if (prev && entry.perProjectSecrets === true && prev.perProjectSecrets !== true) {
      this.secrets.deletePrefix(`${mcpOwnerPrefix(owner)}env:`)
      this.secrets.deletePrefix(`${mcpOwnerPrefix(owner)}header:`)
    }
    if (prev) {
      this.retarget(owner, prev, entry, opts.applied === true)
      // The same retarget rule for every project's own values (perProjectSecrets links): an approved launch change
      // drops them so no value follows the server to a new target. The user's own edit never clears.
      if (opts.applied === true && !sameLaunch(prev, entry)) {
        for (const lo of this.linkOwners(entry.id)) {
          this.secrets.deletePrefix(`${mcpOwnerPrefix(lo)}env:`)
          this.secrets.deletePrefix(`${mcpOwnerPrefix(lo)}header:`)
        }
      }
    }
    // An entry that stops being a connector loses the preset-made OAuth state and tokens with it.
    if (prev?.connectorId && !keepsConnector) this.secrets.deletePrefix(`${mcpOwnerPrefix(owner)}oauth:`)
    else if (prev?.oauth && sameEndpoint(prev, entry)) entry.oauth = prev.oauth
    if (prev) {
      this.dropOrphanSecrets(owner, prev, entry)
      for (const lo of this.linkOwners(entry.id)) this.dropOrphanSecrets(lo, prev, entry)
    }
    return lib.save(entry)
  }

  /**
   * An existing definition is replaced. A changed endpoint aborts the owner's in-flight authorization and drops its
   * OAuth tokens. When an approved proposal (not the user's own edit) changes where it connects or its plain env or
   * header names or values (sameLaunch), the stored env and
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
    if (!applied || sameLaunch(before, after)) return false
    const had = this.secrets.keys(`${key}env:`).length + this.secrets.keys(`${key}header:`).length > 0
    this.secrets.deletePrefix(`${key}env:`)
    this.secrets.deletePrefix(`${key}header:`)
    return had
  }

  libraryUpsert(entry: McpLibraryEntry): McpLibraryInfo[] {
    const lib = this.lib()
    const others = lib.list().filter((e) => e.id !== entry?.id)
    const prev = entry && typeof entry === 'object' ? lib.get(entry.id) : undefined
    // Validate the merged value: an omitted per-project field keeps the stored one (false clears, [] clears).
    if (entry && typeof entry === 'object') {
      const merged = mergePerProject(prev, entry)
      const next: McpLibraryEntry = { ...entry }
      if (merged.perProjectSecrets === true) next.perProjectSecrets = true
      else delete next.perProjectSecrets
      if (merged.perProjectEnv) next.perProjectEnv = merged.perProjectEnv
      else delete next.perProjectEnv
      assertValidLibraryEntry(next, others)
    } else assertValidLibraryEntry(entry, others)
    if (prev?.connectorId && !sameDefinition(prev, entry)) {
      throw new Error(`${prev.name} is a connector: its address, headers and secret slots come from the preset. Remove it and add a custom server to change them.`)
    }
    // The explicit clear values (false, []) are fine on a connector; only setting them is refused.
    if (prev?.connectorId && (entry.perProjectSecrets === true || (Array.isArray(entry.perProjectEnv) && entry.perProjectEnv.length > 0))) {
      throw new Error('Per-project values are not available for connectors yet; add a custom server instead.')
    }
    const saved = this.commitEntry(entry)
    this.relinkProjects(saved)
    this.notifyLibrary()
    return this.libraryList()
  }

  /** Delete one entry, its secrets, every link to it and the grants to those links (no broadcasts of the library). */
  private removeEntry(libraryId: string): void {
    this.lib().remove(libraryId)
    if (this.dataDir) removeBuildDir(this.dataDir, libraryId)
    this.secrets.deletePrefix(mcpLibraryPrefix(libraryId))
    this.flows.get(mcpLibraryPrefix(libraryId))?.abort()
    this.lastErrors.delete(mcpLibraryPrefix(libraryId))
    for (const p of this.projects.list()) {
      const links = (p.mcpServers ?? []).filter((s) => s.libraryId === libraryId).map((s) => s.id)
      if (!links.length) continue
      // Values a perProjectSecrets link kept in its own project scope go with the link.
      for (const id of links) this.secrets.deletePrefix(mcpSecretPrefix(p.id, id))
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

  /**
   * For the practice kit: add a library entry from a kit file (new id, source 'user', no OAuth, connector or build
   * fields), or replace `replaceId` in place (same id, links refreshed). A replace drops every stored secret value and
   * sign-in of the entry and of each project link, like an approved retarget: the user enters them again. The caller
   * has rebuilt `fields`; this validates the whole entry (names, pinned versions, hidden characters) and throws a
   * readable Error. Refuses to replace a connector entry or a built server. Returns the saved entry.
   */
  kitImportEntry(fields: Omit<McpLibraryEntry, 'id' | 'source' | 'addedAt'>, replaceId?: string): McpLibraryEntry {
    const lib = this.lib()
    const prev = replaceId === undefined ? undefined : lib.get(replaceId)
    if (replaceId !== undefined) {
      if (!prev) throw new Error('Library entry not found')
      if (prev.connectorId || prev.buildDigest) throw new Error(`${prev.name} is a connector or a built server; it cannot be replaced from a kit.`)
    }
    const entry: McpLibraryEntry = { ...fields, id: prev?.id ?? newId('mcpl'), source: 'user', addedAt: prev?.addedAt ?? new Date(this.now()).toISOString() }
    assertValidLibraryEntry(entry, lib.list().filter((e) => e.id !== entry.id))
    if (prev) {
      const owner: McpSecretOwner = { libraryId: prev.id }
      const key = mcpOwnerPrefix(owner)
      this.flows.get(key)?.abort()
      this.lastErrors.delete(key)
      this.secrets.deletePrefix(`${key}env:`)
      this.secrets.deletePrefix(`${key}header:`)
      this.secrets.deletePrefix(`${key}oauth:`)
      for (const lo of this.linkOwners(prev.id)) {
        this.secrets.deletePrefix(`${mcpOwnerPrefix(lo)}env:`)
        this.secrets.deletePrefix(`${mcpOwnerPrefix(lo)}header:`)
      }
    }
    const saved = lib.save(entry)
    if (prev) this.relinkProjects(saved)
    this.notifyLibrary()
    return saved
  }

  /**
   * For the practice kit: save a custom preset from a kit file (validated like an upsert, then marked origin 'kit').
   * Library entries already made from it are never rewritten. Throws a readable Error.
   */
  connectorPresetsKitSave(input: unknown): UserConnectorDef {
    if (!this.presets) throw new Error('Custom connectors are not available.')
    const def = validateUserPreset(typeof input === 'object' && input ? { ...(input as object), origin: 'kit' } : input, { allowOrigin: true })
    // A kit is outside input: plain values, addresses and token slot names get the same rules as an imported server.
    for (const v of def.variants) {
      const refusal = presetVariantRefusal(v)
      if (refusal) throw new Error(refusal)
    }
    if (!this.presets.get(def.id) && this.presets.list().length >= USER_CONNECTOR_PRESETS_MAX) {
      throw new Error(`You can keep at most ${USER_CONNECTOR_PRESETS_MAX} custom connectors. Remove one first.`)
    }
    const saved = this.presets.save(def)
    this.notifyLibrary()
    return saved
  }

  librarySetSecret(input: McpLibrarySecretInput): McpLibraryInfo[] {
    const entry = this.lib().get(input.libraryId)
    if (!entry) throw new Error('Library entry not found')
    if (!isSecretKind(input?.kind)) throw new Error('Unknown secret kind.')
    if (entry.perProjectSecrets === true) throw new Error(`${entry.name} keeps its secrets per project. Set them in each project's MCP servers.`)
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
    const mocked = this.mockTest(entry)
    if (mocked) return mocked
    await this.refreshIfNeeded({ libraryId: entry.id })
    if (entry.perProjectSecrets === true) {
      // The entry holds no env / header values of its own: probe without secret slots, never with stored values.
      const { secretEnv: _se, secretHeaders: _sh, ...bare } = entry
      const r = await testServer(this.resolveSpec({ libraryId: entry.id }, { ...bare, enabled: true }), 20_000, this.fetchImpl)
      return this.noteTestResult(entry, r.ok ? r : { ...r, error: `${r.error ?? 'The server did not answer.'} (This server keeps its secrets per project: test it from a project.)` })
    }
    return this.noteTestResult(entry, await testServer(this.resolveSpec({ libraryId: entry.id }, { ...entry, enabled: true }), 20_000, this.fetchImpl))
  }

  /**
   * A failed test leaves one warn line in main.log so a user's report can be matched to its cause. The probe has
   * already redacted secret values from `error`; the line never carries headers, env values or the URL.
   */
  private noteTestResult(target: { name: string; transport: string }, r: McpTestResult): McpTestResult {
    if (!r.ok && !r.needsAuthorization) {
      const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' | ').slice(0, 1000)
      log.warn(`MCP test failed for ${oneLine(target.name)} (${target.transport}): ${oneLine(r.error ?? 'no error text')}`)
    }
    return r
  }

  // ---------- project servers ----------

  private info(projectId: string, spec: McpServerSpec, missing = false): McpServerInfo {
    const owner = this.ownerOf(projectId, spec)
    const secretOwner = this.secretOwnerOf(projectId, spec)
    const envSet = (spec.secretEnv ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(secretOwner, 'env', n)))
    const headersSet = (spec.secretHeaders ?? []).filter((n) => this.secrets.has(mcpOwnerSecretKey(secretOwner, 'header', n)))
    const missingSecrets = [...(spec.secretEnv ?? []).filter((n) => !envSet.includes(n)), ...(spec.secretHeaders ?? []).filter((n) => !headersSet.includes(n))]
    const auth: McpAuthStatus = missing ? { state: spec.oauth ? 'notAuthorized' : 'notRequired' } : this.statusFor(owner, spec.oauth)
    return {
      spec,
      envSet,
      headersSet,
      missingSecrets,
      auth,
      secretScope: 'projectId' in secretOwner ? 'project' : 'library',
      ...(missing ? { libraryMissing: true as const } : {})
    }
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
      // This project's values for the names the entry lets a project override: present = replace, {} = clear,
      // absent = keep. Names outside the entry's perProjectEnv are dropped; a bad value refuses the whole save.
      const entry = this.library?.get(stored.libraryId)
      if (entry) {
        for (const [field, kind] of [['envOverrides', 'env'], ['headerOverrides', 'header']] as const) {
          const given: unknown = input.spec[field]
          if (given === undefined || given === null || typeof given !== 'object' || Array.isArray(given)) continue
          delete next[field]
          if ((entry.transport === 'stdio') !== (kind === 'env')) continue
          const cleaned = cleanOverrides(given, entry.perProjectEnv ?? [], kind)
          if (Object.keys(cleaned).length) next[field] = cleaned
        }
      }
      return this.result(this.projects.save({ ...project, mcpServers: existing.map((s) => (s.id === stored.id ? next : s)) }))
    }
    if (input.spec?.libraryId || input.spec?.source === 'library') throw new Error('Use mcp:linkLibrary to add a server from the library.')
    assertValidSpec(input.spec, existing)
    const spec: McpServerSpec = withOAuth({ ...noProjectScope(noConnector(input.spec)), source: normalSource(input.spec.source) }, undefined)
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
    // A linked server is only unlinked: its tokens (and, without perProjectSecrets, its secrets) belong to the library
    // entry. What lives under the link's own project prefix is only this project's per-project values: delete it.
    if (!spec.libraryId) this.flows.get(mcpSecretPrefix(project.id, input.serverId))?.abort()
    this.secrets.deletePrefix(mcpSecretPrefix(project.id, input.serverId))
    const roles = project.roles.map((r) => (r.mcpServers?.includes(input.serverId) ? { ...r, mcpServers: r.mcpServers.filter((id) => id !== input.serverId) } : r))
    return this.result(this.projects.save({ ...project, roles, mcpServers: existing.filter((s) => s.id !== input.serverId) }))
  }

  setSecret(input: McpSecretInput): McpMutationResult {
    const project = this.project(input.projectId)
    const spec = (project.mcpServers ?? []).find((s) => s.id === input.serverId)
    if (!spec) throw new Error('MCP server not found')
    // A link whose entry sets perProjectSecrets takes this project's own value (slots come from the entry's definition).
    const perProject = !!spec.libraryId && this.library?.get(spec.libraryId)?.perProjectSecrets === true
    if (spec.libraryId && !perProject) throw new Error(`${spec.name} comes from your MCP library. Set its secret on the library entry instead.`)
    if (!isSecretKind(input?.kind)) throw new Error('Unknown secret kind.')
    const def = perProject ? (this.library?.get(spec.libraryId!) ?? spec) : spec
    const slots = input.kind === 'env' ? def.secretEnv : def.secretHeaders
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
    const entry = spec.libraryId ? this.library?.get(spec.libraryId) : undefined
    const mocked = entry ? this.mockTest(entry) : undefined
    if (mocked) return mocked
    await this.refreshIfNeeded(this.ownerOf(input.projectId, spec))
    return this.noteTestResult(spec, await testServer(this.resolve(input.projectId, spec), 20_000, this.fetchImpl))
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
    this.removeServerSecrets(project.id, link.id)
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
    const entry = libraryEntryFromSpec({ ...noProjectScope(noConnector(spec)), source: normalSource(spec.source) }, newId('mcpl'))
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

  /**
   * mcp:copyFromLibrary: replace a linked server with a project-only copy (new id, source 'user', this project's
   * overrides baked into env / headers, enabled and roles kept, Role.mcpServers grants moved to the new id). Secrets:
   * a perProjectSecrets link moves its own project values; otherwise copySecrets copies the entry's values. OAuth is
   * never copied. New secret keys are written first, then the project is saved; a failed save deletes the new keys.
   */
  copyFromLibrary(input: McpCopyFromLibraryInput): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    const stored = existing.find((s) => s.id === input.serverId)
    if (!stored) throw new Error('MCP server not found')
    if (!stored.libraryId) throw new Error(`${stored.name} is already project-only.`)
    const entry = this.library?.get(stored.libraryId)
    if (!entry) throw new Error(`${stored.name} was removed from your MCP library.`)
    if (entry.buildDigest) throw new Error(`${stored.name} is a built server; its files live with the library entry, so it cannot be copied.`)
    const link = linkedSpec(entry, stored)
    const stdio = link.transport === 'stdio'
    const allowed = entry.perProjectEnv ?? []
    const baked = cleanOverrides(stdio ? link.envOverrides : link.headerOverrides, allowed, stdio ? 'env' : 'header')
    const {
      libraryId: _l,
      connectorId: _ci,
      connectorVariant: _cv,
      connectorCustom: _cc,
      oauth: _o,
      buildDigest: _bd,
      perProjectSecrets: _ps,
      perProjectEnv: _pe,
      envOverrides: _eo,
      headerOverrides: _ho,
      ...base
    } = link as McpServerSpec & { buildDigest?: string }
    const copy: McpServerSpec = {
      ...base,
      id: newId('mcp'),
      source: 'user',
      enabled: stored.enabled,
      ...(stored.roles ? { roles: [...stored.roles] } : {}),
      addedAt: new Date(this.now()).toISOString(),
      ...(stdio
        ? Object.keys(baked).length ? { env: mergeOverrides(base.env, baked, false) } : {}
        : Object.keys(baked).length ? { headers: mergeOverrides(base.headers, baked, true) } : {})
    }
    assertValidSpec(copy, existing.filter((s) => s.id !== stored.id))
    const from = mcpSecretPrefix(project.id, stored.id)
    const to = mcpSecretPrefix(project.id, copy.id)
    this.removeServerSecrets(project.id, copy.id)
    try {
      const source: McpSecretOwner | null = entry.perProjectSecrets === true ? { projectId: project.id, serverId: stored.id } : input.copySecrets === true ? { libraryId: entry.id } : null
      if (source) {
        const dest: McpSecretOwner = { projectId: project.id, serverId: copy.id }
        for (const n of copy.secretEnv ?? []) {
          const v = this.secrets.get(mcpOwnerSecretKey(source, 'env', n))
          if (v) this.secrets.set(mcpOwnerSecretKey(dest, 'env', n), v)
        }
        for (const n of copy.secretHeaders ?? []) {
          const v = this.secrets.get(mcpOwnerSecretKey(source, 'header', n))
          if (v) this.secrets.set(mcpOwnerSecretKey(dest, 'header', n), v)
        }
      }
    } catch (e) {
      this.secrets.deletePrefix(to)
      throw e
    }
    let out: Project
    try {
      const roles = project.roles.map((r) => (r.mcpServers?.includes(stored.id) ? { ...r, mcpServers: r.mcpServers.map((id) => (id === stored.id ? copy.id : id)) } : r))
      out = this.projects.save({ ...project, roles, mcpServers: existing.map((s) => (s.id === stored.id ? copy : s)) })
    } catch (e) {
      this.secrets.deletePrefix(to)
      throw e
    }
    // Whatever the old link kept in its own project scope has moved (or was not wanted): drop it.
    this.secrets.deletePrefix(from)
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
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
    const enteredSecret = typeof input.clientSecret === 'string' && input.clientSecret ? input.clientSecret : undefined
    checkClientCredential(clientId, 'client id', CLIENT_ID_MAX)
    if (enteredSecret) checkClientCredential(enteredSecret, 'client secret', CLIENT_SECRET_MAX)
    const key = mcpOwnerPrefix(ref.owner)
    this.flows.get(key)?.abort()
    const ac = new AbortController()
    this.flows.set(key, ac)
    let settled!: () => void
    const done = new Promise<void>((r) => (settled = r))
    const secretOf = (): string | undefined => this.secrets.get(mcpOwnerOAuthKey(ref.owner, 'clientSecret'))
    const connector = connectorOf(ref.spec, this.customDef)
    const preset = oauthPresetFor(ref.spec, this.customDef)
    try {
      if (connector?.variant.auth.kind === 'token') {
        throw new OAuthError('authorization', `${connector.def.name} uses a ${connector.variant.auth.label.toLowerCase()}, not OAuth. Paste it instead.`)
      }
      // Nothing to sign in to: answer 'notRequired' without any flow or network (the connect dialog treats it as done).
      if (connector?.variant.auth.kind === 'none') return { state: 'notRequired' }
      if (clientId || enteredSecret) {
        if (enteredSecret) this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'clientSecret'), enteredSecret)
        const cur = ref.spec.oauth
        ref.saveOAuth({
          ...(cur ?? {}),
          ...(clientId ? { clientId, clientSource: 'manual' as const } : {}),
          // A preset's issuer ties the entered client to that authorization server, so a retry can reuse it.
          // Only with 'replace': in 'fallback' discovery may name another issuer, which records its own after the flow.
          ...(clientId && preset?.issuer && preset.endpointsMode === 'replace' && !cur?.authorizationServer ? { authorizationServer: preset.issuer } : {}),
          ...(enteredSecret ? { hasClientSecret: true } : {})
        })
      }
      if (connector?.variant.auth.kind === 'oauthClient') {
        const cfg = this.refFromOwner(ref.owner)?.spec.oauth
        const needsSecret = connector.variant.auth.clientSecret === 'required'
        // A placeholder id an older mock build stored is never a real client outside mock mode.
        const realClientId = cfg?.clientId && (this.mock || cfg.clientId !== MOCK_CLIENT_ID) ? cfg.clientId : undefined
        if (!realClientId || (needsSecret && !enteredSecret && !secretOf())) {
          throw new OAuthError(
            'registration',
            `${connector.def.name} needs your own OAuth app: enter its client id${needsSecret ? ' and client secret' : ''}, then authorize again.`,
            true
          )
        }
      }
      if (this.mock && connector) return this.mockAuthorize(ref, connector.variant.auth.kind === 'oauthClient', clientId)
      if (preset?.redirectPort) {
        // One sign-in on the fixed port at a time: the newer one wins, the older resolves 'error'.
        const prev = this.fixedPortFlow
        this.fixedPortFlow = { ac, done }
        if (prev && prev.ac !== ac) {
          prev.ac.abort(SUPERSEDED)
          await prev.done
        }
        if (ac.signal.aborted) throw new OAuthError('callback', 'Authorization was cancelled.')
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
        now: this.now,
        ...(preset ? { preset } : {})
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
      this.markConnected(ref.owner, true)
      return this.statusFor(ref.owner, result.config)
    } catch (e) {
      const secrets = [enteredSecret ?? '', secretOf() ?? '']
      const cancelled = ac.signal.aborted
      const message = cancelled
        ? ac.signal.reason === SUPERSEDED
          ? 'Authorization was cancelled: another sign-in started.'
          : 'Authorization was cancelled.'
        : redactOAuth(e instanceof Error ? e.message : String(e), secrets)
      const status: McpAuthStatus = {
        state: 'error',
        error: message,
        ...(e instanceof OAuthError && e.needsClientId ? { needsClientId: true as const } : {})
      }
      if (!cancelled) this.lastErrors.set(key, status)
      return status
    } finally {
      if (this.flows.get(key) === ac) this.flows.delete(key)
      if (this.fixedPortFlow?.ac === ac) this.fixedPortFlow = undefined
      settled()
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
    this.markConnected(ref.owner, false)
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
      const preset = oauthPresetFor(ref.spec, this.customDef)
      // Defence in depth: a connector's stored token endpoint must still be on its issuer's (or its preset token
      // endpoint's) domain before the client secret is posted there; sign-in checked it, a tampered config would not.
      if (
        preset?.issuer &&
        !onRegistrableDomain(cfg.tokenEndpoint ?? '', preset.issuer) &&
        !(preset.tokenEndpoint && onRegistrableDomain(cfg.tokenEndpoint ?? '', preset.tokenEndpoint))
      ) {
        throw new Error("the stored token endpoint is not on the connector's domain; sign in again")
      }
      const tokens = await this.oauth.refreshTokens(
        cfg,
        {
          refreshToken,
          ...(clientSecret ? { clientSecret } : {}),
          ...(preset?.sendResource === false ? { sendResource: false } : {}),
          ...(preset?.tokenResponse ? { tokenResponse: preset.tokenResponse } : {})
        },
        this.fetchImpl,
        this.now
      )
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
    const token = this.realAccessToken(owner)
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

  // ---------- connectors ----------

  /**
   * A connector library entry's auth succeeded (connectedAt = now) or was cleared (connectedAt removed). Project-only
   * servers and ordinary library entries are left alone. No broadcast; the caller notifies.
   */
  private markConnected(owner: McpSecretOwner, connected: boolean): void {
    if (!('libraryId' in owner)) return
    const lib = this.library
    const entry = lib?.get(owner.libraryId)
    if (!lib || !entry?.connectorId) return
    if (!connected && entry.connectedAt === undefined) return
    lib.save(withConnectedAt(entry, connected ? this.now() : undefined))
  }

  /** The library entry made from a connector, if any (the first one; connectors:add keeps it unique). */
  private connectorEntry(connectorId: string, custom = false): McpLibraryEntry | undefined {
    return this.libraryEntries().find((e) => e.connectorId === connectorId && (e.connectorCustom === true) === custom)
  }

  /**
   * The variant an entry made from a preset connects with. Curated: the entry's variant, else the default. Custom: the
   * entry's variant while the preset still has it (the default when the entry names none), else undefined.
   */
  private entryVariant(def: ConnectorDef, entry: McpLibraryEntry, custom: boolean): ConnectorVariant | undefined {
    if (!custom) return connectorVariant(def, entry.connectorVariant)
    if (entry.connectorVariant === undefined) return connectorVariant(def)
    return def.variants.find((v) => v.id === entry.connectorVariant)
  }

  /** The card state; a custom entry whose variant left the preset is judged from the entry alone. */
  private entryState(variant: ConnectorVariant | undefined, info: McpLibraryInfo): ConnectorState {
    if (variant) return connectorState(variant, info)
    if (info.missingSecrets.length) return 'needsSetup'
    if (info.auth.state === 'error') return 'error'
    if (info.entry.oauth) return info.auth.state === 'authorized' ? 'connected' : 'needsSetup'
    // connectedAt is stamped by every successful connect (no-auth add, token set, sign-in), so an OAuth entry that was
    // never authorized (no oauth block yet) does not read as connected.
    const slots = (info.entry.secretEnv?.length ?? 0) + (info.entry.secretHeaders?.length ?? 0)
    return slots > 0 || info.entry.connectedAt !== undefined ? 'connected' : 'needsSetup'
  }

  private connectorInfo(def: ConnectorDef, entry: McpLibraryEntry | undefined, custom: boolean, all: Project[]): ConnectorInfo {
    if (!entry) return { connector: structuredClone(def), state: 'available' as const }
    const info = this.libraryInfo(entry, all)
    const variant = this.entryVariant(def, entry, custom)
    const state = this.entryState(variant, info)
    return {
      connector: structuredClone(def),
      library: info,
      variant: variant?.id ?? entry.connectorVariant,
      state,
      // Only a connected card carries it: a stale stamp (e.g. a mock sign-in seen outside mock mode) is not shown.
      ...(state === 'connected' && entry.connectedAt !== undefined ? { connectedAt: entry.connectedAt } : {})
    }
  }

  /** connectors:list: curated presets in catalog order with their library entry and gallery state, then custom presets in store order. */
  connectorsList(): ConnectorInfo[] {
    const all = this.projects.list()
    const curated = CONNECTORS.map((def) => this.connectorInfo(def, this.connectorEntry(def.id), false, all))
    const custom = (this.presets?.list() ?? []).map((preset): ConnectorInfo => ({
      ...this.connectorInfo(presetConnectorDef(preset), this.connectorEntry(preset.id, true), true, all),
      custom: true,
      preset
    }))
    return [...curated, ...custom]
  }

  // ---------- custom connector presets ----------

  /** connectorPresets:list: the stored definitions in store order. */
  connectorPresetsList(): UserConnectorDef[] {
    return this.presets?.list() ?? []
  }

  /**
   * connectorPresets:upsert: validate (validateUserPreset rebuilds every field), enforce the cap on a new id, save.
   * A library entry already made from the preset is never rewritten: it keeps its own definition and secrets.
   */
  connectorPresetsUpsert(input: unknown): UserConnectorDef[] {
    if (!this.presets) throw new Error('Custom connectors are not available.')
    const def = validateUserPreset(input)
    if (!this.presets.get(def.id) && this.presets.list().length >= USER_CONNECTOR_PRESETS_MAX) {
      throw new Error(`You can keep at most ${USER_CONNECTOR_PRESETS_MAX} custom connectors. Remove one first.`)
    }
    this.presets.save(def)
    this.notifyLibrary()
    return this.presets.list()
  }

  /** connectorPresets:remove: refused while a library entry made from the preset exists. */
  connectorPresetsRemove(input: ConnectorPresetRemoveInput): UserConnectorDef[] {
    const presets = this.presets
    const stored = typeof input?.id === 'string' ? presets?.get(input.id) : undefined
    if (!presets || !stored) throw new Error('Custom connector not found.')
    if (this.connectorEntry(stored.id, true)) throw new Error(`${stored.name} is in your MCP library. Remove it there first.`)
    presets.remove(stored.id)
    this.notifyLibrary()
    return presets.list()
  }

  /**
   * mcp:setProjectOverrides: this project's non-secret values for a linked server's perProjectEnv names. Each map given
   * replaces the stored one ({} clears it, absent keeps it), filtered and checked by cleanOverrides like mcp:upsert.
   */
  setProjectOverrides(input: McpProjectOverridesInput): McpMutationResult {
    const project = this.project(input.projectId)
    const existing = project.mcpServers ?? []
    const stored = existing.find((s) => s.id === input.serverId)
    if (!stored) throw new Error('MCP server not found')
    if (!stored.libraryId) throw new Error(`${stored.name} is project-only: edit its env and headers directly.`)
    const entry = this.library?.get(stored.libraryId)
    if (!entry) throw new Error(`${stored.name} was removed from your MCP library.`)
    const stdio = entry.transport === 'stdio'
    const next: McpServerSpec = { ...stored }
    for (const [field, kind, given] of [['envOverrides', 'env', input.env], ['headerOverrides', 'header', input.headers]] as const) {
      if (given === undefined) continue
      if (given === null || typeof given !== 'object' || Array.isArray(given)) throw new Error('The per-project values must be a list of names and values.')
      if (stdio !== (kind === 'env')) throw new Error(stdio ? 'This server takes env, not headers.' : 'This server takes headers, not env.')
      delete next[field]
      const cleaned = cleanOverrides(given, entry.perProjectEnv ?? [], kind)
      if (Object.keys(cleaned).length) next[field] = cleaned
    }
    return this.result(this.projects.save({ ...project, mcpServers: existing.map((s) => (s.id === stored.id ? next : s)) }))
  }

  /**
   * connectors:add: create the library entry from the catalog. Only the connector id and a variant id are read
   * from the input. Idempotent: an existing entry for the connector is returned unchanged, except that while it is
   * not connected a different valid `variant` rewrites it in place (same id, name, addedAt and source; the old
   * variant's stored header values, OAuth state and tokens are dropped, an in-flight authorization is aborted).
   * A connected entry (or a 'none'-auth one) keeps its variant until it is disconnected.
   */
  connectorsAdd(input: ConnectorAddInput): McpLibraryInfo {
    const curated = connectorById(input?.connectorId)
    const preset = curated ? undefined : typeof input?.connectorId === 'string' ? this.presets?.get(input.connectorId) : undefined
    const def = curated ?? (preset ? presetConnectorDef(preset) : undefined)
    if (!def) throw new Error('Unknown connector.')
    const custom = !!preset
    const build = (variant: ConnectorVariant, id: string, taken: readonly string[]): McpLibraryEntry => {
      const mine = preset?.variants.find((v) => v.id === variant.id)
      return preset && mine ? buildPresetEntry(preset, mine, id, taken, new Date(this.now())) : buildConnectorEntry(def, variant, id, taken, new Date(this.now()))
    }
    const lib = this.lib()
    const existing = this.connectorEntry(def.id, custom)
    if (existing) {
      const wanted = typeof input.variant === 'string' ? def.variants.find((v) => v.id === input.variant) : undefined
      const current = this.entryVariant(def, existing, custom)
      if (!wanted || wanted.id === existing.connectorVariant || wanted.id === current?.id) {
        return this.libraryInfo(existing, this.projects.list())
      }
      if (this.entryState(current, this.libraryInfo(existing, this.projects.list())) === 'connected') {
        return this.libraryInfo(existing, this.projects.list())
      }
      const entries = lib.list()
      const built = build(wanted, existing.id, [])
      const { url: _u, headers: _h, secretHeaders: _s, command: _cmd, args: _a, env: _e, secretEnv: _se, oauth: _o, connectedAt: _c, buildDigest: _b, ...keep } = existing
      const rewritten: McpLibraryEntry = {
        ...keep,
        transport: built.transport,
        ...(built.url !== undefined ? { url: built.url } : {}),
        ...(built.headers ? { headers: built.headers } : {}),
        ...(built.secretHeaders ? { secretHeaders: built.secretHeaders } : {}),
        ...(built.command !== undefined ? { command: built.command } : {}),
        ...(built.args ? { args: built.args } : {}),
        ...(built.env ? { env: built.env } : {}),
        ...(built.secretEnv ? { secretEnv: built.secretEnv } : {}),
        description: built.description,
        connectorVariant: built.connectorVariant
      }
      // Nothing to sign in to: connected as soon as it is the variant (as in the fresh-add path).
      const next = wanted.auth.kind === 'none' ? withConnectedAt(rewritten, this.now()) : rewritten
      assertValidLibraryEntry(next, entries.filter((e) => e.id !== existing.id))
      const key = mcpOwnerPrefix({ libraryId: existing.id })
      this.flows.get(key)?.abort()
      this.lastErrors.delete(key)
      this.secrets.deletePrefix(`${key}header:`)
      if (custom) this.secrets.deletePrefix(`${key}env:`)
      this.secrets.deletePrefix(`${key}oauth:`)
      const saved = lib.save(next)
      this.relinkProjects(saved)
      this.notifyLibrary()
      return this.libraryInfo(saved, this.projects.list())
    }
    const variant = connectorVariant(def, typeof input.variant === 'string' ? input.variant : undefined)
    const entries = lib.list()
    const built = build(variant, newId('mcpl'), entries.map((e) => e.name))
    // Nothing to sign in to: the entry is connected as soon as it exists.
    const entry = variant.auth.kind === 'none' ? withConnectedAt(built, this.now()) : built
    assertValidLibraryEntry(entry, entries)
    const saved = lib.save(entry)
    this.notifyLibrary()
    return this.libraryInfo(saved, this.projects.list())
  }

  /** connectors:setToken: store (or clear with null) a 'token' connector's secret header, prefix added. */
  connectorsSetToken(input: ConnectorTokenInput): McpLibraryInfo {
    const curated = connectorById(input?.connectorId)
    const preset = curated ? undefined : typeof input?.connectorId === 'string' ? this.presets?.get(input.connectorId) : undefined
    const def = curated ?? (preset ? presetConnectorDef(preset) : undefined)
    if (!def) throw new Error('Unknown connector.')
    const custom = !!preset
    const entry = this.connectorEntry(def.id, custom)
    if (!entry) throw new Error(`Add ${def.name} first.`)
    const variant = this.entryVariant(def, entry, custom)
    if (!variant) throw new Error(`${def.name} no longer has the variant this entry was made from. Remove it from your MCP library and add it again.`)
    const auth = variant.auth
    if (auth.kind === 'none') throw new Error(`${def.name} needs no sign-in.`)
    if (auth.kind !== 'token') throw new Error(`${def.name} signs in with OAuth; use Authorize instead.`)
    // A command (stdio) variant keeps its token in an environment variable, any other in a header.
    const slotKind = entry.transport === 'stdio' ? 'env' : 'header'
    const slots = slotKind === 'env' ? entry.secretEnv : entry.secretHeaders
    if (!(slots ?? []).includes(auth.header)) throw new Error(`${def.name} has no ${auth.header} slot. Remove it and add it again.`)
    const key = mcpOwnerSecretKey({ libraryId: entry.id }, slotKind, auth.header)
    if (input.token === null) this.secrets.delete(key)
    else if (typeof input.token === 'string') this.secrets.set(key, tokenHeaderValue(auth, input.token))
    else throw new Error('The token must be text.')
    this.markConnected({ libraryId: entry.id }, input.token !== null)
    this.notifyLibrary()
    return this.libraryInfo(this.lib().get(entry.id) ?? entry, this.projects.list())
  }

  /** ORGAI_MOCK=1 only: a connector entry's test without network; undefined otherwise. */
  private mockTest(entry: McpLibraryEntry): McpTestResult | undefined {
    if (!this.mock) return undefined
    const c = connectorOf(entry, this.customDef)
    if (!c) return undefined
    return mockConnectorTest(c.def, c.variant, this.libraryInfo(entry, this.projects.list()))
  }

  /**
   * ORGAI_MOCK=1 only: authorize a connector entry without discovery, browser or network. Stores a fake access
   * token (no refresh token, no expiry) and account mock@example.com. The entered client id was saved above.
   */
  private mockAuthorize(ref: AuthRef, manualClient: boolean, enteredClientId: string): McpAuthStatus {
    const cur = this.refFromOwner(ref.owner)?.spec.oauth
    const preset = oauthPresetFor(ref.spec, this.customDef)
    const clientId = enteredClientId || (cur?.clientId !== MOCK_CLIENT_ID ? cur?.clientId : undefined)
    const config: McpOAuthConfig = {
      resource: resourceOf(ref.spec.url),
      authorizationServer: preset?.issuer ?? 'https://mock.invalid',
      ...(preset?.scopes ? { scopes: [...preset.scopes] } : {}),
      // No placeholder client id: a fake one would pass the real preflight later.
      ...(clientId ? { clientId, clientSource: manualClient ? ('manual' as const) : ('dcr' as const) } : {}),
      hasClientSecret: !!cur?.hasClientSecret,
      authorizedAt: new Date(this.now()).toISOString(),
      account: MOCK_CONNECTOR_ACCOUNT
    }
    ref.saveOAuth(config)
    this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'accessToken'), MOCK_CONNECTOR_TOKEN)
    this.secrets.set(mcpOwnerOAuthKey(ref.owner, 'refreshToken'), null)
    this.lastErrors.delete(mcpOwnerPrefix(ref.owner))
    this.markConnected(ref.owner, true)
    return this.statusFor(ref.owner, config)
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

  /**
   * Enabled servers whose library entry (if linked) still exists and whose secret slots all hold a value, with
   * linked snapshots refreshed. A server saved with empty slots (filled in later by the user) never starts
   * without its credentials; `skippedServers` names it for the run warning.
   */
  enabledServers(project: Project): McpServerSpec[] {
    const r = this.refreshed(project)
    return (r.project.mcpServers ?? []).filter((s) => s.enabled && !r.missing.has(s.id) && !this.unsetSecretSlots(project.id, s).length)
  }

  /** Enabled, still-linked servers left out of runs because a secret slot has no value, with the unset slot names. */
  skippedServers(project: Project): { name: string; missing: string[]; scope?: 'project' }[] {
    const r = this.refreshed(project)
    return (r.project.mcpServers ?? [])
      .filter((s) => s.enabled && !r.missing.has(s.id))
      .map((s) => ({
        name: s.name,
        missing: this.unsetSecretSlots(project.id, s),
        // A linked server whose values are this project's own: the warning points at the project's MCP settings.
        ...(s.libraryId && 'projectId' in this.secretOwnerOf(project.id, s) ? { scope: 'project' as const } : {})
      }))
      .filter((s) => s.missing.length > 0)
  }

  /** Secret slot names (env, then headers) with no stored value; an empty stored value counts as unset. */
  private unsetSecretSlots(projectId: string, spec: McpServerSpec): string[] {
    const owner = this.secretOwnerOf(projectId, spec)
    return [
      ...(spec.secretEnv ?? []).filter((n) => !this.secrets.get(mcpOwnerSecretKey(owner, 'env', n))),
      ...(spec.secretHeaders ?? []).filter((n) => !this.secrets.get(mcpOwnerSecretKey(owner, 'header', n)))
    ]
  }

  /** `owner` holds OAuth tokens; `secretOwner` (default: the same) holds the env / header secret values. */
  private resolveSpec(owner: McpSecretOwner, spec: McpServerSpec, extra: Record<string, string> = {}, secretOwner: McpSecretOwner = owner): ResolvedMcpServer {
    let env: Record<string, string> = { ...(spec.env ?? {}) }
    let headers: Record<string, string> = { ...(spec.headers ?? {}) }
    // This project's plain overrides, for the names the entry lists right now; applied before the secret values.
    const entry = spec.libraryId ? this.library?.get(spec.libraryId) : undefined
    if (entry?.perProjectEnv?.length) {
      const stdio = spec.transport === 'stdio'
      const given = stdio ? spec.envOverrides : spec.headerOverrides
      for (const n of entry.perProjectEnv) {
        if (!given || !Object.hasOwn(given, n)) continue
        try {
          const one = cleanOverrides({ [n]: given[n] }, [n], stdio ? 'env' : 'header')
          if (stdio) env = mergeOverrides(env, one, false)
          else headers = mergeOverrides(headers, one, true)
        } catch {
          // Never name the value; the server name is enough to find it.
          console.warn(`MCP server "${spec.name}" has a per-project value that is not valid; it was ignored.`)
        }
      }
    }
    for (const n of spec.secretEnv ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpOwnerSecretKey(secretOwner, 'env', n))
      if (v) env[n] = v
    }
    for (const n of spec.secretHeaders ?? []) {
      const v = Object.hasOwn(extra, n) ? extra[n] : this.secrets.get(mcpOwnerSecretKey(secretOwner, 'header', n))
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
    return this.resolveSpec(this.ownerOf(projectId, current), current, extra, this.secretOwnerOf(projectId, current))
  }

  /** Save an approved install: 'project' as a project-only server, 'library' as a new library entry linked to the project. */
  persistInstall(projectId: string, spec: McpServerSpec, secrets: Record<string, string> = {}, scope: 'project' | 'library' = 'project'): Project {
    const project = this.project(projectId)
    const existing = project.mcpServers ?? []
    if (spec?.libraryId || (spec as { projectOnly?: unknown })?.projectOnly !== undefined) throw new Error('An installed server cannot carry a library link.')
    if (existing.some((s) => s.id === spec?.id) || this.library?.get(spec?.id)) throw new Error('A server with that id already exists.')
    assertValidSpec(spec, existing)
    // OAuth configs are written by the main process only, after an authorization; an install never brings one.
    const saved: McpServerSpec = withOAuth({ ...noProjectScope(noConnector(spec)), source: spec.source === 'registry' ? 'registry' : 'agent' }, undefined)
    // A new server never inherits values left under its id (a removed perProjectSecrets link's, for one).
    this.removeServerSecrets(projectId, saved.id)
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
  /** The build workspace as a genuine `<data>/quick/quick_<id>` dir, or a refusal. */
  private genuineWorkspace(workspace: string): string {
    const ws = this.dataDir ? scratchDirFor(this.dataDir, workspace) : null
    if (!ws) throw new Error('That build folder is not one OrgAI created, so its files were not saved.')
    return ws
  }

  /**
   * After an approved MCP proposal was applied: store the values the user typed on the card (ProposalDecision.secrets,
   * keyed by proposalSecretKey) for the payload's own secret slots only, under each server's owner (projectId null =
   * library session: the slot's serverId is the entry id; a project server linked to the library: its entry). Keys
   * naming no slot, empty values and multi-line header values are ignored. Returns the names of the proposal's
   * upserted servers that still have an unset slot (they do not start until the user sets it). Never throws on a
   * missing server; values never leave the SecretStore.
   */
  storeProposalSecrets(projectId: string | null, p: McpServersProposalPayload, values: Record<string, string> | undefined): string[] {
    const project = projectId === null ? null : this.refreshed(this.project(projectId)).project
    const specOf = (id: string): McpServerSpec | undefined => {
      if (project) return (project.mcpServers ?? []).find((s) => s.id === id)
      const entry = this.library?.get(id)
      return entry ? { ...entry, enabled: true } : undefined
    }
    const ownerFor = (spec: McpServerSpec): McpSecretOwner => (project ? this.secretOwnerOf(project.id, spec) : { libraryId: spec.id })
    // Only the servers this proposal adds or changes take a value: a slot naming any other stored server is dropped.
    const upserted = new Set((Array.isArray(p.upsert) ? p.upsert : []).map((u) => u?.id).filter((id): id is string => typeof id === 'string'))
    for (const slot of Array.isArray(p.secrets) ? p.secrets : []) {
      if (!values || !isSecretKind(slot?.kind) || typeof slot.serverId !== 'string' || typeof slot.name !== 'string') continue
      if (!upserted.has(slot.serverId)) {
        // installLogging routes console.warn into main.log. Names and values stay out of the line.
        console.warn('A proposal secret slot names a server the proposal does not add or change; its value was dropped.')
        continue
      }
      const key = proposalSecretKey(slot)
      const v = Object.hasOwn(values, key) ? values[key] : undefined
      if (typeof v !== 'string' || !v || (slot.kind === 'header' && /[\r\n]/.test(v))) continue
      const spec = specOf(slot.serverId)
      const slots = spec ? (slot.kind === 'env' ? spec.secretEnv : spec.secretHeaders) : undefined
      if (!spec || !slots?.includes(slot.name)) continue
      if (!project && this.library?.get(spec.id)?.perProjectSecrets === true) {
        // A per-project entry holds no values of its own: each project sets them. Names and values stay out of the line.
        console.warn('A library proposal secret was skipped: that entry keeps its secrets per project.')
        continue
      }
      this.secrets.set(mcpOwnerSecretKey(ownerFor(spec), slot.kind, slot.name), v)
    }
    if (projectId === null) this.notifyLibrary()
    const waiting: string[] = []
    for (const raw of Array.isArray(p.upsert) ? p.upsert : []) {
      const spec = typeof raw?.id === 'string' ? specOf(raw.id) : undefined
      if (!spec || !spec.enabled) continue
      if (!project && this.library?.get(spec.id)?.perProjectSecrets === true) continue
      const owner = ownerFor(spec)
      const unset = [
        ...(spec.secretEnv ?? []).filter((n) => !this.secrets.get(mcpOwnerSecretKey(owner, 'env', n))),
        ...(spec.secretHeaders ?? []).filter((n) => !this.secrets.get(mcpOwnerSecretKey(owner, 'header', n)))
      ]
      if (unset.length) waiting.push(spec.name)
    }
    return waiting
  }

  applyLibraryProposal(p: McpServersProposalPayload, opts: LibraryProposalOptions = {}): void {
    const lib = this.lib()
    const removeIds = new Set((Array.isArray(p.remove) ? p.remove : []).filter((id): id is string => typeof id === 'string'))
    let planned = lib.list().filter((e) => !removeIds.has(e.id))
    const now = new Date(this.now()).toISOString()
    const problems: string[] = []
    const commits: McpLibraryEntry[] = []
    for (const raw of Array.isArray(p.upsert) ? p.upsert : []) {
      const base = libraryEntryFromSpec({ ...noProjectScope(noConnector(raw)), enabled: true, source: normalSource(raw.source === 'library' ? 'user' : raw.source) }, raw.id)
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
    // M5: a stdio server that points into the build workspace is copied to <data>/mcp-builds/<entryId>/ first.
    const staged: Array<{ entry: McpLibraryEntry; digest: string; install: () => InstalledBuild; discard: () => void }> = []
    const installed: InstalledBuild[] = []
    try {
      if (opts.buildWorkspace !== undefined) {
        const ws = this.genuineWorkspace(opts.buildWorkspace)
        const wsKeys = [ws, ...(ws === opts.buildWorkspace ? [] : [opts.buildWorkspace])]
        for (const entry of commits) {
          if (entry.transport !== 'stdio') continue
          const inWs = (v: unknown): v is string => wsKeys.some((k) => insideWorkspace(k, v))
          if (!inWs(entry.command) && !(entry.args ?? []).some(inWs)) continue
          if (!this.dataDir) throw new Error('Built servers cannot be saved here: no data folder is configured.')
          const root = wsKeys.find((k) => inWs(entry.command) || (entry.args ?? []).some((a) => insideWorkspace(k, a))) ?? ws
          const st = stageBuild(this.dataDir, entry.id, ws)
          staged.push({ entry, digest: st.digest, install: st.install, discard: st.discard })
          const dir = join(this.dataDir, 'mcp-builds', entry.id)
          const map = (v: string): string => (insideWorkspace(root, v) ? rewritePath(root, dir, v) : v)
          const cmd = entry.command
          if (typeof cmd === 'string') entry.command = map(cmd)
          if (entry.args) entry.args = entry.args.map(map)
        }
      }
      for (const id of removeIds) if (lib.get(id)) this.removeEntry(id)
      for (const s of staged) installed.push(s.install())
      for (const entry of commits) {
        const st = staged.find((s) => s.entry === entry)
        this.relinkProjects(this.commitEntry(entry, { applied: true, ...(st ? { buildDigest: st.digest } : {}) }))
      }
    } catch (e) {
      for (const i of installed) i.rollback()
      for (const s of staged) s.discard()
      throw e
    }
    for (const i of installed) i.finish()
    this.notifyLibrary()
  }

  /**
   * Apply an approved project-scope proposal. Items with libraryId link that entry; projectOnly items stay in the
   * project; any other new server becomes a library entry and is linked under the item's id. Everything is
   * validated first; nothing is saved on any problem.
   */
  /** opts.projectOnly: every new server stays in the project, never the library (work runs, review M3). */
  applyProposal(projectId: string, p: McpServersProposalPayload, opts: { projectOnly?: boolean } = {}): Project {
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
      if (Array.isArray(raw.configOnly)) {
        // A toggle or re-grant (review L1): only the listed fields go onto the server as stored now, so an edit the
        // user made in Settings while the card was open survives approval.
        if (!current) {
          fail('that server is no longer in this project.')
          continue
        }
        put({
          ...current,
          ...(raw.configOnly.includes('enabled') ? { enabled } : {}),
          ...(raw.configOnly.includes('roles') && roles ? { roles } : {})
        })
        continue
      }
      if (current?.libraryId) {
        // A linked server: the definition belongs to the library entry, only the project-owned fields change.
        put({ ...current, enabled, ...(roles ? { roles } : {}) })
        continue
      }
      const spec: McpServerSpec = withOAuth(
        { ...noProjectScope(noConnector(raw)), enabled, ...(roles ? { roles } : {}), source: normalSource(raw.source), addedAt: current?.addedAt ?? (raw.addedAt || now) } as McpServerSpec,
        current && sameEndpoint(current, raw) ? current.oauth : undefined
      )
      delete (spec as { projectOnly?: boolean }).projectOnly
      delete spec.libraryId
      if (raw.projectOnly || opts.projectOnly || current || !lib) {
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
    // A server id the project did not hold before (new project-only servers, new links, a removed id added back) starts
    // with no stored values: nothing left under that id's prefix may be inherited.
    const heldBefore = new Set((project.mcpServers ?? []).filter((s) => !removeIds.has(s.id)).map((s) => s.id))
    for (const s of servers) if (!heldBefore.has(s.id)) this.removeServerSecrets(project.id, s.id)
    for (const entry of newEntries) lib?.save(entry)
    // A roles list on a server is the whole answer to "who can use it" (review M2): an explicit Role.mcpServers grant of
    // a role left off the list goes too, so an ungrant is never reported done while the grant still lets it through.
    const allowed = new Map<string, Set<string>>()
    for (const raw of Array.isArray(p.upsert) ? p.upsert : []) {
      const saved = servers.find((s) => s.id === raw?.id || (raw?.libraryId && s.libraryId === raw.libraryId))
      if (saved && Array.isArray(saved.roles)) allowed.set(saved.id, new Set(saved.roles))
    }
    const keeps = (r: { slug: string }, id: string): boolean => !removeIds.has(id) && (!allowed.has(id) || allowed.get(id)!.has(r.slug))
    const roles = project.roles.map((r) => (r.mcpServers?.some((id) => !keeps(r, id)) ? { ...r, mcpServers: r.mcpServers.filter((id) => keeps(r, id)) } : r))
    const saved = this.projects.save({ ...project, roles, mcpServers: servers })
    for (const [before, after] of redefined) this.retarget({ projectId: project.id, serverId: before.id }, before, after, true)
    // Linked or not: a removed server's own project values (a perProjectSecrets link keeps them there) go with it.
    for (const s of removed) this.removeServerSecrets(project.id, s.id)
    if (newEntries.length) this.notifyLibrary()
    return saved
  }
}
