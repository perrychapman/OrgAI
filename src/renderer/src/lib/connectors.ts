import type { ConnectorAuth, ConnectorCategory, ConnectorDef, ConnectorInfo, ConnectorVariant, McpServerSpec, Role } from '@shared/types'
import { connectorVariant } from '@shared/connectors'

/** Plain-word helpers for the Connectors gallery, connect dialog and project side. No protocol vocabulary. */

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  email: 'Email',
  calendar: 'Calendar',
  files: 'Files',
  chat: 'Chat',
  docs: 'Docs',
  project: 'Projects',
  dev: 'Code',
  monitoring: 'Monitoring',
  payments: 'Payments',
  design: 'Design'
}

export type ChipTone = 'neutral' | 'warning' | 'success' | 'danger'

/** The state chip on a tile: words, with the account when we know it. */
export function stateChip(info: ConnectorInfo): { label: string; tone: ChipTone } {
  switch (info.state) {
    case 'connected': {
      const account = info.library?.auth.account
      return { label: account ? `Connected as ${account}` : 'Connected', tone: 'success' }
    }
    case 'needsSetup':
      return { label: 'Needs setup', tone: 'warning' }
    case 'error':
      return { label: 'Error', tone: 'danger' }
    default:
      return { label: 'Not connected', tone: 'neutral' }
  }
}

/** First letter(s) for the logo tile. */
export function connectorInitial(def: Pick<ConnectorDef, 'name'>): string {
  const words = def.name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : words[0][0].toUpperCase()
}

/** A stable hue (0-359) per connector id, for the initial tile. */
export function connectorHue(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** "Can read" or "Can read and change". */
export function accessWords(v: Pick<ConnectorVariant, 'readOnly'>): string {
  return v.readOnly ? 'Can read' : 'Can read and change'
}

/** One sentence under the variant choice, in plain words. */
export function variantExplain(v: Pick<ConnectorVariant, 'readOnly'>): string {
  return v.readOnly
    ? 'Agents can look things up but cannot create, edit or delete anything. This is the safe default.'
    : 'Agents can also create, edit or delete things in your account. Only pick this if you want them to act for you.'
}

/** The variant to preselect: the connector's default. */
export function defaultVariantId(def: ConnectorDef): string {
  return connectorVariant(def, def.defaultVariant).id
}

export type ConnectKind = ConnectorAuth['kind']

/** What a user must still do before Connect can work; empty = ready. */
export function connectMissing(auth: ConnectorAuth, input: { clientId: string; clientSecret: string; token: string }): string[] {
  const missing: string[] = []
  if (auth.kind === 'oauthClient') {
    if (!input.clientId.trim()) missing.push('Client ID')
    if (auth.clientSecret === 'required' && !input.clientSecret) missing.push('Client secret')
  } else if (auth.kind === 'token') {
    if (!input.token.trim()) missing.push(auth.label)
  }
  return missing
}

/** "Add the Client ID and Client secret to continue." */
export function missingSentence(missing: string[]): string {
  if (missing.length === 0) return ''
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return `Add the ${list} to continue.`
}

/** The quiet status line in the dialog for a preview / untested connector, or undefined when both are fine. */
export function honestyNote(def: Pick<ConnectorDef, 'status' | 'verified'>): string | undefined {
  if (def.status === 'preview' && !def.verified) return 'Preview · not yet tested with OrgAI'
  if (def.status === 'preview') return 'Preview · the service calls this a beta'
  if (!def.verified) return 'Not yet tested with OrgAI'
  return undefined
}

/** Tool names in words: "search_messages" -> "Search messages", "listIssues" -> "List issues". */
export function plainToolName(name: string): string {
  const spaced = name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
  if (!spaced) return name
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** Which roles may use a server: names, not counts. */
export function roleAccessSummary(roles: Pick<Role, 'slug' | 'name'>[], granted: string[] | undefined): string {
  if (roles.length === 0) return 'No roles yet'
  if (granted === undefined) return roles.length === 1 ? roles[0].name : 'All roles'
  const names = roles.filter((r) => granted.includes(r.slug)).map((r) => r.name)
  if (names.length === 0) return 'No roles'
  if (names.length === roles.length && roles.length > 1) return 'All roles'
  return names.join(', ')
}

/** Connector infos keyed by library entry id. */
export function byLibraryId(infos: ConnectorInfo[]): Map<string, ConnectorInfo> {
  const m = new Map<string, ConnectorInfo>()
  for (const i of infos) if (i.library) m.set(i.library.entry.id, i)
  return m
}

/** Project servers that came from a connector (via a library link). */
export function projectConnectorServers(servers: McpServerSpec[] | undefined): McpServerSpec[] {
  return (servers ?? []).filter((s) => s.connectorId)
}

/** Order: connected first, then needs setup / error, then the rest in catalog order. */
export function sortForGallery(infos: ConnectorInfo[]): ConnectorInfo[] {
  const rank = (i: ConnectorInfo): number => (i.state === 'connected' ? 0 : i.state === 'needsSetup' || i.state === 'error' ? 1 : 2)
  return infos
    .map((x, idx) => ({ x, idx }))
    .sort((a, b) => rank(a.x) - rank(b.x) || a.idx - b.idx)
    .map((o) => o.x)
}

/** Filter by name, vendor, category or description. */
export function filterConnectors(infos: ConnectorInfo[], query: string): ConnectorInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return infos
  return infos.filter((i) => `${i.connector.name} ${i.connector.vendor} ${CATEGORY_LABELS[i.connector.category]} ${i.connector.description}`.toLowerCase().includes(q))
}

/** The consequence line before Disconnect or Remove. */
export function removeConsequence(usedBy: { projectName: string }[], what: 'disconnect' | 'remove'): string {
  const names = usedBy.map((u) => u.projectName)
  const who = names.length === 0 ? 'No project uses it right now.' : `${names.join(', ')} will lose access.`
  return what === 'disconnect'
    ? `This signs OrgAI out of the service on this computer. ${who}`
    : `This removes the service and its saved sign-in or token from this computer. ${who}`
}
