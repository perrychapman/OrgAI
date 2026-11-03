import type { AppSettings, ConnectionId, ProviderConnections } from '@shared/types'

export const CONNECTION_LABELS: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** Why a connection cannot be the default right now (not usable). Pure. */
export function defaultRefusal(id: ConnectionId, connections: Partial<ProviderConnections> | undefined): string {
  if (id === 'litellm') {
    const l = connections?.litellm
    if (l?.enabled === true && !l.baseUrl?.trim()) return 'LiteLLM has no base URL yet. Add it and connect, then make it the default.'
    if (l?.enabled === true && l.hasApiKey !== true) return 'LiteLLM has no API key yet. Add it and connect, then make it the default.'
  }
  if (id === 'anthropic' && connections?.anthropic?.enabled === false) return 'Anthropic is turned off. Connect it first, then make it the default.'
  return `${CONNECTION_LABELS[id]} is not connected. Connect it first, then make it the default.`
}

/** The settings without AppSettings.defaultConnectionReplaced. Pure. */
export function withoutReplaced(s: AppSettings): AppSettings {
  const { defaultConnectionReplaced: _drop, ...rest } = s
  return rest
}
