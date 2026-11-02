import type { McpServerSpec, Role } from '@shared/types'
import { mcpServersForRole } from '@shared/defaults'
import type { HarnessToolAudience } from './harnessTools'

/**
 * Per-role MCP grants, enforced on every MCP tool call (PreToolUse in the Claude adapter, the tool step in the mock).
 * Pure: the caller passes the LIVE server list (ctx.mcpServers(): project servers plus run-scoped installs, with the
 * roles the install card left on them), so a server approved mid-run is gated the moment it exists.
 */

/** The MCP server name of the harness's own tools (mcp__orgai__<tool>). */
export const HARNESS_MCP_SERVER = 'orgai'

/** Split `mcp__<server>__<tool>`. Server names are kebab-case, so the first `__` after the prefix ends the server. */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  if (i <= 0 || i + 2 >= rest.length) return undefined
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) }
}

export interface McpCaller {
  /** The calling agent's role; undefined when it cannot be told (every non-harness MCP call is then denied). */
  role: Pick<Role, 'slug' | 'name' | 'mcpServers' | 'canSpawn'> | undefined
  /** The run's root agent (the orchestrator, or the Architect / assistant of a setup-like run). */
  isRoot: boolean
}

/**
 * Why an MCP tool call must be refused, or undefined when it may go on (to the normal permission path; this never
 * approves anything). Non-MCP tool names always pass.
 * - mcp__orgai__<tool>: checked against the harness tool audiences when `harness` is given ('root' = the root only,
 *   'spawners' = the root and canSpawn roles, 'all' = everyone); an unknown harness tool is refused.
 * - any other server: it must be in `servers`, enabled, and granted to the caller's role by mcpServersForRole
 *   (spec.roles undefined = every role, else the listed slugs or a role whose mcpServers holds the id). The root is
 *   held to the same rule.
 */
export function mcpCallDenial(
  toolName: string,
  caller: McpCaller,
  servers: readonly McpServerSpec[],
  harness?: ReadonlyMap<string, HarnessToolAudience>
): string | undefined {
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return undefined
  const { server, tool } = parsed
  const who = caller.role ? `the ${caller.role.name} role (${caller.role.slug})` : 'this agent'
  if (server === HARNESS_MCP_SERVER) {
    if (!harness) return undefined
    const audience = harness.get(tool)
    if (!audience) return `OrgAI has no harness tool named "${tool}" in this run.`
    if (caller.isRoot || audience === 'all' || (audience === 'spawners' && !!caller.role?.canSpawn)) return undefined
    return `The OrgAI tool ${tool} is not available to ${who}.`
  }
  if (!caller.role) return `OrgAI could not tell which role made this call, so the MCP server "${server}" is not available to it.`
  const spec = servers.find((s) => s.name === server)
  if (!spec) return `The MCP server "${server}" is not configured for this run.`
  if (!spec.enabled) return `The MCP server "${server}" is turned off for this project.`
  if (mcpServersForRole({ mcpServers: [spec] }, caller.role).length) return undefined
  return `The org chart does not grant the MCP server "${server}" to ${who}. Hand this step to an agent whose role has it, or ask the user to grant it.`
}

/** Names of the roles a server is granted to, from the live list (empty when it is unknown or off). */
export function rolesGrantedServer(roles: readonly Role[], servers: readonly McpServerSpec[], serverName: string): Role[] {
  const spec = servers.find((s) => s.name === serverName)
  if (!spec) return []
  return roles.filter((r) => mcpServersForRole({ mcpServers: [spec] }, r).length > 0)
}
