import type { AppSettings, ConnectionId, ProviderConnections } from '@shared/types'

const LABELS: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** Why a connection cannot be the default right now (not usable). Pure. */
export function defaultRefusal(id: ConnectionId, connections: Partial<ProviderConnections> | undefined): string {
  if (id === 'litellm') {
    const l = connections?.litellm
    if (l?.enabled === true && !l.baseUrl?.trim()) return 'LiteLLM has no base URL yet. Add it and connect, then make it the default.'
    if (l?.enabled === true && l.hasApiKey !== true) return 'LiteLLM has no API key yet. Add it and connect, then make it the default.'
  }
  return `${LABELS[id]} is not connected. Connect it first, then make it the default.`
}

export type SettingsDefaultDecision =
  | { kind: 'keep' }
  | { kind: 'pick'; connection: ConnectionId }
  | { kind: 'refuse'; message: string }

/**
 * What a settings:set with an incoming defaultConnection means. Unchanged = keep; a stale echo of the value the last
 * automatic rewrite replaced (default still automatic) = keep the stored value; otherwise an explicit pick, refused
 * when the connection is not usable. Pure.
 */
export function decideSettingsDefault(input: {
  stored: ConnectionId
  chosen: boolean
  incoming: ConnectionId
  autoReplaced: ConnectionId | undefined
  refusal: (id: ConnectionId) => string | null
}): SettingsDefaultDecision {
  if (input.incoming === input.stored) return { kind: 'keep' }
  if (!input.chosen && input.autoReplaced !== undefined && input.incoming === input.autoReplaced) return { kind: 'keep' }
  const message = input.refusal(input.incoming)
  return message ? { kind: 'refuse', message } : { kind: 'pick', connection: input.incoming }
}

/**
 * The settings to save for a renderer's settings:set: defaultConnectionChosen always comes from the stored settings,
 * except an explicit pick (decideSettingsDefault) which sets it true. Throws the refusal message. Pure.
 */
export function settingsForSave(
  incoming: AppSettings,
  stored: AppSettings,
  ctl: { autoReplaced: ConnectionId | undefined; refusal: (id: ConnectionId) => string | null }
): AppSettings {
  const { defaultConnectionChosen: _drop, ...rest } = incoming
  const chosen = stored.defaultConnectionChosen === true
  const d = decideSettingsDefault({
    stored: stored.defaultConnection,
    chosen,
    incoming: incoming.defaultConnection,
    autoReplaced: ctl.autoReplaced,
    refusal: ctl.refusal
  })
  if (d.kind === 'refuse') throw new Error(d.message)
  if (d.kind === 'pick') return { ...rest, defaultConnection: d.connection, defaultConnectionChosen: true }
  return { ...rest, defaultConnection: stored.defaultConnection, ...(chosen ? { defaultConnectionChosen: true } : {}) }
}
