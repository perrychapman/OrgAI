import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type McpServerConfig,
  type SdkPluginConfig,
  type ModelUsage,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type SDKMessage,
  type SDKUserMessage,
  type Query
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentInstance, ImageAttachment, McpServerSpec, PluginSpec, Project, Role, RunEvent, TranscriptBlock, UsageStatus, WorktreeInfo } from '@shared/types'
import type { PermissionDecision, PermissionSuggestion, ProviderAuth } from '@shared/types'
import { SPAWN_TOOL } from '@shared/types'
import { mcpServersForRole, newId } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type CompletionInput, type ResolvedMcpServer, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { applyAllowScope, chooseSuggestions, listRules, suggestionLabels } from './permissionRules'
import { isGitRepo } from './worktrees'
import { costOf, ratesFromModelUsage, type CostRates, type TokenMix } from './claudeCost'
import { PartialText } from './claudePartial'
import { SETUP_TOOLS_INSTRUCTIONS, harnessToolsFor, isBlockingHarnessTool, type HarnessTool } from './harnessTools'
import { matchingRule } from './ruleMatch'
import { ContinuationDriver, stepActivity } from './continuation'
import { LIST_AGENTS_TOOL, MESSAGE_TOOL, buildRolePrompt, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { HandleNamer, mapSendMessage, messageTranscriptText, spawnHandle } from './network'
import { describeTool } from './activity'
import { WorktreeIntegrator } from './integration'
import { resolveParent } from './agentTree'
import {
  mapRateLimitEvent,
  mapUsageResponse,
  mergeUsage,
  shareUsed,
  shouldSteerToSonnet,
  trackShare,
  windowShareExceeded,
  type AuthMode,
  type RateLimitInfoLike,
  type ShareTracker,
  type UsageResponseLike
} from './usage'

/** How often a live session asks for plan usage. */
const USAGE_POLL_MS = 60_000
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const DEFAULT_OPUS_GUARD = 80

type UserContent = SDKUserMessage['message']['content']

/**
 * Content for a user turn. Plain string when there are no images; otherwise image blocks first, then the
 * text block (left out when the text is empty).
 */
export function userContent(text: string, images?: ImageAttachment[]): UserContent {
  if (!images?.length) return text
  const blocks: Exclude<UserContent, string> = images.map((i) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: i.mediaType, data: i.data }
  }))
  if (text) blocks.push({ type: 'text', text })
  return blocks
}

/** The transcript block for a user message; `images` is left off when there are none. */
function userBlock(text: string, images?: ImageAttachment[]): TranscriptBlock {
  return images?.length ? { kind: 'user', text, images } : { kind: 'user', text }
}

function isOpusModel(model: string | undefined): boolean {
  return !!model && /opus/i.test(model)
}

/**
 * The Claude adapter: maps Claude Agent SDK messages and hooks onto normalized RunEvents. Everything
 * that is not SDK mechanics lives in the shared runtime modules: harness tools (harnessTools.ts),
 * role prompts (prompts.ts), activity strings (activity.ts), worktree integration (integration.ts)
 * and permission scopes (permissionRules.ts).
 */

/**
 * Inside a packaged Electron app the SDK resolves its native CLI to a path inside app.asar, which
 * cannot be spawned. electron-builder unpacks that binary beside the archive (app.asar.unpacked),
 * so point the SDK there. Outside a package this returns undefined and the SDK's default is used.
 */
function packagedClaudeExecutable(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    if (!pkgJson.includes('app.asar')) return undefined
    const dir = dirname(pkgJson).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}
const CLAUDE_EXECUTABLE = packagedClaudeExecutable()
const EXECUTABLE_OPTION = CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE } : {}

const ROOT_ID = ROOT_AGENT_ID
/** MCP server name for the harness's own tools; tool names surface as mcp__orgai__<name>. */
const ORGAI_MCP = 'orgai'
const ORGAI_TOOL_PREFIX = `mcp__${ORGAI_MCP}__`

/** Activity string for an SDK tool name; harness tools lose their MCP prefix first. */
function describe(name: string, input: unknown): string {
  if (name.startsWith(ORGAI_TOOL_PREFIX)) return describeTool(name.slice(ORGAI_TOOL_PREFIX.length), input, { harness: true })
  return describeTool(name, input)
}

/** A push-based async iterable used as the SDK's streaming prompt input. */
class PushStream<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

/** Server-level tool rule for an MCP server. UNVERIFIED inside an AgentDefinition.tools whitelist (documented for permission rules). */
export function mcpToolRule(serverName: string): string {
  return `mcp__${serverName}`
}

/** Names of the MCP servers a role may use (mcpServersForRole), root included. */
export function agentMcpServerNames(project: Pick<Project, 'mcpServers'>, role: Pick<Role, 'slug' | 'mcpServers'>): string[] {
  return mcpServersForRole(project, role).map((s) => s.name)
}

/** SDK server configs for the resolved MCP servers, keyed by spec.name. Entries missing their command or url are skipped. */
export function toClaudeMcpServers(resolved: ResolvedMcpServer[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const r of resolved) {
    const { spec } = r
    if (spec.transport === 'stdio') {
      if (!spec.command) continue
      out[spec.name] = {
        type: 'stdio',
        command: spec.command,
        ...(spec.args?.length ? { args: [...spec.args] } : {}),
        ...(Object.keys(r.env).length ? { env: { ...r.env } } : {})
      }
    } else {
      if (!spec.url) continue
      out[spec.name] = {
        type: spec.transport,
        url: spec.url,
        ...(Object.keys(r.headers).length ? { headers: { ...r.headers } } : {})
      }
    }
  }
  return out
}

/** Enabled project plugins as SDK plugin configs. Note: strictMcpConfig also stops plugin-declared MCP servers from loading. */
export function toClaudePlugins(plugins: PluginSpec[] | undefined): SdkPluginConfig[] {
  return (plugins ?? []).filter((p) => p.enabled).map((p) => ({ type: 'local' as const, path: p.path }))
}

/** Secret values to keep out of logs: resolved MCP secrets plus the connection's tokens and key. */
export function collectSecrets(resolved: ResolvedMcpServer[], connection: RuntimeContext['connection']): string[] {
  const out = new Set<string>()
  for (const r of resolved) {
    for (const n of r.spec.secretEnv ?? []) if (r.env[n]) out.add(r.env[n])
    for (const n of r.spec.secretHeaders ?? []) if (r.headers[n]) out.add(r.headers[n])
  }
  for (const [k, v] of Object.entries(connection?.env ?? {})) if (v && /TOKEN|KEY|SECRET|PASSWORD/i.test(k)) out.add(v)
  if (connection?.apiKey) out.add(connection.apiKey)
  return [...out].filter((v) => v.length >= 4)
}

/** Replace every secret value in a log line. Longest first so a secret containing another is fully hidden. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) if (v) out = out.split(v).join('***')
  return out
}

/** True when the run reaches its models through a non-anthropic connection (LiteLLM). */
export function usesProxy(ctx: Pick<RuntimeContext, 'connection'>): boolean {
  return !!ctx.connection && ctx.connection.connection !== 'anthropic'
}

/** Child-process environment. A non-anthropic connection authenticates with its own token, never ANTHROPIC_API_KEY. */
export function buildEnv(ctx: RuntimeContext, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { project } = ctx
  const env: Record<string, string | undefined> = {
    ...base,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(project.maxSubagentDepth),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(project.maxConcurrentSubagents),
    // Only org-chart roles may be spawned; drop the SDK's built-in general-purpose default.
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1'
  }
  if (usesProxy(ctx)) delete env.ANTHROPIC_API_KEY
  else if (project.provider.auth.kind === 'apiKey') env.ANTHROPIC_API_KEY = base[project.provider.auth.envVar]
  Object.assign(env, ctx.connection?.env)
  return env
}

/**
 * The AgentDefinitions for a run. The root gets every harness tool, a canSpawn role the 'spawners' ones; each
 * role gets a server-level rule and an mcpServers entry for every MCP server granted to it.
 */
export function buildAgents(
  ctx: RuntimeContext,
  harness: Pick<HarnessTool, 'name' | 'audience'>[],
  isolation: boolean,
  mcpSpecs: Pick<Project, 'mcpServers'> = ctx.project
): Record<string, AgentDefinition> {
  const isSetup = isSetupLikeRun(ctx.run.kind)
  const agents: Record<string, AgentDefinition> = {}
  for (const role of ctx.roles) {
    const tools: string[] = [...role.tools]
    const isRoot = role.reportsTo === null
    for (const t of harness) if (isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners')) tools.push(`${ORGAI_TOOL_PREFIX}${t.name}`)
    if (role.canSpawn) tools.push(SPAWN_TOOL)
    // A lead addresses its running reports by handle, so it always gets the messaging tools on work runs.
    if (role.canSpawn && !isSetup) for (const t of [MESSAGE_TOOL, LIST_AGENTS_TOOL]) if (!tools.includes(t)) tools.push(t)
    const mcp = agentMcpServerNames(mcpSpecs, role)
    for (const name of mcp) if (!tools.includes(mcpToolRule(name))) tools.push(mcpToolRule(name))
    const def: AgentDefinition = {
      description: role.description,
      prompt: buildRolePrompt(role, ctx.roles, ctx.project, { isSetup, isolation }),
      tools,
      model: role.model || 'inherit'
    }
    if (mcp.length) def.mcpServers = mcp
    if (role.effort) def.effort = role.effort
    agents[role.slug] = def
  }
  return agents
}

/**
 * Who called a harness tool. PreToolUse sees every call with its tool_use_id and agent_id (absent for the
 * root); the MCP handler may only see the tool name, so calls are matched by tool_use_id when the handler's
 * request metadata carries it, otherwise first-in-first-out per tool name.
 */
export class HarnessCallerTracker {
  private byToolUse = new Map<string, string | undefined>()
  private queues = new Map<string, Array<{ toolUseId?: string; agentId?: string }>>()

  /** Record a PreToolUse sighting. agentId is the SDK agent id (undefined for the root). */
  record(toolName: string, toolUseId: string | undefined, agentId: string | undefined): void {
    if (toolUseId) this.byToolUse.set(toolUseId, agentId)
    this.queues.set(toolName, [...(this.queues.get(toolName) ?? []), { toolUseId, agentId }])
  }

  /** Resolve and consume the caller; undefined means the root (or unknown). Never throws. */
  resolve(toolName: string, meta?: unknown): string | undefined {
    try {
      const id = toolUseIdFromMeta(meta)
      const queue = this.queues.get(toolName) ?? []
      if (id && this.byToolUse.has(id)) {
        const agentId = this.byToolUse.get(id)
        this.byToolUse.delete(id)
        const i = queue.findIndex((e) => e.toolUseId === id)
        if (i >= 0) queue.splice(i, 1)
        return agentId
      }
      const next = queue.shift()
      if (next?.toolUseId) this.byToolUse.delete(next.toolUseId)
      return next?.agentId
    } catch {
      return undefined
    }
  }
}

/** Pull a tool_use id out of MCP request _meta (key name unverified at runtime). */
export function toolUseIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  for (const key of ['claudecode/toolUseId', 'toolUseId', 'tool_use_id']) {
    const v = m[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/** The harness's tools as an in-process MCP server; the model sees them as mcp__orgai__<name>. */
function buildHarnessServer(tools: HarnessTool[], callers: HarnessCallerTracker, instructions?: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ORGAI_MCP,
    version: '1.0.0',
    ...(instructions ? { instructions } : {}),
    tools: tools.map((t) =>
      tool(t.name, t.description, t.inputSchema.shape, async (args, extra) => {
        const agentId = callers.resolve(ORGAI_TOOL_PREFIX + t.name, (extra as { _meta?: unknown } | undefined)?._meta)
        return { content: [{ type: 'text' as const, text: await t.call(args, agentId ? { agentId } : undefined) }] }
      })
    )
  })
}

function permissionKey(toolName: string, input: unknown): string {
  try {
    return `${toolName}\u0000${JSON.stringify(input ?? {})}`
  } catch {
    return toolName
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

class ClaudeSession implements RuntimeSession {
  readonly finished: Promise<void>
  private input = new PushStream<SDKUserMessage>()
  private abort = new AbortController()
  private q!: Query
  private agents = new Map<string, AgentInstance>()
  /** tool_use id -> agent that issued it */
  private toolUseIssuer = new Map<string, string>()
  /** Agent tool_use id -> spawned task/agent id */
  private taskByToolUse = new Map<string, string>()
  /** tool name -> last agent seen requesting it (permission attribution fallback) */
  private lastToolAgent = new Map<string, string>()
  /**
   * tool name + input -> agents that issued exactly that call and have not been through
   * canUseTool yet. PreToolUse fires before the permission check and carries agent_id;
   * canUseTool carries neither an agent nor a tool_use id, so the call is matched by content.
   */
  private pendingPermissionIssuers = new Map<string, string[]>()
  private harnessCallers = new HarnessCallerTracker()
  private rolesBySlug: Map<string, Role>
  private root: Role
  private isSetup: boolean
  /** Writing reports get their own git worktree. Only for work runs inside a git repository. */
  private isolation: boolean
  /** Agent tool_use ids that were given isolation:"worktree" -> the spawning agent's id (ROOT_ID for the orchestrator). */
  private isolatedSpawns = new Map<string, string>()
  /** Commits and merges isolated reports' branches; tells the orchestrator through notifyOrchestrator. */
  private integrator: WorktreeIntegrator
  private sessionLogged = false
  /** The in-process harness MCP server; kept so setMcpServers can send it again. */
  private harnessServer?: McpSdkServerConfigWithInstance
  /** Secret values (MCP env/headers, connection tokens) redacted from logged lines. Never emitted. */
  private secrets = new Set<string>()
  /** Generates report handles (implementer-1, implementer-2) for spawns that did not name themselves. */
  private handles = new HandleNamer()
  /** Agent tool_use id -> the handle the report was spawned with; stored on the agent at task_started. */
  private spawnHandles = new Map<string, string>()
  /** agent id -> message id -> latest usage, so streamed and re-sent messages are counted once. */
  private usageByMessage = new Map<string, Map<string, { input: number; output: number; model?: string; mix: TokenMix }>>()
  /** Per-model USD rates from the latest result message; applied to new tokens until the next result. */
  private costRates: CostRates | null = null
  /** Streamed text per agent, throttled into agent.partial events. */
  private partial = new PartialText((agentId, text) => this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text }))
  private seenBlocks = new Set<string>()
  private seenToolUses = new Set<string>()
  /** Resumed sessions only: tool results already shown, in case the SDK replays history. */
  private seenToolResults = new Set<string>()
  /** Resumed sessions only: subtracted from the SDK's cumulative cost; null until the first result. */
  private resumeCostBase: number | null = null
  // ---------- subscription usage ----------
  private authMode: AuthMode
  private usage: UsageStatus | null = null
  private usageTimer: ReturnType<typeof setInterval> | null = null
  private usageUnavailableLogged = false
  /** This run's share of the five-hour window, for project.maxWindowShare. */
  private share: ShareTracker | null = null
  private capTripped = false
  /** Why the window cap stopped the run; sent to the orchestrator with the user's next message. */
  private pendingCapNote: string | null = null
  /** Set once the provider rejected a request on a usage limit. */
  private limited = false
  private ending = false
  /** Unattended execution: re-engages the orchestrator when a turn ends with plan steps left. */
  private continuation: ContinuationDriver

  constructor(private ctx: RuntimeContext) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = isSetupLikeRun(ctx.run.kind)
    this.isolation = !this.isSetup && ctx.project.isolateWriters !== false && isGitRepo(ctx.project.path)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
    // A proxy connection (LiteLLM) has no subscription plan windows: treat it like an API key.
    this.authMode = usesProxy(ctx) || ctx.project.provider.auth.kind === 'apiKey' ? 'apiKey' : 'unknown'
    this.integrator = new WorktreeIntegrator(ctx, {
      agent: (id) => this.agents.get(id),
      setWorktree: (id, info) => {
        const a = this.agents.get(id)
        if (!a) return
        a.worktree = info
        this.upsert(a)
      },
      notify: (text) => this.notifyOrchestrator(text)
    })
    this.continuation = new ContinuationDriver({
      kind: ctx.run.kind,
      autoContinue: ctx.autoContinue,
      maxAutoContinues: ctx.maxAutoContinues,
      delayMs: ctx.continuationDelayMs,
      getPlan: () => ctx.getPlan(),
      updatePlan: (plan) => ctx.updatePlan(plan),
      liveReports: () => [...this.agents.values()].filter((a) => a.id !== ROOT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => this.limited,
      // A window-cap stop waits for the user like an interrupt does.
      stopping: () => this.ending || this.capTripped || this.abort.signal.aborted,
      orchestratorBusy: () => {
        const root = this.agents.get(ROOT_ID)
        return !!root && root.state !== 'idle' && root.state !== 'done'
      },
      nudge: (text, activity) => {
        this.notifyOrchestrator(text, activity)
        this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
      },
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_ID, { kind: 'system', text })
    })
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    // After a window-cap stop, the orchestrator learns why with the user's next message, and the cap
    // measures afresh from here.
    const note = this.pendingCapNote
    this.pendingCapNote = null
    if (this.capTripped) {
      this.capTripped = false
      this.share = null
    }
    const composed = note ? (text ? `${note}\n\n---\n${text}` : note) : text
    this.input.push({
      type: 'user',
      message: { role: 'user', content: userContent(composed, images) },
      parent_tool_use_id: null
    })
    this.transcript(ROOT_ID, userBlock(text, images))
    this.setState(ROOT_ID, 'thinking', 'Thinking…')
  }

  async interrupt(): Promise<void> {
    // An interrupted turn waits for the user; no automatic continue until they reply.
    this.continuation.hold()
    try {
      await this.q?.interrupt()
    } catch (e) {
      this.log('warn', `Interrupt failed: ${(e as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    this.continuation.dispose()
    this.stopUsagePolling()
    this.input.end()
    this.abort.abort()
  }

  // ---------- internals ----------

  private emit(e: RunEvent): void {
    this.ctx.emit(e)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private transcript(agentId: string, block: TranscriptBlock): void {
    this.emit({
      type: 'transcript',
      runId: this.ctx.run.id,
      entry: { id: newId('t'), agentId, at: Date.now(), block }
    })
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent } })
  }

  private ensureAgent(id: string, init?: Partial<AgentInstance>): AgentInstance {
    let a = this.agents.get(id)
    if (!a) {
      const slug = init?.roleSlug ?? 'general-purpose'
      const role = this.rolesBySlug.get(slug)
      a = {
        id,
        roleId: role?.id ?? null,
        roleSlug: slug,
        name: role?.name ?? slug,
        parentId: id === ROOT_ID ? null : ROOT_ID,
        spawnToolUseId: null,
        state: 'starting',
        activity: 'Starting…',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: Date.now(),
        ...init
      }
      this.upsert(a)
    }
    return a
  }

  private setState(id: string, state: AgentInstance['state'], activity?: string): void {
    const a = this.ensureAgent(id)
    a.state = state
    if (activity !== undefined) a.activity = activity
    if (state === 'done' || state === 'error') a.endedAt = Date.now()
    this.upsert(a)
  }

  /**
   * Split the run's cost across agents: per-model rates come from the result's cumulative modelUsage,
   * each agent pays for its own token mix at those rates. Emits agent.upsert for every agent whose cost moved.
   */
  private apportionCost(modelUsage: Record<string, ModelUsage> | undefined): void {
    const rates = ratesFromModelUsage(modelUsage)
    if (!rates) return
    this.costRates = rates
    for (const [agentId, perAgent] of this.usageByMessage) {
      const a = this.agents.get(agentId)
      if (!a) continue
      const cost = costOf(perAgent.values(), rates)
      if (Math.abs(cost - a.costUsd) < 1e-9) continue
      a.costUsd = cost
      this.upsert(a)
    }
  }

  /** Queue a harness message for the orchestrator; it starts a new turn if the orchestrator is idle. */
  private notifyOrchestrator(text: string, activity = 'Integrating a report…'): void {
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.transcript(ROOT_ID, { kind: 'system', text })
    const root = this.agents.get(ROOT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_ID, 'thinking', activity)
  }

  /** An agent called SendMessage: draw it on the canvas and keep a copy in the sender's transcript. */
  private onAgentMessage(fromId: string, toolInput: Record<string, unknown>): void {
    const m = mapSendMessage(fromId, toolInput, this.agents.values())
    if (!m) return
    this.emit({ type: 'agent.message', runId: this.ctx.run.id, ...m })
    this.transcript(fromId, { kind: 'system', text: messageTranscriptText(m) })
  }

  /** Pop the issuer of a pending call. With an agent id, removes that agent's entry; otherwise the oldest. */
  private takeIssuer(key: string, agentId?: string): string | undefined {
    const queue = this.pendingPermissionIssuers.get(key)
    if (!queue?.length) return undefined
    const idx = agentId ? queue.indexOf(agentId) : 0
    if (idx === -1) return undefined
    const [issuer] = queue.splice(idx, 1)
    if (!queue.length) this.pendingPermissionIssuers.delete(key)
    return issuer
  }

  private resolveAgentId(msg: { agent_id?: string; parent_tool_use_id: string | null }): string {
    if (msg.agent_id) return msg.agent_id
    if (msg.parent_tool_use_id) return this.taskByToolUse.get(msg.parent_tool_use_id) ?? ROOT_ID
    return ROOT_ID
  }

  // ---------- subscription usage ----------

  private startUsagePolling(): void {
    if (this.usageTimer) return
    if (this.authMode === 'apiKey') {
      // API keys have no plan windows; say so once so the meter can show it.
      if (!this.usage) this.applyUsage(mapUsageResponse(null, 'apiKey'))
      return
    }
    void this.pollUsage()
    this.usageTimer = setInterval(() => void this.pollUsage(), USAGE_POLL_MS)
  }

  private stopUsagePolling(): void {
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.usageTimer = null
  }

  /** Ask the SDK for plan usage. The method is experimental: missing or failing means "unavailable", never a run error. */
  private async pollUsage(): Promise<void> {
    let resp: UsageResponseLike | null = null
    try {
      const fn = (this.q as unknown as Record<string, unknown> | undefined)?.[USAGE_METHOD]
      if (typeof fn !== 'function') throw new Error('this SDK has no usage method')
      resp = (await (fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(this.q, { skipBehaviors: true })) as UsageResponseLike
    } catch (e) {
      if (!this.usageUnavailableLogged) {
        this.usageUnavailableLogged = true
        this.log('info', `Plan usage is unavailable: ${(e as Error).message}`)
      }
    }
    if (this.ending && !this.usageTimer) return
    const report = mapUsageResponse(resp, this.authMode)
    if (report.available && this.authMode === 'unknown') this.authMode = 'subscription'
    this.applyUsage(mergeUsage(this.usage, report))
  }

  private applyUsage(usage: UsageStatus): void {
    this.usage = usage
    this.emit({ type: 'usage.status', runId: this.ctx.run.id, usage })
    this.checkWindowShare()
  }

  /** project.maxWindowShare: interrupt the run once it has used that many points of the five-hour window. */
  private checkWindowShare(): void {
    const cap = this.ctx.project.maxWindowShare
    const util = this.usage?.windows.fiveHour?.utilization
    if (this.isSetup || !cap || typeof util !== 'number') return
    this.share = trackShare(this.share, util)
    if (this.capTripped || !windowShareExceeded(0, shareUsed(this.share), cap)) return
    this.capTripped = true
    const used = Math.round(shareUsed(this.share))
    this.log('warn', `This run used ${used}% of the five-hour usage window (cap ${cap}%); interrupting it.`)
    void this.interrupt()
    const note =
      `[OrgAI harness] The run was interrupted because it used ${used}% of the plan's five-hour usage window, ` +
      `above the project's cap of ${cap}%. Reports in flight may have been cut off. Pick up from where things stand, ` +
      'and keep the remaining work lean.'
    this.pendingCapNote = note
    this.transcript(ROOT_ID, { kind: 'system', text: note })
    this.setState(ROOT_ID, 'idle', `Stopped: used ${used}% of the five-hour window`)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
  }

  /** The provider rejected a request on a usage limit. The session ends at the next result and the run pauses. */
  private onRateLimited(until: number | undefined, window: string | undefined): void {
    if (this.authMode === 'apiKey') return
    if (!this.limited) {
      this.limited = true
      const when = until ? new Date(until).toLocaleString() : 'unknown'
      this.log('warn', `Usage limit reached${window ? ` (${window.replace(/_/g, ' ')} window)` : ''}; resets ${when}. The run pauses and continues then.`)
    }
    this.ctx.rateLimited({ ...(until ? { until } : {}), ...(window ? { window } : {}) })
  }

  /** Spawn a report on Sonnet instead of Opus while the Opus weekly window is near its limit? */
  private steerToSonnet(target: Role | undefined, toolInput: Record<string, unknown>): boolean {
    if (this.isSetup || usesProxy(this.ctx) || !this.ctx.project.preferSonnetNearLimit || this.authMode === 'apiKey') return false
    const explicit = typeof toolInput.model === 'string' && toolInput.model ? toolInput.model : undefined
    let model = explicit ?? target?.model ?? 'inherit'
    if (model === 'inherit') model = this.root.model && this.root.model !== 'inherit' ? this.root.model : (this.agents.get(ROOT_ID)?.model ?? '')
    return isOpusModel(model) && shouldSteerToSonnet(this.usage, this.ctx.opusGuardThreshold ?? DEFAULT_OPUS_GUARD)
  }

  private buildHooks(): Options['hooks'] {
    const hookAllow = (reason: string): HookJSONOutput => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason }
    })
    const preToolUse: HookCallback = async (raw) => {
      const input = raw as PreToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      this.lastToolAgent.set(input.tool_name, agentId)
      if (input.tool_name.startsWith(ORGAI_TOOL_PREFIX)) this.harnessCallers.record(input.tool_name, input.tool_use_id, input.agent_id)
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
      const key = permissionKey(input.tool_name, toolInput)
      this.pendingPermissionIssuers.set(key, [...(this.pendingPermissionIssuers.get(key) ?? []), agentId])

      if (input.tool_name === SPAWN_TOOL || input.tool_name === 'Task') {
        const parentSlug = input.agent_type ?? this.root.slug
        const parentRole = this.rolesBySlug.get(parentSlug)
        const requested = String(toolInput.subagent_type ?? '')
        const allowedSlugs = parentRole
          ? this.ctx.roles.filter((r) => parentRole.spawnable.includes(r.id)).map((r) => r.slug)
          : []
        const allowed = !!parentRole && parentRole.canSpawn && allowedSlugs.includes(requested)
        if (!allowed) {
          const reason = parentRole?.canSpawn
            ? `The org chart does not let ${parentSlug} spawn "${requested || '(unspecified)'}". Allowed subagent_type values: ${allowedSlugs.join(', ') || 'none'}.`
            : `The org chart does not let ${parentSlug} spawn subagents. Do the work yourself.`
          this.log('warn', `Blocked spawn: ${parentSlug} -> ${requested || '(unspecified)'}`)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason
            }
          }
        }
        this.setState(agentId, 'delegating', describe(input.tool_name, toolInput))
        // Writing reports get their own worktree when their parent is the orchestrator or is itself
        // isolated (nested isolation). A nested spawn runs from the parent's worktree, so Claude Code
        // cuts the child's branch from the parent's branch; the integrator merges it back into the
        // parent's worktree (see worktrees.ts). Writers under a non-isolated parent share its checkout.
        const target = this.rolesBySlug.get(requested)
        const parentIsolated = !input.agent_id || !!this.integrator.worktreeOf(input.agent_id)
        const updates: Record<string, unknown> = {}
        // Every report gets a handle so peers and its lead can reach it with SendMessage({to: handle}).
        const { handle, generated } = spawnHandle(this.handles, requested, toolInput.name)
        this.spawnHandles.set(input.tool_use_id, handle)
        if (generated) updates.name = handle
        if (this.isolation && parentIsolated && target && canWrite(target) && !toolInput.isolation) {
          this.isolatedSpawns.set(input.tool_use_id, agentId)
          updates.isolation = 'worktree'
        }
        // Near the Opus weekly limit, new Opus reports run on Sonnet (project.preferSonnetNearLimit).
        if (this.steerToSonnet(target, toolInput)) {
          updates.model = 'sonnet'
          this.log('info', `Spawning ${target?.name ?? requested} on Sonnet instead of Opus: the weekly usage window is near its limit.`)
        }
        if (!Object.keys(updates).length) return {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { ...toolInput, ...updates }
          }
        }
      }

      // The first tool call from an isolated agent reveals its real worktree path.
      this.integrator.reportCwd(agentId, input.cwd)

      if (input.tool_name === MESSAGE_TOOL) this.onAgentMessage(agentId, toolInput)

      // Proposal tools block on the user, so the node shows "waiting" until they decide; plan tools return at once.
      const harness = input.tool_name.startsWith(ORGAI_TOOL_PREFIX)
      const state = harness && isBlockingHarnessTool(input.tool_name.slice(ORGAI_TOOL_PREFIX.length)) ? 'waiting' : 'tool'
      this.setState(agentId, state, describe(input.tool_name, toolInput))
      // A hook 'allow' bypasses the permission system (mode, classifier and canUseTool alike; verified in
      // scripts/smoke-permission-hook.mjs). The harness's own tools carry their approval inside their round-trip,
      // and rules granted while the run is live (request_permission_rules, the rules panel) apply without a restart.
      if (harness) return hookAllow('OrgAI harness tool')
      const rules = this.ctx.allowedRules?.()
      if (rules?.length) {
        const hit = matchingRule(input.tool_name, toolInput, rules)
        if (hit) return hookAllow(`OrgAI: allowed by saved rule ${hit}`)
      }
      return {}
    }

    const postToolUse: HookCallback = async (raw) => {
      const input = raw as PostToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      // Calls that never needed a permission prompt still leave an issuer queued; drop it now.
      this.takeIssuer(permissionKey(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>), agentId)
      const archPath = this.ctx.project.setup?.architecturePath
      if (!this.isSetup && archPath && (input.tool_name === 'Edit' || input.tool_name === 'Write')) {
        const filePath = ((input.tool_input ?? {}) as Record<string, unknown>).file_path
        if (isArchitectureFile(filePath, archPath)) {
          this.log('info', `${this.agents.get(agentId)?.name ?? agentId} updated ${archPath}`)
          void this.ctx.noteArchitectureUpdated().catch((e) => this.log('warn', `Could not record the architecture update: ${(e as Error).message}`))
        }
      }
      const a = this.agents.get(agentId)
      // Between tool calls the orchestrator's node shows the plan step it is on.
      const activity = (agentId === ROOT_ID && !this.isSetup ? stepActivity(this.ctx.getPlan()) : undefined) ?? 'Thinking…'
      if (a && a.state !== 'done' && a.state !== 'error') this.setState(agentId, 'thinking', activity)
      return {}
    }

    // Note: the toolUseID passed to SubagentStart is a hook invocation id, not the Agent
    // tool_use id. The parent link comes from the task_started system message, which
    // arrives first and carries task_id (= agent_id), tool_use_id and subagent_type.
    const subagentStart: HookCallback = async (raw) => {
      const input = raw as SubagentStartHookInput
      const role = this.rolesBySlug.get(input.agent_type)
      const existing = this.agents.get(input.agent_id)
      this.upsert({
        ...(existing ?? this.ensureAgent(input.agent_id, { roleSlug: input.agent_type, parentId: ROOT_ID })),
        roleId: role?.id ?? null,
        roleSlug: input.agent_type,
        name: role?.name ?? input.agent_type,
        state: 'thinking',
        activity: existing?.activity && existing.activity !== 'Starting…' ? existing.activity : 'Reading the brief…'
      })
      return {}
    }

    const subagentStop: HookCallback = async (raw) => {
      const input = raw as SubagentStopHookInput
      const a = this.ensureAgent(input.agent_id, { roleSlug: input.agent_type })
      a.result = input.last_assistant_message
      a.state = 'done'
      a.activity = 'Reported back'
      a.endedAt = Date.now()
      this.partial.clear(a.id, true)
      this.upsert(a)
      void this.integrator.onSubagentFinished(a.id)
      return {}
    }

    const stop: HookCallback = async () => {
      this.setState(ROOT_ID, 'idle', 'Waiting for you')
      return {}
    }

    return {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
      SubagentStart: [{ hooks: [subagentStart] }],
      SubagentStop: [{ hooks: [subagentStop] }],
      Stop: [{ hooks: [stop] }]
    }
  }

  /**
   * The SDK's total_cost_usd is cumulative for the query() and, on resume, may start from the
   * total the resumed transcript saved. Report only this run's spend. If the first result is below
   * the earlier run's cost, the SDK evidently did not carry the old total, so nothing is subtracted.
   */
  private runCost(sdkTotal: number): number {
    if (!this.ctx.resumeSessionId) return sdkTotal
    if (this.resumeCostBase === null) {
      const base = this.ctx.resumeBaseCostUsd ?? 0
      this.resumeCostBase = sdkTotal >= base ? base : 0
    }
    return Math.max(0, sdkTotal - this.resumeCostBase)
  }

  private noteSecrets(resolved: ResolvedMcpServer[]): void {
    for (const s of collectSecrets(resolved, this.ctx.connection)) this.secrets.add(s)
  }

  /** Every server of the session: the harness's own plus the resolved MCP servers. */
  private mcpRecord(resolved: ResolvedMcpServer[]): Record<string, McpServerConfig> {
    const record: Record<string, McpServerConfig> = toClaudeMcpServers(resolved)
    if (this.harnessServer) record[ORGAI_MCP] = this.harnessServer
    return record
  }

  /**
   * An install was approved mid-run: attach the server to the live session. setMcpServers replaces the
   * dynamic set, so the whole record is sent again. Resolves with the prefix the agent calls the tools by.
   */
  private async addMcpServer(spec: McpServerSpec): Promise<string> {
    const resolved = (await this.ctx.resolvedMcpServers?.()) ?? []
    this.noteSecrets(resolved)
    if (!resolved.some((r) => r.spec.name === spec.name)) throw new Error(`MCP server "${spec.name}" is not configured for this run.`)
    if (!this.q) throw new Error('The session is not running yet.')
    let result
    try {
      result = await this.q.setMcpServers(this.mcpRecord(resolved))
    } catch (e) {
      throw new Error(redactSecrets((e as Error).message ?? String(e), this.secrets))
    }
    const error = result.errors?.[spec.name]
    if (error) throw new Error(redactSecrets(error, this.secrets))
    return `mcp__${spec.name}__`
  }

  private async buildOptions(): Promise<Options> {
    const { project } = this.ctx
    const env = buildEnv(this.ctx)

    // The harness tools for this kind of run (setup / mcp-assist / work); the audience decides who sees which.
    const tools = harnessToolsFor(this.ctx, {
      integratePending: (wt) => this.integrator.integratePending(wt),
      onPlanUpdated: (plan) => {
        const root = this.agents.get(ROOT_ID)
        const activity = stepActivity(plan)
        if (root && activity && root.state !== 'done' && root.state !== 'error') this.setState(ROOT_ID, root.state, activity)
      },
      onDecided: () => {
        const a = this.agents.get(ROOT_ID)
        if (a && a.state === 'waiting') this.setState(ROOT_ID, 'thinking', 'Thinking…')
      },
      addMcpServer: (spec) => this.addMcpServer(spec)
    })
    this.harnessServer = buildHarnessServer(tools, this.harnessCallers, this.isSetup ? SETUP_TOOLS_INSTRUCTIONS : undefined)

    // MCP servers: the project's (plus run-scoped installs) with secrets filled in, only these load (strictMcpConfig).
    const resolved = (await this.ctx.resolvedMcpServers?.()) ?? []
    this.noteSecrets(resolved)

    const options: Options = {
      cwd: project.path,
      agents: buildAgents(this.ctx, tools, this.isolation, { mcpServers: this.ctx.mcpServers ? this.ctx.mcpServers() : project.mcpServers }),
      agent: this.root.slug,
      // Setup never edits files, so a plan-only project setting must not block the Architect's read tools.
      // An unattended ('auto') project keeps the classifier for the Architect's shell work too.
      permissionMode: this.isSetup ? (project.permissionMode === 'auto' ? 'auto' : 'acceptEdits') : project.permissionMode,
      allowDangerouslySkipPermissions: !this.isSetup && project.permissionMode === 'bypassPermissions',
      settingSources: ['project'],
      hooks: this.buildHooks(),
      // stream_event messages drive the live "agent.partial" text; transcripts still come from complete messages.
      includePartialMessages: true,
      // Subagent text and thinking are not forwarded by default; the nested transcripts need them.
      forwardSubagentText: true,
      abortController: this.abort,
      env,
      stderr: (data) => {
        const line = redactSecrets(data.trim(), this.secrets)
        if (line) this.log('warn', line)
      },
      canUseTool: async (toolName, input, permOptions) => {
        // The harness's own tools carry their approval inside the proposal round-trip.
        if (toolName.startsWith(ORGAI_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: input }
        const agentId = this.takeIssuer(permissionKey(toolName, input)) ?? this.lastToolAgent.get(toolName) ?? ROOT_ID
        this.setState(agentId, 'waiting', `Needs approval: ${describe(toolName, input)}`)
        // The SDK can forbid a "don't ask again" choice for asks whose rule would grant too much.
        const suggestions = chooseSuggestions(
          toolName,
          input,
          permOptions.suggestions?.length ? fromSdkSuggestions(permOptions.suggestions) : undefined,
          !!permOptions.suppressAlwaysAllowRule
        )
        const decision = await this.ctx.requestPermission({
          agentId,
          toolName,
          input,
          summary: describe(toolName, input),
          ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {})
        })
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describe(toolName, input))
        if (decision.behavior === 'allow') return this.allowWithScope(decision, suggestions, input)
        return { behavior: 'deny', message: decision.message }
      }
    }
    if (CLAUDE_EXECUTABLE) options.pathToClaudeCodeExecutable = CLAUDE_EXECUTABLE
    options.mcpServers = this.mcpRecord(resolved)
    options.strictMcpConfig = true
    const plugins = toClaudePlugins(this.ctx.plugins?.())
    if (plugins.length) options.plugins = plugins
    // "Always allow (project)" rules live in .claude/settings.local.json, which settingSources ['project'] does not load.
    const savedRules = listRules(project.path)
    if (savedRules.length) options.allowedTools = savedRules
    if (this.root.model && this.root.model !== 'inherit') options.model = this.root.model
    if (project.maxBudgetUsd && !this.isSetup) options.maxBudgetUsd = project.maxBudgetUsd
    if (this.ctx.resumeSessionId) options.resume = this.ctx.resumeSessionId
    return options
  }

  /** Allow result for a decision; session and project scopes add the suggested rules for the rest of the session. */
  private allowWithScope(
    decision: Extract<PermissionDecision, { behavior: 'allow' }>,
    suggestions: PermissionSuggestion[],
    input: Record<string, unknown>
  ): PermissionResult {
    const granted = applyAllowScope(this.ctx.project.path, decision, suggestions, (level, message) => this.log(level, message))
    if (!granted) return { behavior: 'allow', updatedInput: input }
    return {
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: toSdkSessionUpdates(granted),
      decisionClassification: 'user_permanent'
    }
  }

  private async run(): Promise<void> {
    const runId = this.ctx.run.id
    this.ensureAgent(ROOT_ID, {
      roleId: this.root.id,
      roleSlug: this.root.slug,
      name: this.root.name,
      parentId: null,
      state: 'thinking',
      activity: 'Reading your request…'
    })
    if (this.ctx.resumeSessionId) {
      this.transcript(ROOT_ID, { kind: 'system', text: `Continued from run ${this.ctx.run.resumedFrom ?? this.ctx.resumeSessionId}` })
    }
    this.transcript(ROOT_ID, userBlock(this.ctx.prompt, this.ctx.images))

    let firstMessage = composeFirstMessage(this.ctx.prompt, this.ctx.hiddenContext)

    try {
      if (this.isolation) {
        const leftover = await this.integrator.start()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      this.input.push({
        type: 'user',
        message: { role: 'user', content: userContent(firstMessage, this.ctx.images) },
        parent_tool_use_id: null
      })
      this.q = query({ prompt: this.input, options: await this.buildOptions() })
      for await (const msg of this.q) this.handle(msg)
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.emit({ type: 'run.status', runId, status: 'finished' })
      } else {
        const message = redactSecrets((e as Error).message ?? String(e), this.secrets)
        this.log('error', message)
        this.setState(ROOT_ID, 'error', message.slice(0, 80))
        this.emit({ type: 'run.status', runId, status: 'error', error: message })
      }
    } finally {
      this.ending = true
      this.continuation.dispose()
      this.stopUsagePolling()
      this.partial.clearAll()
      for (const a of this.agents.values()) {
        if (a.state !== 'done' && a.state !== 'error') {
          a.state = 'done'
          a.endedAt = Date.now()
          this.upsert(a)
        }
      }
    }
  }

  private handle(msg: SDKMessage): void {
    const runId = this.ctx.run.id
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const root = this.ensureAgent(ROOT_ID)
          root.model = msg.model
          this.upsert(root)
          this.emit({ type: 'run.status', runId, status: 'running', sessionId: msg.session_id })
          // The SDK re-emits init on every resumed turn (reports landing, harness messages); log it once.
          if (!this.sessionLogged) {
            this.sessionLogged = true
            this.log('info', `Session ${msg.session_id} started with Claude Code ${msg.claude_code_version} (${msg.model})`)
          }
          this.startUsagePolling()
        } else if (msg.subtype === 'task_started') {
          // Background shell commands and MCP calls are tasks too; only subagents belong on the chart.
          if (msg.task_type && msg.task_type !== 'local_agent') break
          // A SendMessage to a finished subagent resumes it with parent_task_id = the messenger (possibly its own
          // descendant); resolveParent keeps an existing agent's parent so the tree can never gain a cycle.
          const candidate = msg.parent_task_id ?? (msg.tool_use_id ? this.toolUseIssuer.get(msg.tool_use_id) : undefined)
          const parentId = resolveParent(this.agents, msg.task_id, candidate, ROOT_ID)
          if (msg.tool_use_id) this.taskByToolUse.set(msg.tool_use_id, msg.task_id)
          const slug = msg.subagent_type ?? 'general-purpose'
          const role = this.rolesBySlug.get(slug)
          const existing = this.agents.get(msg.task_id)
          if (msg.description) this.integrator.noteBrief(msg.task_id, msg.description)
          const handle = (msg.tool_use_id ? this.spawnHandles.get(msg.tool_use_id) : undefined) ?? existing?.handle
          // Claude Code creates the worktree itself at a known path; the first tool call confirms the real cwd.
          // A nested spawn's worktree lands inside its parent's worktree; integration re-locates it with git either way.
          const spawner = msg.tool_use_id ? this.isolatedSpawns.get(msg.tool_use_id) : undefined
          const parentWt = spawner && spawner !== ROOT_ID ? this.integrator.worktreeOf(spawner) : undefined
          const worktree: WorktreeInfo | undefined =
            this.integrator.worktreeOf(msg.task_id) ??
            (spawner
              ? this.integrator.track(msg.task_id, {
                  path: join(parentWt?.path ?? this.ctx.project.path, '.claude', 'worktrees', `agent-${msg.task_id}`),
                  branch: `worktree-agent-${msg.task_id}`,
                  status: 'active',
                  ...(parentWt
                    ? { mergeTarget: 'parent' as const, parentAgentId: spawner, parentBranch: parentWt.branch }
                    : { mergeTarget: 'main' as const })
                })
              : undefined)
          this.upsert({
            ...(existing ?? this.ensureAgent(msg.task_id, { roleSlug: slug, parentId })),
            roleId: role?.id ?? null,
            roleSlug: slug,
            name: role?.name ?? slug,
            parentId,
            spawnToolUseId: msg.tool_use_id ?? null,
            activity: msg.description?.slice(0, 90) || existing?.activity || 'Starting…',
            ...(worktree ? { worktree } : {}),
            ...(handle ? { handle } : {})
          })
        } else if (msg.subtype === 'task_notification') {
          const a = this.agents.get(msg.task_id)
          if (a) {
            a.state = msg.status === 'completed' ? 'done' : 'error'
            a.activity = msg.status === 'completed' ? 'Reported back' : `Task ${msg.status}`
            a.result = a.result ?? msg.summary
            a.endedAt = Date.now()
            this.upsert(a)
            void this.integrator.onSubagentFinished(a.id)
          }
        }
        break
      }
      case 'assistant': {
        const agentId = this.resolveAgentId(msg)
        const a = this.ensureAgent(agentId)
        const usage = msg.message.usage
        const messageId = msg.message.id || msg.uuid
        if (usage) {
          // Streaming emits one message per content block and the CLI may re-send a message after a
          // permission answer, all sharing message.id. Count each message id once, using its latest usage.
          const perAgent = this.usageByMessage.get(agentId) ?? new Map<string, { input: number; output: number; model?: string; mix: TokenMix }>()
          const mix: TokenMix = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0
          }
          perAgent.set(messageId, {
            input: mix.input + mix.cacheRead + mix.cacheCreation,
            output: mix.output,
            model: msg.message.model || perAgent.get(messageId)?.model || a.model,
            mix
          })
          this.usageByMessage.set(agentId, perAgent)
          let input = 0
          let output = 0
          for (const u of perAgent.values()) {
            input += u.input
            output += u.output
          }
          a.inputTokens = input
          a.outputTokens = output
          // Live estimate at the last known per-model rates; the next result message reconciles it.
          if (this.costRates) a.costUsd = costOf(perAgent.values(), this.costRates)
        }
        if (msg.message.model) a.model = msg.message.model
        // A background report can wake an idle orchestrator into a new turn.
        if (a.state === 'idle' || a.state === 'done') {
          a.state = 'thinking'
          a.activity = 'Thinking…'
          if (agentId === ROOT_ID) this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
        }
        for (const [index, block] of msg.message.content.entries()) {
          // A re-sent message repeats blocks already shown; skip anything seen under this message id.
          const blockKey = `${messageId}:${index}:${block.type}`
          if (this.seenBlocks.has(blockKey)) continue
          if (block.type === 'text' && block.text.trim()) {
            this.seenBlocks.add(blockKey)
            a.lastText = block.text.trim().slice(0, 200)
            this.transcript(agentId, { kind: 'text', text: block.text })
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.seenBlocks.add(blockKey)
            this.transcript(agentId, { kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            if (this.seenToolUses.has(block.id)) continue
            this.seenToolUses.add(block.id)
            this.seenBlocks.add(blockKey)
            this.toolUseIssuer.set(block.id, agentId)
            this.transcript(agentId, { kind: 'tool_use', id: block.id, name: block.name, input: block.input })
          }
        }
        if (msg.error) this.log('warn', `Assistant message error: ${JSON.stringify(msg.error)}`)
        if (msg.error === 'rate_limit' && !this.limited) {
          // No rejected rate_limit_event came first; fall back to the last known reset of the limiting window.
          const w = this.usage?.windows.fiveHour
          const until = this.usage?.limitedUntil ?? (w && w.utilization !== null && w.utilization >= 100 ? w.resetsAt ?? undefined : undefined)
          this.onRateLimited(until, this.usage?.limitedWindow)
        }
        // The completed text block replaces whatever was streamed for it.
        if (msg.message.content.some((b) => b.type === 'text')) this.partial.clear(agentId)
        this.upsert(a)
        break
      }
      case 'stream_event': {
        this.partial.onEvent(this.resolveAgentId(msg), msg.event)
        break
      }
      case 'user': {
        const agentId = this.resolveAgentId(msg)
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              if (this.ctx.resumeSessionId) {
                if (this.seenToolResults.has(block.tool_use_id)) continue
                this.seenToolResults.add(block.tool_use_id)
              }
              this.transcript(agentId, {
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                content: textOf(block.content).slice(0, 4000),
                isError: !!block.is_error
              })
            }
          }
        }
        break
      }
      case 'result': {
        const totalCostUsd = this.runCost(msg.total_cost_usd)
        this.emit({ type: 'run.cost', runId, totalCostUsd })
        this.apportionCost(msg.modelUsage)
        this.partial.clear(ROOT_ID, true)
        const root = this.ensureAgent(ROOT_ID)
        if (msg.subtype === 'success') {
          root.result = msg.result
          root.state = 'idle'
          const reportsRunning = [...this.agents.values()].some(
            (x) => x.id !== ROOT_ID && x.state !== 'done' && x.state !== 'error'
          )
          root.activity = reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
        } else {
          root.state = 'error'
          root.activity = msg.subtype.replace(/^error_/, '').replace(/_/g, ' ')
          this.log('error', `Run ended: ${msg.subtype}`)
        }
        this.upsert(root)
        this.emit({ type: 'run.status', runId, status: 'idle' })
        // Unattended execution: after a short delay (a report that just landed wakes the orchestrator
        // first), remind it of the plan's remaining steps. The driver re-checks every condition then.
        if (msg.subtype === 'success' && !this.isSetup) this.continuation.turnEnded()
        if (this.limited && !this.ending) {
          // Every further request would be rejected too. End the session; the run manager pauses the
          // run and continues it when the window resets.
          this.ending = true
          this.log('info', 'Ending the session at the usage limit; it continues when the window resets.')
          void this.stop()
        }
        break
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info as RateLimitInfoLike
        const next = mapRateLimitEvent(info, this.usage)
        if (this.authMode === 'apiKey') next.authMode = 'apiKey'
        else this.authMode = 'subscription'
        this.applyUsage(next)
        if (info.status === 'rejected') this.onRateLimited(next.limitedUntil, next.limitedWindow)
        break
      }
      default:
        break
    }
  }
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = 'claude' as const

  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    return new ClaudeSession(ctx)
  }

  /**
   * Plan usage without a run. A query whose input never yields still answers the usage control
   * request within a second of starting (verified in scripts/smoke-usage-probe.mjs), so this
   * spends nothing: no prompt is sent and the process is aborted right after the answer.
   */
  async probeUsage(auth: ProviderAuth): Promise<UsageStatus | null> {
    if (auth.kind === 'apiKey') return mapUsageResponse(null, 'apiKey')
    const abort = new AbortController()
    let release: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    const never: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>((r) => (release = r)) })
    }
    const finish = (): void => {
      abort.abort()
      release?.({ value: undefined as never, done: true })
    }
    try {
      const q = query({ prompt: never, options: { cwd: process.cwd(), model: 'haiku', settingSources: [], abortController: abort, tools: [], ...EXECUTABLE_OPTION } })
      // Drain the stream in the background so the process keeps running until we abort it.
      const drain = (async () => {
        try {
          for await (const _ of q as AsyncIterable<unknown>) void _
        } catch {
          /* aborted */
        }
      })()
      const fn = (q as unknown as Record<string, unknown>)[USAGE_METHOD]
      if (typeof fn !== 'function') {
        finish()
        await drain
        return null
      }
      const resp = (await Promise.race([
        (fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('usage probe timed out')), 10_000))
      ])) as UsageResponseLike
      finish()
      await drain
      return mapUsageResponse(resp, 'subscription')
    } catch {
      finish()
      return null
    }
  }

  async complete(input: CompletionInput): Promise<string> {
    const options: Options = {
      cwd: input.cwd,
      systemPrompt: { type: 'custom', prompt: input.system },
      tools: [],
      maxTurns: 1,
      settingSources: [],
      permissionMode: 'dontAsk',
      ...EXECUTABLE_OPTION
    }
    if (input.model) options.model = input.model
    let text = ''
    for await (const msg of query({ prompt: input.prompt, options })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) if (block.type === 'text') text += block.text
      } else if (msg.type === 'result' && msg.subtype !== 'success') {
        throw new Error(`Completion failed: ${msg.subtype}`)
      }
    }
    return text
  }
}

/** Copy SDK permission updates into the structured-clone-safe shared shape. */
function fromSdkSuggestions(updates: PermissionUpdate[]): PermissionSuggestion[] {
  return updates.map((u): PermissionSuggestion => {
    switch (u.type) {
      case 'addRules':
      case 'replaceRules':
      case 'removeRules':
        return {
          type: u.type,
          rules: u.rules.map((r) => (r.ruleContent ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName })),
          behavior: u.behavior,
          destination: u.destination
        }
      case 'addDirectories':
      case 'removeDirectories':
        return { type: u.type, directories: [...u.directories], destination: u.destination }
      case 'setMode':
        return { type: 'setMode', mode: u.mode, destination: u.destination }
    }
  })
}

/** Shared suggestions back to SDK updates, all scoped to this session (persistence is the harness's job). */
function toSdkSessionUpdates(suggestions: PermissionSuggestion[]): PermissionUpdate[] {
  return suggestions.map((s): PermissionUpdate => {
    if (s.type === 'setMode') return { type: 'setMode', mode: s.mode as SdkPermissionMode, destination: 'session' }
    if ('directories' in s) return { type: s.type, directories: [...s.directories], destination: 'session' }
    return { type: s.type, rules: s.rules.map((r) => ({ ...r })), behavior: s.behavior, destination: 'session' }
  })
}

type SdkPermissionMode = Extract<PermissionUpdate, { type: 'setMode' }>['mode']
