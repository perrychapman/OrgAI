import type { AnthropicConnection, ConnectionId, ConnectionInfo, ConnectionStatus, OpenAIConnection, Project, ProxyConnection, Role, RoleConnectionProblem } from '@shared/types'
import { isProxyConnection } from '@shared/types'
import { type ConnectionsView, isConnectionId, projectConnection, roleConnection, roleConnectionProblems } from '@shared/defaults'
import { connectionLabel } from './connectionLabel'

/**
 * Multi-provider org charts in the renderer (docs/design/multi-provider.md "Renderer"): the one place that turns the
 * store's connections:list into what defaults.ts reads, and words a role's "Runs on" connection. Pure.
 */

/** The ConnectionsView defaults.ts helpers read, rebuilt from connections:list. undefined while the list is not loaded. */
export function connectionsViewOf(list: readonly ConnectionInfo[] | null | undefined): ConnectionsView | undefined {
  if (!list) return undefined
  const anthropic = list.find((c) => c.connection.id === 'anthropic')?.connection as AnthropicConnection | undefined
  const openai = list.find((c) => c.connection.id === 'openai')?.connection as OpenAIConnection | undefined
  const proxies = list.map((c) => c.connection).filter((c): c is ProxyConnection => isProxyConnection(c))
  const view: ConnectionsView = { proxies }
  // connectionConfigured treats a missing anthropic record as enabled and a missing openai one as off, as main does.
  if (anthropic || openai) view.connections = { anthropic, openai } as NonNullable<ConnectionsView['connections']>
  return view
}

/** Live state per connection, for roleConnectionProblems' 'disconnected'. */
export function connectionStatesOf(list: readonly ConnectionInfo[] | null | undefined): Partial<Record<ConnectionId, ConnectionStatus['state']>> {
  const out: Partial<Record<ConnectionId, ConnectionStatus['state']>> = {}
  for (const c of list ?? []) out[c.connection.id] = c.status.state
  return out
}

/** One renderer sentence per problem: names the role, the connection and the fix in the role panel's words ("Runs on"). */
export function roleProblemText(p: Pick<RoleConnectionProblem, 'roleName' | 'connection' | 'problem'>): string {
  if (p.problem === 'unknown') return `${p.roleName} runs on a connection that was removed. Change the role's Runs on in the Team tab.`
  const name = connectionLabel(p.connection)
  const state = p.problem === 'disconnected' ? 'is not connected' : 'is not set up or is turned off'
  return `${p.roleName} runs on ${name}, which ${state}. Connect it in App settings or change the role's Runs on.`
}

/**
 * Roles whose own connection cannot run them (defaults.ts roleConnectionProblems over the loaded list), with the
 * renderer sentence. [] while the list is not loaded (the run's own refusal stays the truth) and on mock projects.
 */
export function roleProblems(
  project: Pick<Project, 'provider' | 'roles'>,
  list: readonly ConnectionInfo[] | null | undefined
): (RoleConnectionProblem & { text: string })[] {
  if (!list) return []
  return roleConnectionProblems(project, connectionsViewOf(list), connectionStatesOf(list)).map((p) => ({ ...p, text: roleProblemText(p) }))
}

/** True when the role names its own connection that differs from the project's (the root never does). */
export function isPinned(role: Pick<Role, 'connection' | 'reportsTo'>, project: Pick<Project, 'provider'>): boolean {
  return role.reportsTo !== null && roleConnection(role, project) !== projectConnection(project)
}

/**
 * The connection a non-root role names itself (Role.connection, a valid id), even when it equals the project's: main
 * keeps every such role and its model when the project switches connection (connections service remapOne). undefined =
 * the role follows the project.
 */
export function ownConnection(role: Pick<Role, 'connection' | 'reportsTo'>): ConnectionId | undefined {
  return role.reportsTo !== null && isConnectionId(role.connection) ? role.connection : undefined
}

/** Roles that keep their own connection (pinned to another one than the project's), in role order. */
export function pinnedRoles<R extends Pick<Role, 'connection' | 'reportsTo'>>(project: Pick<Project, 'provider'> & { roles: R[] }): R[] {
  return project.roles.filter((r) => isPinned(r, project))
}

/** A connection a role may be put on: configured (enabled) and listed. Connected or not, the role panel shows its state. */
export function selectableConnections(list: readonly ConnectionInfo[] | null | undefined): ConnectionInfo[] {
  return (list ?? []).filter((c) => c.connection.enabled !== false)
}

export interface RunsOnOption {
  /** '' = Project default (clears Role.connection). */
  value: string
  label: string
  disabled?: boolean
}

/**
 * The "Runs on" select: "Project default (<name>)", then every enabled connection except the project's own (picking it
 * equals the default). A pinned connection that is not in that list stays as one extra option ("Removed proxy" /
 * "<name> (turned off)") so the role's value is never silently shown as something else.
 */
export function runsOnOptions(
  role: Pick<Role, 'connection' | 'reportsTo'>,
  project: Pick<Project, 'provider'>,
  list: readonly ConnectionInfo[] | null | undefined
): RunsOnOption[] {
  const own = projectConnection(project)
  const opts: RunsOnOption[] = [{ value: '', label: `Project default (${connectionLabel(own)})` }]
  // A role that names the project's own connection keeps it when the project switches: show that, never "default".
  if (ownConnection(role) === own) opts.push({ value: own, label: `${connectionLabel(own)} (kept if the project switches)` })
  const usable = selectableConnections(list).filter((c) => c.connection.id !== own)
  for (const c of usable) {
    const state = c.status.state === 'connected' ? '' : ' (not connected)'
    opts.push({ value: c.connection.id, label: `${connectionLabel(c.connection.id)}${state}` })
  }
  const pinned = isPinned(role, project) ? roleConnection(role, project) : null
  if (pinned && !usable.some((c) => c.connection.id === pinned)) {
    const known = list?.some((c) => c.connection.id === pinned)
    opts.push({ value: pinned, label: known ? `${connectionLabel(pinned)} (turned off)` : connectionLabel(pinned) })
  }
  return opts
}

/** Show the "Runs on" control: two or more enabled connections, or the role is pinned (its value must stay visible). */
export function showRunsOn(role: Pick<Role, 'connection' | 'reportsTo'>, project: Pick<Project, 'provider'>, list: readonly ConnectionInfo[] | null | undefined): boolean {
  if (role.reportsTo === null) return false
  return selectableConnections(list).length >= 2 || isPinned(role, project)
}

/** The short provider tag a chip or agent shows when it differs from the default: the connection's name, else null. */
export function connectionTag(on: ConnectionId | undefined, base: ConnectionId | undefined): string | null {
  if (!on || !base || on === base) return null
  return connectionLabel(on)
}

/** Tooltip for a tag: "Runs on OpenAI, not this project's default (Anthropic)". */
export function connectionTagTitle(on: ConnectionId, base: ConnectionId, whose: 'project' | 'run' = 'project'): string {
  return `Runs on ${connectionLabel(on)}, not this ${whose}'s default (${connectionLabel(base)})`
}

/** True when the role can change files: Edit, Write or Bash (the tools RoleCapabilities treats as elevated). */
export function isWriterRole(role: Pick<Role, 'tools'>): boolean {
  return role.tools.some((t) => t === 'Edit' || t === 'Write' || t === 'Bash')
}

/**
 * The bridged limits of a role pinned to another connection (docs/design/multi-provider.md "Phase 1 limits"): two short
 * sentences, plus one for a role that writes. Plain words.
 */
export function bridgedLimits(connection: ConnectionId, writer: boolean): string {
  const base = `It runs as its own session on ${connectionLabel(connection)}, answers its lead once and cannot be messaged. Roles it would create on other connections are not bridged.`
  return writer ? `${base} It works in the project folder with no worktree.` : base
}

/** The one-line limit note beside the project's "N run on their own connections" line. */
export const BRIDGED_NOTE =
  'Roles on their own connection run as their own session, answer their lead once, cannot be messaged and cannot start roles on a third connection.'

/** The text under the Runs on select for a pinned role (also what the polite status says when the value changes to it). */
export function runsOnHintText(connection: ConnectionId, writer: boolean): string {
  return `Bills and routes through ${connectionLabel(connection)}, not the project default. ${bridgedLimits(connection, writer)}`
}

/** What is said when Runs on goes back to the project default. */
export function runsOnDefaultText(base: ConnectionId): string {
  return `Runs on the project default, ${connectionLabel(base)}.`
}

/** The closed Model fold's summary: "Everyday", or "Everyday · Runs on <name>" when the role is pinned. */
export function modelFoldSummary(word: string, on: ConnectionId | undefined, base: ConnectionId | undefined): string {
  const tag = connectionTag(on, base)
  return tag ? `${word} · Runs on ${tag}` : word
}

/** The root's Model section line: it never has its own connection. */
export function rootRunsOnLine(base: ConnectionId): string {
  return `The orchestrator runs on the project's connection (${connectionLabel(base)}); change it in Project settings > Connection.`
}

/** Tooltip text for a folded group: " · ran on OpenAI" for members on another connection than the run's, else ''. Names only. */
export function groupConnectionNote(members: readonly { connection?: ConnectionId }[], runConnection: ConnectionId | undefined): string {
  if (!runConnection) return ''
  const names = [...new Set(members.map((m) => m.connection).filter((c): c is ConnectionId => !!c && c !== runConnection))].map(connectionLabel)
  return names.length ? ` · ran on ${names.join(', ')}` : ''
}
