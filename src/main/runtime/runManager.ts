import { mkdirSync, realpathSync } from 'node:fs'
import type {
  AdapterChoice,
  ImageAttachment,
  McpInstallDecision,
  McpInstallOutcome,
  McpInstallRequest,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerSpec,
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRequest,
  PermissionRuleDecision,
  PermissionRuleRequest,
  Project,
  Proposal,
  ProposalDecision,
  ProviderId,
  ProviderModel,
  QuestionAnswer,
  Role,
  RunEvent,
  RunKind,
  RunPeer,
  RunPlan,
  RunRecord,
  RunSummary,
  UserQuestion
} from '@shared/types'
import { adapterForProject, mcpSecretNames, modelFamily, newId } from '@shared/defaults'
import { DEFAULT_MAX_AUTO_CONTINUES, RUN_MESSAGE_MAX_CHARS, RUN_PEER_PROMPT_CHARS } from '@shared/types'
import { architectRole, mcpAssistantRole } from '@shared/setup'
import { ROOT_AGENT_ID, isSetupLikeRun, type ResolvedMcpServer, type RunMessageResult, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { log, logPermission, logRunEvent } from '../log'
import { hasContent, sanitizeImages } from './attachments'
import { breakParentCycles } from './agentTree'
import { describePlanChange } from './continuation'
import { addRules, isUnsafeAllowRule, listRules } from './permissionRules'
import { isValidRule } from './ruleMatch'
import { validateSpec } from '../mcp/validate'
import { assistContext } from '../mcp/assist'

/** The path as the file system spells it (true case on Windows). Falls back to the input when it cannot be resolved. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

const FLUSH_INTERVAL_MS = 1500
/** When a usage limit gives no reset time, try again after this long. */
export const DEFAULT_PAUSE_MS = 5 * 60 * 1000
/** Sent to the orchestrator when a paused run continues. */
export const RESUME_TEXT =
  'The usage window has reset. Continue exactly where you left off; the harness has reconciled any report branches left in progress.'

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly'
}

/** The pause reason shown to the user. */
export function pauseReasonText(window: string | undefined, error?: string): string {
  const label = window ? `${WINDOW_LABELS[window] ?? window.replace(/_/g, ' ')} usage limit` : 'subscription usage limit'
  return (
    `The ${label} was reached${error ? ` (${error.slice(0, 120)})` : ''}, so the session ended. ` +
    'Reports still working were cut off; any worktrees they left are committed by the continued run, which tells the orchestrator what is pending.'
  )
}

interface ActiveRun {
  summary: RunSummary
  session?: RuntimeSession
  pending: Map<string, (d: PermissionDecision) => void>
  pendingProposals: Map<string, (d: ProposalDecision) => void>
  pendingQuestions: Map<string, { question: UserQuestion; resolve: (a: QuestionAnswer) => void }>
  pendingMerges: Map<string, (d: MergeDecision) => void>
  /** request_mcp_install cards waiting for mcp:answerInstall. */
  pendingInstalls: Map<string, { request: McpInstallRequest; resolve: (d: McpInstallDecision) => void }>
  /** request_permission_rules cards waiting for permissions:decideRequest. */
  pendingRules: Map<string, { request: PermissionRuleRequest; resolve: (d: PermissionRuleDecision) => void }>
  /** Rules granted for this run only (scope 'run'); project grants go to the settings file. */
  runRules: string[]
  /** The project's (canonical) path, for saving project-scoped grants. */
  projectPath: string
  /** Servers approved with scope 'run': kept in memory (secret values included) until the run ends. */
  runServers: Map<string, { spec: McpServerSpec; secrets: Record<string, string> }>
  /** Everything needed to redraw the run later; flushed to disk on a timer and at the end. */
  record: RunRecord
  flushTimer?: ReturnType<typeof setTimeout>
  /** Set when the provider reported a usage-limit rejection; the run pauses instead of ending. */
  limited?: { until?: number; window?: string }
  /** The user ended the session; never pause it. */
  userStopped?: boolean
  /** The provider session this run resumes; known before the adapter reports summary.sessionId at init. */
  resumeSessionId?: string
  /** The run's own emit (records, persists, logs and broadcasts); send() and stop() route through it so summary.status stays current. */
  emit: (e: RunEvent) => void
  /** Display name of the project, for cross-run messages. */
  projectName: string
  /** Name of the root role (its orchestrator), for list_runs. */
  rootRole: string
  /** Cross-run messages this run has sent (see RUN_MESSAGE_LIMIT). */
  messagesSent: number
}

/**
 * The most message_run messages one run may send. A hard stop so two orchestrators cannot ping-pong forever
 * (each message wakes the other, whose reply wakes the first).
 */
export const RUN_MESSAGE_LIMIT = 40

/** A session that is open and not being stopped: the run can still receive a message. */
function isOpenStatus(status: RunSummary['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'idle'
}

/** Statuses of a run whose session is open (or opening). */
const LIVE_STATUSES: ReadonlySet<RunSummary['status']> = new Set(['starting', 'running', 'idle', 'stopping'])

/**
 * The session chain of `from`: every run of its project connected to it through resumedFrom links (in either
 * direction, transitively) or a shared non-empty sessionId. Both are followed because it is unverified whether
 * a resumed provider session reports the same session id. Cycle-safe. Includes `from`.
 */
export function sessionChain(runs: RunSummary[], from: RunSummary): RunSummary[] {
  const byId = new Map<string, RunSummary>()
  for (const r of runs) if (r.projectId === from.projectId) byId.set(r.id, r)
  if (!byId.has(from.id)) byId.set(from.id, from)
  const ids = new Set([from.id])
  const sessions = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const r of byId.values()) {
      if (ids.has(r.id)) {
        if (r.sessionId && !sessions.has(r.sessionId)) {
          sessions.add(r.sessionId)
          changed = true
        }
        if (r.resumedFrom && byId.has(r.resumedFrom) && !ids.has(r.resumedFrom)) {
          ids.add(r.resumedFrom)
          changed = true
        }
      } else if ((r.sessionId && sessions.has(r.sessionId)) || (r.resumedFrom && ids.has(r.resumedFrom))) {
        ids.add(r.id)
        changed = true
      }
    }
  }
  return [...byId.values()].filter((r) => ids.has(r.id))
}

/** A prompt shortened for messages: one line, at most `max` (default 60) characters. */
function excerpt(prompt: string, max = 60): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export interface RunManagerOptions {
  /** The current project for a run being resumed automatically. */
  resolveProject?: (projectId: string) => Project | null | undefined
  /** App setting passed to adapters (see RuntimeContext.opusGuardThreshold). */
  opusGuardThreshold?: () => number
  /** Delay between a turn ending and the automatic-continue check (RuntimeContext.continuationDelayMs). */
  continuationDelayMs?: number
  /** The model catalog used to decide which adapter a LiteLLM project runs on (adapterForProject). Default: empty. */
  catalog?: () => ProviderModel[]
  /** How a run reaches its models; errors become start errors. Missing = no RuntimeContext.connection. */
  resolveConnection?: (project: Project, choice: AdapterChoice) => RunConnection
  /** MCP servers and secrets (McpService). Missing = runs have no MCP servers and cannot install any. */
  mcp?: {
    enabledServers(project: Project): McpServerSpec[]
    resolve(projectId: string, spec: McpServerSpec, extra?: Record<string, string>): ResolvedMcpServer
    persistInstall(projectId: string, spec: McpServerSpec, secrets: Record<string, string>): Project
    searchRegistry(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult>
  }
}

/** Human label of a model family for refusal messages. */
const FAMILY_LABEL: Record<string, string> = { claude: 'Claude', openai: 'OpenAI', other: 'other' }
const CONNECTION_LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

export interface StartInput {
  project: Project
  prompt: string
  kind?: RunKind
  hiddenContext?: string
  /** A new project's first build run; recorded on the project so the UI stops offering it. */
  scaffold?: boolean
  /** Continue an earlier run: resume its provider session. */
  resumeSessionId?: string
  /** The run being continued. */
  resumedFrom?: string
  /** Cost already recorded on the run being continued. */
  resumeBaseCostUsd?: number
  /** The continued run's plan; it carries over with a fresh automatic-continue count. */
  plan?: RunPlan
  /** Pasted images for the first message; validated here before reaching the adapter. */
  images?: ImageAttachment[]
  /** An info line logged on the new run right after it starts. */
  notice?: string
}

export class RunManager {
  private runs = new Map<string, ActiveRun>()
  /** Paused run id -> its auto-resume timer. Lives only as long as the app process. */
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private adapters: Partial<Record<ProviderId, RuntimeAdapter>>,
    private broadcast: (e: RunEvent) => void,
    private store: RunStore,
    private setup: SetupService,
    /** Retention per project; older finished runs are deleted when a run ends. */
    private keepRunsFor: (projectId: string) => number,
    private options: RunManagerOptions = {}
  ) {}

  /** Drop every run of a deleted project. Live runs are stopped first. */
  async removeProject(projectId: string): Promise<void> {
    for (const r of this.runs.values()) {
      if (r.summary.projectId === projectId) {
        r.userStopped = true
        await r.session?.stop().catch(() => {})
        if (r.flushTimer) clearTimeout(r.flushTimer)
        this.runs.delete(r.summary.id)
      }
    }
    for (const s of this.store.list(projectId)) this.clearResume(s.id)
    this.store.removeProject(projectId)
  }

  /** The adapter a project's runs use (also used by the org chart drafter). Does not check role mismatches. */
  adapterFor(project: Project): RuntimeAdapter {
    return this.choose(project, 'setup').adapter
  }

  /**
   * Pick the adapter for a run. Work runs refuse to start when some roles would need the other adapter;
   * setup-like runs use a built-in role and only need the root's adapter.
   */
  private choose(project: Project, kind: RunKind): { adapter: RuntimeAdapter; choice: AdapterChoice } {
    const choice = adapterForProject(project, this.options.catalog?.() ?? [])
    if (!isSetupLikeRun(kind) && choice.mismatched.length) {
      const catalog = this.options.catalog?.() ?? []
      const bad = choice.mismatched.map((id) => project.roles.find((r) => r.id === id)).filter((r): r is Role => !!r)
      const names = bad.length ? bad.map((r) => r.name) : choice.mismatched
      const families = [...new Set(bad.map((r) => catalog.find((m) => m.id === r.model && m.connection === choice.connection)?.family ?? modelFamily(r.model)))]
      const other = families.length ? families.map((f) => (f === 'other' ? 'non-Claude' : (FAMILY_LABEL[f] ?? f))).join('/') : 'other'
      const rootFamily = choice.family ?? 'claude'
      throw new Error(
        `Roles ${names.join(', ')} use ${other}-family models, but this ${CONNECTION_LABEL[choice.connection] ?? choice.connection} project's orchestrator runs on ${FAMILY_LABEL[rootFamily] ?? rootFamily}. Pick models of one family.`
      )
    }
    const adapter = this.adapters[choice.adapter]
    if (!adapter) throw new Error(`No runtime adapter for provider "${choice.adapter}"`)
    return { adapter, choice }
  }

  async start({
    project,
    prompt,
    kind = 'work',
    hiddenContext,
    scaffold,
    resumeSessionId,
    resumedFrom,
    resumeBaseCostUsd,
    plan: carriedPlan,
    images: rawImages,
    notice
  }: StartInput): Promise<RunSummary> {
    // Adapter and connection are settled before a run exists, so a refusal leaves no run behind.
    const { adapter, choice } = this.choose(project, kind)
    const connection = this.options.resolveConnection?.(project, choice)
    if (hiddenContext === undefined && kind === 'mcp-assist') hiddenContext = assistContext(project)
    const images = sanitizeImages(rawImages, (m) => log.warn(m))
    const summary: RunSummary = {
      id: newId('run'),
      projectId: project.id,
      kind,
      prompt,
      status: 'starting',
      startedAt: Date.now(),
      totalCostUsd: 0
    }
    if (resumedFrom) summary.resumedFrom = resumedFrom
    const active: ActiveRun = {
      summary,
      pending: new Map(),
      pendingProposals: new Map(),
      pendingQuestions: new Map(),
      pendingMerges: new Map(),
      pendingInstalls: new Map(),
      pendingRules: new Map(),
      runRules: [],
      projectPath: project.path,
      runServers: new Map(),
      emit: () => {},
      projectName: project.name,
      rootRole: (project.roles.find((r) => r.reportsTo === null) ?? project.roles[0])?.name ?? '',
      messagesSent: 0,
      record: { summary, agents: {}, transcript: [], logs: [] },
      ...(resumeSessionId ? { resumeSessionId } : {})
    }
    this.runs.set(summary.id, active)
    this.store.upsert(summary)

    const emit = (raw: RunEvent): void => {
      let e = raw
      // A session that ends after a usage-limit rejection is paused, not finished.
      if (e.type === 'run.status' && (e.status === 'finished' || e.status === 'error') && active.limited && !active.userStopped) {
        const now = Date.now()
        const until = active.limited.until && active.limited.until > now ? active.limited.until : now + DEFAULT_PAUSE_MS
        e = { ...e, status: 'paused', pausedUntil: until, pauseReason: pauseReasonText(active.limited.window, e.error), autoResume: true }
      }
      if (e.type === 'run.status') {
        summary.status = e.status
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.error) summary.error = e.error
        if (e.status === 'finished' || e.status === 'error' || e.status === 'paused') summary.endedAt = Date.now()
        if (e.status === 'paused') {
          summary.pausedUntil = e.pausedUntil
          summary.pauseReason = e.pauseReason
          summary.autoResume = e.autoResume
          this.scheduleResume(summary.id, e.pausedUntil ?? Date.now() + DEFAULT_PAUSE_MS)
        }
        this.store.upsert(summary)
      } else if (e.type === 'run.cost') {
        summary.totalCostUsd = e.totalCostUsd
        this.store.upsert(summary)
      }
      this.recordEvent(active, e)
      logRunEvent(summary, e)
      this.broadcast(e)
    }

    active.emit = emit
    emit({ type: 'run.status', runId: summary.id, status: 'starting' })
    if (notice) emit({ type: 'log', runId: summary.id, level: 'info', message: notice })
    if (carriedPlan && kind === 'work') emit({ type: 'plan.updated', runId: summary.id, plan: { ...structuredClone(carriedPlan), autoContinues: 0 } })

    const updatePlan = async (plan: RunPlan): Promise<void> => {
      const previous = active.record.plan
      const next = structuredClone(plan)
      emit({ type: 'plan.updated', runId: summary.id, plan: next })
      const change = describePlanChange(previous, next)
      if (change) emit({ type: 'log', runId: summary.id, level: 'info', message: change })
      if (next.status === 'blocked' && previous?.status !== 'blocked') {
        const text = `The orchestrator needs you: ${next.blockedReason ?? 'it marked the plan blocked.'} Reply below to continue.`
        emit({ type: 'transcript', runId: summary.id, entry: { id: newId('t'), agentId: ROOT_AGENT_ID, at: Date.now(), block: { kind: 'system', text } } })
      }
    }

    const setupLike = isSetupLikeRun(kind)
    const mcp = this.options.mcp
    /** The project as saved after installs this run made; the canonical path is kept. */
    let live: Project = project
    const projectServers = (): McpServerSpec[] => (setupLike ? [] : (mcp?.enabledServers(live) ?? live.mcpServers?.filter((s) => s.enabled) ?? []))
    const runServerSpecs = (): McpServerSpec[] => [...active.runServers.values()].map((r) => r.spec)
    const allServers = (): McpServerSpec[] => {
      const base = projectServers()
      return [...base, ...runServerSpecs().filter((s) => !base.some((b) => b.id === s.id))]
    }
    const resolveOne = (spec: McpServerSpec): ResolvedMcpServer => {
      const extra = active.runServers.get(spec.id)?.secrets
      if (mcp) return mcp.resolve(live.id, spec, extra)
      const env = { ...(spec.env ?? {}) }
      const headers = { ...(spec.headers ?? {}) }
      for (const n of spec.secretEnv ?? []) if (extra?.[n]) env[n] = extra[n]
      for (const n of spec.secretHeaders ?? []) if (extra?.[n]) headers[n] = extra[n]
      return { spec, env, headers }
    }
    try {
      // A new project's folder may not exist yet, and the provider needs a real cwd.
      mkdirSync(project.path, { recursive: true })
      // Git and Claude Code compare paths case-sensitively on Windows; a project path typed in a different
      // case than the folder on disk makes worktree isolation refuse to start. Use the on-disk spelling.
      project = { ...project, path: canonicalPath(project.path) }
      live = project
      if (scaffold) {
        const updated = this.setup.markScaffolded(project.id)
        this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
      }
      const ctx: RuntimeContext = {
        run: summary,
        project,
        roles: kind === 'setup' ? [architectRole()] : kind === 'mcp-assist' ? [mcpAssistantRole()] : project.roles,
        prompt,
        images: images.length ? images : undefined,
        hiddenContext,
        resumeSessionId,
        resumeBaseCostUsd,
        emit,
        listRuns: () => this.listRunsFor(active),
        messageRun: (targetId, text) => this.messageRun(active, targetId, text),
        ...(connection ? { connection } : {}),
        requestPermission: (req) => this.requestPermission(active, req),
        requestProposal: (req) =>
          this.requestProposal(active, req, (saved) => {
            // Keep the harness tools' view of the project current after an approved MCP change.
            if (req.kind === 'mcpServers') {
              live = { ...saved, path: live.path }
              ctx.project = live
            }
          }),
        requestMcpInstall: (req) => this.requestMcpInstall(active, req, () => live, (saved) => (live = { ...saved, path: live.path })),
        ...(mcp ? { searchMcpRegistry: (input: McpRegistrySearchInput) => mcp.searchRegistry(input) } : {}),
        mcpServers: allServers,
        resolveMcpSecrets: async (serverId) => {
          const spec = allServers().find((s) => s.id === serverId)
          if (!spec) return { env: {}, headers: {} }
          const r = resolveOne(spec)
          return {
            env: Object.fromEntries((spec.secretEnv ?? []).filter((n) => r.env[n] !== undefined).map((n) => [n, r.env[n]])),
            headers: Object.fromEntries((spec.secretHeaders ?? []).filter((n) => r.headers[n] !== undefined).map((n) => [n, r.headers[n]]))
          }
        },
        resolvedMcpServers: async () => allServers().map(resolveOne),
        plugins: () => (setupLike ? [] : (live.plugins ?? []).filter((p) => p.enabled)),
        requestQuestion: (req) => this.requestQuestion(active, req),
        requestPermissionRules: (req) => this.requestRules(active, req),
        allowedRules: () => [...new Set([...listRules(project.path), ...active.runRules])],
        noteArchitectureUpdated: async () => {
          const updated = this.setup.markArchitectureUpdated(project.id)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        },
        requestMergeReview: (req) => this.requestMergeReview(active, req),
        rateLimited: (info) => {
          active.limited = { ...active.limited, ...info }
        },
        opusGuardThreshold: this.options.opusGuardThreshold?.(),
        getPlan: () => active.record.plan,
        updatePlan,
        pendingInteractions: () =>
          active.pending.size +
          active.pendingProposals.size +
          active.pendingQuestions.size +
          active.pendingMerges.size +
          active.pendingInstalls.size +
          active.pendingRules.size,
        autoContinue: project.autoContinue !== false,
        maxAutoContinues: project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
        ...(this.options.continuationDelayMs !== undefined ? { continuationDelayMs: this.options.continuationDelayMs } : {}),
        completeSetup: async (text) => {
          const updated = this.setup.complete(project.id, text)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        }
      }
      active.session = await adapter.start(ctx)
      void active.session.finished.finally(() => {
        for (const resolve of active.pending.values()) resolve({ behavior: 'deny', message: 'Run ended' })
        active.pending.clear()
        for (const resolve of active.pendingProposals.values()) resolve({ behavior: 'revise', feedback: 'Run ended' })
        active.pendingProposals.clear()
        for (const [questionId, q] of active.pendingQuestions) {
          q.resolve({ selected: [] })
          this.broadcast({ type: 'question.resolved', runId: summary.id, questionId, answer: { selected: [] } })
        }
        active.pendingQuestions.clear()
        for (const [requestId, r] of active.pendingRules) {
          r.resolve({ behavior: 'deny', message: 'Run ended' })
          this.broadcast({ type: 'rules.resolved', runId: summary.id, requestId, decision: { behavior: 'deny', message: 'Run ended' } })
        }
        active.pendingRules.clear()
        // Unanswered merge reviews keep their branch for later (maintenance panel or a future run).
        for (const [reviewId, resolve] of active.pendingMerges) {
          resolve({ behavior: 'hold' })
          this.broadcast({ type: 'merge.resolved', runId: summary.id, reviewId, decision: { behavior: 'hold' } })
        }
        active.pendingMerges.clear()
        // Unanswered installs are denied; servers approved for this run only (and their secrets) are forgotten.
        for (const [requestId, p] of active.pendingInstalls) {
          p.resolve({ approved: false, scope: 'run' })
          this.broadcast({ type: 'mcpInstall.resolved', runId: summary.id, requestId, outcome: { approved: false, scope: 'run' } })
        }
        active.pendingInstalls.clear()
        active.runServers.clear()
        this.flush(active)
        this.runs.delete(summary.id)
        this.store.prune(this.keepRunsFor)
      })
    } catch (e) {
      emit({ type: 'run.status', runId: summary.id, status: 'error', error: (e as Error).message })
      this.flush(active)
      // No session will ever finish this run; it must not count as live.
      this.runs.delete(summary.id)
      this.store.prune(this.keepRunsFor)
    }
    return summary
  }

  private recordEvent(active: ActiveRun, e: RunEvent): void {
    const r = active.record
    switch (e.type) {
      case 'agent.upsert':
        r.agents[e.agent.id] = e.agent
        break
      case 'agent.remove':
        delete r.agents[e.agentId]
        break
      case 'transcript':
        r.transcript.push(e.entry)
        break
      case 'log':
        r.logs.push({ at: Date.now(), level: e.level, message: e.message })
        break
      case 'plan.updated':
        r.plan = e.plan
        break
      default:
        return
    }
    if (!active.flushTimer) active.flushTimer = setTimeout(() => this.flush(active), FLUSH_INTERVAL_MS)
  }

  private flush(active: ActiveRun): void {
    if (active.flushTimer) clearTimeout(active.flushTimer)
    active.flushTimer = undefined
    try {
      this.store.saveRecord(active.record)
    } catch (e) {
      console.error('Failed to persist run record:', e)
    }
  }

  /** Summary of a live run, without copying its record. Undefined once the run has ended. */
  /** Runs whose session is still open. */
  liveRunCount(): number {
    return this.runs.size
  }

  /** runs:listLive: every live run (session open or opening) across all projects, every kind, oldest first. Copies. */
  liveRuns(): RunSummary[] {
    return [...this.runs.values()]
      .filter((a) => LIVE_STATUSES.has(a.summary.status))
      .map((a) => ({ ...a.summary }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  // ---------- cross-run messaging ----------

  /** list_runs: every other live work run, across projects, oldest first. A setup-like caller sees none. */
  private listRunsFor(self: ActiveRun): RunPeer[] {
    if (isSetupLikeRun(self.summary.kind)) return []
    return [...this.runs.values()]
      .filter((a) => a !== self && a.summary.kind === 'work' && isOpenStatus(a.summary.status))
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
      .map((a) => ({
        runId: a.summary.id,
        projectId: a.summary.projectId,
        projectName: a.projectName,
        kind: a.summary.kind,
        status: a.summary.status,
        prompt: excerpt(a.summary.prompt, RUN_PEER_PROMPT_CHARS),
        startedAt: a.summary.startedAt,
        rootRole: a.rootRole,
        live: true
      }))
  }

  /** message_run: see RuntimeContext.messageRun. Both runs record the exchange through their own emit. */
  private async messageRun(sender: ActiveRun, targetId: string, rawText: string): Promise<RunMessageResult> {
    const text = (typeof rawText === 'string' ? rawText : '').trim().slice(0, RUN_MESSAGE_MAX_CHARS)
    if (!text || isSetupLikeRun(sender.summary.kind) || targetId === sender.summary.id) return 'refused'
    const target = this.runs.get(targetId)
    const stored = target ? undefined : this.store.get(targetId)
    if (!target && !stored) return 'not-found'
    if (isSetupLikeRun((target?.summary ?? stored!).kind)) return 'refused'
    if (sender.messagesSent >= RUN_MESSAGE_LIMIT) return 'refused'
    const session = target?.session
    if (!target || !isOpenStatus(target.summary.status) || !session?.receive) return 'not-live'

    sender.messagesSent++
    const at = Date.now()
    const from = sender.summary
    const to = target.summary
    const fromPrompt = excerpt(from.prompt, RUN_PEER_PROMPT_CHARS)
    const toPrompt = excerpt(to.prompt, RUN_PEER_PROMPT_CHARS)
    const block = (a: ActiveRun, text: string): void =>
      a.emit({ type: 'transcript', runId: a.summary.id, entry: { id: newId('t'), agentId: ROOT_AGENT_ID, at, block: { kind: 'system', text } } })

    sender.emit({ type: 'run.message', runId: from.id, direction: 'out', peerRunId: to.id, peerProjectId: to.projectId, peerProjectName: target.projectName, peerPrompt: toPrompt, text, at })
    block(sender, `Sent to run ${to.id} (${target.projectName}: ${toPrompt}): ${text}`)
    sender.emit({ type: 'log', runId: from.id, level: 'info', message: `Messaged run ${to.id} (${target.projectName}).` })
    // The recipient's block goes first so its transcript reads in order even if receive() wakes the root at once.
    target.emit({ type: 'run.message', runId: to.id, direction: 'in', peerRunId: from.id, peerProjectId: from.projectId, peerProjectName: sender.projectName, peerPrompt: fromPrompt, text, at })
    block(target, `Message from run ${from.id} (${sender.projectName}: ${fromPrompt}): ${text}`)
    target.emit({ type: 'log', runId: to.id, level: 'info', message: `Received a message from run ${from.id} (${sender.projectName}).` })
    try {
      await session.receive({ fromRunId: from.id, fromProjectName: sender.projectName, fromPrompt, text })
    } catch (e) {
      const message = (e as Error).message
      sender.emit({ type: 'log', runId: from.id, level: 'warn', message: `Run ${to.id} could not receive the message: ${message}` })
      target.emit({ type: 'log', runId: to.id, level: 'warn', message: `Could not take the message from run ${from.id}: ${message}` })
      return 'not-live'
    }
    return 'delivered'
  }

  summaryOf(runId: string): RunSummary | undefined {
    return this.runs.get(runId)?.summary
  }

  get(runId: string): RunRecord | null {
    const active = this.runs.get(runId)
    if (active) return { ...active.record, summary: { ...active.summary } }
    const stored = this.store.getRecord(runId)
    if (!stored) return null
    // Records written before agentTree.resolveParent existed can hold a parent cycle; repair them on read.
    const agents = breakParentCycles(stored.agents ?? {}, ROOT_AGENT_ID)
    return agents === stored.agents ? stored : { ...stored, agents }
  }

  private requestPermission(
    active: ActiveRun,
    req: Omit<PermissionRequest, 'id' | 'runId'>
  ): Promise<PermissionDecision> {
    const request: PermissionRequest = { ...req, id: newId('perm'), runId: active.summary.id }
    logPermission(active.summary, request)
    return new Promise((resolve) => {
      active.pending.set(request.id, (decision) => {
        logPermission(active.summary, request, decision)
        resolve(decision)
      })
      this.broadcast({ type: 'permission.request', runId: active.summary.id, request })
    })
  }

  decide(runId: string, requestId: string, decision: PermissionDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pending.get(requestId)
    if (!active || !resolve) return
    active.pending.delete(requestId)
    resolve(decision)
    this.broadcast({ type: 'permission.resolved', runId, requestId })
  }

  private requestProposal(
    active: ActiveRun,
    req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>,
    onApplied?: (saved: Project) => void
  ): Promise<ProposalDecision> {
    const proposal = { ...req, id: newId('prop'), runId: active.summary.id, createdAt: Date.now() } as Proposal
    return new Promise((resolve) => {
      active.pendingProposals.set(proposal.id, (decision) => {
        if (decision.behavior === 'approve') {
          try {
            const updated = this.setup.applyProposal(active.summary.projectId, proposal)
            onApplied?.(updated)
            this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
          } catch (e) {
            const message = (e as Error).message
            logRunEvent(active.summary, { type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            this.broadcast({ type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            resolve({ behavior: 'revise', feedback: `The harness could not apply this proposal: ${message}` })
            return
          }
        }
        resolve(decision)
      })
      this.broadcast({ type: 'proposal.request', runId: active.summary.id, proposal })
    })
  }

  decideProposal(runId: string, proposalId: string, decision: ProposalDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pendingProposals.get(proposalId)
    if (!active || !resolve) return
    active.pendingProposals.delete(proposalId)
    resolve(decision)
    this.broadcast({ type: 'proposal.resolved', runId, proposalId, decision })
  }

  private requestQuestion(
    active: ActiveRun,
    req: Omit<UserQuestion, 'id' | 'runId' | 'createdAt'>
  ): Promise<QuestionAnswer> {
    const question: UserQuestion = { ...req, id: newId('q'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingQuestions.set(question.id, { question, resolve })
      this.broadcast({ type: 'question.request', runId: active.summary.id, question })
    })
  }

  answerQuestion(runId: string, questionId: string, answer: QuestionAnswer): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingQuestions.get(questionId)
    if (!active || !pending) return
    active.pendingQuestions.delete(questionId)
    // Only labels that were offered count; a single-choice question keeps the first.
    const labels = new Set(pending.question.options.map((o) => o.label))
    let selected = (Array.isArray(answer?.selected) ? answer.selected : []).filter((l) => typeof l === 'string' && labels.has(l))
    if (!pending.question.allowMultiple) selected = selected.slice(0, 1)
    const text = pending.question.allowFreeText && typeof answer?.text === 'string' && answer.text.trim() ? answer.text.trim() : undefined
    const clean: QuestionAnswer = text ? { selected, text } : { selected }
    pending.resolve(clean)
    this.broadcast({ type: 'question.resolved', runId, questionId, answer: clean })
  }

  private requestMergeReview(
    active: ActiveRun,
    req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>
  ): Promise<MergeDecision> {
    const review: MergeReview = { ...req, id: newId('merge'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingMerges.set(review.id, resolve)
      this.broadcast({ type: 'merge.request', runId: active.summary.id, review })
    })
  }

  decideMerge(runId: string, reviewId: string, decision: MergeDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pendingMerges.get(reviewId)
    if (!active || !resolve) return
    active.pendingMerges.delete(reviewId)
    resolve(decision)
    this.broadcast({ type: 'merge.resolved', runId, reviewId, decision })
  }

  // ---------- permission rule requests ----------

  private requestRules(
    active: ActiveRun,
    req: Omit<PermissionRuleRequest, 'id' | 'runId' | 'createdAt' | 'flagged'>
  ): Promise<PermissionRuleDecision> {
    const rules = [...new Set(req.rules.map((r) => r.trim()).filter((r) => isValidRule(r)))]
    const request: PermissionRuleRequest = {
      ...req,
      rules,
      flagged: rules.filter((r) => isUnsafeAllowRule(r)),
      id: newId('rule'),
      runId: active.summary.id,
      createdAt: Date.now()
    }
    if (!rules.length) return Promise.resolve({ behavior: 'deny', message: 'no valid rules' })
    return new Promise((resolve) => {
      active.pendingRules.set(request.id, { request, resolve })
      this.broadcast({ type: 'rules.request', runId: active.summary.id, request })
    })
  }

  /**
   * Answer a request_permission_rules card. A grant is in force before the agent's tool call returns: run
   * scope adds the rules to the run (allowedRules), project scope also saves them to the settings file. The user
   * chose the rules knowingly, so flagged (destructive) rules are saved too.
   */
  decideRules(runId: string, requestId: string, decision: PermissionRuleDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingRules.get(requestId)
    if (!active || !pending) return
    active.pendingRules.delete(requestId)
    const { rules } = pending.request
    let clean: PermissionRuleDecision
    if (decision?.behavior === 'grant') {
      const scope = decision.scope === 'project' ? 'project' : 'run'
      clean = { behavior: 'grant', scope }
      for (const r of rules) if (!active.runRules.includes(r)) active.runRules.push(r)
      if (scope === 'project') {
        try {
          addRules(active.projectPath, rules)
        } catch (e) {
          clean = { behavior: 'grant', scope: 'run' }
          this.broadcast({ type: 'log', runId, level: 'warn', message: `Could not save the rules to the project (${(e as Error).message}); they apply to this run only.` })
        }
      }
      this.broadcast({
        type: 'log',
        runId,
        level: 'info',
        message: `Allowed ${rules.join(', ')} ${clean.scope === 'project' ? 'for this project' : 'for this run'} at the request of ${pending.request.agentId}.`
      })
    } else {
      const message = typeof decision?.message === 'string' && decision.message.trim() ? decision.message.trim() : undefined
      clean = message ? { behavior: 'deny', message } : { behavior: 'deny' }
      this.broadcast({ type: 'log', runId, level: 'info', message: `Denied the permission request for ${rules.join(', ')}.` })
    }
    pending.resolve(clean)
    this.broadcast({ type: 'rules.resolved', runId, requestId, decision: clean })
  }

  // ---------- MCP install requests ----------

  private requestMcpInstall(
    active: ActiveRun,
    req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>,
    getProject: () => Project,
    setProject: (saved: Project) => void
  ): Promise<McpInstallDecision> {
    const request: McpInstallRequest = { ...req, id: newId('mcpi'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingInstalls.set(request.id, {
        request,
        resolve: (raw) => {
          const decision = this.settleInstall(active, request, raw, getProject(), setProject)
          // Secrets stop here: the agent and the renderer only ever see the outcome.
          const outcome: McpInstallOutcome = {
            approved: decision.approved,
            scope: decision.scope,
            ...(decision.note ? { note: decision.note } : {}),
            ...(decision.spec ? { spec: decision.spec } : {})
          }
          this.broadcast({ type: 'mcpInstall.resolved', runId: active.summary.id, requestId: request.id, outcome })
          resolve(outcome)
        }
      })
      this.broadcast({ type: 'mcpInstall.request', runId: active.summary.id, request })
    })
  }

  /** Validate an install answer and apply it (save the server or keep it for this run). Never throws. */
  private settleInstall(active: ActiveRun, request: McpInstallRequest, raw: McpInstallDecision, project: Project, setProject: (saved: Project) => void): McpInstallDecision {
    const scope = raw?.scope === 'project' ? 'project' : 'run'
    const note = typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 600) : undefined
    if (!raw?.approved) return { approved: false, scope, ...(note ? { note } : {}) }
    const spec: McpServerSpec = raw.spec ?? request.spec
    const others = [...(project.mcpServers ?? []), ...[...active.runServers.values()].map((r) => r.spec)].filter((s) => s.id !== spec.id)
    const errors = validateSpec(spec, others)
    if (errors.length) return { approved: false, scope, note: `The harness did not install it: ${errors.join(' ')}` }
    const secrets: Record<string, string> = {}
    for (const n of mcpSecretNames(spec)) {
      const v = raw.secrets?.[n]
      if (typeof v === 'string' && v) secrets[n] = v
    }
    if (scope === 'project' && this.options.mcp) {
      try {
        const saved = this.options.mcp.persistInstall(project.id, spec, secrets)
        setProject(saved)
        this.broadcast({ type: 'project.updated', runId: active.summary.id, project: saved })
      } catch (e) {
        return { approved: false, scope, note: `The harness could not save the server: ${(e as Error).message}` }
      }
    } else {
      active.runServers.set(spec.id, { spec, secrets })
    }
    return { approved: true, scope: scope === 'project' && this.options.mcp ? 'project' : 'run', ...(note ? { note } : {}), ...(raw.spec ? { spec: raw.spec } : {}) }
  }

  /** Answer a request_mcp_install card (mcp:answerInstall). Unknown or already answered requests are ignored. */
  answerMcpInstall(runId: string, requestId: string, decision: McpInstallDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingInstalls.get(requestId)
    if (!active || !pending) return
    active.pendingInstalls.delete(requestId)
    pending.resolve(decision)
  }

  async send(runId: string, text: string, rawImages?: ImageAttachment[]): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) throw new Error('Run is not active')
    const images = sanitizeImages(rawImages, (m) => log.warn(m))
    if (!hasContent(text, images)) throw new Error('Nothing to send')
    active.emit({ type: 'run.status', runId, status: 'running' })
    await active.session.send(text, images.length ? images : undefined)
  }

  async interrupt(runId: string): Promise<void> {
    await this.runs.get(runId)?.session?.interrupt()
  }

  async stop(runId: string): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) return
    active.userStopped = true
    active.emit({ type: 'run.status', runId, status: 'stopping' })
    await active.session.stop()
  }

  async stopAll(): Promise<void> {
    for (const runId of [...this.resumeTimers.keys()]) this.clearResume(runId)
    for (const r of this.runs.values()) r.userStopped = true
    await Promise.allSettled([...this.runs.values()].map((r) => r.session?.stop()))
    for (const r of this.runs.values()) this.flush(r)
  }

  list(projectId: string): RunSummary[] {
    return this.store.list(projectId)
  }

  /** A run's summary, live or persisted. */
  summary(runId: string): RunSummary | null {
    const active = this.runs.get(runId)
    return active ? { ...active.summary } : this.store.get(runId)
  }

  /**
   * Start a new run that resumes a finished run's provider session, so the orchestrator keeps
   * its memory. Same kind as the old run: setup runs keep the Architect (with its hidden profile
   * context), work runs use the project's roles. `project` must be the old run's project.
   */
  async continueRun(project: Project, fromRunId: string, text: string, rawImages?: ImageAttachment[]): Promise<RunSummary> {
    const from = this.summary(fromRunId)
    if (!from) throw new Error('Run not found')
    if (from.projectId !== project.id) throw new Error('Run belongs to another project')
    if (from.status !== 'finished' && from.status !== 'error' && from.status !== 'paused') throw new Error('Run is still active; send a message instead')
    if (!from.sessionId) throw new Error('This run has no session to continue')
    const prompt = text.trim()
    const images = sanitizeImages(rawImages, (m) => log.warn(m))
    if (!hasContent(prompt, images)) throw new Error('Nothing to send')

    // One live run per provider session: two runs resuming one session would interleave in it.
    const chain = this.chainOf(from)
    const chainIds = new Set(chain.map((r) => r.id))
    const chainSessions = new Set(chain.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))
    for (const a of this.runs.values()) {
      const s = a.summary
      if (s.projectId !== from.projectId || !LIVE_STATUSES.has(s.status)) continue
      if (chainIds.has(s.id) || (a.resumeSessionId && chainSessions.has(a.resumeSessionId))) {
        throw new Error(`Session already open: run ${s.id} ("${excerpt(s.prompt)}") is continuing it; reply there instead.`)
      }
    }

    // Continue from the newest ended run of the chain, so no turn of a later continuation is lost.
    const target = chain
      .filter((r) => r.sessionId && (r.status === 'finished' || r.status === 'error' || r.status === 'paused'))
      .reduce((best, r) => (r.startedAt > best.startedAt || (r.startedAt === best.startedAt && r.resumedFrom === best.id) ? r : best), from)
    const sessionId = target.sessionId ?? from.sessionId

    // A paused run is handed over to its continuation; it stays in history as finished.
    for (const r of target.id === from.id ? [from] : [target, from]) {
      if (r.status !== 'paused') continue
      this.clearResume(r.id)
      const done = this.patchSummary(r.id, { status: 'finished', autoResume: false })
      if (done) this.broadcast({ type: 'run.status', runId: done.id, status: 'finished', pausedUntil: done.pausedUntil, pauseReason: done.pauseReason, autoResume: false })
    }
    return this.start({
      project,
      prompt,
      images,
      kind: target.kind,
      hiddenContext: target.kind === 'setup' ? this.setup.hiddenContext(project) : undefined,
      resumeSessionId: sessionId,
      resumedFrom: target.id,
      resumeBaseCostUsd: target.totalCostUsd,
      plan: target.kind === 'work' ? this.get(target.id)?.plan : undefined,
      ...(target.id !== from.id
        ? { notice: `Continued from run ${target.id} ("${excerpt(target.prompt)}"), the newest run of this session, instead of the older run ${from.id}.` }
        : {})
    })
  }

  /** Every run of `from`'s session chain (see sessionChain), with live runs' current summaries. */
  private chainOf(from: RunSummary): RunSummary[] {
    const all = new Map(this.store.list(from.projectId).map((r) => [r.id, r]))
    for (const a of this.runs.values()) if (a.summary.projectId === from.projectId) all.set(a.summary.id, { ...a.summary })
    return sessionChain([...all.values()], from)
  }

  // ---------- pause and auto-resume ----------

  private scheduleResume(runId: string, at: number): void {
    this.clearResume(runId)
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.resumeTimers.delete(runId)
      this.resumeNow(runId).catch((err) => {
        const message = `Could not resume the paused run: ${(err as Error).message}`
        this.broadcast({ type: 'log', runId, level: 'error', message })
        const s = this.patchSummary(runId, { autoResume: false })
        if (s) this.broadcast({ type: 'run.status', runId, status: s.status, pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, autoResume: false })
      })
    }, delay)
    this.resumeTimers.set(runId, timer)
  }

  private clearResume(runId: string): void {
    const t = this.resumeTimers.get(runId)
    if (t) clearTimeout(t)
    this.resumeTimers.delete(runId)
  }

  /** Is an auto-resume timer pending for this run? */
  hasAutoResume(runId: string): boolean {
    return this.resumeTimers.has(runId)
  }

  /** Change a run's summary, live or persisted, and save it. Returns the updated copy. */
  private patchSummary(runId: string, patch: Partial<RunSummary>): RunSummary | null {
    const active = this.runs.get(runId)
    if (active) {
      Object.assign(active.summary, patch)
      this.store.upsert(active.summary)
      return { ...active.summary }
    }
    const stored = this.store.get(runId)
    if (!stored) return null
    const next = { ...stored, ...patch }
    this.store.upsert(next)
    return next
  }

  /** Continue a paused run now, with the harness's resume message. */
  async resumeNow(runId: string): Promise<RunSummary> {
    this.clearResume(runId)
    const from = this.summary(runId)
    if (!from) throw new Error('Run not found')
    if (from.status !== 'paused') throw new Error('Run is not paused')
    const current = this.options.resolveProject?.(from.projectId)
    if (!current) throw new Error('Project not found')
    // Setup runs re-profile the repo like setup:start so the Architect's hidden context is current.
    const project = from.kind === 'setup' ? await this.setup.prepare(current) : current
    try {
      return await this.continueRun(project, runId, RESUME_TEXT)
    } catch (e) {
      // The timer is gone; a run still paused must not claim it will resume by itself.
      const s = this.summary(runId)
      if (s?.status === 'paused' && s.autoResume) this.cancelAutoResume(runId)
      throw e
    }
  }

  /** Keep a paused run paused; the user continues it by hand. */
  cancelAutoResume(runId: string): void {
    this.clearResume(runId)
    const s = this.patchSummary(runId, { autoResume: false })
    if (s && s.status === 'paused') {
      this.broadcast({ type: 'run.status', runId, status: 'paused', pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, autoResume: false })
    }
  }
}
