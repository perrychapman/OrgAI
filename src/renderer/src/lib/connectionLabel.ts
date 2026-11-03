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
