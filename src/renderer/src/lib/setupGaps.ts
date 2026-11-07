import type { ConnectorInfo, McpLibraryInfo, McpServerInfo, Project } from '@shared/types'
import { connectorEase } from '@shared/connectors'
import { needsSignIn, waitingLabel } from './roleCapabilities'

/**
 * To set up (docs/design/dashboard-2.md section 8): what will make a run fail or skip a service, as rows. Pure; the
 * component feeds it the library list, the connector list and the per-project server lists. Never a decision.
 */

export type SetupKind = 'connection' | 'service' | 'project-value' | 'project-server' | 'connector'

/** Where a row's button goes. */
export type SetupTarget =
  | { type: 'connections' }
  | { type: 'connector'; connectorId: string }
  | { type: 'library'; libraryId: string }
  | { type: 'project'; projectId: string; serverId: string }

export interface SetupRow {
  kind: SetupKind
  /** Unique within the list. */
  id: string
  line: string
  caption?: string
  action: string
  target: SetupTarget
}

export const KIND_ORDER: readonly SetupKind[] = ['connection', 'service', 'project-value', 'project-server', 'connector']

const NAMES_MAX = 3

/** "Used by Billing API, Docs site" (at most 3 names, then "and N more"); '' without names. */
export function usedByCaption(names: readonly string[]): string {
  const list = [...new Set(names.filter((n) => n.trim() !== ''))]
  if (list.length === 0) return ''
  if (list.length <= NAMES_MAX) return `Used by ${list.join(', ')}`
  return `Used by ${list.slice(0, NAMES_MAX).join(', ')} and ${list.length - NAMES_MAX} more`
}

/** The row for a connection problem the helper already worded ("OpenAI is not connected. 2 projects use it."). */
export function connectionRow(problem: { id: string; text: string }): SetupRow {
  return { kind: 'connection', id: problem.id, line: problem.text, action: 'Connection settings', target: { type: 'connections' } }
}

/** The button of a service that needs the user: a connector says how (sign in, token), anything else "Set up". */
function serviceAction(info: McpLibraryInfo, connectors: readonly ConnectorInfo[]): { action: string; target: SetupTarget } {
  const connectorId = info.entry.connectorId
  const connector = connectorId ? connectors.find((c) => c.connector.id === connectorId) : undefined
  if (connectorId && connector) {
    const ease = connectorEase(connector.connector, connector.variant)
    return { action: ease === 'token' ? 'Add token' : ease === 'ownApp' ? 'Set up' : 'Sign in', target: { type: 'connector', connectorId } }
  }
  return { action: 'Set up', target: { type: 'library', libraryId: info.entry.id } }
}

/**
 * Rows from the library and the connector gallery: services nobody can run yet (service), per-project values still
 * empty (project-value) and connectors whose last sign-in failed while a project uses them (connector). One row per
 * library entry: a connector in error that also needs a sign in shows once, as a service.
 */
export function libraryRows(library: readonly McpLibraryInfo[], connectors: readonly ConnectorInfo[]): SetupRow[] {
  const rows: SetupRow[] = []
  const shown = new Set<string>()
  for (const info of library) {
    const used = info.usedBy ?? []
    if (info.entry.perProjectSecrets) {
      for (const p of info.projectSecrets ?? []) {
        if (p.missingSecrets.length === 0) continue
        shown.add(info.entry.id)
        rows.push({
          kind: 'project-value',
          id: `${info.entry.id}:${p.projectId}:${p.serverId}`,
          line: `${info.entry.name} · ${waitingLabel({ missingSecrets: p.missingSecrets, secretScope: 'project' })}`,
          caption: p.projectName,
          action: 'Set value',
          target: { type: 'project', projectId: p.projectId, serverId: p.serverId }
        })
      }
      continue
    }
    if (used.length === 0) continue
    if (!needsSignIn({ spec: { enabled: true }, auth: info.auth, missingSecrets: info.missingSecrets })) continue
    shown.add(info.entry.id)
    const { action, target } = serviceAction(info, connectors)
    rows.push({ kind: 'service', id: info.entry.id, line: `${info.entry.name} · ${waitingLabel({ missingSecrets: info.missingSecrets })}`, caption: usedByCaption(used.map((u) => u.projectName)), action, target })
  }
  for (const c of connectors) {
    if (c.state !== 'error' || !c.library || c.library.usedBy.length === 0 || shown.has(c.library.entry.id)) continue
    rows.push({ kind: 'connector', id: c.connector.id, line: `${c.connector.name} has a problem`, caption: usedByCaption(c.library.usedBy.map((u) => u.projectName)), action: 'Open', target: { type: 'connector', connectorId: c.connector.id } })
  }
  return rows
}

/** Projects whose own (not library-linked) enabled servers might need a sign in: the ones worth an `mcp.list` call. */
export function projectsWithOwnServers(projects: readonly Pick<Project, 'id' | 'mcpServers'>[]): string[] {
  return projects.filter((p) => (p.mcpServers ?? []).some((s) => s.enabled && !s.libraryId)).map((p) => p.id)
}

/** Rows for one project's own servers that need a sign in or a value. Linked servers are the library's business. */
export function projectServerRows(project: Pick<Project, 'id' | 'name'>, infos: readonly McpServerInfo[]): SetupRow[] {
  return infos
    .filter((i) => !i.spec.libraryId && needsSignIn(i))
    .map((i) => ({
      kind: 'project-server' as const,
      id: `${project.id}:${i.spec.id}`,
      line: `${i.spec.name} · ${waitingLabel(i)}`,
      caption: project.name,
      action: 'Set up',
      target: { type: 'project' as const, projectId: project.id, serverId: i.spec.id }
    }))
}

/** Connection, service, project value, project server, connector; then by line. */
export function orderSetupRows(rows: readonly SetupRow[]): SetupRow[] {
  return [...rows].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.line.localeCompare(b.line, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}
