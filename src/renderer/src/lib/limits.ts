import { isBuiltinConnectionId, isProxyConnection } from '@shared/types'
import type { ConnectionInfo, Project } from '@shared/types'
import { projectConnection } from '@shared/defaults'

/**
 * How a project pays for its runs (config-review spec 1). 'metered': the project's connection is a proxy (any), or an
 * Anthropic / OpenAI connection on an API key, so a USD cost cap means money. 'subscription': a login (Claude Code,
 * ChatGPT), including the mock adapter on a login connection; plan windows apply. 'unknown': the connection list is
 * not loaded yet (and the project is not on a proxy); render it like a subscription but without the plan line.
 */
export type ProjectMetering = 'metered' | 'subscription' | 'unknown'

export function projectMetering(project: Pick<Project, 'provider'>, connections: readonly ConnectionInfo[] | null | undefined): ProjectMetering {
  const id = projectConnection(project)
  if (!isBuiltinConnectionId(id)) return 'metered'
  const info = connections?.find((c) => c.connection.id === id)
  if (!info) return 'unknown'
  const conn = info.connection
  if (isProxyConnection(conn)) return 'metered'
  return conn.auth.kind === 'apiKey' ? 'metered' : 'subscription'
}

/** True when the project is metered (a proxy or an API-key connection). Unknown counts as not metered. */
export function isMeteredProject(project: Pick<Project, 'provider'>, connections: readonly ConnectionInfo[] | null | undefined): boolean {
  return projectMetering(project, connections) === 'metered'
}
