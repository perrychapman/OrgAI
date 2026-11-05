/**
 * Which host channels can store a secret value (docs/design/cli-standalone.md 5.6, Wave 7). Node and inproc hosts
 * create their vault lazily: `HostDispatcher.invokeRpc` awaits `SecretStore.prepareWrite()` before a handler runs
 * exactly when the channel's predicate is true, so handlers stay synchronous and a clear (or any call that stores
 * nothing) never creates a vault or a keychain item.
 *
 * A predicate sees the gated (shallow-validated, decoded) positional arguments and a read-only view of host state, and
 * is true only when the call will store a non-empty value. It never throws and never looks at a value beyond "is it a
 * non-empty string": the handler's own argument builders (host/args.ts) still validate everything. Where a predicate
 * cannot know (a pending card's slots, a refusal later in the handler) it errs towards true: a needless prepareWrite
 * creates a vault early, a missing one makes set() throw VaultNotReady.
 *
 * Async internal writers prepare themselves right before their set(): the OAuth authorize flow after the browser step
 * (and the mock sign-in before its synthetic token), and McpService.doRefresh (mcp:test, mcpLibrary:test, runs). The
 * channel-coverage test (secretChannels.test.ts) accepts either.
 *
 * Electron-free and light: registry.ts (and through it the CLI bundle) imports this file, so it imports shared types
 * only; the two key prefixes below mirror store/secrets.ts (a test keeps them equal).
 */
import type { McpLibraryEntry, Project, SecretStatus } from '../../shared/types'

/** Read-only host state a predicate may look at (never a secret value). */
export interface StoresSecretHostView {
  /** A stored project, or null. */
  project(projectId: string): Project | null
  /** A library entry, or undefined. */
  libraryEntry(entryId: string): McpLibraryEntry | undefined
  /** SecretStore.keys(prefix). */
  secretKeys(prefix?: string): string[]
  /** SecretStore.status(key): promote / copy carry only readable secrets (an unreadable source makes the handler refuse). */
  secretStatus(key: string): SecretStatus
}

/** True when this call will store a non-empty secret value. Pure: no side effects, never throws on odd input. */
export type StoresSecretFn = (args: readonly unknown[], host: StoresSecretHostView) => boolean

/** store/secrets.ts mcpSecretPrefix (a project-only server, or a link's per-project values). */
export function projectServerSecretPrefix(projectId: string, serverId: string): string {
  return `mcp:${projectId}:${serverId}:`
}

/** store/secrets.ts mcpLibraryPrefix. */
export function librarySecretPrefix(entryId: string): string {
  return `mcplib:${entryId}:`
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (r: Record<string, unknown>, k: string): unknown => (Object.hasOwn(r, k) ? r[k] : undefined)
const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== ''
const nonBlank = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''
const first = (args: readonly unknown[]): Record<string, unknown> | undefined => (isRecord(args[0]) ? args[0] : undefined)
/** Some own value of a plain object is a non-empty string. */
const anyValue = (v: unknown): boolean => isRecord(v) && Object.keys(v).some((k) => nonEmpty(v[k]))

/**
 * Whether carrying the keys a move would read stores a value: false when any of them is unreadable here (the handler
 * then refuses before changing anything, 5.4) or none is set; true when at least one is readable.
 */
function carriesReadable(keys: readonly string[], host: StoresSecretHostView): boolean {
  let readable = false
  for (const k of keys) {
    const s = host.secretStatus(k)
    if (typeof s === 'object') return false
    if (s === 'set') readable = true
  }
  return readable
}

/** connections:setSecret: the LiteLLM key, trimmed, non-empty (the service trims; '' or null clears). */
const connectionSecret: StoresSecretFn = (args) => {
  const i = first(args)
  return !!i && own(i, 'id') === 'litellm' && nonBlank(own(i, 'apiKey'))
}

/** connectors:setToken: a token string with something left after trimming (null clears; '' is refused by the service). */
const connectorToken: StoresSecretFn = (args) => {
  const i = first(args)
  return !!i && nonBlank(own(i, 'token'))
}

/** mcp:setSecret / mcpLibrary:setSecret: a non-empty value (null or '' deletes). */
const slotValue: StoresSecretFn = (args) => {
  const i = first(args)
  return !!i && nonEmpty(own(i, 'value'))
}

/** setup:decide: an approval carrying at least one non-empty secret value (only MCP proposals take them). */
const proposalDecision: StoresSecretFn = (args) => {
  const i = first(args)
  const d = i ? own(i, 'decision') : undefined
  return isRecord(d) && own(d, 'behavior') === 'approve' && anyValue(own(d, 'secrets'))
}

/** mcp:answerInstall: an approval for the project or the library (a 'run' install keeps its values in memory). */
const installAnswer: StoresSecretFn = (args) => {
  const i = first(args)
  const d = i ? own(i, 'decision') : undefined
  if (!isRecord(d) || own(d, 'approved') !== true) return false
  const scope = own(d, 'scope')
  return (scope === 'project' || scope === 'library') && anyValue(own(d, 'secrets'))
}

/** mcp:authorize: a client secret, stored before the browser opens. The tokens are prepared by the flow itself. */
const authorizeClientSecret: StoresSecretFn = (args) => {
  const i = first(args)
  return !!i && nonEmpty(own(i, 'clientSecret'))
}

/** mcp:promote: a project-only server whose own keys (env, header and OAuth) hold a readable value. */
const promote: StoresSecretFn = (args, host) => {
  const i = first(args)
  const projectId = i ? own(i, 'projectId') : undefined
  const serverId = i ? own(i, 'serverId') : undefined
  if (typeof projectId !== 'string' || typeof serverId !== 'string') return false
  const spec = (host.project(projectId)?.mcpServers ?? []).find((s) => s.id === serverId)
  if (!spec || spec.libraryId) return false
  return carriesReadable(host.secretKeys(projectServerSecretPrefix(projectId, serverId)), host)
}

/**
 * mcp:copyFromLibrary: the slots the copy takes values for. A perProjectSecrets link always moves this project's own
 * values (whatever copySecrets says); any other link copies the entry's values only with copySecrets.
 */
const copyFromLibrary: StoresSecretFn = (args, host) => {
  const i = first(args)
  const projectId = i ? own(i, 'projectId') : undefined
  const serverId = i ? own(i, 'serverId') : undefined
  if (!i || typeof projectId !== 'string' || typeof serverId !== 'string') return false
  const stored = (host.project(projectId)?.mcpServers ?? []).find((s) => s.id === serverId)
  if (!stored?.libraryId) return false
  const entry = host.libraryEntry(stored.libraryId)
  if (!entry || entry.buildDigest) return false
  const prefix = entry.perProjectSecrets === true ? projectServerSecretPrefix(projectId, serverId) : own(i, 'copySecrets') === true ? librarySecretPrefix(entry.id) : null
  if (!prefix) return false
  const keys = [...(entry.secretEnv ?? []).map((n) => `${prefix}env:${n}`), ...(entry.secretHeaders ?? []).map((n) => `${prefix}header:${n}`)]
  return carriesReadable(keys, host)
}

/** Never throws: an odd input (or a host view that throws) means "stores nothing"; the handler refuses it anyway. */
function safe(fn: StoresSecretFn): StoresSecretFn {
  return (args, host) => {
    try {
      return fn(Array.isArray(args) ? args : [], host) === true
    } catch {
      return false
    }
  }
}

/**
 * The channels the spec names (5.6). An audit of every `secrets.set(` caller (McpService, ConnectionService) found no
 * other channel that stores a value: removals, revokes and kit replaces only delete, and the Team assistant saves a
 * server with a missing secret as disabled without a value.
 * - connections:setSecret, connectors:setToken: a non-empty value.
 * - mcp:setSecret, mcpLibrary:setSecret: a non-empty value.
 * - setup:decide: approving with non-empty `secrets` (an MCP proposal; other kinds carry none).
 * - mcp:answerInstall: approving with non-empty `secrets` and a scope other than 'run'.
 * - mcp:authorize: the input carries a client secret (stored before the browser opens).
 * - mcp:promote, mcp:copyFromLibrary: the source holds a readable secret (per-project values included, whatever
 *   copySecrets says); an unreadable carried slot makes the predicate false and the handler refuse.
 */
export const STORES_SECRET: Readonly<Record<string, StoresSecretFn>> = {
  'connections:setSecret': safe(connectionSecret),
  'connectors:setToken': safe(connectorToken),
  'mcp:setSecret': safe(slotValue),
  'mcpLibrary:setSecret': safe(slotValue),
  'setup:decide': safe(proposalDecision),
  'mcp:answerInstall': safe(installAnswer),
  'mcp:authorize': safe(authorizeClientSecret),
  'mcp:promote': safe(promote),
  'mcp:copyFromLibrary': safe(copyFromLibrary)
}
