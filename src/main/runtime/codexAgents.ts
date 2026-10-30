import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentInstance, AgentMessage, Role } from '@shared/types'
import { newId } from '@shared/defaults'
import { dynamicToolSpec, type DynamicToolSpec } from './codexProtocol'
import { NETWORK_TOOLS } from './codexEvents'
import { HandleNamer, mapSendMessage, messageTranscriptText, resolveRecipient, spawnHandle } from './network'
import { LIST_AGENTS_TOOL, MESSAGE_TOOL } from './prompts'
import { ROOT_AGENT_ID } from './types'
import { gitAutomationRisk, secureGitArgs } from './worktrees'

/**
 * Harness-side subagents for providers without a native spawn: Codex has no Agent tool the harness can
 * govern, so OrgAI implements the org chart itself. Every spawned role is its own Codex thread; this module
 * holds the policy (who may spawn whom, depth, concurrency, handles, message routing) as pure, host-driven
 * logic, and codex.ts supplies the host that talks to the app-server.
 *
 * Dynamic tools exposed to the model (names are what the model calls):
 *   spawn_agent   {role, brief, name?, description?}  roles with canSpawn
 *   send_message  {to, message, summary?}             roles with canSpawn or the SendMessage tool
 *   list_agents   {}                                  roles with canSpawn or the ListAgents tool
 */

export const spawnArgs = z.object({
  role: z.string().min(1).describe('The slug of the role to delegate to, exactly as listed in your instructions'),
  brief: z.string().min(1).describe('A complete, self-contained brief for the report: goal, context, constraints, what to report back'),
  name: z.string().optional().describe('Optional handle for the report (letters, digits, - _ .); default role-1, role-2, ...'),
  description: z.string().optional().describe('Three to six words naming the task, shown on the org chart')
})
export const messageArgs = z.object({
  to: z.string().min(1).describe('Handle of a running agent (such as implementer-2), or "main" for the orchestrator'),
  message: z.string().min(1).describe('The message. Brief and specific.'),
  summary: z.string().optional().describe('Optional five word preview')
})
export const listArgs = z.object({})

export const SPAWN_TOOL_DESCRIPTION =
  'Delegate work to a report in your org chart. Returns at once with the report\'s handle; the report works in the background and its final report arrives later as a message from the harness. Use send_message to follow up with a running report.'
export const MESSAGE_TOOL_DESCRIPTION = 'Send a message to another running agent by handle, or to the orchestrator as "main". It reads the message at its next step.'
export const LIST_TOOL_DESCRIPTION = 'List the agents in this run with their handles, roles and states.'

/** The network tools an agent of this role gets (root = the root role). */
export function networkToolNames(role: Role, opts: { setupLike: boolean }): string[] {
  if (opts.setupLike) return []
  const names: string[] = []
  if (role.canSpawn) names.push(NETWORK_TOOLS.spawn)
  if (role.canSpawn || role.tools.includes(MESSAGE_TOOL)) names.push(NETWORK_TOOLS.message)
  if (role.canSpawn || role.tools.includes(LIST_AGENTS_TOOL)) names.push(NETWORK_TOOLS.list)
  return names
}

export function networkToolSpecs(names: string[]): DynamicToolSpec[] {
  const defs: Record<string, { description: string; inputSchema: z.ZodObject<z.ZodRawShape> }> = {
    [NETWORK_TOOLS.spawn]: { description: SPAWN_TOOL_DESCRIPTION, inputSchema: spawnArgs },
    [NETWORK_TOOLS.message]: { description: MESSAGE_TOOL_DESCRIPTION, inputSchema: messageArgs },
    [NETWORK_TOOLS.list]: { description: LIST_TOOL_DESCRIPTION, inputSchema: listArgs }
  }
  return names.filter((n) => defs[n]).map((name) => dynamicToolSpec({ name, ...defs[name] }))
}

/** Extra developer instructions that map the shared prompts' Claude tool names onto the Codex tool names. */
export function codexToolNotes(toolNames: string[], opts: { renamedPlanTool: boolean }): string {
  const lines: string[] = []
  if (toolNames.includes(NETWORK_TOOLS.spawn)) {
    lines.push(`To delegate (the "Agent tool" in the instructions above), call ${NETWORK_TOOLS.spawn} with role set to the report's slug (the instructions call it subagent_type), a complete brief, and optionally name. It returns at once; the report's final answer reaches you later as a message beginning "Harness:". Do not use Codex's own multi-agent features.`)
  }
  if (toolNames.includes(NETWORK_TOOLS.message)) lines.push(`${MESSAGE_TOOL} in the instructions above is ${NETWORK_TOOLS.message} here.`)
  if (toolNames.includes(NETWORK_TOOLS.list)) lines.push(`${LIST_AGENTS_TOOL} in the instructions above is ${NETWORK_TOOLS.list} here.`)
  if (opts.renamedPlanTool) lines.push('The harness plan tool update_plan is named orgai_update_plan here (update_plan is a different, built-in Codex tool that does not reach the harness). Use set_plan, orgai_update_plan, complete_plan and mark_blocked for the run plan.')
  return lines.length ? `Codex notes:\n${lines.map((l) => `- ${l}`).join('\n')}` : ''
}

// ---------- policy ----------

export interface NetworkOptions {
  roles: Role[]
  root: Role
  maxDepth: number
  maxConcurrent: number
  handles?: HandleNamer
}

export interface SpawnPlan {
  id: string
  role: Role
  parentId: string
  depth: number
  handle: string
}

export type SpawnCheck = ({ ok: true } & SpawnPlan) | { ok: false; message: string }

interface Member {
  id: string
  role: Role
  parentId: string
  depth: number
  handle: string
  live: boolean
}

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/

export class CodexAgentNetwork {
  private members = new Map<string, Member>()
  readonly handles: HandleNamer

  constructor(private opts: NetworkOptions) {
    this.handles = opts.handles ?? new HandleNamer()
  }

  /** The role an agent id runs (root = the root role). */
  roleOf(agentId: string): Role | undefined {
    return agentId === ROOT_AGENT_ID ? this.opts.root : this.members.get(agentId)?.role
  }

  depthOf(agentId: string): number {
    return agentId === ROOT_AGENT_ID ? 0 : (this.members.get(agentId)?.depth ?? 0)
  }

  /** Spawned agents that have not finished their current turn. */
  liveCount(): number {
    return [...this.members.values()].filter((m) => m.live).length
  }

  isLive(agentId: string): boolean {
    return this.members.get(agentId)?.live ?? false
  }

  /** The role slugs `parent` may spawn. */
  allowedSlugs(parent: Role): string[] {
    return this.opts.roles.filter((r) => parent.canSpawn && parent.spawnable.includes(r.id)).map((r) => r.slug)
  }

  private findRole(requested: string): Role | undefined {
    const q = requested.trim().toLowerCase()
    return (
      this.opts.roles.find((r) => r.slug.toLowerCase() === q) ??
      this.opts.roles.find((r) => r.name.toLowerCase() === q) ??
      this.opts.roles.find((r) => r.id === requested.trim())
    )
  }

  /**
   * Validate a spawn and, when allowed, reserve the agent id and handle. Enforces Role.canSpawn, the parent's
   * `spawnable` list (by role id), maxSubagentDepth and maxConcurrentSubagents. Refusals are texts for the model.
   */
  begin(parentId: string, args: { role: string; name?: string }, existing: Iterable<AgentInstance> = []): SpawnCheck {
    const parent = this.roleOf(parentId)
    if (!parent) return { ok: false, message: 'You are not part of this run\'s org chart, so you cannot spawn.' }
    if (!parent.canSpawn) return { ok: false, message: `The org chart does not let ${parent.slug} spawn subagents. Do the work yourself.` }
    const allowed = this.allowedSlugs(parent)
    const target = this.findRole(args.role)
    if (!target || !parent.spawnable.includes(target.id)) {
      return {
        ok: false,
        message: `The org chart does not let ${parent.slug} spawn "${args.role || '(unspecified)'}". Allowed role values: ${allowed.join(', ') || 'none'}.`
      }
    }
    const depth = this.depthOf(parentId) + 1
    if (depth > this.opts.maxDepth) {
      return { ok: false, message: `Subagent depth limit reached (maxSubagentDepth ${this.opts.maxDepth}). ${parent.slug} cannot spawn another level; do this work yourself or hand it back to your lead.` }
    }
    if (this.liveCount() >= this.opts.maxConcurrent) {
      return { ok: false, message: `Concurrent subagent limit reached (${this.opts.maxConcurrent} running). Wait for a report to finish (its result arrives as a message), then spawn again.` }
    }
    const name = args.name?.trim()
    if (name) {
      if (!HANDLE_PATTERN.test(name)) return { ok: false, message: `The name "${name}" is not a valid handle. Use letters, digits, - _ . (at most 41 characters).` }
      const lower = name.toLowerCase()
      if (lower === 'main' || lower === 'orchestrator' || lower === 'user' || [...existing].some((a) => a.handle?.toLowerCase() === lower)) {
        return { ok: false, message: `The handle "${name}" is already in use or reserved. Choose another name.` }
      }
    }
    const { handle } = spawnHandle(this.handles, target.slug, name)
    const id = newId('cx')
    this.members.set(id, { id, role: target, parentId, depth, handle, live: true })
    return { ok: true, id, role: target, parentId, depth, handle }
  }

  /** Spawn failed after begin(): forget the reservation. */
  abort(agentId: string): void {
    this.members.delete(agentId)
  }

  /** The agent's turn ended (it reported). */
  finish(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) m.live = false
  }

  /** The agent got a message and works again. */
  wake(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) m.live = true
  }

  /** Ids of the spawned agents, oldest first. */
  ids(): string[] {
    return [...this.members.keys()]
  }
}

// ---------- tool calls ----------

export interface SpawnRequest extends SpawnPlan {
  brief: string
  description?: string
  /** The dynamic tool call id that spawned it (AgentInstance.spawnToolUseId). */
  callId: string
}

/** What the session provides to the network's tool handlers. */
export interface NetworkHost {
  agents(): Iterable<AgentInstance>
  /** Create the thread (and worktree), register the agent and start its first turn. Throws an Error with a model-readable message. */
  spawn(req: SpawnRequest): Promise<void>
  /** Hand `text` to the agent: steer its running turn, or start one. */
  deliver(toAgentId: string, text: string): Promise<void>
  /** Draw the message on the canvas and keep a copy in the sender's transcript. */
  announce(m: AgentMessage, transcriptText: string): void
}

export interface ToolOutcome {
  text: string
  success: boolean
}

function fail(text: string): ToolOutcome {
  return { text, success: false }
}

function agentLine(a: AgentInstance): string {
  const label = a.id === ROOT_AGENT_ID ? 'main (the orchestrator)' : (a.handle ?? a.id)
  return `${label} · ${a.roleSlug} · ${a.state}${a.activity ? ` — ${a.activity}` : ''}`
}

/** Run one network tool call by `callerId`. Never throws; failures are texts for the model. */
export async function callNetworkTool(
  net: CodexAgentNetwork,
  host: NetworkHost,
  callerId: string,
  callId: string,
  tool: string,
  args: unknown
): Promise<ToolOutcome> {
  try {
    if (tool === NETWORK_TOOLS.list) {
      const lines = [...host.agents()].filter((a) => a.id !== callerId && a.state !== 'done' && a.state !== 'error').map(agentLine)
      return { text: lines.length ? `Running now:\n${lines.join('\n')}` : 'No other agents are running.', success: true }
    }
    if (tool === NETWORK_TOOLS.message) {
      const parsed = messageArgs.safeParse(args)
      if (!parsed.success) return fail(`send_message needs {to, message}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      const agents = [...host.agents()]
      const m = mapSendMessage(callerId, { to: parsed.data.to, message: parsed.data.message }, agents)
      if (!m || !m.to) {
        const live = agents.filter((a) => a.id !== callerId && a.state !== 'done' && a.state !== 'error').map((a) => (a.id === ROOT_AGENT_ID ? 'main' : (a.handle ?? a.id)))
        return fail(`No agent named "${parsed.data.to}" is reachable. ${live.length ? `Reachable now: ${live.join(', ')}.` : 'Nobody else is running.'} (The orchestrator is "main".)`)
      }
      const target = agents.find((a) => a.id === m.to)
      if (target?.state === 'error') return fail(`${m.toHandle} ended with an error and cannot receive messages.`)
      const from = agents.find((a) => a.id === callerId)
      const sender = callerId === ROOT_AGENT_ID ? 'the orchestrator' : (from?.handle ?? from?.roleSlug ?? callerId)
      host.announce(m, messageTranscriptText(m))
      net.wake(m.to)
      await host.deliver(m.to, `Message from ${sender}:\n${parsed.data.message}`)
      return { text: `Delivered to ${m.toHandle}.`, success: true }
    }
    if (tool === NETWORK_TOOLS.spawn) {
      const parsed = spawnArgs.safeParse(args)
      if (!parsed.success) return fail(`spawn_agent needs {role, brief}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      const check = net.begin(callerId, { role: parsed.data.role, name: parsed.data.name }, host.agents())
      if (!check.ok) return fail(check.message)
      try {
        await host.spawn({ ...check, brief: parsed.data.brief, description: parsed.data.description, callId })
      } catch (e) {
        net.abort(check.id)
        return fail(`Could not start ${check.role.slug}: ${(e as Error).message}`)
      }
      return {
        text: `Spawned ${check.handle} (${check.role.slug}). It works in the background; its final report arrives as a message from the harness. Message it with send_message({to: "${check.handle}"}) while it runs.`,
        success: true
      }
    }
    return fail(`Unknown tool ${tool}.`)
  } catch (e) {
    return fail((e as Error).message)
  }
}

export { resolveRecipient }

// ---------- report delivery ----------

/** The harness message that carries a finished report to the agent that spawned it. */
export function reportMessage(child: { handle?: string; name: string; roleSlug: string }, outcome: { status: 'completed' | 'failed'; result?: string; error?: string }): string {
  const who = `${child.handle ?? child.roleSlug} (${child.name})`
  if (outcome.status === 'failed') return `Harness: report from ${who}: it failed${outcome.error ? ` (${outcome.error})` : ''}. ${outcome.result ? `Its last words:\n${outcome.result}` : 'It left no result.'}`
  return `Harness: report from ${who}:\n\n${outcome.result?.trim() || '(it finished without a written report)'}`
}

/** First message of a child's thread. */
export function childFirstMessage(parentLabel: string, brief: string): string {
  return `${brief.trim()}\n\n---\nYou were spawned by ${parentLabel}. When you are done, finish with your final report as your last message; the harness delivers it to ${parentLabel}.`
}

// ---------- worktrees ----------

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', secureGitArgs(args), { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    })
  })
}

/**
 * Create the isolated worktree for a spawned writer, where Claude Code would: `<cwd>/.claude/worktrees/agent-<id>`
 * on branch `worktree-agent-<id>` cut from the HEAD of `cwd` (the repo root, or the parent's worktree for nested
 * isolation), so worktrees.ts (findWorktree, integrateWorktree, pendingWorktrees) and maintenance recognise it.
 */
export async function createAgentWorktree(cwd: string, agentId: string): Promise<{ path: string; branch: string }> {
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) throw new Error(`git worktree add failed: could not resolve HEAD${head.err || head.out ? ` (${head.err || head.out})` : ''}`)
  const risk = await gitAutomationRisk(cwd, head.out)
  if (risk) throw new Error(risk)
  const branch = `worktree-agent-${agentId}`
  const path = join(cwd, '.claude', 'worktrees', `agent-${agentId}`)
  const res = await git(cwd, ['worktree', 'add', '-b', branch, path, head.out])
  if (!res.ok) throw new Error(`git worktree add failed: ${res.err || res.out}`)
  return { path, branch }
}
