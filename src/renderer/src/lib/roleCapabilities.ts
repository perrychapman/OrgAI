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

/** Tools that change files or run commands; shown by name and in the warning colour. */
export const ELEVATED_TOOL_NAMES: readonly string[] = ['Bash', 'Edit', 'Write', 'NotebookEdit']

export function isElevatedTool(tool: string): boolean {
  return ELEVATED_TOOL_NAMES.includes(tool)
}

function sortByCatalog(tools: readonly string[], catalog: readonly string[]): string[] {
  const rank = (t: string): number => {
    const i = catalog.indexOf(t)
    return i < 0 ? catalog.length : i
  }
  return [...tools].sort((a, b) => rank(a) - rank(b))
}

/** The elevated tools a role has, in catalog order. */
export function elevatedTools(tools: readonly string[], catalog: readonly string[]): string[] {
  return sortByCatalog(tools, catalog).filter(isElevatedTool)
}

export interface ToolsSummaryParts {
  /** The first three ordinary tools by catalog order. */
  base: string[]
  /** Every elevated tool, by name. */
  elevated: string[]
  /** Ordinary tools not named in `base`. */
  more: number
}

export function toolsSummaryParts(tools: readonly string[], catalog: readonly string[]): ToolsSummaryParts {
  const sorted = sortByCatalog(tools, catalog)
  const ordinary = sorted.filter((t) => !isElevatedTool(t))
  return { base: ordinary.slice(0, 3), elevated: sorted.filter(isElevatedTool), more: Math.max(0, ordinary.length - 3) }
}

/** "Read, Glob, Grep + Bash, Edit": the first three ordinary tools, then every elevated tool by name, then "2 more". */
export function toolsSummary(tools: readonly string[], catalog: readonly string[]): string {
  if (tools.length === 0) return 'No tools'
  const { base, elevated, more } = toolsSummaryParts(tools, catalog)
  const tail = [...elevated, ...(more > 0 ? [`${more} more`] : [])]
  const head = base.join(', ')
  if (tail.length === 0) return head
  return head ? `${head} + ${tail.join(', ')}` : tail.join(', ')
}

/** Spoken tools count for a node: "5 tools including Bash, Edit" (no "including" when nothing is elevated). */
export function toolsAriaLabel(tools: readonly string[], catalog: readonly string[]): string {
  const n = `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`
  const el = elevatedTools(tools, catalog)
  return el.length > 0 ? `${n} including ${el.join(', ')}` : n
}

/** The access words for a connection, or null when it is a custom server with no stated access. */
export function accessLabel(readOnly: boolean | null): string | null {
  if (readOnly === null) return null
  return readOnly ? 'Can read' : 'Can read and change'
}

/** Granted to the role, whether or not the server is switched on. */
export function grantedServers<T extends { spec: Pick<McpServerSpec, 'id' | 'roles'> }>(servers: readonly T[], role: Pick<Role, 'slug' | 'mcpServers'>): T[] {
  return servers.filter((s) => serverGranted(s.spec, role))
}

/** Project servers the role cannot use yet. */
export function grantableServers<T extends { spec: Pick<McpServerSpec, 'id' | 'roles'> }>(servers: readonly T[], role: Pick<Role, 'slug' | 'mcpServers'>): T[] {
  return servers.filter((s) => !serverGranted(s.spec, role))
}

/** The server cannot be used until the user signs in or sets a secret (App settings > Connectors). */
export function needsSignIn(info: { spec: Pick<McpServerSpec, 'enabled'>; auth: { state: string }; missingSecrets: readonly string[]; libraryMissing?: true }): boolean {
  if (info.libraryMissing) return false
  // A server saved with an empty secret slot is switched off until it is filled, so a missing secret counts either way.
  if (info.missingSecrets.length > 0) return true
  return info.spec.enabled && (info.auth.state === 'notAuthorized' || info.auth.state === 'expired')
}

/** What a waiting connection needs: a sign in (OAuth, token) or this project's own value(s) for a per-project entry. */
export function waitingLabel(info: { missingSecrets: readonly string[]; secretScope?: 'project' | 'library' }): string {
  const n = info.missingSecrets.length
  if (info.secretScope === 'project' && n > 0) return n === 1 ? 'Needs a value for this project' : `Needs ${n} values for this project`
  return 'Needs sign in'
}

export interface RevokePlan {
  /** New McpServerSpec.roles (always an explicit list). */
  roles: string[]
  /** New Role.mcpServers, or undefined when the role has no role-level grant to drop. */
  roleMcpServers?: string[]
}

/** Everything a revoke changes: the server's role list and the role's own grant. An "every role" server becomes the explicit list minus the role. */
export function revokePlan(
  server: Pick<McpServerSpec, 'id' | 'roles'>,
  projectRoles: readonly Pick<Role, 'slug'>[],
  role: Pick<Role, 'slug' | 'mcpServers'>
): RevokePlan {
  const plan: RevokePlan = { roles: revokeServerRoles(server, projectRoles, role) }
  if (role.mcpServers?.includes(server.id)) plan.roleMcpServers = withoutRoleServer(role, server.id)
  return plan
}

/** Project skills the role holds / does not hold yet (a disabled skill can still be held). */
export function roleSkillSplit<T extends Pick<SkillSpec, 'id'>>(skills: readonly T[], role: Pick<Role, 'skills'>): { granted: T[]; available: T[] } {
  const held = new Set(role.skills ?? [])
  return { granted: skills.filter((s) => held.has(s.id)), available: skills.filter((s) => !held.has(s.id)) }
}
