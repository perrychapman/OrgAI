import { connectionName, proxyOf, type ConnectionsView } from '@shared/defaults'
import type { AppSettings, ConnectionId } from '@shared/types'

/** Label of a connection in messages: Anthropic, OpenAI or the proxy's own name. */
export function connectionLabel(id: ConnectionId, v?: ConnectionsView): string {
  return connectionName(id, v)
}

/** Why a connection cannot be the default right now (not usable). Names a proxy by its name. Pure. */
export function defaultRefusal(id: ConnectionId, v: ConnectionsView | undefined): string {
  const label = connectionName(id, v)
  if (id !== 'anthropic' && id !== 'openai') {
    const p = proxyOf(v, id)
    if (!p) return `${label} no longer exists. Pick another connection.`
    if (p.enabled === true && !p.anthropicBaseUrl?.trim()) return `${label} has no base URL yet. Add it and connect, then make it the default.`
    if (p.enabled === true && p.hasApiKey !== true) return `${label} has no API key yet. Add it and connect, then make it the default.`
  }
  if (id === 'anthropic' && v?.connections?.anthropic?.enabled === false) return 'Anthropic is turned off. Connect it first, then make it the default.'
  return `${label} is not connected. Connect it first, then make it the default.`
}

/** The settings without AppSettings.defaultConnectionReplaced. Pure. */
export function withoutReplaced(s: AppSettings): AppSettings {
  const { defaultConnectionReplaced: _drop, ...rest } = s
  return rest
}
