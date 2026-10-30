import type { McpProposalServer, McpServersProposalPayload } from '@shared/types'
import { pinnedVersionOf } from './mcpVersion'

export const SKIP_MCP_FEEDBACK = 'Skipped by the user; continue without MCP servers.'

export type McpProposalScope = 'library' | 'project'

export function proposalScope(payload: Pick<McpServersProposalPayload, 'scope'>): McpProposalScope {
  return payload.scope === 'library' ? 'library' : 'project'
}

/** What approving does for one server, in plain words. */
export function upsertAction(s: McpProposalServer, scope: McpProposalScope): string {
  if (scope === 'library') return `Add ${s.name} to your library`
  if (s.libraryId) return `Link ${s.name} from your library`
  if (s.projectOnly) return `Add ${s.name} to this project`
  return `Add ${s.name} to the library and this project`
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

export function whoCanUse(s: McpProposalServer): string {
  if (s.roles === undefined) return 'Every role'
  return s.roles.length > 0 ? s.roles.join(', ') : 'No roles yet'
}

export function removalLabels(payload: McpServersProposalPayload): string[] {
  return (payload.remove ?? []).map((id) => {
    const hit = payload.upsert.find((s) => s.id === id)
    return `Remove ${hit ? hit.name : id}`
  })
}

export function secretsLine(payload: McpServersProposalPayload, serverId?: string): string | null {
  const list = (payload.secrets ?? []).filter((x) => serverId === undefined || x.serverId === serverId)
  if (list.length === 0) return null
  return `You will set ${list.length} ${list.length === 1 ? 'secret' : 'secrets'} after approving: ${list.map((x) => x.name).join(', ')}`
}
