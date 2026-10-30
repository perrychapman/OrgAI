import type { ConnectorInfo, McpAuthTarget, McpLibraryInfo, McpServerInfo, McpServerSpec, McpTransport } from '@shared/types'
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

/** The project server linked to a connector's library entry, if any. */
export function linkedServerFor(info: ConnectorInfo, servers: McpServerInfo[]): McpServerInfo | undefined {
  const id = info.library?.entry.id
  return id ? servers.find((s) => s.spec.libraryId === id) : undefined
}

/**
 * Splits the project's servers: `connector` rows are shown under Connected services (one per connector whose library
 * entry is known), `rest` stays in the generic lists. A connector link whose entry is gone stays in `rest` so its
 * "entry was removed" note is still visible.
 */
export function splitConnectorServers(
  servers: McpServerInfo[],
  connectors: ConnectorInfo[] | null
): { connector: McpServerInfo[]; rest: McpServerInfo[] } {
  const known = new Set((connectors ?? []).map((c) => c.library?.entry.id).filter((x): x is string => !!x))
  const connector: McpServerInfo[] = []
  const rest: McpServerInfo[] = []
  for (const s of servers) {
    if (s.spec.connectorId && s.spec.libraryId && known.has(s.spec.libraryId)) connector.push(s)
    else rest.push(s)
  }
  return { connector, rest }
}

/** Connectors the user has set up in the app (connected, needing setup or failed), in the order given. */
export function setUpConnectors(connectors: ConnectorInfo[] | null): ConnectorInfo[] {
  return (connectors ?? []).filter((c) => c.state !== 'available' && !!c.library)
}

/** Why "Use in this project" cannot go ahead yet, or null when it can. */
export function useInProjectBlocker(roleCount: number, picked: string[]): string | null {
  if (roleCount === 0) return null
  return picked.length === 0 ? 'Choose at least one role, or All roles. Agents get no access until you do.' : null
}

/** The empty-state kind for a project with no servers. */
export function emptyKind(connectors: ConnectorInfo[] | null): 'use' | 'none' {
  return setUpConnectors(connectors).some((c) => c.state === 'connected') ? 'use' : 'none'
}
