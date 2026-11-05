/**
 * Shared pieces of `orgai mcp` (cli-spec 6.3): NAME=VALUE parsing, spec building from flags, server and library
 * resolution within the current scope, and the text lines of a server or library entry. Everything a server, the
 * registry or a connector provides is untrusted and goes through safe / safeLine before it reaches the terminal.
 */
import { newId } from '../../../shared/defaults'
import type { McpAuthStatus, McpLibraryEntry, McpLibraryInfo, McpServerInfo, McpServerSpec, McpTestResult, McpTransport } from '../../../shared/types'
import type { McpSecretClash } from '../../../shared/mcpSecretClash'
import { hostCall } from '../../manage'
import { safeLine } from '../../output'
import { CliError, EXIT, type HostClient } from '../../types'

/** Scopes per kind of subcommand (cli-spec 3.3): reads, tests and assist, changes. */
export const READ = ['read'] as const
export const OPERATE = ['read', 'operate'] as const
export const CONFIGURE = ['read', 'configure'] as const

/** mcp:test / mcpLibrary:test may start a stdio server (the probe gives it 20 s); leave room for the round trip. */
export const TEST_TIMEOUT_MS = 60_000

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** An env var or header name as the host validates them, loosely (the host is the gate; this only catches typos). */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

/**
 * `NAME=VALUE` pairs: the first '=' splits (a value may contain '='). An empty name, a missing '=' or the same name
 * twice is exit 2. `flag` names the option in the message.
 */
export function parsePairs(pairs: readonly string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of pairs ?? []) {
    const eq = raw.indexOf('=')
    if (eq === -1) throw usage(`--${flag} needs NAME=VALUE, not "${safeLine(raw).slice(0, 60)}".`)
    const name = raw.slice(0, eq)
    if (!name) throw usage(`--${flag} needs a name before '=' ("${safeLine(raw).slice(0, 60)}").`)
    if (!NAME_RE.test(name)) throw usage(`--${flag}: "${safeLine(name).slice(0, 60)}" is not a valid name.`)
    if (Object.hasOwn(out, name)) throw usage(`--${flag} ${name} was given more than once.`)
    out[name] = raw.slice(eq + 1)
  }
  return out
}

/** Secret slot names (never values): each a valid name, none twice, none also given a plain value. */
export function parseSlots(names: readonly string[] | undefined, flag: string, plain: Record<string, string>): string[] {
  const out: string[] = []
  for (const name of names ?? []) {
    if (name.includes('=')) throw usage(`--${flag} takes a name only; secret values are set with \`orgai mcp set-secret\` (--from-env or --stdin), never on the command line.`)
    if (!NAME_RE.test(name)) throw usage(`--${flag}: "${safeLine(name).slice(0, 60)}" is not a valid name.`)
    if (out.includes(name)) throw usage(`--${flag} ${name} was given more than once.`)
    if (Object.hasOwn(plain, name)) throw usage(`${name} is given both as a plain value and as a secret slot.`)
    out.push(name)
  }
  return out
}

/** The definition flags `mcp add` and `mcp library add` share. */
export const DEFINITION_FLAGS = {
  command: { type: 'string' },
  arg: { type: 'string', multiple: true },
  url: { type: 'string' },
  transport: { type: 'string' },
  env: { type: 'string', multiple: true },
  'secret-var': { type: 'string', multiple: true },
  header: { type: 'string', multiple: true },
  'secret-header': { type: 'string', multiple: true },
  description: { type: 'string' }
} as const

export interface DefinitionValues {
  command?: string
  arg?: string[]
  url?: string
  transport?: string
  env?: string[]
  'secret-var'?: string[]
  header?: string[]
  'secret-header'?: string[]
  description?: string
}

/** The transport-specific fields of a new server from the shared flags (validated by the host's validateSpec). */
export function definitionFrom(name: string, v: DefinitionValues): Pick<McpServerSpec, 'name' | 'transport' | 'command' | 'args' | 'env' | 'secretEnv' | 'url' | 'headers' | 'secretHeaders' | 'description'> {
  if (!name) throw usage('Give the server a name.')
  const hasCommand = v.command !== undefined
  const hasUrl = v.url !== undefined
  if (hasCommand === hasUrl) throw usage('Give exactly one of --command <cmd> (a local stdio server) or --url <url> (a remote server).')
  const description = v.description !== undefined ? { description: v.description } : {}
  if (hasCommand) {
    if (v.transport !== undefined && v.transport !== 'stdio') throw usage('--transport http / sse goes with --url.')
    if (v.header?.length || v['secret-header']?.length) throw usage('--header and --secret-header go with --url; a stdio server takes --env and --secret-var.')
    if (!v.command) throw usage('--command needs the program to run.')
    const env = parsePairs(v.env, 'env')
    const secretEnv = parseSlots(v['secret-var'], 'secret-var', env)
    return {
      name,
      transport: 'stdio',
      command: v.command,
      ...(v.arg?.length ? { args: [...v.arg] } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(secretEnv.length ? { secretEnv } : {}),
      ...description
    }
  }
  if (v.arg?.length) throw usage('--arg goes with --command.')
  if (v.env?.length || v['secret-var']?.length) throw usage('--env and --secret-var go with --command; a remote server takes --header and --secret-header.')
  const transport: McpTransport = v.transport === undefined ? 'http' : (v.transport as McpTransport)
  if (transport !== 'http' && transport !== 'sse') throw usage('--transport must be http or sse with --url.')
  const headers = parsePairs(v.header, 'header')
  const secretHeaders = parseSlots(v['secret-header'], 'secret-header', headers)
  return {
    name,
    transport,
    url: v.url!,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(secretHeaders.length ? { secretHeaders } : {}),
    ...description
  }
}

/** A new project-only server spec (mcp:upsert adds it: the id is new). */
export function newServerSpec(name: string, v: DefinitionValues, enabled: boolean, now = Date.now()): McpServerSpec {
  return { id: newId('mcp'), ...definitionFrom(name, v), enabled, source: 'user', addedAt: new Date(now).toISOString() }
}

/** A new library entry (mcpLibrary:upsert adds it). */
export function newLibraryEntry(name: string, v: DefinitionValues, perProjectSecrets: boolean, now = Date.now()): McpLibraryEntry {
  return { id: newId('mcpl'), ...definitionFrom(name, v), source: 'user', addedAt: new Date(now).toISOString(), ...(perProjectSecrets ? { perProjectSecrets: true } : {}) }
}

// ---------- Resolution (current scope only) ----------

/** One of `items` by exact id, else by name (case-sensitive, then case-insensitive). None or several is exit 2. */
function pick<T>(items: readonly T[], ref: string, idOf: (t: T) => string, nameOf: (t: T) => string, what: string): T {
  if (!ref) throw usage(`Name the ${what}.`)
  const byId = items.find((t) => idOf(t) === ref)
  if (byId) return byId
  let hits = items.filter((t) => nameOf(t) === ref)
  if (hits.length === 0) hits = items.filter((t) => nameOf(t).toLowerCase() === ref.toLowerCase())
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw usage(`More than one ${what} is called "${safeLine(ref)}"; use its id (${hits.map((h) => safeLine(idOf(h))).join(', ')}).`)
  throw usage(`No ${what} "${safeLine(ref).slice(0, 80)}" here.`)
}

/** The project's servers (mcp:list). */
export async function listServers(client: HostClient, projectId: string): Promise<McpServerInfo[]> {
  const list = await hostCall<McpServerInfo[]>(client, 'mcp:list', [projectId])
  return Array.isArray(list) ? list : []
}

/** A server of this project by id or name. */
export async function findServer(client: HostClient, projectId: string, ref: string): Promise<McpServerInfo> {
  return pick(await listServers(client, projectId), ref, (s) => s.spec.id, (s) => s.spec.name, 'MCP server in this project')
}

/** The app-wide library (mcpLibrary:list). */
export async function listLibrary(client: HostClient): Promise<McpLibraryInfo[]> {
  const list = await hostCall<McpLibraryInfo[]>(client, 'mcpLibrary:list', [])
  return Array.isArray(list) ? list : []
}

/** A library entry by id or name. */
export async function findLibrary(client: HostClient, ref: string): Promise<McpLibraryInfo> {
  return pick(await listLibrary(client), ref, (e) => e.entry.id, (e) => e.entry.name, 'MCP library entry')
}

// ---------- Text ----------

/** "authorized (mock@example.com, expires ...)", "not authorized", "error: ...". */
export function authText(a: McpAuthStatus | undefined): string {
  if (!a) return ''
  switch (a.state) {
    case 'notRequired':
      return 'not required'
    case 'notAuthorized':
      return 'not authorized'
    case 'authorized': {
      const extra = [a.account ? safeLine(a.account) : '', a.expiresAt ? `expires ${safeLine(a.expiresAt)}` : ''].filter(Boolean).join(', ')
      return extra ? `authorized (${extra})` : 'authorized'
    }
    case 'expired':
      return 'expired'
    case 'error':
      return a.error ? `error: ${safeLine(a.error)}` : 'error'
    default:
      return safeLine(a.state)
  }
}

/** Short auth word for tables. */
export function authWord(a: McpAuthStatus | undefined): string {
  if (!a) return ''
  return a.state === 'notRequired' ? '-' : a.state === 'notAuthorized' ? 'not authorized' : safeLine(a.state)
}

/** Where a server connects: `command arg ...` or the URL (one sanitized line). */
export function targetText(spec: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url'>): string {
  if (spec.transport === 'stdio') return safeLine([spec.command ?? '', ...(spec.args ?? [])].join(' '))
  return safeLine(spec.url ?? '')
}

/** The quiet clash line (as the Settings row says it; shared/mcpSecretClash.ts). */
export function secretClashLine(clash: McpSecretClash): string {
  const names = clash.others.map((o) => safeLine(o))
  const list = names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Shares the secret name ${safeLine(clash.envName)} with ${list}. On the OpenAI connection, a run starts only one of them when their values differ.`
}

/** Detail lines of a definition shared by `mcp show` and `mcp library show` (values are non-secret by contract). */
export function definitionLines(spec: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url' | 'env' | 'headers' | 'secretEnv' | 'secretHeaders' | 'description' | 'source'>, set: { envSet: string[]; headersSet: string[] }): string[] {
  const lines: string[] = []
  lines.push(`Transport:    ${safeLine(spec.transport)}`)
  lines.push(`${spec.transport === 'stdio' ? 'Command:      ' : 'URL:          '}${targetText(spec)}`)
  if (spec.description) lines.push(`Description:  ${safeLine(spec.description)}`)
  lines.push(`Source:       ${safeLine(spec.source)}`)
  for (const [k, v] of Object.entries(spec.env ?? {})) lines.push(`Env:          ${safeLine(k)}=${safeLine(v)}`)
  for (const [k, v] of Object.entries(spec.headers ?? {})) lines.push(`Header:       ${safeLine(k)}: ${safeLine(v)}`)
  for (const n of spec.secretEnv ?? []) lines.push(`Secret env:   ${safeLine(n)} (${set.envSet.includes(n) ? 'set' : 'missing'})`)
  for (const n of spec.secretHeaders ?? []) lines.push(`Secret header: ${safeLine(n)} (${set.headersSet.includes(n) ? 'set' : 'missing'})`)
  return lines
}

/** The text of an mcp:test / mcpLibrary:test result; the exit code is 0 ok, 5 needs authorization, else 1. */
export function testLines(name: string, r: McpTestResult, authHint: string): { lines: string[]; code: number } {
  const n = safeLine(name)
  if (r.ok) {
    const tools = r.toolDetails?.length ? r.toolDetails : (r.tools ?? []).map((t) => ({ name: t, description: undefined as string | undefined }))
    const lines = [`${n} answered${typeof r.durationMs === 'number' ? ` in ${Math.round(r.durationMs)} ms` : ''} with ${tools.length} tool${tools.length === 1 ? '' : 's'}.`]
    for (const t of tools) lines.push(`  ${safeLine(t.name)}${t.description ? `  ${safeLine(t.description).slice(0, 120)}` : ''}`)
    return { lines, code: EXIT.ok }
  }
  if (r.needsAuthorization) return { lines: [`${n} needs authorization.${r.error ? ` ${safeLine(r.error)}` : ''}`, `Run \`${authHint}\`.`], code: EXIT.auth }
  const lines = [`${n} did not answer: ${safeLine(r.error ?? 'unknown error')}`]
  if (r.stderr) for (const l of r.stderr.split('\n').slice(-10)) if (l.trim()) lines.push(`  ${safeLine(l)}`)
  return { lines, code: EXIT.failure }
}

/** Kebab-case connector / preset id as connectorArgs accepts it (at most 64 characters). */
export const KEBAB_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function checkKebabId(id: string | undefined, what: string): string {
  if (!id) throw usage(`Name the ${what}.`)
  if (id.length > 64 || !KEBAB_ID_RE.test(id)) throw usage(`"${safeLine(id).slice(0, 70)}" is not a ${what} id (kebab-case, at most 64 characters).`)
  return id
}

/** Exit 2 for leftover positionals. */
export function noMore(positionals: readonly string[], from = 0): void {
  if (positionals.length > from) throw usage(`Unexpected argument "${safeLine(positionals[from]).slice(0, 60)}".`)
}
