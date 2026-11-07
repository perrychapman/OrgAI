import type { AgentInstance, AgentMessage, ImageAttachment, McpServerSpec, Role, RunEvent, TranscriptBlock, WorktreeInfo } from '@shared/types'
import { KNOWLEDGE_RECALL_TOOL, SKILL_HARNESS_TOOLS, isBuiltinConnectionId, isModelTier } from '@shared/types'
import { effectiveSubagentLimits, isolateWritersOn, newId, projectKindOf } from '@shared/defaults'
import { validModelId } from '../connections/codexAccount'
import { ROOT_AGENT_ID, isSetupLikeRun, type CompletionInput, type PeerMessage, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type RootTurnEnd, type SessionSettlement, type ExecActivityReason } from './types'
import { CodexAppServer, CodexRpcError, codexExitMessage, type CodexAppServerOptions } from './codexAppServer'
import {
  METHOD,
  SERVER_REQUEST,
  buildLaunchConfig,
  codexToolName,
  dynamicToolSpec,
  harnessToolName,
  lockNativeSkills,
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
  type FolderTrustConfig,
  type LaunchConfig,
  type PolicyChoice
} from './codexProtocol'
import { countUsage, setModelTokens } from './runUsage'
import { CodexEventMapper, NETWORK_TOOLS, ThrottledPartial, fileChanges, type CodexUpdate } from './codexEvents'
import { costFromPrice, openAiMix, priceFor } from './pricing'
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
import { SETUP_TOOLS_INSTRUCTIONS, harnessToolsFor, isBlockingHarnessTool, type ConfigChange, type ConfigChangeResult, type HarnessTool, type HarnessToolHooks, type McpAttachResult } from './harnessTools'
import { ContinuationDriver, stepActivity } from './continuation'
import { buildRolePrompt, peerMessageText, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { firstMessageHiddenContext, spawnKnowledge, userMessageKnowledge, withSpawnKnowledge, withUserMessageKnowledge } from './knowledgeDelivery'
import { describeTool, isAuthFailure } from './activity'
import { WorktreeIntegrator } from './integration'
import { allowRuleStrings, applyAllowScope, chooseSuggestions, isOfferableDirectory, listRules, suggestionLabels } from './permissionRules'
import { isFreeCdTarget, matchOptionsFor, type MatchOptions } from './ruleMatch'
import { dirname, isAbsolute, join } from 'node:path'
import { isGitRepo } from './worktrees'
import { canonicalDeep, isInsideEither, isNetworkPath, isTrustRestrictedRun, isWorkspaceConfigPath } from '../quick/scratch'
import { lstatSync } from 'node:fs'
import { commandReferenceTouch, referenceCommandMessage, referenceFolderMessage, referenceFolderOf, referenceRefusalEntry } from './referenceDirectories'

/**
 * sandbox_workspace_write.writable_roots for a run: the allowed folders only, never on a trust-restricted run, and
 * never a reference folder: an allowed folder that is, is inside or contains a reference folder is left out (writes
 * inside writable roots need no approval, so the reference gate in onFileApproval would never see them).
 */
export function codexWritableRoots(ctx: Pick<RuntimeContext, 'allowedDirectories' | 'referenceDirectories' | 'run'>): string[] {
  if (isTrustRestrictedRun(ctx.run)) return []
  const allowed = (ctx.allowedDirectories?.() ?? []).filter((d) => typeof d === 'string' && d.length > 0)
  const refs = (ctx.referenceDirectories?.() ?? []).filter((r) => typeof r === 'string' && r.length > 0)
  if (!refs.length) return allowed
  return allowed.filter((d) => !referenceFolderOf(d, refs) && !refs.some((r) => referenceFolderOf(r, [d])))
}

/** Most parent folders folderTrustPaths climbs looking for a `.git` entry. */
const REPO_ROOT_CLIMB_MAX = 40

/** The nearest ancestor of `start` (itself included) holding a `.git` entry, by lstat only; undefined for a network path or none. */
function nearestGitRoot(start: string): string | undefined {
  if (!start || isNetworkPath(start)) return undefined
  let dir = start
  for (let i = 0; i < REPO_ROOT_CLIMB_MAX; i++) {
    try {
      lstatSync(join(dir, '.git'))
      return dir
    } catch {
      // not here
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
  return undefined
}

/**
 * The folders Codex's project-layer lookup may use for this run: the project path, its real (canonicalDeep) spelling
 * when different, and for 'untrusted' also the nearest ancestor holding a `.git` entry (Codex also looks the repo root up).
 * An empty project path gives none. Never touches the file system for a network path.
 */
export function folderTrustPaths(projectPath: string, level: 'untrusted' | 'trusted'): string[] {
  if (!projectPath) return []
  const out = new Set<string>([projectPath])
  let real = projectPath
  try {
    real = canonicalDeep(projectPath)
  } catch {
    // keep the lexical spelling only
  }
  out.add(real)
  if (level === 'untrusted') {
    const root = nearestGitRoot(projectPath)
    if (root) out.add(root)
    const realRoot = real !== projectPath ? nearestGitRoot(real) : undefined
    if (realRoot) out.add(realRoot)
  }
  return [...out]
}

/**
 * Codex project trust to pin for a run (see folderTrustEntry for how the config form was checked). 'untrusted' for a
 * trust-restricted run, an engagement, or when ctx.folderConfigLoads() is false; 'trusted' only when the project's
 * stored trust is 'trusted' and ctx.folderConfigLoads() is true (the user accepted it; Codex then writes nothing to the
 * shared CODEX_HOME); otherwise undefined (no gate: today's behaviour). A run with no folder path (setup-like
 * assistants on virtual projects) pins nothing. Read when a launch config is built, never per tool call.
 */
export function codexFolderTrust(ctx: Pick<RuntimeContext, 'run' | 'project' | 'folderConfigLoads'>): FolderTrustConfig | undefined {
  const loads = ctx.folderConfigLoads?.()
  const level: 'untrusted' | 'trusted' | undefined =
    isTrustRestrictedRun(ctx.run) || projectKindOf(ctx.project) === 'engagement' || loads === false
      ? 'untrusted'
      : ctx.project.folderConfigTrust?.state === 'trusted' && loads === true
        ? 'trusted'
        : undefined
  if (!level) return undefined
  const paths = folderTrustPaths(ctx.project.path, level)
  return paths.length ? { level, paths } : undefined
}

/** Launch options for the trust pin: the entry itself, and no AGENTS.md whenever the level is 'untrusted'. */
function trustLaunchOpts(ctx: RuntimeContext): { folderTrust?: FolderTrustConfig; noProjectDocs: boolean } {
  const folderTrust = codexFolderTrust(ctx)
  return { ...(folderTrust ? { folderTrust } : {}), noProjectDocs: isTrustRestrictedRun(ctx.run) || folderTrust?.level === 'untrusted' }
}

const PROTECTED_SEGMENTS =new Set(['.git', '.codex', '.agents', '.claude'])
/** True when a path has a .git, .codex, .agents or .claude segment (case-insensitive, either separator). */
export function hasProtectedSegment(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => PROTECTED_SEGMENTS.has(seg.toLowerCase()))
}

/**
 * True when a folder is still offerable by its real path (canonicalDeep; reviewer-3 M3): a link or an alternate
 * spelling that resolves into ~/.ssh or OrgAI's data folder is refused. A path that cannot be resolved is refused.
 */
export function offerableByRealPath(dir: string, opts: Parameters<typeof isOfferableDirectory>[1]): boolean {
  try {
    return isOfferableDirectory(canonicalDeep(dir), opts)
  } catch {
    return false
  }
}
import { tmpdir } from 'node:os'
import { scrubControlEnv } from './childEnv'
import { SELF_CONTROL_PATHS_UNAVAILABLE_LOG, SELF_CONTROL_REFUSAL_TEXT, checkSelfControlDenial, readControlProtectedPaths, selfControlLogLine } from './selfControlGate'
import type { ResolvedMcpServer } from './types'

/**
 * MCP servers without OrgAI's control variables in their env (cli-spec 3.4(3)): plain values go into the `-c
 * mcp_servers.<name>.env` config, which the app-server env scrub never sees.
 */
function withoutControlEnv(servers: ResolvedMcpServer[]): ResolvedMcpServer[] {
  return servers.map((s) => ({ ...s, env: scrubControlEnv(s.env ?? {}) }))
}

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
  /** The app-server's last stderr lines, secrets redacted, for exit errors. Optional for test fakes. */
  stderrTail?(): string
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

/**
 * A model id for Codex from a role's model: undefined for 'inherit', tier names, bare Claude aliases and any id that
 * fails validModelId (it would reach the app-server's thread params; a hand-edited project could hold '--flag').
 */
export function codexModelFor(model: string | undefined): string | undefined {
  const m = typeof model === 'string' ? model.trim() : undefined
  if (!m || m === 'inherit' || isModelTier(m.toLowerCase()) || CLAUDE_ALIASES.has(m.toLowerCase())) return undefined
  return validModelId(m) ? m : undefined
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
  /** A session (or project) grant of a setMode acceptEdits suggestion: edits inside free folders need no card. */
  private sessionAcceptEdits = false
  /** The reference-folder policy downgrade warning was logged (once per run). */
  private warnedReferencePolicy = false
  /** Folders granted through an addDirectories suggestion for this session (also free for `cd` and edits). */
  private sessionDirs: string[] = []
  private limited = false
  private ending = false
  private ended = false
  private launch: LaunchConfig = { config: [], env: {}, summary: [], skipped: [] }
  private mcpRestartPending = false
  /** Root turn ends so far (completed, failed and interrupted): RootTurnEnd.turnGen. */
  private rootTurnGen = 0
  /** thread/start or thread/resume requests in flight. */
  private threadStarts = 0
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
    this.isolation = !this.setupLike && isolateWritersOn(ctx.project) && isGitRepo(ctx.project.path)
    // Explicit project limits win; otherwise derived from the roles this run actually has (effectiveSubagentLimits).
    const limits = effectiveSubagentLimits({ ...ctx.project, roles: ctx.roles })
    this.net = new CodexAgentNetwork({ roles: ctx.roles, root, maxDepth: limits.depth, maxConcurrent: limits.concurrency })
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
      addMcpServer: (spec) => this.addMcpServer(spec),
      configChanged: (change) => this.configChanged(change)
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
      projectKind: projectKindOf(ctx.project),
      // Getters: RunManager's setLive re-clamp of ctx reaches the live driver.
      get autoContinue() {
        return ctx.autoContinue
      },
      get maxAutoContinues() {
        return ctx.maxAutoContinues
      },
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
      nudge: (text, activity, summary) => {
        this.notifyOrchestrator(text, activity, { summary })
        this.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
      },
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_AGENT_ID, { kind: 'system', text }, { source: 'harness' }),
      onSettled: () => this.noteActivity('continuation')
    })
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.transcript(ROOT_AGENT_ID, userBlock(text, images))
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    // The transcript entry above is what the user typed; the knowledge block goes only to the model.
    const body = withUserMessageKnowledge(text, userMessageKnowledge(this.ctx, text, (m) => this.log('warn', m)))
    if (this.rootThreadId) await this.sendToThread(this.rootThreadId, body, images)
    else this.earlySends.push({ text: body, images })
  }

  async interrupt(): Promise<void> {
    // An interrupted turn waits for the user; no automatic continue until they reply.
    this.continuation.hold()
    await this.interruptAll()
  }

  /** A message from another run's orchestrator. RunManager writes the transcript block, so none is written here. */
  async receive(message: PeerMessage): Promise<void> {
    if (this.ending) return
    this.notifyOrchestrator(peerMessageText(message), 'Reading a message from another run…', { transcript: false })
  }

  /** Headless exec settlement view (cli-spec 6.2(2)). */
  settlement(): SessionSettlement {
    const root = this.agents.get(ROOT_AGENT_ID)
    const rootIdle =
      (!this.rootThreadId || !this.activeTurn.has(this.rootThreadId)) && (!root || root.state === 'idle' || root.state === 'done' || root.state === 'error')
    const quiescent =
      !this.mcpRestartPending && !this.restarting && this.queues.size === 0 && this.threadStarts === 0 && this.earlySends.length === 0 && !this.integrator.hasPendingWork()
    return {
      rootTurnGen: this.rootTurnGen,
      rootIdle,
      continuationSettled: this.continuation.isSettledForTurn(this.rootTurnGen),
      nudgeTurn1Sent: this.continuation.nudgeTurn1Sent,
      quiescent
    }
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

  /** Exec settlement: adapter-internal activity (a listener's throw never breaks the session). */
  private noteActivity(reason: ExecActivityReason): void {
    try {
      this.ctx.noteActivity?.(reason)
    } catch {
      /* ignore */
    }
  }

  private transcript(agentId: string, block: TranscriptBlock, opts?: { source?: 'harness' }): void {
    this.emit({ type: 'transcript', runId: this.ctx.run.id, entry: { id: newId('t'), agentId, at: Date.now(), block, ...(opts?.source ? { source: opts.source } : {}) } })
  }

  /** Set once the "self-control gate skipped" line was logged for this run. */
  private selfControlSkipLogged = false

  /**
   * The pre-mode self-control gate (selfControlGate.ts, cli-spec 3.4(1)) for one approval request: true when it must
   * be declined (the orgai command, OrgAI's control files). On a hit it logs a warning and writes one harness row on
   * the calling agent. An empty or unreadable protected list declines every shell command (review M2: it cannot be
   * checked against the control files) and leaves file changes to the normal flow (logged once per run). Commands
   * Codex runs inside its own sandbox without an approval request never reach this gate: they are governed by Codex's
   * sandbox policy (policyFor in codexProtocol.ts), not by OrgAI.
   */
  private selfControlDenied(agentId: string, checks: ReadonlyArray<{ toolName: string; input: unknown; label?: string }>, cwd: string): boolean {
    const { paths: protectedPaths, unavailable } = readControlProtectedPaths(this.ctx.controlProtectedPaths?.bind(this.ctx))
    if (unavailable && !this.selfControlSkipLogged) {
      this.selfControlSkipLogged = true
      this.log('warn', SELF_CONTROL_PATHS_UNAVAILABLE_LOG)
    }
    const shell = process.platform === 'win32' ? 'powershell' : 'bash'
    const hit = checks.find((c) => checkSelfControlDenial(c.toolName, c.input, { protectedPaths, pathsUnavailable: unavailable, cwd, shell }))
    if (!hit) return false
    this.log('warn', selfControlLogLine(hit.label ?? hit.toolName, this.agents.get(agentId)?.name ?? agentId))
    this.transcript(agentId, { kind: 'system', text: SELF_CONTROL_REFUSAL_TEXT }, { source: 'harness' })
    return true
  }

  /**
   * LiteLLM only: the agent's cost from the thread's cumulative token totals at its model's /model/info price
   * (RunConnection.pricing). undefined = no estimate (other connections, no pricing, or an unpriced model), so the
   * cost stays 0 as on a ChatGPT plan.
   */
  private estimateCost(agent: AgentInstance, u: { input: number; output: number; cachedInput: number }): number | undefined {
    const conn = this.ctx.connection
    if (!conn || isBuiltinConnectionId(conn.connection) || !conn.pricing) return undefined
    const price = priceFor(conn.pricing, agent.model ?? this.agents.get(ROOT_AGENT_ID)?.model)
    return price ? costFromPrice(openAiMix(u.input, u.cachedInput, u.output), price) : undefined
  }

  private totalCost(): number {
    let usd = 0
    for (const a of this.agents.values()) usd += a.costUsd
    return usd
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent, ...(agent.usage ? { usage: structuredClone(agent.usage) } : {}) } })
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

  /**
   * Queue a harness message for the orchestrator; it starts a new turn if the orchestrator is idle. The transcript
   * row is a harness row (`summary` as its text and the full message in `detail` when a summary is given), except for
   * `agentMessage` deliveries: those carry another agent's words and stay unmarked, like Claude's native SendMessage.
   */
  private notifyOrchestrator(text: string, activity = 'Integrating a report…', opts: { transcript?: boolean; summary?: string; agentMessage?: boolean } = {}): void {
    if (opts.transcript !== false) {
      this.transcript(
        ROOT_AGENT_ID,
        { kind: 'system', text: opts.summary ?? text, ...(opts.summary ? { detail: text } : {}) },
        opts.agentMessage ? undefined : { source: 'harness' }
      )
    }
    const rootAgent = this.agents.get(ROOT_AGENT_ID)
    if (rootAgent && (rootAgent.state === 'idle' || rootAgent.state === 'done')) {
      this.setState(ROOT_AGENT_ID, 'thinking', activity)
      this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
    }
    if (!this.rootThreadId) {
      this.log('warn', 'A harness message for the orchestrator was dropped: the root thread does not exist yet.')
      return
    }
    void this.sendToThread(this.rootThreadId, text).catch((e) => this.log('warn', `Could not deliver a harness message to the orchestrator: ${(e as Error).message}`))
    this.noteActivity('message')
  }

  private async interruptAll(): Promise<void> {
    if (!this.server) return
    const pending = [...this.activeTurn].map(([threadId, turnId]) =>
      Promise.race([this.server.request(METHOD.turnInterrupt, { threadId, turnId }).catch((e: Error) => this.log('warn', `Interrupt failed: ${e.message}`)), new Promise((r) => setTimeout(r, 2000))])
    )
    await Promise.all(pending)
  }

  // ---------- start ----------

  /**
   * The thread policy for a role, derived from the project's mode read now (so the MCP restart re-derives it). With
   * reference folders (read live; an unreadable list counts as having some) bypass and auto are downgraded so writes
   * outside the workspace still reach onFileApproval (codexProtocol.ts policyFor); one run warning says so.
   */
  private policyFor(role: Role): PolicyChoice {
    const mode = this.ctx.project.permissionMode
    const base = { writes: canWrite(role), setupLike: this.setupLike, quick: !!this.ctx.run.quick, setupWrites: typeof this.ctx.run.buildWorkspace === 'string' }
    if (!this.hasReferenceFolders()) return policyFor(mode, base)
    const choice = policyFor(mode, { ...base, referenceFolders: true })
    const plain = policyFor(mode, base)
    if (!this.warnedReferencePolicy && (plain.sandbox !== choice.sandbox || plain.approvalsReviewer !== choice.approvalsReviewer)) {
      this.warnedReferencePolicy = true
      this.log('warn', plain.sandbox === 'danger-full-access' ? 'Reference folders keep this Codex run asking before writes outside the project.' : "Reference folders turn off Codex's auto reviewer for this run; OrgAI decides each approval.")
    }
    return choice
  }

  private hasReferenceFolders(): boolean {
    if (!this.ctx.referenceDirectories) return false
    try {
      return this.ctx.referenceDirectories().some((r) => typeof r === 'string' && r.length > 0)
    } catch {
      return true
    }
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
    const hasSkillTool = this.harness.some((t) => t.name === SKILL_HARNESS_TOOLS.load)
    const skills = hasSkillTool && !isSetup ? (this.ctx.skills?.() ?? []).filter((s) => s.roleIds.includes(role.id)).map((s) => ({ name: s.name, description: s.description })) : []
    // Engagements: the approved engagement document, read at prompt-build time (each new thread re-reads it).
    const engagementDocument = this.ctx.engagementDocument?.()
    // Constant for the run (RunManager computes it once), so every thread's instructions carry the same index.
    const knowledgeBrief = this.ctx.knowledgeBrief?.()
    const base = buildRolePrompt(role, this.ctx.roles, this.ctx.project, { isSetup, isolation: this.isolation, ...(this.ctx.run.quick ? { quick: this.ctx.run.quick } : {}), ...(this.ctx.run.team ? { team: this.ctx.run.team } : {}), ...(this.ctx.allowedDirectories?.().length ? { allowedDirectories: this.ctx.allowedDirectories() } : {}), ...(this.ctx.referenceDirectories?.().length ? { referenceDirectories: this.ctx.referenceDirectories() } : {}), ...(engagementDocument ? { engagementDocument } : {}), ...(knowledgeBrief ? { knowledgeBrief } : {}), ...(skills.length ? { skills, skillTool: 'load_skill' as const } : {}) })
    const { names } = this.toolsFor(role, isRoot)
    const notes = codexToolNotes(names, { renamedPlanTool: names.includes('orgai_update_plan') })
    const parts = [base]
    if (isSetup && isRoot && this.ctx.run.kind === 'setup') parts.push(SETUP_TOOLS_INSTRUCTIONS)
    if (notes) parts.push(notes)
    return parts.join('\n\n')
  }

  private threadParams(role: Role, isRoot: boolean, cwd: string, parentModel?: string): Record<string, unknown> {
    const policy = this.policyFor(role)
    const own = codexModelFor(role.model)
    if (!own && typeof role.model === 'string' && role.model.trim() && !validModelId(role.model.trim())) {
      this.log('warn', `Ignoring the invalid model of ${String(role.name).replace(/[^ -~]/g, "?").slice(0, 80)}; it uses the ${parentModel ? "parent's" : 'default'} model.`)
    }
    const model = own ?? (validModelId(parentModel) ? parentModel : undefined)
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
    this.threadStarts += 1
    try {
      return await this.startThreadNow(params, method)
    } finally {
      this.threadStarts -= 1
    }
  }

  private async startThreadNow(params: Record<string, unknown>, method: string): Promise<{ threadId: string; model?: string }> {
    let res: unknown
    // Codex discovers skills itself (repo .agents/skills, the user's and the admin folders); OrgAI hands out only the
    // granted ones through load_skill, so every thread's native skills are switched off first (best effort, warned).
    if (typeof params.cwd === 'string') {
      const lock = await lockNativeSkills((m, p) => this.server.request(m, p), params.cwd)
      if (lock.error || lock.failed || lock.skipped) {
        this.log('warn', `Codex native skills could not all be disabled (${lock.error ?? `${lock.failed} failed, ${lock.skipped} over the limit`}); the agent may see skills the role was not granted.`)
      }
    }
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
        const message = error?.message ?? codexExitMessage(code, server.stderrTail?.())
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
    if (ctx.resumeSessionId) this.transcript(ROOT_AGENT_ID, { kind: 'system', text: `Continued from run ${ctx.run.resumedFrom ?? ctx.resumeSessionId}` }, { source: 'harness' })
    this.transcript(ROOT_AGENT_ID, userBlock(ctx.prompt, ctx.images))

    try {
      let firstMessage = composeFirstMessage(ctx.prompt, firstMessageHiddenContext(ctx, (m) => this.log('warn', m)))
      if (this.isolation) {
        const leftover = await this.integrator.start()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      const servers = withoutControlEnv(ctx.resolvedMcpServers ? await ctx.resolvedMcpServers() : [])
      this.launch = buildLaunchConfig(ctx.connection, servers, { ...trustLaunchOpts(ctx), writableRoots: codexWritableRoots(ctx) })
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
          this.transcript(ROOT_AGENT_ID, { kind: 'system', text: 'The earlier Codex conversation could not be resumed; this run starts a new one.' }, { source: 'harness' })
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
        if (agent) countUsage(agent, 'toolCalls')
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
          setModelTokens(agent, agent.model ?? this.agents.get(ROOT_AGENT_ID)?.model ?? 'unknown', {
            input: Math.max(0, u.input - u.cachedInput),
            output: u.output,
            cacheRead: Math.min(u.cachedInput, u.input),
            cacheWrite: 0
          })
          const cost = this.estimateCost(agent, u)
          const moved = cost !== undefined && Math.abs(cost - agent.costUsd) > 1e-12
          if (moved) agent.costUsd = cost
          this.upsert(agent)
          if (moved) this.emit({ type: 'run.cost', runId: this.ctx.run.id, totalCostUsd: this.totalCost() })
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
        if (agent) countUsage(agent, 'turns')
        if (agentId === ROOT_AGENT_ID) this.rootTurnCompleted(u)
        else this.childTurnCompleted(agentId, u)
        void this.maybeRestartForMcp()
        return
      case 'error':
        this.log(u.willRetry ? 'info' : 'warn', `Codex: ${u.message}${u.willRetry ? ' (retrying)' : ''}`)
        if (u.willRetry && agent) {
          countUsage(agent, 'retries')
          this.upsert(agent)
        }
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
    // Exec settlement (cli-spec 6.2(2)): every root turn end is reported before 'idle', failed and interrupted ones included.
    this.rootTurnGen += 1
    const turnGen = this.rootTurnGen
    const end: RootTurnEnd =
      u.status === 'failed'
        ? { turnGen, ok: false, errorSubtype: 'failed', isAuthError: isAuthFailure({ text: u.error?.message ?? '', isError: true }) }
        : { turnGen, ok: true, ...(u.status === 'interrupted' ? { interrupted: true } : {}) }
    if (this.limited) end.limited = true
    try {
      this.ctx.onRootTurnEnded?.(end)
    } catch (e) {
      this.log('warn', `Root turn end listener failed: ${(e as Error)?.message ?? String(e)}`)
    }
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
    // Only a completed turn may be nudged; a failed or interrupted one is settled at once.
    if (u.status === 'completed') this.continuation.turnEnded(turnGen)
    else this.continuation.skipTurn(turnGen)
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
    this.noteActivity('report')
    if (u.status === 'completed') void this.integrator.onSubagentFinished(agentId)
    if (u.status === 'interrupted') return
    const text = reportMessage(child, u.status === 'failed' ? { status: 'failed', result: u.result, error: u.error?.message } : { status: 'completed', result: u.result })
    this.deliverTo(child.parentId ?? ROOT_AGENT_ID, text)
  }

  /**
   * Hand a message to an agent (the orchestrator gets the full notifyOrchestrator treatment). Harness-written
   * messages (report hand-offs) get a harness row; `agentMessage` deliveries (send_message) carry another
   * agent's words and stay unmarked.
   */
  private deliverTo(agentId: string, text: string, opts: { agentMessage?: boolean } = {}): Promise<void> {
    if (agentId === ROOT_AGENT_ID) {
      this.notifyOrchestrator(text, undefined, { agentMessage: opts.agentMessage })
      return Promise.resolve()
    }
    const threadId = this.agentThread.get(agentId)
    const target = this.agents.get(agentId)
    if (!threadId || !target) return Promise.reject(new Error(`${agentId} has no thread`))
    this.transcript(agentId, { kind: 'system', text }, opts.agentMessage ? undefined : { source: 'harness' })
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
      // The role id is passed only when the thread resolves to a role (or is the root): skills never fall back to the root's.
      const resolved = agentId === ROOT_AGENT_ID ? this.root : this.net.roleOf(agentId)
      // knowledge_recall dedupes per agent, so a thread OrgAI never bound reads as unknown (no agentId), not as the root.
      const unknownCaller = tool.name === KNOWLEDGE_RECALL_TOOL && !this.threads.has(call.threadId)
      const text = await tool.call(call.arguments, unknownCaller ? {} : resolved ? { agentId, roleId: resolved.id } : { agentId })
      return toolResponse(text, true)
    } catch (e) {
      return toolResponse(`${tool.name} failed: ${(e as Error).message}`, false)
    } finally {
      const a = this.agents.get(agentId)
      if (a && a.state === 'waiting') this.setState(agentId, 'thinking', 'Thinking…')
    }
  }

  /**
   * matchOptionsFor(ctx) now, or null when a folder list (allowed, reference, protected) cannot be read (review L1):
   * callers then ask with no rule allow and no suggestions, and an allow accepts that one call.
   */
  private safeMatchOptions(): MatchOptions | null {
    try {
      return matchOptionsFor(this.ctx)
    } catch (e) {
      this.log('warn', `Could not read the run's folders, so this needs your approval: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * MatchOptions right now (null: see safeMatchOptions): the project, the allowed folders (live) and the folders granted for this session. On
   * win32 Codex runs commands through PowerShell, so MSYS `/c/...` cd targets are never free (review re-check L7).
   */
  private matchOpts(cwd?: string): MatchOptions | null {
    const base = this.safeMatchOptions()
    if (!base) return null
    return {
      ...base,
      ...(cwd && isAbsolute(cwd) ? { cwd, effectiveCwd: cwd } : {}),
      freeDirs: [...(base.freeDirs ?? []), ...this.sessionDirs],
      ...(process.platform === 'win32' ? { shell: 'powershell' as const } : {})
    }
  }

  /**
   * Free to edit without a card: every path is concrete, has no protected segment, and sits in a free dir lexically
   * and by real path. Only MatchOptions.freeDirs count (reference folders live in readOnlyDirs); as a defence in case
   * the lists ever overlap, a path under a reference folder (read live; an unreadable list frees nothing) is never free.
   */
  private editPathsFree(paths: readonly string[]): boolean {
    if (!paths.length) return false
    // Read the reference list first: matchOptionsFor reads it too, unguarded.
    let refs: string[] = []
    if (this.ctx.referenceDirectories) {
      try {
        refs = this.ctx.referenceDirectories().filter((r) => typeof r === 'string' && r.length > 0)
      } catch {
        return false
      }
    }
    const opts = this.matchOpts()
    if (!opts) return false
    return paths.every((p) => {
      if (typeof p !== 'string' || !p || !isAbsolute(p) || hasProtectedSegment(p)) return false
      if (refs.length && referenceFolderOf(p, refs, this.ctx.project.path)) return false
      if (!isFreeCdTarget(dirname(p), opts)) return false
      let real: string
      try {
        real = canonicalDeep(p)
      } catch {
        return false
      }
      return (opts.freeDirs ?? []).some((d) => typeof d === 'string' && isAbsolute(d) && isInsideEither(d, real))
    })
  }

  /**
   * Saved rules when ctx.allowedRules is absent: ctx.savedRules() (wherever the project keeps them), else the project
   * folder's file; none on a trust-restricted run.
   */
  private savedRules(): string[] {
    if (isTrustRestrictedRun(this.ctx.run)) return []
    return this.ctx.savedRules ? this.ctx.savedRules() : listRules(this.ctx.project.path)
  }

  /**
   * A card for one call. `referenceFolder` (a command touching a reference folder, or null when the list could not be
   * read): no suggestions, the folder on the request, and an allow grants this call only (never a rule or a scope).
   */
  private async ask(agentId: string, toolName: 'Bash' | 'Edit', input: Record<string, unknown>, cwd?: string, referenceFolder?: string | null) {
    const summary = describePermission(toolName, input)
    this.setState(agentId, 'waiting', `Needs approval: ${summary}`)
    const restricted = isTrustRestrictedRun(this.ctx.run)
    const touching = referenceFolder !== undefined
    // Unreadable folder lists (null) ask like a touching call: no suggestions, and an allow accepts this call only.
    const callOpts = touching ? undefined : (this.matchOpts(cwd) ?? undefined)
    const chosen = callOpts ? chooseSuggestions(toolName, input, undefined, false, callOpts) : []
    // A restricted run never turns on accept-edits: its folder is not the user's project.
    const suggestions = restricted ? chosen.filter((s) => s.type !== 'setMode') : chosen
    try {
      const decision = await this.ctx.requestPermission({
        agentId,
        toolName,
        input,
        summary,
        ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {}),
        ...(referenceFolder ? { referenceFolder } : {})
      })
      let granted = false
      if (decision.behavior === 'allow' && callOpts) {
        // Never write rules into an untrusted folder: a 'project' grant becomes a run grant (RunManager downgrades first).
        const safe = isTrustRestrictedRun(this.ctx.run) && decision.scope === 'project' ? { ...decision, scope: 'session' as const } : decision
        const persist = {
          ...(this.ctx.allowDirectories ? { allowDirectories: this.ctx.allowDirectories.bind(this.ctx) } : {}),
          ...(this.ctx.acceptEditsForProject ? { acceptEditsForProject: this.ctx.acceptEditsForProject.bind(this.ctx) } : {}),
          // Where the project keeps its rules (OrgAI's data folder for engagements); absent = the folder's file.
          ...(this.ctx.saveProjectRules ? { saveProjectRules: this.ctx.saveProjectRules.bind(this.ctx) } : {})
        }
        const scoped = applyAllowScope(this.ctx.project.path, safe, suggestions, (level, message) => this.log(level, message), persist, { toolName, input, opts: callOpts })
        if (scoped) {
          granted = true
          this.sessionRules.push(...allowRuleStrings(scoped))
          const offer = this.safeMatchOptions()
          for (const s of scoped) {
            if (s.type === 'setMode' && s.mode === 'acceptEdits' && !restricted) this.sessionAcceptEdits = true
            if (s.type === 'addDirectories' && offer) {
              // Checked as written and by real path (reviewer-3 M3: a link or another case spelling of ~/.ssh).
              for (const d of s.directories) if (typeof d === 'string' && d && !this.sessionDirs.includes(d) && isOfferableDirectory(d, offer) && offerableByRealPath(d, offer)) this.sessionDirs.push(d)
            }
          }
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
    // Self-control gate first (cli-spec 3.4(1)): declined without a card before the policy, reference checks and rules.
    const selfCwd = typeof req.cwd === 'string' && req.cwd && isAbsolute(req.cwd) ? req.cwd : this.ctx.project.path
    if (this.selfControlDenied(agentId, [{ toolName: process.platform === 'win32' ? 'PowerShell' : 'Bash', input: { command: req.command } }], selfCwd)) {
      return { decision: 'decline' }
    }
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) {
      this.log('info', `Declined a command in ${this.ctx.project.permissionMode} mode: ${req.command.slice(0, 120)}`)
      return { decision: 'decline' }
    }
    const input = { command: req.command, ...(req.cwd ? { cwd: req.cwd } : {}), ...(req.reason ? { reason: req.reason } : {}) }
    // Reference folders (H1): a command that runs inside one (req.cwd) or names a path at, under or above one is never
    // accepted by a rule; it is asked with the folder named and no suggestions, and an allow accepts this command only.
    // An unreadable list asks the same way (no folder named).
    const touch = this.referenceTouchOfCommand(req.command, req.cwd)
    if (touch) {
      this.log('info', `Asking about a command by ${this.agents.get(agentId)?.name ?? agentId}: ${touch.folder ? referenceCommandMessage(touch.folder, touch.how ?? 'names') : 'the reference folders could not be read'}`)
      const { decision } = await this.ask(agentId, 'Bash', input, req.cwd, touch.folder)
      return { decision: decision.behavior === 'allow' ? 'accept' : 'decline' }
    }
    // Saved rules plus anything granted while the run is live (request_permission_rules, the rules panel).
    const rules = [...(this.ctx.allowedRules?.() ?? this.savedRules()), ...this.sessionRules]
    const opts = this.matchOpts(req.cwd)
    if (!opts) {
      // The folder lists could not be read (review L1): asked like an unreadable reference list, this command only.
      const { decision } = await this.ask(agentId, 'Bash', input, req.cwd, null)
      return { decision: decision.behavior === 'allow' ? 'accept' : 'decline' }
    }
    if (req.command && matchesBashRule(req.command, rules, opts)) return { decision: 'accept' }
    const { decision, granted } = await this.ask(agentId, 'Bash', input, req.cwd)
    if (decision.behavior === 'deny') return { decision: 'decline' }
    return { decision: this.sessionDecision(granted) }
  }

  /**
   * The approval answer for an allowed card. 'acceptForSession' only when the run has no reference folders (read live;
   * an unreadable list counts as having some): Codex would otherwise reuse its cached approval for a later call whose
   * cwd or paths sit inside a reference folder, without asking OrgAI (review M4). With reference folders the grant is
   * kept only in this session's own rules (sessionRules, matched by OrgAI per call after the reference check).
   */
  private sessionDecision(granted: boolean): 'accept' | 'acceptForSession' {
    return granted && !this.hasReferenceFolders() ? 'acceptForSession' : 'accept'
  }

  /**
   * The reference folder a command approval touches (commandReferenceTouch from req.cwd, else the project folder; the
   * shell is PowerShell on win32), `{ folder: null }` when the list cannot be read, null when none.
   */
  private referenceTouchOfCommand(command: string, cwd: string | undefined): { folder: string | null; how?: 'names' | 'runs-in' } | null {
    if (!this.ctx.referenceDirectories) return null
    let refs: string[]
    try {
      refs = this.ctx.referenceDirectories().filter((r) => typeof r === 'string' && r.length > 0)
    } catch (e) {
      this.log('warn', `Could not read the run's reference folders: ${(e as Error).message}`)
      return { folder: null }
    }
    if (!refs.length || typeof command !== 'string') return null
    const from = typeof cwd === 'string' && cwd && isAbsolute(cwd) ? cwd : this.ctx.project.path
    return commandReferenceTouch(command, from, refs, { shell: process.platform === 'win32' ? 'powershell' : 'bash' })
  }

  /**
   * Why a file-change approval must be declined because of a reference folder, or null. Only when the run has
   * reference folders (read live): a changed path under one, a grantRoot under one or containing one, a change with no
   * usable path, or a request naming neither changes nor a grantRoot (fails closed). Relative paths resolve against
   * the agent's worktree, else the project folder.
   */
  private referenceChangeDenial(
    agentId: string,
    changes: ReadonlyArray<{ path: string }>,
    grantRoot: string | undefined
  ): { reason: string; entry: { text: string; detail: string } } | null {
    if (!this.ctx.referenceDirectories) return null
    let refs: string[]
    try {
      refs = this.ctx.referenceDirectories().filter((r) => typeof r === 'string' && r.length > 0)
    } catch (e) {
      this.log('warn', `Could not read the run's reference folders: ${(e as Error).message}`)
      return { reason: 'OrgAI could not check the reference folders, so this change was declined.', entry: referenceRefusalEntry(undefined, 'a reference folder') }
    }
    if (!refs.length) return null
    const cwd = this.integrator.worktreeOf(agentId)?.path ?? this.ctx.project.path
    const unnamed = { reason: `${referenceFolderMessage(refs[0]!)}; this change names no file path, so it was declined`, entry: referenceRefusalEntry(undefined, refs[0]!) }
    if (!changes.length && !grantRoot) return unnamed
    for (const c of changes) {
      if (typeof c.path !== 'string' || !c.path) return unnamed
      const hit = referenceFolderOf(c.path, refs, cwd)
      if (hit) return { reason: referenceFolderMessage(hit), entry: referenceRefusalEntry(c.path, hit) }
    }
    if (grantRoot) {
      const hit = referenceFolderOf(grantRoot, refs, cwd) ?? refs.find((r) => referenceFolderOf(r, [isAbsolute(grantRoot) ? grantRoot : join(cwd, grantRoot)]))
      if (hit) return { reason: referenceFolderMessage(hit), entry: referenceRefusalEntry(grantRoot, hit) }
    }
    return null
  }

  private async onFileApproval(params: unknown): Promise<unknown> {
    const req = parseFileApproval(params)
    if (!req) return { decision: 'decline' }
    const agentId = this.agentOf(req.threadId)
    const item = this.mapper.item(req.itemId)
    const changes = item ? fileChanges(item) : []
    // Self-control gate first (cli-spec 3.4(1)): every changed path and the grantRoot as edit targets, declined without
    // a card. A change with no usable path is left to the checks below.
    const selfChecks = [...changes.map((c) => c.path), ...(req.grantRoot ? [req.grantRoot] : [])]
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => ({ toolName: 'Edit', input: { file_path: p } }))
    if (selfChecks.length && this.selfControlDenied(agentId, selfChecks, this.integrator.worktreeOf(agentId)?.path ?? this.ctx.project.path)) {
      return { decision: 'decline' }
    }
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) return { decision: 'decline' }
    // Reference folders are read-only: declined without a card, before the accept-edits auto-accept and any rule.
    const refDenial = this.referenceChangeDenial(agentId, changes, req.grantRoot)
    if (refDenial) {
      // One harness row on the calling agent: "Refused: <file> is in a reference folder (read only)" (H2). The decline
      // itself carries no text to the agent (the approval answer is a bare decision).
      this.log('warn', `Declined a file change by ${this.agents.get(agentId)?.name ?? agentId}: ${refDenial.reason}`)
      this.transcript(agentId, { kind: 'system', ...refDenial.entry }, { source: 'harness' })
      return { decision: 'decline' }
    }
    const buildWorkspace = this.ctx.run.buildWorkspace
    if (buildWorkspace && (changes.length ? changes.some((c) => isWorkspaceConfigPath(buildWorkspace, c.path)) : req.grantRoot ? isWorkspaceConfigPath(buildWorkspace, req.grantRoot) : false)) {
      this.log('warn', 'Declined a change under .claude/ in the build workspace.')
      this.transcript(agentId, { kind: 'system', text: 'Build sessions cannot write settings under .claude/ in the workspace.' }, { source: 'harness' })
      return { decision: 'decline' }
    }
    const saved = this.ctx.allowedRules?.() ?? this.savedRules()
    const paths = changes.map((c) => c.path)
    // Settings, hooks and VCS folders are never accepted silently, whatever rule or mode is in force.
    // Lexical and real path both (a link inside the project can name a protected folder elsewhere).
    const protectedPath = (p: string): boolean => {
      if (hasProtectedSegment(p)) return true
      try {
        return hasProtectedSegment(canonicalDeep(p))
      } catch {
        return true
      }
    }
    const touchesProtected = paths.some(protectedPath) || (req.grantRoot ? protectedPath(req.grantRoot) : false)
    // A saved bare Edit / Write rule (legacy files) covers concrete changed files only, never a grantRoot request
    // (write access to a whole folder, possibly / or home: review re-check Medium).
    if (!touchesProtected && paths.length > 0 && [...saved, ...this.sessionRules].some((r) => r === 'Edit' || r === 'Write')) return { decision: 'accept' }
    // Accept edits (the project's mode, read now: RunManager refreshes ctx.project, or the thread's policy) or a
    // session grant of it: concrete changed files inside the project, an allowed folder or a granted folder, by lexical
    // and real path, need no card. A grantRoot alone, or anything outside, asks.
    const mode = this.ctx.project.permissionMode
    const restricted = isTrustRestrictedRun(this.ctx.run)
    if (policy?.autoAcceptEdits || mode === 'acceptEdits' || mode === 'auto' || (this.sessionAcceptEdits && !restricted)) {
      if (!touchesProtected && this.editPathsFree(paths)) return { decision: 'accept' }
    }
    const input: Record<string, unknown> = {
      file_path: changes[0]?.path ?? req.grantRoot ?? '',
      ...(changes.length ? { changes } : {}),
      ...(req.reason ? { reason: req.reason } : {}),
      ...(req.grantRoot ? { grantRoot: req.grantRoot } : {})
    }
    const { decision, granted } = await this.ask(agentId, 'Edit', input)
    if (decision.behavior === 'deny') return { decision: 'decline' }
    return { decision: this.sessionDecision(granted) }
  }

  private async onPermissionsApproval(params: unknown): Promise<unknown> {
    const req = parsePermissionsApproval(params)
    if (!req) return { permissions: {}, scope: 'turn' }
    const agentId = this.agentOf(req.threadId)
    const policy = this.threads.get(req.threadId)?.policy
    if (policy?.denyApprovals) return { permissions: {}, scope: 'turn' }
    // Self-control gate (cli-spec 3.4(1)): a requested folder at, under or above OrgAI's control files (the data dir,
    // home...) would let Codex read or write them inside its own sandbox with no further approval. Declined without a
    // card; the search-root rule (Grep: at, under or an ancestor) is the one that fits a granted root.
    const paths = requestedPaths(req.requested)
    const cwd = this.integrator.worktreeOf(agentId)?.path ?? this.ctx.project.path
    if (paths.length && this.selfControlDenied(agentId, paths.map((path) => ({ toolName: 'Grep', input: { pattern: '.', path }, label: 'extra permissions' })), cwd)) {
      return { permissions: {}, scope: 'turn' }
    }
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
    deliver: (toAgentId, text) => this.deliverTo(toAgentId, text, { agentMessage: true }),
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
      this.noteActivity('subagent')
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
      // After newAgent, so the "Added N known items" row lands on the report; the block stays out of its transcript entry.
      const knownItems = spawnKnowledge(this.ctx, req.brief, req.id, (m) => this.log('warn', m))
      await this.sendToThread(started.threadId, childFirstMessage(parentLabel, withSpawnKnowledge(req.brief, knownItems)), undefined, effort)
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
   * told the server is connected. Returns the prefix with availability 'after-idle': the tools appear after the restart, never now.
   */
  private async addMcpServer(spec: McpServerSpec): Promise<McpAttachResult> {
    if (!this.ctx.resolvedMcpServers) throw new Error('This run cannot attach MCP servers; the server is available from the next run.')
    this.mcpRestartPending = true
    this.pendingMcpPrefixes.push(mcpToolPrefix(spec.name))
    this.log('info', `MCP server ${spec.name} will be attached when the agents are idle (Codex reads MCP servers at start-up).`)
    void this.maybeRestartForMcp()
    return { prefix: mcpToolPrefix(spec.name), availability: 'after-idle' }
  }

  /**
   * An approved propose_mcp_servers / propose_skills changed the run's own project and RunManager already updated
   * ctx.mcpServers() / resolvedMcpServers() / skills(). An MCP change marks the same restart-at-idle pending as
   * addMcpServer (the restart rebuilds the launch config from the live list, so a removed or disabled server is simply
   * not in it) and answers 'after-idle'. A skills-only change is 'now': list_skills / load_skill read ctx.skills() at
   * call time. Codex's native skill lock is not redone here: a newly linked skill is not re-locked natively, which
   * only matters for native skills, and those stay locked.
   */
  private async configChanged(change: ConfigChange): Promise<ConfigChangeResult> {
    if (!change.mcp) return { availability: 'now' }
    if (!this.ctx.resolvedMcpServers) throw new Error('This run cannot attach MCP servers; the change applies from the next run.')
    const live = new Set((this.ctx.mcpServers?.() ?? []).map((s) => s.name))
    for (const name of change.mcp.upserted) {
      const prefix = mcpToolPrefix(name)
      if (live.has(name) && !this.pendingMcpPrefixes.includes(prefix)) this.pendingMcpPrefixes.push(prefix)
    }
    this.mcpRestartPending = true
    this.log('info', 'The MCP configuration changed; Codex is restarted to apply it when the agents are idle.')
    void this.maybeRestartForMcp()
    return { availability: 'after-idle' }
  }

  private async maybeRestartForMcp(): Promise<void> {
    if (!this.mcpRestartPending || this.restarting || this.ending || this.activeTurn.size > 0) return
    this.restarting = true
    this.mcpRestartPending = false
    this.noteActivity('restart')
    try {
      const servers = withoutControlEnv(await this.ctx.resolvedMcpServers!())
      const launch = buildLaunchConfig(this.ctx.connection, servers, {
        ...trustLaunchOpts(this.ctx),
        writableRoots: codexWritableRoots(this.ctx)
      })
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
        // threadParams re-derives the policy (mode and reference folders read now); the thread keeps the new one.
        const { dynamicTools: _t, serviceName: _s, ...resume } = this.threadParams(role, info.agentId === ROOT_AGENT_ID, wt?.path ?? this.ctx.project.path)
        void _t
        void _s
        info.policy = this.policyFor(role)
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
      this.notifyOrchestrator(
        prefixes.length
          ? `Harness: the MCP server${prefixes.length === 1 ? '' : 's'} you requested ${prefixes.length === 1 ? 'is' : 'are'} connected now. Tool names start with ${prefixes.join(' and ')}. Calls may still ask the user for permission.`
          : 'Harness: the MCP configuration change is in place now. Tools of servers that were disabled or removed are gone.',
        'Using a new MCP server…'
      )
    } catch (e) {
      this.restarting = false
      this.fail(`Could not restart Codex to attach the MCP server: ${(e as Error).message}`)
      return
    }
    this.restarting = false
    this.noteActivity('restart')
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
    const connection = input.connection ?? (await this.options.completionConnection?.())
    // One-shot completions never run in the project folder: its AGENTS.md must not reach the model (project docs off,
    // empty temp dir as cwd). Nothing in a tool-less read-only thread needs the folder.
    const launch = buildLaunchConfig(connection, [], { noProjectDocs: true })
    const scratchCwd = tmpdir()
    const options: CodexAppServerOptions = { cwd: scratchCwd, env: launch.env, config: launch.config }
    const server: CodexServerLike = this.options.createServer ? this.options.createServer(options) : new CodexAppServer(options)
    let text = ''
    let final = ''
    let failure: string | undefined
    let tokens: { input: number; output: number; cachedInput: number } | undefined
    let done!: () => void
    const completed = new Promise<void>((resolve) => (done = resolve))
    const mapper = new CodexEventMapper()
    server.onNotification((method, params) => {
      for (const u of mapper.handle(method, params)) {
        // thread/tokenUsage/updated carries the thread's running total; the last one is the completion's spend.
        if (u.type === 'tokens') tokens = { input: u.input, output: u.output, cachedInput: u.cachedInput }
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
      failure ??= error?.message ?? codexExitMessage(code, server.stderrTail?.())
      done()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    // The caller gave up (run-title timeout, run stopped): end the turn wait, kill the app-server at once so pending
    // requests reject, and settle whichever step is awaited (start, thread/start, turn/start) even if one hangs.
    let cancel!: (e: Error) => void
    const cancelled = new Promise<never>((_, reject) => (cancel = reject))
    cancelled.catch(() => {})
    const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, cancelled])
    const onAbort = (): void => {
      failure ??= 'the completion was cancelled'
      done()
      cancel(new Error('Completion cancelled'))
      server.close()
    }
    if (input.signal?.aborted) throw new Error('Completion cancelled')
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await step(server.start(this.options.clientVersion))
      if (input.signal?.aborted) throw new Error('Completion cancelled')
      const model = codexModelFor(input.model)
      const res = await step(server.request(METHOD.threadStart, {
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: input.system,
        cwd: scratchCwd,
        ...(model ? { model } : {}),
        serviceName: ORGAI_SERVICE
      }))
      const thread = parseThreadResult(res)
      if (!thread) throw new Error('thread/start returned no thread id')
      await step(server.request(METHOD.turnStart, { threadId: thread.threadId, input: userInput(input.prompt) }))
      await Promise.race([completed, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('Completion timed out')), this.options.completionTimeoutMs ?? 180_000)))])
      if (failure) throw new Error(`Completion failed: ${failure}`)
      if (tokens && input.onUsage) {
        // Codex's input count includes cached tokens (same split as a run's agents).
        try {
          input.onUsage({
            tokens: { input: Math.max(0, tokens.input - tokens.cachedInput), output: tokens.output, cacheRead: Math.min(tokens.cachedInput, tokens.input), cacheWrite: 0 },
            ...(model ? { model } : {})
          })
        } catch {
          // A reporting failure never fails the completion.
        }
      }
      return final || text
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      server.close()
    }
  }
}

/**
 * The path-looking strings anywhere in a Codex permissions request (absolute, `~`), at most 64 of them and 8 levels
 * deep: the folders a granted profile would open (writable or readable roots).
 */
export function requestedPaths(requested: unknown): string[] {
  const out: string[] = []
  const visit = (v: unknown, depth: number): void => {
    if (out.length >= 64 || depth > 8) return
    if (typeof v === 'string') {
      if (/^(?:\/|~(?:$|[\\/])|[a-zA-Z]:[\\/]|\\\\)/.test(v)) out.push(v)
      return
    }
    if (Array.isArray(v)) for (const x of v) visit(x, depth + 1)
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1)
  }
  visit(requested, 0)
  return out
}
