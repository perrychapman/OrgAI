import { mkdirSync, realpathSync } from 'node:fs'
import type {
  AppSettings,
  AdapterChoice,
  ImageAttachment,
  McpInstallDecision,
  McpInstallOutcome,
  McpInstallRequest,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpLibraryEntry,
  McpServerSpec,
  McpServersProposalPayload,
  MergeDecision,
  PendingCards,
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
import { adapterForProject, mcpSecretNames, modelFamily, newId, runMessagingOn } from '@shared/defaults'
import { DEFAULT_MAX_AUTO_CONTINUES, HARNESS_PROJECT_ID, RUN_MESSAGE_MAX_CHARS, RUN_PEER_PROMPT_CHARS } from '@shared/types'
import { architectRole, mcpAssistantRole } from '@shared/setup'
import { MCP_ASSIST_MODEL_LABEL, SETUP_MODEL_LABEL, resolveBuiltinModel, type ResolvedBuiltinModel } from './builtinModel'
import { ROOT_AGENT_ID, isSetupLikeRun, type ResolvedMcpServer, type RunMessageOutcome, type RunConnection, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { log, logPermission, logRunEvent } from '../log'
import { hasContent, sanitizeImages } from './attachments'
import { breakParentCycles } from './agentTree'
import { describePlanChange, peerDeliveryBlocked } from './continuation'
import { isLiveAgent, runOutcome, settleAgent, type RunOutcome } from './activity'
import { cancelPending, emptyPending, listPending, type PendingCardMaps } from './pendingCards'
import { addRules, isUnsafeAllowRule, listRules } from './permissionRules'
import { isValidRule } from './ruleMatch'
import { validateSpec } from '../mcp/validate'
import { assistContext } from '../mcp/assist'
import { generateRunTitle } from '../ai/runTitle'

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
  pending: PendingCardMaps['pending']
  pendingProposals: PendingCardMaps['pendingProposals']
  pendingQuestions: PendingCardMaps['pendingQuestions']
  pendingMerges: PendingCardMaps['pendingMerges']
  /** request_mcp_install cards waiting for mcp:answerInstall. */
  pendingInstalls: PendingCardMaps['pendingInstalls']
  /** request_permission_rules cards waiting for permissions:decideRequest. */
  pendingRules: PendingCardMaps['pendingRules']
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
  /**
   * A usage-limit report holds peer delivery until the user's next successful send(). Unlike `limited` (which
   * drives pausing at session end and is never cleared) this lifts, so a transient limit does not hold messages
   * until teardown.
   */
  limitHold?: boolean
  /** The user ended the session; never pause it. */
  userStopped?: boolean
  /** Cancels a pending title query (user stop, project removal, app quit). A natural end lets the title land. */
  titleAbort?: AbortController
  /** Set by the terminal run.status; later agent upserts are relabeled with settleAgent. */
  outcome?: RunOutcome
  /** Agents still live when the run ended; they read Stopped / Failed however the adapter re-reports them. */
  cutOff?: Set<string>
  /** The provider session this run resumes; known before the adapter reports summary.sessionId at init. */
  resumeSessionId?: string
  /** The run's own emit (records, persists, logs and broadcasts); send() and stop() route through it so summary.status stays current. */
  emit: (e: RunEvent) => void
  /** Display name of the project, for cross-run messages. */
  projectName: string
  /** Name of the root role (its orchestrator), for list_runs. */
  rootRole: string
  /** Cross-run messages this run has sent, per target run id (see RUN_MESSAGE_LIMIT). */
  messagesSent: Map<string, number>
  /** Project.runMessaging when the run started; used when the current project cannot be resolved. */
  messagingAtStart: boolean
  /** Cross-run messages this run has taken from all runs, delivered or queued (see RUN_MESSAGE_INBOUND_LIMIT). */
  messagesReceived: number
  /** Peer messages held while the run waits on its user (see peerDeliveryBlocked), oldest first. */
  inbox: QueuedPeerMessage[]
  /**
   * The user interrupted the run and has not sent a message since. Mirrors ContinuationDriver.isHeld(), which lives
   * inside the adapter; RunManager routes both interrupt() and send(), so it tracks the same rule itself.
   */
  held: boolean
  /** The inbox flush in progress; flushes chain on it so concurrent flushes never reorder peer messages. */
  flushing?: Promise<void>
}

/** A message_run message held for a run that is waiting on its user. */
interface QueuedPeerMessage {
  fromRunId: string
  fromProjectId: string
  fromProjectName: string
  fromPrompt: string
  text: string
  at: number
  /** Set once a delivery was attempted: true when the session took it, false when it could not. */
  delivered?: boolean
  /** The session's receive() did not settle within RUN_MESSAGE_RECEIVE_TIMEOUT_MS (delivered is false). */
  timedOut?: boolean
}

/**
 * The most message_run messages one run may send to one other run (so each direction of a run pair has its own cap).
 * A hard stop so two orchestrators cannot ping-pong forever (each message wakes the other, whose reply wakes the first).
 */
export const RUN_MESSAGE_LIMIT = 40

/** The most message_run messages one run may take from all other runs together, delivered or queued. */
export const RUN_MESSAGE_INBOUND_LIMIT = 100

/** The most peer messages held for one run while it waits on its user; beyond this message_run answers 'busy'. */
export const RUN_MESSAGE_QUEUE_LIMIT = 20

/**
 * How long one peer delivery may wait on the recipient session's receive(). A receive that never settles would
 * otherwise stall the run's flush chain: the sender's message_run and every later peer message to that run.
 */
export const RUN_MESSAGE_RECEIVE_TIMEOUT_MS = 30_000

/** Cards waiting for the user on a run (permission, proposal, question, merge review, install, rules). */
function pendingCount(a: ActiveRun): number {
  return a.pending.size + a.pendingProposals.size + a.pendingQuestions.size + a.pendingMerges.size + a.pendingInstalls.size + a.pendingRules.size
}

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

/** A system line in a run's root transcript. */
function systemBlock(a: ActiveRun, at: number, text: string): void {
  a.emit({ type: 'transcript', runId: a.summary.id, entry: { id: newId('t'), agentId: ROOT_AGENT_ID, at, source: 'harness', block: { kind: 'system', text } } })
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
  /**
   * App settings for the built-in roles' models (setupModel, mcpAssistModel) and the connections' tier mappings.
   * Missing = the built-in roles keep their default model ('opus').
   */
  appSettings?: () => Pick<AppSettings, 'setupModel' | 'mcpAssistModel' | 'connections'>
  /** How a run reaches its models; errors become start errors. Missing = no RuntimeContext.connection. */
  resolveConnection?: (project: Project, choice: AdapterChoice) => RunConnection
  /**
   * The connection's fast-tier model for one-shot helpers (run titles). Missing or undefined = 'haiku' on the
   * Claude adapter, the adapter's default model elsewhere.
   */
  fastModel?: (project: Project, choice: AdapterChoice) => string | undefined
  /** MCP servers and secrets (McpService). Missing = runs have no MCP servers and cannot install any. */
  mcp?: {
    enabledServers(project: Project): McpServerSpec[]
    resolve(projectId: string, spec: McpServerSpec, extra?: Record<string, string>): ResolvedMcpServer
    persistInstall(projectId: string, spec: McpServerSpec, secrets: Record<string, string>, scope?: 'project' | 'library'): Project
    searchRegistry(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult>
    /** The project with linked servers refreshed from the library (links whose entry is gone disabled). */
    withLibrary?(project: Project): Project
    /** Refresh expiring OAuth tokens before servers start; resolves with the names still without a usable token. */
    prepareForRun?(projectId: string, specs: McpServerSpec[]): Promise<string[]>
    /** The app-wide MCP library (secret-free), for setup-like runs. */
    libraryEntries?(): McpLibraryEntry[]
  }
}

/** The install-card fields a user may edit before approving; everything else stays as the agent requested it. */
const INSTALL_EDITABLE = ['name', 'url', 'command', 'args', 'env', 'headers', 'secretEnv', 'secretHeaders', 'roles', 'enabled', 'description'] as const

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

/**
 * The requested spec with the user's allowed edits applied. Ids, transport, registry refs, OAuth configs and
 * library links never come from the renderer: a card edit cannot point at another server's stored credentials.
 */
export function mergeInstallEdit(requested: McpServerSpec, edit: McpServerSpec | undefined): McpServerSpec {
  const out: McpServerSpec = { ...requested }
  delete out.oauth
  delete out.libraryId
  delete (out as { projectOnly?: unknown }).projectOnly
  if (out.source === 'library') out.source = 'agent'
  if (!edit || typeof edit !== 'object') return out
  const target = out as unknown as Record<string, unknown>
  const from = edit as unknown as Record<string, unknown>
  for (const k of INSTALL_EDITABLE) {
    if (!Object.hasOwn(from, k)) continue
    const v = from[k]
    if (v === undefined) {
      if (k !== 'name' && k !== 'enabled') delete target[k]
      continue
    }
    const ok =
      k === 'enabled' ? typeof v === 'boolean'
      : k === 'args' || k === 'secretEnv' || k === 'secretHeaders' || k === 'roles' ? isStringList(v)
      : k === 'env' || k === 'headers' ? isStringRecord(v)
      : typeof v === 'string'
    if (ok) target[k] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...(v as Record<string, string>) } : v
  }
  return out
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
  /** A title carried over from the run being continued (auto-resume); no new title is generated. */
  title?: string
  /** Continuations: the continued run's title (or prompt excerpt), given to the title model as context. */
  titleContext?: string
}

export class RunManager {
  private runs = new Map<string, ActiveRun>()
  /** Paused run id -> its auto-resume timer. Lives only as long as the app process. */
  /** Every pending title query, live run or not, with its project id; stopAll and removeProject abort them. */
  private titleAborts = new Map<AbortController, string>()
  private resumeTimers =new Map<string, ReturnType<typeof setTimeout>>()

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
    // Pending titles of the project's runs, live or already ended, are cancelled.
    for (const [a, pid] of this.titleAborts) if (pid === projectId) a.abort()
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

  /**
   * The model of a setup or MCP assistant run's built-in role, from App settings, resolved against the run's
   * connection (builtinModel.ts). undefined for work runs or without settings (the role's default applies).
   */
  private builtinRoleModel(kind: RunKind, project: Project, choice: AdapterChoice): ResolvedBuiltinModel | undefined {
    if (kind !== 'setup' && kind !== 'mcp-assist') return undefined
    const settings = this.options.appSettings?.()
    if (!settings) return undefined
    const setting = kind === 'setup' ? settings.setupModel : settings.mcpAssistModel
    const label = kind === 'setup' ? SETUP_MODEL_LABEL : MCP_ASSIST_MODEL_LABEL
    return resolveBuiltinModel(setting, label, {
      connection: choice.connection,
      adapter: choice.adapter,
      catalog: this.options.catalog?.() ?? [],
      tierModels: settings.connections?.[choice.connection]?.tierModels ?? {},
      root: project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
    })
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
    notice,
    title: carriedTitle,
    titleContext
  }: StartInput): Promise<RunSummary> {
    // The virtual harness project exists only for the library MCP assistant.
    if (project.id === HARNESS_PROJECT_ID && kind !== 'mcp-assist') throw new Error('Only the MCP assistant can run on the harness project.')
    // Linked MCP servers come from the library as it is now (a deleted entry disables its links).
    project = this.options.mcp?.withLibrary?.(project) ?? project
    // Adapter and connection are settled before a run exists, so a refusal leaves no run behind.
    const { adapter, choice } = this.choose(project, kind)
    const connection = this.options.resolveConnection?.(project, choice)
    const libraryEntries = (): McpLibraryEntry[] => this.options.mcp?.libraryEntries?.() ?? []
    if (hiddenContext === undefined && kind === 'mcp-assist') hiddenContext = assistContext(project, libraryEntries())
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
    if (carriedTitle && kind === 'work') summary.title = carriedTitle
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
      messagesSent: new Map(),
      messagingAtStart: runMessagingOn(project),
      messagesReceived: 0,
      inbox: [],
      held: false,
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
      const outcome = e.type === 'run.status' && !active.outcome ? runOutcome(e.status, !!active.userStopped) : null
      if (outcome) {
        active.outcome = outcome
        active.cutOff = new Set(Object.values(active.record.agents).filter(isLiveAgent).map((a) => a.id))
      }
      // No card outlives its run: cancel every pending card before a terminal (or paused) status goes out.
      if (outcome || (e.type === 'run.status' && e.status === 'paused')) cancelPending(active, summary.id, this.broadcast)
      if (e.type === 'agent.upsert' && active.outcome) {
        if (isLiveAgent(e.agent)) active.cutOff?.add(e.agent.id)
        const settled = settleAgent(e.agent, !!active.cutOff?.has(e.agent.id), active.outcome, ROOT_AGENT_ID)
        if (settled !== e.agent) e = { ...e, agent: settled }
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
      // Root and cut-off reports read Finished / Stopped / Failed instead of "Waiting for you".
      if (outcome) {
        for (const agent of Object.values(active.record.agents)) {
          const settled = settleAgent(agent, !!active.cutOff?.has(agent.id), outcome, ROOT_AGENT_ID)
          if (settled !== agent) emit({ type: 'agent.upsert', runId: summary.id, agent: settled })
        }
      }
    }

    active.emit = emit
    emit({ type: 'run.status', runId: summary.id, status: 'starting' })
    if (notice) emit({ type: 'log', runId: summary.id, level: 'info', message: notice })
    if (carriedPlan && kind === 'work') emit({ type: 'plan.updated', runId: summary.id, plan: { ...structuredClone(carriedPlan), autoContinues: 0 } })
    // Advisory title from the fast model; never awaited, never fails the run.
    // The harness's own resume message is never titled (the continued run's title is carried instead).
    if (kind === 'work' && !summary.title && prompt.trim() && prompt.trim() !== RESUME_TEXT.trim()) {
      void this.titleRun(active, adapter, {
        prompt,
        cwd: project.path,
        model: this.options.fastModel?.(project, choice) ?? (choice.adapter === 'claude' ? 'haiku' : undefined),
        connection,
        ...(titleContext ? { continues: titleContext } : {})
      })
    }

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
      const runScoped = active.runServers.get(spec.id)
      const extra = runScoped?.secrets
      // A server approved for this run only never reads stored secrets or OAuth tokens: only what the user typed.
      if (mcp && !runScoped) return mcp.resolve(live.id, spec, extra)
      const env = { ...(spec.env ?? {}) }
      const headers = { ...(spec.headers ?? {}) }
      for (const n of spec.secretEnv ?? []) if (extra?.[n]) env[n] = extra[n]
      for (const n of spec.secretHeaders ?? []) if (extra?.[n]) headers[n] = extra[n]
      return { spec, env, headers }
    }
    /** Servers already warned about in this run: one warning each. */
    const warnedAuth = new Set<string>()
    /** Refresh expiring OAuth tokens before servers resolve; warn once per server that still has no usable token. */
    const prepareServers = async (specs: McpServerSpec[]): Promise<void> => {
      if (!mcp?.prepareForRun || !specs.length) return
      let names: string[] = []
      try {
        names = await mcp.prepareForRun(live.id, specs)
      } catch (e) {
        log.warn(`MCP OAuth preparation failed: ${(e as Error).message}`)
      }
      for (const name of names) {
        if (warnedAuth.has(name)) continue
        warnedAuth.add(name)
        emit({
          type: 'log',
          runId: summary.id,
          level: 'warn',
          message: `MCP server "${name}" needs authorization: open Settings > MCP servers and choose Authorize. It starts without credentials in this run.`
        })
      }
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
      const builtinModel = this.builtinRoleModel(kind, project, choice)
      if (builtinModel?.warning) emit({ type: 'log', runId: summary.id, level: 'warn', message: builtinModel.warning })
      const ctx: RuntimeContext = {
        run: summary,
        project,
        roles: kind === 'setup' ? [architectRole(builtinModel)] : kind === 'mcp-assist' ? [mcpAssistantRole(builtinModel)] : project.roles,
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
        // Setup-like runs (setup, mcp-assist, the harness project) change servers through proposals only.
        ...(setupLike || project.id === HARNESS_PROJECT_ID
          ? {}
          : { requestMcpInstall: (req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>) => this.requestMcpInstall(active, req, () => live, (saved) => (live = { ...saved, path: live.path })) }),
        ...(mcp ? { searchMcpRegistry: (input: McpRegistrySearchInput) => mcp.searchRegistry(input) } : {}),
        mcpServers: allServers,
        ...(setupLike ? { mcpLibrary: libraryEntries } : {}),
        resolveMcpSecrets: async (serverId) => {
          const spec = allServers().find((s) => s.id === serverId)
          if (!spec) return { env: {}, headers: {} }
          await prepareServers([spec])
          const r = resolveOne(spec)
          return {
            env: Object.fromEntries((spec.secretEnv ?? []).filter((n) => r.env[n] !== undefined).map((n) => [n, r.env[n]])),
            headers: Object.fromEntries((spec.secretHeaders ?? []).filter((n) => r.headers[n] !== undefined).map((n) => [n, r.headers[n]]))
          }
        },
        resolvedMcpServers: async () => {
          const specs = allServers()
          await prepareServers(specs)
          return specs.map(resolveOne)
        },
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
          active.limitHold = true
        },
        opusGuardThreshold: this.options.opusGuardThreshold?.(),
        getPlan: () => active.record.plan,
        updatePlan,
        pendingInteractions: () => pendingCount(active),
        autoContinue: project.autoContinue !== false,
        maxAutoContinues: project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
        ...(this.options.continuationDelayMs !== undefined ? { continuationDelayMs: this.options.continuationDelayMs } : {}),
        completeSetup: async (text) => {
          const updated = this.setup.complete(project.id, text)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        }
      }
      active.session = await adapter.start(ctx)
      void active.session.finished.finally(() => this.teardown(active))
    } catch (e) {
      emit({ type: 'run.status', runId: summary.id, status: 'error', error: (e as Error).message })
      // No session will ever finish this run; it must not count as live.
      this.teardown(active)
    }
    return summary
  }

  /**
   * A run's session ended (or never started): settle every card still open, forget run-scoped servers and held
   * peer messages, persist the record and drop the run from the live set.
   */
  private teardown(active: ActiveRun): void {
    const runId = active.summary.id
    // Every waiting card (permissions, proposals, questions, rules, merges, installs) is settled as cancelled.
    cancelPending(active, runId, this.broadcast)
    // A stopped run's pending title is dropped; a run that ended on its own may still get its title afterwards.
    if (active.userStopped) active.titleAbort?.abort()
    // Servers approved for this run only (and their secrets) are forgotten.
    active.runServers.clear()
    // Held peer messages are dropped; their senders are told if they are still live.
    const dropped = active.inbox.splice(0)
    if (dropped.length) {
      const n = dropped.length
      active.emit({ type: 'log', runId, level: 'warn', message: `${n} held message${n === 1 ? '' : 's'} from other runs ${n === 1 ? 'was' : 'were'} not delivered: the run ended first.` })
      for (const m of dropped) {
        this.runs.get(m.fromRunId)?.emit({ type: 'log', runId: m.fromRunId, level: 'warn', message: `Your queued message to run ${runId} was not delivered: that run ended before it resumed.` })
      }
    }
    this.flush(active)
    this.runs.delete(runId)
    this.store.prune(this.keepRunsFor)
  }

  /**
   * Generate the run's title and publish it: summary (index and record), then run.title. Runs after the session may
   * have ended; a run already deleted (project removed, pruned) is left alone. Never throws.
   */
  private async titleRun(
    active: ActiveRun,
    adapter: RuntimeAdapter,
    input: { prompt: string; cwd: string; model?: string; connection?: RunConnection; continues?: string }
  ): Promise<void> {
    const runId = active.summary.id
    // Provider error text is cut short and stripped of the run connection's secret values before it is logged.
    const secrets = [input.connection?.apiKey, ...Object.entries(input.connection?.env ?? {}).filter(([k]) => /TOKEN|KEY|SECRET|PASSWORD/i.test(k)).map(([, v]) => v)]
      .filter((v): v is string => typeof v === 'string' && v.length >= 4)
    const scrub = (m: string): string => secrets.reduce((acc, s) => acc.split(s).join('[redacted]'), m).replace(/\s+/g, ' ').slice(0, 200)
    const abort = new AbortController()
    active.titleAbort = abort
    this.titleAborts.set(abort, active.summary.projectId)
    try {
      const title = await generateRunTitle(adapter, { ...input, signal: abort.signal }, (message) => log.info(`Run ${runId}: no title (${scrub(message)})`))
      if (!title || abort.signal.aborted) return
      const live = this.runs.get(runId) === active
      if (!live && !this.store.get(runId)) return
      active.summary.title = title
      this.store.upsert(active.summary)
      if (live) {
        active.emit({ type: 'run.title', runId, title })
      } else {
        // The session already ended and its record was flushed; record.summary is active.summary, so save it again.
        this.flush(active)
        logRunEvent(active.summary, { type: 'run.title', runId, title })
        this.broadcast({ type: 'run.title', runId, title })
      }
    } catch (e) {
      log.warn(`Run ${runId}: title failed: ${scrub(String((e as Error)?.message ?? e))}`)
    } finally {
      this.titleAborts.delete(abort)
      if (active.titleAbort === abort) active.titleAbort = undefined
    }
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
      case 'run.title':
        // record.summary is the live summary object; this only schedules the save.
        r.summary.title = e.title
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

  /**
   * runs:pendingCards: the decision cards a run is waiting on, the objects its `*.request` events carried, so a
   * fresh renderer can show them. Empty for an unknown or ended run (the end cancels every card).
   */
  pendingCards(runId: string): PendingCards {
    const active = this.runs.get(runId)
    return active ? listPending(active) : emptyPending()
  }

  // ---------- cross-run messaging ----------

  /**
   * list_runs: every other live work run, across projects, oldest first. A setup-like caller sees none. A peer's
   * prompt is shown only when both the caller's and the peer's projects have runMessaging on (else ''), so a project
   * that did not opt in neither reads nor reveals what other runs are doing beyond project, status and orchestrator.
   */
  private listRunsFor(self: ActiveRun): RunPeer[] {
    if (isSetupLikeRun(self.summary.kind)) return []
    const selfOn = this.messagingOn(self)
    return [...this.runs.values()]
      .filter((a) => a !== self && a.summary.kind === 'work' && isOpenStatus(a.summary.status))
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
      .map((a) => ({
        runId: a.summary.id,
        projectId: a.summary.projectId,
        projectName: a.projectName,
        kind: a.summary.kind,
        status: a.summary.status,
        prompt: selfOn && this.messagingOn(a) ? excerpt(a.summary.prompt, RUN_PEER_PROMPT_CHARS) : '',
        startedAt: a.summary.startedAt,
        rootRole: a.rootRole,
        live: true,
        messaging: this.messagingOn(a)
      }))
  }

  /** message_run: see RuntimeContext.messageRun. Both runs record the exchange through their own emit. */
  private async messageRun(sender: ActiveRun, targetId: string, rawText: string): Promise<RunMessageOutcome> {
    const text = (typeof rawText === 'string' ? rawText : '').trim().slice(0, RUN_MESSAGE_MAX_CHARS)
    if (isSetupLikeRun(sender.summary.kind)) return { result: 'refused', refusal: 'not-work' }
    if (targetId === sender.summary.id) return { result: 'refused', refusal: 'self' }
    if (!text) return { result: 'refused', refusal: 'empty' }
    const target = this.runs.get(targetId)
    const stored = target ? undefined : this.store.get(targetId)
    if (!target && !stored) return { result: 'not-found' }
    const targetSummary = target?.summary ?? stored!
    if (isSetupLikeRun(targetSummary.kind)) return { result: 'refused', refusal: 'not-work' }
    // An ended run is just not live; checking its project's flag would name a project the caller cannot list.
    if (!target) return { result: 'not-live' }
    // Opt-in per project (Project.runMessaging): both ends must allow it; one project only needs its own flag.
    const off: string[] = []
    if (!this.messagingOn(sender)) off.push(sender.projectName)
    if (target.summary.projectId !== sender.summary.projectId && !this.messagingOn(target)) off.push(target.projectName)
    if (off.length) return { result: 'refused', refusal: 'messaging-off', offProjects: off }
    const sent = sender.messagesSent.get(targetId) ?? 0
    if (sent >= RUN_MESSAGE_LIMIT) return { result: 'refused', refusal: 'cap', cap: 'pair' }
    const session = target?.session
    if (!target || !isOpenStatus(target.summary.status) || !session?.receive) return { result: 'not-live' }
    if (target.messagesReceived >= RUN_MESSAGE_INBOUND_LIMIT) return { result: 'refused', refusal: 'cap', cap: 'inbound' }
    // A peer never overrides the user: a run the user interrupted, a usage-limited run and a run waiting on a card
    // keep the message until the user resumes it (send) or answers the last card. Messages already held stay ahead.
    const waiting = this.deliveryBlocked(target) !== null || target.inbox.length > 0
    if (waiting && target.inbox.length >= RUN_MESSAGE_QUEUE_LIMIT) return { result: 'refused', refusal: 'busy' }

    sender.messagesSent.set(targetId, sent + 1)
    target.messagesReceived++
    const at = Date.now()
    const from = sender.summary
    const to = target.summary
    const message: QueuedPeerMessage = {
      fromRunId: from.id,
      fromProjectId: from.projectId,
      fromProjectName: sender.projectName,
      fromPrompt: excerpt(from.prompt, RUN_PEER_PROMPT_CHARS),
      text,
      at
    }
    const toPrompt = excerpt(to.prompt, RUN_PEER_PROMPT_CHARS)
    sender.emit({ type: 'run.message', runId: from.id, direction: 'out', peerRunId: to.id, peerProjectId: to.projectId, peerProjectName: target.projectName, peerPrompt: toPrompt, text, at })
    if (waiting) {
      target.inbox.push(message)
      systemBlock(sender, at, `Queued for run ${to.id} (${target.projectName}: ${toPrompt}) until it resumes; it is waiting on its user: ${text}`)
      sender.emit({ type: 'log', runId: from.id, level: 'info', message: `Queued a message for run ${to.id} (${target.projectName}); it is waiting on its user.` })
      target.emit({ type: 'log', runId: to.id, level: 'info', message: `Holding a message from run ${from.id} (${sender.projectName}) until this run resumes.` })
      return { result: 'queued' }
    }
    systemBlock(sender, at, `Sent to run ${to.id} (${target.projectName}: ${toPrompt}): ${text}`)
    sender.emit({ type: 'log', runId: from.id, level: 'info', message: `Messaged run ${to.id} (${target.projectName}).` })
    // Through the inbox, behind any flush in progress, so a direct message never overtakes held ones.
    target.inbox.push(message)
    await this.flushInbox(target)
    if (message.delivered === true) return { result: 'delivered' }
    // The session never answered: busy if the run is still live, otherwise just gone.
    if (message.timedOut) return this.runs.get(targetId) === target ? { result: 'refused', refusal: 'timeout' } : { result: 'not-live' }
    // Still waiting: the run became blocked before its turn came. Gone without an attempt: the run ended.
    if (message.delivered === undefined && target.inbox.includes(message)) return { result: 'queued' }
    return { result: 'not-live' }
  }

  /** Why a peer message must wait for this run's user now, or null (continuation.peerDeliveryBlocked). */
  private deliveryBlocked(a: ActiveRun): string | null {
    return peerDeliveryBlocked({ held: a.held, rateLimited: !!a.limitHold, pendingInteractions: pendingCount(a) })
  }

  /**
   * Hand one peer message to the recipient's session and record the receiving side (run.message 'in', transcript
   * block, log) at delivery time. False when the session could not take it; both runs get a warning.
   */
  private async deliverPeerMessage(target: ActiveRun, m: QueuedPeerMessage): Promise<boolean> {
    const to = target.summary
    const session = target.session
    const sender = this.runs.get(m.fromRunId)
    if (!session?.receive || !isOpenStatus(to.status)) {
      sender?.emit({ type: 'log', runId: m.fromRunId, level: 'warn', message: `Run ${to.id} could not receive the message: it is no longer live.` })
      return false
    }
    const at = Date.now()
    // The recipient's block goes first so its transcript reads in order even if receive() wakes the root at once.
    target.emit({ type: 'run.message', runId: to.id, direction: 'in', peerRunId: m.fromRunId, peerProjectId: m.fromProjectId, peerProjectName: m.fromProjectName, peerPrompt: m.fromPrompt, text: m.text, at })
    systemBlock(target, at, `Note from run ${m.fromRunId} (${m.fromProjectName}: ${m.fromPrompt}), from its orchestrator: ${m.text}`)
    target.emit({ type: 'log', runId: to.id, level: 'info', message: `Received a message from run ${m.fromRunId} (${m.fromProjectName}).` })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), RUN_MESSAGE_RECEIVE_TIMEOUT_MS)
    })
    try {
      const receiving = session.receive({ fromRunId: m.fromRunId, fromProjectName: m.fromProjectName, fromPrompt: m.fromPrompt, text: m.text })
      // A receive that settles after the timeout must not surface as an unhandled rejection.
      receiving.catch(() => undefined)
      if ((await Promise.race([receiving.then(() => 'ok' as const), timeout])) === 'timeout') {
        m.timedOut = true
        const secs = Math.round(RUN_MESSAGE_RECEIVE_TIMEOUT_MS / 1000)
        sender?.emit({ type: 'log', runId: m.fromRunId, level: 'warn', message: `Run ${to.id} did not accept the message within ${secs}s; it may be busy.` })
        target.emit({ type: 'log', runId: to.id, level: 'warn', message: `Taking the message from run ${m.fromRunId} did not finish within ${secs}s; moving on.` })
        return false
      }
      return true
    } catch (e) {
      const message = (e as Error).message
      sender?.emit({ type: 'log', runId: m.fromRunId, level: 'warn', message: `Run ${to.id} could not receive the message: ${message}` })
      target.emit({ type: 'log', runId: to.id, level: 'warn', message: `Could not take the message from run ${m.fromRunId}: ${message}` })
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Deliver held peer messages, oldest first, while nothing makes the run wait on its user. */
  private flushInbox(a: ActiveRun): Promise<void> {
    const drain = async (): Promise<void> => {
      while (a.inbox.length && this.deliveryBlocked(a) === null && this.runs.get(a.summary.id) === a) {
        const m = a.inbox.shift()!
        m.delivered = await this.deliverPeerMessage(a, m)
      }
    }
    // Chained: a flush started while another runs waits for it, so messages leave strictly oldest first.
    const next = (a.flushing ?? Promise.resolve()).then(drain).catch((e: unknown) => log.warn(`Peer message flush failed: ${(e as Error)?.message ?? e}`))
    a.flushing = next
    void next.finally(() => {
      if (a.flushing === next) a.flushing = undefined
    })
    return next
  }

  /** A card was answered: if it was the last one and the run is not held, deliver held peer messages. */
  private cardSettled(a: ActiveRun): void {
    if (a.inbox.length) void this.flushInbox(a)
  }

  /** Project.runMessaging of a run's project, read from the current saved project when possible. */
  private messagingOn(a: ActiveRun): boolean {
    const current = this.options.resolveProject?.(a.summary.projectId)
    return current ? runMessagingOn(current) : a.messagingAtStart
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
      active.pending.set(request.id, {
        request,
        resolve: (decision) => {
          logPermission(active.summary, request, decision)
          resolve(decision)
        }
      })
      this.broadcast({ type: 'permission.request', runId: active.summary.id, request })
    })
  }

  decide(runId: string, requestId: string, decision: PermissionDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pending.get(requestId)
    if (!active || !pending) return
    active.pending.delete(requestId)
    pending.resolve(decision)
    this.broadcast({ type: 'permission.resolved', runId, requestId })
    this.cardSettled(active)
  }

  private requestProposal(
    active: ActiveRun,
    req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>,
    onApplied?: (saved: Project) => void
  ): Promise<ProposalDecision> {
    const proposal = { ...req, id: newId('prop'), runId: active.summary.id, createdAt: Date.now() } as Proposal
    return new Promise((resolve) => {
      active.pendingProposals.set(proposal.id, { proposal, resolve: (decision) => {
        if (decision.behavior === 'approve') {
          try {
            if (active.summary.projectId === HARNESS_PROJECT_ID) {
              // The harness project is virtual: its proposals change the MCP library only, never a stored project.
              if (proposal.kind !== 'mcpServers') throw new Error('Only MCP library proposals can be applied here.')
              this.setup.applyLibraryProposal(proposal.payload as McpServersProposalPayload)
            } else {
              const updated = this.setup.applyProposal(active.summary.projectId, proposal)
              onApplied?.(updated)
              this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
            }
          } catch (e) {
            const message = (e as Error).message
            logRunEvent(active.summary, { type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            this.broadcast({ type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            resolve({ behavior: 'revise', feedback: `The harness could not apply this proposal: ${message}` })
            return
          }
        }
        resolve(decision)
      } })
      this.broadcast({ type: 'proposal.request', runId: active.summary.id, proposal })
    })
  }

  decideProposal(runId: string, proposalId: string, decision: ProposalDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingProposals.get(proposalId)
    if (!active || !pending) return
    active.pendingProposals.delete(proposalId)
    pending.resolve(decision)
    this.broadcast({ type: 'proposal.resolved', runId, proposalId, decision })
    this.cardSettled(active)
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
    this.cardSettled(active)
  }

  private requestMergeReview(
    active: ActiveRun,
    req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>
  ): Promise<MergeDecision> {
    const review: MergeReview = { ...req, id: newId('merge'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingMerges.set(review.id, { review, resolve })
      this.broadcast({ type: 'merge.request', runId: active.summary.id, review })
    })
  }

  decideMerge(runId: string, reviewId: string, decision: MergeDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingMerges.get(reviewId)
    if (!active || !pending) return
    active.pendingMerges.delete(reviewId)
    pending.resolve(decision)
    this.broadcast({ type: 'merge.resolved', runId, reviewId, decision })
    this.cardSettled(active)
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
    this.cardSettled(active)
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
        resolve: (raw, cancelled) => {
          const decision = this.settleInstall(active, request, raw, getProject(), setProject)
          // Secrets stop here: the agent and the renderer only ever see the outcome.
          const outcome: McpInstallOutcome = {
            approved: decision.approved,
            scope: decision.scope,
            ...(decision.note ? { note: decision.note } : {}),
            ...(decision.spec ? { spec: decision.spec } : {})
          }
          this.broadcast({ type: 'mcpInstall.resolved', runId: active.summary.id, requestId: request.id, outcome, ...(cancelled ? { cancelled: true as const } : {}) })
          resolve(outcome)
        }
      })
      this.broadcast({ type: 'mcpInstall.request', runId: active.summary.id, request })
    })
  }

  /** Validate an install answer and apply it (save the server or keep it for this run). Never throws. */
  private settleInstall(active: ActiveRun, request: McpInstallRequest, raw: McpInstallDecision, project: Project, setProject: (saved: Project) => void): McpInstallDecision {
    const scope = raw?.scope === 'project' ? 'project' : raw?.scope === 'library' ? 'library' : 'run'
    const note = typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 600) : undefined
    if (!raw?.approved) return { approved: false, scope, ...(note ? { note } : {}) }
    const refuse = (why: string): McpInstallDecision => ({ approved: false, scope, note: `The harness did not install it: ${why}` })
    if (project.id === HARNESS_PROJECT_ID) return refuse('installs are not available in a harness session; propose library entries instead.')
    if (raw.spec !== undefined && (!raw.spec || typeof raw.spec !== 'object' || raw.spec.id !== request.spec.id)) return refuse('the edited server must keep the requested id.')
    const id = request.spec.id
    const taken =
      (project.mcpServers ?? []).some((s) => s.id === id) ||
      active.runServers.has(id) ||
      !!this.options.mcp?.libraryEntries?.().some((e) => e.id === id)
    if (taken) return refuse('a server with that id already exists.')
    const spec = mergeInstallEdit(request.spec, raw.spec)
    const others = [...(project.mcpServers ?? []), ...[...active.runServers.values()].map((r) => r.spec)]
    const errors = validateSpec(spec, others)
    if (errors.length) return { approved: false, scope, note: `The harness did not install it: ${errors.join(' ')}` }
    const secrets: Record<string, string> = {}
    for (const n of mcpSecretNames(spec)) {
      const v = raw.secrets?.[n]
      if (typeof v === 'string' && v) secrets[n] = v
    }
    if (scope !== 'run' && this.options.mcp) {
      try {
        const saved = this.options.mcp.persistInstall(project.id, spec, secrets, scope)
        setProject(saved)
        this.broadcast({ type: 'project.updated', runId: active.summary.id, project: saved })
      } catch (e) {
        return { approved: false, scope, note: `The harness could not save the server: ${(e as Error).message}` }
      }
    } else {
      active.runServers.set(spec.id, { spec, secrets })
    }
    return { approved: true, scope: scope !== 'run' && this.options.mcp ? scope : 'run', ...(note ? { note } : {}), ...(raw.spec ? { spec } : {}) }
  }

  /** Answer a request_mcp_install card (mcp:answerInstall). Unknown or already answered requests are ignored. */
  answerMcpInstall(runId: string, requestId: string, decision: McpInstallDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingInstalls.get(requestId)
    if (!active || !pending) return
    active.pendingInstalls.delete(requestId)
    pending.resolve(decision)
    this.cardSettled(active)
  }

  async send(runId: string, text: string, rawImages?: ImageAttachment[]): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) throw new Error('Run is not active')
    const images = sanitizeImages(rawImages, (m) => log.warn(m))
    if (!hasContent(text, images)) throw new Error('Nothing to send')
    active.emit({ type: 'run.status', runId, status: 'running' })
    // The user's message lifts an interrupt's hold (as ContinuationDriver.userMessage does in the adapter); peer
    // messages held meanwhile follow it, so the orchestrator reads the user first. A usage-limit hold lifts too.
    // Both are cleared only once the session took the message: a failed send leaves the run held. The user's send
    // never waits on peer delivery: the flush runs on its own (flushInbox catches and logs its errors).
    await active.session.send(text, images.length ? images : undefined)
    active.held = false
    active.limitHold = false
    void this.flushInbox(active)
  }

  /** Interrupt the turn. Until the user's next message, peer messages are held (as automatic continues are). */
  async interrupt(runId: string): Promise<void> {
    const active = this.runs.get(runId)
    if (active?.session) active.held = true
    await active?.session?.interrupt()
  }

  async stop(runId: string): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) return
    active.userStopped = true
    active.titleAbort?.abort()
    active.emit({ type: 'run.status', runId, status: 'stopping' })
    await active.session.stop()
  }

  async stopAll(): Promise<void> {
    for (const runId of [...this.resumeTimers.keys()]) this.clearResume(runId)
    for (const r of this.runs.values()) r.userStopped = true
    // Titles still pending for runs that already ended are cancelled too (app quit).
    for (const a of this.titleAborts.keys()) a.abort()
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
      // The harness's own resume message is not a new task: keep the title of the run it continues.
      // A follow-up is titled with the task it continues as context, so it stays recognisable.
      ...(prompt === RESUME_TEXT.trim() && target.title
        ? { title: target.title }
        : { titleContext: target.title ?? excerpt(target.prompt, 200) }),
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
