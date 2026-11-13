import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type {
  AgentInstance,
  DelegationVerdict,
  EngagementChangedEvent,
  HostHandoffFacts,
  EngagementNoteWriter,
  FolderConfigState,
  OutputProduceInput,
  OutputReadInput,
  OutputRegisterInput,
  OutputsChangedEvent,
  RunOutput,
  RunUsage,
  UsageOverview,
  UsageStats,
  UsageStatsQuery,
  AppSettings,
  AdapterChoice,
  BridgedRoleChoice,
  ConnectionId,
  ModelRef,
  ModelTier,
  CardKind,
  DecisionLookup,
  DecisionOptions,
  DecisionOutcome,
  DecidedBy,
  ExecOutcome,
  RunEndedBy,
  RunOverrides,
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
  OrgChartProposalPayload,
  SkillsProposalPayload,
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
  KnowledgeNode,
  KnowledgeRecallInput,
  KnowledgeServedUsage,
  KnowledgeSource,
  EngagementNote,
  EngagementNoteContent,
  RunTeam,
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
  RunStaffing,
  RunRecord,
  RunSummary,
  SwitchRunModelInput,
  SwitchRunModelResult,
  SetRunPermissionModeInput,
  SetRunPermissionModeResult,
  Effort,
  PermissionMode,
  RunSurface,
  SkillUseCount,
  UserQuestion
} from '@shared/types'
import { BridgedSessions, bridgeKey } from './bridge'
import { QUICK_ASSISTANT_SLUG, adapterForProject, cleanRunStaffing, effortOptionsFor, effectiveSubagentLimits, connectionName, connectionRecord, roleConnection, roleConnectionProblems, isKnownConnection, agentProducedNothing, isolateWritersOn, mcpSecretNames, mixedFamilyRefusal, modelFamily, newId, projectConnection, projectKindOf, projectRulesLocation, resolveModelSetting, runMessagingOn, settingTier, singleRunProject, staffingGoalOf, writesToProjectFolder } from '@shared/defaults'
import { referenceFolderOf } from './referenceDirectories'
import { aliasesFor, priceAgentUsage, resolvePrice, type PricingContext } from './pricing'
import {
  IntervalTimer,
  buildUsageCsv,
  buildUsageOverview,
  buildUsageOverviewCsv,
  buildUsageStats,
  computeRunUsage,
  emptyAgentUsage,
  legacySummaryUsage,
  monthRange,
  normalizeRunRecord,
  sanitizeUsageOverviewQuery,
  type UsageOverviewNames
} from './runUsage'
import { knowledgeAutoContextOn } from '@shared/knowledge'
import { RESUME_TEXT } from './prompts'
import { dropLoneHighSurrogate, fenceDatum, knowledgeBrief, knowledgeContextBlock, knowledgeListItem, recallKnowledge } from '@shared/knowledgeIndex'
import { strongMentionLinks } from '@shared/knowledgeLinks'
import { DEFAULT_EXEC_STALL_TIMEOUT_MS, DEFAULT_HEADLESS_DECISION_POLICY, DEFAULT_MAX_AUTO_CONTINUES, EXEC_FINALIZE_STOP_TIMEOUT_MS, EXEC_SETTLE_DEBOUNCE_MS, EXEC_TITLE_JOIN_MS, HARNESS_PROJECT_ID, KNOWLEDGE_RECALLED_IDS_MAX, KNOWLEDGE_RUN_WRITES_MAX, MAX_TIMER_DELAY_MS, OUTPUTS_RUN_MAX, RUN_TITLE_MAX_CHARS, PERMISSION_MODE_OPTIONS, isBuiltinConnectionId, isEffort, isPermissionMode, runPermissionModeChoices, QUICK_PROJECT_ID, RUN_MESSAGE_MAX_CHARS, RUN_PEER_PROMPT_CHARS, SKILLS_PROJECT_ID, USAGE_STATS_DEFAULT_LIMIT, USAGE_STATS_MAX_LIMIT, isVirtualProjectId } from '@shared/types'
import { architectRole, mcpAssistantRole, skillAssistantRole } from '@shared/setup'
import { isTrustRestrictedRun, isInsideEither, samePath, canonicalDeep } from '../quick/scratch'
import { isQuickSessionEditGrant, isQuickWriteTool } from '../quick/sessionEdits'
import { MCP_ASSIST_MODEL_LABEL, QUICK_RUN_MODEL_LABEL, SETUP_MODEL_LABEL, SKILL_ASSIST_MODEL_LABEL, resolveBuiltinModel, type ResolvedBuiltinModel } from './builtinModel'
import { runModelLogs } from './runModels'
import { ROOT_AGENT_ID, isSetupLikeRun, type RootTurnEnd, type CompletionInput, type KnowledgeCaller, type KnowledgeStoreApi, type ResolvedMcpServer, type RunMessageOutcome, type RunConnection, type RunSkill, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type SessionSettlement, type SkillAssistCatalog } from './types'
import type { DelegationGate, RunManagerScheduleHooks, SelfKnowledgeHooks } from './types'
import type { EvolvePostRunResult, EvolveStrategy } from '@shared/types'
import { OPEN_IN_APP_MIN_INTERVAL_MS, OPEN_IN_APP_PER_RUN_MAX, type AppNavigateEvent, type AppNavigateOutcome, type AppReferenceQuery } from '@shared/types'
import { atlasPath, atlasSurface, isAtlasSurfaceId, type AtlasSurfaceId } from '@shared/view/atlas'
import { clampText } from '../capabilities/sanitize'
import { datum } from './harnessTools'
import type { OutputScope, OutputWriteResult, OutputsServiceApi } from '../outputs/api'
import type { SkillRunSource } from '../skills/types'
import { RunStore } from '../store/runs'
import { isValidId } from '../windowScope'
import type { SetupService } from '../setup/service'
import { log, logPermission, logRunEvent } from '../log'
import { hasContent, sanitizeImages } from './attachments'
import { breakParentCycles } from './agentTree'
import { describePlanChange, peerDeliveryBlocked, planNudgesApply } from './continuation'
import { PermissionModeRefusal } from './permissionModeRefusal'
import { isAuthFailure, isLiveAgent, runOutcome, settleAgent, withSkillActivity, type RunOutcome } from './activity'
import { canNarrowPermissionMode, effectiveRunProject, execBudgetUsd, overlaidByAcceptEdits, overridesWidening, projectBudgetUsd, withoutWaitPolicy } from './runOverrides'
import { modelHandoff } from './modelHandoff'
import { defaultEndedBy, execOutcomeFor, execQuiescent } from './execSettle'
import { delegationPreflight, obligationsFor, subtreeFailed } from './delegation'
import { DelegationLedger } from './delegationLedger'
import { keepsHostBusy, runActivityState, type RunActivityState } from './runActivity'
import { countsAsDenial, fullPolicy, policyAction, type PolicyDecisions } from './decisionPolicy'
import { DecisionIndex } from './decisionIndex'
import { cancelPending, cleanProposalDecision, emptyPending, listPending, proposalEffect, proposalOutcome, type PendingCardMaps } from './pendingCards'
import { addRules, addRulesReport, isBlanketAllowRule, isUnsafeAllowRule, listRules, tooBroadRuleRefusal } from './permissionRules'
import { projectRulesFile, readEngagementDocument } from '../store/projectData'
import { readStaffingProfile, recordRunInStaffingProfile, staffingProfileApplies } from '../store/staffingProfile'
import { cleanFolderConfigTrust, folderConfigStateOf, folderConfigWarning, presentConfigPaths } from './folderConfigTrust'

/**
 * The project the adapters see. Adapters read `isolateWriters !== false`, so the value is made explicit: an
 * engagement isolates (git worktrees) only on an explicit true; a code project is on unless explicitly false.
 * Code projects pass through untouched; engagements get the explicit isolateWritersOn value.
 */
function noFolderWrites(p: Project): Project {
  if (writesToProjectFolder(p)) return p
  const on = isolateWritersOn(p)
  return p.isolateWriters === on ? p : { ...p, isolateWriters: on }
}
import { allowedDirectoryRisk } from './allowedDirectories'
import { isValidRule } from './ruleMatch'
import { controlProtectedPaths } from './selfControlGate'
import { validateSpec } from '../mcp/validate'
import { ProposalSecretsNotSaved } from '../mcp/proposalSecrets'
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

/**
 * The folders an outputs call may touch, from the stored project (types.ts "Run outputs"; api.ts OutputScope): the
 * project folder, the existing allowed folders (resolveAllowedDirectories: real paths, never the data folder or a
 * folder inside the project) and the reference folders (never accepted). Used by RunManager at call time and by the
 * outputs:* handlers.
 */
export function outputScopeOf(project: Project, dataDir: string | undefined): OutputScope {
  const allowed = resolveAllowedDirectories(project.allowedDirectories, { projectPath: project.path, dataDir }).dirs
  // References are refused by the service, so none is dropped here (one inside the project folder must still count):
  // both the given and the canonical spelling go in.
  const references = [
    ...new Set(
      (project.referenceDirectories ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .flatMap((r) => [resolvePath(r.trim()), canonicalPath(resolvePath(r.trim()))])
    )
  ]
  return { projectId: project.id, projectPath: project.path, allowedDirectories: allowed, referenceDirectories: references }
}

/** The noun of the transcript row "Produced <word> <title>". */
function producedWord(kind: string): string {
  return kind === 'docx' ? 'document' : kind === 'xlsx' ? 'workbook' : kind === 'pptx' ? 'deck' : kind === 'mermaid' || kind === 'svg' ? 'diagram' : 'file'
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
/** How long a 'trusted' folder-config answer is reused before the folder is scanned again. */
const FOLDER_CHECK_MS = 2000

/** Exec settlement re-check while the root is idle but the adapter is not settled yet (a continuation timer...). */
export const EXEC_SETTLE_POLL_MS = 1000
/**
 * The stall watchdog's hard ceiling (review M4): an exec run whose adapter keeps reporting a busy root with no activity
 * at all ends 'stalled' after this many execStallTimeoutMs periods (30 min at the 5 min default).
 */
export const EXEC_STALL_BUSY_ROUNDS = 6

/**
 * A delay setTimeout honours: setTimeout runs anything above MAX_TIMER_DELAY_MS (about 24.8 days) after 1 ms, so a
 * longer exec timer (a record saved before the host refused such values) is capped there; non-finite or negative is 0.
 */
export function timerDelay(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_DELAY_MS) : 0
}

/** Wait for `p` at most `ms`; true when the time ran out first. Never rejects. */
async function raceTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms)
  })
  try {
    return await Promise.race([p.then(() => false as const, () => false as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}
/** Most skill loads one run counts (RunUsage.skills, transcript rows); later skill.used events are dropped. */
export const RUN_SKILL_LOAD_LIMIT = 1000
/** run.usage events (and the index save that goes with them) are published at most this often per run. */
export const USAGE_THROTTLE_MS = 1000
/** knowledge.recalled events go out at most this often per agent (leading edge at once, the rest merged and trailing). */
export const KNOWLEDGE_RECALLED_THROTTLE_MS = 1000
/** Most agents whose "already shown" knowledge state a run keeps (a bug-proofing bound; more agents just get no dedupe). */
const KNOWLEDGE_SHOWN_AGENTS_MAX = 500
/** Most entity names one "Added N known items" row lists. */
const KNOWLEDGE_ROW_NAMES = 3

/** One agent's knowledge.recalled throttle: when it last went out and what is waiting. */
interface RecalledThrottle {
  lastAt: number
  timer?: ReturnType<typeof setTimeout>
  pending?: { ids: string[]; via: 'recall' | 'auto' }
}
/** When a usage limit gives no reset time, try again after this long. */
export const DEFAULT_PAUSE_MS = 5 * 60 * 1000
// RESUME_TEXT lives in prompts.ts (the adapters' delivery helpers need it without importing the manager); re-exported
// here so existing imports of it from './runManager' keep compiling.
export { RESUME_TEXT }

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
 * RunSummary.permissionMode for a run whose session runs in `mode` (review L1): undefined for runs that take no per-run
 * mode (setup-like runs pin their own, whatever the project says); on a run with a narrower choice list (Chat) a mode
 * outside it is what its adapter downgrades to asking, 'default'. Every other run records `mode` as is.
 */
export function recordedRunPermissionMode(run: Pick<RunSummary, 'kind' | 'quick' | 'buildWorkspace'>, mode: PermissionMode): PermissionMode | undefined {
  const choices = runPermissionModeChoices(run)
  if (!choices.length) return undefined
  return choices.includes(mode) ? mode : 'default'
}

/** The plain sentence for running reports that keep their earlier mode after a live permission mode change. */
export function reportsUnchangedText(n: number): string {
  return n === 1 ? '1 running report keeps the earlier mode until it finishes.' : `${n} running reports keep the earlier mode until they finish.`
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
  /** Team evolution: run the post-run ratchet pass once when this run ends (StartInput.evolve; work runs only). */
  evolve?: EvolveStrategy | true
  evolveWindowRuns?: number
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
  /** Quick runs: the user chose Allow for session on a covered edit; dies with the run (RuntimeContext.quickSessionEdits). */
  quickSessionEdits?: boolean
  /** The project's (canonical) path, for saving project-scoped grants. */
  projectPath: string
  /** Set for engagements: their saved rules live in OrgAI's data folder, never in the project folder. */
  rulesTarget?: { file: string }
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
  /** Required delegation (work runs only): the host-owned ledger behind RuntimeContext.delegation. */
  ledger?: DelegationLedger
  /** The last run.delegation payload (JSON), so an unchanged ledger emits nothing. */
  delegationSent?: string
  /** The ledger carries something to show (obligations, strict, preflight problems or a native strike); plain adaptive runs stay silent. */
  delegationOn?: boolean
  /** The root turn generation at which the exec root's one correction was sent; pending until a later turn ends. */
  correctionGen?: number
  /** The user ended the session; never pause it. */
  userStopped?: boolean
  /**
   * Who cut the session (RunSummary.endedBy): 'user' from stop(), 'app' from stopAll({ reason: 'quit' }), 'policy' /
   * 'budget' from finalizeExecRun. The first one wins.
   */
  endedBy?: RunEndedBy
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
  /** Knowledge graph writes and saved notes this run made through the harness tools (KNOWLEDGE_RUN_WRITES_MAX). */
  knowledgeWrites: number
  /** The writes cap was reached and logged once. */
  knowledgeCapWarned?: boolean
  /** open_in_app places shown this run and when the last one went out (OPEN_IN_APP_PER_RUN_MAX / OPEN_IN_APP_MIN_INTERVAL_MS). */
  appOpens?: number
  appOpenedAt?: number
  /** produce_output / register_output successes this run made (OUTPUTS_RUN_MAX); the cap warning is logged once. */
  outputsMade: number
  outputsCapWarned?: boolean
  /** Per named receiving agent: node id -> the signature last served in full (knowledge_recall and auto context). In memory only. */
  knowledgeShown: Map<string, Map<string, string>>
  /** Per named receiving agent: node id -> the signature last put in an automatic context block, full or not. In memory only. */
  knowledgeContextShown: Map<string, Map<string, string>>
  /** RunUsage.knowledge: recalls, auto context blocks, entities and characters served. */
  knowledgeUsage: KnowledgeServedUsage
  /** Per agent: knowledge.recalled throttle state (last emit, trailing timer, ids and `via` waiting to go out). */
  knowledgeRecalled: Map<string, RecalledThrottle>
  /** knowledgeBrief() was computed (also when it was undefined); the text is constant for the run. */
  knowledgeBriefDone?: boolean
  knowledgeBriefText?: string
  /** engagementDocument() was read (also when it was undefined); like the brief, the text is constant for the run so a resumed session keeps a cache-stable prompt prefix. */
  engagementDocumentDone?: boolean
  engagementDocumentText?: string
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
  // ---------- headless exec (cli-spec 6.2) ----------
  /** The run's RuntimeContext (exec settlement reads ctx.autoContinue). Set before adapter.start. */
  ctx?: RuntimeContext
  /** The caller held the 'configure' scope: widening overrides apply (effectiveRunProject). Never persisted. */
  allowWidening?: boolean
  /** The newest root turn generation the adapter reported (ctx.onRootTurnEnded). */
  rootTurnGen: number
  /** Bumped on every activity that may keep an exec run from settling (and that resets the stall watchdog). */
  activityGen: number
  lastTurnEnd?: RootTurnEnd
  settleTimer?: ReturnType<typeof setTimeout>
  stallTimer?: ReturnType<typeof setTimeout>
  /** finalizeExecRun in flight or done (the first outcome claimed it). */
  finalizing?: Promise<void>
  /** The outcome finalizeExecRun claimed. */
  finalOutcome?: ExecOutcome
  /** The finalizer wrote the final status (or gave up): teardown no longer waits for it. */
  finalizeDone?: boolean
  /** The finalizer's own run.status is going through emit (late adapter statuses are dropped otherwise). */
  finalEmitting?: boolean
  /** run.finalized was broadcast (by the finalizer, or best effort by a quit). */
  finalizedSent?: boolean
  /** The adapter reported run.status 'error' after the finalizer claimed the run (its text, or ''). */
  adapterError?: string
  /** Decision cards the headless policy resolved as a refusal (maxAutoDenials). */
  autoDenials: number
  /** Headless policy timers per card id (grace before acting, or the 'wait' timeout). */
  policyTimers: Map<string, ReturnType<typeof setTimeout>>
  /** The run-title task (finalizeExecRun joins it). */
  titleTask?: Promise<void>
  /** adapter.start() in flight (finalizeExecRun waits for it before stopping). */
  opening?: Promise<unknown>
  /** Exec budget (execBudgetUsd of the effective project) and the exec chain's cost before this run. */
  execBudget?: number
  chainPriorCostUsd: number
  /** Agents already checked for an unpriced model (exec budget). */
  priceChecked: Set<string>
  /** Bridged reports (multi-provider org charts): the child sessions of this run. Set at start when roles are bridged. */
  bridge?: BridgedSessions
  /** Agents the bridge wrapper emitted (remapped id -> the bridged role's connection); later upserts keep it. */
  /** agent.compacted events counted per agent id (AgentInstance.compactions, set on every agent.upsert). */
  compactions?: Map<string, number>
  bridgedAgents?: Map<string, ConnectionId>
  /** RunConnection per distinct connection of bridged roles, for pricing (never emitted, logged or persisted). */
  bridgedConnections?: RunConnection[]
  /** Whether a model setting or id has a known price on this run's connection (exec budget). Set in start(). */
  modelPriced?: (model: string) => boolean
  /**
   * The permission mode the user chose for this run (start-time choice, a carried one, or runs:setPermissionMode). It is
   * laid over ctx.project every time the project is re-derived (runProjectFor), so a live install or proposal cannot undo it.
   * An "accept edits" grant never changes it (see acceptEditsGrant).
   */
  chosenMode?: PermissionMode
  /**
   * The adapter applied a session / project "accept edits" grant to this session (RuntimeContext.acceptEditsGranted):
   * runProjectFor lays acceptEdits over a narrower mode for the rest of the session. Cleared by an applied
   * runs:setPermissionMode (the adapter drops its grant on a narrowing). Never persisted or carried.
   */
  acceptEditsGrant?: true
  /** Bumped by each followed "accept edits" grant, so setPermissionMode can tell one landed while it awaited. */
  modeGen?: number
  /** The run's live project (start()'s `live`, as setLive keeps it), so mode changes re-derive ctx.project from it. */
  liveProject?: () => Project
  /** A runs:setPermissionMode call is waiting on the session: a second one is refused (serialized per run). */
  permissionModeChanging?: boolean
  /** teardown ran (it may be reached from both the finalizer and session.finished). */
  tornDown?: boolean
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
  // A calendar month replaces since / until; a malformed one is refused, never ignored.
  if (q.range !== undefined && q.range !== null) {
    const { since, until } = monthRange((q.range as { month?: unknown }).month as string)
    out.since = since
    out.until = until
  }
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
  /**
   * Interactive clients right now: open desktop windows plus attached TUI or interactive sockets. The headless decision
   * policy waits humanGraceMs before auto-resolving a card while this is above 0. Missing = 0.
   */
  interactiveClients?: () => number
  /**
   * The orgai command's own host (hostKind 'inproc'): nothing but that process can answer a card, so a `wait` decision
   * policy is turned into `fail` when a run starts, whichever path brought it (cli-standalone-default.md 4.3).
   */
  noWaitPolicy?: boolean
  /**
   * Team evolution (evolve/service.ts afterRun): the post-run ratchet pass of a run started with `evolve`. Never starts a
   * run; errors are swallowed and logged here. Missing = `evolve` on a start is ignored.
   */
  evolveAfterRun?: (input: { projectId: string; evolve: true; strategy?: EvolveStrategy; evalWindowRuns?: number }) => Promise<EvolvePostRunResult>
  /** OrgAI's data dir, for the allowed-folder checks. Tests may omit it (the data-dir check is then skipped). */
  dataDir?: string
  /**
   * Team files (teamFiles/service.ts): called at the top of start() for work and setup runs. Returns the fresh stored
   * project (the team is fixed for the run from here on) and a warning when the files hold changes waiting for approval.
   * Never throws; virtual and engagement projects come back unchanged.
   */
  teamFiles?: { beforeRun(project: Project): { project: Project; warning?: string } }
  /**
   * RuntimeContext.controlProtectedPaths (bootstrap: controlProtectedPaths(dataDir, ownership.runtimeDir)). Missing =
   * controlProtectedPaths(dataDir) when dataDir is set, else none.
   */
  controlProtectedPaths?: () => string[]
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
  /** The model catalog used to decide which adapter a proxy project runs on (adapterForProject). Default: empty. */
  catalog?: () => ProviderModel[]
  /** The last background model-discovery failure of a connection (ConnectionInfo.modelsError), for the run-start model check. */
  modelsError?: (connection: ConnectionId) => string | undefined
  /**
   * App settings for the built-in roles' models (setupModel, mcpAssistModel) and the connections' tier mappings.
   * Missing = the built-in roles use the 'deep' tier on the run's connection.
   */
  appSettings?: () => Pick<AppSettings, 'setupModel' | 'mcpAssistModel' | 'connections'> &
    Partial<Pick<AppSettings, 'modelPrices' | 'communityPrices' | 'skillAssistModel' | 'quickRunModel'>>
  /** How a run reaches its models; errors become start errors. Missing = no RuntimeContext.connection. */
  resolveConnection?: (project: Project, choice: AdapterChoice) => RunConnection
  /**
   * Bridged reports (multi-provider org charts): the RunConnection of a role on another connection / adapter than the
   * run's root (ConnectionService.runConnectionFor). Throws a readable error when it cannot be used; the run is then
   * refused. Missing = only 'mock' bridged roles can run ("This project has roles on other connections...").
   */
  resolveRoleConnection?: (project: Project, target: { connection: ConnectionId; adapter: ProviderId }) => RunConnection
  /**
   * RuntimeContext.connectionModels on setup runs: every connection a drafted role may name (connectionConfigured),
   * with its tier mapping and catalog ids. Missing = drafts may not name another connection.
   */
  connectionModels?: () => { connection: ConnectionId; name: string; tierModels: Partial<Record<ModelTier, ModelRef>>; models: ModelRef[] }[]
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
    skippedServers?(project: Project): { name: string; missing: string[]; scope?: 'project' }[]
    /** The app-wide MCP library (secret-free), for setup-like runs. */
    libraryEntries?(): McpLibraryEntry[]
    /**
     * The names of an approved MCP proposal's servers still waiting for a secret (McpService.storeProposalSecrets).
     * projectId null = library session. RunManager calls it with `values` undefined after the apply: the typed values
     * (ProposalDecision.secrets) go into SetupService.applyProposal / applyLibraryProposal as `secrets`, which store
     * them before any record changes (round 6 item 10).
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
  /**
   * Context notes of a stored project (store/projectData.ts), for RuntimeContext.engagementNotes on engagement work
   * runs and single-agent runs. Missing = no engagement_context data. `save` is the store's saveNote with an agent
   * writer (RunManager fills the run id and role); missing = the tool's save action is refused.
   */
  engagementNotes?: {
    list(projectId: string): EngagementNote[]
    read(projectId: string, noteId: string): EngagementNoteContent | null
    save?(projectId: string, input: { noteId?: string; title: string; text: string }, writer: EngagementNoteWriter): EngagementNote
  }
  /**
   * The engagement knowledge graph store (store/knowledge.ts `knowledgeStore(dataDir)`), for RuntimeContext.knowledge
   * on engagement work runs. Missing = engagement_knowledge is not offered.
   */
  knowledge?: KnowledgeStoreApi
  /**
   * Push projects:engagementChanged to every window after an agent wrote a note ('notes') or the knowledge graph
   * ('knowledge') (bootstrap.ts emits it on the host's HostEventBus). Missing = no push.
   */
  engagementChanged?: (event: EngagementChangedEvent) => void
  /**
   * The run outputs service (outputs/service.ts `createOutputsService(dataDir)`), for RuntimeContext.outputs on work
   * runs of stored projects (never quick, setup-like, build or virtual-project runs). Missing = the tools say outputs
   * are not available.
   */
  outputs?: OutputsServiceApi
  /** Push outputs:changed after an agent produced or registered an output (bootstrap.ts emits it on the HostEventBus). Missing = no push. */
  outputsChanged?: (event: OutputsChangedEvent) => void
  /**
   * A saved team template's roles converted for `project` (setup/templates.ts, the agent-import convert path),
   * for RuntimeContext.orgTemplate on setup runs. null for an unknown id. Missing = templates unavailable.
   */
  orgTemplate?: (templateId: string, project: Project) => { name: string; roles: Role[] } | null
  /** Self-knowledge and self-configuration (app_reference, open_in_app, appSettings apply). See SelfKnowledgeHooks. */
  selfKnowledge?: SelfKnowledgeHooks
  /** Schedules (schedules/service.ts): RuntimeContext.schedules and the apply of an approved 'schedules' proposal. Missing = neither. */
  schedules?: RunManagerScheduleHooks
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

/** A proposal approval refused before anything was applied: decideProposal keeps the card pending (Wave 7). */
class ProposalKeptOpen extends Error {}

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
/** A project or role name for one log line: control characters become spaces, at most 80 chars. */
const logText = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 80)

/** A decision method's 'applied' outcome. */
function applied(runId: string, requestId: string, effectiveDecision: string | undefined, opts: DecisionOptions): DecisionOutcome {
  return {
    status: 'applied',
    runId,
    requestId,
    ...(effectiveDecision ? { effectiveDecision } : {}),
    ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {})
  }
}

/** The pending card `id` in one run's maps, with its kind and revision. */
function findPendingCard(cards: PendingCardMaps, id: string): { kind: CardKind; revision?: number } | undefined {
  const permission = cards.pending.get(id)
  if (permission) return { kind: 'permission', revision: permission.request.revision }
  const question = cards.pendingQuestions.get(id)
  if (question) return { kind: 'question', revision: question.question.revision }
  const proposal = cards.pendingProposals.get(id)
  if (proposal) return { kind: 'proposal', revision: proposal.proposal.revision }
  const rules = cards.pendingRules.get(id)
  if (rules) return { kind: 'rules', revision: rules.request.revision }
  const merge = cards.pendingMerges.get(id)
  if (merge) return { kind: 'merge', revision: merge.review.revision }
  const install = cards.pendingInstalls.get(id)
  if (install) return { kind: 'mcpInstall', revision: install.request.revision }
  return undefined
}

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
  modelSelection?: RunSummary['modelSelection']
  conversationBudgetUsd?: number
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
  /**
   * Work runs of a stored project only: 'single' runs one assistant built from the project (RunSummary.team).
   * Refused on setup-like runs, quick runs and virtual projects. Continuations carry it from the run they continue.
   */
  team?: RunTeam
  /** Headless exec overrides (cli-spec 6.2(1)); host clients only. Refused on setup-like runs; stored on RunSummary.overrides. */
  overrides?: RunOverrides
  /** The caller holds the 'configure' scope: widening overrides apply (runOverrides.ts effectiveRunProject). */
  allowWidening?: boolean
  /**
   * Team evolution (StartRunInput.evolve): after this run ends, one post-run ratchet pass (RunManagerOptions.evolveAfterRun).
   * Honoured for stored-project work runs that are not quick runs; dropped otherwise. Not carried by continuations.
   */
  evolve?: boolean | EvolveStrategy
  /** With `evolve`: how many finished runs a trial generation the pass applies is measured over (1..10; the engine's default otherwise). */
  evolveWindowRuns?: number
  /**
   * The desktop user's start-time choices (StartRunInput.modelSelection / effort / permissionMode). Only the desktop
   * runs:start handler sets it; RunManager validates each against the catalog, effortOptionsFor and
   * runPermissionModeChoices and refuses (throws) before a run exists.
   */
  userChoice?: StartUserChoice
  /**
   * Set only by ScheduleService (never from IPC input): the schedule starting this work run, recorded as
   * RunSummary.scheduleId / scheduleName. Continuations pass it only on RunManager's own usage-limit auto-resume of a
   * scheduled run (SCHEDULED_RESUME); a user's continuation never does.
   */
  schedule?: { id: string; name: string }
  /** Set by continueRun only (a symbol key, so no caller input can carry it): the per-run choices of the continued run. */
  [CARRIED_CHOICES]?: CarriedChoices
}

/** StartInput.userChoice. */
export interface StartUserChoice {
  modelSelection?: { model: string; connection: ConnectionId }
  effort?: Effort
  permissionMode?: PermissionMode
}

/** Internal StartInput key: what continueRun carries from the run it continues (already vetted for the permission mode). */
const CARRIED_CHOICES = Symbol('carriedChoices')

interface CarriedChoices {
  /** The continued run's root effort; start() drops it (with a warning) on an adapter that does not take it. */
  rootEffort?: Effort
  /** A chosen permission mode that continueRun decided to carry. */
  permissionMode?: PermissionMode
  /** Lines logged on the new run right after it starts. */
  logs?: { level: 'info' | 'warn'; message: string }[]
}

/** What a run of this kind is, for the checks on a desktop user's per-run choices. */
export interface StartChoiceRun {
  kind: RunKind
  quick?: QuickRunInfo
  buildWorkspace?: string
  /** An exec run (overrides.execMode): it keeps the mode it started with. */
  exec: boolean
}

/** The same text rule as switchModel's: non-empty, short, trimmed, no control characters. */
const isChoiceText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)

/**
 * Start-time choices of the desktop user (StartInput.userChoice), checked BEFORE a run exists, so a refusal leaves no
 * run and no stored record. Pure; throws a plain-words Error on the first problem and returns only the known, clean
 * fields. The effort is checked against the adapter once choose() has picked it (checkStartEffort).
 *
 * - modelSelection: valid text for both fields, and the catalog holds exactly that id on exactly that connection
 *   (stricter than a continuation, which may keep a selection whose model has left the catalog).
 * - permissionMode: a real mode that runPermissionModeChoices lists for this run (setup-like runs and Chat / build
 *   sessions are narrowed there); an exec run keeps the mode it started with.
 */
export function checkStartChoice(choice: StartUserChoice, run: StartChoiceRun, catalog: readonly ProviderModel[]): StartUserChoice {
  const out: StartUserChoice = {}
  if (choice.modelSelection !== undefined) {
    const sel: unknown = choice.modelSelection
    const model = sel && typeof sel === 'object' ? (sel as { model?: unknown }).model : undefined
    const connection = sel && typeof sel === 'object' ? (sel as { connection?: unknown }).connection : undefined
    if (!isChoiceText(model) || !isChoiceText(connection)) throw new Error('Invalid model selection')
    if (!catalog.some((m) => m.id === model && m.connection === connection)) throw new Error('This model is not available on that connection. Choose another model.')
    out.modelSelection = { model, connection }
  }
  if (choice.effort !== undefined) {
    if (!isEffort(choice.effort)) throw new Error('Invalid effort level')
    out.effort = choice.effort
  }
  if (choice.permissionMode !== undefined) {
    if (!isPermissionMode(choice.permissionMode)) throw new Error('Invalid permission mode')
    if (run.exec) throw new Error('Exec runs keep the mode they started with.')
    if (!runPermissionModeChoices({ kind: run.kind, quick: run.quick, buildWorkspace: run.buildWorkspace }).includes(choice.permissionMode)) {
      throw new Error('This run cannot use that permission mode.')
    }
    out.permissionMode = choice.permissionMode
  }
  return out
}

/** The effort a run's adapter takes (effortOptionsFor); throws a plain-words Error otherwise. Pure. */
export function checkStartEffort(effort: Effort, adapter: ProviderId): void {
  if (!effortOptionsFor(adapter).includes(effort)) throw new Error(`This model does not take the ${effort} effort level.`)
}

/** Internal ContinueRunOptions key: the automatic rate-limit resume (keeps the exec fields like `exec`). */
const AUTO_RESUME = Symbol('autoResume')
/** Internal ContinueRunOptions key: the schedule of a run RunManager's own auto-resume continues (never a user continuation). */
const SCHEDULED_RESUME = Symbol('scheduledResume')

/** continueRun options (cli-spec 6.2(1)). */
export interface ContinueRunOptions {
  /** Merged over the overrides carried from the continued run. */
  overrides?: RunOverrides
  /** `orgai resume --exec`: keep the chain's execMode / execChainId / waitForReset / decisionPolicy. */
  exec?: boolean
  /** The caller holds the 'configure' scope. */
  allowWidening?: boolean
  /** The desktop surface (or RunManager's own resume timer): a widening per-run permission mode the user chose carries. */
  desktop?: true
  /** Set only by RunManager's own auto-resume. */
  [AUTO_RESUME]?: true
  /** Set only by RunManager's own auto-resume of a scheduled run: the continuation stays the schedule's (ScheduleService tracks it). */
  [SCHEDULED_RESUME]?: { id: string; name: string }
}

/** Narrowing overrides a continuation always keeps (goal never widens: picks stay inside the roles' ceilings). */
const NARROWING_KEYS = ['permissionMode', 'maxBudgetUsd', 'autoContinue', 'maxAutoContinues', 'strictDelegation', 'goal'] as const
/** Exec fields a continuation keeps only with `exec` or on the automatic resume. */
const EXEC_KEYS = ['execMode', 'execChainId', 'waitForReset', 'decisionPolicy', 'allowUnmerged', 'allowUnpricedBudget', 'execStallTimeoutMs', 'allowPeerMessages'] as const

/** Carried exec fields that only a 'configure' caller can set (overridesWidening): kept only with allowWidening. */
const CONFIGURE_ONLY_EXEC_KEYS: ReadonlySet<string> = new Set(['allowPeerMessages', 'allowUnpricedBudget'])

/**
 * The overrides of a continuation (cli-spec 6.2(1)): the continued run's narrowing overrides always, its exec fields
 * only for `orgai resume --exec` or the automatic resume (a later desktop continue strips them), then opts.overrides
 * on top. allowPeerMessages / allowUnpricedBudget carry over only with allowWidening (an 'operate'-only resume never
 * inherits a 'configure' grant). A decisionPolicy merges per field over the carried one (opts.overrides may give only
 * the fields the client set) and the remaining choices take the defaults. undefined when nothing is left.
 * With `project` (the project the run continues as) and neither `exec` nor the automatic resume, a carried narrowing
 * key that would widen that project now (overridesWidening) is dropped, so the project's value applies: `allowWidening`
 * then widens only the fields this call supplied (PR 49 review H2: a TUI continue with a staged /goal must not bring
 * back an earlier exec's bypassPermissions, autoContinue or budget on a project narrowed since).
 */
export function continuedOverrides(prev: RunOverrides | undefined, opts: ContinueRunOptions, project?: Project): RunOverrides | undefined {
  const out: Record<string, unknown> = {}
  const keepExec = opts.exec === true || opts[AUTO_RESUME] === true
  for (const k of [...NARROWING_KEYS, ...(keepExec ? EXEC_KEYS : [])]) {
    if (CONFIGURE_ONLY_EXEC_KEYS.has(k) && opts.allowWidening !== true) continue
    const v = prev?.[k]
    if (v === undefined) continue
    if (project && !keepExec && overridesWidening(project, { [k]: v } as RunOverrides).length > 0) continue
    out[k] = typeof v === 'object' ? structuredClone(v) : v
  }
  for (const [k, v] of Object.entries(opts.overrides ?? {})) {
    if (v === undefined) continue
    if (k === 'decisionPolicy') {
      const merged: Record<string, unknown> = { ...((out.decisionPolicy as object | undefined) ?? {}) }
      for (const [pk, pv] of Object.entries(v as object)) if (pv !== undefined) merged[pk] = pv
      out.decisionPolicy = merged
    } else out[k] = v
  }
  if (out.decisionPolicy) {
    const policy = out.decisionPolicy as Record<string, unknown>
    for (const k of ['permission', 'rules', 'mcpInstall', 'question', 'proposal', 'merge'] as const) policy[k] ??= DEFAULT_HEADLESS_DECISION_POLICY[k]
  }
  return Object.keys(out).length ? (out as RunOverrides) : undefined
}

/**
 * Copy the grant fields (Role.mcpServers, Role.skills) of the saved roles onto a running session's roles, matched by id,
 * in place: the adapters hold these objects (role maps, the spawn network, the MCP and Skill gates, agent definitions
 * rebuilt on a restart), so an ungrant or a new grant approved mid-run is in force on the next call. Role identity never
 * changes mid-run: a role an org change added joins on the next run, and a role it removed keeps its start-time
 * definition (and grants) until this run ends. Every other field stays as the run started.
 */
/**
 * What an approved change touched, for the live run's project view (setLive): servers and their role grants, skills and
 * their role grants, the org chart, the allowed folders or the permission mode. Nothing else moves, so team-file changes
 * the same save ingested stay out of a live run.
 */
type LiveSettle = 'mcpServers' | 'skills' | 'orgChart' | 'folders' | 'permissionMode'

/** The items an approved change named itself: only these move onto a live run's project (setLive). */
export interface LiveOwnItems {
  /** Server or skill ids, library entry ids included. */
  ids: readonly string[]
  /** Server or skill names. */
  names: readonly string[]
}

/**
 * The live list with only the change's own items taken from the saved project, in place, new ones at the end, gone ones
 * removed; the roles' grants to those items follow and every other grant stays. A team-file change the same save
 * ingested may touch the same list, but it names other items, so it stays out of the live run. Pure.
 */
export function overlayOwnItems<T extends { id: string; name: string; libraryId?: string }>(
  live: readonly T[] | undefined,
  saved: readonly T[] | undefined,
  liveRoles: readonly Role[],
  savedRoles: readonly Role[],
  field: 'mcpServers' | 'skills',
  own: LiveOwnItems
): { items: T[] | undefined; roles: Role[] } {
  const ids = new Set(own.ids)
  const names = new Set(own.names)
  const isOwn = (x: T): boolean => ids.has(x.id) || names.has(x.name) || (!!x.libraryId && ids.has(x.libraryId))
  const savedById = new Map((saved ?? []).filter(isOwn).map((x) => [x.id, x]))
  const savedByName = new Map((saved ?? []).filter(isOwn).map((x) => [x.name, x]))
  const used = new Set<string>()
  const items: T[] = []
  for (const x of live ?? []) {
    if (!isOwn(x)) {
      items.push(x)
      continue
    }
    const replacement = savedById.get(x.id) ?? savedByName.get(x.name)
    if (replacement && !used.has(replacement.id)) {
      used.add(replacement.id)
      items.push(replacement)
    }
  }
  for (const x of saved ?? []) if (isOwn(x) && !used.has(x.id)) items.push(x)
  const ownIds = new Set([...(live ?? []).filter(isOwn), ...(saved ?? []).filter(isOwn)].map((x) => x.id))
  const savedRole = new Map(savedRoles.map((r) => [r.id, r]))
  const roles = liveRoles.map((r) => {
    const s = savedRole.get(r.id)
    if (!s || !ownIds.size) return r
    const mine = (r[field] ?? []).filter((id) => !ownIds.has(id))
    const theirs = (s[field] ?? []).filter((id) => ownIds.has(id))
    const merged = [...mine, ...theirs]
    const out: Role = { ...r }
    if (merged.length || r[field] !== undefined) out[field] = merged
    return out
  })
  return { items: live === undefined && saved === undefined ? undefined : items, roles }
}

/**
 * The live roles with only the approved org chart's own roles (matched by id or name) taken from the saved roles, in
 * place, new ones at the end. Roles the proposal did not name stay as the run has them, so a prompt edit the same
 * save ingested from the team files never reaches a live run. Pure.
 */
export function overlayOwnRoles(live: readonly Role[], saved: readonly Role[], own: { ids: readonly string[]; names: readonly string[] }): Role[] {
  const ids = new Set(own.ids)
  const names = new Set(own.names)
  const isOwn = (r: Role): boolean => ids.has(r.id) || names.has(r.name)
  const mine = saved.filter(isOwn)
  const byId = new Map(mine.map((r) => [r.id, r]))
  const byName = new Map(mine.map((r) => [r.name, r]))
  const used = new Set<string>()
  const out: Role[] = []
  for (const r of live) {
    if (!isOwn(r)) {
      out.push(r)
      continue
    }
    const next = byId.get(r.id) ?? byName.get(r.name)
    if (next && !used.has(next.id)) {
      used.add(next.id)
      out.push(next)
    }
  }
  for (const r of mine) if (!used.has(r.id)) out.push(r)
  return out
}

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

/** How many post-run evolve passes RunManager remembers for awaitEvolvePass. */
const EVOLVE_PASSES_KEPT = 50

export class RunManager {
  private runs = new Map<string, ActiveRun>()
  /** Run id -> its post-run evolve pass (bounded; startEvolvePass / awaitEvolvePass). */
  private evolvePasses = new Map<string, Promise<EvolvePostRunResult | undefined>>()
  /** Post-run evolve passes not settled yet: shutdown waits for them (evolvePassCount) before it lets go of the folder. */
  private evolvePassesInFlight = 0
  /** Paused run id -> its auto-resume timer. Lives only as long as the app process. */
  /** Every pending title query, live run or not, with its project id; stopAll and removeProject abort them. */
  private titleAborts = new Map<AbortController, string>()
  private resumeTimers =new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * waitForReset exec runs started by a 'configure' caller (allowWidening). The automatic rate-limit resume (the timer
   * path only) is the same invocation, so it keeps widening overrides; like the resume timers this lives only in this
   * process. Dropped with the timer (clearResume), at teardown without an armed timer, and when the resume consumes it.
   */
  private widenedRuns = new Set<string>()
  /** Set by stopAll({ reason: 'quit' }) and markQuit: no run starts, continues, resumes or takes a message after it. */
  private quitting = false
  /** adapter.start() calls not yet settled; stopAll waits for them so a session that opens during a quit is stopped. */
  private startsInFlight = new Set<Promise<unknown>>()
  /** Resumes (timer or manual) between their start and the successor run being registered (activity lease; withResumeLease). */
  private resumesInFlight = 0
  /** Pending decision cards across runs and tombstones of resolved ones (runs:findDecision, DecisionOutcome). */
  private decisions = new DecisionIndex()

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
  /**
   * Stop the project's live runs and cancel their titles. With `removeRuns` (default true) its run records are deleted
   * too; resolves with the number deleted (0 when kept).
   */
  async removeProject(projectId: string, { removeRuns = true }: { removeRuns?: boolean } = {}): Promise<number> {
    // Pending titles of the project's runs, live or already ended, are cancelled.
    for (const [a, pid] of this.titleAborts) if (pid === projectId) a.abort()
    for (const r of this.runs.values()) {
      if (r.summary.projectId === projectId) {
        r.userStopped = true
        this.clearExecTimers(r)
        await r.session?.stop().catch(() => {})
        if (r.flushTimer) clearTimeout(r.flushTimer)
        if (r.usageTimer) clearTimeout(r.usageTimer)
        for (const st of r.knowledgeRecalled.values()) if (st.timer) clearTimeout(st.timer)
        r.knowledgeRecalled.clear()
        this.runs.delete(r.summary.id)
      }
    }
    for (const s of this.store.list(projectId)) this.clearResume(s.id)
    return removeRuns ? this.store.removeProject(projectId) : 0
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
    // A quitting app (or draining host) spends no tokens on helpers.
    if (this.quitting) throw new Error('OrgAI is quitting; no model calls start now.')
    if (isVirtualProjectId(project.id)) throw new Error('The harness and the built-in assistant projects have no model connection for completions.')
    const { adapter, choice } = this.choose(project, 'setup')
    const connection = this.options.resolveConnection?.(project, choice)
    let model: string | undefined
    if (input.tier === 'fast') {
      model = this.options.fastModel?.(project, choice) ?? (choice.adapter === 'claude' ? 'haiku' : undefined)
    } else if (choice.adapter !== 'mock') {
      const tiered = connectionRecord(this.options.appSettings?.() ?? {}, choice.connection)?.tierModels?.everyday
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
   * start). On a proxy a mixed chart starts with one info line naming the roles on another family; setup-like runs
   * use a built-in role and only need the root's adapter.
   */
  private choose(project: Project, kind: RunKind): { adapter: RuntimeAdapter; choice: AdapterChoice } {
    const catalog = this.options.catalog?.() ?? []
    const choice = adapterForProject(project, catalog)
    const known = this.options.appSettings?.()
    if (known && choice.adapter !== 'mock' && !isKnownConnection(known, choice.connection)) {
      throw new Error('That connection no longer exists. Pick another in Project settings > Connection.')
    }
    if (!isSetupLikeRun(kind) && choice.mismatched.length) {
      const bad = choice.mismatched.map((id) => project.roles.find((r) => r.id === id)).filter((r): r is Role => !!r)
      const names = (bad.length ? bad.map((r) => r.name) : choice.mismatched).map((n) => logText(String(n)))
      const families = [...new Set(bad.map((r) => catalog.find((m) => m.id === r.model && m.connection === choice.connection)?.family ?? modelFamily(r.model)))]
      const other = families.length ? families.map((f) => (f === 'other' ? 'non-Claude' : (FAMILY_LABEL[f] ?? f))).join('/') : 'other'
      const where = connectionName(choice.connection, this.options.appSettings?.())
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

  /** The pricing context for a connection (`rc`: its RunConnection, when the run has one). Settings are read at each call. */
  private pricingContext(on: ConnectionId, rc: RunConnection | undefined): PricingContext {
    const s = this.options.appSettings?.()
    const community = s?.communityPrices === false ? undefined : this.options.communityPrices?.()
    return {
      connection: on,
      overrides: s?.modelPrices ?? [],
      ...(rc?.pricing ? { pricing: rc.pricing } : {}),
      catalog: this.options.catalog?.() ?? [],
      aliases: aliasesFor(rc, connectionRecord(s ?? {}, on)?.tierModels),
      ...(community ? { community } : {})
    }
  }

  /**
   * Whether a model setting or id has a known price on `on` (exec budget, and the start-time check of an explicitly
   * chosen model under a project cap). A tier name or alias is read through the connection's tier mapping first.
   */
  private modelIsPriced(setting: string, on: ConnectionId, rc: RunConnection | undefined): boolean {
    const tierModels = connectionRecord(this.options.appSettings?.() ?? {}, on)?.tierModels ?? {}
    // An empty catalog means "not discovered yet": the connection's builtin list answers then (modelForTier).
    const catalog = this.options.catalog?.() ?? []
    const resolved = resolveModelSetting(setting, { connection: on, tierModels, ...(catalog.length ? { catalog } : {}) })
    if (!resolved || resolved.model === 'inherit') return true
    const ctx = this.pricingContext(on, rc)
    if (resolvePrice(resolved.model, ctx) !== null) return true
    // A bare tier name or Claude alias the connection does not map is resolved by the CLI itself (latest model of the
    // family): its real id is only known from usage reports, which checkExecBudget prices live.
    return !!settingTier(resolved.model) && !Object.hasOwn(ctx.aliases ?? {}, resolved.model)
  }

  /**
   * The project a run's adapter sees: the live project with the run's overrides applied, then the user's per-run
   * permission mode (chosenMode) on top. The one place both start() and setLive() derive ctx.project from.
   */
  private runProjectFor(active: ActiveRun, project: Project): Project {
    const own = this.runOwnProject(active, project)
    return active.acceptEditsGrant && overlaidByAcceptEdits(own.permissionMode) ? { ...own, permissionMode: 'acceptEdits' } : own
  }

  /** runProjectFor without the "accept edits" grant overlay: the run's own mode, which RunSummary.permissionMode records. */
  private runOwnProject(active: ActiveRun, project: Project): Project {
    const effective = effectiveRunProject(project, active.summary.overrides, { allowWidening: active.allowWidening })
    return active.chosenMode ? { ...effective, permissionMode: active.chosenMode } : effective
  }

  /**
   * Re-derive ctx.project from the run's live project (chosenMode and the grant overlay included), record the run's own
   * mode (recordedRunPermissionMode) and the overlay (sessionPermissionMode) on the summary, and when any of the three
   * mode fields moved, save the summary and broadcast run.permissionMode. `ctx` defaults to active.ctx (setLive passes
   * its own, the same object once the run started). `force` saves and broadcasts even when the three fields did not
   * move since this call began (the caller changed permissionModeChosen itself first): one snapshot, after re-deriving.
   */
  private rederiveRunMode(active: ActiveRun, ctx: RuntimeContext | undefined = active.ctx, force = false): void {
    if (!ctx) return
    const live = active.liveProject?.()
    const own = live ? this.runOwnProject(active, live).permissionMode : (active.chosenMode ?? ctx.project.permissionMode)
    if (live) ctx.project = this.runProjectFor(active, live)
    const s = active.summary
    const before = `${s.permissionMode}|${s.permissionModeChosen}|${s.sessionPermissionMode}`
    const recorded = recordedRunPermissionMode(s, own)
    if (recorded) s.permissionMode = recorded
    else delete s.permissionMode
    if (ctx.project.permissionMode === 'acceptEdits' && own !== 'acceptEdits' && recorded !== undefined) s.sessionPermissionMode = 'acceptEdits'
    else delete s.sessionPermissionMode
    if (!force && `${s.permissionMode}|${s.permissionModeChosen}|${s.sessionPermissionMode}` === before) return
    this.store.upsert(s)
    this.broadcastRunMode(active)
  }

  /**
   * A session's "accept edits" grant ends with the session (never carried): at a finished / error / paused status and
   * at teardown. The ended run shows its own mode again. Idempotent.
   */
  private endAcceptEditsGrant(active: ActiveRun): void {
    delete active.acceptEditsGrant
    if (!active.summary.sessionPermissionMode) return
    delete active.summary.sessionPermissionMode
    this.store.upsert(active.summary)
    this.broadcastRunMode(active)
  }

  /** run.permissionMode: a snapshot of the summary's three mode fields (the renderer replaces all three). */
  private broadcastRunMode(active: ActiveRun): void {
    const s = active.summary
    this.broadcast({
      type: 'run.permissionMode',
      runId: s.id,
      ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
      ...(s.permissionModeChosen ? { permissionModeChosen: true as const } : {}),
      ...(s.sessionPermissionMode ? { sessionPermissionMode: s.sessionPermissionMode } : {})
    })
  }

  /**
   * RuntimeContext.acceptEditsGranted (reviews M1, M-a, M-b): the adapter applied a session / project "accept edits"
   * grant to its own session. RunManager lays acceptEdits over a narrower mode in force for the rest of this session
   * (ctx.project, RunSummary.sessionPermissionMode, run.permissionMode). The run's own mode, permissionModeChosen and
   * what a continuation carries are untouched: a session grant ends with its session. Only bound on work runs that are
   * not trust-restricted; bridged children never get the hook.
   */
  private followAcceptEditsGrant(active: ActiveRun): void {
    const ctx = active.ctx
    if (!ctx) return
    // Bumped on every grant, even a repeated one (re-check Low 1a): setPermissionMode must see each one that lands.
    active.modeGen = (active.modeGen ?? 0) + 1
    if (active.acceptEditsGrant) return
    active.acceptEditsGrant = true
    const before = ctx.project.permissionMode
    this.rederiveRunMode(active)
    if (before !== ctx.project.permissionMode) {
      const label = PERMISSION_MODE_OPTIONS.find((o) => o.value === 'acceptEdits')?.label ?? 'acceptEdits'
      active.emit({ type: 'log', runId: active.summary.id, level: 'info', message: `${label} is on for the rest of this session.` })
    }
  }

  /**
   * Bridged reports (multi-provider org charts): roles of a work run whose (connection, adapter) differs from the
   * root's run in child sessions. Only team work runs of a stored project bridge; quick, single, setup-like,
   * trust-restricted and virtual-project runs ignore the list. Refuses the run (throws) before it exists when a role's
   * connection cannot be used or this build cannot run it. Returns the RunConnection per distinct pair.
   */
  private resolveBridged(
    project: Project,
    choice: AdapterChoice,
    kind: RunKind,
    flags: { quick?: unknown; team?: RunTeam; buildWorkspace?: string }
  ): { bridged: BridgedRoleChoice[]; connections: Map<string, RunConnection> } {
    const none = { bridged: [] as BridgedRoleChoice[], connections: new Map<string, RunConnection>() }
    const list = choice.bridged ?? []
    if (!list.length) return none
    if (kind !== 'work' || flags.quick || flags.team === 'single' || isVirtualProjectId(project.id) || isTrustRestrictedRun({ quick: flags.quick as QuickRunInfo | undefined, buildWorkspace: flags.buildWorkspace })) return none
    const settings = this.options.appSettings?.()
    const problem = roleConnectionProblems(project, settings)[0]
    if (problem) throw new Error(problem.message)
    const connections = new Map<string, RunConnection>()
    for (const b of list) {
      const key = bridgeKey(b.connection, b.adapter)
      if (connections.has(key)) continue
      const roleName = project.roles.find((r) => r.id === b.roleId)?.name ?? b.roleId
      const where = connectionName(b.connection, settings)
      if (!this.adapters[b.adapter]) throw new Error(`Role ${logText(roleName)} runs on ${where}: no runtime adapter for provider "${b.adapter}".`)
      if (b.adapter === 'mock') {
        connections.set(key, { connection: b.connection, adapter: 'mock' })
        continue
      }
      if (!this.options.resolveRoleConnection) throw new Error('This project has roles on other connections, which this build cannot run.')
      try {
        connections.set(key, this.options.resolveRoleConnection(project, { connection: b.connection, adapter: b.adapter }))
      } catch (e) {
        throw new Error(`Role ${logText(roleName)} runs on ${where}: ${(e as Error).message}`)
      }
    }
    return { bridged: list, connections }
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
      connectionName: connectionName(choice.connection, settings),
      tierModels: connectionRecord(settings, choice.connection)?.tierModels ?? {},
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
    const tierModels = connectionRecord(settings ?? {}, connection)?.tierModels ?? {}
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
      connectionName: connectionName(choice.connection, settings),
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

  /** Where the project's saved rules live (projectRulesFile). An engagement needs the data dir: never falls back to a relative path. */
  private rulesFileFor(p: Pick<Project, 'id' | 'path' | 'kind' | 'folderConfigTrust'>): string {
    // An engagement or a project behind the folder config gate keeps its rules in the data folder, never in the folder.
    if (projectRulesLocation(p) === 'app' && !this.options.dataDir) throw new Error('OrgAI has no data folder to keep this project\'s rules in.')
    return projectRulesFile(p, this.options.dataDir ?? '')
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
    modelSelection,
    conversationBudgetUsd,
    resumedFrom,
    resumeBaseCostUsd,
    plan: carriedPlan,
    images: rawImages,
    notice,
    title: carriedTitle,
    titleContext,
    surface,
    quick,
    buildWorkspace,
    team,
    overrides: rawOverrides,
    allowWidening,
    userChoice,
    schedule,
    evolve: rawEvolve,
    evolveWindowRuns,
    [CARRIED_CHOICES]: carried
  }: StartInput): Promise<RunSummary> {
    this.refuseWhileQuitting()
    if (team !== undefined && team !== 'single') throw new Error('Unknown team for this run.')
    let continuationBudget = conversationBudgetUsd !== undefined ? projectBudgetUsd(project) : undefined
    // Headless exec overrides (cli-spec 6.2(1)) shape work runs only.
    let overrides: RunOverrides | undefined = rawOverrides && Object.keys(rawOverrides).length ? { ...rawOverrides } : undefined
    if (overrides && this.options.noWaitPolicy) overrides = withoutWaitPolicy(overrides)
    if (overrides && isSetupLikeRun(kind)) throw new Error('Run overrides apply to work runs only.')
    if (team === 'single') {
      if (kind !== 'work') throw new Error('Only a work run can use the single assistant.')
      if (isVirtualProjectId(project.id) || quick || buildWorkspace) throw new Error('The single assistant runs on a saved project only.')
    }
    // Each virtual project belongs to exactly one kind of run.
    if (project.id === HARNESS_PROJECT_ID && kind !== 'mcp-assist') throw new Error('Only the MCP assistant can run on the harness project.')
    if (project.id === SKILLS_PROJECT_ID && kind !== 'skill-assist') throw new Error('Only the Skill assistant can run on the skills project.')
    if (project.id === QUICK_PROJECT_ID && (kind !== 'work' || !quick)) throw new Error('Only a quick run can run on the quick project.')
    if (quick && project.id !== QUICK_PROJECT_ID) throw new Error('Quick run details belong to the quick project only.')
    if (buildWorkspace && kind !== 'mcp-assist') throw new Error('A build workspace belongs to an MCP assistant run.')
    // Team files: the folder is checked first (a pulled change is gated), so the run starts on the last approved team.
    let teamWarning: string | undefined
    if (this.options.teamFiles && (kind === 'work' || kind === 'setup') && !isVirtualProjectId(project.id) && !quick && !buildWorkspace) {
      try {
        const fresh = this.options.teamFiles.beforeRun(project)
        if (fresh.project?.id === project.id) {
          if (continuationBudget !== undefined && fresh.project !== project && conversationBudgetUsd !== undefined) {
            const totalCap = Math.min(conversationBudgetUsd, projectBudgetUsd(fresh.project) ?? Infinity)
            const prior = resumedFrom ? this.summary(resumedFrom) : null
            const spent = prior ? this.chainOf(prior).reduce((sum, r) => sum + Math.max(0, r.usage?.costUsd ?? r.totalCostUsd), 0) : 0
            continuationBudget = Math.min(continuationBudget, totalCap - spent)
            conversationBudgetUsd = totalCap
          }
          project = fresh.project
        }
        teamWarning = fresh.warning
      } catch (e) {
        log.warn(`Team files could not be checked before the run: ${(e as Error).message}`)
      }
    }
    // Linked MCP servers come from the library as it is now (a deleted entry disables its links).
    if (continuationBudget !== undefined && continuationBudget <= 0) throw new Error('The conversation budget is spent; switching models does not reset it.')
    project = this.options.mcp?.withLibrary?.(project) ?? project
    // Team/library refreshes return stored projects, whose cap has not had conversation spend deducted.
    if (continuationBudget !== undefined) project = { ...project, maxBudgetUsd: Math.min(continuationBudget, projectBudgetUsd(project) ?? Infinity) }
    // The Chat's single assistant settles its model before the adapter is chosen.
    let quickWarning: string | undefined
    if (team === 'single') project = singleRunProject(project, this.options.appSettings?.().quickRunModel)
    if (quick?.team === 'single' || team === 'single') {
      const resolved = this.resolveQuickAssistant(project)
      project = resolved.project
      quickWarning = resolved.warning
    }
    // ---- The desktop user's start-time choices (userChoice). Every check below runs before `summary` is created, so a
    // refusal leaves no run: nothing is stored and nothing is in this.runs. Model first (it settles the adapter), then
    // the effort against that adapter, the permission mode, and the price of an explicitly chosen model under a cap.
    const choiceRun: StartChoiceRun = { kind, ...(quick ? { quick } : {}), ...(buildWorkspace ? { buildWorkspace } : {}), exec: !!overrides?.execMode }
    const chosen = userChoice ? checkStartChoice(userChoice, choiceRun, this.options.catalog?.() ?? []) : undefined
    // An explicit choice wins over the single assistant's quick-run model settled above.
    if (chosen?.modelSelection) modelSelection = chosen.modelSelection
    // Adapter and connection are settled before a run exists, so a refusal leaves no run behind.
    if (modelSelection) {
      const selected = this.options.catalog?.().find((m) => m.id === modelSelection.model && m.connection === modelSelection.connection)
      if (!selected && modelSelection.connection !== projectConnection(project)) throw new Error('Selected model is no longer available')
      const originalConnection = projectConnection(project)
      project = { ...project, provider: { ...project.provider, connection: modelSelection.connection, id: project.provider.id === 'mock' ? 'mock' : selected?.adapter ?? project.provider.id }, roles: project.roles.map((r) => r.reportsTo === null ? { ...r, model: modelSelection.model, connection: modelSelection.connection } : { ...r, connection: r.connection ?? originalConnection }) }
    }
    const { adapter, choice } = this.choose(project, kind)
    if (modelSelection && modelSelection.connection !== choice.connection) {
      throw new Error(chosen?.modelSelection ? 'That connection is not available. Choose another model.' : 'The original connection is no longer available for this session')
    }
    // The root's effort: a chosen one must suit the adapter that will run (refused); a carried one that does not is
    // dropped with a warning on the new run (a continuation never refuses over it).
    let rootEffort: Effort | undefined
    let droppedEffort: Effort | undefined
    if (chosen?.effort) {
      checkStartEffort(chosen.effort, choice.adapter)
      rootEffort = chosen.effort
    } else if (carried?.rootEffort) {
      if (effortOptionsFor(choice.adapter).includes(carried.rootEffort)) rootEffort = carried.rootEffort
      else droppedEffort = carried.rootEffort
    }
    // The user's permission mode for this run (a validated choice, or one continueRun decided to carry). An exec run
    // keeps the mode of its overrides. ctx.project gets it through runProjectFor.
    const chosenMode: PermissionMode | undefined = chosen?.permissionMode ?? (carried?.permissionMode && !overrides?.execMode ? carried.permissionMode : undefined)
    const bridging = this.resolveBridged(project, choice, kind, { quick, team, buildWorkspace })
    const connection = this.options.resolveConnection?.(project, choice)
    // An explicit model under a project cap needs a known price, or the cap could not be enforced. Checked here, with
    // the same pricing as active.modelPriced, so the refusal still leaves no run.
    if (chosen?.modelSelection && projectBudgetUsd(project) !== undefined && !overrides?.allowUnpricedBudget && !this.modelIsPriced(chosen.modelSelection.model, choice.connection, connection)) {
      throw new Error('This model has no known price, so the project budget cannot be enforced.')
    }
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
      modelAdapter: choice.adapter,
      ...(conversationBudgetUsd !== undefined && conversationBudgetUsd > 0 && Number.isFinite(conversationBudgetUsd) ? { conversationBudgetUsd } : {}),
      // Labels the run's cost in the UI (CLI estimate, proxy prices, or none on a ChatGPT plan).
      connection: connection?.connection ?? choice.connection
    }
    if (resumedFrom) summary.resumedFrom = resumedFrom
    if (carriedTitle && kind === 'work') summary.title = carriedTitle
    if (surface === 'team' && kind === 'setup') summary.surface = surface
    if (quick) summary.quick = { ...quick }
    if (buildWorkspace) summary.buildWorkspace = buildWorkspace
    if (team === 'single') summary.team = 'single'
    if (schedule && kind === 'work') {
      summary.scheduleId = schedule.id
      summary.scheduleName = schedule.name
    }
    if (overrides) {
      if (overrides.execMode && !overrides.execChainId) overrides.execChainId = summary.id
      summary.overrides = overrides
    }
    // Display facts, set before the first save: the mode in force (only runs that take a per-run mode; see
    // recordedRunPermissionMode) and the user's per-run choices.
    const modeInForce = chosenMode ?? effectiveRunProject(project, overrides, { allowWidening }).permissionMode
    // Schedules (docs/design/schedules.md 6): a scheduled run, its auto-resume included, never runs with bypass.
    if (summary.scheduleId && modeInForce === 'bypassPermissions') throw new Error('A scheduled run cannot use bypass permissions. Choose a permission mode for the schedule.')
    const recordedMode = recordedRunPermissionMode(summary, modeInForce)
    if (recordedMode) summary.permissionMode = recordedMode
    if (chosenMode) summary.permissionModeChosen = true
    if (rootEffort) summary.rootEffort = rootEffort
    const exec = !!overrides?.execMode
    // Team evolution: stored-project work runs only (never setup, quick, single-assistant or virtual-project runs).
    const evolveMode: EvolveStrategy | true | undefined =
      rawEvolve && kind === 'work' && !quick && !buildWorkspace && team !== 'single' && !isVirtualProjectId(project.id) && this.options.evolveAfterRun ? (rawEvolve === true ? true : rawEvolve) : undefined
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
      ...(projectRulesLocation(project) === 'app' ? { rulesTarget: { file: this.rulesFileFor(project) } } : {}),
      runServers: new Map(),
      emit: () => {},
      skills: [],
      skillCounts: new Map(),
      skillLoads: 0,
      knowledgeWrites: 0,
      outputsMade: 0,
      knowledgeShown: new Map(),
      knowledgeContextShown: new Map(),
      knowledgeUsage: { recalls: 0, autoContexts: 0, itemsServed: 0, charsServed: 0 },
      knowledgeRecalled: new Map(),
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
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(allowWidening ? { allowWidening: true } : {}),
      ...(evolveMode ? { evolve: evolveMode, ...(evolveWindowRuns !== undefined ? { evolveWindowRuns } : {}) } : {}),
      ...(chosenMode ? { chosenMode } : {}),
      rootTurnGen: 0,
      activityGen: 0,
      autoDenials: 0,
      policyTimers: new Map(),
      chainPriorCostUsd: overrides?.execChainId ? this.chainPriorCost(project.id, overrides.execChainId, summary.id) : 0,
      priceChecked: new Set()
    }
    if (bridging.bridged.length) {
      active.bridgedAgents = new Map()
      active.bridgedConnections = [...bridging.connections.values()]
    }
    this.runs.set(summary.id, active)
    // Only the automatic resume of a waitForReset chain is the same invocation; nothing else re-applies the grant.
    if (allowWidening && overrides?.execMode && overrides.waitForReset) this.widenedRuns.add(summary.id)
    this.store.upsert(summary)

    // Settings are read at each pricing call, so a saved override applies to a live run on its next usage update.
    const pricingFor = (on: ConnectionId): PricingContext => {
      // A bridged agent is priced by ITS connection: that RunConnection's pricing record and tier aliases.
      const rc = on === choice.connection ? connection : active.bridgedConnections?.find((c) => c.connection === on)
      return this.pricingContext(on, rc)
    }
    // Exec budgets (cli-spec 6.2(3)): a role's model setting is read like the pricing aliases (tier name -> the
    // connection's tier model) before its price is looked up. 'inherit' has no model of its own and is not checked.
    active.modelPriced = (setting: string): boolean => this.modelIsPriced(setting, choice.connection, connection)

    const emit = (raw: RunEvent, from?: { bridged: true }): void => {
      // Usage is computed by the host; an adapter's run.usage is dropped.
      if (raw.type === 'run.usage' || raw.type === 'run.model' || raw.type === 'run.permissionMode') return
      if (raw.type === 'skill.used' && !this.noteSkillUsed(active, raw)) return
      // A compaction of an agent's conversation: counted here (AgentInstance.compactions belongs to RunManager), recorded
      // and broadcast, then the agent goes out again with its new count.
      if (raw.type === 'agent.compacted') {
        if (typeof raw.agentId !== 'string' || !raw.agentId) return
        const counts = (active.compactions ??= new Map())
        counts.set(raw.agentId, Math.min(1_000_000, (counts.get(raw.agentId) ?? 0) + 1))
        this.recordEvent(active, raw)
        logRunEvent(summary, raw)
        this.broadcast(raw)
        const known = active.record.agents[raw.agentId]
        if (known) emit({ type: 'agent.upsert', runId: summary.id, agent: known })
        return
      }
      let e = raw
      // An exec run the finalizer claimed (cli-spec 6.2(2)): it writes the final status itself; later adapter statuses
      // (the abort's 'finished' / 'error', a stray 'idle') never change status, execOutcome or endedBy.
      if (e.type === 'run.status' && active.finalizing && !active.finalEmitting) {
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.status === 'error') active.adapterError = e.error ?? active.adapterError ?? ''
        return
      }
      // A session that ends after a usage-limit rejection is paused, not finished.
      if (e.type === 'run.status' && (e.status === 'finished' || e.status === 'error') && active.limited && !active.userStopped && !active.finalizing) {
        const now = Date.now()
        const until = active.limited.until && active.limited.until > now ? active.limited.until : now + DEFAULT_PAUSE_MS
        e = { ...e, status: 'paused', pausedUntil: until, pauseReason: pauseReasonText(active.limited.window, e.error), autoResume: true }
      }
      // Knowledge items still waiting in the per-second throttle go out before the run's end, never after it.
      if (e.type === 'run.status' && (e.status === 'finished' || e.status === 'error' || e.status === 'paused')) this.flushRecalled(active)
      const outcome = e.type === 'run.status' && !active.outcome ? runOutcome(e.status, !!active.userStopped) : null
      if (outcome) {
        // Every terminal path settles the ledger before an outcome is chosen (spec 5.6).
        this.finalizeDelegation(active, { sessionEnded: true })
        active.outcome = outcome
        active.cutOff = new Set(Object.values(active.record.agents).filter(isLiveAgent).map((a) => a.id))
      }
      // No card outlives its run: cancel every pending card before a terminal (or paused) status goes out.
      if (outcome || (e.type === 'run.status' && e.status === 'paused')) this.cancelCards(active)
      // Revision requests this run never answered are closed (a paused run may still answer; only an outcome ends them).
      if (outcome) this.outputsRunEnded(active)
      if (e.type === 'agent.upsert') {
        let agent = e.agent
        if (active.outcome) {
          if (isLiveAgent(agent)) active.cutOff?.add(agent.id)
          agent = settleAgent(agent, !!active.cutOff?.has(agent.id), active.outcome, ROOT_AGENT_ID)
        }
        // The connection is RunManager's: a bridged child's agent keeps the wrapper's value, everything else gets its
        // role's connection (the root: the run's). An adapter's own value is replaced.
        let on: ConnectionId
        if (from?.bridged && agent.connection) {
          on = agent.connection
          active.bridgedAgents?.set(agent.id, on)
        } else {
          const role = agent.roleId ? project.roles.find((r) => r.id === agent.roleId) : undefined
          on = active.bridgedAgents?.get(agent.id) ?? (role && agent.id !== ROOT_AGENT_ID ? roleConnection(role, project) : choice.connection)
        }
        // Priced into a copy (never the adapter's object) before it is recorded or broadcast. The delegation display is the ledger's.
        const priced = priceAgent({ ...agent, connection: on }, pricingFor(on))
        delete priced.delegation
        const compacted = active.compactions?.get(agent.id)
        if (compacted) priced.compactions = compacted
        else delete priced.compactions
        const shown = active.ledger ? this.delegationDisplay(active)[agent.id] : undefined
        e = { ...e, agent: shown ? { ...priced, delegation: shown } : priced }
      }
      const closing = e.type === 'run.status' && (e.status === 'finished' || e.status === 'error' || e.status === 'paused')
      if (e.type === 'run.status') {
        const now = Date.now()
        summary.status = e.status
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.error) summary.error = e.error
        active.idleTimer.set(e.status === 'idle', now)
        if (closing) {
          summary.endedAt = now
          this.endAcceptEditsGrant(active)
        }
        // A session cut by End session or by the app quitting records who cut it, so the status word needs no agents.
        if ((e.status === 'finished' || e.status === 'error') && active.endedBy) {
          summary.endedBy = active.endedBy
          if (active.endedBy === 'app') {
            summary.endedWithApp = true
            if (active.endedWhile) summary.endedWhile = active.endedWhile
          }
        }
        if (e.status === 'paused') {
          // An exec run without waitForReset ends 'rate-limited' here: no resume timer is armed (a reset already in the
          // past would otherwise resume it before the finalizer runs), and it waits for the user like autoResume false.
          if (exec && !overrides?.waitForReset) e = { ...e, autoResume: false }
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
        // On a priced (proxy) connection the adapter's total is a proxy estimate, not the provider's own figure.
        if (!connection?.pricing) active.providerTotalUsd = e.totalCostUsd
      }
      this.recordEvent(active, e)
      logRunEvent(summary, e)
      this.broadcast(e)
      // A removed agent never reports: its ledger entry is ended (spec 5.2).
      if (e.type === 'agent.remove' && active.ledger) {
        active.ledger.ended(e.agentId)
        this.delegationChanged(active)
      }
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
      // Team evolution: one post-run pass per run that finished or failed on its own, once its record is on disk (the
      // engine decides which runs it measures). A run the user stopped or interrupted (held until their next message),
      // or one ended by quitting, gets none.
      if ((outcome === 'finished' || outcome === 'failed') && !active.userStopped && !active.held && !this.quitting && active.evolve) this.startEvolvePass(active)
      if (exec) this.execEventSeen(active, e)
      else if (summary.conversationBudgetUsd !== undefined && (e.type === 'agent.upsert' || e.type === 'run.cost')) this.checkExecBudget(active, e.type === 'agent.upsert' ? e.agent : undefined)
    }

    active.emit = emit
    emit({ type: 'run.status', runId: summary.id, status: 'starting', ...(summary.surface ? { surface: summary.surface } : {}) })
    if (notice) emit({ type: 'log', runId: summary.id, level: 'info', message: notice })
    // cli-parity 3.1: the concrete model of each tier in use, and a warning for a stale or fallback one (runModels.ts).
    if (kind === 'work' && choice.adapter !== 'mock') {
      const roleOn = new Map(bridging.bridged.map((b) => [b.roleId, b.connection]))
      for (const l of runModelLogs({ roles: project.roles, connectionOf: (id) => roleOn.get(id) ?? choice.connection, catalog: () => this.options.catalog?.() ?? [], connectionName: (id) => connectionName(id, this.options.appSettings?.()), modelsError: this.options.modelsError })) emit({ type: 'log', runId: summary.id, ...l })
    }
    for (const line of carried?.logs ?? []) emit({ type: 'log', runId: summary.id, level: line.level, message: line.message })
    if (droppedEffort) emit({ type: 'log', runId: summary.id, level: 'warn', message: `This model does not take the ${droppedEffort} effort level, so the run uses its default effort.` })
    if (carriedPlan && kind === 'work') emit({ type: 'plan.updated', runId: summary.id, plan: { ...structuredClone(carriedPlan), autoContinues: 0 } })
    // Advisory title from the fast model; never awaited, never fails the run.
    // The harness's own resume message is never titled (the continued run's title is carried instead).
    if (kind === 'work' && exec && !summary.title && prompt.trim() && prompt.trim() !== RESUME_TEXT.trim()) {
      // A headless exec run is never titled by a model call (no spend, nothing for the finalizer to wait on): its title
      // is the first line of its prompt, bounded.
      const first = prompt.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
      summary.title = first.length > RUN_TITLE_MAX_CHARS ? `${first.slice(0, RUN_TITLE_MAX_CHARS - 1).trimEnd()}…` : first
    } else if (kind === 'work' && !summary.title && prompt.trim() && prompt.trim() !== RESUME_TEXT.trim()) {
      active.titleTask = this.titleRun(active, adapter, {
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

    // Run staffing (shared/types.ts "Run staffing"): mirrors updatePlan. Cleaned here (cleanRunStaffing), stored on the
    // record by recordEvent, persisted with the record's flush and broadcast. Nothing calls it yet.
    const updateStaffing = async (staffing: RunStaffing): Promise<void> => {
      const next = cleanRunStaffing(staffing)
      if (!next) {
        log.warn(`Run ${summary.id}: a staffing update that is not an object was ignored.`)
        return
      }
      emit({ type: 'staffing.updated', runId: summary.id, staffing: next })
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
    active.liveProject = () => live
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
        let skipped: { name: string; missing: string[]; scope?: 'project' }[] = []
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
            message:
              s.scope === 'project'
                ? `MCP server "${s.name}" needs ${s.missing.join(', ')} for this project: open Project settings > MCP servers and fill it in. It does not start in this run.`
                : `MCP server "${s.name}" has no value for ${s.missing.join(', ')}: open Settings > MCP servers and fill it in. It does not start in this run.`
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
        // A new project's folder may not exist yet, and the provider needs a real cwd. An engagement's folder is the
        // client's: OrgAI never creates it.
        if (writesToProjectFolder(project)) mkdirSync(project.path, { recursive: true })
        else if (!existsSync(project.path)) throw new Error(`The folder ${project.path} no longer exists.`)
      }
      // Git and Claude Code compare paths case-sensitively on Windows; a project path typed in a different
      // case than the folder on disk makes worktree isolation refuse to start. Use the on-disk spelling.
      project = noFolderWrites({ ...project, path: canonicalPath(project.path) })
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
      if (teamWarning) emit({ type: 'log', runId: summary.id, level: 'warn', message: teamWarning })
      /**
       * The project as saved after an install or an approved proposal on this run's own project: the canonical path is
       * kept, the harness tools' view (ctx.project) follows, and a work run's skills are recomputed from the new grants.
       */
      // `settle` says what the approved change itself touched; only that moves onto the live project. The saved project
      // also carries whatever the same save ingested from the team files (a pull), and a file change never reaches a
      // live run. An approved org chart (review M1) says it applies from the next run, so this run's grants stay.
      const setLive = (saved: Project, settle: LiveSettle = 'mcpServers', own?: LiveOwnItems): void => {
        // Never the roles list as saved for an org chart with named roles: only the proposal's own roles move.
        const next: Project = { ...live }
        const ownBefore = this.runOwnProject(active, live).permissionMode
        const overlay =<K extends keyof Project>(key: K): void => {
          if (saved[key] === undefined) delete next[key]
          else next[key] = saved[key]
        }
        const savedRoles = new Map(saved.roles.map((r) => [r.id, r]))
        /** The grant field of live roles taken from the saved roles (by id); every other role field stays. */
        const grants = (field: 'mcpServers' | 'skills'): void => {
          next.roles = next.roles.map((r) => {
            const s = savedRoles.get(r.id)
            if (!s) return r
            const out: Role = { ...r }
            if (s[field]) out[field] = [...(s[field] as string[])]
            else delete out[field]
            return out
          })
        }
        if ((settle === 'mcpServers' || settle === 'skills') && own) {
          // Named items only: a pulled change to another server or skill in this same save stays out of the run.
          if (settle === 'mcpServers') {
            const o = overlayOwnItems(live.mcpServers, saved.mcpServers, next.roles, saved.roles, 'mcpServers', own)
            if (o.items) next.mcpServers = o.items
            else delete next.mcpServers
            next.roles = o.roles
          } else {
            const o = overlayOwnItems(live.skills, saved.skills, next.roles, saved.roles, 'skills', own)
            if (o.items) next.skills = o.items
            else delete next.skills
            next.roles = o.roles
          }
        } else if (settle === 'mcpServers') {
          overlay('mcpServers')
          grants('mcpServers')
        } else if (settle === 'skills') {
          overlay('skills')
          grants('skills')
        } else if (settle === 'orgChart') {
          if (own) next.roles = overlayOwnRoles(live.roles, saved.roles, own)
          else overlay('roles')
        }
        else if (settle === 'folders') overlay('allowedDirectories')
        else overlay('permissionMode')
        live = noFolderWrites({ ...next, path: live.path })
        // Review L3: an approved project change that narrows the run's own mode to Plan or Don't ask takes the "accept
        // edits" overlay with it (otherwise new Codex threads and a restarted Claude query would start in acceptEdits
        // under a project that now says Plan). Only a change of the run's own mode counts: a mode the user chose for the
        // run (chosenMode) is not moved by the project, so its overlay stays. The live native session is NOT told
        // (session.setPermissionMode is not called from here: setLive runs inside the adapter's own permission / hook
        // calls, where a call back into the session could wait on itself); the session's grant ends at its next restart
        // or when the user chooses the mode again.
        if (active.acceptEditsGrant) {
          const ownAfter = this.runOwnProject(active, live).permissionMode
          if ((ownAfter === 'plan' || ownAfter === 'dontAsk') && ownAfter !== ownBefore && canNarrowPermissionMode(ownBefore, ownAfter)) {
            delete active.acceptEditsGrant
            const label = PERMISSION_MODE_OPTIONS.find((o) => o.value === ownAfter)?.label ?? ownAfter
            emit({ type: 'log', runId: summary.id, level: 'warn', message: `The project mode is now ${label}. An "accept edits" permission granted earlier may still apply to the running session until it restarts or you choose the mode again.` })
          }
        }
        // The run's overrides are re-applied to the saved project (cli-spec 6.2(1)): a tightened project re-clamps them.
        // RunSummary.permissionMode follows: an approved project change (acceptEdits for project) moves it.
        this.rederiveRunMode(active, ctx)
        ctx.autoContinue = ctx.project.autoContinue !== false && planNudgesApply(summary)
        ctx.maxAutoContinues = ctx.project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES
        this.applyExecBudget(active, ctx)
        const skills = settle === 'mcpServers' || settle === 'skills'
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
      // Reference folders (Project.referenceDirectories): readable, never editable. Same resolution and conditions.
      let refDirs: string[] = []
      const resolveReferences = (): void => {
        const r = resolveAllowedDirectories(live.referenceDirectories, { projectPath: live.path, dataDir: this.options.dataDir })
        // A folder that is also an allowed folder stays writable: it is only in allowedDirectories().
        refDirs = r.dirs.filter((d) => !allowedDirs.some((a) => samePath(a, d)))
        for (const ref of refDirs) {
          for (const a of allowedDirs) {
            const key = `contains:${a}|${ref}`
            if (warnedMissing.has(key) || !isInsideEither(a, ref)) continue
            warnedMissing.add(key)
            log.info(`Run ${summary.id}: ${a} contains reference folder ${ref}; edits there stay refused.`)
          }
        }
        for (const m of r.missing) {
          if (warnedMissing.has(m)) continue
          warnedMissing.add(m)
          emit({ type: 'log', runId: summary.id, level: 'warn', message: `Reference folder ${m} does not exist; agents cannot read it in this run.` })
        }
        for (const u of r.unsafe) {
          if (warnedMissing.has(u)) continue
          warnedMissing.add(u)
          emit({ type: 'log', runId: summary.id, level: 'warn', message: `Reference folder ${u} is too broad or sensitive; agents cannot use it in this run.` })
        }
      }
      if (foldersOn) {
        resolveFolders()
        resolveReferences()
      }
      // Folder config gate (folderConfigTrust.ts): decided at run start and latched. A run that started without the
      // folder's own agent config never gains it mid-run (accepting applies from the next run); one that started with
      // it loses it for good when the folder changes. Omitted for projects with no gate field (legacy, virtual,
      // trust-restricted), whose behaviour is unchanged. A scan that fails counts as "do not load".
      let folderLoads: (() => boolean) | undefined
      // Rules copied from the folder's settings.local.json on accept stop counting when the folder's config stops loading.
      let importedRulesNow: () => string[] = () => []
      if (!restricted && !isVirtualProjectId(project.id) && project.folderConfigTrust !== undefined) {
        // The stored record decides the trust, but the folder judged is the one this run is in.
        const gateProject = (): Project => ({ ...(this.options.resolveProject?.(project.id) ?? live), path: live.path })
        importedRulesNow = () => cleanFolderConfigTrust(gateProject().folderConfigTrust)?.importedRules ?? []
        const stateNow = (): FolderConfigState => {
          try {
            return folderConfigStateOf(gateProject())
          } catch {
            return 'changed'
          }
        }
        const warnNotLoaded = (state: FolderConfigState): void => {
          let paths: string[] = []
          try {
            paths = presentConfigPaths(live.path)
          } catch {
            /* the sentence still reads right without a list */
          }
          emit({ type: 'log', runId: summary.id, level: 'warn', message: folderConfigWarning(state, paths) })
        }
        const first = stateNow()
        let latched = first === 'none' || first === 'trusted'
        if (!latched) warnNotLoaded(first)
        // This is asked on every permission check and a check scans the whole config, so a 'trusted' answer is reused
        // for FOLDER_CHECK_MS; a change shows up within that window. A latched-false run never scans again.
        let checkedAt = Date.now()
        folderLoads = () => {
          if (!latched) return false
          const at = Date.now()
          if (at >= checkedAt && at - checkedAt < FOLDER_CHECK_MS) return true
          const now = stateNow()
          checkedAt = at
          if (now === 'none' || now === 'trusted') return true
          latched = false
          warnNotLoaded(now)
          return false
        }
      }
      const withoutUnloadedImports = (rules: string[]): string[] => {
        if (!folderLoads || folderLoads()) return rules
        let imported: string[] = []
        try {
          imported = importedRulesNow()
        } catch {
          /* an unreadable record drops nothing it cannot name */
        }
        return imported.length ? rules.filter((r) => !imported.includes(r)) : rules
      }
      // What the run sees (cli-spec 6.2(1)): the project with its overrides applied, before ctx exists, so the adapter's
      // permission mode and continuation host read the effective values from turn 1.
      const runProject = this.runProjectFor(active, project)
      const bridge = bridging.bridged.length
        ? new BridgedSessions({
            adapters: this.adapters,
            parent: () => ctx,
            bridged: bridging.bridged,
            connections: bridging.connections,
            extraConnections: connection ? [connection] : [],
            emit: (e) => emit(e, { bridged: true }),
            agents: () => Object.values(active.record.agents),
            connectionName: (id) => connectionName(id, this.options.appSettings?.()),
            log: { info: (m) => log.info(m), warn: (m) => log.warn(m) }
          })
        : undefined
      active.bridge = bridge
      const gate = kind === 'work' && !summary.quick && summary.team !== 'single' ? this.createDelegation(active, project, choice.adapter, bridging.bridged.map((b) => b.roleId)) : undefined
      // The project's staffing profile, read once: a snapshot for the life of the run (spec 4.5).
      const staffingProfile = this.options.dataDir && staffingProfileApplies(summary, runProject) ? readStaffingProfile(this.options.dataDir, summary.projectId) : undefined
      const ctx: RuntimeContext = {
        ...(staffingProfile ? { staffingProfile: () => staffingProfile } : {}),
        run: summary,
        project: runProject,
        ...(gate ? { delegation: gate } : {}),
        ...(folderLoads ? { folderConfigLoads: folderLoads } : {}),
        roles:
          kind === 'setup' ? [architectRole(builtinModel, { kind: projectKindOf(project) })]
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
        ...(bridge
          ? {
              bridge: { roles: () => bridge.roles(), spawn: (input) => bridge.spawn(input) },
              agentConnection: (roleId: string) => {
                const r = ctx.roles.find((x) => x.id === roleId)
                return r ? roleConnection(r, live) : undefined
              }
            }
          : {}),
        ...(kind === 'setup' && this.options.connectionModels ? { connectionModels: () => this.options.connectionModels!() } : {}),
        requestPermission: (req) => this.requestPermission(active, req),
        requestProposal: (req) =>
          this.requestProposal(active, req, (saved) => {
            // Keep the harness tools' view of the project (and the run's skills) current after an approved change.
            if (req.kind === 'mcpServers') {
              const payload = req.payload as McpServersProposalPayload
              setLive(saved, 'mcpServers', { ids: [...payload.upsert.map((s) => s.id), ...(payload.remove ?? [])], names: payload.upsert.map((s) => s.name) })
            } else if (req.kind === 'skills') {
              const payload = req.payload as SkillsProposalPayload
              setLive(saved, 'skills', { ids: payload.items.flatMap((i) => (i.libraryId ? [i.libraryId] : [])), names: payload.items.map((i) => i.draft.name) })
            } else if (req.kind === 'orgChart') {
              const payload = req.payload as OrgChartProposalPayload
              setLive(saved, 'orgChart', { ids: payload.roles.map((r) => r.id), names: payload.roles.map((r) => r.name) })
            }
          }),
        // Setup-like runs (setup, mcp-assist, the harness project) change servers through proposals only.
        ...(bare && !isQuick
          ? {}
          : { requestMcpInstall: (req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>) => this.requestMcpInstall(active, req, () => live, (saved) => setLive(saved, 'mcpServers', { ids: [req.spec.id], names: [req.spec.name] })) }),
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
        // Only with a source: an empty answer from one makes the adapters' gate refuse shell commands (review M2).
        ...(this.options.controlProtectedPaths || this.options.dataDir
          ? { controlProtectedPaths: () => this.options.controlProtectedPaths?.() ?? (this.options.dataDir ? controlProtectedPaths(this.options.dataDir) : []) }
          : {}),
        allowedRules: () => [...new Set([...(restricted ? [] : withoutUnloadedImports(listRules({ file: this.rulesFileFor(live) }))), ...active.runRules])],
        // Where the project keeps its saved rules: the folder file for code projects, OrgAI's data folder for engagements.
        ...(restricted
          ? {}
          : {
              savedRules: () => withoutUnloadedImports(listRules({ file: this.rulesFileFor(live) })),
              saveProjectRules: (rules: string[]) => addRulesReport({ file: this.rulesFileFor(live) }, rules)
            }),
        ...(!writesToProjectFolder(project) ? {
              engagementDocument: () => {
                if (!active.engagementDocumentDone) {
                  active.engagementDocumentDone = true
                  active.engagementDocumentText = this.options.dataDir ? readEngagementDocument(this.options.dataDir, project.id) : undefined
                }
                return active.engagementDocumentText
              }
            } : {}),
        // Context notes: work runs of an engagement and single-agent runs; never Chat, setup-like or trust-restricted runs.
        ...(this.options.engagementNotes && kind === 'work' && !bare && !restricted && (projectKindOf(project) === 'engagement' || team === 'single')
          ? {
              engagementNotes: {
                list: () => this.options.engagementNotes!.list(project.id),
                read: (noteId: string) => this.options.engagementNotes!.read(project.id, noteId),
                save: (input: { noteId?: string; title: string; text: string }, caller: KnowledgeCaller) => {
                  const save = this.options.engagementNotes?.save
                  if (!save) throw new Error('Notes cannot be saved in this run.')
                  this.checkKnowledgeBudget(active)
                  const source = this.knowledgeSource(active, caller, ctx.roles)
                  const note = save(project.id, input, { by: 'agent', runId: summary.id, role: source.role })
                  this.countKnowledgeWrite(active, source.agentId, `Saved note ${note.title}`)
                  this.engagementChanged(project.id, 'notes', [note.id])
                  return note
                }
              }
            }
          : {}),
        // The knowledge graph: work runs of an engagement (any team); never Chat, setup-like or trust-restricted runs.
        // The same gate covers the read side (recall, automatic context, the standing brief); it is read-only.
        ...(this.options.knowledge && kind === 'work' && !bare && !restricted && projectKindOf(project) === 'engagement'
          ? {
              knowledge: this.bindKnowledge(active, this.options.knowledge, project.id, () => ctx.roles),
              ...this.bindKnowledgeReads(active, this.options.knowledge, project.id, () => this.options.resolveProject?.(project.id) ?? live)
            }
          : {}),
        // Run outputs: work runs of a stored project (code or engagement, team default or single); never Chat, setup-like,
        // build-session or trust-restricted runs.
        ...(this.options.outputs && kind === 'work' && !bare && !restricted
          ? { outputs: this.bindOutputs(active, this.options.outputs, project.id, () => ctx.roles, () => this.options.resolveProject?.(project.id) ?? live) }
          : {}),
        // Saved team templates: Architect setup runs only.
        ...(this.options.orgTemplate && kind === 'setup' && !isVirtualProjectId(project.id)
          ? { orgTemplate: (templateId: string) => this.options.orgTemplate!(templateId, live) }
          : {}),
        ...(foldersOn
          ? {
              allowedDirectories: () => [...allowedDirs],
              referenceDirectories: () => [...refDirs],
              ...(folderSave
                ? {
                    allowDirectories: (requested: string[]) => {
                      // A reference folder (or anything inside one) stays read-only: never saved as writable.
                      const refs = [...new Set([...refDirs, ...(live.referenceDirectories ?? []).filter((r): r is string => typeof r === 'string')])]
                      const dirs = requested.filter((d) => {
                        if (!referenceFolderOf(d, refs, live.path)) return true
                        log.info(`Run ${summary.id}: ${d} is a reference folder; it stays read-only.`)
                        return false
                      })
                      if (!dirs.length) return []
                      const saved = folderSave(live.id, { addDirectories: dirs })
                      setLive(saved, 'folders')
                      this.broadcast({ type: 'project.updated', runId: summary.id, project: saved })
                      resolveFolders()
                      resolveReferences()
                      const asked = resolveAllowedDirectories(dirs, { projectPath: live.path, dataDir: this.options.dataDir }).dirs
                      const inForce = asked.filter((d) => allowedDirs.some((a) => samePath(a, d)))
                      if (inForce.length) emit({ type: 'log', runId: summary.id, level: 'info', message: `Allowed folders for this project: ${inForce.join(', ')}` })
                      return inForce
                    },
                    acceptEditsForProject: () => {
                      if (live.permissionMode !== 'default') return false
                      const saved = folderSave(live.id, { acceptEdits: true })
                      setLive(saved, 'permissionMode')
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
        ...(this.options.selfKnowledge
          ? {
              appReference: (q: AppReferenceQuery) => this.options.selfKnowledge!.reference(q, { status: isQuick || kind === 'mcp-assist' || kind === 'skill-assist' }),
              ...(isQuick || setupLike ? { navigate: (target: { surfaceId: AtlasSurfaceId; projectId?: string }, caller: { agentId?: string }) => this.navigateFor(active, target, caller) } : {}),
              ...(isQuick
                ? {
                    appSettings: () => this.options.selfKnowledge!.settings(),
                    storedProject: (projectId: string) => this.storedProjectFor(projectId)
                  }
                : {})
            }
          : {}),
        // Schedules: Chat runs and work runs (team or single) of a stored project; never setup-like, build or other
        // virtual-project runs. A scheduled run keeps the access so the tools refuse it in words (summary.scheduleId).
        ...(this.options.schedules && kind === 'work' && (isQuick || !bare) ? { schedules: this.options.schedules.access() } : {}),
        ...(!bare && !isQuick && kind === 'work' && this.options.skillAssist
          ? {
              skillCatalog: () => this.options.skillAssist!.catalog(project.id),
              readSkill: (ref: { libraryId?: string; skillId?: string }) => this.options.skillAssist!.read(project.id, ref)
            }
          : {}),
        ...(isQuick && this.options.skillAssist
          ? {
              skillCatalog: () => this.options.skillAssist!.catalog(null),
              readSkill: (ref: { libraryId?: string; skillId?: string }) => this.options.skillAssist!.read(null, ref)
            }
          : {}),
        ...(isQuick ? { quickSessionEdits: () => active.quickSessionEdits === true } : {}),
        // The adapter applied an "accept edits" grant to its session: ctx.project follows (never on restricted runs).
        ...(!restricted && runPermissionModeChoices(summary).includes('acceptEdits') ? { acceptEditsGranted: () => this.followAcceptEditsGrant(active) } : {}),
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
        getStaffing: () => active.record.staffing,
        updateStaffing,
        // The per-run override (RunOverrides.goal) on top of the project's goal, fixed at run start.
        staffingGoal: staffingGoalOf(runProject, summary.overrides?.goal),
        pendingInteractions: () => pendingCount(active),
        // A Chat with the single assistant is a conversation: no plan nudges (planNudgesApply).
        autoContinue: runProject.autoContinue !== false && planNudgesApply(summary),
        maxAutoContinues: runProject.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
        onRootTurnEnded: (e: RootTurnEnd) => this.rootTurnEnded(active, e),
        noteActivity: () => this.bumpActivity(active),
        ...(this.options.continuationDelayMs !== undefined ? { continuationDelayMs: this.options.continuationDelayMs } : {}),
        completeSetup: async (text) => {
          const updated = this.setup.complete(project.id, text)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        }
      }
      const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
      if (root && modelSelection) root.model = modelSelection.model
      // The root's effort choice (ctx.roles holds this run's own copies); reports keep their own role effort and staffing.
      if (root && rootEffort) root.effort = rootEffort
      if (root && root.model !== 'inherit' && summary.connection) {
        summary.modelSelection = { model: root.model, connection: summary.connection }
        this.store.upsert(summary)
      }
      active.ctx = ctx
      if (gate && active.ledger) {
        const problems = active.ledger.snapshot().problems
        for (const message of problems) emit({ type: 'log', runId: summary.id, level: exec ? 'error' : 'warn', message: `Required delegation: ${message}` })
        // An unmeetable obligation refuses an exec run before its session starts (spec 4.5); an interactive run goes on with the warning.
        if (exec && problems.length > 0) {
          await this.finalizeExecRun(summary.id, 'delegation-incomplete', { endedBy: 'policy' })
          return summary
        }
      }
      if (exec || summary.conversationBudgetUsd !== undefined) {
        // Budget before launch (cli-spec 6.2(3)): a spent chain (maxBudgetUsd 0 included) or an unpriced role model
        // ends the run as 'budget-exceeded' without ever starting the adapter.
        this.applyExecBudget(active, ctx)
        const refusal = this.preLaunchBudgetRefusal(active, ctx)
        if (refusal) {
          emit({ type: 'log', runId: summary.id, level: 'warn', message: refusal })
          await this.finalizeExecRun(summary.id, 'budget-exceeded', { endedBy: 'budget' })
          return summary
        }
      }
      const opening = adapter.start(ctx)
      this.startsInFlight.add(opening)
      active.opening = opening
      try {
        active.session = await opening
      } finally {
        this.startsInFlight.delete(opening)
        active.opening = undefined
      }
      void active.session.finished.finally(() => this.teardown(active))
      if (exec) this.armStall(active)
      // The run was ended (End session or the app quitting) while its session was still opening: stop it at once.
      if (active.userStopped || active.finalizing) {
        this.stopSession(active)?.catch((err: unknown) => log.warn(`Run ${summary.id}: stopping a session that opened after its end failed: ${(err as Error)?.message ?? err}`))
      }
    } catch (e) {
      emit({ type: 'run.status', runId: summary.id, status: 'error', error: (e as Error).message })
      // No session will ever finish this run; it must not count as live.
      this.teardown(active)
    }
    return summary
  }

  // ---------- headless exec: budget, settlement and the finalizer (cli-spec 6.2) ----------

  /** The cost of the exec chain's other runs (stored and live), for the chain budget. */
  private chainPriorCost(projectId: string, chainId: string, excludeId: string): number {
    const byId = new Map<string, RunSummary>()
    for (const r of this.store.list(projectId)) byId.set(r.id, r)
    for (const a of this.runs.values()) if (a.summary.projectId === projectId) byId.set(a.summary.id, a.summary)
    let sum = 0
    for (const r of byId.values()) {
      if (r.id === excludeId || r.overrides?.execChainId !== chainId) continue
      const cost = r.usage?.costUsd ?? r.totalCostUsd
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) sum += cost
    }
    return sum
  }

  /** The exec budget of the run's effective project and what is left of it for the adapter (ctx.budgetUsd). */
  private applyExecBudget(a: ActiveRun, ctx: RuntimeContext): void {
    const o = a.summary.overrides
    if (!o?.execMode && a.summary.conversationBudgetUsd === undefined) return
    a.execBudget = o?.execMode ? execBudgetUsd(ctx.project, o) : projectBudgetUsd(ctx.project)
    if (a.execBudget !== undefined) ctx.budgetUsd = Math.max(0, a.execBudget - a.chainPriorCostUsd)
    else delete ctx.budgetUsd
  }

  /** Why an exec run may not start under its budget, or null. */
  private preLaunchBudgetRefusal(a: ActiveRun, ctx: RuntimeContext): string | null {
    const budget = a.execBudget
    if (budget === undefined) return null
    if (a.chainPriorCostUsd >= budget) {
      return `The budget of $${budget.toFixed(2)} is spent ($${a.chainPriorCostUsd.toFixed(2)} so far in this exec chain); the run did not start.`
    }
    if (a.summary.overrides?.allowUnpricedBudget || !a.modelPriced) return null
    for (const role of ctx.roles) {
      if (a.modelPriced(role.model)) continue
      const name = logText(String(role.model))
      log.warn(`Run ${a.summary.id}: model ${name} (role ${logText(role.name)}) has no known price; a budget cannot be enforced.`)
      return `Model ${name} (role ${logText(role.name)}) has no known price, so the budget cannot be enforced; the run did not start. Set a model price in App settings or allow unpriced models.`
    }
    return null
  }

  /** Synchronous budget check on every agent.upsert of an exec run (after pricing). */
  private checkExecBudget(a: ActiveRun, agent?: AgentInstance): void {
    const budget = a.execBudget
    if (budget === undefined || a.finalizing) return
    const runId = a.summary.id
    if (agent && !a.summary.overrides?.allowUnpricedBudget) {
      const unpriced = agent.usage?.models.find((m) => m.costUsd === null)
      let model = unpriced?.model
      if (!model && !a.priceChecked.has(agent.id)) {
        a.priceChecked.add(agent.id)
        // Mock models are fake ids priced by the mock's own provider cost; only their usage entries are checked.
        if (a.adapter !== 'mock' && agent.model && a.modelPriced && !a.modelPriced(agent.model)) model = agent.model
      }
      if (model) {
        const message = `Model ${logText(model)} has no known price, so the budget cannot be enforced; the run ends.`
        log.warn(`Run ${runId}: ${message}`)
        a.emit({ type: 'log', runId, level: 'warn', message })
        void this.finalizeExecRun(runId, 'budget-exceeded', { endedBy: 'budget' })
        return
      }
    }
    const cost = Math.max(a.summary.usage?.costUsd ?? 0, a.summary.usage?.providerCostUsd ?? 0)
    if (a.chainPriorCostUsd + cost >= budget) {
      a.emit({ type: 'log', runId, level: 'warn', message: `The budget of $${budget.toFixed(2)} is reached ($${(a.chainPriorCostUsd + cost).toFixed(2)} estimated); the run ends.` })
      void this.finalizeExecRun(runId, 'budget-exceeded', { endedBy: 'budget' })
    }
  }

  // ---------- required delegation (docs/design/delegation-enforcement.md 4.3-4.5, 5.2, 5.6, 5.8) ----------

  /**
   * The ledger and gate of a work run: obligations from the roles and RunOverrides.strictDelegation, the preflight problems
   * (stored on the ledger), the root registered. The gate is RuntimeContext.delegation; holds force canCorrect / canWait false.
   */
  private createDelegation(a: ActiveRun, project: Project, adapterId: ProviderId, bridged: readonly string[]): DelegationGate {
    const strict = a.summary.overrides?.strictDelegation === true
    const roles = project.roles
    const obligations = obligationsFor(roles, strict)
    const root = roles.find((r) => r.reportsTo === null) ?? roles[0]
    const problems = delegationPreflight(roles, obligations, effectiveSubagentLimits({ ...project, roles }), adapterId as 'claude' | 'codex' | 'mock', bridged)
    const ledger = new DelegationLedger(
      { obligations, strict, problems },
      {
        roleLabel: (roleId) => {
          const r = roles.find((x) => x.id === roleId)
          return { slug: r?.slug ?? roleId, name: r?.name ?? roleId }
        },
        handle: (agentId) => a.record.agents[agentId]?.handle ?? agentId,
        spawnTool: adapterId === 'codex' ? 'spawn_report' : 'the Agent tool'
      }
    )
    if (root) ledger.noteRoot(ROOT_AGENT_ID, root.id)
    a.ledger = ledger
    a.delegationOn = strict || Object.keys(obligations).length > 0 || problems.length > 0
    this.delegationChanged(a)
    const held = (): boolean => this.delegationHold(a)
    const changed = <T,>(v: T): T => {
      this.delegationChanged(a)
      return v
    }
    return {
      noteSpawn: (childId, parentId, roleId) => changed(ledger.noteSpawn(childId, parentId, roleId)),
      completion: (agentId, opts) => changed(ledger.completion(agentId, { ...opts, canCorrect: opts.canCorrect && !held(), canWait: opts.canWait && !held() })),
      ended: (agentId) => changed(ledger.ended(agentId)),
      resumed: (agentId) => changed(ledger.resumed(agentId)),
      delivered: (childId) => changed(ledger.delivered(childId)),
      receiptText: (childId) => ledger.receiptText(childId),
      nativeStrike: (agentId) => {
        a.delegationOn = true
        return changed(ledger.nativeStrike(agentId))
      }
    }
  }

  /** A held, usage-limited or stopping run (or one whose session ended) can neither correct nor wait (spec 4.4). */
  private delegationHold(a: ActiveRun): boolean {
    return a.held || !!a.limitHold || !!a.userStopped || !!a.finalizing || a.outcome !== undefined || a.summary.status === 'stopping'
  }

  private delegationDisplay(a: ActiveRun): Record<string, NonNullable<AgentInstance['delegation']>> {
    return a.ledger && a.delegationOn ? a.ledger.summary().agents : {}
  }

  /** The ledger changed: persist the snapshot, update the summary and per-agent display fields and emit run.delegation. */
  private delegationChanged(a: ActiveRun): void {
    if (!a.ledger || !a.delegationOn) return
    const { summary, agents } = a.ledger.summary()
    const json = JSON.stringify({ summary, agents })
    if (json === a.delegationSent) return
    a.delegationSent = json
    a.record.delegation = a.ledger.snapshot()
    a.summary.delegation = summary
    for (const [id, inst] of Object.entries(a.record.agents)) {
      if (agents[id]) inst.delegation = agents[id]
      else delete inst.delegation
    }
    try {
      this.store.upsert(a.summary)
    } catch (e) {
      log.warn(`Run ${a.summary.id}: could not persist the delegation summary: ${(e as Error).message}`)
    }
    if (!a.flushTimer) a.flushTimer = setTimeout(() => this.flush(a), FLUSH_INTERVAL_MS)
    a.emit({ type: 'run.delegation', runId: a.summary.id, summary, agents })
  }

  /**
   * Every terminal path calls this before an outcome is chosen (spec 5.6): descendants still open are ended, then the root is
   * judged with canCorrect and canWait false unless it already completed. A root with valid receipts that never called
   * complete_plan is ok. Idempotent.
   */
  private finalizeDelegation(a: ActiveRun, _opts: { sessionEnded: boolean }): void {
    const ledger = a.ledger
    if (!ledger) return
    for (const id of Object.keys(ledger.snapshot().agents)) if (id !== ROOT_AGENT_ID) ledger.ended(id)
    ledger.completion(ROOT_AGENT_ID, { canCorrect: false, canWait: false, reportText: '' })
    this.delegationChanged(a)
  }

  /** execOutcomeFor's delegation inputs (spec 5.8). Empty without a ledger. */
  private delegationFacts(a: ActiveRun): { rootVerdict?: DelegationVerdict; subtreeFailed?: boolean; strictNativeSpawns?: number } {
    const ledger = a.ledger
    if (!ledger) return {}
    const state = ledger.snapshot()
    const rootVerdict = ledger.rootVerdict()
    return {
      ...(rootVerdict ? { rootVerdict } : {}),
      subtreeFailed: subtreeFailed(state),
      ...(state.strict ? { strictNativeSpawns: ledger.summary().summary.nativeSpawns } : {})
    }
  }

  /**
   * Exec quiescence with the root missing required reports and its correction unused: send the correction through the
   * adapter's harness-message path (RuntimeSession.nudge, not an auto-continue) and stay live. True when one was sent.
   */
  private sendRootCorrection(a: ActiveRun): boolean {
    const ledger = a.ledger
    const nudge = a.session?.nudge
    if (!ledger || !nudge || a.correctionGen !== undefined || this.delegationHold(a)) return false
    const d = ledger.completion(ROOT_AGENT_ID, { canCorrect: true, canWait: false, reportText: '', provisional: true })
    this.delegationChanged(a)
    if (d.action !== 'correct' || !d.text) return false
    a.correctionGen = a.rootTurnGen
    this.bumpActivity(a)
    a.emit({ type: 'log', runId: a.summary.id, level: 'warn', message: 'The root finished without its required reports; sent its one correction.' })
    void nudge.call(a.session, d.text).catch((e: unknown) => log.warn(`Run ${a.summary.id}: the delegation correction was not delivered: ${(e as Error)?.message ?? e}`))
    return true
  }

  /** RunManager's view of an exec run's own events (after they were recorded and broadcast). */
  private execEventSeen(a: ActiveRun, e: RunEvent): void {
    if (e.type === 'agent.upsert') {
      this.bumpActivity(a)
      this.checkExecBudget(a, e.agent)
      return
    }
    if (e.type !== 'run.status') return
    if (e.status === 'running') this.bumpActivity(a)
    if (a.finalizing || a.finalEmitting) return
    const runId = a.summary.id
    if (e.status === 'paused') {
      // waitForReset leaves the outcome to the auto-resume, unless none is armed (an adapter's autoResume false).
      if (!a.summary.overrides?.waitForReset || e.autoResume === false) void this.finalizeExecRun(runId, 'rate-limited')
    } else if (e.status === 'error') {
      const auth = !!a.lastTurnEnd?.isAuthError || isAuthFailure({ text: e.error, isError: true })
      void this.finalizeExecRun(runId, auth ? 'auth-error' : 'failed')
    } else if (e.status === 'finished') {
      // The session ended without the finalizer: a cut (End session, quit) is 'interrupted', else judge the plan.
      if (a.userStopped) {
        void this.finalizeExecRun(runId, 'interrupted', { endedBy: a.endedBy ?? 'user' })
      } else {
        this.finalizeDelegation(a, { sessionEnded: true })
        const r = execOutcomeFor({ plan: a.record.plan, agents: Object.values(a.record.agents), allowUnmerged: a.summary.overrides?.allowUnmerged, ...this.delegationFacts(a) })
        void this.finalizeExecRun(runId, r.outcome, { endedBy: r.endedBy })
      }
    }
  }

  /** ctx.onRootTurnEnded: every root turn end, failed ones included, before the adapter's 'idle'. */
  private rootTurnEnded(a: ActiveRun, e: RootTurnEnd): void {
    if (typeof e?.turnGen === 'number' && Number.isFinite(e.turnGen)) a.rootTurnGen = e.turnGen
    a.lastTurnEnd = e
    a.activityGen++
    if (!a.summary.overrides?.execMode || a.finalizing) return
    const runId = a.summary.id
    if (e.errorSubtype === 'error_max_budget_usd') {
      void this.finalizeExecRun(runId, 'budget-exceeded', { endedBy: 'budget' })
      return
    }
    if (!e.ok && !e.limited && !e.interrupted) {
      void this.finalizeExecRun(runId, e.isAuthError ? 'auth-error' : 'failed')
      return
    }
    this.armSettle(a)
    this.armStall(a)
  }

  /** Activity that may keep an exec run from settling: bump activityGen, re-arm the settle check and the stall watchdog. */
  private bumpActivity(a: ActiveRun): void {
    a.activityGen++
    if (!a.summary.overrides?.execMode || a.finalizing) return
    this.armSettle(a)
    this.armStall(a)
  }

  private armSettle(a: ActiveRun, delay: number = EXEC_SETTLE_DEBOUNCE_MS): void {
    if (a.settleTimer) clearTimeout(a.settleTimer)
    const gen = a.activityGen
    const turn = a.rootTurnGen
    a.settleTimer = setTimeout(() => {
      a.settleTimer = undefined
      // A later activity re-armed it; this one is stale.
      if (gen !== a.activityGen || turn !== a.rootTurnGen) return
      this.trySettleExecRun(a)
    }, delay)
  }

  /** At a stable (rootTurnGen, activityGen): finalize the exec run if it is quiescent (execSettle.ts). */
  private trySettleExecRun(a: ActiveRun): void {
    if (!a.summary.overrides?.execMode || a.finalizing || this.runs.get(a.summary.id) !== a) return
    const st = a.summary.status
    if (st !== 'running' && st !== 'idle') return
    // A bridged child still working keeps the run open; poll like an adapter with pending work.
    if (a.bridge?.hasActive()) return this.armSettle(a, EXEC_SETTLE_POLL_MS)
    const settlement = a.session?.settlement?.()
    const input = {
      settlement,
      rootTurnGen: a.rootTurnGen,
      limitHold: !!a.limitHold,
      held: a.held,
      agents: Object.values(a.record.agents),
      openCards: pendingCount(a),
      inboxLength: a.inbox.length,
      flushing: !!a.flushing,
      plan: a.record.plan,
      autoContinue: a.ctx?.autoContinue === true,
      delegationCorrectionPending: a.correctionGen !== undefined && a.rootTurnGen <= a.correctionGen
    }
    if (execQuiescent(input)) {
      // A root with missing required reports gets its one correction and the run stays live (spec 5.6).
      if (this.sendRootCorrection(a)) return this.armSettle(a, EXEC_SETTLE_POLL_MS)
      this.finalizeDelegation(a, { sessionEnded: false })
      const r = execOutcomeFor({ plan: a.record.plan, agents: input.agents, allowUnmerged: a.summary.overrides.allowUnmerged, ...this.delegationFacts(a) })
      void this.finalizeExecRun(a.summary.id, r.outcome, { endedBy: r.endedBy })
      return
    }
    // Adapter-side state (a continuation timer, a deferred restart) can change without any event: poll while idle.
    if (settlement?.rootIdle) this.armSettle(a, EXEC_SETTLE_POLL_MS)
  }

  /**
   * The stall watchdog: reset on every activity; fires after execStallTimeoutMs without any. While the adapter says
   * the root is busy it re-arms, but only EXEC_STALL_BUSY_ROUNDS times in a row with no activity at all (review M4):
   * a lost harness notice or a hung turn that never reports back must not keep an exec run alive forever. Any activity
   * (bumpActivity, a root turn end) starts the count again; a card under a policy timer never counts.
   */
  private armStall(a: ActiveRun, busyRounds = 0): void {
    if (a.stallTimer) clearTimeout(a.stallTimer)
    a.stallTimer = undefined
    const o = a.summary.overrides
    if (!o?.execMode || a.finalizing) return
    const gen = a.activityGen
    // A non-positive timeout (a record from before cleanRunOverrides refused one) would re-arm every tick: use the default.
    const set = o.execStallTimeoutMs
    const ms = timerDelay(typeof set === 'number' && set > 0 ? set : DEFAULT_EXEC_STALL_TIMEOUT_MS)
    a.stallTimer = setTimeout(() => {
      a.stallTimer = undefined
      if (a.finalizing || this.runs.get(a.summary.id) !== a) return
      if (gen !== a.activityGen) return this.armStall(a)
      // A paused run waits for its reset (waitForReset); a card under the policy's grace or 'wait' timer suspends it.
      if (a.summary.status === 'paused') return
      if (a.policyTimers.size > 0) return this.armStall(a)
      const settlement = a.session?.settlement?.()
      // Without a settlement view the adapter cannot say it is busy: only this watchdog ends such a run.
      if (settlement && !settlement.rootIdle) {
        if (busyRounds + 1 < EXEC_STALL_BUSY_ROUNDS) return this.armStall(a, busyRounds + 1)
        log.warn(`Run ${a.summary.id}: busy with no activity for ${ms * EXEC_STALL_BUSY_ROUNDS} ms; ending it as stalled.`)
        void this.finalizeExecRun(a.summary.id, 'stalled', { endedBy: 'policy' })
        return
      }
      log.warn(`Run ${a.summary.id}: no activity for ${ms} ms while not settled; ending it as stalled.`)
      void this.finalizeExecRun(a.summary.id, 'stalled', { endedBy: 'policy' })
    }, ms)
  }

  private clearExecTimers(a: ActiveRun): void {
    if (a.settleTimer) clearTimeout(a.settleTimer)
    if (a.stallTimer) clearTimeout(a.stallTimer)
    a.settleTimer = undefined
    a.stallTimer = undefined
    for (const t of a.policyTimers.values()) clearTimeout(t)
    a.policyTimers.clear()
  }

  /** A run.status from the finalizer itself (late adapter statuses are dropped). */
  private finalEmit(a: ActiveRun, e: Extract<RunEvent, { type: 'run.status' }>): void {
    a.finalEmitting = true
    try {
      a.emit(e)
    } finally {
      a.finalEmitting = false
    }
  }

  /**
   * End an exec run with `outcome` (cli-spec 6.2(2) item 4). Idempotent: the first call claims the outcome and later
   * calls return the same promise. Stops the session and waits for it (EXEC_FINALIZE_STOP_TIMEOUT_MS), joins the title
   * (EXEC_TITLE_JOIN_MS), flushes usage, writes the final status, execOutcome and endedBy, persists, and broadcasts
   * exactly one run.finalized. RunManager never calls stop() for policy, budget or completion finishes.
   */
  finalizeExecRun(runId: string, outcome: ExecOutcome, opts: { endedBy?: RunEndedBy } = {}): Promise<void> {
    const a = this.runs.get(runId)
    if (!a) return Promise.resolve()
    if (a.finalizing) return a.finalizing
    a.finalOutcome = outcome
    const endedBy = opts.endedBy !== undefined ? opts.endedBy : defaultEndedBy(outcome)
    const run = this.runFinalizer(a, outcome, endedBy)
      .catch((err: unknown) => log.warn(`Run ${runId}: finalizing failed: ${(err as Error)?.message ?? err}`))
      .finally(() => {
        a.finalizeDone = true
      })
    a.finalizing = run
    return run
  }

  private async runFinalizer(a: ActiveRun, outcome: ExecOutcome, endedBy: RunEndedBy | undefined): Promise<void> {
    // Claimed synchronously by finalizeExecRun; the body starts on a microtask so the caller's emit finishes first.
    await Promise.resolve()
    const s = a.summary
    this.clearExecTimers(a)
    // A finalized run never resumes by itself (a waitForReset pause stopped by the user included).
    this.clearResume(s.id)
    if (s.status === 'paused') s.autoResume = false
    if (endedBy) a.endedBy ??= endedBy
    if (outcome === 'interrupted') {
      a.userStopped = true
      if (endedBy === 'user') s.endedBy = 'user'
      if (s.status === 'starting' || s.status === 'running' || s.status === 'idle') this.finalEmit(a, { type: 'run.status', runId: s.id, status: 'stopping' })
      this.flush(a)
    }
    // A session still opening is waited for, then stopped with the rest.
    if (!a.session && a.opening) await raceTimeout(a.opening.catch(() => undefined), EXEC_FINALIZE_STOP_TIMEOUT_MS)
    let timedOut = false
    if (a.session) {
      const stopping = this.stopSession(a)?.catch((err: unknown) => log.warn(`Run ${s.id}: stop failed while finalizing: ${(err as Error)?.message ?? err}`))
      timedOut = await raceTimeout(Promise.all([stopping, a.session.finished.catch(() => undefined)]), EXEC_FINALIZE_STOP_TIMEOUT_MS)
      if (timedOut) log.warn(`Run ${s.id}: the session did not finish within ${EXEC_FINALIZE_STOP_TIMEOUT_MS} ms of being stopped; finalizing anyway.`)
    }
    // The title may still land within EXEC_TITLE_JOIN_MS; after that it is cancelled so it cannot race persistence.
    if (a.titleTask) await raceTimeout(a.titleTask, EXEC_TITLE_JOIN_MS)
    a.titleAbort?.abort()
    // The final status, unless the run already reached one (an adapter error, a natural end, the pause).
    // A paused run the user stopped ('interrupted') is finished, not left paused.
    const terminal = s.status === 'finished' || s.status === 'error' || (s.status === 'paused' && outcome !== 'interrupted')
    if (!terminal) {
      const status = outcome === 'failed' || outcome === 'auth-error' ? 'error' : outcome === 'rate-limited' ? 'paused' : 'finished'
      const error =
        status === 'error' ? a.adapterError || s.error || (a.lastTurnEnd?.errorSubtype ? `The turn ended with ${logText(a.lastTurnEnd.errorSubtype)}.` : 'The run failed.') : undefined
      this.finalEmit(a, { type: 'run.status', runId: s.id, status, ...(error ? { error } : {}), ...(status === 'paused' ? { autoResume: false } : {}) })
    }
    this.closeTimers(a)
    this.refreshUsage(a, true)
    if (s.overrides?.execMode) s.execOutcome = outcome
    if (endedBy) s.endedBy = endedBy
    else if (s.endedBy !== 'app') delete s.endedBy
    try {
      this.store.upsert(s)
    } catch (e) {
      log.warn(`Run ${s.id}: could not persist the finalized summary: ${(e as Error).message}`)
    }
    this.flush(a)
    a.finalizeDone = true
    // The run leaves the live set here once its final status is written (session.finished's teardown waited for it).
    if (this.runs.get(s.id) === a) this.teardown(a)
    if (s.overrides?.execMode && !a.finalizedSent) {
      a.finalizedSent = true
      this.broadcast({ type: 'run.finalized', runId: s.id, ...(s.overrides?.execChainId ? { execChainId: s.overrides.execChainId } : {}), outcome, summary: { ...s } })
    }
  }

  // ---------- decision cards: index, tombstones and the headless policy ----------

  /** A card was raised (after its *.request broadcast): index it, count the activity and apply the headless policy. */
  private cardCreated(a: ActiveRun, kind: CardKind, id: string, card: unknown): void {
    this.decisions.add(id, { runId: a.summary.id, projectId: a.summary.projectId, kind, revision: 1 })
    this.bumpActivity(a)
    this.applyPolicy(a, kind, id, card)
  }

  /** A card left the pending set: tombstone it, drop its policy timer, count the activity. */
  private cardResolved(a: ActiveRun, kind: CardKind, id: string, status: 'applied' | 'cancelled', effectiveDecision?: string, decidedBy?: DecidedBy): void {
    const t = a.policyTimers.get(id)
    if (t) clearTimeout(t)
    a.policyTimers.delete(id)
    this.decisions.resolve(id, { status, kind, runId: a.summary.id, ...(effectiveDecision ? { effectiveDecision } : {}), ...(decidedBy ? { decidedBy } : {}) })
    this.bumpActivity(a)
  }

  /** Cancel every open card of a run (its end or pause) and record 'cancelled' tombstones. */
  private cancelCards(a: ActiveRun): void {
    cancelPending(a, a.summary.id, this.broadcast, (id, kind) => this.cardResolved(a, kind, id, 'cancelled'))
  }

  /** The 'not pending' answer of a decision method: from the tombstones, else not-found. */
  private decisionMiss(requestId: string): DecisionOutcome {
    return this.decisions.missOutcome(requestId)
  }

  /** expectedRevision given and different from the card's revision. */
  private staleRevision(revision: number | undefined, opts: DecisionOptions): boolean {
    return opts.expectedRevision !== undefined && opts.expectedRevision !== (revision ?? 1)
  }

  /** The decision method for a card kind (the headless policy answers through the same paths as a human). */
  private decideCard<K extends CardKind>(kind: K, runId: string, id: string, decision: PolicyDecisions[K], opts: DecisionOptions): DecisionOutcome {
    switch (kind) {
      case 'permission':
        return this.decide(runId, id, decision as PolicyDecisions['permission'], opts)
      case 'rules':
        return this.decideRules(runId, id, decision as PolicyDecisions['rules'], opts)
      case 'proposal':
        return this.decideProposal(runId, id, decision as PolicyDecisions['proposal'], opts)
      case 'question':
        return this.answerQuestion(runId, id, decision as PolicyDecisions['question'], opts)
      case 'merge':
        return this.decideMerge(runId, id, decision as PolicyDecisions['merge'], opts)
      default:
        return this.answerMcpInstall(runId, id, decision as PolicyDecisions['mcpInstall'], opts)
    }
  }

  /**
   * Headless decision policy (cli-spec 6.2(1)) on an exec run: act after a 0 ms timer (so the *.request event goes out
   * first), or after humanGraceMs while an interactive client is attached. A human answer clears the timer.
   */
  private applyPolicy(a: ActiveRun, kind: CardKind, id: string, card: unknown): void {
    const o = a.summary.overrides
    if (!o?.execMode || a.finalizing) return
    const policy = fullPolicy(o.decisionPolicy)
    const runId = a.summary.id
    let interactive = 0
    try {
      interactive = this.options.interactiveClients?.() ?? 0
    } catch {
      interactive = 0
    }
    const act = (): void => {
      a.policyTimers.delete(id)
      if (a.finalizing || this.runs.get(runId) !== a || !findPendingCard(a, id)) return
      const action = policyAction(kind, card, policy)
      if (action.kind === 'fail') {
        a.emit({ type: 'log', runId, level: 'warn', message: `A ${kind} card needs a decision and the headless policy fails the run on it.` })
        void this.finalizeExecRun(runId, 'needs-decision', { endedBy: 'policy' })
        return
      }
      if (action.kind === 'wait') {
        a.policyTimers.set(
          id,
          setTimeout(() => {
            a.policyTimers.delete(id)
            if (a.finalizing || this.runs.get(runId) !== a || !findPendingCard(a, id)) return
            a.emit({ type: 'log', runId, level: 'warn', message: `Nobody answered a ${kind} card within ${policy.waitTimeoutMs} ms; the run ends.` })
            void this.finalizeExecRun(runId, 'needs-decision', { endedBy: 'policy' })
          }, timerDelay(policy.waitTimeoutMs))
        )
        return
      }
      this.decideCard(kind, runId, id, action.decision, { decidedBy: { surface: 'policy' } })
      if (!countsAsDenial(kind)) return
      a.autoDenials++
      if (a.autoDenials >= policy.maxAutoDenials) {
        a.emit({ type: 'log', runId, level: 'warn', message: `The headless policy refused ${a.autoDenials} decision${a.autoDenials === 1 ? '' : 's'} (limit ${policy.maxAutoDenials}); the run ends.` })
        void this.finalizeExecRun(runId, 'needs-decision', { endedBy: 'policy' })
      }
    }
    a.policyTimers.set(id, setTimeout(act, interactive > 0 ? timerDelay(policy.humanGraceMs) : 0))
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
      skills: [...a.skillCounts.values()],
      knowledge: a.knowledgeUsage,
      transcript: a.record.transcript
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

  // ---------- engagement notes and knowledge graph (harness tool writes) ----------

  /**
   * Provenance of a knowledge or note write: the run, the calling agent (missing = the root) and its role name. The
   * role comes from the run's agent record (its slug, shown as the role's name when the run's roles know it), else the
   * role the adapter named (caller.roleId), else the root role. Never a string the agent supplied.
   */
  private knowledgeSource(a: ActiveRun, caller: KnowledgeCaller, roles: Role[]): KnowledgeSource & { agentId: string } {
    const agentId = caller.agentId ?? ROOT_AGENT_ID
    const slug = a.record.agents[agentId]?.roleSlug
    const role =
      (slug ? (roles.find((r) => r.slug === slug)?.name ?? slug) : undefined) ??
      (caller.roleId ? roles.find((r) => r.id === caller.roleId)?.name : undefined) ??
      a.rootRole
    return { by: 'agent', runId: a.summary.id, agentId, ...(role ? { role } : {}), at: Date.now() }
  }

  /** Throws (before anything is saved) once the run made KNOWLEDGE_RUN_WRITES_MAX writes; the cap is logged once. */
  private checkKnowledgeBudget(a: ActiveRun): void {
    if (a.knowledgeWrites < KNOWLEDGE_RUN_WRITES_MAX) return
    if (!a.knowledgeCapWarned) {
      a.knowledgeCapWarned = true
      log.warn(`Run ${a.summary.id}: knowledge graph write limit (${KNOWLEDGE_RUN_WRITES_MAX}) reached; later writes are refused`)
    }
    throw new Error(`The knowledge graph write limit for this run (${KNOWLEDGE_RUN_WRITES_MAX}) is reached; nothing was saved.`)
  }

  /** After a successful store write: count it and write its harness transcript row on the writing agent. */
  private countKnowledgeWrite(a: ActiveRun, agentId: string, text: string): void {
    a.knowledgeWrites++
    this.knowledgeRow(a, agentId, text)
  }

  /**
   * A quiet harness row (like a skill load) on the agent that wrote to the notes or the graph. An agent id the run
   * record does not know (an adapter quirk) would attach the row to no visible agent, so it falls back to the root.
   */
  private knowledgeRow(a: ActiveRun, agentId: string, text: string): void {
    const shown = agentId === ROOT_AGENT_ID || a.record.agents[agentId] ? agentId : ROOT_AGENT_ID
    a.emit({ type: 'transcript', runId: a.summary.id, entry: { id: newId('t'), agentId: shown, at: Date.now(), source: 'harness', block: { kind: 'system', text } } })
  }

  /** A stored, non-virtual project (Chat's propose_project_settings target, open_in_app project checks). */
  private storedProjectFor(projectId: string): Project | undefined {
    if (typeof projectId !== 'string' || isVirtualProjectId(projectId)) return undefined
    let p: Project | null | undefined
    try {
      p = this.options.resolveProject?.(projectId)
    } catch {
      p = undefined
    }
    return p && !isVirtualProjectId(p.id) ? p : undefined
  }

  /**
   * ctx.navigate (open_in_app): limits, surface and project checks, then one AppNavigateEvent through
   * options.selfKnowledge.navigate and one harness row on the calling agent.
   */
  private navigateFor(a: ActiveRun, target: { surfaceId: AtlasSurfaceId; projectId?: string }, caller: { agentId?: string }): AppNavigateOutcome {
    const sk = this.options.selfKnowledge
    if (!sk) return { ok: false, refusal: 'This run cannot open places in the app.' }
    if (!isAtlasSurfaceId(target?.surfaceId)) return { ok: false, refusal: 'That is not a place OrgAI knows; use app_reference locate to find the surface id.' }
    if ((a.appOpens ?? 0) >= OPEN_IN_APP_PER_RUN_MAX) return { ok: false, refusal: `Already opened ${OPEN_IN_APP_PER_RUN_MAX} places in this run.` }
    const now = Date.now()
    if (a.appOpenedAt !== undefined && now - a.appOpenedAt < OPEN_IN_APP_MIN_INTERVAL_MS) return { ok: false, refusal: 'Wait a moment before opening another place.' }
    const scope = atlasSurface(target.surfaceId)?.scope ?? 'app'
    let projectId: string | undefined
    if (scope === 'project' || scope === 'engagement' || scope === 'run') {
      if (target.projectId === undefined) {
        if (scope !== 'run') return { ok: false, refusal: 'That place belongs to a project; give projectId (call list_projects for ids).' }
      } else {
        const project = this.storedProjectFor(target.projectId)
        if (!project) return { ok: false, refusal: 'No such project; call list_projects for ids.' }
        if (scope === 'engagement' && projectKindOf(project) !== 'engagement') return { ok: false, refusal: 'That place only exists in engagement projects.' }
        projectId = project.id
      }
    }
    const agent = caller.agentId && caller.agentId !== ROOT_AGENT_ID ? a.record.agents[caller.agentId] : a.record.agents[ROOT_AGENT_ID]
    const agentLabel = clampText(agent?.name || a.rootRole, 80) || 'Assistant'
    const event: AppNavigateEvent = { surfaceId: target.surfaceId, ...(projectId ? { projectId } : {}), runId: a.summary.id, agentLabel }
    let shown = false
    try {
      shown = sk.navigate(event)
    } catch (e) {
      log.warn(`open_in_app could not be delivered: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!shown) return { ok: false, refusal: 'No OrgAI window is open to show it in.' }
    a.appOpens = (a.appOpens ?? 0) + 1
    a.appOpenedAt = now
    const path = atlasPath(target.surfaceId)
    this.knowledgeRow(a, caller.agentId ?? ROOT_AGENT_ID, `Opened ${path} for you`)
    return { ok: true, path }
  }

  /** Push projects:engagementChanged for an agent write (index.ts passes the broadcaster); never throws into the tool. */
  private engagementChanged(projectId: string, what: 'notes' | 'knowledge', ids: string[]): void {
    const event: EngagementChangedEvent = { projectId, what, ids }
    try {
      this.options.engagementChanged?.(event)
    } catch (e) {
      log.warn(`engagementChanged broadcast failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * RuntimeContext.outputs over the outputs service: the folder scope read from the stored project at call time (so an
   * allowed folder added mid-run counts at once), the source from the run's agent record, the per-run cap, `output.created`,
   * one quiet transcript row on the calling agent and the outputs:changed push (never throws into the tool).
   */
  private bindOutputs(
    a: ActiveRun,
    service: OutputsServiceApi,
    projectId: string,
    roles: () => Role[],
    project: () => Project
  ): NonNullable<RuntimeContext['outputs']> {
    const done = async (
      caller: KnowledgeCaller,
      call: (scope: OutputScope, source: { runId: string; agentId?: string; role?: string }) => Promise<OutputWriteResult>,
      row: (o: RunOutput) => string
    ): Promise<OutputWriteResult> => {
      if (a.outputsMade >= OUTPUTS_RUN_MAX) {
        if (!a.outputsCapWarned) {
          a.outputsCapWarned = true
          log.warn(`Run ${a.summary.id}: output limit (${OUTPUTS_RUN_MAX}) reached; later outputs are refused`)
        }
        throw new Error(`The output limit for this run (${OUTPUTS_RUN_MAX}) is reached; nothing was saved.`)
      }
      // Reserve the slot before the await so parallel calls cannot pass the check together; release it on failure.
      let known: ReturnType<RunManager['knowledgeSource']>
      let result: OutputWriteResult
      a.outputsMade++
      try {
        known = this.knowledgeSource(a, caller, roles())
        const scope = outputScopeOf(project(), this.options.dataDir)
        result = await call(scope, { runId: a.summary.id, agentId: known.agentId, ...(known.role ? { role: known.role } : {}) })
      } catch (e) {
        a.outputsMade--
        throw e
      }
      const { output, created } = result
      const versioned = !created && !!result.versioned
      // A call that changed nothing (same content) costs no slot and emits no event; the transcript still says so.
      if (!created && !versioned) a.outputsMade--
      const n = output.version ?? 1
      if (created) a.emit({ type: 'output.created', runId: a.summary.id, output })
      else if (versioned) a.emit({ type: 'output.versioned', runId: a.summary.id, output })
      this.knowledgeRow(a, known.agentId, created ? row(output) : versioned ? `Updated ${datum(output.title, 120)} to version ${n}` : `No change; still version ${n}`)
      try {
        this.options.outputsChanged?.({ projectId, ids: [output.id], what: created ? 'added' : versioned ? 'version' : 'updated' })
      } catch (e) {
        log.warn(`outputsChanged broadcast failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      return result
    }
    return {
      produce: (input: OutputProduceInput, caller) =>
        done(
          caller,
          (scope, source) => service.produce(scope, input, source),
          (o) => `Produced ${producedWord(o.kind)} ${datum(o.title, 120)}`
        ),
      register: (input: OutputRegisterInput, caller) =>
        done(
          caller,
          (scope, source) => service.register(scope, input, source),
          (o) => `Registered output ${datum(o.title, 120)}`
        ),
      // Read-only: no cap, no event, no row. The service resolves the scope's folders for its own path checks.
      read: (input: OutputReadInput) => service.readForAgent(outputScopeOf(project(), this.options.dataDir), input)
    }
  }

  /**
   * A run reached an outcome (finished, error, stopped): let the outputs service close the revision requests it never
   * answered and push 'revision' for the outputs they touch. Never throws, never waits for the caller.
   */
  private outputsRunEnded(a: ActiveRun): void {
    const service = this.options.outputs
    const projectId = a.summary.projectId
    if (!service || isVirtualProjectId(projectId)) return
    try {
      // The service's own onChange pushes the 'revision' change; emitting it here too would double it.
      service.runEnded(projectId, a.summary.id)
    } catch (e) {
      log.warn(`outputs runEnded failed for run ${a.summary.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** Revise routing (outputs/revise.ts): how a live run stands, or null when it is not live. */
  liveRunFacts(runId: string): { status: RunSummary['status']; limitHold: boolean; pendingCards: number; working: boolean } | null {
    const a = this.runs.get(runId)
    if (!a || !LIVE_STATUSES.has(a.summary.status)) return null
    // working: runActivity's 'working' or 'ending' (an idle root whose reports, peer flush or nudge still run).
    return { status: a.summary.status, limitHold: !!a.limitHold, pendingCards: pendingCount(a), working: this.activityStateOf(a) !== 'waiting' }
  }

  /** Revise routing: OrgAI is quitting, so nothing starts, continues or takes a message. */
  isQuitting(): boolean {
    return this.quitting
  }

  /** RuntimeContext.knowledge over the store: provenance, the writes cap, one transcript row per write, the push. */
  private bindKnowledge(a: ActiveRun, store: KnowledgeStoreApi, projectId: string, roles: () => Role[]): NonNullable<RuntimeContext['knowledge']> {
    const label = (n: KnowledgeNode): string => `${n.kind} ${n.name}`
    return {
      graph: () => store.get(projectId),
      upsertNode: (input, caller) => {
        this.checkKnowledgeBudget(a)
        const source = this.knowledgeSource(a, caller, roles())
        const r = store.upsertNode(projectId, input, source)
        this.countKnowledgeWrite(a, source.agentId, `${r.created ? 'Recorded' : 'Updated'} ${label(r.node)}`)
        this.engagementChanged(projectId, 'knowledge', [r.node.id])
        return r
      },
      link: (input, caller) => {
        this.checkKnowledgeBudget(a)
        const source = this.knowledgeSource(a, caller, roles())
        const r = store.saveEdge(projectId, input, source)
        const g = store.get(projectId)
        const name = (id: string): string => {
          const n = g.nodes.find((x) => x.id === id)
          return n ? n.name : id
        }
        this.countKnowledgeWrite(a, source.agentId, `Linked ${name(r.edge.from)} ${r.edge.relation} ${name(r.edge.to)}`)
        this.engagementChanged(projectId, 'knowledge', [r.edge.id])
        return r
      },
      retire: (input, caller) => {
        this.checkKnowledgeBudget(a)
        const source = this.knowledgeSource(a, caller, roles())
        const r = store.retire(projectId, input, source)
        if (r.alreadyRetired) return r
        // A fact's label is its text (multi-line, up to 1,000 chars): one line, cut, like every other row value.
        const reason = input.reason?.trim() ? ` (${datum(input.reason, 120)})` : ''
        this.countKnowledgeWrite(a, source.agentId, `Retired ${r.item} ${datum(r.label, 160)}${reason}`)
        this.engagementChanged(projectId, 'knowledge', [r.id])
        return r
      }
    }
  }

  // ---------- knowledge reads: recall, automatic context, brief (read-only, in-memory state per run) ----------

  /** The agent a row or event lands on: the agent when the run record knows it, else the root (like knowledgeRow). */
  private visibleAgent(a: ActiveRun, agentId: string): string {
    return agentId === ROOT_AGENT_ID || a.record.agents[agentId] ? agentId : ROOT_AGENT_ID
  }

  /**
   * The "already shown" map of one agent (created on first use), or undefined for a missing / over-long id and once the
   * run tracks KNOWLEDGE_SHOWN_AGENTS_MAX agents (those just get no dedupe). Keyed by the id the adapter reports, so a
   * spawned agent that is not in the run record yet still has its own state.
   */
  private shownFor(a: ActiveRun, agentId: string | undefined): Map<string, string> | undefined {
    if (typeof agentId !== 'string' || !agentId || agentId.length > 128) return undefined
    let m = a.knowledgeShown.get(agentId)
    if (!m) {
      if (a.knowledgeShown.size >= KNOWLEDGE_SHOWN_AGENTS_MAX) return undefined
      m = new Map()
      a.knowledgeShown.set(agentId, m)
    }
    return m
  }

  /** Like shownFor, for what an automatic context block already gave this agent (it may be less than a recall gives). */
  private contextShownFor(a: ActiveRun, agentId: string | undefined): Map<string, string> | undefined {
    if (typeof agentId !== 'string' || !agentId || agentId.length > 128) return undefined
    let m = a.knowledgeContextShown.get(agentId)
    if (!m) {
      if (a.knowledgeContextShown.size >= KNOWLEDGE_SHOWN_AGENTS_MAX) return undefined
      m = new Map()
      a.knowledgeContextShown.set(agentId, m)
    }
    return m
  }

  /** Count what was served, refresh the usage and (for a non-empty answer) tell the renderer which nodes were touched. */
  private noteServed(a: ActiveRun, kind: 'recalls' | 'autoContexts', items: number, chars: number): void {
    a.knowledgeUsage[kind]++
    a.knowledgeUsage.itemsServed += items
    a.knowledgeUsage.charsServed += chars
    if (this.runs.get(a.summary.id) === a) this.refreshUsage(a, false)
  }

  /**
   * knowledge.recalled for one agent: at most one per KNOWLEDGE_RECALLED_THROTTLE_MS. The first call goes out at once
   * (leading edge); calls inside the window merge their ids (deduped, the newest KNOWLEDGE_RECALLED_IDS_MAX kept, the
   * newest call's `via`) into one trailing event when the window ends. Nothing is queued after the run's outcome.
   */
  private noteRecalled(a: ActiveRun, agentId: string, ids: string[], via: 'recall' | 'auto'): void {
    if (!ids.length || a.outcome) return
    const key = this.visibleAgent(a, agentId)
    let st = a.knowledgeRecalled.get(key)
    if (!st) {
      st = { lastAt: 0 }
      a.knowledgeRecalled.set(key, st)
    }
    const fresh = new Set(ids)
    st.pending = { ids: [...(st.pending?.ids ?? []).filter((id) => !fresh.has(id)), ...fresh].slice(-KNOWLEDGE_RECALLED_IDS_MAX), via }
    if (st.timer) return
    const wait = Math.max(0, st.lastAt + KNOWLEDGE_RECALLED_THROTTLE_MS - Date.now())
    if (wait === 0) {
      this.sendRecalled(a, key, st)
      return
    }
    st.timer = setTimeout(() => this.sendRecalled(a, key, st), wait)
    st.timer.unref?.()
  }

  private sendRecalled(a: ActiveRun, agentId: string, st: RecalledThrottle, force = false): void {
    if (st.timer) clearTimeout(st.timer)
    st.timer = undefined
    const pending = st.pending
    st.pending = undefined
    if (!pending || !pending.ids.length) return
    if (!force && (a.outcome || this.runs.get(a.summary.id) !== a)) return
    st.lastAt = Date.now()
    a.emit({ type: 'knowledge.recalled', runId: a.summary.id, agentId, nodeIds: pending.ids, at: st.lastAt, via: pending.via })
  }

  /** Send every waiting knowledge.recalled now and stop the timers (the run is ending; called before the terminal status goes out). */
  private flushRecalled(a: ActiveRun): void {
    for (const [agentId, st] of a.knowledgeRecalled) this.sendRecalled(a, agentId, st, true)
    a.knowledgeRecalled.clear()
  }

  /**
   * RuntimeContext.knowledgeRecall / knowledgeContext / knowledgeBrief over the store. Read-only: no write counts toward
   * KNOWLEDGE_RUN_WRITES_MAX and the graph file is never touched. Dedupe state lives on the ActiveRun only.
   * `project` is the project as saved now (falls back to the run's own copy), for Project.knowledgeAutoContext.
   */
  private bindKnowledgeReads(
    a: ActiveRun,
    store: KnowledgeStoreApi,
    projectId: string,
    project: () => Project
  ): Pick<RuntimeContext, 'knowledgeRecall' | 'knowledgeContext' | 'knowledgeBrief'> {
    return {
      knowledgeRecall: (input: KnowledgeRecallInput, caller: KnowledgeCaller): string => {
        try {
          // The row lands on the root when no agent is named, but dedupe needs a named agent: an unknown caller must not
          // share the root's "already shown" state (ROOT_AGENT_ID named explicitly does).
          const agentId = caller.agentId ?? ROOT_AGENT_ID
          const query = String(input.query)
          const graph = store.get(projectId)
          const view = store.recallView?.(projectId)
          const inferred = strongMentionLinks(view?.inferred ?? store.inferred?.(projectId) ?? [])
          const shown = this.shownFor(a, caller.agentId)
          const r = recallKnowledge(graph, query, { budget: input.budget, fresh: input.fresh === true, ...(shown ? { shown } : {}), inferred, ...(view ? { rankOn: view.rankOn } : {}) })
          const ids = [...r.served.map((s) => s.id), ...r.alreadyShown]
          if (shown) for (const s of r.served) if (s.complete) shown.set(s.id, s.signature)
          this.noteServed(a, 'recalls', r.served.length, r.text.length)
          this.knowledgeRow(a, agentId, `Recalled ${ids.length} item${ids.length === 1 ? '' : 's'} about ${datum(query, 80)}`)
          this.noteRecalled(a, agentId, ids, 'recall')
          // A very large graph is ranked on a revision up to 30 s old (store readRecallView): say so, in a few words.
          const old = view && view.rankOn !== graph ? ' (Search index up to 30 s old.)' : ''
          if (r.text) return `${r.text}${old ? `\n${old.trim()}` : ''}`
          const q = fenceDatum(query, 120)
          return (r.cut.length ? `${r.cut.length} entities match "${q}" but none fit the budget. Ask again with a larger budget.` : `Nothing in the knowledge graph matches "${q}".`) + old
        } catch (e) {
          log.warn(`Run ${a.summary.id}: knowledge recall failed: ${e instanceof Error ? e.message : String(e)}`)
          return 'The knowledge graph could not be read right now.'
        }
      },
      knowledgeContext: (text: string, opts: { agentId?: string; purpose: 'spawn' | 'message' }): string | null => {
        try {
          if (typeof text !== 'string' || !text) return null
          if (!knowledgeAutoContextOn(project())) return null
          const agentId = typeof opts?.agentId === 'string' && opts.agentId ? opts.agentId : undefined
          const shown = this.shownFor(a, agentId)
          const contextShown = this.contextShownFor(a, agentId)
          const r = knowledgeContextBlock(store.get(projectId), text, { ...(shown ? { shown } : {}), ...(contextShown ? { contextShown } : {}) })
          if (!r) return null
          // "Already shown" for a recall needs everything printed; the next automatic block only needs this one to have gone out.
          if (shown) for (const s of r.served) if (s.complete) shown.set(s.id, s.signature)
          if (contextShown) for (const s of r.served) contextShown.set(s.id, s.signature)
          this.noteServed(a, 'autoContexts', r.served.length, r.text.length)
          const names = r.served.map((s) => knowledgeListItem(s.name, 60))
          const n = names.length
          const list = names.slice(0, KNOWLEDGE_ROW_NAMES).join(', ') + (n > KNOWLEDGE_ROW_NAMES ? `, and ${n - KNOWLEDGE_ROW_NAMES} more` : '')
          const row = `Added ${n} known item${n === 1 ? '' : 's'}: ${list}`
          this.knowledgeRow(a, agentId ?? ROOT_AGENT_ID, row.length > 200 ? `${dropLoneHighSurrogate(row.slice(0, 199))}…` : row)
          this.noteRecalled(a, agentId ?? ROOT_AGENT_ID, r.served.map((s) => s.id), 'auto')
          return r.text
        } catch (e) {
          log.warn(`Run ${a.summary.id}: knowledge context failed: ${e instanceof Error ? e.message : String(e)}`)
          return null
        }
      },
      knowledgeBrief: (): string | undefined => {
        if (a.knowledgeBriefDone) return a.knowledgeBriefText
        a.knowledgeBriefDone = true
        try {
          a.knowledgeBriefText = knowledgeBrief(store.get(projectId))
        } catch (e) {
          log.warn(`Run ${a.summary.id}: knowledge brief failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        return a.knowledgeBriefText
      }
    }
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
    // Reached from session.finished and, for an exec run that never started or never finished, from the finalizer.
    if (active.tornDown) return
    // An exec run the finalizer claimed stays live until its final status is written (it may still wait for the
    // title), so listLive, continueRun and a quit's writeCut never see it gone while it still reads 'idle'.
    if (active.finalizing && !active.finalizeDone) {
      void active.finalizing.finally(() => this.teardown(active))
      return
    }
    active.tornDown = true
    const runId = active.summary.id
    this.endAcceptEditsGrant(active)
    // Bridged children never outlive their run.
    if (active.bridge?.hasActive()) void active.bridge.stopAll('the run ended').catch(() => {})
    // A widened chain's grant lives only until its own automatic resume (an armed timer); any other end drops it.
    if (!this.resumeTimers.has(runId)) this.widenedRuns.delete(runId)
    // Every waiting card (permissions, proposals, questions, rules, merges, installs) is settled as cancelled.
    this.cancelCards(active)
    // Waiting knowledge.recalled events are sent once and their timers stop (nothing is emitted after this).
    this.flushRecalled(active)
    // After the cards and the recalled events: their cancellation counts as activity and would re-arm the exec timers.
    this.clearExecTimers(active)
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
    // The run's assignments go into its project's staffing profile (spec 4.5); never throws, once per run id.
    if (active.ctx) recordRunInStaffingProfile(this.options.dataDir, active.record, active.ctx.project, (m) => log.warn(m))
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
      const title = await generateRunTitle(
        adapter,
        {
          ...input,
          signal: abort.signal,
          // Title spend is logged (it is not an agent's usage, so it is not in the run totals).
          onUsage: (u) => log.info(`Run ${runId}: title used ${(Number(u?.tokens?.input) || 0) + (Number(u?.tokens?.output) || 0)} tokens${u?.model ? ` on ${u.model}` : ''}`)
        },
        (message) => log.info(`Run ${runId}: no title (${scrub(message)})`))
      if (!title || abort.signal.aborted) return
      const live = this.runs.get(runId) === active
      if (!live) {
        const stored = this.store.get(runId)
        if (!stored) return
        active.summary = stored
        active.record.summary = stored
      }
      active.summary.title = title
      this.store.upsert(active.summary)
      if (live) {
        active.emit({ type: 'run.title', runId, title })
      } else {
        // The session already ended and its record was flushed; save the latest summary with the title.
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
      case 'staffing.updated':
        r.staffing = e.staffing
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

  /**
   * Team evolution: the single post-run pass of a run started with `evolve`. Off the critical path (a microtask after the
   * record is flushed), never throws, never starts a run. The promise is kept (bounded) so a headless caller can wait
   * for it through awaitEvolvePass.
   */
  private startEvolvePass(active: ActiveRun): void {
    const afterRun = this.options.evolveAfterRun
    const runId = active.summary.id
    const strategy = active.evolve
    const evalWindowRuns = active.evolveWindowRuns
    active.evolve = undefined
    if (!afterRun || this.evolvePasses.has(runId) || !strategy) return
    // The record (transcript, usage, plan) is what the engine measures; the closing usage refresh lands right after this event.
    this.evolvePassesInFlight++
    const pass = Promise.resolve()
      .then(() => {
        // Quitting began, or the user interrupted, between the run's end and this microtask: no pass.
        if (this.quitting || active.held) return undefined
        this.flush(active)
        return afterRun({ projectId: active.summary.projectId, evolve: true, ...(strategy === true ? {} : { strategy }), ...(evalWindowRuns !== undefined ? { evalWindowRuns } : {}) })
      })
      .catch((e: unknown) => {
        log.warn(`Run ${runId}: the post-run evolve pass failed: ${logText(String((e as Error)?.message ?? e))}`)
        return undefined
      })
      .finally(() => {
        this.evolvePassesInFlight--
      })
    this.evolvePasses.set(runId, pass)
    while (this.evolvePasses.size > EVOLVE_PASSES_KEPT) this.evolvePasses.delete(this.evolvePasses.keys().next().value as string)
  }

  /** The post-run evolve pass of a run, resolved when it settles; undefined when the run had none (not started with evolve, stopped, still live, or the pass failed). */
  async awaitEvolvePass(runId: string): Promise<EvolvePostRunResult | undefined> {
    return this.evolvePasses.get(runId)
  }

  /** Runs whose session is still open. */
  liveRunCount(): number {
    return this.runs.size
  }

  /** What a live run is doing (runActivity.ts): working without the user, ending, or only waiting on the user. */
  private activityStateOf(a: ActiveRun): RunActivityState {
    let settlement: SessionSettlement | undefined
    try {
      settlement = a.session?.settlement?.()
    } catch {
      settlement = undefined
    }
    return runActivityState({
      status: a.summary.status,
      openCards: pendingCount(a),
      held: a.held,
      limitHold: !!a.limitHold,
      agents: Object.values(a.record.agents),
      peerMessagesPending: a.inbox.length > 0 || !!a.flushing || !!a.bridge?.hasActive(),
      ...(settlement ? { settlement } : {})
    })
  }

  /**
   * Live runs doing work without the user right now (review H3): the desktop asks before closing its last window
   * only for these. Idle runs, runs with an open card and runs held by an interrupt or a usage limit do not count.
   */
  workingRunCount(): number {
    let n = 0
    for (const a of this.runs.values()) if (this.activityStateOf(a) === 'working') n++
    return n
  }

  /**
   * Activity ('liveRuns', cli-spec 3.2(4)): live runs that keep a host from going idle. Working and ending runs, and
   * exec runs still in flight (their follower, stall watchdog and decision policy own their end). A run that only
   * waits on its user does not: a background host's idle exit then ends it like a quit would (continuable).
   */
  busyRunCount(): number {
    let n = 0
    for (const a of this.runs.values()) {
      const s = a.summary
      if (!LIVE_STATUSES.has(s.status)) continue
      if (keepsHostBusy(this.activityStateOf(a), !!s.overrides?.execMode && !s.execOutcome)) n++
    }
    return n
  }

  /**
   * The run counts host.status reports (the TUI's quit confirm), stricter than
   * busyRunCount: every live run in any form counts (working or ending, waiting on the user, held), every paused run
   * with an auto-resume pending (armed or firing), and every open card. terminalSessions is the socket server's; the
   * caller fills it.
   */
  handoffFacts(): Omit<HostHandoffFacts, 'terminalSessions'> {
    let workingRuns = 0
    let waitingRuns = 0
    let heldRuns = 0
    let openCards = 0
    for (const a of this.runs.values()) {
      openCards += pendingCount(a)
      const s = a.summary
      const state = this.activityStateOf(a)
      // An exec run in flight is working whatever its root does (its follower owns its end), as in busyRunCount.
      if (state !== 'waiting' || (LIVE_STATUSES.has(s.status) && !!s.overrides?.execMode && !s.execOutcome)) workingRuns++
      else if (a.held || a.limitHold) heldRuns++
      else waitingRuns++
    }
    return { workingRuns, waitingRuns, heldRuns, pausedRuns: this.activeResumeTimerCount() + this.inFlightResumeCount(), openCards }
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

  /** runs:usageCsv: usageStats rows as CSV (USAGE_CSV_COLUMNS), limit USAGE_STATS_MAX_LIMIT (runUsage.ts buildUsageCsv). */
  usageCsv(raw: UsageStatsQuery, names: { project?: string; client?: string } = {}): string {
    return buildUsageCsv(this.usageStats({ ...(raw && typeof raw === 'object' ? raw : {}), limit: USAGE_STATS_MAX_LIMIT } as UsageStatsQuery), {
      project: typeof names.project === 'string' ? names.project : '',
      client: typeof names.client === 'string' ? names.client : ''
    })
  }

  /** runs:usageStats: usage per run, per role and per trend bucket for one project (see UsageStats). */
  usageStats(raw: UsageStatsQuery): UsageStats {
    const query = sanitizeUsageQuery(raw)
    const now = Date.now()
    const inRange = (s: RunSummary): boolean =>
      s.projectId === query.projectId &&
      (query.kinds as RunKind[]).includes(s.kind) && (query.since === undefined || s.startedAt >= query.since) && (query.until === undefined || s.startedAt < query.until)
    return buildUsageStats(this.usageSummaries(this.store.list(query.projectId), inRange, now), query, now)
  }

  /**
   * runs:usageOverview: usage across every project (stored, virtual and a removed project's leftover runs); see
   * UsageOverview. `names` resolves project and connection display names (the dispatcher's project lookup). Throws for
   * a malformed month or project id list (sanitizeUsageOverviewQuery).
   */
  usageOverview(raw: unknown, names: UsageOverviewNames): UsageOverview {
    const query = sanitizeUsageOverviewQuery(raw)
    const now = Date.now()
    const kinds = new Set(query.kinds)
    const only = query.projectIds ? new Set(query.projectIds) : null
    const inRange = (s: RunSummary): boolean =>
      kinds.has(s.kind) && (!only || only.has(s.projectId)) && (query.since === undefined || s.startedAt >= query.since) && (query.until === undefined || s.startedAt < query.until)
    return buildUsageOverview(this.usageSummaries(this.store.all(), inRange, now), query, names, now, new Set(this.runs.keys()))
  }

  /** runs:usageOverviewCsv: the overview's rows as CSV, at most USAGE_STATS_MAX_LIMIT (the query's limit is replaced). */
  usageOverviewCsv(raw: unknown, names: UsageOverviewNames): string {
    // A non-object raw (other than undefined / null) is passed through so the sanitizer refuses it.
    const query = raw === undefined || raw === null ? { limit: USAGE_STATS_MAX_LIMIT } : typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, limit: USAGE_STATS_MAX_LIMIT } : raw
    return buildUsageOverviewCsv(this.usageOverview(query, names))
  }

  /**
   * Summaries with usage filled for the usage queries: stored ones that pass `keep` (legacy ones normalized from their
   * record once and written back to the index) plus live runs with their current usage.
   */
  private usageSummaries(stored: readonly RunSummary[], keep: (s: RunSummary) => boolean, now: number): RunSummary[] {
    const byId = new Map<string, RunSummary>()
    const fill: { id: string; usage: RunUsage }[] = []
    for (const s of stored) {
      if (!keep(s) || this.runs.has(s.id)) continue
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
      if (!keep(a.summary)) continue
      byId.set(a.summary.id, { ...a.summary, usage: this.currentUsage(a, now) })
    }
    return [...byId.values()]
  }

  // ---------- cross-run messaging ----------

  /**
   * list_runs: every other live work run, across projects, oldest first. A setup-like caller sees none. A peer's
   * prompt is shown only when both the caller's and the peer's projects have runMessaging on (else ''), so a project
   * that did not opt in neither reads nor reveals what other runs are doing beyond project, status and orchestrator.
   */
  private listRunsFor(self: ActiveRun): RunPeer[] {
    if (isSetupLikeRun(self.summary.kind) || isVirtualProjectId(self.summary.projectId) || self.summary.team === 'single') return []
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
    if (isSetupLikeRun(sender.summary.kind) || isVirtualProjectId(sender.summary.projectId) || sender.summary.team === 'single') return { result: 'refused', refusal: 'not-work' }
    if (targetId === sender.summary.id) return { result: 'refused', refusal: 'self' }
    if (!text) return { result: 'refused', refusal: 'empty' }
    const target = this.runs.get(targetId)
    const stored = target ? undefined : this.store.get(targetId)
    if (!target && !stored) return { result: 'not-found' }
    const targetSummary = target?.summary ?? stored!
    if (isSetupLikeRun(targetSummary.kind) || isVirtualProjectId(targetSummary.projectId) || targetSummary.team === 'single') return { result: 'refused', refusal: 'not-work' }
    // An ended run is just not live; checking its project's flag would name a project the caller cannot list.
    if (!target) return { result: 'not-live' }
    // A headless exec run takes no peer messages unless its caller allowed them (RunOverrides.allowPeerMessages).
    if (target.summary.overrides?.execMode && !target.summary.overrides.allowPeerMessages) {
      return { result: 'refused', refusal: 'messaging-off', offProjects: [target.projectName] }
    }
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
      this.bumpActivity(a)
      try {
        while (a.inbox.length && this.deliveryBlocked(a) === null && this.runs.get(a.summary.id) === a) {
          const m = a.inbox.shift()!
          m.delivered = await this.deliverPeerMessage(a, m)
        }
      } finally {
        this.bumpActivity(a)
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
    if (isVirtualProjectId(a.summary.projectId) || a.summary.team === 'single') return false
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
    // A call that touches a reference folder offers Allow once and Deny only, whatever the adapter sent.
    if (typeof request.referenceFolder === 'string' && request.referenceFolder) {
      delete request.suggestions
      delete request.ruleLabels
    } else if ('referenceFolder' in request) delete request.referenceFolder
    // Fields only RunManager may set: drop whatever an adapter sent.
    delete request.quickReadOnly
    delete request.maxScope
    delete request.workingFolder
    delete request.workingFolderScratch
    const quick = active.summary.quick
    if (quick && !quick.allowEdits && isQuickWriteTool(request.toolName)) request.quickReadOnly = true
    if (request.referenceFolder) request.maxScope = 'once'
    else if (this.isRestricted(active.summary)) request.maxScope = 'session'
    if (quick) {
      request.workingFolder = quick.folder
      if (quick.scratch) request.workingFolderScratch = true
    }
    request.revision = 1
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
      this.cardCreated(active, 'permission', request.id, request)
    })
  }

  /** Quick runs and build sessions never save anything into their folder (isTrustRestrictedRun, plus the quick project). */
  private isRestricted(summary: RunSummary): boolean {
    return summary.projectId === QUICK_PROJECT_ID || isTrustRestrictedRun(summary)
  }

  decide(runId: string, requestId: string, decision: PermissionDecision, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pending.get(requestId)
    if (!active || !pending) return this.decisionMiss(requestId)
    if (this.staleRevision(pending.request.revision, opts)) return { status: 'stale-revision', runId, requestId }
    // pending -> resolving: out of the map before anything else runs, so a second answer finds a tombstone.
    active.pending.delete(requestId)
    // A quick run or build session works in a folder that is not a project: a 'project' grant would let the adapter
    // save rules into it. Narrow to the session here so every adapter is covered.
    let narrowed: PermissionDecision =
      decision?.behavior === 'allow' && decision.scope === 'project' && this.isRestricted(active.summary) ? { ...decision, scope: 'session' } : decision
    // A call that touches a reference folder is allowed once at most: never a session or project grant.
    if (pending.request.referenceFolder && narrowed?.behavior === 'allow' && (narrowed.scope === 'session' || narrowed.scope === 'project')) {
      log.info(`Narrowed a ${narrowed.scope} grant to once: the call touches a reference folder`)
      narrowed = { ...narrowed, scope: 'once' }
    }
    if (isQuickSessionEditGrant(active.summary, pending.request, narrowed) && !active.quickSessionEdits) {
      active.quickSessionEdits = true
      log.info('Quick run: edits allowed for the session in its folder')
    }
    const effective = narrowed?.behavior === 'allow' ? 'allow' : 'deny'
    this.cardResolved(active, 'permission', requestId, 'applied', effective, opts.decidedBy)
    pending.resolve(narrowed)
    const savedToProject = narrowed?.behavior === 'allow' && narrowed.scope === 'project'
    this.broadcast({ type: 'permission.resolved', runId, requestId, ...(savedToProject ? { savedToProject: true as const } : {}), ...(narrowed?.behavior === 'allow' && narrowed.scope ? { scope: narrowed.scope } : {}), ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}) })
    if (active.summary.quick && narrowed?.behavior === 'allow' && narrowed.scope === 'session') {
      // Adapter labels are built from the agent's own command text: strip hidden characters before they reach a row.
      const labels = (pending.request.ruleLabels ?? []).map((l) => excerpt(clampText(String(l), 80), 80)).filter(Boolean).join(', ')
      const what = isQuickSessionEditGrant(active.summary, pending.request, narrowed)
        ? "edits in this chat's folder"
        : labels
          ? excerpt(labels, 200)
          : excerpt(clampText(String(pending.request.toolName), 80), 80)
      systemBlock(active, Date.now(), `You allowed ${what} for this chat.`)
    }
    this.cardSettled(active)
    return applied(runId, requestId, effective, opts)
  }

  private requestProposal(
    active: ActiveRun,
    req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>,
    onApplied?: (saved: Project) => void
  ): Promise<ProposalOutcome> {
    const effect = proposalEffect(req.kind, active.summary, active.adapter)
    const proposal = { ...req, id: newId('prop'), runId: active.summary.id, createdAt: Date.now(), effect, revision: 1 } as Proposal
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
        // Round 6 item 10: the typed values go into the apply itself, which stores them before it changes any record. Values
        // the store cannot take now (vault locked, damaged, no secure storage) make it throw ProposalSecretsNotSaved with
        // the store's own reason (5.4), nothing applied; decideProposal keeps the card open for another try. Over the
        // socket, the setup:decide storesSecret predicate has prepared (created or reopened) the vault before this runs,
        // by the same slot rule (proposalSecrets.ts proposalTypedSlots).
        const secrets = proposal.kind === 'mcpServers' && decision.secrets ? { secrets: decision.secrets } : {}
        {
          try {
            if (proposal.kind === 'schedules') {
              // Schedules: Chat (any target) or a stored project's work run (that project only); ScheduleService
              // validates every item again and writes all or nothing. A scheduled run never gets here (the tool refuses).
              if (!this.options.schedules) throw new Error('Schedules are not available in this run.')
              if (active.summary.scheduleId) throw new Error('A scheduled run cannot create or change schedules.')
              const quick = !!active.summary.quick
              if (active.summary.kind !== 'work' || (!quick && isVirtualProjectId(active.summary.projectId))) throw new Error('Schedules can only be proposed from Chat or a project run.')
              this.options.schedules.apply(proposal.payload, { projectId: quick ? null : active.summary.projectId })
            } else if (proposal.kind === 'appSettings') {
              // App-wide settings: Chat only, applied through the settings path (RunManagerOptions.selfKnowledge).
              if (!active.summary.quick || !this.options.selfKnowledge) throw new Error('App settings can only be changed from Chat.')
              this.options.selfKnowledge.applyAppSettings(proposal.payload)
            } else if (proposal.target) {
              // A stored project's settings changed from Chat: re-resolve the target, settings only, setup untouched.
              if (!active.summary.quick) throw new Error('Only Chat can change another project\'s settings.')
              if (proposal.kind !== 'settings') throw new Error('Only settings proposals can target a project.')
              const target = this.storedProjectFor(proposal.target.projectId)
              if (!target) throw new Error('That project no longer exists.')
              const updated = this.setup.applyProposal(target.id, proposal, { targeted: true })
              this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
            } else if (active.summary.projectId === HARNESS_PROJECT_ID) {
              // The harness project is virtual: its proposals change the MCP library only, never a stored project.
              if (proposal.kind !== 'mcpServers') throw new Error('Only MCP library proposals can be applied here.')
              this.setup.applyLibraryProposal(proposal.payload as McpServersProposalPayload, { ...(active.summary.buildWorkspace ? { buildWorkspace: active.summary.buildWorkspace } : {}), ...secrets })
              waitingForSecrets = this.proposalWaitingForSecrets(null, proposal)
            } else if (active.summary.projectId === SKILLS_PROJECT_ID) {
              // Library-scope Skill assistant: skill proposals change the skill library only.
              if (proposal.kind !== 'skills') throw new Error('Only skill proposals can be applied here.')
              this.setup.applySkillsLibraryProposal(proposal)
            } else if (isVirtualProjectId(active.summary.projectId)) {
              throw new Error('This session has no project to change.')
            } else if (active.summary.kind === 'skill-assist' && proposal.kind !== 'skills') {
              throw new Error('Only skill proposals can be applied in a Skill assistant session.')
            } else {
              // The values are stored before onApplied: a stored secret lets the server start (enabledServers reads the
              // SecretStore live).
              const updated = this.setup.applyProposal(active.summary.projectId, proposal, { projectOnly: active.summary.kind === 'work', ...secrets })
              waitingForSecrets = this.proposalWaitingForSecrets(active.summary.projectId, proposal)
              onApplied?.(updated)
              this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
            }
          } catch (e) {
            // The store refused the values before anything was applied (round 6 item 10): the card keeps waiting for them.
            if (e instanceof ProposalSecretsNotSaved) throw new ProposalKeptOpen(`${e.message}. Nothing was applied; the card is still open.`)
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
      this.cardCreated(active, 'proposal', proposal.id, proposal)
    })
  }

  /**
   * The names of an applied MCP proposal's servers still waiting for a secret value (McpService.storeProposalSecrets
   * without values: the apply already stored what the card carried). Never throws: a failed read names every upserted
   * server with a secret slot, so the outcome never claims a value was saved.
   */
  private proposalWaitingForSecrets(projectId: string | null, proposal: Proposal): string[] | undefined {
    if (proposal.kind !== 'mcpServers' || !this.options.mcp?.storeProposalSecrets) return undefined
    try {
      return this.options.mcp.storeProposalSecrets(projectId, proposal.payload, undefined)
    } catch (e) {
      log.warn(`Could not list the servers waiting for secrets: ${(e as Error).message}`)
      const named = (Array.isArray(proposal.payload.upsert) ? proposal.payload.upsert : [])
        .filter((u) => (u?.secretEnv?.length ?? 0) + (u?.secretHeaders?.length ?? 0) > 0 && typeof u.name === 'string')
        .map((u) => u.name)
      return named.length ? named : undefined
    }
  }

  decideProposal(runId: string, proposalId: string, decision: ProposalDecision, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pendingProposals.get(proposalId)
    if (!active || !pending) return this.decisionMiss(proposalId)
    if (this.staleRevision(pending.proposal.revision, opts)) return { status: 'stale-revision', runId, requestId: proposalId }
    active.pendingProposals.delete(proposalId)
    // The broadcast carries the secret-free outcome (with waitingForSecrets), never decision.secrets.
    let resolved: ProposalOutcome | void
    try {
      resolved = pending.resolve(decision)
    } catch (e) {
      // Not applied and not answered (the vault cannot take the values now): the card stays open for another try.
      if (!(e instanceof ProposalKeptOpen)) throw e
      active.pendingProposals.set(proposalId, pending)
      throw new Error(e.message)
    }
    const outcome = resolved ?? proposalOutcome(cleanProposalDecision(decision))
    // An approval the harness could not apply came back as a revise: say so (applyError).
    const applyError = cleanProposalDecision(decision).behavior === 'approve' && outcome.behavior === 'revise' ? outcome.feedback : undefined
    this.cardResolved(active, 'proposal', proposalId, 'applied', outcome.behavior, opts.decidedBy)
    this.broadcast({ type: 'proposal.resolved', runId, proposalId, decision: outcome, ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}) })
    this.cardSettled(active)
    return { ...applied(runId, proposalId, outcome.behavior, opts), ...(applyError ? { applyError } : {}) }
  }

  private requestQuestion(
    active: ActiveRun,
    req: Omit<UserQuestion, 'id' | 'runId' | 'createdAt'>
  ): Promise<QuestionAnswer> {
    const question: UserQuestion = { ...req, id: newId('q'), runId: active.summary.id, createdAt: Date.now(), revision: 1 }
    return new Promise((resolve) => {
      active.pendingQuestions.set(question.id, { question, resolve })
      this.broadcast({ type: 'question.request', runId: active.summary.id, question })
      this.cardCreated(active, 'question', question.id, question)
    })
  }

  answerQuestion(runId: string, questionId: string, answer: QuestionAnswer, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pendingQuestions.get(questionId)
    if (!active || !pending) return this.decisionMiss(questionId)
    if (this.staleRevision(pending.question.revision, opts)) return { status: 'stale-revision', runId, requestId: questionId }
    active.pendingQuestions.delete(questionId)
    // Only labels that were offered count; a single-choice question keeps the first.
    const labels = new Set(pending.question.options.map((o) => o.label))
    let selected = (Array.isArray(answer?.selected) ? answer.selected : []).filter((l) => typeof l === 'string' && labels.has(l))
    if (!pending.question.allowMultiple) selected = selected.slice(0, 1)
    // The headless policy's conservative answer is text only (decisionPolicy.ts conservativeAnswer), whatever the card allows.
    const textAllowed = pending.question.allowFreeText || opts.decidedBy?.surface === 'policy'
    const text = textAllowed && typeof answer?.text === 'string' && answer.text.trim() ? answer.text.trim() : undefined
    const clean: QuestionAnswer = text ? { selected, text } : { selected }
    this.cardResolved(active, 'question', questionId, 'applied', 'answer', opts.decidedBy)
    pending.resolve(clean)
    this.broadcast({ type: 'question.resolved', runId, questionId, answer: clean, ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}) })
    this.cardSettled(active)
    return applied(runId, questionId, 'answer', opts)
  }

  private requestMergeReview(
    active: ActiveRun,
    req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>
  ): Promise<MergeDecision> {
    const review: MergeReview = { ...req, id: newId('merge'), runId: active.summary.id, createdAt: Date.now(), revision: 1 }
    return new Promise((resolve) => {
      active.pendingMerges.set(review.id, { review, resolve })
      this.broadcast({ type: 'merge.request', runId: active.summary.id, review })
      this.cardCreated(active, 'merge', review.id, review)
    })
  }

  decideMerge(runId: string, reviewId: string, decision: MergeDecision, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pendingMerges.get(reviewId)
    if (!active || !pending) return this.decisionMiss(reviewId)
    if (this.staleRevision(pending.review.revision, opts)) return { status: 'stale-revision', runId, requestId: reviewId }
    active.pendingMerges.delete(reviewId)
    const effective = decision?.behavior === 'merge' || decision?.behavior === 'discard' ? decision.behavior : 'hold'
    this.cardResolved(active, 'merge', reviewId, 'applied', effective, opts.decidedBy)
    pending.resolve(decision)
    this.broadcast({ type: 'merge.resolved', runId, reviewId, decision, ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}) })
    this.cardSettled(active)
    return applied(runId, reviewId, effective, opts)
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
      createdAt: Date.now(),
      revision: 1
    }
    if (!rules.length) return Promise.resolve({ behavior: 'deny', message: 'no valid rules' })
    return new Promise((resolve) => {
      active.pendingRules.set(request.id, { request, resolve })
      this.broadcast({ type: 'rules.request', runId: active.summary.id, request })
      this.cardCreated(active, 'rules', request.id, request)
    })
  }

  /**
   * Answer a request_permission_rules card. A grant is in force before the agent's tool call returns: run
   * scope adds the rules to the run (allowedRules), project scope also saves them to the settings file. The user
   * chose the rules knowingly, so flagged destructive rules are saved too; blanket rules and too-broad shell prefixes
   * (tooBroadRuleRefusal) stay run grants.
   */
  decideRules(runId: string, requestId: string, decision: PermissionRuleDecision, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pendingRules.get(requestId)
    if (!active || !pending) return this.decisionMiss(requestId)
    if (this.staleRevision(pending.request.revision, opts)) return { status: 'stale-revision', runId, requestId }
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
          if (savable.length) addRules(active.rulesTarget ?? active.projectPath, savable)
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
    this.cardResolved(active, 'rules', requestId, 'applied', clean.behavior, opts.decidedBy)
    pending.resolve(clean)
    this.broadcast({ type: 'rules.resolved', runId, requestId, decision: clean, ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}) })
    this.cardSettled(active)
    return applied(runId, requestId, clean.behavior, opts)
  }

  // ---------- MCP install requests ----------

  private requestMcpInstall(
    active: ActiveRun,
    req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>,
    getProject: () => Project,
    setProject: (saved: Project) => void
  ): Promise<McpInstallDecision> {
    const request: McpInstallRequest = { ...req, id: newId('mcpi'), runId: active.summary.id, createdAt: Date.now(), revision: 1 }
    delete request.runOnly
    if (active.summary.quick) {
      // Chat: the server lives in this run only and only the calling agent's role may use it.
      request.runOnly = true
      // An unknown caller (no agent record, no slug) gets nobody rather than the root role.
      const slug = active.record.agents[req.agentId]?.roleSlug
      request.spec = { ...request.spec, roles: slug ? [slug] : [] }
    }
    return new Promise((resolve) => {
      active.pendingInstalls.set(request.id, {
        request,
        resolve: (raw, cancelled, decidedBy) => {
          const decision = this.settleInstall(active, request, raw, getProject(), setProject)
          // Secrets stop here: the agent and the renderer only ever see the outcome.
          const outcome: McpInstallOutcome = {
            approved: decision.approved,
            scope: decision.scope,
            ...(decision.note ? { note: decision.note } : {}),
            ...(decision.spec ? { spec: decision.spec } : {})
          }
          this.broadcast({
            type: 'mcpInstall.resolved',
            runId: active.summary.id,
            requestId: request.id,
            outcome,
            ...(cancelled ? { cancelled: true as const } : {}),
            ...(decidedBy ? { decidedBy } : {})
          })
          resolve(outcome)
          return outcome
        }
      })
      this.broadcast({ type: 'mcpInstall.request', runId: active.summary.id, request })
      this.cardCreated(active, 'mcpInstall', request.id, request)
    })
  }

  /** Validate an install answer and apply it (save the server or keep it for this run). Never throws. */
  private settleInstall(active: ActiveRun, request: McpInstallRequest, raw: McpInstallDecision, project: Project, setProject: (saved: Project) => void): McpInstallDecision {
    // Any quick run: scope 'run' and never persisted, whatever project the run sits on.
    const quickRun = !!active.summary.quick
    const scope = quickRun ? 'run' : raw?.scope === 'project' ? 'project' : raw?.scope === 'library' ? 'library' : 'run'
    const note = typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 600) : undefined
    if (!raw?.approved) return { approved: false, scope, ...(note ? { note } : {}) }
    const refuse = (why: string): McpInstallDecision => ({ approved: false, scope, note: `The harness did not install it: ${why}` })
    if (isVirtualProjectId(project.id) && !quickRun) return refuse('installs are not available in this session; propose library entries instead.')
    if (raw.spec !== undefined && (!raw.spec || typeof raw.spec !== 'object' || raw.spec.id !== request.spec.id)) return refuse('the edited server must keep the requested id.')
    const id = request.spec.id
    const taken =
      (project.mcpServers ?? []).some((s) => s.id === id) ||
      active.runServers.has(id) ||
      !!this.options.mcp?.libraryEntries?.().some((e) => e.id === id)
    if (taken) return refuse('a server with that id already exists.')
    const spec = mergeInstallEdit(request.spec, raw.spec)
    if (quickRun) spec.roles = [...(request.spec.roles ?? [])]
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
  answerMcpInstall(runId: string, requestId: string, decision: McpInstallDecision, opts: DecisionOptions = {}): DecisionOutcome {
    const active = this.runs.get(runId)
    const pending = active?.pendingInstalls.get(requestId)
    if (!active || !pending) return this.decisionMiss(requestId)
    if (this.staleRevision(pending.request.revision, opts)) return { status: 'stale-revision', runId, requestId }
    active.pendingInstalls.delete(requestId)
    // The install's own resolve validates and applies it; the outcome says whether it was really installed.
    const outcome = pending.resolve(decision, false, opts.decidedBy)
    const effective = (outcome ? outcome.approved : !!decision?.approved) ? 'approve' : 'deny'
    this.cardResolved(active, 'mcpInstall', requestId, 'applied', effective, opts.decidedBy)
    this.cardSettled(active)
    return applied(runId, requestId, effective, opts)
  }

  /**
   * runs:findDecision: which live run holds the pending card `requestId` (its kind and revision), or how a recently
   * resolved one ended (tombstones, at most DECISION_TOMBSTONES_MAX), else 'not-found'.
   */
  findDecision(requestId: string): DecisionLookup {
    const indexed = this.decisions.lookup(requestId)
    if (indexed.status !== 'not-found') return indexed
    for (const active of this.runs.values()) {
      const hit = findPendingCard(active, requestId)
      if (hit) {
        return {
          status: 'pending',
          requestId,
          runId: active.summary.id,
          projectId: active.summary.projectId,
          kind: hit.kind,
          revision: hit.revision ?? 1
        }
      }
    }
    return { status: 'not-found', requestId }
  }

  async switchModel(input: SwitchRunModelInput): Promise<SwitchRunModelResult> {
    this.refuseWhileQuitting()
    if (!input || typeof input.runId !== 'string' || typeof input.model !== 'string' || !input.model || input.model.length > 200 || input.model.trim() !== input.model || /[\x00-\x1f\x7f]/.test(input.model)) throw new Error('Invalid model selection')
    if (input.expectedRunId !== undefined && !isValidId(input.expectedRunId)) throw new Error('Invalid expected run id')
    let run = this.summary(input.runId)
    if (!run) throw new Error('Run not found')
    run = this.chainOf(run).reduce((latest, item) => item.startedAt > latest.startedAt || (item.startedAt === latest.startedAt && item.resumedFrom === latest.id) ? item : latest, run)
    if (input.expectedRunId !== undefined && run.id !== input.expectedRunId) return { run, applied: false, reason: 'The conversation has continued; select the model again.' }
    const connection = input.connection ?? run.modelSelection?.connection ?? run.connection
    if (!connection) throw new Error('Connection is required')
    const model = (this.options.catalog?.() ?? []).find((m) => m.connection === connection && m.id === input.model)
    if (!model) throw new Error('Model is not available on this connection')
    const active = this.runs.get(run.id)
    if (active && (connection !== run.connection || (active.adapter !== 'mock' && model.adapter !== active.adapter)) && !['finished', 'error', 'paused'].includes(run.status)) return { run, applied: false, reason: 'End this session, then select the model and send a message to continue with a transcript handoff.' }
    const selection = { model: input.model, connection }
    if (active && !['finished', 'error', 'paused'].includes(run.status)) {
      if (active.execBudget !== undefined && active.chainPriorCostUsd + (run.usage?.costUsd ?? run.totalCostUsd) >= active.execBudget) return { run, applied: false, reason: 'The conversation budget is spent; switching models does not reset it.' }
      if (active.execBudget !== undefined && !run.overrides?.allowUnpricedBudget && active.modelPriced && !active.modelPriced(input.model)) {
        return { run, applied: false, reason: 'This model has no known price, so the budget cannot be enforced.' }
      }
      if (!active.session?.switchModel) return { run, applied: false, reason: 'This session cannot switch models.' }
      try { await active.session.switchModel({ model: input.model }) }
      catch (error) { return { run: this.summary(run.id) ?? run, applied: false, reason: (error as Error).message } }
      const root = active.ctx?.roles.find((r) => r.reportsTo === null) ?? active.ctx?.roles[0]
      if (root) root.model = input.model
      active.priceChecked.clear()
    }
    const updated = this.patchSummary(run.id, { modelSelection: selection })!
    this.broadcast({ type: 'run.model', runId: run.id, selection })
    return { run: updated, applied: !active || ['finished', 'error', 'paused'].includes(run.status) ? false : true, ...(!active || ['finished', 'error', 'paused'].includes(run.status) ? { reason: 'Model will be used when the run continues.' } : {}) }
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
    // A bridged report works for the delegating agent, not for the user's next message: an interrupt ends it.
    await active?.bridge?.stopAll('the user interrupted the run')
    await active?.session?.interrupt()
  }

  async stop(runId: string): Promise<void> {
    const active = this.runs.get(runId)
    if (!active) return this.stopPaused(runId)
    const st = active.summary.status
    if (st === 'finished' || st === 'error') return
    // A headless exec run ends through its finalizer (outcome 'interrupted', endedBy 'user'); an outcome already
    // claimed (budget, policy, completion) stands.
    if (active.summary.overrides?.execMode) return this.finalizeExecRun(runId, 'interrupted', { endedBy: 'user' })
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

  /**
   * End a paused run that has no live session (it left `runs` when its session finished; only its resume timer may be
   * left): the auto-resume is cancelled and the run is finished as ended by the user. An exec run still waiting for its
   * reset (no execOutcome yet) is finalized as 'interrupted' (cli-spec 6.2(3)), so its follower gets run.finalized.
   */
  private stopPaused(runId: string): void {
    const s = this.store.get(runId)
    if (!s || s.status !== 'paused') return
    this.clearResume(runId)
    const exec = !!s.overrides?.execMode && !s.execOutcome
    const done = this.patchSummary(runId, { status: 'finished', autoResume: false, endedBy: 'user', ...(exec ? { execOutcome: 'interrupted' as const } : {}) })
    if (!done) return
    this.broadcast(withEndFacts({ type: 'run.status', runId, status: 'finished', pausedUntil: done.pausedUntil, pauseReason: done.pauseReason, autoResume: false }, done))
    if (exec) this.broadcastFinalized(done, 'interrupted')
  }

  /**
   * A paused exec run of a waitForReset chain that will no longer resume by itself (no timer: an adapter's autoResume
   * false, a resume that failed, Cancel auto-resume) is finalized as 'rate-limited', so its follower never waits
   * forever. A live run goes through the finalizer; a stored one is patched and run.finalized broadcast. Idempotent.
   */
  private finalizeStrandedExec(runId: string): void {
    if (this.resumeTimers.has(runId)) return
    const a = this.runs.get(runId)
    if (a) {
      const o = a.summary.overrides
      if (o?.execMode && o.waitForReset && a.summary.status === 'paused') void this.finalizeExecRun(runId, 'rate-limited')
      return
    }
    const s = this.store.get(runId)
    if (!s?.overrides?.execMode || !s.overrides.waitForReset || s.execOutcome || s.status !== 'paused') return
    const done = this.patchSummary(runId, { execOutcome: 'rate-limited', autoResume: false })
    if (done) this.broadcastFinalized(done, 'rate-limited')
  }

  private broadcastFinalized(s: RunSummary, outcome: ExecOutcome): void {
    this.broadcast({ type: 'run.finalized', runId: s.id, ...(s.overrides?.execChainId ? { execChainId: s.overrides.execChainId } : {}), outcome, summary: { ...s } })
  }

  /** The run's session.stop(), one call at a time (End session, quit and a late start share it; a failed stop can be retried). */
  private stopSession(r: ActiveRun): Promise<void> | undefined {
    if (!r.session) return undefined
    if (r.stopCall) return r.stopCall
    // Bridged children go first (their spawns resolve "Stopped"); the root's stop starts in the same tick.
    const children = r.bridge?.hasActive() ? r.bridge.stopAll(r.endedBy === 'app' ? 'OrgAI is closing' : 'the run was stopped') : undefined
    const root = r.session.stop()
    const call = children ? Promise.all([children, root]).then(() => undefined) : root
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
    // A headless exec run cut before its finalizer finished (best effort): its claimed outcome, else 'interrupted'.
    const execCut = !!s.overrides?.execMode && !r.finalizedSent && (forced || s.status === 'finished' || s.status === 'error' || s.status === 'paused')
    if (execCut) s.execOutcome ??= r.finalOutcome ?? 'interrupted'
    try {
      this.store.upsert(s)
    } catch (e) {
      console.error('Failed to persist run summary:', e)
    }
    this.flush(r)
    // The session never reported its end: tell the renderer it is finished, and who cut it.
    if (forced) this.broadcast(withEndFacts({ type: 'run.status', runId: s.id, status: 'finished' }, s))
    if (execCut && s.execOutcome) {
      r.finalizedSent = true
      this.broadcast({ type: 'run.finalized', runId: s.id, ...(s.overrides?.execChainId ? { execChainId: s.overrides.execChainId } : {}), outcome: s.execOutcome, summary: { ...s } })
    }
  }

  /**
   * The app is quitting and will not wait any longer (the shutdown's forced drain, activity.ts: the deadline passed, stopAll failed, or a
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
  async continueRun(project: Project, fromRunId: string, text: string, rawImages?: ImageAttachment[], opts: ContinueRunOptions = {}): Promise<RunSummary> {
    this.refuseWhileQuitting()
    const from = this.summary(fromRunId)
    if (!from) throw new Error('Run not found')
    if (from.projectId !== project.id) throw new Error('Run belongs to another project')
    if (from.status !== 'finished' && from.status !== 'error' && from.status !== 'paused') throw new Error('Run is still active; send a message instead')
    if (!from.sessionId && !from.modelSelection) throw new Error('This run has no session to continue')
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
      .filter((r) => (r.sessionId || r.modelSelection) && (r.status === 'finished' || r.status === 'error' || r.status === 'paused'))
      .reduce((best, r) => (r.startedAt > best.startedAt || (r.startedAt === best.startedAt && r.resumedFrom === best.id) ? r : best), from)
    const sessionId = target.sessionId ?? from.sessionId

    const selectedAdapter = this.options.catalog?.().find((m) => m.id === target.modelSelection?.model && m.connection === target.modelSelection?.connection)?.adapter
    const switching = target.modelSelection && (!target.sessionId || target.modelSelection.connection !== target.connection || (selectedAdapter && selectedAdapter !== (target.modelAdapter ?? project.provider.id) && (target.modelAdapter ?? project.provider.id) !== 'mock'))
    const overrides = continuedOverrides(target.overrides ?? from.overrides, switching ? { ...opts, exec: !!target.overrides?.execMode } : opts, project)
    // A new provider session must not regain the conversation's already spent desktop budget.
    let carriedBudget = target.conversationBudgetUsd
    if ((switching || carriedBudget !== undefined) && !overrides?.execMode) {
      // A carried override is already the remaining allowance, whereas the stored conversation cap and the
      // current project cap describe total spend. Never subtract the chain from a remaining allowance twice.
      const spent = chain.reduce((sum, r) => sum + Math.max(0, r.usage?.costUsd ?? r.totalCostUsd), 0)
      // An explicit continuation override is a new remaining allowance, unlike a carried original total.
      const requestedCap = carriedBudget !== undefined && opts.overrides?.maxBudgetUsd !== undefined
        ? spent + opts.overrides.maxBudgetUsd : Infinity
      const cap = Math.min(carriedBudget ?? overrides?.maxBudgetUsd ?? Infinity, projectBudgetUsd(project) ?? Infinity, requestedCap)
      if (Number.isFinite(cap)) {
        if (spent >= cap) throw new Error('The conversation budget is spent; switching models does not reset it.')
        project = { ...project, maxBudgetUsd: cap - spent }
        if (overrides?.maxBudgetUsd !== undefined) overrides.maxBudgetUsd = cap - spent
        carriedBudget = cap
      }
    }
    // A paused run is handed over to its continuation; it stays in history as finished. An exec run still waiting for
    // its reset (no execOutcome) whose continuation is not an exec run (the Desktop composer, `orgai resume` without
    // --exec) is finalized as 'interrupted' by the user, so its `orgai exec` follower ends instead of adopting the
    // desktop continuation (which never sends run.finalized) and waiting forever.
    const handedToExec = !!overrides?.execMode
    // The per-run choices of the run being continued (docs: StartRunInput.effort / permissionMode). The effort goes on
    // as is (start() drops it with a warning where the adapter cannot take it). A chosen permission mode is carried
    // when it narrows the project's current mode, or the desktop user / the resume timer / a 'configure' caller is
    // continuing; otherwise the project's mode applies and the new run says so.
    const carried: CarriedChoices = {}
    if (target.rootEffort && isEffort(target.rootEffort)) carried.rootEffort = target.rootEffort
    if (target.permissionModeChosen && target.permissionMode && isPermissionMode(target.permissionMode) && !handedToExec) {
      const chosenMode = target.permissionMode
      const allowed = runPermissionModeChoices(target).includes(chosenMode)
      const trusted = opts.desktop === true || opts[AUTO_RESUME] === true || opts.allowWidening === true
      if (allowed && (trusted || canNarrowPermissionMode(project.permissionMode, chosenMode))) carried.permissionMode = chosenMode
      else carried.logs = [{ level: 'info', message: "The per-run permission mode was not carried; the project's mode applies." }]
    }
    for (const r of target.id === from.id ? [from] : [target, from]) {
      if (r.status !== 'paused') continue
      this.clearResume(r.id)
      const strand = !!r.overrides?.execMode && !r.execOutcome && !handedToExec
      const done = this.patchSummary(r.id, { status: 'finished', autoResume: false, ...(strand ? { execOutcome: 'interrupted' as const, endedBy: 'user' as const } : {}) })
      if (!done) continue
      this.broadcast(withEndFacts({ type: 'run.status', runId: done.id, status: 'finished', pausedUntil: done.pausedUntil, pauseReason: done.pauseReason, autoResume: false }, done))
      if (strand) this.broadcastFinalized(done, 'interrupted')
    }
    return this.start({
      project,
      prompt,
      images,
      kind: target.kind,
      ...(overrides ? { overrides } : {}),
      ...(opts.allowWidening ? { allowWidening: true } : {}),
      ...(carried.rootEffort || carried.permissionMode || carried.logs ? { [CARRIED_CHOICES]: carried } : {}),
      // The harness's own resume message is not a new task: keep the title of the run it continues.
      // A follow-up is titled with the task it continues as context, so it stays recognisable.
      ...(prompt === RESUME_TEXT.trim() && target.title
        ? { title: target.title }
        : { titleContext: target.title ?? excerpt(target.prompt, 200) }),
      hiddenContext: [target.kind === 'setup' ? this.setup.hiddenContext(project) : '', switching ? modelHandoff(chain.map((r) => this.get(r.id)).filter((r): r is RunRecord => !!r)) : ''].filter(Boolean).join('\n\n') || undefined,
      // A Team-tray Architect session stays in the Team tray when it is continued or auto-resumed.
      ...(target.surface ? { surface: target.surface } : {}),
      // A Chat run keeps its folder and settings; an MCP build session reopens in the same workspace.
      ...(target.quick ? { quick: target.quick } : {}),
      ...(target.buildWorkspace ? { buildWorkspace: target.buildWorkspace } : {}),
      ...(target.team === 'single' ? { team: target.team } : {}),
      ...(opts[SCHEDULED_RESUME] ? { schedule: { ...opts[SCHEDULED_RESUME] } } : {}),
      resumeSessionId: switching ? undefined : sessionId,
      ...(target.modelSelection ? { modelSelection: target.modelSelection } : {}),
      ...(carriedBudget !== undefined ? { conversationBudgetUsd: carriedBudget } : {}),
      resumedFrom: target.id,
      // totalCostUsd may be a computed cost; only the provider's own total is subtracted from the next provider total.
      // On a proxy project the adapter total was a proxy estimate (older records may carry it as providerCostUsd): no base.
      resumeBaseCostUsd: !isBuiltinConnectionId(projectConnection(project)) ? 0 : target.usage ? (target.usage.providerCostUsd ?? 0) : target.totalCostUsd,
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
    this.clearResumeTimer(runId)
    // No auto-resume is armed while the app quits (resumeNow would refuse); the boot normalization ends the pause.
    if (this.quitting) return
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      // Activity lease (cli-spec 3.2(4)): taken BEFORE the timer entry goes, so a host never sees neither a timer, an
      // in-flight resume nor a live run. The timer path calls resumeUnleased (the lease is already held here) and
      // drops the lease once, after the error handling below, when the resume settles.
      this.withResumeLease(() => {
        this.resumeTimers.delete(runId)
        return this.resumeUnleased(runId, { auto: true }).then(
          () => undefined,
          (err: unknown) => {
            const message = `Could not resume the paused run: ${(err as Error).message}`
            this.broadcast({ type: 'log', runId, level: 'error', message })
            const s = this.patchSummary(runId, { autoResume: false })
            if (s) this.broadcast({ type: 'run.status', runId, status: s.status, pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, autoResume: false })
            this.finalizeStrandedExec(runId)
          }
        )
      }).catch((err: unknown) => log.warn(`Run ${runId}: auto-resume failed: ${(err as Error)?.message ?? err}`))
    }, delay)
    this.resumeTimers.set(runId, timer)
  }

  private clearResumeTimer(runId: string): void {
    const t = this.resumeTimers.get(runId)
    if (t) clearTimeout(t)
    this.resumeTimers.delete(runId)
  }

  /** Cancel a run's auto-resume: its timer and the widening grant that only that resume may use. */
  private clearResume(runId: string): void {
    this.clearResumeTimer(runId)
    this.widenedRuns.delete(runId)
  }

  /** Activity (pausedAutoResumes): auto-resume timers still armed. */
  activeResumeTimerCount(): number { return this.resumeTimers.size }

  /** Activity (pausedAutoResumes): auto-resumes whose timer fired and whose successor run is not registered yet. */
  inFlightResumeCount(): number { return this.resumesInFlight }

  /** Activity (backgroundTasks): pending run-title queries, live run or not. */
  titleTaskCount(): number { return this.titleAborts.size }

  /** Activity (backgroundTasks): post-run evolve passes still running (they write the team and the ledger). */
  evolvePassCount(): number { return this.evolvePassesInFlight }

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

  /**
   * Hold one in-flight resume lease (inFlightResumeCount) while fn runs: taken before fn is called, dropped exactly
   * once when its promise settles, or at once when fn throws synchronously. continueRun -> start() registers the
   * successor ActiveRun in `this.runs` before its first await, so by the time the lease drops the successor is live.
   */
  private withResumeLease<T>(fn: () => Promise<T>): Promise<T> {
    this.resumesInFlight++
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.resumesInFlight--
    }
    let p: Promise<T>
    try {
      p = fn()
    } catch (e) {
      release()
      return Promise.reject(e)
    }
    return p.finally(release)
  }

  /**
   * Continue a paused run now, with the harness's resume message. A manual resume (Desktop or RPC) holds its own
   * resume lease across the async setup.prepare gap; the timer path takes the lease itself and calls resumeUnleased.
   */
  resumeNow(runId: string, opts: { desktop?: true } = {}): Promise<RunSummary> {
    return this.withResumeLease(() => this.resumeUnleased(runId, opts.desktop ? { desktop: true } : {}))
  }

  /**
   * runs:setPermissionMode (the desktop window and the in-process TUI holding 'configure' only; the dispatcher refuses
   * socket clients, so no peer, harness tool or agent can reach it; both user surfaces confirm a widening first). Contract: SetRunPermissionModeInput / SetRunPermissionModeResult. The desktop user owns the run, so
   * narrowing and widening are treated alike; everything else is checked here. A refusal changes nothing, with one
   * exception: when the session applied `mode` twice and an "accept edits" grant landed after each, the session really
   * runs `mode` under the grant, so chosenMode, permissionModeChosen and the overlay record that (applied: false, with the
   * reports-unchanged count).
   */
  async setPermissionMode(input: SetRunPermissionModeInput): Promise<SetRunPermissionModeResult> {
    this.refuseWhileQuitting()
    if (!input || typeof input !== 'object' || typeof input.runId !== 'string' || !isPermissionMode(input.mode)) throw new Error('Invalid permission mode')
    const mode = input.mode
    let run = this.summary(input.runId)
    if (!run) throw new Error('Run not found')
    // The conversation's newest run, like switchModel: a stale id of an older run in the chain lands on the live one.
    run = this.chainOf(run).reduce((latest, item) => item.startedAt > latest.startedAt || (item.startedAt === latest.startedAt && item.resumedFrom === latest.id) ? item : latest, run)
    if (run.overrides?.execMode) throw new Error('Exec runs keep the mode they started with.')
    const choices = runPermissionModeChoices(run)
    if (!choices.length) throw new Error('This run keeps its own permission mode.')
    if (!choices.includes(mode)) throw new Error('This run cannot use that permission mode.')
    const active = this.runs.get(run.id)
    // Ended or paused: saved for the continuation (continueRun reads permissionMode / permissionModeChosen).
    if (!active || run.status === 'finished' || run.status === 'error' || run.status === 'paused') {
      const saved = this.patchSummary(run.id, { permissionMode: mode, permissionModeChosen: true }) ?? run
      this.broadcast({ type: 'run.permissionMode', runId: run.id, permissionMode: mode, permissionModeChosen: true })
      return { run: saved, applied: false, reason: 'The mode will be used when the run continues.' }
    }
    const session = active.session
    const ctx = active.ctx
    if (!session?.setPermissionMode || !ctx) {
      return { run, applied: false, reason: 'This session cannot change its permission mode while it runs. End the session, then choose the mode before you continue.' }
    }
    // Serialized per run (review M2): a second change while one waits on the session is refused, nothing changes.
    if (active.permissionModeChanging) return { run, applied: false, reason: 'Another permission mode change for this run is still in progress. Try again in a moment.' }
    active.permissionModeChanging = true
    try {
      // Review L3: a narrowing is in force on ctx.project before the session answers (no call slips through under the
      // old, wider mode); a widening only after the session applied it (no call is allowed under a mode that never
      // took effect). The adapter derives its mapping from `mode` itself. chosenMode keeps setLive from undoing it. The
      // adapter drops its own "accept edits" grant on any applied change below acceptEdits (contract), so the overlay
      // goes with a narrowing too, and comes back if the session refuses.
      const previousChosen = active.chosenMode
      const previousGrant = active.acceptEditsGrant
      const narrows = canNarrowPermissionMode(ctx.project.permissionMode, mode)
      if (narrows) {
        active.chosenMode = mode
        delete active.acceptEditsGrant
        this.rederiveRunMode(active)
      }
      let applied = false
      let reportsUnchanged = 0
      let refusalReason: string | undefined
      // Review L-a: a grant followed while the change awaited may reach the provider after it. That matters for every
      // mode below acceptEdits (the adapter drops its grant there, re-check Low 1b), so such a change is sent once more
      // to be the last word. Applied twice yet raced twice: refused (Low 1c, below).
      const raceable = overlaidByAcceptEdits(mode)
      let raced = false
      for (let attempt = 0; attempt < (raceable ? 2 : 1) && !applied; attempt++) {
        const gen = active.modeGen ?? 0
        try {
          const answer = await session.setPermissionMode(mode)
          if (answer === true || (answer && typeof answer === 'object' && answer.applied === true)) {
            const n = typeof answer === 'object' ? answer.reportsUnchanged : 0
            reportsUnchanged = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
            raced = raceable && (active.modeGen ?? 0) !== gen
            applied = !raced
          } else break
        } catch (e) {
          // Review L2: a provider / SDK message is logged, never shown; the user gets a fixed plain sentence.
          if (e instanceof PermissionModeRefusal) {
            // A typed, opt-in refusal: OrgAI-written plain text, bounded and cleaned, is the reason.
            // eslint-disable-next-line no-control-regex
            const clean = e.message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
            if (clean) refusalReason = clean
          } else {
            log.warn(`Run ${run.id}: the session refused a permission mode change (${(e as Error)?.message ?? String(e)})`)
          }
          break
        }
      }
      if (!applied && raced) {
        // Re-check Low 1c: the session applied `mode` but a grant landed after it each time. The session's own mode is
        // `mode` (never the earlier, possibly wider choice) with the grant on top, which the overlay shows.
        active.chosenMode = mode
        active.acceptEditsGrant = true
        active.summary.permissionModeChosen = true
        // Re-derive first, then one broadcast (forced: permissionModeChosen moved before the derivation).
        this.rederiveRunMode(active, active.ctx, true)
        // The session did apply `mode`, so the reports it could not change are counted like on an applied change.
        reportsUnchanged += active.bridge?.liveWiderThan(mode) ?? 0
        const note = reportsUnchanged ? reportsUnchangedText(reportsUnchanged) : ''
        return {
          run: this.summary(run.id) ?? run,
          applied: false,
          reason: `An "accept edits" permission was granted during the change. Choose the mode again.${note ? ` ${note}` : ''}`,
          ...(reportsUnchanged ? { reportsUnchanged } : {})
        }
      }
      if (!applied) {
        // Back to the earlier choice (unless something else replaced ours meanwhile) and the earlier grant (a grant that
        // landed during the await set it itself), then re-derived from the live project as it is now (an approval may
        // have landed during the await); the summary follows.
        if (narrows && active.chosenMode === mode) {
          if (previousChosen) active.chosenMode = previousChosen
          else delete active.chosenMode
        }
        if (previousGrant) active.acceptEditsGrant = true
        this.rederiveRunMode(active)
        return { run: this.summary(run.id) ?? run, applied: false, reason: refusalReason ?? 'The session could not change its permission mode now.' }
      }
      active.chosenMode = mode
      delete active.acceptEditsGrant
      if (!active.summary.permissionModeChosen) {
        active.summary.permissionModeChosen = true
        this.store.upsert(active.summary)
        this.broadcastRunMode(active)
      }
      this.rederiveRunMode(active)
      // Bridged children are separate sessions that keep the mode they started in (they never take this change). Counted
      // on every change, not only on a matrix narrowing: modes the matrix cannot compare (dontAsk to default) still leave
      // a child wider than `mode` (liveWiderThan is 0 when none is).
      reportsUnchanged += active.bridge?.liveWiderThan(mode) ?? 0
      const updated = this.summary(run.id) ?? run
      const label = PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode
      const note = reportsUnchanged ? reportsUnchangedText(reportsUnchanged) : ''
      active.emit({ type: 'log', runId: run.id, level: 'info', message: `Permission mode set to ${label} for this run.${note ? ` ${note}` : ''}` })
      return { run: updated, applied: true, ...(reportsUnchanged ? { reportsUnchanged, reason: note } : {}) }
    } finally {
      delete active.permissionModeChanging
    }
  }

  /**
   * resumeNow's body, without the activity lease (the caller holds it). `auto` is the timer path only: a manual
   * Resume now (Desktop or RPC) never re-applies a 'configure' caller's widening. `desktop` (the desktop's Resume now,
   * and the timer, which acts for the desktop user) lets a per-run permission mode the user chose carry over.
   */
  private async resumeUnleased(runId: string, opts: { auto?: boolean; desktop?: true } = {}): Promise<RunSummary> {
    const widened = opts.auto === true && this.widenedRuns.has(runId)
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
      // A waitForReset exec chain still in flight (no execOutcome: its follower waits) keeps its exec fields, on the
      // timer or an early Resume now. A finalized exec run (e.g. 'rate-limited', its client gone) resumed by hand
      // continues as a desktop run, with the exec fields stripped (cli-spec 6.2(1)).
      // A chain a 'configure' caller widened stays widened across its own automatic resume only.
      const o = from.overrides
      const keepExec = !!o?.execMode && !!o.waitForReset && !from.execOutcome
      // Schedules (review L1): only the timer's resume of a scheduled run stays the schedule's.
      const scheduled = opts.auto === true && from.scheduleId ? { [SCHEDULED_RESUME]: { id: from.scheduleId, name: from.scheduleName ?? '' } } : {}
      return await (keepExec
        ? this.continueRun(project, runId, RESUME_TEXT, undefined, { [AUTO_RESUME]: true, ...(widened ? { allowWidening: true } : {}), ...scheduled })
        : opts.desktop || opts.auto
          ? this.continueRun(project, runId, RESUME_TEXT, undefined, { desktop: true, ...scheduled })
          : this.continueRun(project, runId, RESUME_TEXT))
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
      // A waitForReset exec chain will not resume now: it ends 'rate-limited' (its follower would wait forever).
      this.finalizeStrandedExec(runId)
    }
  }
}
