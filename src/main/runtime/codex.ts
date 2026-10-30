import type { AgentInstance, AgentMessage, ImageAttachment, McpServerSpec, Role, RunEvent, TranscriptBlock, WorktreeInfo } from '@shared/types'
import { newId } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type CompletionInput, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { CodexAppServer, CodexRpcError, type CodexAppServerOptions } from './codexAppServer'
import {
  METHOD,
  SERVER_REQUEST,
  buildLaunchConfig,
  codexToolName,
  dynamicToolSpec,
  harnessToolName,
  matchesBashRule,
  mcpToolPrefix,
  parseCommandApproval,
  parseFileApproval,
  parsePermissionsApproval,
  parseThreadResult,
  parseToolCall,
  parseTurnId,
  parseUserInputQuestions,
  policyFor,
  toolResponse,
  untilFromRateLimits,
  userInput,
  type DynamicToolSpec,
  type LaunchConfig,
  type PolicyChoice
} from './codexProtocol'
import { CodexEventMapper, NETWORK_TOOLS, ThrottledPartial, fileChanges, type CodexUpdate } from './codexEvents'
import {
  CodexAgentNetwork,
  callNetworkTool,
  childFirstMessage,
  codexToolNotes,
  createAgentWorktree,
  networkToolNames,
  networkToolSpecs,
  reportMessage,
  type NetworkHost,
  type SpawnRequest
} from './codexAgents'
import { SETUP_TOOLS_INSTRUCTIONS, harnessToolsFor, isBlockingHarnessTool, type HarnessTool, type HarnessToolHooks } from './harnessTools'
import { ContinuationDriver, stepActivity } from './continuation'
import { buildRolePrompt, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { describeTool } from './activity'
import { WorktreeIntegrator } from './integration'
import { allowRuleStrings, applyAllowScope, chooseSuggestions, listRules, suggestionLabels } from './permissionRules'
import { isGitRepo } from './worktrees'

/**
 * The Codex adapter: drives `codex app-server` (JSON-RPC over stdio, codexAppServer.ts) and maps its threads,
 * turns and items onto the same RunEvents the Claude adapter produces. Event mapping lives in codexEvents.ts,
 * protocol shapes in codexProtocol.ts, harness-side subagents in codexAgents.ts. Shared behaviour (harness
 * tools, role prompts, activity strings, worktree integration, continuation, permission rules) comes from the
 * provider-neutral modules, never from here.
 *
 * Shape of a run
 *   one app-server process per run, env = connection.env (CODEX_HOME = OrgAI's own Codex home) over process.env
 *   root thread    thread/start { developerInstructions = role prompt, dynamicTools, cwd, approvalPolicy, sandbox }
 *   subagents      Codex has no spawn the harness can govern, so the dynamic tool spawn_agent starts another thread
 *                  per report (own prompt, model, worktree); its final message goes to the parent as a harness message
 *   approvals      item/*\/requestApproval server requests -> ctx.requestPermission (or saved rules / the mode's policy)
 *   harness tools  dynamicTools on thread/start, answered through the item/tool/call server request
 * Nothing here spends tokens until a turn starts; see scripts/smoke-codex.mjs for what a real turn verifies.
 */

/** The slice of CodexAppServer the adapter uses; tests inject a fake. */
export interface CodexServerLike {
  start(clientVersion?: string): Promise<unknown>
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): () => void
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void
  onExit(handler: (code: number | null, error?: Error) => void): () => void
  close(): void
  readonly exited: Promise<void>
}

export interface CodexAdapterOptions {
  /** Create the app-server client (tests inject a fake). Default: a real CodexAppServer. */
  createServer?: (options: CodexAppServerOptions) => CodexServerLike
  /** Version string sent in `initialize`. */
  clientVersion?: string
  /**
   * How complete() reaches the models. complete() has no RuntimeContext, so the lead wires this to the
   * connection service (same RunConnection RunManager builds: CODEX_HOME env, API key). Missing = the process
   * environment, which means the user's own CODEX_HOME: wire it in production.
   */
  completionConnection?: () => RunConnection | undefined | Promise<RunConnection | undefined>
  /** Turn-request timeout for complete(), ms. Default 180 s. */
  completionTimeoutMs?: number
}

const ORGAI_SERVICE = 'orgai'
const CLAUDE_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku'])
/** How long a restart waits for the old process to exit. */
const EXIT_WAIT_MS = 3000

/** A model id for Codex from a role's model: undefined for 'inherit' and for bare Claude aliases. */
export function codexModelFor(model: string | undefined): string | undefined {
  const m = model?.trim()
  if (!m || m === 'inherit' || CLAUDE_ALIASES.has(m.toLowerCase())) return undefined
  return m
}

function userBlock(text: string, images?: ImageAttachment[]): TranscriptBlock {
  return images?.length ? { kind: 'user', text, images } : { kind: 'user', text }
}

function describePermission(toolName: string, input: unknown): string {
  return describeTool(toolName, input)
}

interface ThreadInfo {
  agentId: string
  policy: PolicyChoice
}

class CodexSession implements RuntimeSession {
  readonly finished: Promise<void>
  private server!: CodexServerLike
  private unsubscribers: (() => void)[] = []
  private agents = new Map<string, AgentInstance>()
  private threads = new Map<string, ThreadInfo>()
  private agentThread = new Map<string, string>()
  /** threadId -> id of the turn running now. */
  private activeTurn = new Map<string, string>()
  private completedTurns = new Set<string>()
  /** Per-thread FIFO of turn/start and turn/steer requests, so a message never races a turn boundary. */
  private queues = new Map<string, Promise<unknown>>()
  private mapper: CodexEventMapper
  private partial: ThrottledPartial
  private net: CodexAgentNetwork
  private integrator: WorktreeIntegrator
  private continuation: ContinuationDriver
  private root: Role
  private setupLike: boolean
  private isolation: boolean
  private harness: HarnessTool[] = []
  private harnessByCodexName = new Map<string, HarnessTool>()
  private rootThreadId = ''
  /** Messages the user sent before the root thread existed. */
  private earlySends: { text: string; images?: ImageAttachment[] }[] = []
  /** Rules granted with "allow for this run". */
  private sessionRules: string[] = []
  private limited = false
  private ending = false
  private ended = false
  private launch: LaunchConfig = { config: [], env: {}, summary: [], skipped: [] }
  private mcpRestartPending = false
  private restarting = false
  private pendingMcpPrefixes: string[] = []
  private closeSignal!: () => void
  private readonly closed: Promise<void>

  constructor(
    private ctx: RuntimeContext,
    private options: CodexAdapterOptions
  ) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.setupLike = isSetupLikeRun(ctx.run.kind)
    this.isolation = !this.setupLike && ctx.project.isolateWriters !== false && isGitRepo(ctx.project.path)
    this.net = new CodexAgentNetwork({ roles: ctx.roles, root, maxDepth: ctx.project.maxSubagentDepth, maxConcurrent: ctx.project.maxConcurrentSubagents })
    this.closed = new Promise((resolve) => (this.closeSignal = resolve))
    this.partial = new ThrottledPartial((agentId, text) => this.emit({ type: 'agent.partial', runId: ctx.run.id, agentId, text }))

    const hooks: HarnessToolHooks = {
      onDecided: () => {
        const a = this.agents.get(ROOT_AGENT_ID)
        if (a && a.state === 'waiting') this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
      },
      integratePending: (wt) => this.integrator.integratePending(wt),
      onPlanUpdated: (plan) => {
        const rootAgent = this.agents.get(ROOT_AGENT_ID)
        const activity = stepActivity(plan)
        if (rootAgent && activity && rootAgent.state !== 'done' && rootAgent.state !== 'error') this.setState(ROOT_AGENT_ID, rootAgent.state, activity)
      },
      addMcpServer: (spec) => this.addMcpServer(spec)
    }
    this.harness = harnessToolsFor(ctx, hooks)
    for (const t of this.harness) this.harnessByCodexName.set(codexToolName(t.name), t)
    this.mapper = new CodexEventMapper({
      harnessToolNames: this.harnessByCodexName.keys(),
      isBlockingTool: (codexName) => isBlockingHarnessTool(harnessToolName(codexName))
    })

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
      liveReports: () => [...this.agents.values()].filter((a) => a.id !== ROOT_AGENT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => this.limited,
      stopping: () => this.ending || this.restarting,
      orchestratorBusy: () => {
        const r = this.agents.get(ROOT_AGENT_ID)
        return !!r && r.state !== 'idle' && r.state !== 'done'
      },
      nudge: (text, activity) => {
        this.notifyOrchestrator(text, activity)
        this.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      },
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_AGENT_ID, { kind: 'system', text })
    })
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.transcript(ROOT_AGENT_ID, userBlock(text, images))
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    if (this.rootThreadId) await this.sendToThread(this.rootThreadId, text, images)
    else this.earlySends.push({ text, images })
  }

  async interrupt(): Promise<void> {
    // An interrupted turn waits for the user; no automatic continue until they reply.
    this.continuation.hold()
    await this.interruptAll()
  }

  async stop(): Promise<void> {
    if (this.ending) return
    this.ending = true
    this.continuation.dispose()
    await this.interruptAll()
    this.server?.close()
    this.closeSignal()
  }

  // ---------- plumbing ----------

  private emit(e: RunEvent): void {
    this.ctx.emit(e)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private transcript(agentId: string, block: TranscriptBlock): void {
    this.emit({ type: 'transcript', runId: this.ctx.run.id, entry: { id: newId('t'), agentId, at: Date.now(), block } })
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent } })
  }

  private setState(id: string, state: AgentInstance['state'], activity?: string): void {
    const a = this.agents.get(id)
    if (!a) return
    a.state = state
    if (activity !== undefined) a.activity = activity
    if (state === 'done' || state === 'error') a.endedAt = Date.now()
    this.upsert(a)
  }

  private newAgent(id: string, role: Role | undefined, over: Partial<AgentInstance> = {}): AgentInstance {
    const a: AgentInstance = {
      id,
      roleId: role?.id ?? null,
      roleSlug: role?.slug ?? 'agent',
      name: role?.name ?? 'agent',
      parentId: id === ROOT_AGENT_ID ? null : ROOT_AGENT_ID,
      spawnToolUseId: null,
      state: 'starting',
      activity: 'Starting…',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: Date.now(),
      ...over
    }
    this.upsert(a)
    return a
  }

  private agentOf(threadId: string): string {
    return this.threads.get(threadId)?.agentId ?? ROOT_AGENT_ID
  }

  private serialized<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(threadId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.queues.set(threadId, tail)
    void tail.then(() => {
      if (this.queues.get(threadId) === tail) this.queues.delete(threadId)
    })
    return next
  }

  /** Steer the running turn of a thread, or start a new one. */
  private sendToThread(threadId: string, text: string, images?: ImageAttachment[], extra: Record<string, unknown> = {}): Promise<void> {
    return this.serialized(threadId, async () => {
      const input = userInput(text, images)
      const turnId = this.activeTurn.get(threadId)
      if (turnId) {
        try {
          await this.server.request(METHOD.turnSteer, { threadId, input, expectedTurnId: turnId })
          return
        } catch (e) {
          this.log('info', `Could not steer the running turn (${(e as Error).message}); starting a new one.`)
        }
      }
      const res = await this.server.request(METHOD.turnStart, { threadId, input, ...extra })
      const id = parseTurnId(res)
      if (id && !this.completedTurns.has(id)) this.activeTurn.set(threadId, id)
    })
  }

  /** Queue a harness message for the orchestrator; it starts a new turn if the orchestrator is idle. */
  private notifyOrchestrator(text: string, activity = 'Integrating a report…'): void {
    this.transcript(ROOT_AGENT_ID, { kind: 'system', text })
    const rootAgent = this.agents.get(ROOT_AGENT_ID)
    if (rootAgent && (rootAgent.state === 'idle' || rootAgent.state === 'done')) {
      this.setState(ROOT_AGENT_ID, 'thinking', activity)
      this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
    }
    if (!this.rootThreadId) return
    void this.sendToThread(this.rootThreadId, text).catch((e) => this.log('warn', `Could not deliver a harness message to the orchestrator: ${(e as Error).message}`))
  }

  private async interruptAll(): Promise<void> {
    if (!this.server) return
    const pending = [...this.activeTurn].map(([threadId, turnId]) =>
      Promise.race([this.server.request(METHOD.turnInterrupt, { threadId, turnId }).catch((e: Error) => this.log('warn', `Interrupt failed: ${e.message}`)), new Promise((r) => setTimeout(r, 2000))])
    )
    await Promise.all(pending)
  }

  // ---------- start ----------

  private policyFor(role: Role): PolicyChoice {
    return policyFor(this.ctx.project.permissionMode, { writes: canWrite(role), setupLike: this.setupLike })
  }

  private toolsFor(role: Role, isRoot: boolean): { specs: DynamicToolSpec[]; names: string[] } {
    const harness = this.harness.filter((t) => isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners'))
    const network = networkToolNames(role, { setupLike: this.setupLike })
    return {
      specs: [...harness.map(dynamicToolSpec), ...networkToolSpecs(network)],
      names: [...harness.map((t) => codexToolName(t.name)), ...network]
    }
  }

  private instructionsFor(role: Role, isRoot: boolean): string {
    const isSetup = this.setupLike
    const base = buildRolePrompt(role, this.ctx.roles, this.ctx.project, { isSetup, isolation: this.isolation })
    const { names } = this.toolsFor(role, isRoot)
    const notes = codexToolNotes(names, { renamedPlanTool: names.includes('orgai_update_plan') })
    const parts = [base]
    if (isSetup && isRoot && this.ctx.run.kind === 'setup') parts.push(SETUP_TOOLS_INSTRUCTIONS)
    if (notes) parts.push(notes)
    return parts.join('\n\n')
  }

  private threadParams(role: Role, isRoot: boolean, cwd: string, parentModel?: string): Record<string, unknown> {
    const policy = this.policyFor(role)
    const model = codexModelFor(role.model) ?? parentModel
    return {
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
      developerInstructions: this.instructionsFor(role, isRoot),
      dynamicTools: this.toolsFor(role, isRoot).specs,
      serviceName: ORGAI_SERVICE
    }
  }

  /** thread/start; when the server rejects the unstable approvalsReviewer field, retry without it. */
  private async startThread(params: Record<string, unknown>, method: string = METHOD.threadStart): Promise<{ threadId: string; model?: string }> {
    let res: unknown
    try {
      res = await this.server.request(method, params)
    } catch (e) {
      if (!(e instanceof CodexRpcError) || !('approvalsReviewer' in params)) throw e
      this.log('warn', `Codex rejected approvalsReviewer (${e.message}); continuing without the auto reviewer.`)
      const { approvalsReviewer: _dropped, ...rest } = params
      void _dropped
      res = await this.server.request(method, rest)
    }
    const parsed = parseThreadResult(res)
    if (!parsed) throw new Error(`${method} returned no thread id`)
    return parsed
  }

  private bindThread(threadId: string, agentId: string, policy: PolicyChoice): void {
    this.threads.set(threadId, { agentId, policy })
    this.agentThread.set(agentId, threadId)
  }

  private createServer(launch: LaunchConfig): CodexServerLike {
    const options: CodexAppServerOptions = {
      cwd: this.ctx.project.path,
      env: launch.env,
      config: launch.config,
      onStderr: (line) => {
        // The CLI's tracing output is chatty; only surface real problems.
        if (/\b(error|fatal|panic)\b/i.test(line)) this.log('warn', `codex: ${line.slice(0, 300)}`)
      }
    }
    return this.options.createServer ? this.options.createServer(options) : new CodexAppServer(options)
  }

  private wire(server: CodexServerLike): void {
    this.unsubscribers.push(server.onNotification((method, params) => this.onNotification(method, params)))
    server.onServerRequest((method, params) => this.onServerRequest(method, params))
    this.unsubscribers.push(
      server.onExit((code, error) => {
        if (this.restarting || this.ending) return
        const message = error?.message ?? `codex app-server exited (code ${code ?? 'unknown'})`
        this.fail(message)
      })
    )
  }

  private unwire(): void {
    for (const u of this.unsubscribers.splice(0)) u()
  }

  /** The run ended because the process died or startup failed. */
  private fail(message: string): void {
    if (this.ended) return
    this.log('error', message)
    this.setState(ROOT_AGENT_ID, 'error', message.slice(0, 80))
    this.endRun(message)
  }

  private endRun(error?: string): void {
    if (this.ended) return
    this.ended = true
    this.ending = true
    this.continuation.dispose()
    this.partial.clearAll()
    for (const a of this.agents.values()) {
      if (a.state !== 'done' && a.state !== 'error') {
        a.state = 'done'
        a.endedAt = Date.now()
        this.upsert(a)
      }
    }
    this.emit(error ? { type: 'run.status', runId: this.ctx.run.id, status: 'error', error } : { type: 'run.status', runId: this.ctx.run.id, status: 'finished' })
    this.server?.close()
    this.closeSignal()
  }

  private async run(): Promise<void> {
    const { ctx } = this
    const runId = ctx.run.id
    this.newAgent(ROOT_AGENT_ID, this.root, { state: 'thinking', activity: 'Reading your request…', parentId: null })
    if (ctx.resumeSessionId) this.transcript(ROOT_AGENT_ID, { kind: 'system', text: `Continued from run ${ctx.run.resumedFrom ?? ctx.resumeSessionId}` })
    this.transcript(ROOT_AGENT_ID, userBlock(ctx.prompt, ctx.images))

    try {
      let firstMessage = composeFirstMessage(ctx.prompt, ctx.hiddenContext)
      if (this.isolation) {
        const leftover = await this.integrator.start()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      const servers = ctx.resolvedMcpServers ? await ctx.resolvedMcpServers() : []
      this.launch = buildLaunchConfig(ctx.connection, servers)
      for (const s of this.launch.skipped) this.log('warn', `MCP server ${s.name} was skipped: ${s.reason}`)
      for (const line of this.launch.summary) this.log('info', `Codex: ${line}`)
      this.server = this.createServer(this.launch)
      this.wire(this.server)
      await this.server.start(this.options.clientVersion)

      const policy = this.policyFor(this.root)
      const params = this.threadParams(this.root, true, ctx.project.path)
      let started: { threadId: string; model?: string } | undefined
      if (ctx.resumeSessionId) {
        try {
          const { dynamicTools: _tools, serviceName: _service, ...resumeParams } = params
          void _tools
          void _service
          started = await this.startThread({ threadId: ctx.resumeSessionId, ...resumeParams }, METHOD.threadResume)
        } catch (e) {
          this.log('warn', `Could not resume Codex thread ${ctx.resumeSessionId} (${(e as Error).message}); starting a new thread.`)
          this.transcript(ROOT_AGENT_ID, { kind: 'system', text: 'The earlier Codex conversation could not be resumed; this run starts a new one.' })
        }
      }
      if (!started) started = await this.startThread(params)
      this.rootThreadId = started.threadId
      this.bindThread(started.threadId, ROOT_AGENT_ID, policy)
      const rootAgent = this.agents.get(ROOT_AGENT_ID)!
      if (started.model) rootAgent.model = started.model
      this.upsert(rootAgent)
      this.emit({ type: 'run.status', runId, status: 'running', sessionId: started.threadId })
      this.log('info', `Codex thread ${started.threadId} started${started.model ? ` (${started.model})` : ''}`)

      const effort = this.root.effort && ['low', 'medium', 'high'].includes(this.root.effort) ? { effort: this.root.effort } : {}
      await this.sendToThread(started.threadId, firstMessage, ctx.images, effort)
      for (const m of this.earlySends.splice(0)) await this.sendToThread(started.threadId, m.text, m.images)
      await this.closed
    } catch (e) {
      if (!this.ending) this.fail((e as Error).message ?? String(e))
    } finally {
      this.endRun()
      this.unwire()
    }
  }

  // ---------- notifications ----------

  private onNotification(method: string, params: unknown): void {
    for (const u of this.mapper.handle(method, params)) this.apply(u)
  }

  private apply(u: CodexUpdate): void {
    if (u.type === 'log') return this.log(u.level, u.message)
    const agentId = this.agentOf(u.threadId)
    const agent = this.agents.get(agentId)
    switch (u.type) {
      case 'text':
        if (agent) {
          agent.lastText = u.text.slice(0, 200)
          this.upsert(agent)
        }
        this.transcript(agentId, { kind: 'text', text: u.text })
        return
      case 'partial':
        this.partial.set(agentId, u.text)
        return
      case 'thinking':
        this.transcript(agentId, { kind: 'thinking', text: u.text })
        return
      case 'toolUse':
        this.transcript(agentId, { kind: 'tool_use', id: u.id, name: u.name, input: u.input })
        this.setState(agentId, u.state, u.activity)
        return
      case 'toolResult': {
        this.transcript(agentId, { kind: 'tool_result', toolUseId: u.toolUseId, content: u.content, isError: u.isError })
        this.noteArchitectureEdit(agentId, u.toolUseId)
        if (agent && agent.state !== 'done' && agent.state !== 'error') {
          const activity = (agentId === ROOT_AGENT_ID && !this.setupLike ? stepActivity(this.ctx.getPlan()) : undefined) ?? 'Thinking…'
          this.setState(agentId, 'thinking', activity)
        }
        return
      }
      case 'tokens':
        if (agent) {
          agent.inputTokens = u.input
          agent.outputTokens = u.output
          this.upsert(agent)
        }
        return
      case 'turnStarted':
        if (u.turnId) this.activeTurn.set(u.threadId, u.turnId)
        if (agent && (agent.state === 'idle' || agent.state === 'done')) {
          this.setState(agentId, 'thinking', 'Thinking…')
          if (agentId === ROOT_AGENT_ID) this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
        }
        return
      case 'turnCompleted':
        if (u.turnId) this.completedTurns.add(u.turnId)
        if (this.activeTurn.get(u.threadId) === u.turnId || !u.turnId) this.activeTurn.delete(u.threadId)
        this.partial.clear(agentId)
        if (agentId === ROOT_AGENT_ID) this.rootTurnCompleted(u)
        else this.childTurnCompleted(agentId, u)
        void this.maybeRestartForMcp()
        return
      case 'error':
        this.log(u.willRetry ? 'info' : 'warn', `Codex: ${u.message}${u.willRetry ? ' (retrying)' : ''}`)
        if (u.usageLimit && !u.willRetry) void this.onUsageLimit()
        return
    }
  }

  private noteArchitectureEdit(agentId: string, itemId: string): void {
    const archPath = this.ctx.project.setup?.architecturePath
    const item = this.mapper.item(itemId)
    if (this.setupLike || !archPath || !item || item.type !== 'fileChange' || item.status !== 'completed') return
    if (!fileChanges(item).some((c) => isArchitectureFile(c.path, archPath))) return
    this.log('info', `${this.agents.get(agentId)?.name ?? agentId} updated ${archPath}`)
    void this.ctx.noteArchitectureUpdated().catch((e) => this.log('warn', `Could not record the architecture update: ${(e as Error).message}`))
  }

  private rootTurnCompleted(u: Extract<CodexUpdate, { type: 'turnCompleted' }>): void {
    const root = this.agents.get(ROOT_AGENT_ID)
    if (!root) return
    if (u.status === 'failed' && this.limited) {
      root.state = 'idle'
      root.activity = 'Usage limit reached'
    } else if (u.status === 'failed') {
      root.state = 'error'
      root.activity = (u.error?.message ?? 'Turn failed').slice(0, 80)
      this.log('error', `Run turn failed: ${u.error?.message ?? 'unknown error'}`)
    } else {
      if (u.result) root.result = u.result
      root.state = 'idle'
      const reportsRunning = [...this.agents.values()].some((x) => x.id !== ROOT_AGENT_ID && x.state !== 'done' && x.state !== 'error')
      root.activity = u.status === 'interrupted' ? 'Interrupted' : reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
    }
    this.upsert(root)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
    if (u.status === 'completed' && !this.setupLike) this.continuation.turnEnded()
    if (this.limited && !this.ending) {
      this.log('info', 'Ending the session at the usage limit; it continues when the window resets.')
      void this.stop()
    }
  }

  private childTurnCompleted(agentId: string, u: Extract<CodexUpdate, { type: 'turnCompleted' }>): void {
    const child = this.agents.get(agentId)
    if (!child) return
    this.net.finish(agentId)
    if (u.result) child.result = u.result
    if (u.status === 'interrupted') {
      child.state = 'done'
      child.activity = 'Interrupted'
    } else if (u.status === 'failed') {
      child.state = 'error'
      child.activity = (u.error?.message ?? 'Failed').slice(0, 80)
    } else {
      child.state = 'done'
      child.activity = 'Reported back'
    }
    child.endedAt = Date.now()
    this.upsert(child)
    if (u.status === 'completed') void this.integrator.onSubagentFinished(agentId)
    if (u.status === 'interrupted') return
    const text = reportMessage(child, u.status === 'failed' ? { status: 'failed', result: u.result, error: u.error?.message } : { status: 'completed', result: u.result })
    this.deliverTo(child.parentId ?? ROOT_AGENT_ID, text)
  }

  /** Hand a harness message to an agent (the orchestrator gets the full notifyOrchestrator treatment). */
  private deliverTo(agentId: string, text: string): Promise<void> {
    if (agentId === ROOT_AGENT_ID) {
      this.notifyOrchestrator(text)
      return Promise.resolve()
    }
    const threadId = this.agentThread.get(agentId)
    const target = this.agents.get(agentId)
    if (!threadId || !target) return Promise.reject(new Error(`${agentId} has no thread`))
    this.transcript(agentId, { kind: 'system', text })
    if (target.state === 'done' || target.state === 'idle') {
      target.endedAt = undefined
      this.setState(agentId, 'thinking', 'Reading a message…')
    }
    return this.sendToThread(threadId, text)
  }

  private async onUsageLimit(): Promise<void> {
    if (this.limited) return
    this.limited = true
    let until: number | undefined
    try {
      const res = await Promise.race([this.server.request(METHOD.rateLimitsRead), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])
      until = untilFromRateLimits(res)
    } catch {
      // unknown reset time
    }
    this.log('warn', `Codex usage limit reached${until ? `; resets ${new Date(until).toLocaleString()}` : ''}. The run pauses and continues then.`)
    this.ctx.rateLimited({ ...(until ? { until } : {}), window: 'codex' })
  }

  // ---------- server requests ----------

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case SERVER_REQUEST.toolCall:
        return this.onToolCall(params)
      case SERVER_REQUEST.commandApproval:
        return this.onCommandApproval(params)
      case SERVER_REQUEST.fileApproval:
        return this.onFileApproval(params)
      case SERVER_REQUEST.permissionsApproval:
        return this.onPermissionsApproval(params)
      case SERVER_REQUEST.userInput:
        return this.onUserInput(params)
      case SERVER_REQUEST.mcpElicitation:
        return { action: 'decline', content: null, _meta: null }
      case SERVER_REQUEST.legacyApplyPatch:
      case SERVER_REQUEST.legacyExec:
        return { decision: 'denied' }
      default:
        throw new Error(`OrgAI does not handle ${method}`)
    }
  }

  private async onToolCall(params: unknown): Promise<unknown> {
    const call = parseToolCall(params)
    if (!call) return toolResponse('Malformed tool call.', false)
    const agentId = this.agentOf(call.threadId)
    const role = this.net.roleOf(agentId) ?? this.root
    const isNetwork = (Object.values(NETWORK_TOOLS) as string[]).includes(call.tool)
    if (isNetwork) {
      if (!networkToolNames(role, { setupLike: this.setupLike }).includes(call.tool)) return toolResponse(`${role.slug} may not use ${call.tool}.`, false)
      const out = await callNetworkTool(this.net, this.networkHost, agentId, call.callId, call.tool, call.arguments)
      return toolResponse(out.text, out.success)
    }
    const tool = this.harnessByCodexName.get(call.tool)
    if (!tool || !(agentId === ROOT_AGENT_ID || tool.audience === 'all' || (role.canSpawn && tool.audience === 'spawners'))) return toolResponse(`Unknown tool ${call.tool}.`, false)
    if (isBlockingHarnessTool(tool.name)) this.setState(agentId, 'waiting', describeTool(tool.name, call.arguments, { harness: true }))
    try {
      const text = await tool.call(call.arguments, { agentId })
      return toolResponse(text, true)
    } catch (e) {
      return toolResponse(`${tool.name} failed: ${(e as Error).message}`, false)
    } finally {
      const a = this.agents.get(agentId)
      if (a && a.state === 'waiting') this.setState(agentId, 'thinking', 'Thinking…')
    }
  }

  private async ask(agentId: string, toolName: 'Bash' | 'Edit', input: Record<string, unknown>) {
    const summary = describePermission(toolName, input)
    this.setState(agentId, 'waiting', `Needs approval: ${summary}`)
    const suggestions = chooseSuggestions(toolName, input, undefined)
    try {
      const decision = await this.ctx.requestPermission({
        agentId,
        toolName,
        input,
        summary,
        ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {})
      })
      let granted = false
      if (decision.behavior === 'allow') {
        const scoped = applyAllowScope(this.ctx.project.path, decision, suggestions, (level, message) => this.log(level, message))
        if (scoped) {
          granted = true
          this.sessionRules.push(...allowRuleStrings(scoped))
        }
      }
      return { decision, granted }
    } finally {
      const a = this.agents.get(agentId)
      if (a && a.state === 'waiting') this.setState(agentId, 'tool', summary)
    }
  }

  private async onCommandApproval(params: unknown): Promise<unknown> {
    const req = parseCommandApproval(params)
    if (!req) return { decision: 'decline' }
    const agentId = this.agentOf(req.threadId)
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) {
      this.log('info', `Declined a command in ${this.ctx.project.permissionMode} mode: ${req.command.slice(0, 120)}`)
      return { decision: 'decline' }
    }
    // Saved rules plus anything granted while the run is live (request_permission_rules, the rules panel).
    const rules = [...(this.ctx.allowedRules?.() ?? listRules(this.ctx.project.path)), ...this.sessionRules]
    if (req.command && matchesBashRule(req.command, rules)) return { decision: 'accept' }
    const input = { command: req.command, ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.reason ? { reason: req.reason } : {}) }
    const { decision, granted } = await this.ask(agentId, 'Bash', input)
    if (decision.behavior === 'deny') return { decision: 'decline' }
    return { decision: granted ? 'acceptForSession' : 'accept' }
  }

  private async onFileApproval(params: unknown): Promise<unknown> {
    const req = parseFileApproval(params)
    if (!req) return { decision: 'decline' }
    const agentId = this.agentOf(req.threadId)
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) return { decision: 'decline' }
    if (policy?.autoAcceptEdits) return { decision: 'accept' }
    if (listRules(this.ctx.project.path).some((r) => r === 'Edit' || r === 'Write')) return { decision: 'accept' }
    const item = this.mapper.item(req.itemId)
    const changes = item ? fileChanges(item) : []
    const input: Record<string, unknown> = {
      file_path: changes[0]?.path ?? req.grantRoot ?? '',
      ...(changes.length ? { changes } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.grantRoot ? { grantRoot: req.grantRoot } : {})
    }
    const { decision, granted } = await this.ask(agentId, 'Edit', input)
    if (decision.behavior === 'deny') return { decision: 'decline' }
    return { decision: granted ? 'acceptForSession' : 'accept' }
  }

  private async onPermissionsApproval(params: unknown): Promise<unknown> {
    const req = parsePermissionsApproval(params)
    if (!req) return { permissions: {}, scope: 'turn' }
    const agentId = this.agentOf(req.threadId)
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) return { permissions: {}, scope: 'turn' }
    const input = { command: `Extra permissions: ${req.reason ?? JSON.stringify(req.requested)}`, permissions: req.requested }
    const { decision } = await this.ask(agentId, 'Bash', input)
    if (decision.behavior === 'deny') return { permissions: {}, scope: 'turn' }
    return { permissions: req.requested, scope: 'turn' }
  }

  private async onUserInput(params: unknown): Promise<unknown> {
    const req = parseUserInputQuestions(params)
    const answers: Record<string, { answers: string[] }> = {}
    if (!req) return { answers }
    const agentId = this.agentOf(req.threadId)
    for (const q of req.questions) {
      this.setState(agentId, 'waiting', 'Asking you a question…')
      const answer = await this.ctx.requestQuestion({
        agentId,
        question: q.header ? `${q.header}: ${q.question}` : q.question,
        options: q.options.length >= 2 ? q.options : [{ label: 'Yes' }, { label: 'No' }],
        allowMultiple: false,
        allowFreeText: q.isOther || q.options.length < 2
      })
      answers[q.id] = { answers: [...answer.selected, ...(answer.text?.trim() ? [answer.text.trim()] : [])] }
    }
    const a = this.agents.get(agentId)
    if (a && a.state === 'waiting') this.setState(agentId, 'thinking', 'Thinking…')
    return { answers }
  }

  // ---------- subagents ----------

  private networkHost: NetworkHost = {
    agents: () => this.agents.values(),
    spawn: (req) => this.spawnChild(req),
    deliver: (toAgentId, text) => this.deliverTo(toAgentId, text),
    announce: (m: AgentMessage, text: string) => {
      this.emit({ type: 'agent.message', runId: this.ctx.run.id, ...m })
      this.transcript(m.from, { kind: 'system', text })
    }
  }

  private async spawnChild(req: SpawnRequest): Promise<void> {
    const parent = this.agents.get(req.parentId)
    const parentRole = this.net.roleOf(req.parentId) ?? this.root
    // Writing reports get their own worktree when their parent is the orchestrator or is itself isolated.
    const parentWt = req.parentId === ROOT_AGENT_ID ? undefined : this.integrator.worktreeOf(req.parentId)
    const parentIsolated = req.parentId === ROOT_AGENT_ID || !!parentWt
    let worktree: WorktreeInfo | undefined
    let cwd = this.ctx.project.path
    if (this.isolation && parentIsolated && canWrite(req.role)) {
      const created = await createAgentWorktree(parentWt?.path ?? this.ctx.project.path, req.id)
      cwd = created.path
      worktree = this.integrator.track(req.id, {
        path: created.path,
        branch: created.branch,
        status: 'active',
        ...(parentWt ? { mergeTarget: 'parent' as const, parentAgentId: req.parentId, parentBranch: parentWt.branch } : { mergeTarget: 'main' as const })
      })
    } else if (parentWt) {
      cwd = parentWt.path // a non-writing or non-isolated report works in its isolated parent's checkout
    }
    this.integrator.noteBrief(req.id, req.description ?? req.brief.slice(0, 100))
    const parentLabel = req.parentId === ROOT_AGENT_ID ? 'the orchestrator' : (parent?.handle ?? parentRole.slug)
    const policy = this.policyFor(req.role)
    try {
      const params = this.threadParams(req.role, false, cwd, parent?.model)
      const started = await this.startThread(params)
      this.bindThread(started.threadId, req.id, policy)
      this.newAgent(req.id, req.role, {
        parentId: req.parentId,
        spawnToolUseId: req.callId || null,
        handle: req.handle,
        state: 'thinking',
        activity: (req.description ?? req.brief).replace(/\s+/g, ' ').slice(0, 90) || 'Reading the brief…',
        ...(started.model ?? parent?.model ? { model: started.model ?? parent?.model } : {}),
        ...(worktree ? { worktree } : {})
      })
      this.transcript(req.id, { kind: 'user', text: req.brief })
      const effort = req.role.effort && ['low', 'medium', 'high'].includes(req.role.effort) ? { effort: req.role.effort } : {}
      await this.sendToThread(started.threadId, childFirstMessage(parentLabel, req.brief), undefined, effort)
    } catch (e) {
      if (this.agents.delete(req.id)) this.emit({ type: 'agent.remove', runId: this.ctx.run.id, agentId: req.id })
      if (worktree) void this.integrator.onSubagentFinished(req.id)
      throw e
    }
  }

  // ---------- MCP ----------

  /**
   * request_mcp_install was approved: RunManager added the server to the run. Codex reads MCP servers when the
   * app-server starts (`-c mcp_servers.*`, with secrets forwarded through its environment), so a server added
   * mid-run needs a restart. The restart waits until no turn is running (it would cut the install call itself
   * short otherwise), re-launches with every server and thread/resumes each thread; the orchestrator is then
   * told the server is connected. Returns the tool prefix now; the tools appear after the restart.
   */
  private async addMcpServer(spec: McpServerSpec): Promise<string> {
    if (!this.ctx.resolvedMcpServers) throw new Error('This run cannot attach MCP servers; the server is available from the next run.')
    this.mcpRestartPending = true
    this.pendingMcpPrefixes.push(mcpToolPrefix(spec.name))
    this.log('info', `MCP server ${spec.name} will be attached when the agents are idle (Codex reads MCP servers at start-up).`)
    void this.maybeRestartForMcp()
    return mcpToolPrefix(spec.name)
  }

  private async maybeRestartForMcp(): Promise<void> {
    if (!this.mcpRestartPending || this.restarting || this.ending || this.activeTurn.size > 0) return
    this.restarting = true
    this.mcpRestartPending = false
    try {
      const servers = await this.ctx.resolvedMcpServers!()
      const launch = buildLaunchConfig(this.ctx.connection, servers)
      const old = this.server
      this.unwire()
      old.close()
      await Promise.race([old.exited, new Promise((r) => setTimeout(r, EXIT_WAIT_MS))])
      this.launch = launch
      this.server = this.createServer(launch)
      this.wire(this.server)
      await this.server.start(this.options.clientVersion)
      for (const [threadId, info] of this.threads) {
        const role = this.net.roleOf(info.agentId) ?? this.root
        const wt = this.integrator.worktreeOf(info.agentId)
        const { dynamicTools: _t, serviceName: _s, ...resume } = this.threadParams(role, info.agentId === ROOT_AGENT_ID, wt?.path ?? this.ctx.project.path)
        void _t
        void _s
        try {
          await this.startThread({ threadId, ...resume }, METHOD.threadResume)
        } catch (e) {
          if (info.agentId === ROOT_AGENT_ID) throw e
          this.log('warn', `Could not resume the thread of ${this.agents.get(info.agentId)?.name ?? info.agentId}: ${(e as Error).message}`)
          this.setState(info.agentId, 'error', 'Lost its session in a restart')
        }
      }
      this.activeTurn.clear()
      const prefixes = this.pendingMcpPrefixes.splice(0)
      this.log('info', `Codex restarted with ${servers.filter((s) => s.spec.enabled).length} MCP server(s).`)
      this.notifyOrchestrator(`Harness: the MCP server${prefixes.length === 1 ? '' : 's'} you requested ${prefixes.length === 1 ? 'is' : 'are'} connected now. Tool names start with ${prefixes.join(' and ')}.`, 'Using a new MCP server…')
    } catch (e) {
      this.restarting = false
      this.fail(`Could not restart Codex to attach the MCP server: ${(e as Error).message}`)
      return
    }
    this.restarting = false
  }
}

export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex' as const

  constructor(private options: CodexAdapterOptions = {}) {}

  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    return new CodexSession(ctx, this.options)
  }

  /**
   * One-shot completion on an ephemeral, tool-less thread: read-only sandbox, approvals never, the system text as
   * developer instructions. Returns the final agent message.
   */
  async complete(input: CompletionInput): Promise<string> {
    const connection = await this.options.completionConnection?.()
    const launch = buildLaunchConfig(connection, [])
    const options: CodexAppServerOptions = { cwd: input.cwd, env: launch.env, config: launch.config }
    const server: CodexServerLike = this.options.createServer ? this.options.createServer(options) : new CodexAppServer(options)
    let text = ''
    let final = ''
    let failure: string | undefined
    let done!: () => void
    const completed = new Promise<void>((resolve) => (done = resolve))
    const mapper = new CodexEventMapper()
    server.onNotification((method, params) => {
      for (const u of mapper.handle(method, params)) {
        if (u.type === 'text') text += (text ? '\n\n' : '') + u.text
        if (u.type === 'turnCompleted') {
          final = u.result ?? ''
          if (u.status === 'failed') failure = u.error?.message ?? 'the turn failed'
          done()
        }
      }
    })
    server.onServerRequest(async (method) => {
      // Nothing may run: decline every approval and tool call.
      if (method === SERVER_REQUEST.toolCall) return toolResponse('No tools are available.', false)
      if (method === SERVER_REQUEST.mcpElicitation) return { action: 'decline', content: null, _meta: null }
      return { decision: 'decline' }
    })
    server.onExit((code, error) => {
      failure ??= error?.message ?? `codex app-server exited (code ${code ?? 'unknown'})`
      done()
    })
    try {
      await server.start(this.options.clientVersion)
      const model = codexModelFor(input.model)
      const res = await server.request(METHOD.threadStart, {
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: input.system,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(model ? { model } : {}),
        serviceName: ORGAI_SERVICE
      })
      const thread = parseThreadResult(res)
      if (!thread) throw new Error('thread/start returned no thread id')
      await server.request(METHOD.turnStart, { threadId: thread.threadId, input: userInput(input.prompt) })
      await Promise.race([completed, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Completion timed out')), this.options.completionTimeoutMs ?? 180_000))])
      if (failure) throw new Error(`Completion failed: ${failure}`)
      return final || text
    } finally {
      server.close()
    }
  }
}
