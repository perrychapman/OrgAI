import type { McpAuthTarget, McpLibraryInfo, McpServerInfo, McpServerSpec, McpTransport } from '@shared/types'
import { mcpSupportsOAuth } from '@shared/defaults'

/** Plain words for how a server is reached. */
export function transportWords(transport: McpTransport): string {
  return transport === 'stdio' ? 'Runs on this machine' : 'Remote server'
}

/** "in 3 days", "in 20 minutes", "2 hours ago": a coarse relative time for token expiry. */
export function relativeTime(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  const diff = t - now
  const abs = Math.abs(diff)
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute']
  ]
  let text = 'less than a minute'
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms)
      text = `${n} ${name}${n === 1 ? '' : 's'}`
      break
    }
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`
}

/** A library entry shaped as a project server row, so the server form can edit it. */
export function infoFromLibrary(info: McpLibraryInfo): McpServerInfo {
  return {
    spec: { ...info.entry, enabled: true },
    envSet: info.envSet,
    headersSet: info.headersSet,
    missingSecrets: info.missingSecrets,
    auth: info.auth
  }
}

/** Remote servers whose agents cannot use them until the user signs in. */
export function needsAuthorization(info: McpServerInfo): boolean {
  return (
    info.spec.enabled &&
    mcpSupportsOAuth(info.spec) &&
    !info.libraryMissing &&
    (info.auth.state === 'notAuthorized' || info.auth.state === 'expired')
  )
}

/** Where a project row is authorized: a linked row through its library entry. */
export function authTarget(projectId: string, spec: McpServerSpec): McpAuthTarget {
  return spec.libraryId ? { libraryId: spec.libraryId } : { projectId, serverId: spec.id }
}

/** "github is not authorized; agents will not be able to use it" lines for the project warning banner. */
export function authWarning(servers: McpServerInfo[]): { id: string; name: string; expired: boolean }[] {
  return servers.filter(needsAuthorization).map((s) => ({ id: s.spec.id, name: s.spec.name, expired: s.auth.state === 'expired' }))
}
