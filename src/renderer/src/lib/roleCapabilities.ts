import type { McpServerSpec, Project, Role, SkillSpec } from '@shared/types'
import { connectorById } from '@shared/connectors'

/** Is the server granted to the role right now (ignoring whether the server is switched on)? Mirrors mcpServersForRole. */
export function serverGranted(server: Pick<McpServerSpec, 'id' | 'roles'>, role: Pick<Role, 'slug' | 'mcpServers'>): boolean {
  return server.roles === undefined || server.roles.includes(role.slug) || (role.mcpServers ?? []).includes(server.id)
}

/** The `roles` value (slugs) that also lets `role` use the server. `undefined` stays `undefined` (every role already can). */
export function grantServerRoles(server: Pick<McpServerSpec, 'roles'>, role: Pick<Role, 'slug'>): string[] | undefined {
  if (server.roles === undefined) return undefined
  return server.roles.includes(role.slug) ? server.roles : [...server.roles, role.slug]
}

/** The `roles` value that takes `role` away. From "every role" it becomes the explicit list of the others. */
export function revokeServerRoles(server: Pick<McpServerSpec, 'roles'>, projectRoles: readonly Pick<Role, 'slug'>[], role: Pick<Role, 'slug'>): string[] {
  const current = server.roles === undefined ? projectRoles.map((r) => r.slug) : server.roles
  return current.filter((s) => s !== role.slug)
}

/** `Role.mcpServers` without the server (a role-level grant also lets the role use it). */
export function withoutRoleServer(role: Pick<Role, 'mcpServers'>, serverId: string): string[] | undefined {
  return role.mcpServers?.filter((x) => x !== serverId)
}

/** Ids of the roles that hold a skill grant, for skills:update roleIds. */
export function skillRoleIds(roles: readonly Pick<Role, 'id' | 'skills'>[], skillId: string): string[] {
  return roles.filter((r) => (r.skills ?? []).includes(skillId)).map((r) => r.id)
}

/** The new roleIds after granting or revoking one role (never duplicates, order kept). */
export function toggleSkillRoleIds(current: readonly string[], roleId: string, grant: boolean): string[] {
  const without = current.filter((x) => x !== roleId)
  return grant ? [...without, roleId] : without
}

export interface CapabilityCounts {
  tools: number
  connections: number
  skills: number
}

/** What the role can use now: tools, enabled granted servers, enabled granted skills. */
export function capabilityCounts(project: Pick<Project, 'mcpServers' | 'skills'>, role: Pick<Role, 'slug' | 'tools' | 'mcpServers' | 'skills'>): CapabilityCounts {
  const granted = new Set(role.skills ?? [])
  return {
    tools: role.tools.length,
    connections: (project.mcpServers ?? []).filter((s) => s.enabled && serverGranted(s, role)).length,
    skills: (project.skills ?? []).filter((s: SkillSpec) => s.enabled && granted.has(s.id)).length
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "3 tools, 1 connection, 2 skills"; zero connection and skill counts are left out. */
export function countsSummary(c: CapabilityCounts): string {
  const parts = [plural(c.tools, 'tool', 'tools')]
  if (c.connections > 0) parts.push(plural(c.connections, 'connection', 'connections'))
  if (c.skills > 0) parts.push(plural(c.skills, 'skill', 'skills'))
  return parts.join(', ')
}

/** Is the connection read-only? null when it is not a connector preset (a custom server), which has no stated access. */
export function serverReadOnly(server: Pick<McpServerSpec, 'connectorId' | 'connectorVariant'>): boolean | null {
  const def = server.connectorId ? connectorById(server.connectorId) : undefined
  if (!def) return null
  const variant = def.variants.find((v) => v.id === (server.connectorVariant ?? def.defaultVariant)) ?? def.variants[0]
  return variant ? variant.readOnly : null
}

/** The least-privilege sentence under a connection: what the role can do through it, in plain words. */
export function accessSentence(roleName: string, serviceLabel: string, readOnly: boolean | null): string {
  if (readOnly === true) return `${roleName} can read ${serviceLabel}.`
  if (readOnly === false) return `${roleName} can read and change ${serviceLabel}.`
  return `${roleName} can use the tools ${serviceLabel} offers.`
}
