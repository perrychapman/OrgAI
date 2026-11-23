/**
 * The /mcp view's words: the project's MCP servers, one line per server, one server's details, and the
 * choices an edit offers. Pure: everything comes from projects:get (its roles) and mcp:list, plus mcpLibrary:list for
 * "add one from your library". The words are the `orgai mcp` commands' own.
 */
import type { McpAuthState, McpLibraryInfo, McpServerInfo, McpServerSpec, Project } from '../../shared/types'
import { clean, type PickOption } from './configUi'
import { sanitizeTty } from './sanitizeTty'
import type { Seg } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'

export interface McpData {
  project: Project
  /** mcp:list. */
  servers: McpServerInfo[]
}

export interface McpRow {
  id: string
  name: string
  /** on = passed to runs; off = kept in the list only. */
  state: 'on' | 'off'
  /** "every role" / "no role" / "1 role" / "3 roles" (only this project's slugs are counted). */
  roles: string
  transport: string
  /** What to watch out for, in this order: the library entry is gone, a secret is unset, a sign-in is needed. */
  flags: string[]
}

/** A server needs a sign-in when its OAuth state is anything but notRequired / authorized. */
const needsSignIn = (state: McpAuthState): boolean => state !== 'notRequired' && state !== 'authorized'

/** The slugs a spec names that this project actually has, in the project's role order. */
const knownSlugs = (project: Project, slugs: readonly string[]): string[] => project.roles.filter((r) => slugs.includes(r.slug)).map((r) => r.slug)

const byName = (a: string, b: string): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** One row per server, by name: its state, who may use it, how it is reached and what to watch out for. */
export function mcpRows(data: McpData): McpRow[] {
  return data.servers
    .map((info): McpRow => {
      const spec = info.spec
      const slugs = spec.roles ?? []
      const count = knownSlugs(data.project, slugs).length
      return {
        id: spec.id,
        name: clean(spec.name, 120),
        state: spec.enabled ? 'on' : 'off',
        // A list that names only roles this project no longer has reaches no role either.
        roles: spec.roles === undefined ? 'every role' : count === 0 ? 'no role' : `${count} role${count === 1 ? '' : 's'}`,
        transport: clean(spec.transport, 40),
        flags: [...(info.libraryMissing ? ['library entry gone'] : []), ...(info.missingSecrets.length ? ['needs a secret'] : []), ...(needsSignIn(info.auth.state) ? ['needs sign-in'] : [])]
      }
    })
    .sort((a, b) => byName(a.name, b.name))
}

/**
 * One row cut to `width`, the least important part first: the flags go, then the transport, then who may use it, and
 * only then is the name cut. The name column is `nameWidth` wide when it fits. The selected row stands out (accent, bold);
 * a server that is off reads dim, and its flags read as a warning.
 */
export function mcpRowSegs(row: McpRow, width: number, nameWidth: number, sep: string, ellipsis: string, selected: boolean): Seg[] {
  const head = selected ? '> ' : '  '
  const name = row.name
  const variants: { parts: string[]; flags: string[] }[] = [
    { parts: [row.state, row.roles, row.transport], flags: row.flags },
    { parts: [row.state, row.roles, row.transport], flags: [] },
    { parts: [row.state, row.roles], flags: [] },
    { parts: [row.state], flags: [] }
  ]
  const pad = (s: string, w: number): string => (textWidth(s) >= w ? s : s + ' '.repeat(w - textWidth(s)))
  // Aligned columns first (any variant), then unaligned: a ragged column reads worse than shorter words.
  for (const nw of [Math.max(nameWidth, textWidth(name)), textWidth(name)]) {
    for (const v of variants) {
      const rest = v.parts.join(sep)
      const tail = v.flags.length ? `${sep}${v.flags.join(sep)}` : ''
      const total = textWidth(head) + nw + 2 + textWidth(rest) + textWidth(tail)
      if (total <= width) {
        return [
          { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
          { text: pad(name, nw), bold: true, ...(row.state === 'off' && !selected ? { dim: true } : {}) },
          { text: `  ${rest}`, dim: !selected },
          ...(tail ? [{ text: tail, tone: 'warn' as const }] : [])
        ]
      }
    }
  }
  return [
    { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
    { text: truncateEnd(name, Math.max(1, width - textWidth(head)), ellipsis), bold: true, ...(row.state === 'off' ? { dim: true } : {}) }
  ]
}

/** One secret a server takes: an env var or a header name, and whether a value is stored for it. Never a value. */
export interface McpSecretSlot {
  kind: 'env' | 'header'
  name: string
  set: boolean
}

/** The names of a secret list, guarding a field that is missing or not an array. */
const secretNames = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && n !== '') : [])

/** The secret slots of one server: its `secretEnv` names, then its `secretHeaders` names, each with whether a value is stored. */
export function mcpSecretSlots(info: McpServerInfo): McpSecretSlot[] {
  const spec = info.spec
  const envSet = secretNames(info.envSet)
  const headersSet = secretNames(info.headersSet)
  return [
    ...secretNames(spec.secretEnv).map((name): McpSecretSlot => ({ kind: 'env', name, set: envSet.includes(name) })),
    ...secretNames(spec.secretHeaders).map((name): McpSecretSlot => ({ kind: 'header', name, set: headersSet.includes(name) }))
  ]
}

/** Where one server's secret values live: its library entry (shared by every project that links it), else this project. */
export function mcpSecretScope(info: McpServerInfo): 'project' | 'library' {
  const libraryId = info.spec.libraryId
  return info.secretScope === 'library' && typeof libraryId === 'string' && libraryId !== '' ? 'library' : 'project'
}

/** What one server is: its facts, then its description. Plain lines; the view cuts them to the width. */
export function mcpDetailLines(data: McpData, serverId: string): string[] {
  const info = data.servers.find((s) => s.spec.id === serverId)
  if (!info) return ['This server is gone.']
  const spec = info.spec
  const everyRole = spec.roles === undefined
  const slugs = spec.roles ?? []
  const known = everyRole ? data.project.roles : data.project.roles.filter((r) => slugs.includes(r.slug))
  const available = everyRole ? 'every role' : known.length === 0 ? 'no role' : known.map((r) => clean(r.name, 80)).join(', ')
  const own = data.project.roles.filter((r) => r.mcpServers?.includes(spec.id))
  const slots = mcpSecretSlots(info)
  const command = [clean(spec.command ?? '', 200), ...(spec.args ?? []).map((a) => clean(a, 120))].filter(Boolean).join(' ')
  return [
    clean(spec.name, 120),
    `state: ${spec.enabled ? 'on' : 'off'}`,
    `transport: ${clean(spec.transport, 40)}`,
    spec.transport === 'stdio' ? `command: ${command || 'not set'}` : `url: ${clean(spec.url ?? '', 300) || 'not set'}`,
    `available to: ${available}`,
    `granted on their own: ${own.length ? own.map((r) => clean(r.name, 80)).join(', ') : 'none'}`,
    `secrets missing: ${info.missingSecrets.length ? info.missingSecrets.map((n) => clean(n, 80)).join(', ') : 'none'}`,
    `secrets: ${slots.length ? slots.map((s) => `${clean(s.name, 80)} (${s.set ? 'set' : 'missing'})`).join(', ') : 'none'}`,
    `sign-in: ${clean(info.auth.state, 40)}`,
    `source: ${spec.libraryId ? `library entry ${clean(spec.libraryId, 120)}` : 'this project'}`,
    ...(spec.description ? [clean(spec.description, 1000)] : [])
  ]
}

/** The roles to tick for `r`: one per role of the project (by slug). */
export function mcpRoleOptions(project: Project): PickOption[] {
  return project.roles.map((r) => ({ value: r.slug, label: clean(r.name, 120) }))
}

/** The roles to save for a checked set: undefined when every role of the project is checked (= every role). */
export function rolesFromChecks(project: Project, checked: string[]): string[] | undefined {
  if (project.roles.every((r) => checked.includes(r.slug))) return undefined
  return knownSlugs(project, checked)
}

/** The roles to tick for a saved set: every slug when the server is open to every role. */
export function checkedFromRoles(project: Project, roles: string[] | undefined): string[] {
  return roles === undefined ? project.roles.map((r) => r.slug) : knownSlugs(project, roles)
}

/** What a server's state lets runs reach: on or off, and the role slugs that may use it (undefined = every role). */
export interface McpReach {
  enabled: boolean
  roles: string[] | undefined
}

/**
 * Whether going from `before` to `after` gives MORE of the project's agents the server: it is turned on, or at least one
 * role of this project gains it (going to every role counts when a role did not have it). Removing or turning off never
 * widens. Pure.
 */
export function mcpWidens(project: Project, before: McpReach, after: McpReach): boolean {
  if (!before.enabled && after.enabled) return true
  const set = (r: McpReach): Set<string> => new Set(r.roles === undefined ? project.roles.map((x) => x.slug) : knownSlugs(project, r.roles))
  const had = set(before)
  for (const slug of set(after)) if (!had.has(slug)) return true
  return false
}

/** Who may use a server with this role list, in words ("every role", "no role", role names). Names are cleaned. */
export function mcpAvailableTo(project: Project, roles: string[] | undefined): string {
  if (roles === undefined) return 'every role'
  const known = project.roles.filter((r) => roles.includes(r.slug))
  return known.length === 0 ? 'no role' : known.map((r) => clean(r.name, 80)).join(', ')
}

/** One untrusted value for the terminal, sanitized and whitespace-folded but never cut. */
const whole = (s: unknown): string => sanitizeTty(typeof s === 'string' ? s : String(s ?? '')).replace(/\s+/g, ' ').trim()

/** Names only, never values: a record's keys and a name list, de-duplicated. */
const namesOf = (record: unknown, list: unknown): string[] => {
  const keys = record && typeof record === 'object' && !Array.isArray(record) ? Object.keys(record as Record<string, unknown>) : []
  return [...new Set([...keys, ...secretNames(list)])].map(whole).filter(Boolean)
}

/**
 * The lines of the confirmation before a widening save: what the server IS, so `y` is not pressed on a name. The command
 * and every argument (stdio) or the URL (http / sse) whole, the NAMES of env variables, headers and secret slots (never a
 * value), the source and who gets it. Every string is sanitized; none is cut. `spec` is a project server or a library entry.
 */
export function mcpConfirmLines(spec: Pick<McpServerSpec, 'name' | 'transport' | 'command' | 'args' | 'env' | 'secretEnv' | 'url' | 'headers' | 'secretHeaders' | 'libraryId'> & { id?: string }, headline: string, availableTo: string, libraryId?: string): string[] {
  const out: string[] = [whole(headline), '', `name: ${whole(spec.name)}`, `transport: ${whole(spec.transport)}`]
  if (spec.transport === 'stdio') {
    out.push(`command: ${whole(spec.command ?? '') || 'not set'}`)
    const args = Array.isArray(spec.args) ? spec.args : []
    out.push(args.length ? `arguments (${args.length}):` : 'arguments: none')
    args.forEach((a, i) => out.push(`  ${i + 1}. ${whole(a)}`))
  } else {
    out.push(`url: ${whole(spec.url ?? '') || 'not set'}`)
  }
  const envNames = namesOf(spec.env, spec.secretEnv)
  const headerNames = namesOf(spec.headers, spec.secretHeaders)
  const secrets = [...secretNames(spec.secretEnv), ...secretNames(spec.secretHeaders)].map(whole)
  out.push(`environment variable names (values not shown): ${envNames.length ? envNames.join(', ') : 'none'}`)
  out.push(`header names (values not shown): ${headerNames.length ? headerNames.join(', ') : 'none'}`)
  out.push(`secret slots: ${secrets.length ? secrets.join(', ') : 'none'}`)
  const lib = libraryId ?? spec.libraryId
  out.push(`source: ${lib ? `library entry ${whole(lib)}` : 'this project'}`)
  out.push(`available to: ${whole(availableTo)}`)
  out.push('', 'Press y to save. Any other key cancels and saves nothing.')
  return out
}

/** The library entries this project does not link yet, by name. */
export function libraryOptions(library: McpLibraryInfo[], servers: McpServerInfo[]): PickOption[] {
  const linked = new Set(servers.map((s) => s.spec.libraryId).filter((id): id is string => typeof id === 'string' && id !== ''))
  return library
    .filter((info) => !linked.has(info.entry.id))
    .sort((a, b) => byName(clean(a.entry.name, 120), clean(b.entry.name, 120)))
    .map((info) => ({ value: info.entry.id, label: clean(info.entry.name, 120), detail: clean(info.entry.description ?? '', 300) }))
}
