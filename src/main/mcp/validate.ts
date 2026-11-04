import type { McpLibraryEntry, McpRegistryEntry, McpServerSpec } from '@shared/types'
import { MCP_OVERRIDE_VALUE_MAX, MCP_PER_PROJECT_ENV_MAX } from '@shared/types'
import { SAFE_ID, isValidMcpServerName, newId } from '@shared/defaults'
import { hiddenCharIn, hiddenCharProblem } from '../capabilities/sanitize'

/**
 * Validation of MCP server specs and building specs from registry entries. Pure; shared by the settings
 * service, the install flow in RunManager and the harness tools. The point of the version rules: an agent
 * (or a registry entry) must not be able to make OrgAI run "whatever is newest" of a package.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const MAX_ARGS = 64
const MAX_STR = 2000

/** Exact semver: 1.2.3, optionally with a prerelease or build suffix. No ranges, tags or wildcards. */
const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/** Exact PEP 440-ish version: 1.2.3, 2024.1, 1.0rc1, 1.0.post1. */
const PEP440 = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/

export function isExactSemver(v: string): boolean {
  return SEMVER.test(v)
}

/** `pkg@1.2.3` / `@scope/pkg@1.2.3`: null when valid, else the reason. */
function checkNpmSpec(spec: string): string | null {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return `"${spec}" has no version; use package@<exact version>.`
  const version = spec.slice(at + 1)
  if (!isExactSemver(version)) return `"${spec}" is not pinned to an exact version (got "${version}"); use package@1.2.3, not latest, a range, ^, ~ or x.`
  return null
}

function checkPySpec(spec: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?==(.+)$/.exec(spec)
  if (!m) return `"${spec}" is not pinned; use package==<exact version>.`
  if (!PEP440.test(m[2])) return `"${spec}" does not use an exact version (got "${m[2]}"); wildcards and ranges are not allowed.`
  return null
}

const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '--prefix'])
const UVX_VALUE_FLAGS = new Set([
  '--with',
  '--with-requirements',
  '--with-editable',
  '-p',
  '--python',
  '--index-url',
  '-i',
  '--extra-index-url',
  '--index',
  '--env-file',
  '--directory',
  '--project',
  '--config-file',
  '--constraints',
  '-c',
  '--overrides',
  '--isolated-env',
  '--no-config-file',
  '--python-preference',
  '--resolution'
])
const DOCKER_VALUE_FLAGS = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '-w',
  '--workdir',
  '--network',
  '--net',
  '-u',
  '--user',
  '--mount',
  '--entrypoint',
  '--platform',
  '--add-host',
  '-l',
  '--label',
  '-m',
  '--memory',
  '--cpus',
  '--pull',
  '--cap-add',
  '--cap-drop',
  '--device',
  '--hostname',
  '-h',
  '--tmpfs',
  '--security-opt',
  '--restart',
  '--log-driver'
])

/** First non-flag argument, skipping the values of flags that take one. */
function firstPositional(args: string[], valueFlags: Set<string>, from = 0): { value?: string; index: number } {
  for (let i = from; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return { value: args[i + 1], index: i + 1 }
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(a)) i++
      continue
    }
    return { value: a, index: i }
  }
  return { index: args.length }
}

function basename(cmd: string): string {
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd
  return base.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '')
}

/** Version-pinning problems of a stdio launch, empty when the command is not a package launcher or is pinned. */
export function pinErrors(command: string, args: string[]): string[] {
  const cmd = basename(command)
  const errors: string[] = []
  const push = (m: string | null): void => {
    if (m) errors.push(m)
  }
  const npmLike = (a: string[]): void => {
    // `-p pkg@x cmd` names the package with a flag; otherwise the first positional is the package.
    const flagged: string[] = []
    for (let i = 0; i < a.length; i++) if ((a[i] === '-p' || a[i] === '--package') && a[i + 1]) flagged.push(a[i + 1])
    if (flagged.length) {
      for (const f of flagged) push(checkNpmSpec(f))
      return
    }
    const { value } = firstPositional(a, NPX_VALUE_FLAGS)
    if (!value) errors.push('No package to launch; pass package@<exact version>.')
    else push(checkNpmSpec(value))
  }
  if (cmd === 'npx' || cmd === 'bunx') npmLike(args)
  else if (cmd === 'pnpm' || cmd === 'yarn') {
    if (args[0] === 'dlx') npmLike(args.slice(1))
  } else if (cmd === 'npm') {
    if (args[0] === 'exec' || args[0] === 'x') npmLike(args.slice(1))
  } else if (cmd === 'uvx') {
    const fromIdx = args.findIndex((a) => a === '--from')
    const fromEq = args.find((a) => a.startsWith('--from='))
    if (fromIdx >= 0 && args[fromIdx + 1]) push(checkPySpec(args[fromIdx + 1]))
    else if (fromEq) push(checkPySpec(fromEq.slice('--from='.length)))
    else {
      const { value } = firstPositional(args, UVX_VALUE_FLAGS)
      if (!value) errors.push('No package to launch; pass package==<exact version>.')
      else push(checkPySpec(value))
    }
  } else if (cmd === 'docker' || cmd === 'podman') {
    if (args[0] === 'run' || args[0] === 'container') {
      const rest = args[0] === 'container' ? args.slice(2) : args.slice(1)
      const { value: image } = firstPositional(rest, DOCKER_VALUE_FLAGS)
      if (!image) errors.push('No image to run.')
      else if (!/@sha256:[0-9a-f]{16,}$/i.test(image)) {
        const afterSlash = image.slice(image.lastIndexOf('/') + 1)
        const colon = afterSlash.lastIndexOf(':')
        const tag = colon >= 0 ? afterSlash.slice(colon + 1) : ''
        if (!tag) errors.push(`Image "${image}" has no tag; use image:<version> or an @sha256 digest.`)
        else if (/^(latest|stable|main|master|edge|dev|nightly|current)$/i.test(tag)) errors.push(`Image "${image}" uses the floating tag "${tag}"; pin a version tag or an @sha256 digest.`)
      }
    }
  }
  return errors
}

function tooLong(s: unknown): boolean {
  return typeof s === 'string' && s.length > MAX_STR
}

/**
 * All problems with a spec; empty = valid. `existing` is the project's current servers: the name must be
 * unique among entries with a different id.
 */
export function validateSpec(spec: McpServerSpec, existing: readonly McpServerSpec[] = [], where: 'project' | 'library' = 'project'): string[] {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return ['The server spec is missing.']
  // Hidden characters first and alone: the checks below quote names and args, which would echo them.
  const hidden = hiddenCharProblems(spec)
  if (hidden.length) return hidden
  if (typeof spec.id !== 'string' || !SAFE_ID.test(spec.id)) errors.push('The server id must be 1-128 letters, digits, hyphens or underscores.')
  if (typeof spec.name !== 'string' || !isValidMcpServerName(spec.name)) {
    errors.push('The name must be lowercase kebab-case (letters, digits and single hyphens, at most 48 characters), e.g. "github".')
  } else if (existing.some((s) => s.name === spec.name && s.id !== spec.id)) {
    errors.push(`A server named "${spec.name}" already exists in ${where === 'library' ? 'the MCP library' : 'this project'}.`)
  }
  if (spec.transport !== 'stdio' && spec.transport !== 'http' && spec.transport !== 'sse') errors.push('The transport must be stdio, http or sse.')
  if (spec.transport === 'stdio') {
    if (typeof spec.command !== 'string' || !spec.command.trim()) errors.push('A stdio server needs a command.')
    else if (/[\r\n\0]/.test(spec.command) || tooLong(spec.command)) errors.push('The command contains invalid characters or is too long.')
    if (spec.url) errors.push('A stdio server cannot have a URL.')
    if (spec.headers && Object.keys(spec.headers).length) errors.push('A stdio server cannot have headers; use env.')
    if (spec.secretHeaders?.length) errors.push('A stdio server cannot have secret headers; use secretEnv.')
  } else if (spec.transport === 'http' || spec.transport === 'sse') {
    let ok = false
    if (typeof spec.url === 'string') {
      try {
        const u = new URL(spec.url)
        ok = u.protocol === 'http:' || u.protocol === 'https:'
      } catch {
        ok = false
      }
    }
    if (!ok) errors.push(`A ${spec.transport} server needs an http(s) URL.`)
    if (tooLong(spec.url)) errors.push('The URL is too long.')
    if (spec.command) errors.push(`A ${spec.transport} server cannot have a command.`)
    if (spec.env && Object.keys(spec.env).length) errors.push(`A ${spec.transport} server cannot have env variables; use headers.`)
    if (spec.secretEnv?.length) errors.push(`A ${spec.transport} server cannot have secret env variables; use secretHeaders.`)
  }
  if (spec.args !== undefined) {
    if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string' || /[\0]/.test(a) || tooLong(a))) errors.push('The arguments must be strings.')
    else if (spec.args.length > MAX_ARGS) errors.push(`At most ${MAX_ARGS} arguments are allowed.`)
  }
  const env = spec.env ?? {}
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) errors.push(`Environment variable "${k}" is not a valid name.`)
    if (typeof v !== 'string' || tooLong(v)) errors.push(`Environment variable "${k}" must have a short string value.`)
  }
  const headers = spec.headers ?? {}
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME.test(k)) errors.push(`Header "${k}" is not a valid name.`)
    if (typeof v !== 'string' || /[\r\n]/.test(v) || tooLong(v)) errors.push(`Header "${k}" must have a single-line string value.`)
  }
  const seenEnv = new Set<string>()
  for (const n of spec.secretEnv ?? []) {
    if (typeof n !== 'string' || !ENV_NAME.test(n)) errors.push(`Secret environment variable "${String(n)}" is not a valid name.`)
    else if (seenEnv.has(n)) errors.push(`Secret environment variable "${n}" is listed twice.`)
    else if (Object.hasOwn(env, n)) errors.push(`"${n}" is both a secret and a plain environment variable; keep it only in secretEnv.`)
    seenEnv.add(String(n))
  }
  const lowerHeaders = new Set(Object.keys(headers).map((h) => h.toLowerCase()))
  const seenHeader = new Set<string>()
  for (const n of spec.secretHeaders ?? []) {
    if (typeof n !== 'string' || !HEADER_NAME.test(n)) errors.push(`Secret header "${String(n)}" is not a valid name.`)
    else if (seenHeader.has(n.toLowerCase())) errors.push(`Secret header "${n}" is listed twice.`)
    else if (lowerHeaders.has(n.toLowerCase())) errors.push(`"${n}" is both a secret and a plain header; keep it only in secretHeaders.`)
    seenHeader.add(String(n).toLowerCase())
  }
  if (spec.transport === 'stdio' && typeof spec.command === 'string' && spec.command.trim() && Array.isArray(spec.args ?? [])) {
    errors.push(...pinErrors(spec.command.trim(), spec.args ?? []))
  }
  return errors
}

/**
 * One refusal per spec field holding a control, zero-width, bidi or other invisible character (capabilities/sanitize.ts
 * hiddenCharIn). Every field is one line (no control character at all, so a card that clamps a value to one line never
 * hides the rest of it) except the description, which is prose: tab and line breaks, ZWJ, ZWNJ, soft hyphen and tag
 * characters (emoji, Persian and Indic text) are allowed there; bidi marks, zero-width space and controls are not.
 * Proposals, library entries and settings edits all pass here.
 */
export function hiddenCharProblems(spec: Partial<McpServerSpec>): string[] {
  const out: string[] = []
  const one = (field: string, v: unknown): void => {
    const p = hiddenCharProblem(field, v)
    if (p) out.push(p)
  }
  one('The name', spec.name)
  one('The command', spec.command)
  one('The URL', spec.url)
  const prose = hiddenCharProblem('The description', spec.description, { prose: true })
  if (prose) out.push(prose)
  if (Array.isArray(spec.args)) spec.args.forEach((a, i) => one(`Argument ${i + 1}`, a))
  for (const [k, v] of Object.entries(spec.env && typeof spec.env === 'object' ? spec.env : {})) {
    one('An environment variable name', k)
    one(`Environment variable ${safeLabel(k)}`, v)
  }
  for (const [k, v] of Object.entries(spec.headers && typeof spec.headers === 'object' ? spec.headers : {})) {
    one('A header name', k)
    one(`Header ${safeLabel(k)}`, v)
  }
  for (const n of Array.isArray(spec.secretEnv) ? spec.secretEnv : []) one('A secret environment variable name', n)
  for (const n of Array.isArray(spec.secretHeaders) ? spec.secretHeaders : []) one('A secret header name', n)
  for (const r of Array.isArray(spec.roles) ? spec.roles : []) one('A role slug', r)
  return out
}

/** A name quoted for a message only when it is plain; otherwise it is left out (never echo hidden characters). */
function safeLabel(name: string): string {
  return /^[\w.-]{1,64}$/.test(name) ? `"${name}"` : '(unnamed)'
}

/** Library ids double as secret-key segments, so they stay in a safe alphabet. */
export const LIBRARY_ID = SAFE_ID

/**
 * Env names that change what runs (loader, interpreter-option, package-index, proxy and path variables). Copied from
 * capabilities/outside.ts RISKY_ENV; keep the two in sync.
 */
const RISKY_ENV = /^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|SHELL|TMPDIR|TEMP|TMP|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_\w*|DYLD_\w*|PYTHON\w*|NPM_CONFIG_\w*|YARN_\w*|PNPM_\w*|UV_\w*|PIP_\w*|DOCKER_\w*|BUN_\w*|DENO_\w*|RUBYOPT|RUBYLIB|GEM_\w*|PERL5\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GIT_\w*|SSL_CERT_\w*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|\w*_PROXY)$/i
/** Header names that carry a credential or change routing; never overridable per project. */
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|cookie|x-api-key|host|forwarded|x-forwarded-\w+|proxy-\w+)$/i
/** Names that look like a credential, whatever the transport. */
const CREDENTIAL_LIKE = /(secret|token|passw|api[-_]?key|credential|auth)/i

/**
 * Problems with the per-project fields of a library entry (perProjectSecrets, perProjectEnv). Pure. Both are refused
 * on connector entries. Names are never echoed unless plain.
 */
export function perProjectEnvProblems(entry: McpLibraryEntry): string[] {
  const out: string[] = []
  if (!entry || typeof entry !== 'object') return out
  const hasSecrets = 'perProjectSecrets' in entry && entry.perProjectSecrets !== undefined
  const hasEnv = 'perProjectEnv' in entry && entry.perProjectEnv !== undefined
  if (!hasSecrets && !hasEnv) return out
  if (hasSecrets && (entry.perProjectSecrets as unknown) !== true) out.push('perProjectSecrets must be true or left out.')
  if (entry.connectorId) {
    out.push('Per-project values are not available for connectors yet; add a custom server instead.')
    return out
  }
  if (!hasEnv) return out
  const names = entry.perProjectEnv as unknown
  if (!Array.isArray(names)) return [...out, 'perProjectEnv must be a list of names.']
  if (names.length > MCP_PER_PROJECT_ENV_MAX) return [...out, `At most ${MCP_PER_PROJECT_ENV_MAX} per-project names are allowed.`]
  const stdio = entry.transport === 'stdio'
  const kind = stdio ? 'environment variable' : 'header'
  const secrets = new Set((stdio ? entry.secretEnv ?? [] : entry.secretHeaders ?? []).map((n) => (stdio ? String(n) : String(n).toLowerCase())))
  const seen = new Set<string>()
  for (const raw of names) {
    if (typeof raw !== 'string') {
      out.push('A per-project name must be text.')
      continue
    }
    const hidden = hiddenCharProblem('A per-project name', raw)
    if (hidden) {
      out.push(hidden)
      continue
    }
    const label = safeLabel(raw)
    if (raw === '__proto__' || !(stdio ? ENV_NAME : HEADER_NAME).test(raw)) {
      out.push(`${label} is not a valid ${kind} name.`)
      continue
    }
    const key = stdio ? raw : raw.toLowerCase()
    if (seen.has(key)) {
      out.push(`${label} is listed twice.`)
      continue
    }
    seen.add(key)
    if (secrets.has(key)) out.push(`${label} is a secret slot; secrets are set per project through perProjectSecrets, not listed here.`)
    else if (CREDENTIAL_LIKE.test(raw) || (!stdio && CREDENTIAL_HEADER.test(raw))) out.push(`${label} looks like a credential; make it a secret slot instead.`)
    else if (stdio ? RISKY_ENV.test(raw) : CREDENTIAL_HEADER.test(raw)) out.push(`${label} changes what runs or where it connects, so a project cannot override it.`)
  }
  return out
}

/**
 * The overrides a project may set for the names in `allowed`: own string keys in `allowed` are kept, every other key is
 * dropped silently. A value that is not a string, holds a control or hidden character (header values may hold a tab,
 * never a line break) or is longer than MCP_OVERRIDE_VALUE_MAX throws a readable Error that never echoes the value.
 */
export function cleanOverrides(raw: unknown, allowed: readonly string[], kind: 'env' | 'header'): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The per-project values must be a list of names and values.')
  const what = kind === 'env' ? 'Environment variable' : 'Header'
  for (const name of allowed) {
    if (name === '__proto__' || !Object.hasOwn(raw, name)) continue
    const v = (raw as Record<string, unknown>)[name]
    const label = safeLabel(name)
    if (typeof v !== 'string') throw new Error(`${what} ${label} must have a text value.`)
    if (v.length > MCP_OVERRIDE_VALUE_MAX) throw new Error(`${what} ${label} is too long (at most ${MCP_OVERRIDE_VALUE_MAX} characters).`)
    if (kind === 'header' && /[\r\n]/.test(v)) throw new Error(`Header ${label} must be a single line.`)
    if (hiddenCharIn(v, { multiline: kind === 'header' })) throw new Error(`${what} ${label} contains a control or hidden character; remove it.`)
    out[name] = v
  }
  return out
}

/** Problems with a library entry; names are unique within the library. */
export function validateLibraryEntry(entry: McpLibraryEntry, existing: readonly McpLibraryEntry[] = []): string[] {
  if (!entry || typeof entry !== 'object') return ['The library entry is missing.']
  const errors: string[] = []
  if (typeof entry.id !== 'string' || !LIBRARY_ID.test(entry.id)) errors.push('The library entry id must be 1-128 letters, digits, hyphens or underscores.')
  const asSpec = (e: McpLibraryEntry): McpServerSpec => ({ ...e, enabled: true })
  errors.push(...validateSpec(asSpec(entry), existing.map(asSpec), 'library'))
  errors.push(...perProjectEnvProblems(entry))
  return errors
}

/** Whether two definitions launch the same server (a proposal item whose name matches an existing library entry). */
export function sameDefinition(a: McpLibraryEntry | McpServerSpec, b: McpLibraryEntry | McpServerSpec): boolean {
  const key = (e: McpLibraryEntry | McpServerSpec): string =>
    JSON.stringify([e.transport, e.command ?? '', e.args ?? [], e.url ?? '', Object.entries(e.env ?? {}).sort(), Object.entries(e.headers ?? {}).sort(), [...(e.secretEnv ?? [])].sort(), [...(e.secretHeaders ?? [])].sort()])
  return key(a) === key(b)
}

export function assertValidLibraryEntry(entry: McpLibraryEntry, existing: readonly McpLibraryEntry[] = []): void {
  const errors = validateLibraryEntry(entry, existing)
  if (errors.length) throw new Error(errors.join(' '))
}

/** Throws one readable Error listing every problem. */
export function assertValidSpec(spec: McpServerSpec, existing: readonly McpServerSpec[] = []): void {
  const errors = validateSpec(spec, existing)
  if (errors.length) throw new Error(errors.join(' '))
}

/** The registry may already put the tag or digest in the OCI identifier. */
function imageRef(identifier: string, version: string): string {
  if (/@sha256:/i.test(identifier)) return identifier
  return identifier.slice(identifier.lastIndexOf('/') + 1).includes(':') ? identifier : `${identifier}:${version}`
}

export type RegistryChoice = { type: 'package'; index: number } | { type: 'remote'; index: number }

/** A kebab-case server name from a registry name such as "io.github.owner/my_server". */
export function nameFromRegistry(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'server'
}

/**
 * Build a spec from a registry package or remote. Package launchers are always pinned to the entry's
 * package version. Throws for package types OrgAI cannot launch (nuget, mcpb, ...). The result is not yet
 * validated or checked for name clashes; run validateSpec on it.
 */
export function specFromRegistry(entry: McpRegistryEntry, choice: RegistryChoice = { type: 'package', index: 0 }, now = new Date()): McpServerSpec {
  const base = {
    id: newId('mcp'),
    name: nameFromRegistry(entry.name),
    enabled: true,
    source: 'registry' as const,
    ...(entry.description ? { description: entry.description.slice(0, 200) } : {}),
    addedAt: now.toISOString()
  }
  if (choice.type === 'remote') {
    const remote = entry.remotes[choice.index]
    if (!remote) throw new Error('That registry entry has no such remote.')
    const secretHeaders = (remote.headers ?? []).filter((h) => h.isSecret).map((h) => h.name)
    const headers: Record<string, string> = {}
    for (const h of remote.headers ?? []) if (!h.isSecret && h.default !== undefined) headers[h.name] = h.default
    return {
      ...base,
      transport: remote.type === 'sse' ? 'sse' : 'http',
      url: remote.url,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(secretHeaders.length ? { secretHeaders } : {}),
      registry: { name: entry.name, version: entry.version, registryType: 'remote', identifier: remote.url }
    }
  }
  const pkg = entry.packages[choice.index]
  if (!pkg) throw new Error('That registry entry has no such package.')
  if (pkg.transport.type !== 'stdio') throw new Error(`The ${pkg.registryType} package uses the ${pkg.transport.type} transport, which OrgAI cannot launch; use its remote endpoint instead.`)
  const secretEnv = pkg.environmentVariables.filter((v) => v.isSecret).map((v) => v.name)
  const env: Record<string, string> = {}
  for (const v of pkg.environmentVariables) if (!v.isSecret && v.default !== undefined) env[v.name] = v.default
  let command: string
  let args: string[]
  switch (pkg.registryType) {
    case 'npm':
      command = 'npx'
      args = ['-y', `${pkg.identifier}@${pkg.version}`]
      break
    case 'pypi':
      command = 'uvx'
      args = [`${pkg.identifier}==${pkg.version}`]
      break
    case 'oci':
      command = 'docker'
      // `-e NAME` forwards the variable from docker's own environment, so values never appear in args.
      args = ['run', '-i', '--rm', ...pkg.environmentVariables.filter((v) => v.isSecret || env[v.name] !== undefined).flatMap((v) => ['-e', v.name]), imageRef(pkg.identifier, pkg.version)]
      break
    default:
      throw new Error(`OrgAI cannot launch ${pkg.registryType} packages yet.`)
  }
  return {
    ...base,
    transport: 'stdio',
    command,
    args,
    ...(Object.keys(env).length ? { env } : {}),
    ...(secretEnv.length ? { secretEnv } : {}),
    registry: { name: entry.name, version: entry.version, registryType: pkg.registryType, identifier: pkg.identifier }
  }
}
