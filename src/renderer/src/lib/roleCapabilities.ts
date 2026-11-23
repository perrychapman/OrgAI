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

/**
 * Everything a revoke changes: the server's role list and the role's own grant. An "every role" server becomes the
 * explicit list minus the role. Only the revoked role's slug leaves the list: a slug no current role holds may belong
 * to a role removed with Undo still on screen or one named by team files awaiting approval, so it stays (recheck M).
 */
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

// ---------- Role panel header, "What it can use" chips and where a role can work (UI overhaul, Team board) ----------

type RoleRef = Pick<Role, 'id' | 'name' | 'reportsTo'>

/**
 * The group a role sits in on the chart: the name of the root's direct report whose subtree holds it (a direct report is
 * its own group). The root leads the team and has no group name. A role cut off from the root falls back to its own name.
 */
export function roleGroupName(roles: readonly RoleRef[], role: RoleRef): string {
  if (role.reportsTo === null) return 'Leads the team'
  const byId = new Map(roles.map((r) => [r.id, r]))
  let cur: RoleRef = role
  const seen = new Set<string>()
  while (cur.reportsTo !== null && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = byId.get(cur.reportsTo)
    if (!parent || parent.reportsTo === null) return cur.name
    cur = parent
  }
  return cur.name
}

/** How many groups the chart has: the root's direct reports that lead at least one role (the header's "in N groups"). */
export function teamGroupCount(roles: readonly Pick<Role, 'id' | 'reportsTo'>[]): number {
  const roots = new Set(roles.filter((r) => r.reportsTo === null).map((r) => r.id))
  return roles.filter((r) => r.reportsTo !== null && roots.has(r.reportsTo) && roles.some((x) => x.reportsTo === r.id)).length
}

/** "Quality · reports to Lead reviewer"; "Leads the team" for the root. */
export function roleSubline(roles: readonly RoleRef[], role: RoleRef): string {
  if (role.reportsTo === null) return 'Leads the team'
  const manager = roles.find((r) => r.id === role.reportsTo)
  const group = roleGroupName(roles, role)
  if (!manager) return group
  // The group name is dropped when it only repeats the role or its manager.
  return group === manager.name || group === role.name ? `Reports to ${manager.name}` : `${group} group · reports to ${manager.name}`
}

/** True when the role has neither Edit nor Write (it can read and run, but not change files). */
export function cannotEditFiles(tools: readonly string[]): boolean {
  return !tools.includes('Edit') && !tools.includes('Write')
}

export interface UseChip {
  kind: 'tool' | 'service' | 'skill'
  label: string
}

/**
 * The chips of "What it can use": one per tool group the role has on (fully or partly), the names of the services it can
 * reach and the names of its skills. A long list of services or skills ends in one "+N more" chip.
 */
export function roleUseChips(input: { toolGroupLabels: readonly string[]; services: readonly string[]; skills: readonly string[]; perKind?: number }): UseChip[] {
  const cap = input.perKind ?? 3
  const out: UseChip[] = input.toolGroupLabels.map((label) => ({ kind: 'tool' as const, label }))
  for (const [kind, names] of [['service', input.services], ['skill', input.skills]] as const) {
    for (const label of names.slice(0, cap)) out.push({ kind, label })
    if (names.length > cap) out.push({ kind, label: `+${names.length - cap} more` })
  }
  return out
}

export interface WorkPlace {
  /** "{project} (working folder)" or the reference folder's path. */
  name: string
  mode: 'Can write' | 'Read only'
}

/**
 * "Where it can work" on an engagement: the project folder (writable when the role has Edit or Write) and each
 * reference folder (always read only: every adapter refuses changes there).
 */
export function roleWorkPlaces(project: { name: string; referenceDirectories?: readonly string[] }, tools: readonly string[]): WorkPlace[] {
  return [
    { name: `${project.name} (working folder)`, mode: cannotEditFiles(tools) ? 'Read only' : 'Can write' },
    ...(project.referenceDirectories ?? []).map((name) => ({ name, mode: 'Read only' as const }))
  ]
}
