import type { McpProposalServer, McpServersProposalPayload } from '@shared/types'
import { pinnedVersionOf } from './mcpVersion'
import { clampLabel } from './clampLabel'

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

/** Library entries have no role grants, so library scope returns null. With `roleSlugs`, unknown slugs are dropped and an emptied list returns null. */
export function whoCanUse(s: McpProposalServer, roleSlugs?: string[], scope: McpProposalScope = 'project'): string | null {
  if (scope === 'library') return null
  if (s.roles === undefined) return 'Every role'
  if (s.roles.length === 0) return 'No roles yet'
  const known = roleSlugs ? s.roles.filter((r) => roleSlugs.includes(r)) : s.roles
  return known.length > 0 ? known.map((r) => clampLabel(r)).join(', ') : null
}

/** Approve-helper wording for an MCP proposal. */
export function mcpApplyNote(scope: McpProposalScope): string {
  return scope === 'library'
    ? 'Approving saves these MCP servers to your MCP library (available to every project). Secrets are entered separately and stored encrypted.'
    : 'Approving saves these MCP servers to the project. Secrets are entered separately and stored encrypted.'
}

export function removalLabels(payload: McpServersProposalPayload): string[] {
  return (payload.remove ?? []).map((id) => {
    const hit = payload.upsert.find((s) => s.id === id)
    return `Remove ${clampLabel(hit ? hit.name : id)}`
  })
}

export function secretsLine(payload: McpServersProposalPayload, serverId?: string): string | null {
  const list = (payload.secrets ?? []).filter((x) => serverId === undefined || x.serverId === serverId)
  if (list.length === 0) return null
  return `You will set ${list.length} ${list.length === 1 ? 'secret' : 'secrets'} after approving: ${list.map((x) => x.name).join(', ')}`
}

/** Exact command line (stdio) or full URL (http/sse) of a proposed server; null for a plain library link. */
export function proposalCommand(s: McpProposalServer): string | null {
  if (s.libraryId) return null
  if (s.transport === 'stdio') return [s.command ?? '', ...(s.args ?? [])].filter(Boolean).join(' ') || null
  return s.url || null
}

/** Where the proposed spec came from. */
export function proposalSource(s: McpProposalServer): string | null {
  if (s.libraryId) return null
  const r = s.registry
  if (r?.name) return `From the registry: ${clampLabel(r.name)}${r.version ? `@${clampLabel(r.version, 40)}` : ''}`
  return 'Described by the assistant'
}
