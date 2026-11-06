import type { ConnectionId, ConnectionInfo } from '@shared/types'
import { CONNECTION_NAME } from './settingsCopy'

/**
 * The auth method in plain words (config-review spec 4.1), shared by project General and the New project form:
 * Anthropic "Claude Code login" / "API key", OpenAI "ChatGPT sign-in" / "API key", LiteLLM "proxy key".
 */
export function authMethodLabel(info: Pick<ConnectionInfo, 'connection'>): string {
  const c = info.connection
  if (c.id === 'litellm') return 'proxy key'
  if (c.id === 'openai') return c.auth.kind === 'apiKey' ? 'API key' : 'ChatGPT sign-in'
  return c.auth.kind === 'apiKey' ? 'API key' : 'Claude Code login'
}

/** "Anthropic (Claude Code login)". */
export function connectionWithAuth(info: Pick<ConnectionInfo, 'connection'>): string {
  return `${CONNECTION_NAME[info.connection.id]} (${authMethodLabel(info)})`
}

/** The effective default connection's entry (connections:list `isDefault`); null when the list is not loaded. */
export function defaultConnectionInfo(connections: readonly ConnectionInfo[] | null | undefined): ConnectionInfo | null {
  return connections?.find((c) => c.isDefault) ?? null
}

/** Display name of a connection id. */
export function connectionName(id: ConnectionId): string {
  return CONNECTION_NAME[id]
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
  if (next) return `${CONNECTION_NAME[next]} is now the default for new projects and assistants`
  return effective
    ? `The default connection is automatic again: ${CONNECTION_NAME[effective]} for new projects and assistants`
    : 'The default connection is automatic again'
}
