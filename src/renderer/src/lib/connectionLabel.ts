import { isProxyConnection } from '@shared/types'
import type { ConnectionId, ConnectionInfo } from '@shared/types'
import { CONNECTION_NAME } from './settingsCopy'

/** Name of a connection record: a proxy's own name, else the fixed name. */
function recordName(c: ConnectionInfo['connection']): string {
  return isProxyConnection(c) ? c.name : (CONNECTION_NAME[c.id] ?? c.id)
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

/** Display name of a connection id. */
export function connectionName(id: ConnectionId): string {
  return CONNECTION_NAME[id] ?? id
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
