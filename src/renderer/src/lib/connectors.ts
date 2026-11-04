import type { ConnectorAuth, ConnectorCategory, ConnectorDef, ConnectorEase, ConnectorInfo, ConnectorVariant, McpServerSpec, Role } from '@shared/types'
import { connectorEase, connectorVariant, easeRank } from '@shared/connectors'
import { USER_CONNECTOR_PRESETS_MAX, isCustomConnector, type UserConnectorAuth, type UserConnectorDef, type UserConnectorVariant } from './mcpScope'
import { hasHidden } from './hiddenChars'

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
  if (def.status === 'preview' && !def.verified) return 'Not yet tested with OrgAI'
  if (def.status === 'preview') return 'The service calls this a beta'
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
  none: ['no sign in', 'no sign in needed', 'easy'],
  token: ['token', 'paste a token', 'paste', 'api key'],
  ownApp: ['own app', 'needs your own app', 'client id']
}

function easeMatch(def: ConnectorDef, q: string): number | null {
  const n = q.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (n.length < 3) return null
  const keys = EASE_KEYWORDS[connectorEase(def)]
  // A one-word query matches one-word keywords only (so "client" does not pull in the "client id" phrase); a
  // multi-word query matches a phrase from its start (8) or at a later word boundary (9), never mid-word.
  const oneWord = !n.includes(' ')
  const pool = oneWord ? keys.filter((k) => !k.includes(' ')) : keys
  if (pool.some((k) => k.startsWith(n))) return 8
  if (!oneWord && pool.some((k) => ` ${k}`.includes(` ${n}`))) return 9
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

/**
 * Rank of a saved (library) server for a search: 0 name starts with it, 1 a name word starts with it, 2 the name
 * contains it, 3 the description contains it, null no match. Every word of a multi-word query must match somewhere;
 * the worst word decides. An empty query is 0.
 */
export function libraryMatchRank(entry: { name: string; description?: string }, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = entry.name.toLowerCase()
  const desc = (entry.description ?? '').toLowerCase()
  let worst = 0
  for (const w of q.split(/\s+/)) {
    let r: number | null = null
    if (name.startsWith(w)) r = 0
    else if (name.split(/[^a-z0-9]+/).some((p) => p.startsWith(w))) r = 1
    else if (name.includes(w)) r = 2
    else if (desc.includes(w)) r = 3
    if (r === null) return null
    worst = Math.max(worst, r)
  }
  return worst
}

/** Saved servers that match the query, best first (stable otherwise). */
export function filterLibrary<T extends { entry: { name: string; description?: string } }>(items: T[], query: string): T[] {
  if (!query.trim()) return items
  return items
    .map((x, idx) => ({ x, idx, r: libraryMatchRank(x.entry, query) }))
    .filter((o): o is { x: T; idx: number; r: number } => o.r !== null)
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
export type GalleryFilter = 'all' | 'connected' | 'custom' | 'easy' | ConnectorCategory

export function matchesFilter(info: ConnectorInfo, filter: GalleryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'connected') return info.state === 'connected'
  if (filter === 'custom') return isCustomConnector(info)
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
    // The user's own presets that are not connected come first, as their own group.
    const groups: { key: string; title: string; test: (i: ConnectorInfo) => boolean }[] = [
      { key: 'custom', title: 'Your presets', test: (i) => isCustomConnector(i) },
      { key: 'easy', title: 'Easy sign-in', test: (i) => !isCustomConnector(i) && easeGroup(infoEase(i)) === 0 },
      { key: 'token', title: 'Needs a token', test: (i) => !isCustomConnector(i) && easeGroup(infoEase(i)) === 1 },
      { key: 'ownApp', title: 'Needs your own app', test: (i) => !isCustomConnector(i) && easeGroup(infoEase(i)) === 2 }
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
    // The dialog says "preview" (badge) and "not yet tested" (one quiet line) once; setup steps carry the program detail.
    if (/developer preview|not yet tested/i.test(n)) continue
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

// ---------- Custom presets (the user's own services) ----------

export const PRESET_VARIANTS_MAX = 5
export const PRESET_NAME_MAX = 60
export const PRESET_DESCRIPTION_MAX = 160
export const PRESET_ALIASES_MAX = 10
const PRESET_ALIAS_MAX_CHARS = 40
const PRESET_COMMAND_MAX = 500
const PRESET_VALUE_MAX = 2000
export const DEFAULT_TOKEN_HEADER = 'Authorization'

export type PresetAuthKind = 'none' | 'token' | 'oauth'
export type PresetTransport = 'http' | 'stdio'

/** One fixed (non-secret) header or environment variable. */
export interface PresetRowDraft {
  rid: string
  name: string
  value: string
}

/** One access option as the form edits it. */
export interface PresetVariantDraft {
  rid: string
  /** Kept from the saved preset so an edit never renames an option; empty for a new one (made from its label on save). */
  id: string
  label: string
  readOnly: boolean
  /** Remote: an address for this option (empty = the base address). Program: extra arguments, one per line. */
  extra: string
}

/** The preset form's state. Text fields stay strings until `draftToDef`. */
export interface PresetDraft {
  name: string
  description: string
  category: ConnectorCategory
  /** Comma separated. */
  aliases: string
  transport: PresetTransport
  url: string
  command: string
  /** One argument per line. */
  args: string
  auth: PresetAuthKind
  /** Header name (remote) or environment variable (program) that carries the token. */
  tokenName: string
  tokenPrefix: string
  /** Optional https address where the person gets a token. */
  tokenHelp: string
  rows: PresetRowDraft[]
  variants: PresetVariantDraft[]
  /** The rid of the default option. */
  defaultRid: string
}

let ridCounter = 0
/** A fresh row key for the form's lists. */
export function newRid(prefix = 'r'): string {
  ridCounter += 1
  return `${prefix}${ridCounter}`
}

export function newVariantDraft(label = '', readOnly = false): PresetVariantDraft {
  return { rid: newRid('v'), id: '', label, readOnly, extra: '' }
}

/** A blank form: one remote service with no sign-in and one access option. */
export function newPresetDraft(): PresetDraft {
  const v = newVariantDraft('Standard', false)
  return {
    name: '',
    description: '',
    category: 'data',
    aliases: '',
    transport: 'http',
    url: '',
    command: '',
    args: '',
    auth: 'none',
    tokenName: DEFAULT_TOKEN_HEADER,
    tokenPrefix: '',
    tokenHelp: '',
    rows: [],
    variants: [v],
    defaultRid: v.rid
  }
}

function recordToRows(rec: Record<string, string> | undefined): PresetRowDraft[] {
  return Object.entries(rec ?? {}).map(([name, value]) => ({ rid: newRid(), name, value }))
}

/** The preset as the form edits it. The default option supplies the shared address, command and fixed values. */
export function defToDraft(def: UserConnectorDef): PresetDraft {
  const base = def.variants.find((v) => v.id === def.defaultVariant) ?? def.variants[0]
  const stdio = base.transport === 'stdio'
  const auth = base.auth
  const baseArgs = base.args ?? []
  const variants: PresetVariantDraft[] = def.variants.map((v) => {
    let extra = ''
    if (v.id !== base.id) {
      if (stdio) {
        const a = v.args ?? []
        const prefixed = baseArgs.every((x, i) => a[i] === x)
        extra = (prefixed ? a.slice(baseArgs.length) : a).join('\n')
      } else if ((v.url ?? '') !== (base.url ?? '')) extra = v.url ?? ''
    }
    return { rid: newRid('v'), id: v.id, label: v.label, readOnly: v.readOnly, extra }
  })
  const defaultRid = variants[Math.max(0, def.variants.findIndex((v) => v.id === base.id))].rid
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    aliases: (def.aliases ?? []).join(', '),
    transport: stdio ? 'stdio' : 'http',
    url: stdio ? '' : (base.url ?? ''),
    command: base.command ?? '',
    args: baseArgs.join('\n'),
    auth: auth.kind === 'token' ? 'token' : auth.kind === 'oauth' ? 'oauth' : 'none',
    tokenName: auth.kind === 'token' ? auth.header : stdio ? '' : DEFAULT_TOKEN_HEADER,
    tokenPrefix: auth.kind === 'token' ? (auth.prefix ?? '').trimEnd() : '',
    tokenHelp: auth.kind === 'token' ? (auth.link ?? '') : '',
    rows: recordToRows(stdio ? base.env : base.headers),
    variants,
    defaultRid
  }
}

/** A copy for "Duplicate": same fields, a fresh name, no saved option ids. */
export function duplicateDraft(def: UserConnectorDef, takenNames: readonly string[]): PresetDraft {
  const d = defToDraft(def)
  const lower = new Set(takenNames.map((n) => n.toLowerCase()))
  const stem = clampText(def.name, PRESET_NAME_MAX - 9)
  let name = `${stem} copy`
  for (let n = 2; lower.has(name.toLowerCase()); n += 1) name = `${stem} copy ${n}`
  return { ...d, name, variants: d.variants.map((v) => ({ ...v, id: '' })) }
}

/** Search words typed as "a, b" -> lowercase, trimmed, unique. */
export function parseAliases(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    const w = raw.trim().toLowerCase()
    if (w && !out.includes(w)) out.push(w)
  }
  return out
}

/** Non-empty lines, as typed (an argument keeps its inner spaces). */
export function argLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
}

/** A kebab-case id from words ("Acme CRM" -> "acme-crm"), unique among `taken`. */
export function kebabId(text: string, taken: ReadonlySet<string>, fallback = 'service'): string {
  const stem =
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || fallback
  if (!taken.has(stem)) return stem
  for (let n = 2; ; n += 1) {
    const next = `${stem}-${n}`
    if (!taken.has(next)) return next
  }
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function nameProblem(name: string, stdio: boolean): string | undefined {
  if (hasHidden(name)) return 'Remove the hidden characters.'
  if (stdio) return ENV_NAME.test(name) ? undefined : 'Use letters, numbers and underscores, not starting with a number.'
  return HEADER_NAME.test(name) ? undefined : 'Use letters, numbers and dashes only.'
}

function httpsProblem(text: string): string | undefined {
  if (hasHidden(text)) return 'Remove the hidden characters.'
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return 'Use an address that starts with https://'
  }
  if (u.protocol !== 'https:') return 'Use an address that starts with https://'
  if (u.username || u.password) return 'Leave the user name and password out of the address.'
  return undefined
}

export type PresetErrors = Record<string, string>

/**
 * What stops a draft from saving, keyed by field: name, description, aliases, url, command, auth, tokenName, tokenHelp,
 * `row:<rid>`, `variants` and `variant:<rid>`. Empty = fine. Main checks again and may refuse more.
 */
export function validatePreset(d: PresetDraft): PresetErrors {
  const e: PresetErrors = {}
  const stdio = d.transport === 'stdio'
  const name = d.name.trim()
  if (!name) e.name = 'Give it a name.'
  else if (Array.from(name).length > PRESET_NAME_MAX) e.name = `Use ${PRESET_NAME_MAX} characters or fewer.`
  else if (hasHidden(name)) e.name = 'Remove the hidden characters.'
  const desc = d.description.trim()
  if (Array.from(desc).length > PRESET_DESCRIPTION_MAX) e.description = `Use ${PRESET_DESCRIPTION_MAX} characters or fewer.`
  else if (hasHidden(desc) || /[\r\n]/.test(desc)) e.description = 'Keep it to one line without hidden characters.'
  const aliases = parseAliases(d.aliases)
  if (aliases.length > PRESET_ALIASES_MAX) e.aliases = `Use ${PRESET_ALIASES_MAX} search words or fewer.`
  else if (aliases.some((a) => Array.from(a).length > PRESET_ALIAS_MAX_CHARS || hasHidden(a))) e.aliases = `Keep each word under ${PRESET_ALIAS_MAX_CHARS} characters, without hidden characters.`

  if (stdio) {
    const cmd = d.command.trim()
    if (!cmd) e.command = 'Enter the program to run.'
    else if (cmd.length > PRESET_COMMAND_MAX) e.command = `Use ${PRESET_COMMAND_MAX} characters or fewer.`
    else if (/[\r\n]/.test(cmd)) e.command = 'Enter the program on one line.'
    else if (hasHidden(cmd)) e.command = 'Remove the hidden characters.'
    if (hasHidden(d.args)) e.args = 'Remove the hidden characters.'
  } else {
    const url = d.url.trim()
    if (!url) e.url = 'Enter the address.'
    else {
      const p = httpsProblem(url)
      if (p) e.url = p
    }
  }
  if (d.auth === 'oauth' && stdio) e.auth = 'Browser sign-in works only with a remote address.'
  if (d.auth === 'token') {
    const tn = d.tokenName.trim()
    if (!tn) e.tokenName = stdio ? 'Enter the variable name.' : 'Enter the header name.'
    else {
      const p = nameProblem(tn, stdio)
      if (p) e.tokenName = p
    }
    const help = d.tokenHelp.trim()
    if (help) {
      const p = httpsProblem(help)
      if (p) e.tokenHelp = p
    }
    if (!e.tokenName && hasHidden(d.tokenPrefix)) e.tokenName = 'Remove the hidden characters from the prefix.'
  }
  const seen = new Set<string>()
  if (d.auth === 'token' && d.tokenName.trim()) seen.add(d.tokenName.trim().toLowerCase())
  for (const r of d.rows) {
    const n = r.name.trim()
    if (!n && !r.value) continue
    const key = `row:${r.rid}`
    if (!n) e[key] = 'Enter a name.'
    else {
      const p = nameProblem(n, stdio)
      if (p) e[key] = p
      else if (seen.has(n.toLowerCase())) e[key] = d.auth === 'token' && n.toLowerCase() === d.tokenName.trim().toLowerCase() ? 'The token already uses this name.' : 'Already listed.'
      else if (r.value.length > PRESET_VALUE_MAX) e[key] = `Use ${PRESET_VALUE_MAX} characters or fewer.`
      else if (hasHidden(r.value)) e[key] = 'Remove the hidden characters from the value.'
      seen.add(n.toLowerCase())
    }
  }
  if (d.variants.length < 1) e.variants = 'Add at least one access option.'
  else if (d.variants.length > PRESET_VARIANTS_MAX) e.variants = `${PRESET_VARIANTS_MAX} is the most.`
  const labels = new Set<string>()
  for (const v of d.variants) {
    const key = `variant:${v.rid}`
    const label = v.label.trim()
    if (!label) e[key] = 'Name this option.'
    else if (Array.from(label).length > PRESET_NAME_MAX) e[key] = `Use ${PRESET_NAME_MAX} characters or fewer.`
    else if (hasHidden(label)) e[key] = 'Remove the hidden characters.'
    else if (labels.has(label.toLowerCase())) e[key] = 'Another option has this name.'
    else if (v.extra.trim()) {
      const p = stdio ? (hasHidden(v.extra) ? 'Remove the hidden characters.' : undefined) : httpsProblem(v.extra.trim())
      if (p) e[key] = p
    }
    labels.add(label.toLowerCase())
  }
  return e
}

/** Field keys in the order the form shows them, for "focus the first problem". */
export function presetErrorOrder(d: PresetDraft): string[] {
  return ['name', 'description', 'aliases', 'url', 'command', 'args', 'auth', 'tokenName', 'tokenHelp', ...d.rows.map((r) => `row:${r.rid}`), 'variants', ...d.variants.map((v) => `variant:${v.rid}`)]
}

function authOf(d: PresetDraft): UserConnectorAuth {
  if (d.auth === 'oauth' && d.transport !== 'stdio') return { kind: 'oauth' }
  if (d.auth === 'token') {
    const prefix = d.tokenPrefix.trim()
    const link = d.tokenHelp.trim()
    return {
      kind: 'token',
      header: d.tokenName.trim(),
      ...(prefix ? { prefix: `${prefix} ` } : {}),
      label: `${d.name.trim()} token`,
      help: `Paste the token for ${d.name.trim()}.`,
      ...(link ? { link } : {})
    }
  }
  return { kind: 'none' }
}

function rowsToRecord(rows: PresetRowDraft[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const n = r.name.trim()
    if (n) out[n] = r.value
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The preset to send to main. `id` is the preset's id (kept on edit, from `kebabId` on add); saved option ids are kept and
 * new options get one from their label. Assumes `validatePreset` passed. A kit preset keeps its origin.
 */
export function draftToDef(d: PresetDraft, id: string, origin?: 'kit'): UserConnectorDef {
  const stdio = d.transport === 'stdio'
  const auth = authOf(d)
  const taken = new Set<string>(d.variants.map((v) => v.id).filter(Boolean))
  const fixed = rowsToRecord(d.rows)
  const baseArgs = argLines(d.args)
  const variants: UserConnectorVariant[] = d.variants.map((v) => {
    const vid = v.id || kebabId(v.label, taken, 'option')
    taken.add(vid)
    const extra = v.extra.trim()
    const common = { id: vid, label: v.label.trim(), readOnly: v.readOnly, auth }
    if (stdio) {
      const args = [...baseArgs, ...argLines(v.extra)]
      return { ...common, transport: 'stdio' as const, command: d.command.trim(), ...(args.length ? { args } : {}), ...(fixed ? { env: fixed } : {}) }
    }
    return { ...common, transport: 'http' as const, url: extra || d.url.trim(), ...(fixed ? { headers: fixed } : {}) }
  })
  const chosen = d.variants.findIndex((v) => v.rid === d.defaultRid)
  const aliases = parseAliases(d.aliases)
  return {
    id,
    name: d.name.trim(),
    vendor: 'You',
    publisher: 'user',
    category: d.category,
    description: d.description.trim() || 'A service you added yourself.',
    ...(aliases.length ? { aliases } : {}),
    variants,
    defaultVariant: variants[Math.max(0, chosen)].id,
    verified: false,
    ...(origin ? { origin } : {})
  }
}

/** True when two drafts would save the same preset (rids and a blank row do not count). */
export function sameDraft(a: PresetDraft, b: PresetDraft): boolean {
  const norm = (d: PresetDraft): string =>
    JSON.stringify({
      ...d,
      rows: d.rows.filter((r) => r.name.trim() || r.value).map((r) => [r.name, r.value]),
      variants: d.variants.map((v) => [v.id, v.label, v.readOnly, v.extra, v.rid === d.defaultRid])
    })
  return norm(a) === norm(b)
}

/** "Remote" or "Program": how a preset connects (its default option decides). */
export function presetKindWord(def: Pick<UserConnectorDef, 'variants' | 'defaultVariant'>): 'Remote' | 'Program' {
  const v = def.variants.find((x) => x.id === def.defaultVariant) ?? def.variants[0]
  return v?.transport === 'stdio' ? 'Program' : 'Remote'
}

/** "1 access option" / "2 access options". */
export function accessOptionCount(n: number): string {
  return n === 1 ? '1 access option' : `${n} access options`
}

/** Quote a command part when it has spaces or quotes, so the shown line reads as one command. */
function shellPart(s: string): string {
  return /[\s"'\\]/.test(s) || s === '' ? JSON.stringify(s) : s
}

/** The whole command an option runs, in one line: preset values first (`NAME=value`), then the program and arguments. Never cut. */
export function variantCommandLine(v: Pick<UserConnectorVariant, 'command' | 'args' | 'env'>): string {
  const env = Object.entries(v.env ?? {}).map(([k, val]) => `${k}=${shellPart(val)}`)
  return [...env, shellPart(v.command ?? ''), ...(v.args ?? []).map(shellPart)].join(' ')
}

/** The dialog's note about where a preset came from. */
export function customNote(origin: 'kit' | undefined): string {
  return origin === 'kit'
    ? 'This service came from an imported kit. Check where it connects before you add it.'
    : 'You described this service yourself. OrgAI has not checked it.'
}

/** The line on the preset form when the service is already added. */
export const PRESET_ADDED_NOTE =
  'Changes apply the next time it is added. The added service keeps its current settings until you remove and add it again.'

/** Whether another preset still fits. */
export function canAddPreset(count: number): boolean {
  return count < USER_CONNECTOR_PRESETS_MAX
}
