import type { McpProposalServer, McpServerSpec, McpServersProposalPayload, ProposalEffect } from '@shared/types'
import { pinnedVersionOf } from './mcpVersion'
import { clampLabel } from './clampLabel'
import { hasHidden, showHidden } from './hiddenChars'

export const SKIP_MCP_FEEDBACK = 'Skipped by the user; continue without MCP servers.'

export type McpProposalScope = 'library' | 'project'

export function proposalScope(payload: Pick<McpServersProposalPayload, 'scope'>): McpProposalScope {
  return payload.scope === 'library' ? 'library' : 'project'
}

/** What approving does for one server, in plain words. */
export function upsertAction(s: McpProposalServer, scope: McpProposalScope): string {
  if (scope === 'library') return `Add ${clampLabel(s.name)} to your library`
  if (s.libraryId) return `Link ${clampLabel(s.name)} from your library`
  if (s.projectOnly) return `Add ${clampLabel(s.name)} to this project`
  return `Add ${clampLabel(s.name)} to the library and this project`
}

/** Hostname of a remote URL, or null when it does not parse. */
export function remoteHost(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

export function effectLine(s: McpProposalServer): string {
  if (s.transport === 'stdio') return 'Runs code on this machine'
  const host = remoteHost(s.url)
  return host ? `Connects to remote host ${host}` : 'Connects to a remote host'
}

/** Stdio servers show pinned state; remote ones have none. */
export function pinState(s: McpProposalServer): 'pinned' | 'unpinned' | null {
  if (s.transport !== 'stdio') return null
  return pinnedVersionOf(s) ? 'pinned' : 'unpinned'
}

/** A role as the cards name it: slugs are internal, the name is what the user chose. */
export interface RoleRef {
  slug: string
  name: string
}

/** Role names for slugs, in the given order. A slug the project does not have is dropped. */
export function roleNames(slugs: readonly string[], roles: readonly RoleRef[]): string[] {
  const out: string[] = []
  for (const slug of slugs) {
    const r = roles.find((x) => x.slug === slug)
    if (r) {
      const n = clampLabel(r.name, 40)
      if (!out.includes(n)) out.push(n)
    }
  }
  return out
}

/** Library entries have no role grants, so library scope returns null. Names, never slugs; unknown slugs are dropped and an emptied list returns null. */
export function whoCanUse(s: McpProposalServer, roles?: readonly RoleRef[], scope: McpProposalScope = 'project'): string | null {
  if (scope === 'library') return null
  if (s.roles === undefined) return 'Every role'
  if (s.roles.length === 0) return 'No role yet'
  const known = roles ? roleNames(s.roles, roles) : s.roles.map((r) => clampLabel(r, 40))
  return known.length > 0 ? known.join(', ') : null
}

function accessText(roles: readonly string[] | undefined, known: readonly RoleRef[]): string {
  if (roles === undefined) return 'Every role'
  const names = roleNames(roles, known)
  return names.length > 0 ? names.join(', ') : 'no role'
}

/** "Reviewer (was Orchestrator, Implementer)" for a server already in the project; the plain list otherwise. */
export function whoCanUseChange(s: McpProposalServer, current: McpServerSpec | undefined, roles: readonly RoleRef[]): string {
  const now = accessText(s.roles, roles)
  if (!current) return now
  return `${now} (was ${accessText(current.roles, roles)})`
}

/** Approve-helper wording for an MCP proposal. */
export function mcpApplyNote(scope: McpProposalScope, inlineSecrets = false): string {
  const tail = inlineSecrets ? ' Secrets you leave empty can be set later.' : ''
  const base =
    scope === 'library'
    ? 'Approving saves these MCP servers to your MCP library (available to every project). Secrets are stored encrypted.'
    : 'Approving saves these MCP servers to the project. Secrets are stored encrypted.'
  return base + tail
}

export function secretsLine(payload: McpServersProposalPayload, serverId?: string): string | null {
  const list = uniqueSecretSlots(payload).filter((x) => serverId === undefined || x.slot.serverId === serverId)
  if (list.length === 0) return null
  return `You will set ${list.length} ${list.length === 1 ? 'secret' : 'secrets'} after approving: ${list.map((x) => clampLabel(x.slot.name, 40)).join(', ')}`
}

export type McpSecretSlot = NonNullable<McpServersProposalPayload['secrets']>[number]

/** The payload's secret slots without duplicates (same server, kind and name), each with its index in payload.secrets. */
export function uniqueSecretSlots(payload: Pick<McpServersProposalPayload, 'secrets'>): { index: number; slot: McpSecretSlot }[] {
  const seen = new Set<string>()
  const out: { index: number; slot: McpSecretSlot }[] = []
  ;(payload.secrets ?? []).forEach((slot, index) => {
    const key = JSON.stringify([slot.serverId, slot.kind, slot.name])
    if (seen.has(key)) return
    seen.add(key)
    out.push({ index, slot })
  })
  return out
}

// ---------- The whole target: what actually runs (mirrors src/main/capabilities/sanitize.ts reviewTarget) ----------

type TargetSpec = Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url' | 'env' | 'headers' | 'secretEnv' | 'secretHeaders'>

const byKey = ([a]: [string, string], [b]: [string, string]): number => (a < b ? -1 : a > b ? 1 : 0)
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^ -~]/
const quote = (a: string): string => (a === '' || /[\s"']/.test(a) || hasHidden(a) || NON_ASCII.test(a) ? JSON.stringify(a) : a)

/** `NAME=value` pairs before the command and args (stdio), or the URL plus `-H "Name: value"` headers. Secret slots are never here. */
export function targetText(s: TargetSpec): string {
  const env = Object.entries(s.env ?? {}).sort(byKey)
  const headers = Object.entries(s.headers ?? {}).sort(byKey)
  return s.transport === 'stdio'
    ? [...env.map(([k, v]) => `${k}=${quote(v)}`), quote(s.command ?? ''), ...(s.args ?? []).map(quote)].join(' ').trim()
    : [s.url ?? '', ...headers.map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)].join(' ').trim()
}

/** Names of the secret slots a spec carries (env or header names only, never values). */
export function secretSlotNames(s: TargetSpec): string[] {
  return s.transport === 'stdio' ? [...(s.secretEnv ?? [])] : [...(s.secretHeaders ?? [])]
}

function hiddenIn(s: TargetSpec): boolean {
  const parts = [s.command, s.url, ...(s.args ?? []), ...Object.entries(s.env ?? {}).flat(), ...Object.entries(s.headers ?? {}).flat(), ...(s.secretEnv ?? []), ...(s.secretHeaders ?? [])]
  return parts.some((p) => hasHidden(p))
}

/** True when the server's name, text or any part of what it runs holds a hidden character. */
export function mcpServerHidden(s: McpProposalServer, entry?: TargetSpec | null): boolean {
  return hasHidden(s.name) || hasHidden(s.description) || hiddenIn(s) || (!!s.libraryId && !!entry && hiddenIn(entry))
}

const CODE_LOADING_ENV = /^(NODE_OPTIONS|PATH|LD_.*|DYLD_.*|PYTHON.*|NPM_CONFIG_.*|UV_.*|PIP_.*|DOCKER_.*|.*_PROXY)$/i

/** Environment names that change what a stdio command loads or where it connects. */
export function codeLoadingEnv(s: Pick<McpServerSpec, 'env' | 'secretEnv'>): string[] {
  return [...Object.keys(s.env ?? {}), ...(s.secretEnv ?? [])].filter((n) => CODE_LOADING_ENV.test(n))
}

/** What the card shows as the command or address, and what Copy copies (hidden characters escaped). Null when there is none. */
export function proposalTarget(s: McpProposalServer, entry?: TargetSpec | null): string | null {
  const spec: TargetSpec = commandOf(s) === null && s.libraryId && entry ? entry : s
  const text = targetText(spec)
  return text ? showHidden(text) : null
}

function nameDiff(label: string, before: Record<string, string> | undefined, after: Record<string, string> | undefined): string | null {
  const b = before ?? {}
  const a = after ?? {}
  const parts = [
    ...Object.keys(a).filter((k) => !(k in b)).sort().map((k) => `+${showHidden(k)}`),
    ...Object.keys(b).filter((k) => !(k in a)).sort().map((k) => `-${showHidden(k)}`),
    ...Object.keys(a).filter((k) => k in b && b[k] !== a[k]).sort().map((k) => `${showHidden(k)} changed`)
  ]
  return parts.length > 0 ? `${label}: ${parts.join(', ')}` : null
}

function listDiff(label: string, before: readonly string[] | undefined, after: readonly string[] | undefined): string | null {
  const b = before ?? []
  const a = after ?? []
  const parts = [...a.filter((x) => !b.includes(x)).map((x) => `+${showHidden(x)}`), ...b.filter((x) => !a.includes(x)).map((x) => `-${showHidden(x)}`)]
  return parts.length > 0 ? `${label}: ${parts.join(', ')}` : null
}

/** The changed fields of an updated server, before and after ("Args: a b -> a c", "Environment: +NODE_OPTIONS"). */
export function mcpFieldChanges(s: McpProposalServer, current: McpServerSpec): string[] {
  const out: (string | null)[] = []
  const args = (a: readonly string[] | undefined): string => showHidden((a ?? []).join(' ') || 'none')
  if (s.transport !== current.transport) out.push(`Type: ${current.transport} -> ${s.transport}`)
  if ((s.command ?? '') !== (current.command ?? '')) out.push(`Command: ${showHidden(current.command ?? 'none')} -> ${showHidden(s.command ?? 'none')}`)
  if (JSON.stringify(s.args ?? []) !== JSON.stringify(current.args ?? [])) out.push(`Args: ${args(current.args)} -> ${args(s.args)}`)
  if ((s.url ?? '') !== (current.url ?? '')) out.push(`URL: ${showHidden(current.url ?? 'none')} -> ${showHidden(s.url ?? 'none')}`)
  out.push(nameDiff('Environment', current.env, s.env), nameDiff('Headers', current.headers, s.headers))
  out.push(listDiff('Secret environment', current.secretEnv, s.secretEnv), listDiff('Secret headers', current.secretHeaders, s.secretHeaders))
  return out.filter((x): x is string => x !== null)
}

type SpecLike = Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url'>

function commandOf(s: SpecLike): string | null {
  if (s.transport === 'stdio') return [s.command ?? '', ...(s.args ?? [])].filter(Boolean).join(' ') || null
  return s.url || null
}

/**
 * Exact command line (stdio) or full URL (http/sse) of a proposed server. A library link shows its snapshot, else the
 * library entry's own command or url (`entry`); null when neither has one.
 */
export function proposalCommand(s: McpProposalServer, entry?: SpecLike | null): string | null {
  return commandOf(s) ?? (s.libraryId && entry ? commandOf(entry) : null)
}

/** Where the proposed spec came from. */
export function proposalSource(s: McpProposalServer): string | null {
  if (s.libraryId) return null
  const r = s.registry
  if (r?.name) return `From the registry: ${clampLabel(r.name)}${r.version ? `@${clampLabel(r.version, 40)}` : ''}`
  return 'Described by the assistant'
}

// ---------- Diff against what the project (or library) has now ----------

export type McpChange = 'new' | 'link' | 'toggle' | 'access' | 'update' | 'same'

export interface McpRow {
  server: McpProposalServer
  change: Exclude<McpChange, 'same'>
  /** The server in the project (or library) now, when there is one. */
  current?: McpServerSpec
}

export interface McpRemovalView {
  id: string
  name: string
  /** "Remove github-issues from this project" */
  title: string
  /** Who loses it (empty for an unknown id). */
  detail: string
  /** "The library entry stays." for a linked server. */
  note: string | null
}

export interface McpDiff {
  rows: McpRow[]
  removals: McpRemovalView[]
  /** Names of proposed servers that match what is there already. */
  same: string[]
  /** Names of current servers the proposal does not touch (null when the current list is unknown). */
  untouched: string[] | null
  summary: string
}

const CHANGE_ORDER: Record<McpChange, number> = { new: 0, link: 1, toggle: 2, access: 2, update: 2, same: 3 }

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...(a ?? [])].sort()
  const y = [...(b ?? [])].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function sameRecord(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const entries = (r: Record<string, string> | undefined): string => JSON.stringify(Object.entries(r ?? {}).sort(([k], [l]) => (k < l ? -1 : k > l ? 1 : 0)))
  return entries(a) === entries(b)
}

function sameSpec(a: McpProposalServer, b: McpServerSpec): boolean {
  return (
    a.transport === b.transport &&
    (a.command ?? '') === (b.command ?? '') &&
    sameList(a.args, b.args) &&
    (a.url ?? '') === (b.url ?? '') &&
    sameRecord(a.env, b.env) &&
    sameRecord(a.headers, b.headers) &&
    sameList(a.secretEnv, b.secretEnv) &&
    sameList(a.secretHeaders, b.secretHeaders)
  )
}

function sameRoles(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return sameList(a, b)
}

function findCurrent(s: McpProposalServer, current: readonly McpServerSpec[]): McpServerSpec | undefined {
  return current.find((c) => c.id === s.id) ?? (s.libraryId ? current.find((c) => c.libraryId === s.libraryId) : undefined)
}

/** How one proposed server differs from what is there. A linked server's spec is the library's, so only its access can differ. */
export function classifyUpsert(s: McpProposalServer, current: readonly McpServerSpec[], scope: McpProposalScope): { change: McpChange; current?: McpServerSpec } {
  const hit = findCurrent(s, current)
  if (!hit) return { change: s.libraryId && scope === 'project' ? 'link' : 'new' }
  const linked = !!hit.libraryId && !!s.libraryId
  if (!linked && !sameSpec(s, hit)) return { change: 'update', current: hit }
  // Main saves `enabled !== false`, so an omitted flag switches a disabled server on.
  if (scope === 'project' && (s.enabled !== false) !== (hit.enabled !== false)) return { change: 'toggle', current: hit }
  if (scope === 'project' && !sameRoles(s.roles, hit.roles)) return { change: 'access', current: hit }
  return { change: 'same', current: hit }
}

/** Whether the proposal switches an existing server on or off (null when it does not). */
export function toggleDirection(s: McpProposalServer, current: McpServerSpec | undefined): 'on' | 'off' | null {
  if (!current) return null
  const next = s.enabled !== false
  if (next === (current.enabled !== false)) return null
  return next ? 'on' : 'off'
}

/** "Switches github on. It runs code on this machine from the next run." / "... connects to <host> ..." / "Switches github off." */
export function toggleLine(s: McpProposalServer, current: McpServerSpec | undefined): string | null {
  const dir = toggleDirection(s, current)
  if (!dir) return null
  const name = clampLabel(s.name)
  if (dir === 'off') return `Switches ${name} off.`
  const spec = current ?? s
  if (spec.transport === 'stdio') return `Switches ${name} on. It runs code on this machine from the next run.`
  const host = remoteHost(spec.url ?? s.url)
  return `Switches ${name} on. It connects to ${host ?? 'a remote host'} from the next run.`
}

/** Effect line for a new or linked row; a server added switched off does not start. */
export function newEffectLine(s: McpProposalServer): string {
  return s.enabled === false ? 'Added switched off; it does not start until you switch it on.' : effectLine(s)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** One row per removed id: the name from the current servers, who loses it, and whether a library entry stays. */
export function removalLabels(payload: Pick<McpServersProposalPayload, 'remove'>, current: readonly McpServerSpec[], roles: readonly RoleRef[], scope: McpProposalScope): McpRemovalView[] {
  return (payload.remove ?? []).map((id) => {
    const hit = current.find((c) => c.id === id)
    if (!hit) {
      const where = scope === 'library' ? 'your library' : 'this project'
      return { id, name: clampLabel(id, 24), title: `Remove a server that is not in ${where} (${clampLabel(id, 24)})`, detail: '', note: null }
    }
    const name = clampLabel(hit.name)
    if (scope === 'library') {
      return { id, name, title: `Remove ${name} from your library`, detail: 'Projects that link it lose it.', note: null }
    }
    let detail: string
    if (hit.roles === undefined) detail = 'Every role loses it.'
    else {
      const names = roleNames(hit.roles, roles)
      detail = names.length === 0 ? 'No role uses it now.' : `${names.join(', ')} can no longer use it.`
    }
    return { id, name, title: `Remove ${name} from this project`, detail, note: hit.libraryId ? 'The library entry stays.' : null }
  })
}

/** "1 new, 1 linked, 1 access change, 1 changed, 1 removal; 2 servers unchanged" (zero parts left out). */
export function mcpSummaryLine(counts: { new: number; link: number; access: number; update: number; removal: number; on?: number; off?: number }, unchanged: number | null): string {
  const parts: string[] = []
  if (counts.new) parts.push(`${counts.new} new`)
  if (counts.link) parts.push(`${counts.link} linked`)
  if (counts.on) parts.push(`${counts.on} switched on`)
  if (counts.off) parts.push(`${counts.off} switched off`)
  if (counts.access) parts.push(plural(counts.access, 'access change', 'access changes'))
  if (counts.update) parts.push(`${counts.update} changed`)
  if (counts.removal) parts.push(plural(counts.removal, 'removal', 'removals'))
  let out = parts.join(', ')
  if (unchanged) out += `${out ? '; ' : ''}${plural(unchanged, 'server', 'servers')} unchanged`
  return out || 'No changes'
}

/** Diff an MCP proposal against the servers the project (or, in library scope, the library) has now. Pure. */
export function diffMcpProposal(payload: McpServersProposalPayload, currentServers: readonly McpServerSpec[] | null, roles: readonly RoleRef[]): McpDiff {
  const scope = proposalScope(payload)
  const current = currentServers ?? []
  const rows: McpRow[] = []
  const same: string[] = []
  const touched = new Set<string>()
  for (const s of payload.upsert) {
    const { change, current: hit } = classifyUpsert(s, current, scope)
    if (hit) touched.add(hit.id)
    if (change === 'same') same.push(clampLabel(s.name))
    else rows.push({ server: s, change, current: hit })
  }
  rows.sort((a, b) => CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change])
  const removals = removalLabels(payload, current, roles, scope)
  for (const id of payload.remove ?? []) touched.add(id)
  const untouched = currentServers ? current.filter((c) => !touched.has(c.id)).map((c) => clampLabel(c.name)) : null
  const count = (c: McpChange): number => rows.filter((r) => r.change === c).length
  const toggled = (d: 'on' | 'off'): number => rows.filter((r) => r.change === 'toggle' && toggleDirection(r.server, r.current) === d).length
  const unchanged = (untouched?.length ?? 0) + same.length
  return {
    rows,
    removals,
    same,
    untouched,
    summary: mcpSummaryLine({ new: count('new'), link: count('link'), access: count('access'), update: count('update'), removal: removals.length, on: toggled('on'), off: toggled('off') }, unchanged)
  }
}

/** Fold-summary verb for a row, e.g. "change access to notes". */
export function mcpRowVerb(r: McpRow): string {
  const name = clampLabel(r.server.name, 40)
  switch (r.change) {
    case 'new':
      return `add ${name}`
    case 'link':
      return `link ${name}`
    case 'toggle':
      return `switch ${toggleDirection(r.server, r.current) ?? 'on'} ${name}`
    case 'access':
      return `change access to ${name}`
    default:
      return `change ${name}`
  }
}

/** Who made the proposal, as the effect line names it. */
export type EffectProposer = 'assistant' | 'architect' | 'orchestrator'

/** When an approved change takes effect (Proposal.effect), as the card's helper says it; null for an unknown value. */
export function proposalEffectCopy(effect: ProposalEffect | undefined, proposer: EffectProposer = 'orchestrator'): string | null {
  switch (effect) {
    case 'now':
      return 'Takes effect now.'
    case 'after-turn': {
      const who = proposer === 'assistant' ? "the assistant's" : proposer === 'architect' ? "the Architect's" : "the orchestrator's"
      return `Takes effect after ${who} current turn. Reports already running keep what they have.`
    }
    case 'next-run':
      return 'Takes effect from the next run. This run keeps what it has.'
    default:
      return null
  }
}

/** Helper text for filling secrets on the card; says where to find them later. */
export function secretsHelp(scope: McpProposalScope): string {
  const where = scope === 'library' ? 'App settings > Connectors' : 'Project settings > Tools'
  return `Fill them now or later in ${where}. A server with an empty secret does not start.`
}
