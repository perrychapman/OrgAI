import { join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
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
import type { AgentInstance, Role, RunEvent, TranscriptBlock, WorktreeInfo } from '@shared/types'
import type { PermissionDecision, PermissionSuggestion } from '@shared/types'
import { SPAWN_TOOL } from '@shared/types'
import { newId } from '@shared/defaults'
import { ROOT_AGENT_ID, type CompletionInput, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { applyAllowScope, chooseSuggestions, listRules, suggestionLabels } from './permissionRules'
import { isGitRepo } from './worktrees'
import { costOf, ratesFromModelUsage, type CostRates, type TokenMix } from './claudeCost'
import { PartialText } from './claudePartial'
import { SETUP_TOOLS_INSTRUCTIONS, setupTools, workTools, type HarnessTool } from './harnessTools'
import { buildRolePrompt, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { describeTool } from './activity'
import { WorktreeIntegrator } from './integration'

/**
 * The Claude adapter: maps Claude Agent SDK messages and hooks onto normalized RunEvents. Everything
 * that is not SDK mechanics lives in the shared runtime modules: harness tools (harnessTools.ts),
 * role prompts (prompts.ts), activity strings (activity.ts), worktree integration (integration.ts)
 * and permission scopes (permissionRules.ts).
 */

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

function buildAgents(ctx: RuntimeContext, rootExtraTools: string[], isolation: boolean): Record<string, AgentDefinition> {
  const isSetup = ctx.run.kind === 'setup'
  const agents: Record<string, AgentDefinition> = {}
  for (const role of ctx.roles) {
    const tools: string[] = [...role.tools, ...(role.reportsTo === null ? rootExtraTools : [])]
    if (role.canSpawn) tools.push(SPAWN_TOOL)
    const def: AgentDefinition = {
      description: role.description,
      prompt: buildRolePrompt(role, ctx.roles, ctx.project, { isSetup, isolation }),
      tools,
      model: role.model || 'inherit'
    }
    if (role.effort) def.effort = role.effort
    agents[role.slug] = def
  }
  return agents
}

/** The harness's tools as an in-process MCP server; the model sees them as mcp__orgai__<name>. */
function buildHarnessServer(tools: HarnessTool[], instructions?: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ORGAI_MCP,
    version: '1.0.0',
    ...(instructions ? { instructions } : {}),
    tools: tools.map((t) =>
      tool(t.name, t.description, t.inputSchema.shape, async (args) => ({ content: [{ type: 'text' as const, text: await t.call(args) }] }))
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

  constructor(private ctx: RuntimeContext) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = ctx.run.kind === 'setup'
    this.isolation = !this.isSetup && ctx.project.isolateWriters !== false && isGitRepo(ctx.project.path)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
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
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string): Promise<void> {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    })
    this.transcript(ROOT_ID, { kind: 'user', text })
    this.setState(ROOT_ID, 'thinking', 'Thinking…')
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt()
    } catch (e) {
      this.log('warn', `Interrupt failed: ${(e as Error).message}`)
    }
  }

  async stop(): Promise<void> {
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
  private notifyOrchestrator(text: string): void {
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.transcript(ROOT_ID, { kind: 'system', text })
    const root = this.agents.get(ROOT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_ID, 'thinking', 'Integrating a report…')
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

  private buildHooks(): Options['hooks'] {
    const preToolUse: HookCallback = async (raw) => {
      const input = raw as PreToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      this.lastToolAgent.set(input.tool_name, agentId)
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
        if (this.isolation && parentIsolated && target && canWrite(target) && !toolInput.isolation) {
          this.isolatedSpawns.set(input.tool_use_id, agentId)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...toolInput, isolation: 'worktree' }
            }
          }
        }
        return {}
      }

      // The first tool call from an isolated agent reveals its real worktree path.
      this.integrator.reportCwd(agentId, input.cwd)

      // Proposal tools block on the user, so the node shows "waiting" until they decide.
      const state = input.tool_name.startsWith(ORGAI_TOOL_PREFIX) ? 'waiting' : 'tool'
      this.setState(agentId, state, describe(input.tool_name, toolInput))
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
      if (a && a.state !== 'done' && a.state !== 'error') this.setState(agentId, 'thinking', 'Thinking…')
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

  private buildOptions(): Options {
    const { project } = this.ctx
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(project.maxSubagentDepth),
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(project.maxConcurrentSubagents),
      // Only org-chart roles may be spawned; drop the SDK's built-in general-purpose default.
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1'
    }
    if (project.provider.auth.kind === 'apiKey') {
      env.ANTHROPIC_API_KEY = process.env[project.provider.auth.envVar]
    }

    // Setup runs get the harness's proposal tools; work runs with isolation get the merge-retry tool.
    let harnessServer: McpSdkServerConfigWithInstance | undefined
    let extraTools: string[] = []
    if (this.isSetup) {
      const tools = setupTools(this.ctx, {
        onDecided: () => {
          const a = this.agents.get(ROOT_ID)
          if (a && a.state === 'waiting') this.setState(ROOT_ID, 'thinking', 'Thinking…')
        }
      })
      harnessServer = buildHarnessServer(tools, SETUP_TOOLS_INSTRUCTIONS)
      extraTools = tools.map((t) => `${ORGAI_TOOL_PREFIX}${t.name}`)
    } else if (this.isolation) {
      const tools = workTools(this.ctx, { integratePending: (wt) => this.integrator.integratePending(wt) })
      harnessServer = buildHarnessServer(tools)
      extraTools = tools.map((t) => `${ORGAI_TOOL_PREFIX}${t.name}`)
    }

    const options: Options = {
      cwd: project.path,
      agents: buildAgents(this.ctx, extraTools, this.isolation),
      agent: this.root.slug,
      // Setup never edits files, so a plan-only project setting must not block the Architect's read tools.
      permissionMode: this.isSetup ? 'acceptEdits' : project.permissionMode,
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
        const line = data.trim()
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
    if (harnessServer) options.mcpServers = { [ORGAI_MCP]: harnessServer }
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
    this.transcript(ROOT_ID, { kind: 'user', text: this.ctx.prompt })

    let firstMessage = composeFirstMessage(this.ctx.prompt, this.ctx.hiddenContext)

    try {
      if (this.isolation) {
        const leftover = await this.integrator.start()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      this.input.push({
        type: 'user',
        message: { role: 'user', content: firstMessage },
        parent_tool_use_id: null
      })
      this.q = query({ prompt: this.input, options: this.buildOptions() })
      for await (const msg of this.q) this.handle(msg)
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.emit({ type: 'run.status', runId, status: 'finished' })
      } else {
        const message = (e as Error).message ?? String(e)
        this.log('error', message)
        this.setState(ROOT_ID, 'error', message.slice(0, 80))
        this.emit({ type: 'run.status', runId, status: 'error', error: message })
      }
    } finally {
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
        } else if (msg.subtype === 'task_started') {
          // Background shell commands and MCP calls are tasks too; only subagents belong on the chart.
          if (msg.task_type && msg.task_type !== 'local_agent') break
          const parentId =
            msg.parent_task_id ??
            (msg.tool_use_id ? this.toolUseIssuer.get(msg.tool_use_id) : undefined) ??
            ROOT_ID
          if (msg.tool_use_id) this.taskByToolUse.set(msg.tool_use_id, msg.task_id)
          const slug = msg.subagent_type ?? 'general-purpose'
          const role = this.rolesBySlug.get(slug)
          const existing = this.agents.get(msg.task_id)
          if (msg.description) this.integrator.noteBrief(msg.task_id, msg.description)
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
            ...(worktree ? { worktree } : {})
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

  async complete(input: CompletionInput): Promise<string> {
    const options: Options = {
      cwd: input.cwd,
      systemPrompt: { type: 'custom', prompt: input.system },
      tools: [],
      maxTurns: 1,
      settingSources: [],
      permissionMode: 'dontAsk'
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
