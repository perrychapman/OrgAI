import type { ConnectorAuth, ConnectorDef, ConnectorState, ConnectorVariant, McpLibraryEntry, McpLibraryInfo, McpServerSpec, McpTestResult } from '@shared/types'
import { CONNECTOR_REDIRECT_PORT, connectorById, connectorVariant } from '@shared/connectors'
import { isValidMcpServerName } from '@shared/defaults'
import type { OAuthPreset } from './oauth'

/**
 * Connectors on the main side: building a library entry from a preset, the OAuth preset for an entry, the gallery
 * state, token header values and the ORGAI_MOCK=1 stand-ins. Pure; McpService owns persistence and secrets.
 */

/** Looks up a custom preset's ConnectorDef projection by id (McpService passes it; undefined = no such preset). */
export type CustomConnectorLookup = (id: string) => ConnectorDef | undefined

type ConnectorRef = Pick<McpServerSpec, 'connectorId' | 'connectorVariant' | 'connectorCustom'>

/**
 * The preset and variant behind a library entry, or undefined for an ordinary entry (or an unknown preset). An entry
 * with connectorCustom resolves only through `custom` (never the curated catalog), and only while its variant is still
 * one of the preset's; every other entry resolves only through the curated catalog.
 */
export function connectorOf(entry: ConnectorRef | undefined, custom?: CustomConnectorLookup): { def: ConnectorDef; variant: ConnectorVariant } | undefined {
  if (!entry?.connectorId) return undefined
  if (entry.connectorCustom === true) {
    const def = custom?.(entry.connectorId)
    if (!def) return undefined
    if (entry.connectorVariant === undefined) return { def, variant: connectorVariant(def) }
    const variant = def.variants.find((v) => v.id === entry.connectorVariant)
    return variant ? { def, variant } : undefined
  }
  const def = connectorById(entry.connectorId)
  if (!def) return undefined
  return { def, variant: connectorVariant(def, entry.connectorVariant) }
}

/** The OAuth preset for runAuthorization / refreshTokens; undefined for token and no-auth connectors and ordinary entries. */
export function oauthPresetFor(entry: ConnectorRef | undefined, custom?: CustomConnectorLookup): OAuthPreset | undefined {
  const c = connectorOf(entry, custom)
  if (!c) return undefined
  const auth = c.variant.auth
  if (auth.kind === 'token' || auth.kind === 'none') return undefined
  // A custom preset's OAuth carries scopes only: discovery does the rest.
  if (entry?.connectorCustom === true) return auth.kind === 'oauth' && auth.scopes?.length ? { scopes: [...auth.scopes] } : {}
  const o = auth.overrides ?? {}
  return {
    ...(o.issuer ? { issuer: o.issuer } : {}),
    ...(o.authorizationEndpoint ? { authorizationEndpoint: o.authorizationEndpoint } : {}),
    ...(o.tokenEndpoint ? { tokenEndpoint: o.tokenEndpoint } : {}),
    ...(o.endpointsMode ? { endpointsMode: o.endpointsMode } : {}),
    ...(auth.scopes?.length ? { scopes: [...auth.scopes] } : {}),
    ...(o.extraAuthParams ? { extraAuthParams: { ...o.extraAuthParams } } : {}),
    ...(o.sendResource === false ? { sendResource: false } : {}),
    ...(o.tokenResponse ? { tokenResponse: o.tokenResponse } : {}),
    ...(auth.kind === 'oauthClient' ? { redirectPort: CONNECTOR_REDIRECT_PORT } : {})
  }
}

/** A library name for the connector: its id, else id-2 ... id-9 when a custom entry already holds the name. */
export function connectorEntryName(def: { id: string; name: string }, taken: readonly string[]): string {
  const names = new Set(taken)
  if (!names.has(def.id)) return def.id
  for (let i = 2; i < 10; i++) {
    const n = `${def.id}-${i}`.slice(0, 48)
    if (isValidMcpServerName(n) && !names.has(n)) return n
  }
  throw new Error(`The MCP library already has entries named "${def.id}" through "${def.id}-9". Rename one, then add ${def.name} again.`)
}

/**
 * The library entry for a preset variant. Everything comes from the catalog: transport, url, non-secret headers,
 * the token's secret header slot. OAuth state is added later by authorize (main process only).
 */
export function buildConnectorEntry(def: ConnectorDef, variant: ConnectorVariant, id: string, taken: readonly string[], now: Date): McpLibraryEntry {
  const auth = variant.auth
  return {
    id,
    name: connectorEntryName(def, taken),
    transport: variant.transport,
    url: variant.url,
    ...(variant.headers && Object.keys(variant.headers).length ? { headers: { ...variant.headers } } : {}),
    ...(auth.kind === 'token' ? { secretHeaders: [auth.header] } : {}),
    source: 'user',
    description: `${def.name} (${variant.label}): ${def.description}`.slice(0, 200),
    addedAt: now.toISOString(),
    connectorId: def.id,
    connectorVariant: variant.id
  }
}

/** The stored header value for a pasted token: trimmed, single line, the preset's prefix added once. */
export function tokenHeaderValue(auth: Extract<ConnectorAuth, { kind: 'token' }>, token: string): string {
  const t = token.trim()
  if (!t) throw new Error(`Enter the ${auth.label.toLowerCase()}.`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(t)) throw new Error('The token must be a single line without control characters.')
  // Header values: printable ASCII only, spaces allowed inside (trimmed at the ends above).
  if (!/^[\x21-\x7e ]+$/.test(t)) throw new Error('The token may contain only printable ASCII characters (letters, digits, punctuation and spaces).')
  if (t.length > 4000) throw new Error('The token is too long.')
  const prefix = auth.prefix ?? ''
  return prefix && t.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix}${t.slice(prefix.length).trim()}` : `${prefix}${t}`
}

/** A gallery card's state from the entry's library info. */
export function connectorState(variant: ConnectorVariant | undefined, info: McpLibraryInfo | undefined): ConnectorState {
  if (!info || !variant) return 'available'
  if (variant.auth.kind === 'none') return 'connected'
  if (variant.auth.kind === 'token') return info.missingSecrets.length ? 'needsSetup' : 'connected'
  switch (info.auth.state) {
    case 'authorized':
      return 'connected'
    case 'error':
      return 'error'
    default:
      return 'needsSetup'
  }
}

// ---------- ORGAI_MOCK=1 only ----------

export const MOCK_CONNECTOR_ACCOUNT = 'mock@example.com'
export const MOCK_CONNECTOR_TOKEN = 'mock-connector-token'

const MOCK_TOOLS: Record<string, string[]> = {
  email: ['search_threads', 'get_thread', 'list_labels'],
  calendar: ['list_calendars', 'list_events', 'get_freebusy'],
  files: ['search_files', 'get_file', 'list_folder'],
  chat: ['search_messages', 'read_channel', 'list_users'],
  docs: ['search_pages', 'get_page', 'query_database'],
  project: ['search_issues', 'get_issue', 'list_projects'],
  dev: ['search_code', 'get_issue', 'list_pull_requests'],
  monitoring: ['search_issues', 'get_event', 'list_releases'],
  payments: ['list_customers', 'get_payment', 'list_subscriptions'],
  design: ['get_file', 'get_node', 'list_variables'],
  crm: ['search_contacts', 'get_conversation', 'list_companies'],
  data: ['list_sheets', 'read_range', 'search_files'],
  cloud: ['list_projects', 'get_deployment', 'get_logs'],
  knowledge: ['search', 'read_page', 'ask_question'],
  automation: ['list_workflows', 'get_run', 'trigger_workflow'],
  commerce: ['list_orders', 'get_product', 'list_customers'],
  meetings: ['list_meetings', 'get_transcript', 'search_notes']
}

/** The mock test result for a connector entry: tools when it is set up, else the same failure a real test gives. */
export function mockConnectorTest(def: ConnectorDef, variant: ConnectorVariant, info: McpLibraryInfo): McpTestResult {
  const state = connectorState(variant, info)
  if (state !== 'connected') {
    return variant.auth.kind === 'token'
      ? { ok: false, error: `Mock: add the ${variant.auth.label.toLowerCase()} first.`, durationMs: 5 }
      : { ok: false, needsAuthorization: true, error: 'Mock: the server needs authorization.', durationMs: 5 }
  }
  const tools = MOCK_TOOLS[def.category] ?? ['search', 'fetch']
  return {
    ok: true,
    tools,
    toolDetails: tools.map((name) => ({ name, description: `Mock ${def.name} tool (ORGAI_MOCK=1).` })),
    durationMs: 12
  }
}
