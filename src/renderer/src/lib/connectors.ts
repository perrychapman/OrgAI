import type { ConnectorAuth, ConnectorCategory, ConnectorDef, ConnectorEase, ConnectorInfo, ConnectorVariant, McpServerSpec, Role } from '@shared/types'
import { connectorEase, connectorVariant, easeRank } from '@shared/connectors'

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
  design: 'Design',
  crm: 'Customers',
  data: 'Data',
  cloud: 'Cloud',
  knowledge: 'Knowledge',
  automation: 'Automation',
  commerce: 'Commerce',
  meetings: 'Meetings'
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
      return { label: 'Not signed in', tone: 'warning' }
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

/** The ease of the variant this entry uses (the added one, else the default, which is the easiest). */
export function infoEase(info: ConnectorInfo): ConnectorEase {
  return connectorEase(info.connector, info.variant)
}

/** The method badge: words first (never colour alone). `icon` keys the lucide icon the tile maps. */
export const EASE_BADGE: Record<ConnectorEase, { label: string; tone: 'success' | 'neutral' | 'attention' }> = {
  signIn: { label: 'Sign in', tone: 'success' },
  none: { label: 'No sign-in needed', tone: 'success' },
  token: { label: 'Paste a token', tone: 'neutral' },
  ownApp: { label: 'Needs your own app', tone: 'attention' }
}

/** Sort group by ease: no sign-in and one-click sign-in share the front, then tokens, then own-app services. */
function easeGroup(e: ConnectorEase): number {
  return e === 'none' || e === 'signIn' ? 0 : e === 'token' ? 1 : 2
}

/** The tile / row button for an entry: words, accessible name and whether it is the filled (preferred) path. */
export function tileAction(info: ConnectorInfo): { label: string; aria: string; primary: boolean } {
  const name = info.connector.name
  switch (info.state) {
    case 'connected':
      return { label: 'Manage', aria: `Manage ${name}`, primary: false }
    case 'needsSetup':
      return { label: 'Finish setup', aria: `Finish setup for ${name}`, primary: false }
    case 'error':
      return { label: 'Fix', aria: `Fix ${name}`, primary: false }
    default: {
      const ease = infoEase(info)
      if (ease === 'signIn') return { label: 'Sign in', aria: `Sign in with ${name}`, primary: true }
      if (ease === 'none') return { label: 'Add', aria: `Add ${name}`, primary: true }
      if (ease === 'token') return { label: 'Add token', aria: `Add a token for ${name}`, primary: false }
      return { label: 'Set up', aria: `Set up ${name}`, primary: false }
    }
  }
}

const byName = (a: ConnectorInfo, b: ConnectorInfo): number => a.connector.name.localeCompare(b.connector.name)

/**
 * Gallery order: connected first (most recently connected, then name), then entries that need attention, then the rest
 * by ease (no sign-in and one-click sign-in, tokens, own app) and name.
 */
export function sortForGallery(infos: ConnectorInfo[]): ConnectorInfo[] {
  const rank = (i: ConnectorInfo): number => (i.state === 'connected' ? 0 : i.state === 'needsSetup' || i.state === 'error' ? 1 : 2)
  return [...infos].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) return (b.connectedAt ?? 0) - (a.connectedAt ?? 0) || byName(a, b)
    if (ra === 2) return easeRank(infoEase(a)) - easeRank(infoEase(b)) || byName(a, b)
    return byName(a, b)
  })
}

/**
 * How well one query word matches a connector (0 best): name exact, name prefix, a name word prefix, inside the name,
 * alias exact / prefix / inside, vendor, category, description. null = no match.
 */
function wordRank(def: ConnectorDef, w: string): number | null {
  const name = def.name.toLowerCase()
  if (name === w) return 0
  if (name.startsWith(w)) return 1
  if (name.split(/[\s\-_.]+/).some((x) => x.startsWith(w))) return 2
  if (name.includes(w)) return 3
  const aliases = (def.aliases ?? []).map((a) => a.toLowerCase())
  if (aliases.some((a) => a === w)) return 4
  if (aliases.some((a) => a.startsWith(w))) return 5
  if (aliases.some((a) => a.includes(w))) return 6
  if (def.vendor.toLowerCase().includes(w)) return 7
  if (CATEGORY_LABELS[def.category].toLowerCase().includes(w) || def.category.includes(w)) return 8
  if (def.description.toLowerCase().includes(w)) return 9
  return null
}

/** What a person may type for a connection method: the badge words, so searching what they just read works. */
const EASE_KEYWORDS: Record<ConnectorEase, string[]> = {
  signIn: ['sign in', 'easy', 'one click'],
  none: ['no sign in', 'no sign in needed', 'easy', 'open'],
  token: ['token', 'paste a token', 'paste', 'api key'],
  ownApp: ['own app', 'needs your own app', 'client id', 'client']
}

function easeMatch(def: ConnectorDef, q: string): number | null {
  const n = q.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (n.length < 3) return null
  const keys = EASE_KEYWORDS[connectorEase(def)]
  if (keys.some((k) => k.startsWith(n))) return 8
  if (keys.some((k) => k.includes(n))) return 9
  return null
}

/** Match rank for a whole query (0 best), or null when some word matches nothing. */
export function matchRank(def: ConnectorDef, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const words = q.split(/\s+/)
  let worst = 0
  for (const w of words) {
    let r = wordRank(def, w)
    if (words.length === 1) {
      const e = easeMatch(def, q)
      if (e !== null) r = r === null ? e : Math.min(r, e)
    }
    if (r === null) return easeMatch(def, q)
    worst = Math.max(worst, r)
  }
  if (words.length > 1) {
    const e = easeMatch(def, q)
    if (e !== null) worst = Math.min(worst, e)
  }
  // The whole phrase inside the name beats a scatter of word matches ("google docs").
  const name = def.name.toLowerCase()
  if (words.length > 1 && name.includes(q)) worst = Math.min(worst, name.startsWith(q) ? 1 : 3)
  return worst
}

/** Filter by name, alias, vendor, category or description, best matches first (stable otherwise). */
export function filterConnectors(infos: ConnectorInfo[], query: string): ConnectorInfo[] {
  if (!query.trim()) return infos
  return infos
    .map((x, idx) => ({ x, idx, r: matchRank(x.connector, query) }))
    .filter((o): o is { x: ConnectorInfo; idx: number; r: number } => o.r !== null)
    .sort((a, b) => a.r - b.r || a.idx - b.idx)
    .map((o) => o.x)
}

/** "12 services" / "1 service" / "No services": the live count under the search. */
export function serviceCount(n: number): string {
  return n === 0 ? 'No services' : n === 1 ? '1 service' : `${n} services`
}

/** Past this many catalog entries the gallery adds category chips and category headings. */
export const CATEGORY_GROUP_THRESHOLD = 24

/** A gallery filter chip: everything, connected, the easy sign-in ones, or one category. */
export type GalleryFilter = 'all' | 'connected' | 'easy' | ConnectorCategory

export function matchesFilter(info: ConnectorInfo, filter: GalleryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'connected') return info.state === 'connected'
  if (filter === 'easy') return easeGroup(infoEase(info)) === 0
  return info.connector.category === filter
}

/** Categories present in the catalog with their counts, in the order of CATEGORY_LABELS. */
export function categoriesPresent(infos: ConnectorInfo[]): { category: ConnectorCategory; count: number }[] {
  const counts = new Map<ConnectorCategory, number>()
  for (const i of infos) counts.set(i.connector.category, (counts.get(i.connector.category) ?? 0) + 1)
  return (Object.keys(CATEGORY_LABELS) as ConnectorCategory[]).filter((c) => counts.has(c)).map((c) => ({ category: c, count: counts.get(c) ?? 0 }))
}

export interface GallerySection {
  key: string
  /** null = no heading. */
  title: string | null
  items: ConnectorInfo[]
}

/**
 * What the gallery shows. With a query or a filter: one flat list (ranked for a query, else in gallery order). Otherwise a
 * Connected section first, then the rest, grouped by effort (easy sign-in, token, own app) once the catalog passes the threshold; categories are filter chips.
 */
export function gallerySections(infos: ConnectorInfo[], opts: { query: string; filter: GalleryFilter; easy?: boolean }): GallerySection[] {
  const sorted = sortForGallery(infos)
  const query = opts.query.trim()
  if (query || opts.filter !== 'all' || opts.easy) {
    const base = sorted.filter((i) => matchesFilter(i, opts.filter) && (!opts.easy || matchesFilter(i, 'easy')))
    const items = query ? filterConnectors(base, query) : base
    return items.length ? [{ key: 'flat', title: null, items }] : []
  }
  const connected = sorted.filter((i) => i.state === 'connected')
  const rest = sorted.filter((i) => i.state !== 'connected')
  const out: GallerySection[] = []
  if (connected.length) out.push({ key: 'connected', title: 'Connected', items: connected })
  if (infos.length > CATEGORY_GROUP_THRESHOLD) {
    // Past the threshold the default view groups by effort, so the one-click services lead; categories are chips.
    const groups: { key: string; title: string; test: (i: ConnectorInfo) => boolean }[] = [
      { key: 'easy', title: 'Easy sign-in', test: (i) => easeGroup(infoEase(i)) === 0 },
      { key: 'token', title: 'Needs a token', test: (i) => easeGroup(infoEase(i)) === 1 },
      { key: 'ownApp', title: 'Needs your own app', test: (i) => easeGroup(infoEase(i)) === 2 }
    ]
    for (const g of groups) {
      const items = rest.filter(g.test)
      if (items.length) out.push({ key: g.key, title: g.title, items })
    }
  } else if (rest.length) {
    out.push({ key: 'available', title: connected.length ? 'Available' : null, items: rest })
  }
  return out
}

/** The first `max` items and how many are left out, for "and N more". */
export function capList<T>(items: readonly T[], max: number): { shown: T[]; more: number } {
  return items.length <= max ? { shown: [...items], more: 0 } : { shown: items.slice(0, max), more: items.length - max }
}

/** Dialog headline per method. */
export function dialogTitle(def: Pick<ConnectorDef, 'name'>, ease: ConnectorEase, connected: boolean): string {
  if (connected) return def.name
  switch (ease) {
    case 'signIn':
      return `Sign in with ${def.name}`
    case 'none':
      return `Add ${def.name}`
    case 'token':
      return `Add ${def.name} with a token`
    case 'ownApp':
      return `Set up ${def.name}`
  }
}

/** The one line under the headline. */
export function dialogLead(ease: ConnectorEase): string {
  switch (ease) {
    case 'signIn':
      return 'Opens your browser. No keys to paste.'
    case 'none':
      return 'No sign-in needed.'
    case 'token':
      return 'Paste a token from the service. It stays encrypted on this computer.'
    case 'ownApp':
      return 'About 10 minutes, once. This service needs an app you create yourself.'
  }
}

/** The primary button's words in the connect dialog. */
export function connectLabel(ease: ConnectorEase, retry: boolean): string {
  if (retry) return 'Try again'
  return ease === 'signIn' ? 'Sign in' : ease === 'none' ? 'Add' : ease === 'token' ? 'Add token' : 'Connect'
}

/** What agents can do, one quiet line, for a single-variant service. */
export function accessLine(def: Pick<ConnectorDef, 'name'>, v: Pick<ConnectorVariant, 'readOnly'>): string {
  return v.readOnly ? `Agents can look things up in ${def.name} but cannot change anything.` : `Agents can read and change things in ${def.name}.`
}

/** The consequence line before Disconnect or Remove. */
export function removeConsequence(usedBy: { projectName: string }[], what: 'disconnect' | 'remove'): string {
  const names = usedBy.map((u) => u.projectName)
  const who = names.length === 0 ? 'No project uses it right now.' : `${names.join(', ')} will lose access.`
  return what === 'disconnect'
    ? `This signs OrgAI out of the service on this computer. ${who}`
    : `This removes the service and its saved sign-in or token from this computer. ${who}`
}

/** Cut untrusted text to at most n characters, ending in an ellipsis when it was cut. */
export function clampText(s: string, n: number): string {
  if (n <= 0) return ''
  const chars = Array.from(s)
  if (chars.length <= n) return s
  return `${chars.slice(0, n - 1).join('')}…`
}

/**
 * The notes worth showing a person. Developer caveats ("Unverified: ...") and implementation details (headers, storage,
 * token shapes) are dropped; a redirect or admin-approval caveat becomes one plain sentence and goes first.
 */
export function noteForUser(notes: readonly string[] | undefined, serviceName: string): string[] {
  const caveat: string[] = []
  const rest: string[] = []
  for (const raw of notes ?? []) {
    const n = raw.trim()
    if (!n) continue
    if (/^unverified/i.test(n)) continue
    if (/redirect|admin(?:'s)? approval/i.test(n)) {
      const line = `${serviceName} may refuse OrgAI's sign-in address or need an admin's approval.`
      if (!caveat.includes(line)) caveat.push(line)
      continue
    }
    if (/header|safeStorage|token response|authorization:|bearer/i.test(n)) continue
    rest.push(n)
  }
  return [...caveat, ...rest]
}
