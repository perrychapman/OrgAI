import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentInstance, AgentMessage, Effort, ModelTier, Role } from '@shared/types'
import { BRIDGE_BRIEF_MAX_CHARS, EFFORTS, MODEL_TIERS } from '@shared/types'
import { newId } from '@shared/defaults'
import { codexToolName, dynamicToolSpec, type DynamicToolSpec } from './codexProtocol'
import type { HarnessTool } from './harnessTools'
import { NETWORK_TOOLS, canonicalNetworkTool } from './codexEvents'
import { HandleNamer, mapSendMessage, messageTranscriptText, resolveRecipient, spawnHandle } from './network'
import { LIST_AGENTS_TOOL, MESSAGE_TOOL } from './prompts'
import { ROOT_AGENT_ID } from './types'
import { gitExecutable } from '../host/systemBinaries'
import { trackChildProcess } from '../host/shutdown'
import { scrubControlEnv } from './childEnv'

/**
 * Harness-side subagents for providers without a native spawn: Codex has no Agent tool the harness can
 * govern, so OrgAI implements the org chart itself. Every spawned role is its own Codex thread; this module
 * holds the policy (who may spawn whom, depth, concurrency, handles, message routing) as pure, host-driven
 * logic, and codex.ts supplies the host that talks to the app-server.
 *
 * Dynamic tools exposed to the model (names are what the model calls):
 *   spawn_report   {role, brief, name?, description?, tier?, effort?, files?}  roles with canSpawn (files: contextPack.ts)
 *   message_agent  {to, message, summary?}             roles with canSpawn or the SendMessage tool
 *   list_team      {}                                  roles with canSpawn or the ListAgents tool
 * (Before the rename these were spawn_agent, send_message and list_agents, which collided with Codex's built-in multi-agent
 * tools. canonicalNetworkTool maps the old names to the new ones for threads saved earlier.)
 */

export { canonicalNetworkTool }

export const spawnArgs = z.object({
  role: z.string().min(1).describe("The report's role slug"),
  brief: z.string().min(1).describe('Self-contained: goal, context, constraints, what to report back'),
  name: z.string().optional().describe('Handle; default role-1, role-2, ...'),
  description: z.string().optional().describe('Three to six words for the org chart'),
  tier: z.enum(MODEL_TIERS as [ModelTier, ...ModelTier[]]).optional().describe('Model tier; wins over the plan step'),
  effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional().describe('Reasoning effort; wins over the plan step'),
  files: z.array(z.string()).max(8).optional().describe('Up to 8 files in folders this run may read, inlined (24k chars each, 60k total)')
})
export const messageArgs = z.object({
  to: z.string().min(1).describe('A running agent\'s handle (e.g. implementer-2) or "main"'),
  message: z.string().min(1),
  summary: z.string().optional().describe('Five-word preview')
})
export const listArgs = z.object({})

export const SPAWN_TOOL_DESCRIPTION =
  "Delegate work to a report. Returns at once with its handle; the report's final answer arrives later as a harness message. Follow up with message_agent."
export const MESSAGE_TOOL_DESCRIPTION = 'Send a brief message to a running agent by handle, or to the orchestrator as "main"; it reads it at its next step.'
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

/**
 * The dynamic tools a Codex thread of this role gets: the harness tools its audience allows (the root gets every one)
 * and its network tools. CodexAdapter sends these on thread/start; the tool-size budget test measures the same list.
 */
export function codexToolsFor(harness: readonly HarnessTool[], role: Role, isRoot: boolean, opts: { setupLike: boolean }): { specs: DynamicToolSpec[]; names: string[] } {
  const given = harness.filter((t) => isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners'))
  const network = networkToolNames(role, opts)
  return {
    specs: [...given.map(dynamicToolSpec), ...networkToolSpecs(network)],
    names: [...given.map((t) => codexToolName(t.name)), ...network]
  }
}

/** Extra developer instructions that map the shared prompts' Claude tool names onto the Codex tool names. */
/**
 * For a run where Codex still offers its built-in multi-agent tools (the model catalog override in codexNativeCatalog.ts
 * is not in effect): Codex then also adds a developer rule "Do not spawn sub-agents unless the user or applicable
 * AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work", which leads applied
 * to spawn_report. One sentence answering it.
 */
export const NATIVE_RULE_NOTE = `This project's instructions explicitly ask you to delegate through ${NETWORK_TOOLS.spawn}; Codex's rule about not spawning sub-agents concerns its built-in tools, not ${NETWORK_TOOLS.spawn}.`

/**
 * The Codex-only lines appended to a role prompt. `nativeRule`: Codex still offers its built-in multi-agent tools and
 * their rule (the catalog override failed or was not run), so the spawn line also carries NATIVE_RULE_NOTE.
 */
export function codexToolNotes(toolNames: string[], opts: { renamedPlanTool: boolean; nativeRule?: boolean }): string {
  const lines: string[] = []
  if (toolNames.includes(NETWORK_TOOLS.spawn)) {
    lines.push(`To delegate (the "Agent tool" in the instructions above), call ${NETWORK_TOOLS.spawn} with role set to the report's slug (the instructions call it subagent_type), a complete brief, and optionally name. It returns at once; the report's final answer reaches you later as a message beginning "Harness:". Codex's own built-in multi-agent tools (spawn_agent, send_message, wait_agent and similar) are unavailable here and their agents do not count; never use them.${opts.nativeRule ? ` ${NATIVE_RULE_NOTE}` : ''}`)
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
  /** Waiting for required reports: still live for settlement, but not counted against concurrency. */
  parked?: boolean
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
    return [...this.members.values()].filter((m) => m.live && !m.parked).length
  }

  /** The agent waits for its required reports: it stays live but stops counting against the concurrency limit. */
  park(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) m.parked = true
  }

  unpark(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) m.parked = false
  }

  isParked(agentId: string): boolean {
    return this.members.get(agentId)?.parked ?? false
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

  /**
   * A bridged report started (RuntimeContext.bridge): the reservation from begin() takes the agent id and handle the
   * harness gave it, so it counts as a live report (concurrency, depth) until finish(agentId).
   */
  adopt(reservedId: string, agentId: string, handle: string): void {
    const m = this.members.get(reservedId)
    if (!m) return
    this.members.delete(reservedId)
    this.members.set(agentId, { ...m, id: agentId, handle })
  }

  /** Spawn failed after begin(): forget the reservation. */
  abort(agentId: string): void {
    this.members.delete(agentId)
  }

  /** The agent's turn ended (it reported). */
  finish(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) {
      m.live = false
      m.parked = false
    }
  }

  /** The agent got a message and works again. */
  wake(agentId: string): void {
    const m = this.members.get(agentId)
    if (m) {
      m.live = true
      m.parked = false
    }
  }

  /** Spawned agents of `parentId` still working (parked ones included), oldest first. */
  liveChildren(parentId: string): string[] {
    return [...this.members.values()].filter((m) => m.live && m.parentId === parentId).map((m) => m.id)
  }

  /** Every spawned agent still working (parked ones included). */
  liveIds(): Set<string> {
    return new Set([...this.members.values()].filter((m) => m.live).map((m) => m.id))
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
  /** The tier and / or effort stated on the spawn_report call (run staffing); the host resolves them; a bridged host forwards them to the bridge, which resolves them on the child's connection. */
  onCall?: { tier?: ModelTier; effort?: Effort }
  /** Context pack (split-execution 3.2): paths the lead read, inlined by the host into the first message (contextPack.ts). */
  files?: string[]
}

/** What the session provides to the network's tool handlers. */
export interface NetworkHost {
  agents(): Iterable<AgentInstance>
  /** Create the thread (and worktree), register the agent and start its first turn. Throws an Error with a model-readable message. */
  spawn(req: SpawnRequest): Promise<{ staffing?: string; note?: string; pack?: string } | void>
  /**
   * After a successful spawn by `callerId` of `roleId`: one more line for the result (the one-report-and-waiting note,
   * waitingNote.ts), or undefined. Never a refusal.
   */
  afterSpawn?(callerId: string, roleId: string): string | undefined
  /** Hand `text` to the agent: steer its running turn, or start one. */
  deliver(toAgentId: string, text: string): Promise<void>
  /** Draw the message on the canvas and keep a copy in the sender's transcript. */
  announce(m: AgentMessage, transcriptText: string): void
  /**
   * Multi-provider org charts: the connection name when `role` is bridged (RuntimeContext.bridge.roles()), else
   * undefined. A bridged role is never started as a thread; spawn_report routes it to spawnBridged.
   */
  bridgedRole?(role: Role): { connectionName: string } | undefined
  /**
   * Start a bridged report through RuntimeContext.bridge.spawn. Resolves with the harness's agent id and handle once the
   * child exists, after moving the reservation `req.id` to that id (CodexAgentNetwork.adopt, synchronously, so a fast
   * finish is never lost); its final report reaches the parent later as a harness message. Throws a model-readable refusal.
   */
  spawnBridged?(req: SpawnRequest & { name?: string }): Promise<{ agentId: string; handle: string }>
  /** Bridged reports still working, for list_team (they are not threads of this session). */
  bridgedAgents?(): Iterable<{ handle: string; roleSlug: string; connectionName: string }>
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
    tool = canonicalNetworkTool(tool) ?? tool
    if (tool === NETWORK_TOOLS.list) {
      const lines = [...host.agents()].filter((a) => a.id !== callerId && a.state !== 'done' && a.state !== 'error').map(agentLine)
      for (const b of host.bridgedAgents?.() ?? []) lines.push(`${b.handle} · ${b.roleSlug} · running on ${b.connectionName} (its final report arrives as a harness message; it cannot receive messages)`)
      return { text: lines.length ? `Running now:\n${lines.join('\n')}` : 'No other agents are running.', success: true }
    }
    if (tool === NETWORK_TOOLS.message) {
      const parsed = messageArgs.safeParse(args)
      if (!parsed.success) return fail(`message_agent needs {to, message}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
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
      if (!parsed.success) return fail(`spawn_report needs {role, brief}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
      const check = net.begin(callerId, { role: parsed.data.role, name: parsed.data.name }, host.agents())
      if (!check.ok) return fail(check.message)
      // A bridged role runs in its own child session on another connection (RuntimeContext.bridge), never as a thread.
      const bridged = host.bridgedRole?.(check.role)
      if (bridged) {
        // Same cap and wording as delegate_agent (the brief becomes the child's first message).
        if (parsed.data.brief.trim().length > BRIDGE_BRIEF_MAX_CHARS) {
          net.abort(check.id)
          return fail(`REFUSED: the brief is longer than ${BRIDGE_BRIEF_MAX_CHARS} characters. Shorten it.`)
        }
        if (!host.spawnBridged) {
          net.abort(check.id)
          return fail(`Could not start ${check.role.slug}: it runs on ${bridged.connectionName}, which this session cannot reach.`)
        }
        let started: { agentId: string; handle: string }
        try {
          const name = parsed.data.name?.trim()
          started = await host.spawnBridged({ ...check, brief: parsed.data.brief, description: parsed.data.description, callId, ...(name ? { name } : {}), ...(parsed.data.tier || parsed.data.effort ? { onCall: { ...(parsed.data.tier ? { tier: parsed.data.tier } : {}), ...(parsed.data.effort ? { effort: parsed.data.effort } : {}) } } : {}) })
        } catch (e) {
          net.abort(check.id)
          return fail(`Could not start ${check.role.slug}: ${(e as Error).message}`)
        }
        // The host already moved the reservation to the harness's agent id (CodexAgentNetwork.adopt) when the child started.
        const unpacked = parsed.data.files?.length ? ` The files you named were not inlined: it runs in its own session on ${bridged.connectionName}; put what it needs in the brief.` : ''
        return {
          text: `Spawned ${started.handle} (${check.role.slug}) on ${bridged.connectionName}. It works in the background in its own session; its final report arrives as a message from the harness. It cannot receive message_agent while it runs.${unpacked}${afterSpawnLine(host, callerId, check.role.id)}`,
          success: true
        }
      }
      const onCall: { tier?: ModelTier; effort?: Effort } = {}
      if (parsed.data.tier) onCall.tier = parsed.data.tier
      if (parsed.data.effort) onCall.effort = parsed.data.effort
      let staffing: string | undefined
      let note: string | undefined
      let pack: string | undefined
      try {
        const files = parsed.data.files
        const started = await host.spawn({ ...check, brief: parsed.data.brief, description: parsed.data.description, callId, ...(onCall.tier || onCall.effort ? { onCall } : {}), ...(files?.length ? { files } : {}) })
        staffing = started?.staffing
        note = started?.note
        pack = started?.pack
      } catch (e) {
        net.abort(check.id)
        return fail(`Could not start ${check.role.slug}: ${(e as Error).message}`)
      }
      return {
        text: `Spawned ${check.handle} (${check.role.slug})${staffing ? ` on ${staffing}` : ''}. It works in the background; its final report arrives as a message from the harness. Message it with message_agent({to: "${check.handle}"}) while it runs.${note ? ` ${note}` : ''}${pack ? ` ${pack}` : ''}${afterSpawnLine(host, callerId, check.role.id)}`,
        success: true
      }
    }
    return fail(`Unknown tool ${tool}.`)
  } catch (e) {
    return fail((e as Error).message)
  }
}

export { resolveRecipient }

/** host.afterSpawn's line with a leading space, or ''. A throw is ignored: the spawn already happened. */
function afterSpawnLine(host: NetworkHost, callerId: string, roleId: string): string {
  try {
    const line = host.afterSpawn?.(callerId, roleId)
    return line ? ` ${line}` : ''
  } catch {
    return ''
  }
}

// ---------- report delivery ----------

/** A report longer than this is delivered as its head and tail with a notice of what was left out. */
export const REPORT_HANDBACK_MAX_CHARS = 16_000

/** `text` as is when it fits REPORT_HANDBACK_MAX_CHARS, else its first and last part around a one-line notice (no surrogate pair is split). */
export function capHandback(text: string): string {
  if (text.length <= REPORT_HANDBACK_MAX_CHARS) return text
  const half = Math.floor((REPORT_HANDBACK_MAX_CHARS - 200) / 2)
  const safe = (t: string, end: 'head' | 'tail'): string => {
    const c = end === 'head' ? t.charCodeAt(t.length - 1) : t.charCodeAt(0)
    if (end === 'head' && c >= 0xd800 && c <= 0xdbff) return t.slice(0, -1)
    if (end === 'tail' && c >= 0xdc00 && c <= 0xdfff) return t.slice(1)
    return t
  }
  const head = safe(text.slice(0, half), 'head')
  const tail = safe(text.slice(text.length - half), 'tail')
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters of the report left out; the beginning and the end are shown ...]\n\n${tail}`
}

/** The harness message that carries a finished report to the agent that spawned it. */
export function reportMessage(child: { handle?: string; name: string; roleSlug: string }, outcome: { status: 'completed' | 'failed'; result?: string; error?: string }): string {
  const who = `${child.handle ?? child.roleSlug} (${child.name})`
  if (outcome.status === 'failed') return `Harness: report from ${who}: it failed${outcome.error ? ` (${outcome.error})` : ''}. ${outcome.result ? `Its last words:\n${capHandback(outcome.result)}` : 'It left no result.'}`
  return `Harness: report from ${who}:\n\n${capHandback(outcome.result?.trim() ?? '') || '(it finished without a written report)'}`
}

/** First message of a child's thread. */
export function childFirstMessage(parentLabel: string, brief: string): string {
  return `${brief.trim()}\n\n---\nYou were spawned by ${parentLabel}. When you are done, finish with your final report as your last message; the harness delivers it to ${parentLabel}.`
}

// ---------- worktrees ----------

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  // By absolute path (review H1): a bare 'git' is searched in the cwd (the checkout) first on Windows.
  const bin = gitExecutable()
  if (!bin) return Promise.resolve({ ok: false, out: '', err: 'git was not found on PATH.' })
  return new Promise((resolve) => {
    const child = execFile(bin, args, { cwd, env: scrubControlEnv(process.env), windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout).trim(), err: String(stderr ?? error?.message ?? '').trim() })
    })
    // Ended with the host at the shutdown's hard limit (cli-standalone.md 4.3).
    trackChildProcess(child, 'git')
  })
}

/**
 * Create the isolated worktree for a spawned writer, where Claude Code would: `<cwd>/.claude/worktrees/agent-<id>`
 * on branch `worktree-agent-<id>` cut from the HEAD of `cwd` (the repo root, or the parent's worktree for nested
 * isolation), so worktrees.ts (findWorktree, integrateWorktree, pendingWorktrees) and maintenance recognise it.
 */
export async function createAgentWorktree(cwd: string, agentId: string): Promise<{ path: string; branch: string }> {
  const branch = `worktree-agent-${agentId}`
  const path = join(cwd, '.claude', 'worktrees', `agent-${agentId}`)
  const res = await git(cwd, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  if (!res.ok) throw new Error(`git worktree add failed: ${res.err || res.out}`)
  return { path, branch }
}
