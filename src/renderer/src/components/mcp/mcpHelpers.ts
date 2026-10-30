import type {
  McpRegistryEntry,
  McpRegistryEnvVar,
  McpServerInfo,
  McpServerSpec,
  McpTransport,
  Role
} from '@shared/types'
import { newId } from '@shared/defaults'

/** The exact thing that runs: `command args` for stdio, the URL for http and sse. */
export function launchTarget(spec: Pick<McpServerSpec, 'transport' | 'command' | 'args' | 'url'>): string {
  if (spec.transport === 'stdio') return [spec.command ?? '', ...(spec.args ?? [])].join(' ').trim()
  return spec.url ?? ''
}

export const SECURITY_STDIO = 'Runs code on this machine with your permissions.'
export const SECURITY_REMOTE = 'Connects to a remote server that receives what the agent sends it.'
export const SECURITY_SECRETS = 'Secrets are stored encrypted on this machine and are never shown again.'

export function securityPhrase(transport: McpTransport): string {
  return transport === 'stdio' ? SECURITY_STDIO : SECURITY_REMOTE
}

export interface SecretStatus {
  name: string
  set: boolean
}

export function secretStatuses(info: McpServerInfo): SecretStatus[] {
  return [
    ...(info.spec.secretEnv ?? []).map((name) => ({ name, set: info.envSet.includes(name) })),
    ...(info.spec.secretHeaders ?? []).map((name) => ({ name, set: info.headersSet.includes(name) }))
  ]
}

export function allRoleSlugs(roles: Role[]): string[] {
  return roles.map((r) => r.slug)
}

/** A version that names exactly one release: no latest, no ranges, no wildcards. */
export function isPinnedVersion(version: string | undefined): boolean {
  if (!version) return false
  return /^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(version.trim())
}

/** Kebab-case server name derived from free text, unique among `taken`. */
export function slugName(raw: string, taken: string[]): string {
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  let base = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  if (!base) base = 'server'
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`
  return name
}

type SpecBase = Pick<McpServerSpec, 'id' | 'name' | 'enabled' | 'roles' | 'addedAt'>

export interface RegistryOption {
  key: string
  /** "npm @scope/pkg" | "pypi pkg" | "remote https://..." */
  label: string
  /** Exact version shown after the identifier, if any. */
  version?: string
  transport: McpTransport
  pinned: boolean
  /** Why it cannot be selected. */
  blocked?: string
  /** Env vars (stdio) or headers (remote) the user may fill. */
  vars: McpRegistryEnvVar[]
  varKind: 'env' | 'header'
  build: (base: SpecBase, values: Record<string, string>) => McpServerSpec
}

function splitVars(vars: McpRegistryEnvVar[], values: Record<string, string>): { plain: Record<string, string>; secret: string[] } {
  const plain: Record<string, string> = {}
  const secret: string[] = []
  for (const v of vars) {
    if (v.isSecret) secret.push(v.name)
    else {
      const val = values[v.name] ?? v.default ?? ''
      if (val !== '') plain[v.name] = val
    }
  }
  return { plain, secret }
}

/** Every way to install a registry entry, with the spec each would produce. */
export function registryOptions(entry: McpRegistryEntry): RegistryOption[] {
  const out: RegistryOption[] = []
  for (const pkg of entry.packages) {
    const type = pkg.registryType.toLowerCase()
    const pinned = isPinnedVersion(pkg.version)
    const version = pkg.version
    const launcher =
      type === 'npm'
        ? { command: 'npx', args: ['-y', `${pkg.identifier}@${version}`] }
        : type === 'pypi'
          ? { command: 'uvx', args: [`${pkg.identifier}==${version}`] }
          : null
    const blocked = !launcher
      ? `Package type ${pkg.registryType} is not supported`
      : pkg.transport.type !== 'stdio'
        ? 'Only stdio packages can be installed'
        : !pinned
          ? 'Version not pinned'
          : undefined
    out.push({
      key: `pkg:${pkg.registryType}:${pkg.identifier}`,
      label: `${pkg.registryType} ${pkg.identifier}`,
      version,
      transport: 'stdio',
      pinned,
      blocked,
      vars: pkg.environmentVariables,
      varKind: 'env',
      build: (base, values) => {
        const { plain, secret } = splitVars(pkg.environmentVariables, values)
        return {
          ...base,
          transport: 'stdio',
          command: launcher?.command ?? '',
          args: launcher?.args ?? [],
          ...(Object.keys(plain).length ? { env: plain } : {}),
          ...(secret.length ? { secretEnv: secret } : {}),
          source: 'registry',
          registry: { name: entry.name, version, registryType: pkg.registryType, identifier: pkg.identifier },
          description: entry.description
        }
      }
    })
  }
  for (const remote of entry.remotes) {
    const headers = remote.headers ?? []
    const transport: McpTransport = remote.type === 'sse' ? 'sse' : 'http'
    out.push({
      key: `remote:${remote.url}`,
      label: `remote ${remote.url}`,
      transport,
      pinned: true,
      vars: headers,
      varKind: 'header',
      build: (base, values) => {
        const { plain, secret } = splitVars(headers, values)
        return {
          ...base,
          transport,
          url: remote.url,
          ...(Object.keys(plain).length ? { headers: plain } : {}),
          ...(secret.length ? { secretHeaders: secret } : {}),
          source: 'registry',
          registry: { name: entry.name, version: entry.version, registryType: 'remote', identifier: remote.url },
          description: entry.description
        }
      }
    })
  }
  return out
}

export function newServerBase(name: string, roles: Role[]): SpecBase {
  return { id: newId('mcp'), name, enabled: true, roles: allRoleSlugs(roles), addedAt: new Date().toISOString() }
}

/** Drops deleted entries and repeats of the same name and version (the registry can list a version more than once). */
export function dedupeRegistryEntries(entries: McpRegistryEntry[]): McpRegistryEntry[] {
  const seen = new Set<string>()
  const out: McpRegistryEntry[] = []
  for (const e of entries) {
    if (e.status === 'deleted') continue
    const key = `${e.name}@${e.version}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/** Starting points offered while the registry search is empty. */
export const REGISTRY_SUGGESTIONS = ['filesystem', 'github', 'fetch', 'memory', 'playwright']

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e)
}
