import { isBuiltinConnectionId, isProxyConnection } from '@shared/types'
import type { ConnectionId, ConnectionInfo } from '@shared/types'

const BUILTIN_NAME: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

/** Shown for a proxy id that is no longer in the list (a removed proxy named by an old run, usage row or project). */
export const REMOVED_PROXY_LABEL = 'Removed proxy'

/**
 * The renderer's copy of the connection list, fed by the store (it subscribes in useAppStore.ts), so the pure label
 * helpers below can name a proxy without a React hook. null = not loaded yet.
 */
let registry: ReadonlyMap<string, ConnectionInfo> | null = null
export function setConnectionRegistry(list: readonly ConnectionInfo[] | null | undefined): void {
  registry = list ? new Map(list.map((c) => [c.connection.id, c])) : null
}

/**
 * THE name of a connection, used by every surface (never write "LiteLLM" for a proxy): Anthropic, OpenAI, a proxy's
 * own name, "Removed proxy" for a proxy id that is not in the loaded list, "Proxy" before the list has loaded.
 */
export function connectionLabel(id: ConnectionId | null | undefined): string {
  if (!id) return 'No connection'
  if (isBuiltinConnectionId(id)) return BUILTIN_NAME[id]
  const c = registry?.get(id)?.connection
  if (c && isProxyConnection(c)) return c.name
  return registry ? REMOVED_PROXY_LABEL : 'Proxy'
}

/** The kind in words, for a badge: "Anthropic", "OpenAI", "LiteLLM proxy", "OpenAI-compatible proxy". */
export function connectionKindLabel(c: ConnectionInfo['connection'] | undefined | null): string {
  if (!c) return 'Proxy'
  if (isProxyConnection(c)) return c.kind === 'litellm' ? 'LiteLLM proxy' : 'OpenAI-compatible proxy'
  return BUILTIN_NAME[c.id] ?? c.id
}

/** True when the id is a proxy (anything but the two built-ins). */
export const isProxyId = (id: ConnectionId | null | undefined): boolean => !!id && !isBuiltinConnectionId(id)

/** Name of a connection record: a proxy's own name, else the fixed name. */
function recordName(c: ConnectionInfo['connection']): string {
  return isProxyConnection(c) ? c.name : (BUILTIN_NAME[c.id] ?? c.id)
}

/**
 * The auth method in plain words (config-review spec 4.1), shared by project General and the New project form:
 * Anthropic "Claude Code login" / "API key", OpenAI "ChatGPT sign-in" / "API key", LiteLLM "proxy key".
 */
export function authMethodLabel(info: Pick<ConnectionInfo, 'connection'>): string {
  const c = info.connection
  if (isProxyConnection(c)) return 'proxy key'
  if (c.id === 'openai') return c.auth.kind === 'apiKey' ? 'API key' : 'ChatGPT sign-in'
  return c.auth.kind === 'apiKey' ? 'API key' : 'Claude Code login'
}

/** "Anthropic (Claude Code login)". */
export function connectionWithAuth(info: Pick<ConnectionInfo, 'connection'>): string {
  return `${recordName(info.connection)} (${authMethodLabel(info)})`
}

/** The effective default connection's entry (connections:list `isDefault`); null when the list is not loaded. */
export function defaultConnectionInfo(connections: readonly ConnectionInfo[] | null | undefined): ConnectionInfo | null {
  return connections?.find((c) => c.isDefault) ?? null
}

/** @deprecated Same as connectionLabel. */
export function connectionName(id: ConnectionId): string {
  return connectionLabel(id)
}

/**
 * The default card's quiet mode word. 'chosen' only when the user's stored pick is this card; a chosen connection that
 * is no longer usable leaves a fallback default, which is automatic in effect (UI review L3). null until loaded.
 */
export function defaultMode(cardId: ConnectionId, chosen: boolean | null, storedId: ConnectionId | null): 'chosen' | 'automatic' | null {
  if (chosen === null) return null
  return chosen && storedId === cardId ? 'chosen' : 'automatic'
}

/** Announcement after a default change; the automatic one names the connection now in use (UI review L14). */
export function defaultChangeAnnouncement(next: ConnectionId | null, effective: ConnectionId | null): string {
  if (next) return `${connectionName(next)} is now the default for new projects and assistants`
  return effective
    ? `The default connection is automatic again: ${connectionName(effective)} for new projects and assistants`
    : 'The default connection is automatic again'
}
