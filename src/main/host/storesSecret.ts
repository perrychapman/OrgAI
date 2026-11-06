/**
 * Which host channels can store a secret value (docs/design/cli-standalone.md 5.6, Wave 7). Node and inproc hosts
 * create their vault lazily: `HostDispatcher.invokeRpc` awaits `SecretStore.prepareWrite()` before a handler runs
 * exactly when the channel's predicate is true, so handlers stay synchronous and a clear (or any call that stores
 * nothing) never creates a vault or a keychain item.
 *
 * A predicate sees the gated (shallow-validated, decoded) positional arguments and a read-only view of host state (the
 * project and library stores, SecretStore keys and status, the pending card a decision answers, what kind of sign-in an
 * authorize target has), and is true only when the call will store a non-empty value: a decision's values must name a
 * slot of its pending card, an install must be approvable (its id not taken), an authorize target must sign in with
 * OAuth. It never throws and never looks at a value beyond "is it a non-empty string" (plus the one-line checks the
 * handler applies before storing): the handler's own argument builders (host/args.ts) still validate everything. Where
 * a predicate cannot know (a validation the handler runs later) it errs towards true, and so does a host view that
 * throws: a needless prepareWrite creates a vault early, a missing one makes set() throw VaultNotReady and fails the
 * call.
 *
 * Async internal writers prepare themselves right before their set(): the OAuth authorize flow after the browser step
 * (and the mock sign-in before its synthetic token), and McpService.doRefresh (mcp:test, mcpLibrary:test, runs). The
 * channel-coverage test (secretChannels.test.ts) accepts either.
 *
 * Electron-free and light: registry.ts (and through it the CLI bundle) imports this file, so it imports shared types
 * only; the two key prefixes below mirror store/secrets.ts (a test keeps them equal).
 */
import type { McpInstallRequest, McpLibraryEntry, Project, Proposal, SecretStatus } from '../../shared/types'
import { proposalSecretKey } from '../../shared/types'

/**
 * How an mcp:authorize target signs in: 'oauth' (discovery / DCR), 'oauthClient' (the user's own client), 'token' and
 * 'none' (connectors that never take an OAuth client secret), 'stdio' (no OAuth at all). Undefined: no such target.
 */
export type AuthorizeTargetKind = 'oauth' | 'oauthClient' | 'token' | 'none' | 'stdio'

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
  /** The pending proposal card a setup:decide answers (RunManager.pendingCards), or undefined. Optional: absent = unknown. */
  pendingProposal?(runId: string, proposalId: string): Proposal | undefined
  /** The pending install card an mcp:answerInstall answers, with its run's project id, or undefined. Optional: absent = unknown. */
  pendingInstall?(runId: string, requestId: string): { request: McpInstallRequest; projectId: string } | undefined
  /** How an mcp:authorize target (its McpAuthTarget input) signs in, or undefined for no such target. Optional: absent = unknown. */
  authorizeTarget?(target: Record<string, unknown>): AuthorizeTargetKind | undefined
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

/** expectedRevision given and different from the card's (the handler then answers 'stale-revision' and stores nothing). */
const staleCard = (i: Record<string, unknown>, revision: number | undefined): boolean => {
  const expected = own(i, 'expectedRevision')
  return typeof expected === 'number' && expected !== (revision ?? 1)
}

/** A string list as the handlers accept it, else undefined. */
const stringList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined)

/**
 * setup:decide: an approval of a pending MCP proposal carrying a non-empty value for one of the card's own slots (a
 * server the proposal upserts; a header value on one line), as McpService.planProposalSecrets stores them. Values under
 * keys naming no slot, other proposal kinds, a card that is not pending and a stale revision store nothing.
 */
const proposalDecision: StoresSecretFn = (args, host) => {
  const i = first(args)
  const d = i ? own(i, 'decision') : undefined
  if (!i || !isRecord(d) || own(d, 'behavior') !== 'approve') return false
  const values = own(d, 'secrets')
  if (!anyValue(values)) return false
  const runId = own(i, 'runId')
  const proposalId = own(i, 'proposalId')
  if (!host.pendingProposal) return true
  if (typeof runId !== 'string' || typeof proposalId !== 'string') return false
  const card = host.pendingProposal(runId, proposalId)
  if (!card || card.kind !== 'mcpServers' || staleCard(i, card.revision)) return false
  const upserted = new Set((Array.isArray(card.payload.upsert) ? card.payload.upsert : []).map((u) => u?.id).filter((x): x is string => typeof x === 'string'))
  return (Array.isArray(card.payload.secrets) ? card.payload.secrets : []).some((slot) => {
    if (!slot || typeof slot.serverId !== 'string' || typeof slot.name !== 'string' || (slot.kind !== 'env' && slot.kind !== 'header')) return false
    if (!upserted.has(slot.serverId)) return false
    const v = own(values as Record<string, unknown>, proposalSecretKey(slot))
    return nonEmpty(v) && !(slot.kind === 'header' && /[\r\n]/.test(v as string))
  })
}

/**
 * mcp:answerInstall: an approval for the project or the library (a 'run' install keeps its values in memory) of a
 * pending install whose id is still free (RunManager refuses a taken one), with a non-empty value for one of the
 * server's secret names (the card's spec, or the edited spec's lists when the answer replaces them).
 */
const installAnswer: StoresSecretFn = (args, host) => {
  const i = first(args)
  const d = i ? own(i, 'decision') : undefined
  if (!i || !isRecord(d) || own(d, 'approved') !== true) return false
  const scope = own(d, 'scope')
  const values = own(d, 'secrets')
  if ((scope !== 'project' && scope !== 'library') || !anyValue(values)) return false
  if (!host.pendingInstall) return true
  const runId = own(i, 'runId')
  const requestId = own(i, 'requestId')
  if (typeof runId !== 'string' || typeof requestId !== 'string') return false
  const pending = host.pendingInstall(runId, requestId)
  if (!pending || staleCard(i, pending.request.revision)) return false
  const { request, projectId } = pending
  const edit = own(d, 'spec')
  if (edit !== undefined && (!isRecord(edit) || own(edit, 'id') !== request.spec.id)) return false
  const id = request.spec.id
  if ((host.project(projectId)?.mcpServers ?? []).some((s) => s.id === id) || host.libraryEntry(id)) return false
  // RunManager mergeInstallEdit: an edit's own list replaces the card's, an explicit undefined drops it.
  const names = (k: 'secretEnv' | 'secretHeaders'): string[] => {
    if (isRecord(edit) && Object.hasOwn(edit, k)) return edit[k] === undefined ? [] : (stringList(edit[k]) ?? request.spec[k] ?? [])
    return request.spec[k] ?? []
  }
  return [...names('secretEnv'), ...names('secretHeaders')].some((n) => nonEmpty(own(values as Record<string, unknown>, n)))
}

/** McpService checkClientCredential: one line without control characters, bounded (else the handler throws first). */
// eslint-disable-next-line no-control-regex
const oneLine = (v: string, max: number): boolean => v.length <= max && !/[\x00-\x1f\x7f]/.test(v)

/**
 * mcp:authorize: a client secret, stored before the browser opens, for a target that signs in with OAuth (never a
 * token or no-auth connector, never a stdio server: the handler refuses those before storing). The tokens are prepared
 * by the flow itself.
 */
const authorizeClientSecret: StoresSecretFn = (args, host) => {
  const i = first(args)
  if (!i) return false
  const secret = own(i, 'clientSecret')
  if (!nonEmpty(secret) || !oneLine(secret as string, 4000)) return false
  const clientId = own(i, 'clientId')
  if (typeof clientId === 'string' && !oneLine(clientId.trim(), 512)) return false
  if (!host.authorizeTarget) return true
  const kind = host.authorizeTarget(i)
  return kind === 'oauth' || kind === 'oauthClient'
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

/**
 * Never throws. The predicates read odd input without throwing (it means "stores nothing", and the handler refuses
 * it), so a throw comes from the host view; then the answer is true: preparing a vault needlessly is better than a
 * value reaching an unprepared one (VaultNotReady).
 */
function safe(fn: StoresSecretFn): StoresSecretFn {
  return (args, host) => {
    try {
      return fn(Array.isArray(args) ? args : [], host) === true
    } catch {
      return true
    }
  }
}

/**
 * The channels the spec names (5.6). An audit of every `secrets.set(` caller (McpService, ConnectionService) found no
 * other channel that stores a value: removals, revokes and kit replaces only delete, and the Team assistant saves a
 * server with a missing secret as disabled without a value.
 * - connections:setSecret, connectors:setToken: a non-empty value.
 * - mcp:setSecret, mcpLibrary:setSecret: a non-empty value.
 * - setup:decide: approving a pending MCP proposal with a non-empty value for one of its slots.
 * - mcp:answerInstall: approving a pending install (id still free) with a non-empty value for one of its secret names
 *   and a scope other than 'run'.
 * - mcp:authorize: the input carries a client secret (stored before the browser opens) for an OAuth target.
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
