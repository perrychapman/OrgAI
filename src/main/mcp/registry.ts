import type {
  McpRegistryEntry,
  McpRegistryEnvVar,
  McpRegistryPackage,
  McpRegistryRemote,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpRegistryTransport
} from '@shared/types'

/**
 * Client for the official MCP Registry. Everything the registry returns is untrusted data: this module only
 * normalizes and clamps it. Callers must never interpolate registry strings into instructions.
 */

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers'
export const REGISTRY_TIMEOUT_MS = 10_000
export const REGISTRY_MAX_LIMIT = 50
export const REGISTRY_DEFAULT_LIMIT = 20

const MAX_NAME = 200
const MAX_TEXT = 600
const MAX_URL = 500
const MAX_ENV = 40
const MAX_PACKAGES = 12

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return t ? t.slice(0, max) : undefined
}

function envVars(raw: unknown): McpRegistryEnvVar[] {
  if (!Array.isArray(raw)) return []
  const out: McpRegistryEnvVar[] = []
  for (const r of raw.slice(0, MAX_ENV)) {
    if (!isObj(r)) continue
    const name = str(r.name, 120)
    if (!name) continue
    const v: McpRegistryEnvVar = { name, isSecret: r.isSecret === true }
    const description = str(r.description, MAX_TEXT)
    if (description) v.description = description
    if (typeof r.isRequired === 'boolean') v.isRequired = r.isRequired
    const def = str(r.default ?? r.value, MAX_TEXT)
    if (def !== undefined && !v.isSecret) v.default = def
    out.push(v)
  }
  return out
}

function transportType(v: unknown): McpRegistryTransport | undefined {
  if (v === 'stdio' || v === 'sse') return v
  if (v === 'streamable-http' || v === 'http') return 'streamable-http'
  return undefined
}

function parsePackage(raw: unknown): McpRegistryPackage | null {
  if (!isObj(raw)) return null
  const registryType = str(raw.registryType ?? raw.registry_type, 40)
  const identifier = str(raw.identifier, MAX_NAME)
  const version = str(raw.version, 80)
  if (!registryType || !identifier || !version) return null
  const t = isObj(raw.transport) ? raw.transport : {}
  const type = transportType(t.type) ?? 'stdio'
  const url = str(t.url, MAX_URL)
  const pkg: McpRegistryPackage = {
    registryType: registryType.toLowerCase(),
    identifier,
    version,
    transport: url ? { type, url } : { type },
    environmentVariables: envVars(raw.environmentVariables ?? raw.environment_variables)
  }
  const hint = str(raw.runtimeHint ?? raw.runtime_hint, 40)
  if (hint) pkg.runtimeHint = hint
  return pkg
}

function parseRemote(raw: unknown): McpRegistryRemote | null {
  if (!isObj(raw)) return null
  const type = transportType(raw.type)
  const url = str(raw.url, MAX_URL)
  if (!type || type === 'stdio' || !url) return null
  const remote: McpRegistryRemote = { type, url }
  const headers = envVars(raw.headers)
  if (headers.length) remote.headers = headers
  return remote
}

/** Normalize one `{ server, _meta }` wrapper (or a bare server object). Null when it is unusable. */
export function parseRegistryEntry(raw: unknown): McpRegistryEntry | null {
  if (!isObj(raw)) return null
  const server = isObj(raw.server) ? raw.server : raw
  const name = str(server.name, MAX_NAME)
  if (!name) return null
  const packages = (Array.isArray(server.packages) ? server.packages : []).slice(0, MAX_PACKAGES).map(parsePackage).filter((p): p is McpRegistryPackage => !!p)
  const remotes = (Array.isArray(server.remotes) ? server.remotes : []).slice(0, MAX_PACKAGES).map(parseRemote).filter((r): r is McpRegistryRemote => !!r)
  const entry: McpRegistryEntry = {
    name,
    description: str(server.description, MAX_TEXT) ?? '',
    version: str(server.version, 80) ?? '',
    packages,
    remotes
  }
  const title = str(server.title, 120)
  if (title) entry.title = title
  const repo = isObj(server.repository) ? str(server.repository.url, MAX_URL) : undefined
  if (repo) entry.repositoryUrl = repo
  const site = str(server.websiteUrl ?? server.website_url, MAX_URL)
  if (site) entry.websiteUrl = site
  const meta = isObj(raw._meta) ? raw._meta : {}
  const official = isObj(meta['io.modelcontextprotocol.registry/official']) ? (meta['io.modelcontextprotocol.registry/official'] as Json) : {}
  const status = official.status
  if (status === 'active' || status === 'deprecated' || status === 'deleted') entry.status = status
  const published = str(official.publishedAt, 40)
  if (published) entry.publishedAt = published
  return entry
}

export function parseRegistryResponse(body: unknown): McpRegistrySearchResult {
  const root = isObj(body) ? body : {}
  const list = Array.isArray(root.servers) ? root.servers : []
  const entries = list.map(parseRegistryEntry).filter((e): e is McpRegistryEntry => !!e && e.status !== 'deleted')
  const meta = isObj(root.metadata) ? root.metadata : {}
  const nextCursor = str(meta.nextCursor ?? meta.next_cursor, 400)
  return nextCursor ? { entries, nextCursor } : { entries }
}

export async function searchRegistry(input: McpRegistrySearchInput, fetchImpl: typeof fetch = fetch): Promise<McpRegistrySearchResult> {
  const limit = Math.max(1, Math.min(REGISTRY_MAX_LIMIT, Math.floor(Number(input.limit) || REGISTRY_DEFAULT_LIMIT)))
  const url = new URL(REGISTRY_URL)
  const q = (input.query ?? '').trim().slice(0, 200)
  if (q) url.searchParams.set('search', q)
  url.searchParams.set('limit', String(limit))
  if (input.cursor) url.searchParams.set('cursor', String(input.cursor).slice(0, 400))
  url.searchParams.set('version', 'latest')
  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    })
  } catch (e) {
    const err = e as Error
    throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'The MCP Registry did not answer in time.' : `The MCP Registry could not be reached: ${err.message}`)
  }
  if (!res.ok) throw new Error(`The MCP Registry answered ${res.status}.`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error('The MCP Registry returned an unreadable response.')
  }
  return parseRegistryResponse(body)
}
