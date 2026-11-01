import type { CapabilityFlag, CapabilitySourceId, McpServerSpec, McpTransport } from '@shared/types'
import { isValidMcpServerName } from '@shared/defaults'
import { parseJsonc } from '../setup/import/jsonc'
import { parseToml } from '../setup/import/toml'
import { isExactSemver, validateSpec } from '../mcp/validate'
import { capabilityId, clampText, displayPath, isKeyLikeArg, isSecretFlag, scrubUrl, validKeyName } from './sanitize'
import { localPaths, readBoundedText, type LocalLocation } from './paths'
import type { DiscoveredCandidate, LocalContext, SourceResult } from './types'

/**
 * MCP servers named in other tools' config files. DATA ONLY: nothing is spawned, connected or probed. Values of env
 * and headers are never copied (names become secret slots), key-like args and URL queries are dropped, and every
 * other key (auth, oauth, client secrets, header helpers) is left out. Never throws.
 */

export const MCP_FILE_CAP = 1024 * 1024
export const CLAUDE_JSON_CAP = 8 * 1024 * 1024
export const MCP_SERVERS_PER_FILE = 50
export const MCP_TOTAL_CAP = 200
const MAX_ARGS = 64

const LABELS: Record<string, string> = {
  'claude-code-mcp': 'Claude Code',
  'repo-mcp': 'This repository',
  'claude-desktop-mcp': 'Claude Desktop',
  'cursor-mcp': 'Cursor',
  'codex-mcp': 'Codex'
}
const STATUS_LABELS: Record<string, string> = {
  'claude-code-mcp': 'Claude Code MCP servers',
  'repo-mcp': 'Repository MCP servers',
  'claude-desktop-mcp': 'Claude Desktop MCP servers',
  'cursor-mcp': 'Cursor MCP servers',
  'codex-mcp': 'Codex MCP servers'
}

const KNOWN_KEYS = new Set(['command', 'args', 'env', 'envFile', 'url', 'type', 'headers', 'transport', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'serverUrl', 'httpUrl'])
const ENV_SLOT = /^[A-Za-z_][A-Za-z0-9_]*$/

type Json = Record<string, unknown>

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normPath(p: string, platform: NodeJS.Platform): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (platform === 'win32' || platform === 'darwin') s = s.toLowerCase()
  return s
}

/** A version taken from a pinned package argument (npm `pkg@1.2.3`, PyPI `pkg==1.2.3`), when there is one. */
function pinnedVersion(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith('-')) continue
    const at = a.lastIndexOf('@')
    if (at > 0) {
      const v = a.slice(at + 1)
      if (isExactSemver(v)) return v.replace(/^v/, '')
    }
    const eq = /^[\w.-]+==(\d[\w.+-]*)$/.exec(a)
    if (eq) return eq[1]
  }
  return undefined
}

interface Built {
  candidate: DiscoveredCandidate
}

function buildServer(
  rawName: string,
  raw: unknown,
  opts: { source: CapabilitySourceId; origin: 'repo' | 'local'; fileDisplay: string; scopeKey: string; home: string; warn: (m: string) => void }
): Built | null {
  const { source, origin } = opts
  const sourceLabel = LABELS[source] ?? 'Local config'
  let name = rawName
  const notes: string[] = []
  if (!isValidMcpServerName(name)) {
    const norm = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
    if (!norm || !isValidMcpServerName(norm)) {
      opts.warn(`Skipped a server with an unusable name (${clampText(rawName, 40)}).`)
      return null
    }
    name = norm
    notes.push(`Renamed from "${clampText(rawName, 40)}" to fit OrgAI's naming.`)
  }
  if (!isObj(raw)) {
    opts.warn(`Skipped ${name}: the entry is not an object.`)
    return null
  }
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : typeof raw.transport === 'string' ? raw.transport.toLowerCase() : ''
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const urlRaw = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : typeof raw.httpUrl === 'string' ? raw.httpUrl : ''
  let transport: McpTransport
  if (command && (type === '' || type === 'stdio')) transport = 'stdio'
  else if (type === 'sse') transport = 'sse'
  else if (type === 'http' || type === 'streamable-http' || type === 'streamablehttp' || (type === '' && urlRaw)) transport = 'http'
  else if (command) transport = 'stdio'
  else {
    opts.warn(`Skipped ${name}: no command or URL, or an unsupported type.`)
    return null
  }

  const spec: McpServerSpec = { id: '', name, transport, enabled: true, source: 'local', addedAt: '', description: `From ${sourceLabel}` }
  let target = ''
  let kept: string[] = []

  if (transport === 'stdio') {
    if (!command || /[\u0000-\u001f\u007f]/.test(command) || command.length > 1000) {
      opts.warn(`Skipped ${name}: the command is empty or contains control characters.`)
      return null
    }
    spec.command = command
    const rawArgs = Array.isArray(raw.args) ? raw.args : []
    if (rawArgs.length > MAX_ARGS) {
      opts.warn(`Skipped ${name}: more than ${MAX_ARGS} arguments.`)
      return null
    }
    let dropped = 0
    let skipNext = false
    for (const a of rawArgs) {
      if (typeof a !== 'string' || a.includes('\0') || a.length > 2000) {
        dropped++
        skipNext = false
        continue
      }
      if (skipNext) {
        skipNext = false
        if (!a.startsWith('-')) {
          dropped++
          continue
        }
      }
      if (isKeyLikeArg(a) || (/^https?:\/\//i.test(a) && (a.includes('?') || a.includes('#') || /^https?:\/\/[^/]*@/i.test(a)))) {
        dropped++
        continue
      }
      kept.push(a)
      if (isSecretFlag(a)) skipNext = true
    }
    if (dropped) notes.push(`${dropped} argument${dropped === 1 ? '' : 's'} looked like a key and ${dropped === 1 ? 'was' : 'were'} left out; add ${dropped === 1 ? 'it' : 'them'} as a secret after adding.`)
    spec.args = kept
    target = [command, ...kept].join(' ')
    const names = new Set<string>()
    if (isObj(raw.env)) {
      for (const k of Object.keys(raw.env)) {
        if (names.size >= 50) break
        if (ENV_SLOT.test(k) && validKeyName(k)) names.add(k)
        else notes.push('An environment variable with an unusual name was left out.')
      }
    }
    if (isObj(raw.env_http_headers) || isObj(raw.http_headers) || isObj(raw.headers)) notes.push('Headers do not apply to a command server and were left out.')
    if (typeof raw.envFile === 'string') notes.push('The config points to an env file; its values were not read. Add the variables as secrets.')
    if (names.size) spec.secretEnv = [...names]
  } else {
    const scrubbed = scrubUrl(urlRaw)
    if (!scrubbed) {
      opts.warn(`Skipped ${name}: the URL is missing or not a plain http(s) address.`)
      return null
    }
    if (/[?#]|\/\/[^/]*@/.test(urlRaw)) notes.push('The URL had a query, fragment or login part; it was left out.')
    spec.url = scrubbed
    target = scrubbed
    const names = new Set<string>()
    for (const holder of [raw.headers, raw.http_headers, raw.env_http_headers]) {
      if (!isObj(holder)) continue
      for (const k of Object.keys(holder)) {
        if (names.size >= 50) break
        if (validKeyName(k) && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) names.add(k)
        else notes.push('A header with an unusual name was left out.')
      }
    }
    if (typeof raw.bearer_token_env_var === 'string') {
      names.add('Authorization')
      notes.push('The config reads a bearer token from an environment variable; add it as the Authorization secret.')
    }
    if (isObj(raw.env)) notes.push('Environment variables do not apply to a remote server and were left out.')
    if (names.size) spec.secretHeaders = [...names]
  }

  const droppedKeys = Object.keys(raw)
    .filter((k) => !KNOWN_KEYS.has(k) && validKeyName(k))
    .slice(0, 6)
  if (droppedKeys.length) notes.push(`Left out: ${droppedKeys.join(', ')}.`)

  const errors = validateSpec({ ...spec, id: 'placeholder' })
  const needsSecrets = [...(spec.secretEnv ?? []), ...(spec.secretHeaders ?? [])]
  const flags: CapabilityFlag[] = transport === 'stdio' ? ['runsCode'] : ['remote']
  const version = transport === 'stdio' ? pinnedVersion(kept) : undefined
  const item: DiscoveredCandidate['item'] = {
    id: capabilityId(origin, 'mcp', `${opts.fileDisplay}#${opts.scopeKey}${name}`, name),
    kind: 'mcp',
    origin,
    source,
    sourceLabel,
    location: opts.fileDisplay,
    name,
    description: clampText(`From ${sourceLabel}`),
    transport,
    target: clampText(target, 200),
    flags,
    needsSecrets,
    notes: notes.map((n) => clampText(n, 200)).filter((n, i, all) => all.indexOf(n) === i).slice(0, 8)
  }
  if (version) item.version = version
  if (errors.length) item.blockedReason = clampText(errors.join(' '), 300)
  return { candidate: { item, payload: { type: 'mcpSpec', spec } } }
}

interface FileCtx {
  source: CapabilitySourceId
  origin: 'repo' | 'local'
  display: string
  home: string
  out: SourceResult
  budget: { left: number }
}

/** Servers of one `{name: entry}` map, in file order, capped. Returns how many were added. */
function addServers(map: unknown, scopeKey: string, f: FileCtx): number {
  if (!isObj(map)) return 0
  const warn = (message: string): void => {
    f.out.warnings.push({ source: f.source, location: f.display, message })
  }
  let added = 0
  let seen = 0
  for (const [rawName, raw] of Object.entries(map)) {
    if (++seen > MCP_SERVERS_PER_FILE) {
      warn(`Only the first ${MCP_SERVERS_PER_FILE} servers of this file are listed.`)
      break
    }
    if (f.budget.left <= 0) {
      warn(`Only ${MCP_TOTAL_CAP} servers are listed in all.`)
      break
    }
    const built = buildServer(rawName, raw, { source: f.source, origin: f.origin, fileDisplay: f.display, scopeKey, home: f.home, warn })
    if (!built) continue
    f.budget.left--
    added++
    f.out.candidates.push(built.candidate)
  }
  return added
}

type Parsed = { ok: true; value: unknown } | { ok: false; reason: string; missing: boolean }

function readConfig(loc: LocalLocation, cap: number, kind: 'json' | 'jsonc' | 'toml'): Parsed {
  const read = readBoundedText(loc.path, loc.base, cap)
  if (!read.ok) return { ok: false, reason: read.reason, missing: read.state === 'missing' }
  if (kind === 'toml') {
    const r = parseToml(read.text)
    if (r.error && Object.keys(r.data).length === 0) return { ok: false, reason: 'is not valid TOML, skipped', missing: false }
    return { ok: true, value: r.data }
  }
  if (kind === 'json') {
    try {
      return { ok: true, value: JSON.parse(read.text) }
    } catch {
      return { ok: false, reason: 'is not valid JSON, skipped', missing: false }
    }
  }
  const r = parseJsonc(read.text)
  if (r.error || r.value === undefined) return { ok: false, reason: 'is not valid JSON, skipped', missing: false }
  return { ok: true, value: r.value }
}

export function discoverLocalMcp(ctx: LocalContext): SourceResult {
  const out: SourceResult = { candidates: [], sources: [], warnings: [] }
  const budget = { left: MCP_TOTAL_CAP }
  try {
    const paths = localPaths(ctx)
    const home = ctx.homeDir

    const run = (
      source: CapabilitySourceId,
      origin: 'repo' | 'local',
      files: Array<{ loc: LocalLocation; display: string; cap: number; kind: 'json' | 'jsonc' | 'toml'; extract: (v: unknown, f: FileCtx) => number }>
    ): void => {
      const before = out.candidates.length
      const locations: string[] = []
      let anyRead = false
      let error: string | undefined
      for (const file of files) {
        locations.push(file.display)
        const parsed = readConfig(file.loc, file.cap, file.kind)
        if (!parsed.ok) {
          if (!parsed.missing) {
            out.warnings.push({ source, location: file.display, message: `Skipped: the file ${parsed.reason}.` })
            error = `${file.display} ${parsed.reason}.`
          }
          continue
        }
        anyRead = true
        try {
          file.extract(parsed.value, { source, origin, display: file.display, home, out, budget })
        } catch {
          out.warnings.push({ source, location: file.display, message: 'Skipped: the file could not be understood.' })
        }
      }
      const count = out.candidates.length - before
      const state = count ? 'found' : anyRead ? 'empty' : error ? 'error' : 'missing'
      out.sources.push({
        source,
        label: STATUS_LABELS[source] ?? 'MCP servers',
        locations: locations.slice(0, 10),
        state,
        count,
        ...(state === 'error' && error ? { message: error } : {})
      })
    }

    if (paths.claudeJson) {
      const loc = paths.claudeJson
      run('claude-code-mcp', 'local', [
        {
          loc,
          display: displayPath(loc.path, home),
          cap: CLAUDE_JSON_CAP,
          kind: 'json',
          extract: (v, f) => {
            if (!isObj(v)) return 0
            let n = addServers(v.mcpServers, '', f)
            if (isObj(v.projects)) {
              const want = normPath(ctx.projectPath, ctx.platform)
              for (const [key, entry] of Object.entries(v.projects)) {
                if (normPath(key, ctx.platform) !== want || !isObj(entry)) continue
                n += addServers(entry.mcpServers, 'project#', f)
              }
            }
            return n
          }
        }
      ])
    }
    run(
      'repo-mcp',
      'repo',
      paths.repo.map((r) => ({
        loc: r,
        display: r.display,
        cap: MCP_FILE_CAP,
        kind: 'jsonc' as const,
        extract: (v: unknown, f: FileCtx): number => (isObj(v) ? addServers(v[r.key], '', f) : 0)
      }))
    )
    if (paths.claudeDesktop) {
      const loc = paths.claudeDesktop
      run('claude-desktop-mcp', 'local', [{ loc, display: displayPath(loc.path, home), cap: MCP_FILE_CAP, kind: 'json', extract: (v, f) => (isObj(v) ? addServers(v.mcpServers, '', f) : 0) }])
    }
    if (paths.cursor) {
      const loc = paths.cursor
      run('cursor-mcp', 'local', [{ loc, display: displayPath(loc.path, home), cap: MCP_FILE_CAP, kind: 'jsonc', extract: (v, f) => (isObj(v) ? addServers(v.mcpServers, '', f) : 0) }])
    }
    if (paths.codex) {
      const loc = paths.codex
      run('codex-mcp', 'local', [{ loc, display: displayPath(loc.path, home), cap: MCP_FILE_CAP, kind: 'toml', extract: (v, f) => (isObj(v) ? addServers(v.mcp_servers, '', f) : 0) }])
    }
  } catch {
    out.warnings.push({ source: 'claude-code-mcp', message: 'Local MCP configs could not be read.' })
  }
  return out
}
