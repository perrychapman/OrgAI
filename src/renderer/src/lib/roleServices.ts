import type { McpServerSpec, Project, Role } from '@shared/types'
import { mcpServersForRole } from '@shared/defaults'
import { connectorById } from '@shared/connectors'
import { connectorHue, connectorInitial } from './connectors'

export interface RoleService {
  id: string
  /** Display name: the connector's name, or the server's own name for a custom one. */
  label: string
  initial: string
  hue: number
  custom: boolean
}

/** Display label and look for one server spec. */
export function serviceFor(spec: Pick<McpServerSpec, 'id' | 'name' | 'connectorId'>): RoleService {
  const def = spec.connectorId ? connectorById(spec.connectorId) : undefined
  const label = def?.name ?? (spec.name.trim() || spec.id)
  return {
    id: spec.id,
    label,
    initial: connectorInitial({ name: label }),
    hue: connectorHue(spec.connectorId ?? spec.id),
    custom: !spec.connectorId
  }
}

/** The services a role can use right now (enabled and granted), connectors by name, custom servers marked. */
export function servicesForRole(project: Pick<Project, 'mcpServers'>, role: Pick<Role, 'slug' | 'mcpServers'>): RoleService[] {
  return mcpServersForRole(project, role).map(serviceFor)
}
