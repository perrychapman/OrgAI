import { readFileSync } from 'node:fs'
import type { AgentInstance, ConnectionId, ImageAttachment, McpServerSpec, PluginSpec, ProviderId, Role, RunEvent, RunPlan, TranscriptBlock } from '@shared/types'
import { MCP_HARNESS_TOOLS, SPAWN_TOOL } from '@shared/types'
import { mcpServersForRole, newId } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type CompletionInput, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { harnessToolsFor, isBlockingHarnessTool, type HarnessTool } from './harnessTools'
import { ContinuationDriver, PLAN_TOOLS, stepActivity } from './continuation'
import { describeTool, harnessToolActivity } from './activity'
import { allowRuleStrings, applyAllowScope, chooseSuggestions, listRules, suggestionLabels } from './permissionRules'
import { composeFirstMessage } from './prompts'
import { HandleNamer, mapSendMessage, messageTranscriptText, spawnHandle } from './network'

/**
 * A scripted, token-free provider. It plays a script of steps and emits the same normalized RunEvents a
 * real adapter would, going through the same RuntimeContext round-trips (permissions, proposals, setup
 * completion) and the shared harness tools. Used by tests and for UI work: set ORGAI_MOCK=1 and a
 * project's provider.id to "mock"; ORGAI_MOCK_SCRIPT may point at a JSON MockScript.
 */

export type MockStep =
  /** Assistant text from an agent (default: the root). */
  | { type: 'text'; agent?: string; text: string }
  | { type: 'thinking'; agent?: string; text: string }
  /**
   * A tool call. With `ask`, it first needs the user's approval through ctx.requestPermission. With
   * `background` too, the turn goes on without waiting for the answer (a report's call still pending
   * while the orchestrator's turn ends).
   */
  | { type: 'tool'; agent?: string; name: string; input?: Record<string, unknown>; result?: string; ask?: boolean; background?: boolean }
  /** Spawn a report. `role` is a slug; default: the first role the parent may spawn. */
  | { type: 'spawn'; id: string; role?: string; description: string; parent?: string; /** Handle; default <role>-<n>. */ name?: string }
  /** An agent messages another by handle or role slug (SendMessage). `from` defaults to the root. */
  | { type: 'message'; from?: string; to: string; text: string }
  /** A report finishes and reports back to its parent. */
  | { type: 'finish'; id: string; result: string }
  /** Call one of the harness's own tools by bare name (propose_architecture, ask_user, complete_setup, ...). */
  | { type: 'harness'; name: string; args?: Record<string, unknown>; /** Re-run the call when the user asks for changes. Default true. */ retryOnRevise?: boolean }
  /**
   * The plan's usage limit rejects the next request: reports ctx.rateLimited (with `until` ms from now,
   * when given) and ends the session, like the Claude adapter does at the next result.
   */
  | { type: 'rateLimit'; window?: string; untilInMs?: number }
  /** The orchestrator sets its plan (set_plan). Steps are titles or { title, owner }. */
  | { type: 'plan'; goal: string; steps: (string | { title: string; owner?: string })[] }
  /** The orchestrator updates plan steps (update_plan). */
  | { type: 'planUpdate'; steps: { id: string; status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'; note?: string }[] }
  /** The orchestrator completes the plan (complete_plan). */
  | { type: 'planComplete'; summary: string }

export interface MockScript {
  /** Pause before each step, in milliseconds. Default 400. */
  delayMs?: number
  /** Steps for work runs. */
  work?: MockStep[]
  /** Steps for setup runs. */
  setup?: MockStep[]
  /** Steps for MCP assistant runs ('mcp-assist'). */
  mcpAssist?: MockStep[]
  /** Reply to follow-up messages; "{text}" is replaced with the user's message. */
  reply?: string
  /**
   * Turns played for successive harness nudges (automatic continues), in order. Once used up, a nudge
   * gets a one-line text reply that changes nothing.
   */
  continue?: MockStep[][]
}

const DEFAULT_WORK: MockStep[] = [
  { type: 'thinking', text: 'The request is small; one report can do it while I review.' },
  { type: 'text', text: 'Planning the work: I will read the project, delegate the change and review the result.' },
  { type: 'tool', name: 'Read', input: { file_path: 'README.md' }, result: '# Mock project\n' },
  { type: 'spawn', id: 'mock-report-1', description: 'Implement the requested change' },
  { type: 'tool', agent: 'mock-report-1', name: 'Read', input: { file_path: 'src/example.ts' }, result: 'export const x = 1\n' },
  { type: 'tool', agent: 'mock-report-1', name: 'Edit', input: { file_path: 'src/example.ts', old_string: 'x = 1', new_string: 'x = 2' }, ask: true, result: 'File updated.' },
  { type: 'text', agent: 'mock-report-1', text: 'Done. Changed src/example.ts.' },
  { type: 'finish', id: 'mock-report-1', result: 'Changed src/example.ts (x is now 2). Files touched: src/example.ts' },
  { type: 'text', text: 'The report finished: src/example.ts was updated. Anything else?' }
]

const DEFAULT_SETUP: MockStep[] = [
  { type: 'text', text: 'I will look at the repository first, then propose the architecture.' },
  { type: 'tool', name: 'Glob', input: { pattern: '**/*' }, result: 'README.md\nsrc/example.ts' },
  { type: 'tool', name: 'Bash', input: { command: 'git status --short' }, ask: true, result: '' },
  {
    type: 'harness',
    name: 'propose_architecture',
    args: {
      title: 'Mock architecture',
      summary: 'A small TypeScript project used to exercise the harness without spending tokens.',
      stack: ['TypeScript', 'Node.js'],
      modules: [{ name: 'core', purpose: 'Example code', paths: ['src/'] }],
      conventions: ['Strict TypeScript', 'Tests beside the modules'],
      commands: [{ name: 'test', command: 'npm test' }],
      risks: ['This is a scripted mock; nothing was analysed.']
    }
  },
  {
    type: 'harness',
    name: 'propose_org_chart',
    args: {
      title: 'Mock org chart',
      rationale: 'One lead delegating to one engineer is enough to exercise spawning.',
      roles: [
        {
          name: 'Lead',
          description: 'Plans the work and delegates it.',
          responsibilities: ['Plan', 'Delegate', 'Review'],
          prompt: 'You are the lead. Break the request into briefs, delegate them, and review what comes back.',
          tools: ['Read', 'Glob', 'Grep'],
          model: 'opus',
          canSpawn: true,
          spawnable: ['Engineer'],
          reportsTo: null
        },
        {
          name: 'Engineer',
          description: 'Implements a brief.',
          responsibilities: ['Implement', 'Report the files changed'],
          prompt: 'You are an engineer. Implement the brief, stay within its files, and list every file you touched.',
          tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
          model: 'sonnet',
          canSpawn: false,
          spawnable: [],
          reportsTo: 'Lead'
        }
      ]
    }
  },
  {
    type: 'harness',
    name: 'propose_settings',
    args: {
      title: 'Mock settings',
      rationale: 'Defaults are fine for a mock.',
      brief: 'A mock project used to exercise OrgAI without spending tokens.',
      maxSubagentDepth: 2,
      maxConcurrentSubagents: 3
    }
  },
  { type: 'harness', name: 'complete_setup', args: { summary: 'Mock setup finished: architecture, org chart and settings were approved.' } },
  { type: 'text', text: 'Setup is complete.' }
]

const DEFAULT_MCP_ASSIST: MockStep[] = [
  { type: 'text', text: 'I will check which MCP servers the project has, then look in the registry.' },
  { type: 'harness', name: MCP_HARNESS_TOOLS.listServers, args: {} },
  { type: 'harness', name: MCP_HARNESS_TOOLS.searchRegistry, args: { query: 'filesystem' } },
  {
    type: 'harness',
    name: MCP_HARNESS_TOOLS.proposeServers,
    args: {
      title: 'Mock MCP servers',
      rationale: 'A filesystem server lets the roles read shared notes.',
      upsert: [{ id: 'mcp-mock-fs', name: 'mock-fs', transport: 'stdio', command: 'npx', args: ['-y', 'mock-fs-server'], enabled: true, source: 'registry', addedAt: '2026-01-01T00:00:00.000Z' }]
    }
  },
  { type: 'text', text: 'The MCP servers are set up.' }
]

export const DEFAULT_MOCK_SCRIPT: Required<MockScript> = {
  delayMs: 400,
  work: DEFAULT_WORK,
  setup: DEFAULT_SETUP,
  mcpAssist: DEFAULT_MCP_ASSIST,
  reply: 'Mock reply to: {text}',
  continue: []
}

/** The script from ORGAI_MOCK_SCRIPT (a JSON file), filled in from the default; the default when unset. */
export function loadMockScript(env: NodeJS.ProcessEnv = process.env): { script: Required<MockScript>; error?: string } {
  const file = env.ORGAI_MOCK_SCRIPT
  if (!file) return { script: DEFAULT_MOCK_SCRIPT }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MockScript
    return { script: { ...DEFAULT_MOCK_SCRIPT, ...parsed } }
  } catch (e) {
    return { script: DEFAULT_MOCK_SCRIPT, error: `Could not read ORGAI_MOCK_SCRIPT ${file}: ${(e as Error).message}` }
  }
}

const STOPPED = Symbol('stopped')
/** Synthetic price per token so the canvas shows moving numbers. */
const USD_PER_TOKEN = 0.000003

export class MockSession implements RuntimeSession {
  readonly finished: Promise<void>
  /** Harness messages delivered to the orchestrator (automatic continues), in order. For tests. */
  readonly harnessMessages: string[] = []
  /** What a real adapter would grant: role slug -> names of the MCP servers that role may use. For tests. */
  readonly mcpServersByRole: Record<string, string[]> = {}
  /** The enabled plugins the session would load. For tests. */
  readonly plugins: PluginSpec[] = []
  /** Which adapter and connection the run was routed to; never secrets. Undefined without ctx.connection. For tests. */
  readonly connection?: { adapter: ProviderId; connection: ConnectionId }
  /** Servers attached mid-run through the harness's addMcpServer hook, in order. For tests. */
  readonly addedMcpServers: McpServerSpec[] = []
  private agents = new Map<string, AgentInstance>()
  private rolesBySlug: Map<string, Role>
  private root: Role
  private isSetup: boolean
  private tools: HarnessTool[]
  private inbox: { text: string; harness: boolean }[] = []
  private continueTurns: MockStep[][]
  private continuation: ContinuationDriver
  private wake: (() => void) | null = null
  private stopped = false
  private interrupted = false
  private stopSignal: Promise<typeof STOPPED>
  private signalStop!: () => void
  /** agent id -> spawning tool_use id, for the parent's tool_result. */
  private spawnToolUse = new Map<string, string>()
  /** Allow rules granted for the rest of this session. */
  private sessionRules = new Set<string>()
  private handles = new HandleNamer()

  constructor(
    private ctx: RuntimeContext,
    private script: Required<MockScript>,
    loadError?: string
  ) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = isSetupLikeRun(ctx.run.kind)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
    const onDecided = (): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && a.state === 'waiting') this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    }
    const onPlanUpdated = (plan: RunPlan): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      const activity = stepActivity(plan)
      if (a && activity && a.state !== 'done' && a.state !== 'error') this.setState(ROOT_AGENT_ID, a.state, activity)
    }
    this.tools = harnessToolsFor(ctx, { onDecided, onPlanUpdated, addMcpServer: (spec) => this.addMcpServer(spec) })
    const mcpSpecs = { mcpServers: ctx.mcpServers ? ctx.mcpServers() : ctx.project.mcpServers }
    for (const r of ctx.roles) this.mcpServersByRole[r.slug] = mcpServersForRole(mcpSpecs, r).map((s) => s.name)
    this.plugins.push(...(ctx.plugins?.() ?? []).filter((p) => p.enabled))
    if (ctx.connection) this.connection = { adapter: ctx.connection.adapter, connection: ctx.connection.connection }
    this.continueTurns = [...(script.continue ?? [])]
    this.continuation = new ContinuationDriver({
      kind: ctx.run.kind,
      autoContinue: ctx.autoContinue,
      maxAutoContinues: ctx.maxAutoContinues,
      delayMs: ctx.continuationDelayMs,
      getPlan: () => ctx.getPlan(),
      updatePlan: (plan) => ctx.updatePlan(plan),
      liveReports: () => [...this.agents.values()].filter((a) => a.id !== ROOT_AGENT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => false,
      stopping: () => this.stopped,
      orchestratorBusy: () => {
        const root = this.agents.get(ROOT_AGENT_ID)
        return !!root && root.state !== 'idle' && root.state !== 'done'
      },
      nudge: (text, activity) => this.deliverHarness(text, activity),
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_AGENT_ID, { kind: 'system', text })
    })
    this.stopSignal = new Promise((resolve) => (this.signalStop = () => resolve(STOPPED)))
    if (loadError) this.log('warn', loadError)
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.transcript(ROOT_AGENT_ID, images?.length ? { kind: 'user', text, images } : { kind: 'user', text })
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    // An image-only message is still a turn; give the scripted reply something to echo.
    const n = images?.length ?? 0
    this.inbox.push({ text: text || (n ? `[${n} image${n === 1 ? '' : 's'}]` : ''), harness: false })
    this.poke()
  }

  /** Ends the current turn before its next step; a blocking request in flight still waits for its answer. */
  async interrupt(): Promise<void> {
    this.continuation.hold()
    this.interrupted = true
    this.poke()
  }

  async stop(): Promise<void> {
    this.continuation.dispose()
    this.stopped = true
    this.signalStop()
    this.poke()
  }

  /** The addMcpServer harness hook: record the server the way a live adapter would attach it. */
  async addMcpServer(spec: McpServerSpec): Promise<string> {
    this.addedMcpServers.push(spec)
    return `mcp__${spec.name}__`
  }

  // ---------- events ----------

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

  private ensureAgent(id: string, init?: Partial<AgentInstance>): AgentInstance {
    let a = this.agents.get(id)
    if (!a) {
      const role = this.rolesBySlug.get(init?.roleSlug ?? this.root.slug)
      a = {
        id,
        roleId: role?.id ?? null,
        roleSlug: role?.slug ?? this.root.slug,
        name: role?.name ?? id,
        parentId: id === ROOT_AGENT_ID ? null : ROOT_AGENT_ID,
        spawnToolUseId: null,
        state: 'starting',
        activity: 'Starting…',
        model: 'mock',
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

  /** Synthetic usage: every step costs a little, so tokens and cost move like a real run. */
  private charge(agentId: string, text: string): void {
    const a = this.ensureAgent(agentId)
    a.inputTokens += 800
    a.outputTokens += Math.max(20, Math.ceil(text.length / 4))
    a.costUsd = (a.inputTokens + 5 * a.outputTokens) * USD_PER_TOKEN
  }

  private totalCost(): number {
    let usd = 0
    for (const a of this.agents.values()) usd += a.costUsd
    return usd
  }

  // ---------- control flow ----------

  private poke(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  /** Wait `ms`, cut short by stop or interrupt. */
  private pause(ms: number): Promise<void> {
    if (ms <= 0 || this.stopped || this.interrupted) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }

  private untilStopped<T>(p: Promise<T>): Promise<T | typeof STOPPED> {
    return Promise.race([p, this.stopSignal])
  }

  private nextMessage(): Promise<{ text: string; harness: boolean } | null> {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift()!)
    if (this.stopped) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.wake = () => resolve(this.stopped ? null : this.inbox.shift() ?? { text: '', harness: false })
    })
  }

  /** A harness message for the orchestrator (the Claude adapter's notifyOrchestrator path). */
  private deliverHarness(text: string, activity: string): void {
    this.harnessMessages.push(text)
    this.transcript(ROOT_AGENT_ID, { kind: 'system', text })
    const root = this.agents.get(ROOT_AGENT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_AGENT_ID, 'thinking', activity)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
    this.inbox.push({ text, harness: true })
    this.poke()
  }

  private async run(): Promise<void> {
    const runId = this.ctx.run.id
    this.ensureAgent(ROOT_AGENT_ID, {
      roleId: this.root.id,
      roleSlug: this.root.slug,
      name: this.root.name,
      parentId: null,
      state: 'thinking',
      activity: 'Reading your request…'
    })
    if (this.ctx.resumeSessionId) {
      this.transcript(ROOT_AGENT_ID, { kind: 'system', text: `Continued from run ${this.ctx.run.resumedFrom ?? this.ctx.resumeSessionId}` })
    }
    const firstImages = this.ctx.images
    this.transcript(
      ROOT_AGENT_ID,
      firstImages?.length ? { kind: 'user', text: this.ctx.prompt, images: firstImages } : { kind: 'user', text: this.ctx.prompt }
    )
    const sessionId = this.ctx.resumeSessionId ?? `mock-${runId}`
    try {
      this.emit({ type: 'run.status', runId, status: 'running', sessionId })
      const first = composeFirstMessage(this.ctx.prompt, this.ctx.hiddenContext)
      this.log('info', `Mock session ${sessionId} started (${this.ctx.run.kind} script, first message ${first.length} chars)`)
      await this.turn(this.ctx.run.kind === 'mcp-assist' ? this.script.mcpAssist : this.isSetup ? this.script.setup : this.script.work)
      while (!this.stopped) {
        const next = await this.nextMessage()
        if (next === null) break
        if (!next.text) continue
        this.emit({ type: 'run.status', runId, status: 'running' })
        if (next.harness) await this.turn(this.continueTurns.shift() ?? [{ type: 'text', text: 'Mock: continuing with the plan.' }])
        else await this.turn([{ type: 'text', text: this.script.reply.replace('{text}', next.text) }])
      }
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      const message = (e as Error).message ?? String(e)
      this.log('error', message)
      this.setState(ROOT_AGENT_ID, 'error', message.slice(0, 80))
      this.emit({ type: 'run.status', runId, status: 'error', error: message })
    } finally {
      this.continuation.dispose()
      for (const a of this.agents.values()) {
        if (a.state !== 'done' && a.state !== 'error') {
          a.state = 'done'
          a.endedAt = Date.now()
          this.upsert(a)
        }
      }
    }
  }

  private async turn(steps: MockStep[]): Promise<void> {
    this.interrupted = false
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    for (const step of steps) {
      await this.pause(this.script.delayMs)
      if (this.stopped || this.interrupted) break
      await this.step(step)
    }
    if (this.stopped) return
    if (this.interrupted) this.log('info', 'Turn interrupted.')
    this.emit({ type: 'run.cost', runId: this.ctx.run.id, totalCostUsd: this.totalCost() })
    const root = this.ensureAgent(ROOT_AGENT_ID)
    root.state = 'idle'
    const reportsRunning = [...this.agents.values()].some((x) => x.id !== ROOT_AGENT_ID && x.state !== 'done' && x.state !== 'error')
    root.activity = reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
    this.upsert(root)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
    if (!this.interrupted && !this.isSetup) this.continuation.turnEnded()
  }

  private async step(step: MockStep): Promise<void> {
    switch (step.type) {
      case 'text': {
        const agentId = step.agent ?? ROOT_AGENT_ID
        const a = this.ensureAgent(agentId)
        this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: step.text.slice(0, Math.ceil(step.text.length / 2)) })
        a.lastText = step.text.trim().slice(0, 200)
        this.charge(agentId, step.text)
        this.transcript(agentId, { kind: 'text', text: step.text })
        this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: '' })
        this.upsert(a)
        return
      }
      case 'thinking': {
        this.transcript(step.agent ?? ROOT_AGENT_ID, { kind: 'thinking', text: step.text })
        return
      }
      case 'tool':
        return this.toolStep(step)
      case 'spawn':
        return this.spawnStep(step)
      case 'finish': {
        const a = this.ensureAgent(step.id)
        a.result = step.result
        a.state = 'done'
        a.activity = 'Reported back'
        a.endedAt = Date.now()
        this.upsert(a)
        const toolUseId = this.spawnToolUse.get(step.id)
        if (toolUseId) this.transcript(a.parentId ?? ROOT_AGENT_ID, { kind: 'tool_result', toolUseId, content: step.result, isError: false })
        if (a.parentId) this.setState(a.parentId, 'thinking', 'Thinking…')
        return
      }
      case 'harness':
        return this.harnessStep(step)
      case 'plan':
        return this.harnessStep({
          type: 'harness',
          name: PLAN_TOOLS.set,
          args: { goal: step.goal, steps: step.steps.map((s) => (typeof s === 'string' ? { title: s } : s)) }
        })
      case 'planUpdate':
        return this.harnessStep({ type: 'harness', name: PLAN_TOOLS.update, args: { steps: step.steps } })
      case 'planComplete':
        return this.harnessStep({ type: 'harness', name: PLAN_TOOLS.complete, args: { summary: step.summary } })
      case 'message': {
        const from = step.from ?? ROOT_AGENT_ID
        const input = { to: step.to, message: step.text }
        this.transcript(from, { kind: 'tool_use', id: newId('tu'), name: 'SendMessage', input })
        const m = mapSendMessage(from, input, this.agents.values())
        if (!m) return
        this.emit({ type: 'agent.message', runId: this.ctx.run.id, ...m })
        this.transcript(from, { kind: 'system', text: messageTranscriptText(m) })
        if (m.to) this.transcript(m.to, { kind: 'user', text: step.text })
        return
      }
      case 'rateLimit': {
        const until = step.untilInMs !== undefined ? Date.now() + step.untilInMs : undefined
        const window = step.window ?? 'five_hour'
        this.emit({
          type: 'usage.status',
          runId: this.ctx.run.id,
          usage: {
            authMode: 'subscription',
            subscriptionType: 'mock',
            available: true,
            windows: { fiveHour: { utilization: 100, resetsAt: until ?? null } },
            status: 'rejected',
            limitedWindow: window,
            ...(until ? { limitedUntil: until } : {}),
            updatedAt: Date.now()
          }
        })
        this.log('warn', 'Mock usage limit reached; ending the session.')
        this.ctx.rateLimited({ window, ...(until ? { until } : {}) })
        this.stopped = true
        this.signalStop()
        return
      }
    }
  }

  private async toolStep(step: Extract<MockStep, { type: 'tool' }>): Promise<void> {
    const agentId = step.agent ?? ROOT_AGENT_ID
    const input = step.input ?? {}
    const id = newId('tu')
    this.transcript(agentId, { kind: 'tool_use', id, name: step.name, input })
    this.charge(agentId, JSON.stringify(input))
    this.setState(agentId, 'tool', describeTool(step.name, input))
    if (step.ask && step.background) {
      // Leave the request pending and carry on; the result lands whenever the user answers.
      this.setState(agentId, 'waiting', `Needs approval: ${describeTool(step.name, input)}`)
      void this.ctx.requestPermission({ agentId, toolName: step.name, input, summary: describeTool(step.name, input) }).then((decision) => {
        if (this.stopped) return
        const denied = decision.behavior === 'deny'
        this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: denied ? decision.message : step.result ?? 'ok', isError: denied })
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'thinking', 'Thinking…')
      })
      return
    }
    if (step.ask) {
      const suggestions = chooseSuggestions(step.name, input, undefined)
      const rules = allowRuleStrings(suggestions)
      const saved = new Set([...listRules(this.ctx.project.path), ...this.sessionRules])
      const preApproved = rules.length > 0 && rules.every((r) => saved.has(r))
      if (!preApproved) {
        this.setState(agentId, 'waiting', `Needs approval: ${describeTool(step.name, input)}`)
        const decision = await this.untilStopped(
          this.ctx.requestPermission({
            agentId,
            toolName: step.name,
            input,
            summary: describeTool(step.name, input),
            ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {})
          })
        )
        if (decision === STOPPED) return
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describeTool(step.name, input))
        if (decision.behavior === 'deny') {
          this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: decision.message, isError: true })
          this.setState(agentId, 'thinking', 'Thinking…')
          return
        }
        const granted = applyAllowScope(this.ctx.project.path, decision, suggestions, (level, message) => this.log(level, message))
        for (const r of allowRuleStrings(granted ?? [])) this.sessionRules.add(r)
      }
    }
    this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: step.result ?? 'ok', isError: false })
    this.setState(agentId, 'thinking', 'Thinking…')
  }

  private async spawnStep(step: Extract<MockStep, { type: 'spawn' }>): Promise<void> {
    const parentId = step.parent ?? ROOT_AGENT_ID
    const parent = this.ensureAgent(parentId)
    const parentRole = this.rolesBySlug.get(parent.roleSlug)
    const allowed = parentRole ? this.ctx.roles.filter((r) => parentRole.spawnable.includes(r.id)) : []
    const slug = step.role ?? allowed[0]?.slug ?? this.ctx.roles.find((r) => r.reportsTo !== null)?.slug ?? this.root.slug
    const { handle } = spawnHandle(this.handles, slug, step.name)
    const input = { subagent_type: slug, description: step.description, prompt: step.description, name: handle }
    const toolUseId = newId('tu')
    this.transcript(parentId, { kind: 'tool_use', id: toolUseId, name: SPAWN_TOOL, input })
    this.setState(parentId, 'delegating', describeTool(SPAWN_TOOL, input))
    this.spawnToolUse.set(step.id, toolUseId)
    const role = this.rolesBySlug.get(slug)
    this.upsert({
      ...this.ensureAgent(step.id, { roleSlug: slug, parentId }),
      roleId: role?.id ?? null,
      roleSlug: slug,
      name: role?.name ?? slug,
      parentId,
      spawnToolUseId: toolUseId,
      handle,
      state: 'thinking',
      activity: step.description.slice(0, 90) || 'Reading the brief…'
    })
    this.transcript(step.id, { kind: 'user', text: step.description })
  }

  private async harnessStep(step: Extract<MockStep, { type: 'harness' }>): Promise<void> {
    const t = this.tools.find((x) => x.name === step.name)
    if (!t) {
      this.log('warn', `Mock script calls unknown harness tool ${step.name} for a ${this.ctx.run.kind} run`)
      return
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newId('tu')
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_use', id, name: step.name, input: step.args ?? {} })
      this.setState(ROOT_AGENT_ID, isBlockingHarnessTool(step.name) ? 'waiting' : 'tool', harnessToolActivity(step.name))
      let text: string
      let isError = false
      try {
        const res = await this.untilStopped(t.call(step.args ?? {}, { agentId: ROOT_AGENT_ID }))
        if (res === STOPPED) return
        text = res
      } catch (e) {
        text = (e as Error).message
        isError = true
      }
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_result', toolUseId: id, content: text, isError })
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && (a.state === 'waiting' || a.state === 'tool')) this.setState(ROOT_AGENT_ID, 'thinking', stepActivity(this.ctx.getPlan()) ?? 'Thinking…')
      if (isError || !text.startsWith('REVISE') || step.retryOnRevise === false || this.stopped || this.interrupted) return
      this.transcript(ROOT_AGENT_ID, { kind: 'text', text: 'Revising the proposal with your feedback.' })
    }
  }
}

export interface MockAdapterOptions {
  /** Use this script instead of ORGAI_MOCK_SCRIPT or the default. Missing fields come from the default. */
  script?: MockScript
}

export class MockAdapter implements RuntimeAdapter {
  readonly id = 'mock' as const
  /** Every session this adapter started, oldest first. For tests. */
  readonly sessions: MockSession[] = []

  constructor(private options: MockAdapterOptions = {}) {}

  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    // Read the script per run so edits to the JSON file apply without a restart.
    const loaded = this.options.script ? { script: { ...DEFAULT_MOCK_SCRIPT, ...this.options.script } } : loadMockScript()
    const session = new MockSession(ctx, loaded.script, 'error' in loaded ? loaded.error : undefined)
    this.sessions.push(session)
    return session
  }

  /** A fixed org chart draft, in the JSON shape the drafter expects. */
  async complete(_input: CompletionInput): Promise<string> {
    const setupStep = DEFAULT_SETUP.find((s): s is Extract<MockStep, { type: 'harness' }> => s.type === 'harness' && s.name === 'propose_org_chart')
    const args = setupStep?.args ?? { rationale: '', roles: [] }
    return JSON.stringify({ rationale: args.rationale, roles: args.roles })
  }
}
