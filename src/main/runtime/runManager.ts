import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type {
  AgentInstance,
  RunUsage,
  UsageStats,
  UsageStatsQuery,
  AppSettings,
  AdapterChoice,
  ModelPrice,
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
  ProjectPeek,
  QuickRunInfo,
  SkillContent,
  Proposal,
  ProposalDecision,
  ProposalOutcome,
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
  RunSurface,
  SkillUseCount,
  UserQuestion
} from '@shared/types'
import { QUICK_ASSISTANT_SLUG, adapterForProject, agentProducedNothing, mcpSecretNames, mixedFamilyRefusal, modelFamily, newId, projectConnection, runMessagingOn, settingTier } from '@shared/defaults'
import { aliasesFor, priceAgentUsage, type PricingContext } from './pricing'
import { IntervalTimer, buildUsageStats, computeRunUsage, emptyAgentUsage, legacySummaryUsage, normalizeRunRecord } from './runUsage'
import { DEFAULT_MAX_AUTO_CONTINUES, HARNESS_PROJECT_ID, QUICK_PROJECT_ID, RUN_MESSAGE_MAX_CHARS, RUN_PEER_PROMPT_CHARS, SKILLS_PROJECT_ID, USAGE_STATS_DEFAULT_LIMIT, USAGE_STATS_MAX_LIMIT, isVirtualProjectId } from '@shared/types'
import { architectRole, mcpAssistantRole, skillAssistantRole } from '@shared/setup'
import { isTrustRestrictedRun, isInsideEither, samePath, canonicalDeep } from '../quick/scratch'
import { MCP_ASSIST_MODEL_LABEL, QUICK_RUN_MODEL_LABEL, SETUP_MODEL_LABEL, SKILL_ASSIST_MODEL_LABEL, resolveBuiltinModel, type ResolvedBuiltinModel } from './builtinModel'
import { ROOT_AGENT_ID, isSetupLikeRun, type CompletionInput, type ResolvedMcpServer, type RunMessageOutcome, type RunConnection, type RunSkill, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type SkillAssistCatalog } from './types'
import type { SkillRunSource } from '../skills/types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { log, logPermission, logRunEvent } from '../log'
import { hasContent, sanitizeImages } from './attachments'
import { breakParentCycles } from './agentTree'
import { describePlanChange, peerDeliveryBlocked, planNudgesApply } from './continuation'
import { isLiveAgent, runOutcome, settleAgent, withSkillActivity, type RunOutcome } from './activity'
import { cancelPending, cleanProposalDecision, emptyPending, listPending, proposalEffect, proposalOutcome, type PendingCardMaps } from './pendingCards'
import { addRules, isBlanketAllowRule, isUnsafeAllowRule, listRules, tooBroadRuleRefusal } from './permissionRules'
import { allowedDirectoryRisk } from './allowedDirectories'
import { isValidRule } from './ruleMatch'
import { validateSpec } from '../mcp/validate'
import { assistContext, buildToolsFor } from '../mcp/assist'
import { skillAssistContext } from '../skills/assist'
import { generateRunTitle } from '../ai/runTitle'

/** The path as the file system spells it (true case on Windows). Falls back to the input when it cannot be resolved. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** Result of resolveAllowedDirectories. */
export interface ResolvedAllowedDirectories {
  /** Existing directories, canonical, deduped: what the run may use. */
  dirs: string[]
  /** Entries that do not exist or are not directories (as given). */
  missing: string[]
  /** Entries left out on purpose: OrgAI's data folder (either direction) or the project folder itself / inside it. */
  dropped: string[]
  /** The subset of `dropped` left out as too broad or sensitive (home, a folder holding the project, ~/.ssh ...). */
  unsafe: string[]
}

/** OrgAI's data folder in both spellings (deduped); empty without a data dir. */
export function protectedDirsOf(dataDir: string | undefined): string[] {
  if (!dataDir) return []
  return [...new Set([dataDir, canonicalDeep(dataDir)])]
}

/**
 * Resolve `Project.allowedDirectories` for one run. Keeps existing directories only (canonical spelling), drops any
 * that sit inside OrgAI's data dir or contain it, drops the project folder and anything inside it (already free),
 * and dedupes. `dataDir` is optional for tests only: without it the data-dir check is skipped.
 */
export function resolveAllowedDirectories(raw: readonly unknown[] | undefined, opts: { projectPath: string; dataDir?: string; home?: string }): ResolvedAllowedDirectories {
  const out: ResolvedAllowedDirectories = { dirs: [], missing: [], dropped: [], unsafe: [] }
  const denied = protectedDirsOf(opts.dataDir)
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const given = entry.trim()
    let isDir = false
    try {
      isDir = statSync(resolvePath(given)).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      out.missing.push(given)
      continue
    }
    const canon = canonicalPath(resolvePath(given))
    if (opts.dataDir && (isInsideEither(opts.dataDir, canon) || isInsideEither(canon, opts.dataDir))) {
      out.dropped.push(given)
      continue
    }
    if (isInsideEither(opts.projectPath, canon)) {
      out.dropped.push(given)
      continue
    }
    // The static rules (allowedDirectories.ts, shared with ProjectStore's save-time clean), on the canonical path.
    // Both spellings of home and the project (a junction or symlink in either must not hide a containing folder).
    const home = opts.home ?? homedir()
    const both = (p: string): string[] => {
      try {
        return [...new Set([p, canonicalDeep(p)])]
      } catch {
        return [p]
      }
    }
    const homes = both(home)
    const projects = both(opts.projectPath)
    const risks = homes.flatMap((h) => projects.map((projectPath) => allowedDirectoryRisk(canon, { projectPath, deniedDirs: denied, home: h })))
    const risk = risks.includes('project') ? 'project' : risks.find((r) => r !== null) ?? null
    if (risk === 'project') {
      out.dropped.push(given)
      continue
    }
    if (risk) {
      out.dropped.push(given)
      out.unsafe.push(given)
      continue
    }
    if (out.dirs.some((d) => samePath(d, canon))) continue
    out.dirs.push(canon)
  }
  return out
}

const FLUSH_INTERVAL_MS = 1500
/** Most skill loads one run counts (RunUsage.skills, transcript rows); later skill.used events are dropped. */
export const RUN_SKILL_LOAD_LIMIT = 1000
/** run.usage events (and the index save that goes with them) are published at most this often per run. */
export const USAGE_THROTTLE_MS = 1000
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

/** Any decision card open on the run (the user's turn). */
function hasOpenCard(r: PendingCardMaps): boolean {
  return (
    r.pending.size > 0 ||
    r.pendingProposals.size > 0 ||
    r.pendingQuestions.size > 0 ||
    r.pendingMerges.size > 0 ||
    r.pendingInstalls.size > 0 ||
    r.pendingRules.size > 0
  )
}

/**
 * A run.status event with the summary's endedBy / endedWhile: on 'finished' / 'error' when the summary has them, on
 * 'stopping' only with endedBy 'user'. Any an adapter put on the event are dropped (RunManager is their only source).
 */
export function withEndFacts(e: Extract<RunEvent, { type: 'run.status' }>, s: Pick<RunSummary, 'endedBy' | 'endedWhile'>): Extract<RunEvent, { type: 'run.status' }> {
  const { endedBy: _by, endedWhile: _while, ...rest } = e
  const terminal = e.status === 'finished' || e.status === 'error'
  if (terminal && s.endedBy) return { ...rest, endedBy: s.endedBy, ...(s.endedBy === 'app' && s.endedWhile ? { endedWhile: s.endedWhile } : {}) }
  if (e.status === 'stopping' && s.endedBy === 'user') return { ...rest, endedBy: 'user' }
  return rest
}

/** RunSummary.endedWhile for a run cut by the app: idle or an open card is 'waiting', live work 'working', paused none. */
export function quitEndedWhile(status: RunSummary['status'], openCard: boolean): 'working' | 'waiting' | undefined {
  if (status === 'paused' || status === 'finished' || status === 'error') return undefined
  if (status === 'idle' || openCard) return 'waiting'
  return 'working'
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
  /** Who cut the session (RunSummary.endedBy): 'user' from stop(), 'app' from stopAll({ reason: 'quit' }). The first one wins. */
  endedBy?: 'user' | 'app'
  /** With endedBy 'app': what the run was doing when the quit began (RunSummary.endedWhile). Read before stopping. */
  endedWhile?: 'working' | 'waiting'
  /** The session.stop() call in flight (stopSession), so End session, quit and a late start share one stop. */
  stopCall?: Promise<void>
  /** Cancels a pending title query (user stop, project removal, app quit). A natural end lets the title land. */
  titleAbort?: AbortController
  /** Set by the terminal run.status; later agent upserts are relabeled with settleAgent. */
  outcome?: RunOutcome
  /** The adapter driving this run (Proposal.effect). */
  adapter?: ProviderId
  /** Agents still live when the run ended; they read Stopped / Failed however the adapter re-reports them. */
  cutOff?: Set<string>
  /** The provider session this run resumes; known before the adapter reports summary.sessionId at init. */
  resumeSessionId?: string
  /** The run's own emit (records, persists, logs and broadcasts); send() and stop() route through it so summary.status stays current. */
  emit: (e: RunEvent) => void
  /** The adapter's last run.cost total (the provider's own figure; resume base already subtracted). */
  providerTotalUsd?: number
  /** The run's skills, read once at start (RuntimeContext.skills). skill.used events for any other id are dropped. */
  skills: RunSkill[]
  /** Counted skill loads by skill id (RunUsage.skills) and their total (capped at RUN_SKILL_LOAD_LIMIT). */
  skillCounts: Map<string, SkillUseCount>
  skillLoads: number
  /** Time with at least one decision card open. */
  waiting: IntervalTimer
  /** Time held on a usage limit, until the user's next send or the run's end. */
  limitTimer: IntervalTimer
  /** Time in status 'idle'. */
  idleTimer: IntervalTimer
  /** Trailing timer for the throttled run.usage event. */
  usageTimer?: ReturnType<typeof setTimeout>
  /** When run.usage was last published (epoch ms; 0 = never). */
  lastUsageAt: number
  /** summary.usage changed since it was last published and saved. */
  usageDirty: boolean
  /** The last published usage without its timestamp; an identical recompute is not sent again. */
  lastUsageKey?: string
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

/**
 * A priced copy of an agent for agent.upsert: usage priced (a live agent the adapter gave no usage starts empty: its
 * legacy cost field is an adapter estimate and must not read as the provider's), producedNothing set from the agent's final state and the legacy costUsd mirrored. Never mutates the input.
 */
function priceAgent(agent: AgentInstance, ctx: PricingContext): AgentInstance {
  const priced = priceAgentUsage(agent.usage ?? emptyAgentUsage(), ctx)
  if (agentProducedNothing(agent)) priced.producedNothing = true
  else delete priced.producedNothing
  return { ...agent, usage: priced, costUsd: priced.costUsd ?? 0 }
}

/** An allowBuild MCP assistant session (RunSummary.buildWorkspace) also gets Edit, Write and Bash; every call asks. */
function withBuildTools(role: Role, run: Pick<RunSummary, 'kind' | 'buildWorkspace'>): Role {
  const extra = buildToolsFor(run)
  return extra.length ? { ...role, tools: [...new Set([...role.tools, ...extra])] } : role
}

const USAGE_KINDS: readonly RunKind[] = ['work', 'setup', 'mcp-assist', 'skill-assist']

/** runs:usageStats input from the renderer: finite times, known kinds (default work), known bucket. */
function sanitizeUsageQuery(raw: UsageStatsQuery): UsageStatsQuery & { kinds: RunKind[] } {
  const q = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageStatsQuery>
  const kinds = Array.isArray(q.kinds) ? [...new Set(q.kinds.filter((k): k is RunKind => (USAGE_KINDS as readonly unknown[]).includes(k)))] : []
  const out: UsageStatsQuery & { kinds: RunKind[] } = {
    projectId: typeof q.projectId === 'string' ? q.projectId : '',
    kinds: kinds.length ? kinds : ['work'],
    bucket: q.bucket === 'week' ? 'week' : 'day'
  }
  if (typeof q.since === 'number' && Number.isFinite(q.since)) out.since = q.since
  if (typeof q.until === 'number' && Number.isFinite(q.until)) out.until = q.until
  const limit = typeof q.limit === 'number' && Number.isFinite(q.limit) ? Math.floor(q.limit) : USAGE_STATS_DEFAULT_LIMIT
  out.limit = Math.min(USAGE_STATS_MAX_LIMIT, Math.max(1, limit))
  return out
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
  /** OrgAI's data dir, for the allowed-folder checks. Tests may omit it (the data-dir check is then skipped). */
  dataDir?: string
  /**
   * Save permission changes made from a card onto the stored project (index.ts: ProjectStore.update, which cleans
   * allowedDirectories). `addDirectories` are appended, never replacing; `acceptEdits` sets permissionMode
   * 'acceptEdits'. Returns the saved project. Missing = RuntimeContext.allowDirectories / acceptEditsForProject absent.
   */
  saveProjectPermissions?: (projectId: string, patch: { addDirectories?: string[]; acceptEdits?: true }) => Project
  /** The current project for a run being resumed automatically. */
  resolveProject?: (projectId: string) => Project | null | undefined
  /** App setting passed to adapters (see RuntimeContext.opusGuardThreshold). */
  opusGuardThreshold?: () => number
  /** Community model prices (communityPrices.ts); undefined when the setting is off or nothing is cached. */
  communityPrices?: () => Record<string, ModelPrice> | undefined
  /** Delay between a turn ending and the automatic-continue check (RuntimeContext.continuationDelayMs). */
  continuationDelayMs?: number
  /** The model catalog used to decide which adapter a LiteLLM project runs on (adapterForProject). Default: empty. */
  catalog?: () => ProviderModel[]
  /**
   * App settings for the built-in roles' models (setupModel, mcpAssistModel) and the connections' tier mappings.
   * Missing = the built-in roles use the 'deep' tier on the run's connection.
   */
  appSettings?: () => Pick<AppSettings, 'setupModel' | 'mcpAssistModel' | 'connections'> &
    Partial<Pick<AppSettings, 'modelPrices' | 'communityPrices' | 'skillAssistModel' | 'quickRunModel'>>
  /** How a run reaches its models; errors become start errors. Missing = no RuntimeContext.connection. */
  resolveConnection?: (project: Project, choice: AdapterChoice) => RunConnection
  /**
   * The connection's fast-tier model for one-shot helpers (run titles). Missing or undefined = the adapter's
   * default model.
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
    /** Enabled servers `enabledServers` left out because a secret slot has no value (the run warns once each). */
    skippedServers?(project: Project): { name: string; missing: string[] }[]
    /** The app-wide MCP library (secret-free), for setup-like runs. */
    libraryEntries?(): McpLibraryEntry[]
    /**
     * Store an approved MCP proposal's typed secret values (ProposalDecision.secrets) and return the names of its
     * servers still waiting for a secret (McpService.storeProposalSecrets). projectId null = library session.
     */
    storeProposalSecrets?(projectId: string | null, payload: McpServersProposalPayload, values: Record<string, string> | undefined): string[]
  }
  /** Project skills for work runs (SkillService, RuntimeContext.skills). Missing = runs have no skills. */
  skills?: SkillRunSource
  /**
   * The project of a quick run being resumed or continued, rebuilt from its summary.quick (QuickRunService.projectFor).
   * Missing = a paused quick run cannot auto-resume.
   */
  quickProject?: (summary: RunSummary) => Project | null | undefined
  /** The project of an MCP assistant build session being auto-resumed (workspace checked); throws when it is gone. */
  buildProject?: (summary: RunSummary) => Project | null | undefined
  /** list_projects for quick runs only (RuntimeContext.listProjects): stored projects, never virtual ones. */
  listProjects?: () => ProjectPeek[]
  /**
   * The Skill assistant's view of the skills (RuntimeContext.skillCatalog / readSkill). `projectId` is null on the
   * virtual SKILLS_PROJECT_ID (library scope). Missing = the skill tools report the library as unavailable.
   */
  skillAssist?: {
    catalog(projectId: string | null): SkillAssistCatalog
    read(projectId: string | null, ref: { libraryId?: string; skillId?: string }): SkillContent | null
  }
}

/** RunManager.completeForProject input: a one-shot completion on the project's own connection. */
export interface ProjectCompletionInput {
  system: string
  prompt: string
  kind: NonNullable<CompletionInput['kind']>
  /** Which tier of the project's connection answers. 'fast' uses RunManagerOptions.fastModel like run titles. */
  tier: 'fast' | 'everyday'
  signal?: AbortSignal
  onUsage?: CompletionInput['onUsage']
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
/** A project or role name for one log line: control characters become spaces, at most 80 chars. */
const logText = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 80)

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
  /** Setup runs only: the UI surface hosting the run (RunSummary.surface); ignored for other kinds. */
  surface?: RunSurface
  /**
   * Quick runs (Chat): how the run was started. Required for, and accepted only with, project QUICK_PROJECT_ID and
   * kind 'work'. Continuations carry it from the run they continue.
   */
  quick?: QuickRunInfo
  /** MCP assistant runs with allowBuild: the per-run scratch dir the session works in (RunSummary.buildWorkspace). */
  buildWorkspace?: string
}

/**
 * Copy the grant fields (Role.mcpServers, Role.skills) of the saved roles onto a running session's roles, matched by id,
 * in place: the adapters hold these objects (role maps, the spawn network, the MCP and Skill gates, agent definitions
 * rebuilt on a restart), so an ungrant or a new grant approved mid-run is in force on the next call. Role identity never
 * changes mid-run: a role an org change added joins on the next run, and a role it removed keeps its start-time
 * definition (and grants) until this run ends. Every other field stays as the run started.
 */
export function refreshRoleGrants(running: Role[], saved: readonly Role[]): void {
  const byId = new Map(saved.map((r) => [r.id, r]))
  for (const role of running) {
    const next = byId.get(role.id)
    if (!next) continue
    if (next.mcpServers) role.mcpServers = [...next.mcpServers]
    else delete role.mcpServers
    if (next.skills) role.skills = [...next.skills]
    else delete role.skills
  }
}

export class RunManager {
  private runs = new Map<string, ActiveRun>()
  /** Paused run id -> its auto-resume timer. Lives only as long as the app process. */
  /** Every pending title query, live run or not, with its project id; stopAll and removeProject abort them. */
  private titleAborts = new Map<AbortController, string>()
  private resumeTimers =new Map<string, ReturnType<typeof setTimeout>>()
  /** Set by stopAll({ reason: 'quit' }) and markQuit: no run starts, continues, resumes or takes a message after it. */
  private quitting = false
  /** adapter.start() calls not yet settled; stopAll waits for them so a session that opens during a quit is stopped. */
  private startsInFlight = new Set<Promise<unknown>>()

  constructor(
    private adapters: Partial<Record<ProviderId, RuntimeAdapter>>,
    private broadcast: (e: RunEvent) => void,
    private store: RunStore,
    private setup: SetupService,
    /** Retention per project; older finished runs are deleted when a run ends. */
    private keepRunsFor: (projectId: string) => number,
    private options: RunManagerOptions = {}
  ) {
    // Card requests and resolutions change how long a run waits on the user (RunUsage.waitingMs).
    const raw = broadcast
    this.broadcast = (e) => {
      raw(e)
      if ('runId' in e && /\.(request|resolved)$/.test(e.type)) {
        const a = this.runs.get(e.runId)
        if (a) a.waiting.set(pendingCount(a) > 0, Date.now())
      }
    }
  }

  /** Drop every run of a deleted project. Live runs are stopped first. */
  async removeProject(projectId: string): Promise<void> {
    // Pending titles of the project's runs, live or already ended, are cancelled.
    for (const [a, pid] of this.titleAborts) if (pid === projectId) a.abort()
    for (const r of this.runs.values()) {
      if (r.summary.projectId === projectId) {
        r.userStopped = true
        await r.session?.stop().catch(() => {})
        if (r.flushTimer) clearTimeout(r.flushTimer)
        if (r.usageTimer) clearTimeout(r.usageTimer)
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
   * A one-shot completion (no tools) on the project's adapter and connection, with the tier's model. For helpers that
   * are not runs (skill evaluation). Resolves with the text and the model used.
   * Model: tier 'fast' is the run-title model (fastModel, else haiku on Claude); 'everyday' is the connection's
   * everyday tier model (AppSettings.connections), else the model of the project's first everyday-tier role, else
   * the adapter's default. Never for the harness project.
   */
  async completeForProject(project: Project, input: ProjectCompletionInput): Promise<{ text: string; model?: string }> {
    if (isVirtualProjectId(project.id)) throw new Error('The harness and the built-in assistant projects have no model connection for completions.')
    const { adapter, choice } = this.choose(project, 'setup')
    const connection = this.options.resolveConnection?.(project, choice)
    let model: string | undefined
    if (input.tier === 'fast') {
      model = this.options.fastModel?.(project, choice) ?? (choice.adapter === 'claude' ? 'haiku' : undefined)
    } else if (choice.adapter !== 'mock') {
      const tiered = this.options.appSettings?.().connections?.[choice.connection]?.tierModels?.everyday
      const fromRole = project.roles.find((r) => r.tier === 'everyday' && r.model !== 'inherit')?.model
      model = (typeof tiered === 'string' && tiered.trim()) || fromRole || undefined
    }
    const text = await adapter.complete({
      system: input.system,
      prompt: input.prompt,
      kind: input.kind,
      cwd: project.path,
      ...(model ? { model } : {}),
      ...(connection ? { connection } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onUsage ? { onUsage: input.onUsage } : {})
    })
    return { text, ...(model ? { model } : {}) }
  }

  /**
   * Pick the adapter for a run (mixedFamilyRefusal decides whether a work run whose roles span model families may
   * start). On LiteLLM a mixed chart starts with one info line naming the roles on another family; setup-like runs
   * use a built-in role and only need the root's adapter.
   */
  private choose(project: Project, kind: RunKind): { adapter: RuntimeAdapter; choice: AdapterChoice } {
    const catalog = this.options.catalog?.() ?? []
    const choice = adapterForProject(project, catalog)
    if (!isSetupLikeRun(kind) && choice.mismatched.length) {
      const bad = choice.mismatched.map((id) => project.roles.find((r) => r.id === id)).filter((r): r is Role => !!r)
      const names = (bad.length ? bad.map((r) => r.name) : choice.mismatched).map((n) => logText(String(n)))
      const families = [...new Set(bad.map((r) => catalog.find((m) => m.id === r.model && m.connection === choice.connection)?.family ?? modelFamily(r.model)))]
      const other = families.length ? families.map((f) => (f === 'other' ? 'non-Claude' : (FAMILY_LABEL[f] ?? f))).join('/') : 'other'
      const where = CONNECTION_LABEL[choice.connection] ?? choice.connection
      const refusal = mixedFamilyRefusal(choice)
      if (refusal === 'no-root-family') {
        throw new Error(
          `Roles ${names.join(', ')} use ${other}-family models, but this ${where} project's orchestrator has no model of its own, so OrgAI cannot tell which runtime to use. Give the orchestrator a model.`
        )
      }
      if (refusal === 'single-family-connection') {
        const rootFamily = choice.family ?? 'claude'
        throw new Error(
          `Roles ${names.join(', ')} use ${other}-family models, but this ${where} project's orchestrator runs on ${FAMILY_LABEL[rootFamily] ?? rootFamily}. Pick models of one family.`
        )
      }
      const rootFamily = choice.family ?? 'claude'
      log.info(
        `${where} project ${logText(project.name)}: the orchestrator runs on ${FAMILY_LABEL[rootFamily] ?? rootFamily}; ${names.join(', ')} use ${other}-family models through the proxy${choice.adapter === 'codex' ? " (on Codex a report whose model is a tier name or a bare Claude alias runs on its parent's model)" : ''}.`
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
    if (!isSetupLikeRun(kind)) return undefined
    const settings = this.options.appSettings?.()
    if (!settings) return undefined
    const setting = kind === 'setup' ? settings.setupModel : kind === 'skill-assist' ? settings.skillAssistModel : settings.mcpAssistModel
    const label = kind === 'setup' ? SETUP_MODEL_LABEL : kind === 'skill-assist' ? SKILL_ASSIST_MODEL_LABEL : MCP_ASSIST_MODEL_LABEL
    return resolveBuiltinModel(setting, label, {
      connection: choice.connection,
      adapter: choice.adapter,
      catalog: this.options.catalog?.() ?? [],
      tierModels: settings.connections?.[choice.connection]?.tierModels ?? {},
      root: project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
    })
  }

  /**
   * A quick run with team 'single': settle the Assistant's model before the adapter is chosen. The role carries the
   * unresolved AppSettings.quickRunModel setting; a tier name is first read through the connection's tier mapping so
   * adapterForProject sees a real model family, then resolveBuiltinModel (fallback tier 'everyday') gives the model the
   * run uses, with a warning when the setting could not be used. Without appSettings (tests) the setting stays as is.
   */
  private resolveQuickAssistant(project: Project): { project: Project; warning?: string } {
    const role = project.roles.find((r) => r.slug === QUICK_ASSISTANT_SLUG && r.reportsTo === null)
    if (!role) return { project }
    const settings = this.options.appSettings?.()
    const connection = projectConnection(project)
    const tierModels = settings?.connections?.[connection]?.tierModels ?? {}
    const tier = settingTier(role.model)
    const hint = tier ? tierModels[tier]?.trim() || 'inherit' : role.model
    const withModel = (model: string, tierName?: Role['tier']): Project => ({
      ...project,
      roles: project.roles.map((r) => {
        if (r !== role) return r
        const { tier: _drop, ...rest } = r
        return { ...rest, model, ...(tierName ? { tier: tierName } : {}) }
      })
    })
    const choice = adapterForProject(withModel(hint), this.options.catalog?.() ?? [])
    if (!settings || choice.adapter === 'mock') return { project: choice.adapter === 'mock' ? project : withModel(hint) }
    const resolved = resolveBuiltinModel(settings.quickRunModel, QUICK_RUN_MODEL_LABEL, {
      connection: choice.connection,
      adapter: choice.adapter,
      catalog: this.options.catalog?.() ?? [],
      tierModels,
      fallbackTier: 'everyday'
    })
    return { project: withModel(resolved.model, resolved.tier), ...(resolved.warning ? { warning: resolved.warning } : {}) }
  }

  /** The session chain of a run (resumedFrom links, shared session ids), live runs with their current summaries. */
  chain(runId: string): RunSummary[] {
    const from = this.summary(runId)
    return from ? this.chainOf(from) : []
  }

  /** The project a stored or live run continues in: a quick run's rebuilt project, else the current saved one. */
  private projectOfRun(run: RunSummary): Project | null | undefined {
    if (run.quick) return this.options.quickProject?.(run)
    if (run.buildWorkspace) return this.options.buildProject?.(run)
    return this.options.resolveProject?.(run.projectId)
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
    titleContext,
    surface,
    quick,
    buildWorkspace
  }: StartInput): Promise<RunSummary> {
    this.refuseWhileQuitting()
    // Each virtual project belongs to exactly one kind of run.
    if (project.id === HARNESS_PROJECT_ID && kind !== 'mcp-assist') throw new Error('Only the MCP assistant can run on the harness project.')
    if (project.id === SKILLS_PROJECT_ID && kind !== 'skill-assist') throw new Error('Only the Skill assistant can run on the skills project.')
    if (project.id === QUICK_PROJECT_ID && (kind !== 'work' || !quick)) throw new Error('Only a quick run can run on the quick project.')
    if (quick && project.id !== QUICK_PROJECT_ID) throw new Error('Quick run details belong to the quick project only.')
    if (buildWorkspace && kind !== 'mcp-assist') throw new Error('A build workspace belongs to an MCP assistant run.')
    // Linked MCP servers come from the library as it is now (a deleted entry disables its links).
    project = this.options.mcp?.withLibrary?.(project) ?? project
    // The Chat's single assistant settles its model before the adapter is chosen.
    let quickWarning: string | undefined
    if (quick?.team === 'single') {
      const resolved = this.resolveQuickAssistant(project)
      project = resolved.project
      quickWarning = resolved.warning
    }
    // Adapter and connection are settled before a run exists, so a refusal leaves no run behind.
    const { adapter, choice } = this.choose(project, kind)
    const connection = this.options.resolveConnection?.(project, choice)
    const libraryEntries = (): McpLibraryEntry[] => this.options.mcp?.libraryEntries?.() ?? []
    if (hiddenContext === undefined && kind === 'mcp-assist') hiddenContext = assistContext(project, libraryEntries(), buildWorkspace ? { allowBuild: true } : {})
    // Library scope (the virtual skills project) has no stored project: the catalog and reads take null.
    const skillScope = (): string | null => (project.id === SKILLS_PROJECT_ID ? null : project.id)
    if (hiddenContext === undefined && kind === 'skill-assist') {
      let catalog: SkillAssistCatalog = { library: [], project: [] }
      try {
        catalog = this.options.skillAssist?.catalog(skillScope()) ?? catalog
      } catch (e) {
        log.warn(`Skill assistant: the skill catalog is unavailable (${(e as Error).message})`)
      }
      hiddenContext = skillAssistContext(project, catalog)
    }
    const images = sanitizeImages(rawImages, (m) => log.warn(m))
    const summary: RunSummary = {
      id: newId('run'),
      projectId: project.id,
      kind,
      prompt,
      status: 'starting',
      startedAt: Date.now(),
      totalCostUsd: 0,
      // Labels the run's cost in the UI (CLI estimate, LiteLLM prices, or none on a ChatGPT plan).
      connection: connection?.connection ?? choice.connection
    }
    if (resumedFrom) summary.resumedFrom = resumedFrom
    if (carriedTitle && kind === 'work') summary.title = carriedTitle
    if (surface === 'team' && kind === 'setup') summary.surface = surface
    if (quick) summary.quick = { ...quick }
    if (buildWorkspace) summary.buildWorkspace = buildWorkspace
    const active: ActiveRun = {
      summary,
      adapter: choice.adapter,
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
      skills: [],
      skillCounts: new Map(),
      skillLoads: 0,
      projectName: project.name,
      rootRole: (project.roles.find((r) => r.reportsTo === null) ?? project.roles[0])?.name ?? '',
      messagesSent: new Map(),
      messagingAtStart: runMessagingOn(project),
      messagesReceived: 0,
      inbox: [],
      held: false,
      waiting: new IntervalTimer(),
      limitTimer: new IntervalTimer(),
      idleTimer: new IntervalTimer(),
      lastUsageAt: 0,
      usageDirty: false,
      record: { summary, agents: {}, transcript: [], logs: [] },
      ...(resumeSessionId ? { resumeSessionId } : {})
    }
    this.runs.set(summary.id, active)
    this.store.upsert(summary)

    // Settings are read at each pricing call, so a saved override applies to a live run on its next usage update.
    const pricing = (): PricingContext => {
      const s = this.options.appSettings?.()
      const community = s?.communityPrices === false ? undefined : this.options.communityPrices?.()
      return {
        connection: choice.connection,
        overrides: s?.modelPrices ?? [],
        ...(connection?.pricing ? { pricing: connection.pricing } : {}),
        catalog: this.options.catalog?.() ?? [],
        aliases: aliasesFor(connection, s?.connections?.[choice.connection]?.tierModels),
        ...(community ? { community } : {})
      }
    }

    const emit = (raw: RunEvent): void => {
      // Usage is computed by the host; an adapter's run.usage is dropped.
      if (raw.type === 'run.usage') return
      if (raw.type === 'skill.used' && !this.noteSkillUsed(active, raw)) return
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
      if (e.type === 'agent.upsert') {
        let agent = e.agent
        if (active.outcome) {
          if (isLiveAgent(agent)) active.cutOff?.add(agent.id)
          agent = settleAgent(agent, !!active.cutOff?.has(agent.id), active.outcome, ROOT_AGENT_ID)
        }
        // Priced into a copy (never the adapter's object) before it is recorded or broadcast.
        e = { ...e, agent: priceAgent(agent, pricing()) }
      }
      const closing = e.type === 'run.status' && (e.status === 'finished' || e.status === 'error' || e.status === 'paused')
      if (e.type === 'run.status') {
        const now = Date.now()
        summary.status = e.status
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.error) summary.error = e.error
        active.idleTimer.set(e.status === 'idle', now)
        if (closing) summary.endedAt = now
        // A session cut by End session or by the app quitting records who cut it, so the status word needs no agents.
        if ((e.status === 'finished' || e.status === 'error') && active.endedBy) {
          summary.endedBy = active.endedBy
          if (active.endedBy === 'app') {
            summary.endedWithApp = true
            if (active.endedWhile) summary.endedWhile = active.endedWhile
          }
        }
        if (e.status === 'paused') {
          summary.pausedUntil = e.pausedUntil
          summary.pauseReason = e.pauseReason
          summary.autoResume = e.autoResume
          // An adapter that says autoResume: false (e.g. Claude's failed MCP restart on a run the user interrupted)
          // waits for the user; any other paused status keeps the auto-resume timer.
          if (e.autoResume === false) this.clearResume(summary.id)
          else this.scheduleResume(summary.id, e.pausedUntil ?? Date.now() + DEFAULT_PAUSE_MS)
        }
        this.store.upsert(summary)
        // Who ended it rides on the terminal status (and on 'stopping' after End session), never from an adapter.
        e = withEndFacts(e, summary)
      } else if (e.type === 'run.cost') {
        // The provider's own total feeds RunUsage; summary.totalCostUsd follows usage.costUsd.
        // On a priced (LiteLLM) connection the adapter's total is a proxy estimate, not the provider's own figure.
        if (!connection?.pricing) active.providerTotalUsd = e.totalCostUsd
      }
      this.recordEvent(active, e)
      logRunEvent(summary, e)
      this.broadcast(e)
      if (e.type === 'agent.upsert' || e.type === 'run.cost' || e.type === 'run.status' || e.type === 'plan.updated' || e.type === 'skill.used') {
        if (closing) this.closeTimers(active)
        this.refreshUsage(active, closing)
      }
      // Root and cut-off reports read Finished / Stopped / Failed instead of "Waiting for you".
      if (outcome) {
        for (const agent of Object.values(active.record.agents)) {
          const settled = settleAgent(agent, !!active.cutOff?.has(agent.id), outcome, ROOT_AGENT_ID)
          if (settled !== agent) emit({ type: 'agent.upsert', runId: summary.id, agent: settled })
        }
      }
    }

    active.emit = emit
    emit({ type: 'run.status', runId: summary.id, status: 'starting', ...(summary.surface ? { surface: summary.surface } : {}) })
    if (notice) emit({ type: 'log', runId: summary.id, level: 'info', message: notice })
    if (carriedPlan && kind === 'work') emit({ type: 'plan.updated', runId: summary.id, plan: { ...structuredClone(carriedPlan), autoContinues: 0 } })
    // Advisory title from the fast model; never awaited, never fails the run.
    // The harness's own resume message is never titled (the continued run's title is carried instead).
    if (kind === 'work' && !summary.title && prompt.trim() && prompt.trim() !== RESUME_TEXT.trim()) {
      void this.titleRun(active, adapter, {
        prompt,
        cwd: project.path,
        model: this.options.fastModel?.(project, choice),
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
    // Setup-like runs and the virtual projects (harness, skills, Chat) carry no project MCP servers, plugins or skills.
    const bare = setupLike || isVirtualProjectId(project.id)
    const isQuick = project.id === QUICK_PROJECT_ID
    // Quick runs and build sessions: the folder is untrusted, so its saved rules file never counts.
    const restricted = isQuick || isTrustRestrictedRun(summary)
    const mcp = this.options.mcp
    /** The project as saved after installs this run made; the canonical path is kept. */
    let live: Project = project
    const projectServers = (): McpServerSpec[] => (bare ? [] : (mcp?.enabledServers(live) ?? live.mcpServers?.filter((s) => s.enabled) ?? []))
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
      // Servers left out because a secret slot is empty (enabledServers skips them): one warning each per run.
      if (!bare && mcp?.skippedServers) {
        let skipped: { name: string; missing: string[] }[] = []
        try {
          skipped = mcp.skippedServers(live)
        } catch (e) {
          log.warn(`MCP skipped-server check failed: ${(e as Error).message}`)
        }
        for (const s of skipped) {
          const key = `secrets:${s.name}`
          if (warnedAuth.has(key)) continue
          warnedAuth.add(key)
          emit({
            type: 'log',
            runId: summary.id,
            level: 'warn',
            message: `MCP server "${s.name}" has no value for ${s.missing.join(', ')}: open Settings > MCP servers and fill it in. It does not start in this run.`
          })
        }
      }
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
      // A quick run's folder was validated (or made as a scratch dir) before the run: a folder that has gone since is an
      // error, never silently re-created.
      if (isQuick) {
        if (!existsSync(project.path)) throw new Error(`The folder ${project.path} no longer exists.`)
      } else {
        // A new project's folder may not exist yet, and the provider needs a real cwd.
        mkdirSync(project.path, { recursive: true })
      }
      // Git and Claude Code compare paths case-sensitively on Windows; a project path typed in a different
      // case than the folder on disk makes worktree isolation refuse to start. Use the on-disk spelling.
      project = { ...project, path: canonicalPath(project.path) }
      live = project
      if (scaffold) {
        const updated = this.setup.markScaffolded(project.id)
        this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
      }
      // Work runs only. Computed at start and again by setLive when an approved install or proposal changes the
      // project's servers, skills or chart mid-run.
      if (!bare && this.options.skills) {
        try {
          active.skills = this.options.skills.forRun(live, project.roles) ?? []
        } catch (e) {
          log.warn(`Run ${summary.id}: skills unavailable (${(e as Error).message})`)
        }
      }
      const builtinModel = this.builtinRoleModel(kind, project, choice)
      if (builtinModel?.warning) emit({ type: 'log', runId: summary.id, level: 'warn', message: builtinModel.warning })
      if (quickWarning) emit({ type: 'log', runId: summary.id, level: 'warn', message: quickWarning })
      /**
       * The project as saved after an install or an approved proposal on this run's own project: the canonical path is
       * kept, the harness tools' view (ctx.project) follows, and a work run's skills are recomputed from the new grants.
       */
      // skills false (an approved org chart, review M1): the card says it applies from the next run, so this run's grants stay.
      const setLive = (saved: Project, skills = true): void => {
        live = { ...saved, path: live.path }
        ctx.project = live
        // Grant changes reach the live run's roles (review M1): the adapters' gates, restarts and role lookups read these
        // objects. An org chart approval (skills false) leaves them as they started.
        if (skills && !bare) refreshRoleGrants(ctx.roles, live.roles)
        if (skills && !bare && this.options.skills) {
          try {
            active.skills = this.options.skills.forRun(live, ctx.roles) ?? []
          } catch (e) {
            log.warn(`Run ${summary.id}: skills unavailable (${(e as Error).message})`)
          }
        }
      }
      // Extra folders (Project.allowedDirectories): work and setup-like runs of a real project only.
      const folderSave = this.options.saveProjectPermissions
      const foldersOn = !restricted && !isVirtualProjectId(project.id)
      let allowedDirs: string[] = []
      const warnedMissing = new Set<string>()
      const resolveFolders = (): void => {
        const r = resolveAllowedDirectories(live.allowedDirectories, { projectPath: live.path, dataDir: this.options.dataDir })
        allowedDirs = r.dirs
        for (const m of r.missing) {
          if (warnedMissing.has(m)) continue
          warnedMissing.add(m)
          emit({ type: 'log', runId: summary.id, level: 'warn', message: `Allowed folder ${m} does not exist; agents cannot use it in this run.` })
        }
        for (const u of r.unsafe) {
          if (warnedMissing.has(u)) continue
          warnedMissing.add(u)
          emit({ type: 'log', runId: summary.id, level: 'warn', message: `Allowed folder ${u} is too broad or sensitive; agents cannot use it in this run.` })
        }
      }
      if (foldersOn) resolveFolders()
      const ctx: RuntimeContext = {
        run: summary,
        project,
        roles:
          kind === 'setup' ? [architectRole(builtinModel)]
          : kind === 'mcp-assist' ? [withBuildTools(mcpAssistantRole(builtinModel), summary)]
          : kind === 'skill-assist' ? [skillAssistantRole(builtinModel)]
          : project.roles.map((r) => ({ ...r })),
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
            // Keep the harness tools' view of the project (and the run's skills) current after an approved change.
            if (req.kind === 'mcpServers' || req.kind === 'skills' || req.kind === 'orgChart') setLive(saved, req.kind !== 'orgChart')
          }),
        // Setup-like runs (setup, mcp-assist, the harness project) change servers through proposals only.
        ...(bare
          ? {}
          : { requestMcpInstall: (req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>) => this.requestMcpInstall(active, req, () => live, setLive) }),
        ...(mcp ? { searchMcpRegistry: (input: McpRegistrySearchInput) => mcp.searchRegistry(input) } : {}),
        mcpServers: allServers,
        // Setup-like runs and work runs of a real project (not quick runs) read the library; work runs link from it.
        ...(setupLike || (!bare && !isQuick) ? { mcpLibrary: libraryEntries } : {}),
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
        plugins: () => (bare ? [] : (live.plugins ?? []).filter((p) => p.enabled)),
        skills: () => active.skills,
        requestQuestion: (req) => this.requestQuestion(active, req),
        requestPermissionRules: (req) => this.requestRules(active, req),
        // A quick run works in a folder the user never made a project: only this run's own grants count, never the
        // folder's saved rules file (it is untrusted), and nothing is ever written there (decideRules).
        protectedDirectories: () => protectedDirsOf(this.options.dataDir),
        allowedRules: () => [...new Set([...(restricted ? [] : listRules(project.path)), ...active.runRules])],
        ...(foldersOn
          ? {
              allowedDirectories: () => [...allowedDirs],
              ...(folderSave
                ? {
                    allowDirectories: (dirs: string[]) => {
                      const saved = folderSave(live.id, { addDirectories: dirs })
                      setLive(saved, false)
                      this.broadcast({ type: 'project.updated', runId: summary.id, project: saved })
                      resolveFolders()
                      const asked = resolveAllowedDirectories(dirs, { projectPath: live.path, dataDir: this.options.dataDir }).dirs
                      const inForce = asked.filter((d) => allowedDirs.some((a) => samePath(a, d)))
                      if (inForce.length) emit({ type: 'log', runId: summary.id, level: 'info', message: `Allowed folders for this project: ${inForce.join(', ')}` })
                      return inForce
                    },
                    acceptEditsForProject: () => {
                      if (live.permissionMode !== 'default') return false
                      const saved = folderSave(live.id, { acceptEdits: true })
                      setLive(saved, false)
                      if (saved.permissionMode !== 'acceptEdits') return false
                      this.broadcast({ type: 'project.updated', runId: summary.id, project: saved })
                      emit({ type: 'log', runId: summary.id, level: 'info', message: 'Permission mode set to Accept edits for this project.' })
                      return true
                    }
                  }
                : {})
            }
          : {}),
        ...(isQuick && this.options.listProjects ? { listProjects: () => this.options.listProjects!() } : {}),
        ...(!bare && !isQuick && kind === 'work' && this.options.skillAssist
          ? {
              skillCatalog: () => this.options.skillAssist!.catalog(project.id),
              readSkill: (ref: { libraryId?: string; skillId?: string }) => this.options.skillAssist!.read(project.id, ref)
            }
          : {}),
        ...(kind === 'skill-assist' && this.options.skillAssist
          ? {
              skillCatalog: () => this.options.skillAssist!.catalog(skillScope()),
              readSkill: (ref: { libraryId?: string; skillId?: string }) => this.options.skillAssist!.read(skillScope(), ref)
            }
          : {}),
        noteArchitectureUpdated: async () => {
          const updated = this.setup.markArchitectureUpdated(project.id)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        },
        requestMergeReview: (req) => this.requestMergeReview(active, req),
        rateLimited: (info) => {
          active.limited = { ...active.limited, ...info }
          active.limitHold = true
          active.limitTimer.set(true, Date.now())
        },
        opusGuardThreshold: this.options.opusGuardThreshold?.(),
        getPlan: () => active.record.plan,
        updatePlan,
        pendingInteractions: () => pendingCount(active),
        // A Chat with the single assistant is a conversation: no plan nudges (planNudgesApply).
        autoContinue: project.autoContinue !== false && planNudgesApply(summary),
        maxAutoContinues: project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
        ...(this.options.continuationDelayMs !== undefined ? { continuationDelayMs: this.options.continuationDelayMs } : {}),
        completeSetup: async (text) => {
          const updated = this.setup.complete(project.id, text)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        }
      }
      const opening = adapter.start(ctx)
      this.startsInFlight.add(opening)
      try {
        active.session = await opening
      } finally {
        this.startsInFlight.delete(opening)
      }
      void active.session.finished.finally(() => this.teardown(active))
      // The run was ended (End session or the app quitting) while its session was still opening: stop it at once.
      if (active.userStopped) {
        this.stopSession(active)?.catch((err: unknown) => log.warn(`Run ${summary.id}: stopping a session that opened after its end failed: ${(err as Error)?.message ?? err}`))
      }
    } catch (e) {
      emit({ type: 'run.status', runId: summary.id, status: 'error', error: (e as Error).message })
      // No session will ever finish this run; it must not count as live.
      this.teardown(active)
    }
    return summary
  }

  /** Close the open wait / limit / idle intervals (the run ended or paused). */
  private closeTimers(a: ActiveRun): void {
    const now = Date.now()
    a.waiting.set(false, now)
    a.limitTimer.set(false, now)
    a.idleTimer.set(false, now)
  }

  /** The run's current RunUsage from its (priced) agents and RunManager's own timers. */
  private currentUsage(a: ActiveRun, now: number): RunUsage {
    return computeRunUsage(a.summary, Object.values(a.record.agents), {
      providerTotalUsd: a.providerTotalUsd,
      nudges: a.record.plan?.autoContinues ?? 0,
      waitingMs: a.waiting.elapsed(now),
      limitHoldMs: a.limitTimer.elapsed(now),
      idleMs: a.idleTimer.elapsed(now),
      now,
      skills: [...a.skillCounts.values()]
    })
  }

  /**
   * Count a skill.used event into the run. False = drop it (a skill the run does not have, or the per-run cap). A
   * counted load also appends a harness transcript row on the loading agent. The name shown is the run skill's own.
   */
  private noteSkillUsed(a: ActiveRun, e: Extract<RunEvent, { type: 'skill.used' }>): boolean {
    const skill = a.skills.find((s) => s.id === e.skillId)
    if (!skill) {
      log.warn(`Run ${a.summary.id}: dropped skill.used for unknown skill ${String(e.skillId).slice(0, 80)}`)
      return false
    }
    if (a.skillLoads >= RUN_SKILL_LOAD_LIMIT) {
      if (a.skillLoads === RUN_SKILL_LOAD_LIMIT) log.warn(`Run ${a.summary.id}: skill load limit (${RUN_SKILL_LOAD_LIMIT}) reached; later loads are not counted`)
      a.skillLoads++
      return false
    }
    a.skillLoads++
    const slug = a.record.agents[e.agentId]?.roleSlug
    const count = a.skillCounts.get(skill.id) ?? { skillId: skill.id, name: skill.name, loads: 0, roles: [] }
    count.loads++
    if (slug && !count.roles.includes(slug)) count.roles.push(slug)
    a.skillCounts.set(skill.id, count)
    a.emit({ type: 'transcript', runId: a.summary.id, entry: { id: newId('t'), agentId: e.agentId, at: e.at, source: 'harness', block: { kind: 'system', text: `Loaded skill ${skill.name}` } } })
    // The node reads "Using skill <name>" until the adapter's next activity; never after the run ended.
    const agent = a.record.agents[e.agentId]
    if (agent && !a.outcome) {
      const updated = withSkillActivity(agent, skill.name)
      if (updated !== agent) a.emit({ type: 'agent.upsert', runId: a.summary.id, agent: updated })
    }
    return true
  }

  /**
   * Recompute summary.usage (and totalCostUsd) now; publish run.usage and save the index at most once per
   * USAGE_THROTTLE_MS (trailing), or immediately when `immediate` (terminal status, teardown).
   */
  private refreshUsage(a: ActiveRun, immediate: boolean): void {
    const now = Date.now()
    a.summary.usage = this.currentUsage(a, now)
    a.summary.totalCostUsd = a.summary.usage.costUsd ?? 0
    a.usageDirty = true
    if (immediate) {
      this.publishUsage(a)
      return
    }
    if (a.usageTimer) return
    const wait = Math.max(0, a.lastUsageAt + USAGE_THROTTLE_MS - now)
    if (wait === 0) this.publishUsage(a)
    else a.usageTimer = setTimeout(() => this.publishUsage(a), wait)
  }

  private publishUsage(a: ActiveRun): void {
    if (a.usageTimer) clearTimeout(a.usageTimer)
    a.usageTimer = undefined
    const now = Date.now()
    a.summary.usage = this.currentUsage(a, now)
    a.summary.totalCostUsd = a.summary.usage.costUsd ?? 0
    a.lastUsageAt = now
    a.usageDirty = false
    // Nothing but the timestamp changed (e.g. a settled agent after the end): the last event and save still stand.
    const key = JSON.stringify({ ...a.summary.usage, updatedAt: 0 })
    if (key === a.lastUsageKey) return
    a.lastUsageKey = key
    this.store.upsert(a.summary)
    this.broadcast({ type: 'run.usage', runId: a.summary.id, usage: a.summary.usage })
  }

  /**
   * A run's session ended (or never started): settle every card still open, forget run-scoped servers and held
   * peer messages, persist the record and drop the run from the live set.
   */
  private teardown(active: ActiveRun): void {
    const runId = active.summary.id
    // Every waiting card (permissions, proposals, questions, rules, merges, installs) is settled as cancelled.
    cancelPending(active, runId, this.broadcast)
    // The final usage goes out and is saved with the record, whatever the throttle still holds.
    // Always recompute after the timers close so waitingMs / idleMs / limitHoldMs are final (publish skips no-op changes).
    this.closeTimers(active)
    this.refreshUsage(active, true)
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

  /** runs:usageStats: usage per run, per role and per trend bucket for one project (see UsageStats). */
  usageStats(raw: UsageStatsQuery): UsageStats {
    const query = sanitizeUsageQuery(raw)
    const now = Date.now()
    const inRange = (s: RunSummary): boolean =>
      (query.kinds as RunKind[]).includes(s.kind) && (query.since === undefined || s.startedAt >= query.since) && (query.until === undefined || s.startedAt < query.until)
    const byId = new Map<string, RunSummary>()
    const fill: { id: string; usage: RunUsage }[] = []
    for (const s of this.store.list(query.projectId)) {
      if (!inRange(s) || this.runs.has(s.id)) continue
      if (s.usage) {
        byId.set(s.id, s)
        continue
      }
      // Saved before usage tracking: normalize from the record once, then keep the result in the index.
      const record = this.store.getRecord(s.id)
      const usage = (record ? normalizeRunRecord(record, now).summary.usage : undefined) ?? legacySummaryUsage(s, now)
      fill.push({ id: s.id, usage })
      byId.set(s.id, { ...s, usage })
    }
    if (fill.length) this.store.setUsage(fill)
    // Live runs read their current usage, not the last saved one.
    for (const a of this.runs.values()) {
      if (a.summary.projectId !== query.projectId || !inRange(a.summary)) continue
      byId.set(a.summary.id, { ...a.summary, usage: this.currentUsage(a, now) })
    }
    return buildUsageStats([...byId.values()], query, now)
  }

  // ---------- cross-run messaging ----------

  /**
   * list_runs: every other live work run, across projects, oldest first. A setup-like caller sees none. A peer's
   * prompt is shown only when both the caller's and the peer's projects have runMessaging on (else ''), so a project
   * that did not opt in neither reads nor reveals what other runs are doing beyond project, status and orchestrator.
   */
  private listRunsFor(self: ActiveRun): RunPeer[] {
    if (isSetupLikeRun(self.summary.kind) || isVirtualProjectId(self.summary.projectId)) return []
    const selfOn = this.messagingOn(self)
    return [...this.runs.values()]
      .filter((a) => a !== self && a.summary.kind === 'work' && !isVirtualProjectId(a.summary.projectId) && isOpenStatus(a.summary.status))
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
    if (isSetupLikeRun(sender.summary.kind) || isVirtualProjectId(sender.summary.projectId)) return { result: 'refused', refusal: 'not-work' }
    if (targetId === sender.summary.id) return { result: 'refused', refusal: 'self' }
    if (!text) return { result: 'refused', refusal: 'empty' }
    const target = this.runs.get(targetId)
    const stored = target ? undefined : this.store.get(targetId)
    if (!target && !stored) return { result: 'not-found' }
    const targetSummary = target?.summary ?? stored!
    if (isSetupLikeRun(targetSummary.kind) || isVirtualProjectId(targetSummary.projectId)) return { result: 'refused', refusal: 'not-work' }
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
    if (isVirtualProjectId(a.summary.projectId)) return false
    const current = this.options.resolveProject?.(a.summary.projectId)
    return current ? runMessagingOn(current) : a.messagingAtStart
  }

  summaryOf(runId: string): RunSummary | undefined {
    return this.runs.get(runId)?.summary
  }

  get(runId: string): RunRecord | null {
    const active = this.runs.get(runId)
    if (active) return normalizeRunRecord({ ...active.record, summary: { ...active.summary } })
    const found = this.store.getRecord(runId)
    // Records saved before usage tracking get legacy usage on read (nothing is written back here).
    const stored = found ? normalizeRunRecord(found) : null
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

  /** Quick runs and build sessions never save anything into their folder (isTrustRestrictedRun, plus the quick project). */
  private isRestricted(summary: RunSummary): boolean {
    return summary.projectId === QUICK_PROJECT_ID || isTrustRestrictedRun(summary)
  }

  decide(runId: string, requestId: string, decision: PermissionDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pending.get(requestId)
    if (!active || !pending) return
    active.pending.delete(requestId)
    // A quick run or build session works in a folder that is not a project: a 'project' grant would let the adapter
    // save rules into it. Narrow to the session here so every adapter is covered.
    const narrowed: PermissionDecision =
      decision?.behavior === 'allow' && decision.scope === 'project' && this.isRestricted(active.summary) ? { ...decision, scope: 'session' } : decision
    pending.resolve(narrowed)
    const savedToProject = narrowed?.behavior === 'allow' && narrowed.scope === 'project'
    this.broadcast({ type: 'permission.resolved', runId, requestId, ...(savedToProject ? { savedToProject: true as const } : {}) })
    this.cardSettled(active)
  }

  private requestProposal(
    active: ActiveRun,
    req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>,
    onApplied?: (saved: Project) => void
  ): Promise<ProposalOutcome> {
    const effect = proposalEffect(req.kind, active.summary, active.adapter)
    const proposal = { ...req, id: newId('prop'), runId: active.summary.id, createdAt: Date.now(), effect } as Proposal
    return new Promise((resolve) => {
      active.pendingProposals.set(proposal.id, { proposal, resolve: (raw) => {
        // Secrets stop here: the tool and the proposal.resolved event only ever get the outcome.
        const decision = cleanProposalDecision(raw)
        if (decision.behavior !== 'approve') {
          const outcome = proposalOutcome(decision)
          resolve(outcome)
          return outcome
        }
        let waitingForSecrets: string[] | undefined
        {
          try {
            if (active.summary.projectId === HARNESS_PROJECT_ID) {
              // The harness project is virtual: its proposals change the MCP library only, never a stored project.
              if (proposal.kind !== 'mcpServers') throw new Error('Only MCP library proposals can be applied here.')
              this.setup.applyLibraryProposal(proposal.payload as McpServersProposalPayload, active.summary.buildWorkspace ? { buildWorkspace: active.summary.buildWorkspace } : {})
              waitingForSecrets = this.storeProposalSecrets(null, proposal, decision.secrets)
            } else if (active.summary.projectId === SKILLS_PROJECT_ID) {
              // Library-scope Skill assistant: skill proposals change the skill library only.
              if (proposal.kind !== 'skills') throw new Error('Only skill proposals can be applied here.')
              this.setup.applySkillsLibraryProposal(proposal)
            } else if (isVirtualProjectId(active.summary.projectId)) {
              throw new Error('This session has no project to change.')
            } else if (active.summary.kind === 'skill-assist' && proposal.kind !== 'skills') {
              throw new Error('Only skill proposals can be applied in a Skill assistant session.')
            } else {
              const updated = this.setup.applyProposal(active.summary.projectId, proposal, { projectOnly: active.summary.kind === 'work' })
              // Before onApplied: a stored secret lets the server start (enabledServers reads the SecretStore live).
              waitingForSecrets = this.storeProposalSecrets(active.summary.projectId, proposal, decision.secrets)
              onApplied?.(updated)
              this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
            }
          } catch (e) {
            const message = (e as Error).message
            logRunEvent(active.summary, { type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            this.broadcast({ type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            const failed: ProposalOutcome = { behavior: 'revise', feedback: `The harness could not apply this proposal: ${message}` }
            resolve(failed)
            return failed
          }
        }
        const outcome: ProposalOutcome = { behavior: 'approve', ...(waitingForSecrets ? { waitingForSecrets } : {}) }
        resolve(outcome)
        return outcome
      } })
      this.broadcast({ type: 'proposal.request', runId: active.summary.id, proposal })
    })
  }

  /** Store an approved MCP proposal's secret values; the names of its servers still waiting for one. Never throws. */
  private storeProposalSecrets(projectId: string | null, proposal: Proposal, values: Record<string, string> | undefined): string[] | undefined {
    if (proposal.kind !== 'mcpServers' || !this.options.mcp?.storeProposalSecrets) return undefined
    try {
      return this.options.mcp.storeProposalSecrets(projectId, proposal.payload, values)
    } catch (e) {
      log.warn(`Proposal secrets could not be stored: ${(e as Error).message}`)
      return undefined
    }
  }

  decideProposal(runId: string, proposalId: string, decision: ProposalDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingProposals.get(proposalId)
    if (!active || !pending) return
    active.pendingProposals.delete(proposalId)
    // The broadcast carries the secret-free outcome (with waitingForSecrets), never decision.secrets.
    const outcome = pending.resolve(decision) ?? proposalOutcome(cleanProposalDecision(decision))
    this.broadcast({ type: 'proposal.resolved', runId, proposalId, decision: outcome })
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
      // Destructive or unbounded rules, and shell prefixes that grant far more than one command (reviewer-4 M-2).
      flagged: rules.filter((r) => isUnsafeAllowRule(r) || tooBroadRuleRefusal(r) !== null),
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
   * chose the rules knowingly, so flagged destructive rules are saved too; blanket rules and too-broad shell prefixes
   * (tooBroadRuleRefusal) stay run grants.
   */
  decideRules(runId: string, requestId: string, decision: PermissionRuleDecision): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingRules.get(requestId)
    if (!active || !pending) return
    active.pendingRules.delete(requestId)
    const { rules } = pending.request
    let clean: PermissionRuleDecision
    if (decision?.behavior === 'grant') {
      // A quick run's folder is not a project: a grant there stays on this run and nothing is written into the folder.
      const scope = decision.scope === 'project' && !this.isRestricted(active.summary) ? 'project' : 'run'
      clean = { behavior: 'grant', scope }
      for (const r of rules) if (!active.runRules.includes(r)) active.runRules.push(r)
      if (scope === 'project') {
        // A blanket rule (bare Bash / Edit / Write ...) stays a run grant; it is never written to the file.
        // A too-broad shell prefix (tooBroadRuleRefusal, the wording permissions:add uses) also stays on the run (M-2).
        const savable = rules.filter((r) => !isBlanketAllowRule(r) && tooBroadRuleRefusal(r) === null)
        const blanket = rules.filter(isBlanketAllowRule)
        if (blanket.length) this.broadcast({ type: 'log', runId, level: 'warn', message: `Not saved for the project (too broad): ${blanket.join(', ')}. It applies to this run only.` })
        for (const r of rules) {
          const refusal = isBlanketAllowRule(r) ? null : tooBroadRuleRefusal(r)
          if (refusal) this.broadcast({ type: 'log', runId, level: 'warn', message: `Not saved for the project: ${refusal} It applies to this run only.` })
        }
        try {
          if (savable.length) addRules(active.projectPath, savable)
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
    if (isVirtualProjectId(project.id)) return refuse('installs are not available in this session; propose library entries instead.')
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
    this.refuseWhileQuitting()
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
    active.limitTimer.set(false, Date.now())
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
    if (!active) return
    const st = active.summary.status
    if (st === 'finished' || st === 'error') return
    active.userStopped = true
    active.endedBy ??= 'user'
    // Saved with the 'stopping' status, so a quit or crash before the session ends still reads as the user's end.
    if (active.endedBy === 'user') active.summary.endedBy = 'user'
    active.titleAbort?.abort()
    active.emit({ type: 'run.status', runId, status: 'stopping' })
    this.flush(active)
    // A session still opening is stopped by start() as soon as adapter.start resolves (userStopped is set).
    await this.stopSession(active)
  }

  /** The run's session.stop(), one call at a time (End session, quit and a late start share it; a failed stop can be retried). */
  private stopSession(r: ActiveRun): Promise<void> | undefined {
    if (!r.session) return undefined
    if (r.stopCall) return r.stopCall
    const call = r.session.stop()
    r.stopCall = call
    call.catch(() => {
      if (r.stopCall === call) r.stopCall = undefined
    })
    return call
  }

  private refuseWhileQuitting(): void {
    if (this.quitting) throw new Error('OrgAI is quitting; runs cannot start, continue or take messages now.')
  }

  /**
   * In memory: the run is being cut by `by` (the first cut wins). endedWhile is read before anything stops. A run
   * that already ended (finished or error, teardown pending) is left alone.
   */
  private markCut(r: ActiveRun, by: 'user' | 'app'): void {
    const st = r.summary.status
    if (st === 'finished' || st === 'error') return
    if (by === 'app' && !r.endedBy) {
      const w = quitEndedWhile(st, hasOpenCard(r))
      if (w) r.endedWhile = w
    }
    r.userStopped = true
    r.endedBy ??= by
  }

  /**
   * Write a run's summary and record now (synchronous). On a quit, a cut run that has not reported its end is written
   * finished; a paused run keeps its pause (the store's boot normalization ends it next start). A cut run's endedBy
   * goes on the summary, with endedWithApp and endedWhile only when it is 'app'. A run that ended on its own keeps
   * no endedBy.
   */
  private writeCut(r: ActiveRun, quit: boolean): void {
    const s = r.summary
    const forced = quit && !!r.endedBy && s.status !== 'finished' && s.status !== 'error' && s.status !== 'paused'
    if (forced) {
      s.status = 'finished'
      s.endedAt ??= Date.now()
      if (s.autoResume) delete s.autoResume
    }
    if ((s.status === 'finished' || s.status === 'error') && r.endedBy) {
      s.endedBy ??= r.endedBy
      if (s.endedBy === 'app') {
        s.endedWithApp = true
        if (r.endedWhile) s.endedWhile = r.endedWhile
      }
    }
    try {
      this.store.upsert(s)
    } catch (e) {
      console.error('Failed to persist run summary:', e)
    }
    this.flush(r)
    // The session never reported its end: tell the renderer it is finished, and who cut it.
    if (forced) this.broadcast(withEndFacts({ type: 'run.status', runId: s.id, status: 'finished' }, s))
  }

  /**
   * The app is quitting and will not wait any longer (index.ts quitGate: the deadline passed, stopAll failed, or a
   * forced second quit). Synchronously refuses new work, cancels resumes and titles, marks every live run cut by the
   * app (an End session already under way keeps 'user') and writes each summary and record. Safe to call again.
   */
  markQuit(): void {
    this.quitting = true
    for (const runId of [...this.resumeTimers.keys()]) this.clearResume(runId)
    for (const a of this.titleAborts.keys()) a.abort()
    for (const r of this.runs.values()) this.markCut(r, 'app')
    for (const r of this.runs.values()) this.writeCut(r, true)
    // Ask every open session to stop before the process goes (nothing waits for it).
    for (const r of this.runs.values()) {
      this.stopSession(r)?.catch((err: unknown) => log.warn(`Run ${r.summary.id}: stop on quit failed: ${(err as Error)?.message ?? err}`))
    }
  }

  /**
   * Stop every live run. `reason: 'quit'` (the app is quitting) records the cut runs as `endedBy: 'app'` with
   * `endedWithApp: true`, not as user-stopped; without it they read as ended by the user. Either way no run pauses
   * or auto-resumes, pending titles are aborted, and every summary and record is on disk before this resolves.
   */
  async stopAll(opts: { reason?: 'quit' } = {}): Promise<void> {
    const quit = opts.reason === 'quit'
    // From here on start, continueRun, send and resumeNow refuse ("OrgAI is quitting").
    if (quit) this.quitting = true
    for (const runId of [...this.resumeTimers.keys()]) this.clearResume(runId)
    for (const r of this.runs.values()) this.markCut(r, quit ? 'app' : 'user')
    // Titles still pending for runs that already ended are cancelled too (app quit).
    for (const a of this.titleAborts.keys()) a.abort()
    // Open sessions are stopped at once, while sessions still opening are waited for (start() stops each one as soon
    // as adapter.start resolves, userStopped being set), so one hung start does not hold back the others' stops.
    // The second pass picks up sessions that opened meanwhile; stopSession shares one call per run.
    await Promise.allSettled([...[...this.runs.values()].map((r) => this.stopSession(r)), ...this.startsInFlight])
    await Promise.allSettled([...this.runs.values()].map((r) => this.stopSession(r)))
    // A session that never reported its end (its stop failed) is written as ended here, so the index does not depend
    // on the store's boot normalization.
    for (const r of this.runs.values()) this.writeCut(r, quit)
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
    this.refuseWhileQuitting()
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
      // A Team-tray Architect session stays in the Team tray when it is continued or auto-resumed.
      ...(target.surface ? { surface: target.surface } : {}),
      // A Chat run keeps its folder and settings; an MCP build session reopens in the same workspace.
      ...(target.quick ? { quick: target.quick } : {}),
      ...(target.buildWorkspace ? { buildWorkspace: target.buildWorkspace } : {}),
      resumeSessionId: sessionId,
      resumedFrom: target.id,
      // totalCostUsd may be a computed cost; only the provider's own total is subtracted from the next provider total.
      // On a LiteLLM project the adapter total was a proxy estimate (older records may carry it as providerCostUsd): no base.
      resumeBaseCostUsd: projectConnection(project) === 'litellm' ? 0 : target.usage ? (target.usage.providerCostUsd ?? 0) : target.totalCostUsd,
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
    // No auto-resume is armed while the app quits (resumeNow would refuse); the boot normalization ends the pause.
    if (this.quitting) return
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
    this.refuseWhileQuitting()
    const from = this.summary(runId)
    if (!from) throw new Error('Run not found')
    if (from.status !== 'paused') throw new Error('Run is not paused')
    const current = this.projectOfRun(from)
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
