import type { Role } from '@shared/types'
import { datum } from './harnessTools'

/**
 * Shared by the adapters' RuntimeSession.hostConfigChanged: the user changed the run's project in OrgAI (or approved it in
 * another session) while the run was going. The orchestrator did not ask for it, so it is told, never with a turn of its
 * own (Claude: always with the next message to the orchestrator; Codex: steered into a running root turn, else with the
 * next message; the mock records which). Pure text helpers.
 */

/** The first sentence of every notice about a change the user made in OrgAI, not this run. */
export const HOST_CHANGE_LEAD = "The user changed this project's configuration in OrgAI while this run was going; you did not ask for it."

/** At most this many skills, roles or tool names are listed per part of a host notice. */
export const HOST_NOTICE_LIST_CAP = 20

/** Tool names an MCP server reports (untrusted) that may be repeated: plain identifiers, at most 64 chars (claude.ts twin). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

type Named = Pick<Role, 'name' | 'slug'>

const roleList = (roles: readonly Named[]): string =>
  roles.length ? roles.slice(0, HOST_NOTICE_LIST_CAP).map((r) => `${datum(r.name, 60)} (${datum(r.slug, 60)})`).join(', ') + (roles.length > HOST_NOTICE_LIST_CAP ? `, and ${roles.length - HOST_NOTICE_LIST_CAP} more` : '') : 'no role'

/**
 * A host change notice for adapters without the Claude restart notice (Codex, mock): what changed and what is callable
 * now. `prefix` is the adapter's harness-message prefix. MCP servers: `upserted` (with the roles granted each and, when
 * known, the tool names, kept only when they are plain identifiers, capped), `removed` (removed or turned off). Skills:
 * the skills granted now with their roles (null = changed but unreadable). Roster: roles added or changed that can be
 * delegated to now, and removed ones. Every name goes through datum().
 */
export function hostChangeNotice(c: {
  prefix: string
  servers?: { name: string; tools?: readonly unknown[]; roles: readonly Named[] }[]
  removed?: readonly string[]
  skills?: { name: string; roles: readonly Named[] }[] | null
  skillTool?: string
  roster?: { roles: readonly Named[]; removed: readonly string[] }
  /** Set when the change applies only once the session restarts at idle (the adapter tells the orchestrator again then). */
  pending?: string
  /**
   * Codex: MCP servers removed or turned off that the running app-server still has. Codex gives OrgAI no point to refuse
   * a native MCP call before it runs, so they stay reachable until the restart at idle; the notice says exactly that
   * (and nothing else: the restart's own notice says what is in place afterwards).
   */
  reachableUntilRestart?: readonly string[]
}): string {
  const parts = [`${c.prefix} ${HOST_CHANGE_LEAD}`]
  if (c.reachableUntilRestart?.length) {
    const names = c.reachableUntilRestart
    const list = names.slice(0, HOST_NOTICE_LIST_CAP).map((n) => datum(n, 64)).join(', ') + (names.length > HOST_NOTICE_LIST_CAP ? `, and ${names.length - HOST_NOTICE_LIST_CAP} more` : '')
    parts.push(
      `MCP servers removed or turned off: ${list}. Do not call their tools. They stay reachable until Codex restarts when the agents are idle: OrgAI cannot refuse a call to them before then. You are told again once the restart is done.`
    )
    return parts.join(' ')
  }
  if (c.pending) parts.push(c.pending)
  else parts.push('It is in effect now.')
  for (const s of c.servers ?? []) {
    const name = datum(s.name, 64)
    const safe = (s.tools ?? []).filter((t): t is string => typeof t === 'string' && TOOL_NAME.test(t))
    const tools = safe.length
      ? `Its tools: ${safe.slice(0, HOST_NOTICE_LIST_CAP).map((t) => `mcp__${name}__${datum(t, 64)}`).join(', ')}${safe.length > HOST_NOTICE_LIST_CAP ? `, and ${safe.length - HOST_NOTICE_LIST_CAP} more` : ''}.`
      : `Its tool names start with mcp__${name}__.`
    parts.push(`MCP server ${name}: ${tools} Roles that may use it: ${roleList(s.roles)}.`)
  }
  if (c.removed?.length) parts.push(`MCP servers removed or turned off (their tools are refused): ${c.removed.slice(0, HOST_NOTICE_LIST_CAP).map((n) => datum(n, 64)).join(', ')}.`)
  if (c.skills === null) parts.push("The project's skills changed; list them again before you use one.")
  else if (c.skills && !c.skills.length) parts.push('No skills are granted in this run now.')
  else if (c.skills) {
    const listed = c.skills.slice(0, HOST_NOTICE_LIST_CAP).map((s) => `${datum(s.name, 140)} for ${roleList(s.roles)}`)
    const more = c.skills.length > HOST_NOTICE_LIST_CAP ? `, and ${c.skills.length - HOST_NOTICE_LIST_CAP} more` : ''
    parts.push(`Skills granted now: ${listed.join('; ')}${more}.${c.skillTool ? ` Load one with ${c.skillTool}.` : ''}`)
  }
  if (c.roster) {
    if (c.roster.roles.length) parts.push(`Roles you can delegate to now (where the chart lets you): ${roleList(c.roster.roles)}.`)
    if (c.roster.removed.length) parts.push(`Removed from this run (no new agents of these): ${c.roster.removed.slice(0, HOST_NOTICE_LIST_CAP).map((n) => datum(n, 60)).join(', ')}.`)
  }
  // "Refused at once" is said of MCP tools only when the caller passed an MCP part (the mock refuses them at once). On
  // Codex an MCP removal waits for the restart at idle and never comes through this notice.
  const mcpPart = (c.servers?.length ?? 0) > 0 || (c.removed?.length ?? 0) > 0
  parts.push(
    mcpPart
      ? 'Reports you start from now on get the new configuration; removed or ungranted tools are refused at once.'
      : 'Reports you start from now on get the new configuration; skills and roles taken away are refused at once.'
  )
  return parts.join(' ')
}
