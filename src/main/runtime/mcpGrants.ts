import type { McpServerSpec, Role } from '@shared/types'
import { mcpServersForRole } from '@shared/defaults'
import type { HarnessToolAudience } from './harnessTools'
import { mcpServerOfRule } from './ruleMatch'

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

/**
 * Built-in tools that read MCP resources by server name (input.server). Names from SDK 0.3.312 BUILTIN_TOOL_NAMES
 * (sdk.d.ts) and input shapes from sdk-tools.d.ts (ListMcpResourcesInput: server optional, lists every server when
 * omitted; ReadMcpResourceInput / ReadMcpResourceDirInput: server required). Source-read; no live run has checked them.
 */
export const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'])

/** True for a tool call the MCP gate has to look at: mcp__<server>__<tool> and the MCP resource tools. */
export function isMcpGated(toolName: string): boolean {
  return toolName.startsWith('mcp__') || MCP_RESOURCE_TOOLS.has(toolName)
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
  harness?: ReadonlyMap<string, HarnessToolAudience>,
  input?: unknown
): string | undefined {
  if (MCP_RESOURCE_TOOLS.has(toolName)) return resourceCallDenial(toolName, caller, servers, input)
  const parsed = parseMcpToolName(toolName)
  if (!parsed) return undefined
  const { server, tool } = parsed
  const who = callerLabel(caller)
  if (server === HARNESS_MCP_SERVER) {
    if (!harness) return undefined
    const audience = harness.get(tool)
    if (!audience) return `OrgAI has no harness tool named "${tool}" in this run.`
    if (caller.isRoot || audience === 'all' || (audience === 'spawners' && !!caller.role?.canSpawn)) return undefined
    return `The OrgAI tool ${tool} is not available to ${who}.`
  }
  return serverDenial(server, caller, servers)
}

function callerLabel(caller: McpCaller): string {
  return caller.role ? `the ${caller.role.name} role (${caller.role.slug})` : 'this agent'
}

/** Why `caller` may not use the (non-harness) server `server`, or undefined when its role is granted it. */
function serverDenial(server: string, caller: McpCaller, servers: readonly McpServerSpec[]): string | undefined {
  if (!caller.role) return `OrgAI could not tell which role made this call, so the MCP server "${server}" is not available to it.`
  const spec = servers.find((s) => s.name === server)
  if (!spec) return `The MCP server "${server}" is not configured for this run.`
  if (!spec.enabled) return `The MCP server "${server}" is turned off for this project.`
  if (mcpServersForRole({ mcpServers: [spec] }, caller.role).length) return undefined
  return `The org chart does not grant the MCP server "${server}" to ${callerLabel(caller)}. Hand this step to an agent whose role has it, or ask the user to grant it.`
}

/**
 * The MCP resource tools name their server in input.server; the same per-role grant applies. The harness's own server
 * (no resources) is let through. ListMcpResourcesTool without a server lists every connected server's resources, so it
 * is allowed only when the caller's role is granted every enabled server of the run; otherwise the agent is told to
 * name a server. Read tools without a server are refused (the CLI requires one).
 */
function resourceCallDenial(toolName: string, caller: McpCaller, servers: readonly McpServerSpec[], input: unknown): string | undefined {
  const raw = input && typeof input === 'object' ? (input as { server?: unknown }).server : undefined
  const server = typeof raw === 'string' ? raw.trim() : ''
  if (server) return server === HARNESS_MCP_SERVER ? undefined : serverDenial(server, caller, servers)
  if (toolName !== 'ListMcpResourcesTool') return `${toolName} needs the MCP server name in "server".`
  if (!caller.role) return 'OrgAI could not tell which role made this call, so it cannot list MCP resources.'
  const role = caller.role
  const ungranted = servers.filter((s) => s.enabled && !mcpServersForRole({ mcpServers: [s] }, role).length)
  if (!ungranted.length) return undefined
  return `Listing the resources of every MCP server is not available to ${callerLabel(caller)}, because the org chart does not grant it all of them. Call ${toolName} again with "server" set to a server your role is granted.`
}

/**
 * Allow rules without the server-level MCP rules (`mcp__<server>`, `mcp__<server>__*`) that name one of `servers`.
 * Used for servers an agent installed during this run: a saved or granted server-level rule for a same-named server
 * must not approve every tool of the newly installed one, so its calls keep asking per call. Exact tool rules
 * (`mcp__<server>__<tool>`) and every other rule are kept. Pure.
 */
export function withoutServerRules(rules: readonly string[], servers: ReadonlySet<string>): string[] {
  if (!servers.size) return [...rules]
  return rules.filter((r) => {
    const server = mcpServerOfRule(r)
    return !server || !servers.has(server)
  })
}

/**
 * Names of the MCP servers an agent installed during this run (request_mcp_install): every server the adapter attached
 * mid-run, plus any live server whose source is 'agent' and that the project did not have when the run started.
 * Server-level rules never auto-approve these (withoutServerRules). Pure.
 */
export function agentInstalledServers(
  live: readonly McpServerSpec[],
  savedAtStart: readonly McpServerSpec[] | undefined,
  attached: Iterable<string>
): Set<string> {
  const saved = new Set((savedAtStart ?? []).map((s) => s.id))
  const names = new Set(attached)
  for (const s of live) if (s.source === 'agent' && !saved.has(s.id)) names.add(s.name)
  return names
}

/** Names of the roles a server is granted to, from the live list (empty when it is unknown or off). */
export function rolesGrantedServer(roles: readonly Role[], servers: readonly McpServerSpec[], serverName: string): Role[] {
  const spec = servers.find((s) => s.name === serverName)
  if (!spec) return []
  return roles.filter((r) => mcpServersForRole({ mcpServers: [spec] }, r).length > 0)
}
