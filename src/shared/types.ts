/**
 * Shared domain types used by the main process, preload bridge and renderer.
 * Everything that crosses IPC is defined here.
 */

// ---------- Providers ----------

/** 'mock' is a scripted, token-free adapter for UI work and tests; registered only with ORGAI_MOCK=1. */
export type ProviderId = 'claude' | 'mock'

/** How a role authenticates with its provider. */
export type ProviderAuth =
  | { kind: 'subscription' } // e.g. Claude Code login
  | { kind: 'apiKey'; envVar: string } // read from the named environment variable at run time

export interface ProviderConfig {
  id: ProviderId
  label: string
  auth: ProviderAuth
}

/** Model choices are provider-scoped aliases or full model IDs. */
export type ModelRef = string

export const CLAUDE_MODEL_OPTIONS: { value: ModelRef; label: string; hint: string }[] = [
  { value: 'inherit', label: 'Inherit from parent', hint: 'Uses whatever model spawned this agent' },
  { value: 'fable', label: 'Fable', hint: 'Most capable, highest cost' },
  { value: 'opus', label: 'Opus', hint: 'Deep reasoning, orchestration, architecture' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Fast and capable, everyday coding' },
  { value: 'haiku', label: 'Haiku', hint: 'Cheap and quick, lookups and summaries' }
]

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------- Tools ----------

export const TOOL_CATALOG = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Bash',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'NotebookEdit'
] as const
export type ToolName = (typeof TOOL_CATALOG)[number]

/** The tool name that spawns subagents in the Claude Agent SDK. Granted implicitly by `canSpawn`. */
export const SPAWN_TOOL = 'Agent'

// ---------- Org chart ----------

export interface Role {
  id: string
  /** Stable slug used as the subagent_type, e.g. "backend-engineer". */
  slug: string
  name: string
  /** One-line "when to use" description shown to the parent agent. */
  description: string
  responsibilities: string[]
  /** System prompt body. */
  prompt: string
  tools: ToolName[]
  model: ModelRef
  effort?: Effort
  /** May this role create subagents at all? */
  canSpawn: boolean
  /** Which role ids this role may spawn. Enforced by the harness. */
  spawnable: string[]
  /** Parent in the org chart. null for the root orchestrator. */
  reportsTo: string | null
  /** Editor canvas position. */
  position: { x: number; y: number }
  /** Accent color for the node. */
  color: string
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface Project {
  id: string
  name: string
  /** Working directory the agents operate in. */
  path: string
  /** Free text describing the project and the kind of work done in it. Feeds the AI drafter. */
  brief: string
  provider: ProviderConfig
  permissionMode: PermissionMode
  /** Hard spend cap per run in USD. undefined = no cap. */
  maxBudgetUsd?: number
  maxSubagentDepth: number
  maxConcurrentSubagents: number
  /**
   * Run reports that can edit files in their own git worktree, and merge each report back
   * when it finishes. Needs a git repository; silently off otherwise. Default true.
   */
  isolateWriters?: boolean
  /**
   * With isolateWriters: pause before merging each report's branch and show its diff to the user,
   * who merges, discards or holds it. Default false (merge automatically).
   */
  reviewMerges?: boolean
  /** Runs to keep on disk for this project; older ones are deleted. Default DEFAULT_KEEP_RUNS. */
  keepRuns?: number
  /**
   * Subscription plans: percent of the five-hour usage window one run may consume before the harness
   * interrupts it (a soft stop the user can continue from). undefined = off.
   */
  maxWindowShare?: number
  /**
   * Subscription plans: spawn new Opus reports on Sonnet while the Opus weekly window (or the
   * seven-day window when the plan has no per-model one) is at or above the app's opusGuardThreshold.
   */
  preferSonnetNearLimit?: boolean
  roles: Role[]
  /** AI-driven setup state. Missing on projects created before setup existed. */
  setup?: ProjectSetup
  createdAt: string
  updatedAt: string
}

// ---------- App settings (global) ----------

/** Global defaults applied to new projects, plus app-wide auth. Persisted as settings.json in the data dir. */
export interface AppSettings {
  defaultPermissionMode: PermissionMode
  /** undefined = no cap. */
  defaultMaxBudgetUsd?: number
  defaultKeepRuns: number
  defaultIsolateWriters: boolean
  defaultRootModel: ModelRef
  defaultReportModel: ModelRef
  providerAuth: ProviderAuth
  notifications?: boolean
  /** Weekly-window utilization (percent) above which projects that prefer Sonnet steer Opus spawns to Sonnet. */
  opusGuardThreshold: number
  /** preferSonnetNearLimit for new projects. */
  defaultPreferSonnetNearLimit: boolean
}

/** What settings:get returns: the settings plus read-only facts about the install. */
export type AppSettingsInfo = AppSettings & { dataDir: string }

/** Result of auth:status, shown as the sidebar pill. */
export interface AuthStatusResult {
  loggedIn: boolean
  method?: string
  detail?: string
  mode: 'subscription' | 'apiKey'
  envVar?: string
  envVarSet?: boolean
}

// ---------- Setup (AI-driven onboarding) ----------

export type SetupKind = 'new' | 'existing'
export type SetupState = 'pending' | 'in_progress' | 'complete'

/** Token-free snapshot of a working directory, gathered by the main process before the Architect runs. */
export interface ProjectProfile {
  scannedAt: string
  exists: boolean
  isEmpty: boolean
  hasGit: boolean
  fileCount: number
  /** Indented directory listing, truncated. */
  tree: string
  languages: { ext: string; files: number }[]
  /** Contents of manifest and documentation files, each truncated. */
  keyFiles: { path: string; content: string }[]
  gitLog: string[]
}

export interface ArchitectureSpec {
  summary: string
  stack: string[]
  modules: { name: string; purpose: string; paths: string[] }[]
  conventions: string[]
  commands: { name: string; command: string }[]
  risks: string[]
}

export interface ProjectSetup {
  kind: SetupKind
  state: SetupState
  profile?: ProjectProfile
  architecture?: ArchitectureSpec
  /** Repo-relative path of the architecture document written on approval. */
  architecturePath?: string
  /** The Architect's closing summary. */
  summary?: string
  completedAt?: string
  /** New projects only: when the scaffold run was started. */
  scaffoldedAt?: string
  /** When an agent last edited the architecture document during a work run. */
  architectureUpdatedAt?: string
}

export interface OrgChartProposalPayload {
  roles: Role[]
  rationale: string
}

export interface SettingsProposalPayload {
  brief?: string
  permissionMode?: PermissionMode
  /** null clears the cap. */
  maxBudgetUsd?: number | null
  maxSubagentDepth?: number
  maxConcurrentSubagents?: number
  isolateWriters?: boolean
  reviewMerges?: boolean
  rationale: string
}

export type ProposalKind = 'architecture' | 'orgChart' | 'settings'

interface ProposalBase {
  id: string
  runId: string
  agentId: string
  title: string
  createdAt: number
}

export type Proposal =
  | (ProposalBase & { kind: 'architecture'; payload: ArchitectureSpec })
  | (ProposalBase & { kind: 'orgChart'; payload: OrgChartProposalPayload })
  | (ProposalBase & { kind: 'settings'; payload: SettingsProposalPayload })

export type ProposalDecision = { behavior: 'approve' } | { behavior: 'revise'; feedback: string }

/** A multiple-choice question the Architect puts to the user during setup (ask_user tool). */
export interface UserQuestion {
  id: string
  runId: string
  agentId: string
  question: string
  options: { label: string; description?: string }[]
  allowMultiple: boolean
  allowFreeText: boolean
  createdAt: number
}

/** The user's answer: chosen option labels plus optional free text. Empty when the run ended unanswered. */
export interface QuestionAnswer {
  selected: string[]
  text?: string
}

// ---------- Runs ----------

export type AgentState =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'waiting' // waiting for a permission decision
  | 'delegating'
  | 'idle' // turn finished, session still open
  | 'done'
  | 'error'

export interface AgentInstance {
  /** Harness id. "root" for the orchestrator, otherwise the SDK agent_id. */
  id: string
  roleId: string | null
  roleSlug: string
  name: string
  parentId: string | null
  /** tool_use id of the Agent call that spawned this instance (null for root). */
  spawnToolUseId: string | null
  state: AgentState
  /** One-line description of what the agent is doing right now. */
  activity: string
  model?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  startedAt: number
  endedAt?: number
  /** Last text the agent produced (truncated for the node card). */
  lastText?: string
  result?: string
  /** Present when the agent works in an isolated git worktree. */
  worktree?: WorktreeInfo
}

export type WorktreeStatus =
  | 'active' // the agent is working in it
  | 'merging' // the harness is committing and merging it
  | 'merged' // merged into its merge target (main checkout or parent's worktree) and removed
  | 'empty' // the report changed nothing; removed
  | 'conflict' // could not merge automatically; branch kept for the orchestrator
  | 'removed' // gone before the harness looked
  | 'review' // waiting for the user to review the diff before merging
  | 'held' // the user chose to hold it; branch kept for later
  | 'waiting-children' // the agent finished; its branch merges after its own isolated reports are integrated

export interface WorktreeInfo {
  path: string
  branch: string
  status: WorktreeStatus
  changedFiles?: string[]
  /** Where the branch merges when the agent finishes. Absent means 'main' (older records). */
  mergeTarget?: 'main' | 'parent'
  /** Nested isolation: the isolated agent that spawned this one; its worktree is the merge target. */
  parentAgentId?: string
  /** Nested isolation: the parent's branch this one was cut from and merges into. */
  parentBranch?: string
}

/** A report branch still sitting in the repository, as shown by the maintenance panel. */
export interface PendingWorktree {
  path: string
  branch: string
  agentId: string
  /** False when the directory is gone but the branch remains. */
  exists: boolean
  uncommittedFiles: number
  commitsAhead: number
  changedFiles: string[]
  lastCommitAt?: number
  lastSubject?: string
}

/** A finished report's branch waiting for the user's review before it is merged. */
export interface MergeReview {
  id: string
  runId: string
  agentId: string
  agentName: string
  branch: string
  path: string
  changedFiles: string[]
  /** Output of git diff --stat. */
  stat: string
  /** Unified diff, truncated when very large. */
  patch: string
  createdAt: number
}

export type MergeDecision = { behavior: 'merge' } | { behavior: 'discard' } | { behavior: 'hold' }

/** A branch's diff against the main checkout, as shown by the maintenance panel. */
export interface WorktreeDiff {
  stat: string
  patch: string
}

export interface MaintenanceResult {
  ok: boolean
  message: string
}

/** How many runs to keep per project when none is set. */
export const DEFAULT_KEEP_RUNS = 100

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'user'; text: string }
  | { kind: 'system'; text: string }

export interface TranscriptEntry {
  id: string
  agentId: string
  at: number
  block: TranscriptBlock
}

/** 'paused': the session ended on a subscription usage limit; it can resume when the window resets. */
export type RunStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'finished' | 'error' | 'paused'

/** 'work' runs the project's org chart; 'setup' runs the built-in Architect that designs it. */
export type RunKind = 'work' | 'setup'

export interface RunSummary {
  id: string
  projectId: string
  kind: RunKind
  prompt: string
  status: RunStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  totalCostUsd: number
  error?: string
  /** Set when this run continues an earlier run's SDK session; the earlier run's id. */
  resumedFrom?: string
  /** Paused runs: when the usage window resets (epoch ms) and the run may continue. */
  pausedUntil?: number
  /** Paused runs: why, in words shown to the user. */
  pauseReason?: string
  /** Paused runs: the harness continues the run at pausedUntil unless the user cancels. */
  autoResume?: boolean
}

/** A finished or live run as persisted on disk: everything needed to redraw it later. */
export interface RunRecord {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  transcript: TranscriptEntry[]
  logs: { at: number; level: 'info' | 'warn' | 'error'; message: string }[]
}

export interface PermissionRequest {
  id: string
  runId: string
  agentId: string
  toolName: string
  input: unknown
  /** Human description built by the harness. */
  summary: string
  /** Rule updates that would stop prompts for matching calls (provider suggestions or harness-derived). */
  suggestions?: PermissionSuggestion[]
  /** Human-readable rules the suggestions grant, e.g. "Bash(npm test:*)". Shown on the card. */
  ruleLabels?: string[]
}

/** How long an allow decision lasts: this call only, the rest of this run, or every future run of the project. */
export type PermissionScope = 'once' | 'session' | 'project'

/** One permission rule: a tool name plus optional content, written as `Tool(content)`. */
export interface PermissionRuleSpec {
  toolName: string
  ruleContent?: string
}

/** Structured-clone-safe copy of a provider permission update (the Claude SDK's PermissionUpdate). */
export type PermissionSuggestion =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: PermissionRuleSpec[]
      behavior: 'allow' | 'deny' | 'ask'
      destination: string
    }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: string }
  | { type: 'setMode'; mode: string; destination: string }

export type PermissionDecision = { behavior: 'allow'; scope?: PermissionScope } | { behavior: 'deny'; message: string }

// ---------- Subscription usage ----------

/** One plan usage window. */
export interface RateLimitWindow {
  /** Percent of the window used, 0-100. null when the provider did not say. */
  utilization: number | null
  /** When the window resets, epoch ms. */
  resetsAt: number | null
}

/** A per-model weekly window the plan reports by display name (e.g. "Fable"). */
export interface ModelRateLimitWindow extends RateLimitWindow {
  model: string
}

/** The plan limits that constrain a subscription login, as last reported by the provider. */
export interface UsageStatus {
  authMode: 'subscription' | 'apiKey' | 'unknown'
  /** e.g. 'pro', 'max'; null for API keys or when unknown. */
  subscriptionType: string | null
  /** Plan windows were reported. False for API keys and before the first report. */
  available: boolean
  windows: {
    fiveHour?: RateLimitWindow
    sevenDay?: RateLimitWindow
    sevenDayOpus?: RateLimitWindow
    sevenDaySonnet?: RateLimitWindow
  }
  /** Other per-model weekly windows reported by name. */
  modelWindows?: ModelRateLimitWindow[]
  /** Latest rate-limit status from a live request. */
  status?: 'allowed' | 'allowed_warning' | 'rejected'
  /** The window that is limiting (provider name, e.g. 'five_hour'). */
  limitedWindow?: string
  /** While rejected: when requests are allowed again, epoch ms. */
  limitedUntil?: number
  overageInUse?: boolean
  updatedAt: number
}

// ---------- Run events (main -> renderer) ----------

export type RunEvent =
  | {
      type: 'run.status'
      runId: string
      status: RunStatus
      sessionId?: string
      error?: string
      /** status 'paused' (and later updates to a paused run). */
      pausedUntil?: number
      pauseReason?: string
      autoResume?: boolean
    }
  | { type: 'agent.upsert'; runId: string; agent: AgentInstance }
  | { type: 'agent.remove'; runId: string; agentId: string }
  | { type: 'transcript'; runId: string; entry: TranscriptEntry }
  /** Text the agent is streaming right now; '' clears it once the completed message lands. Never persisted. */
  | { type: 'agent.partial'; runId: string; agentId: string; text: string }
  | { type: 'permission.request'; runId: string; request: PermissionRequest }
  | { type: 'permission.resolved'; runId: string; requestId: string }
  | { type: 'run.cost'; runId: string; totalCostUsd: number }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'proposal.request'; runId: string; proposal: Proposal }
  | { type: 'proposal.resolved'; runId: string; proposalId: string; decision: ProposalDecision }
  | { type: 'question.request'; runId: string; question: UserQuestion }
  | { type: 'question.resolved'; runId: string; questionId: string; answer: QuestionAnswer }
  | { type: 'merge.request'; runId: string; review: MergeReview }
  | { type: 'merge.resolved'; runId: string; reviewId: string; decision: MergeDecision }
  /** The main process changed the project (an approved proposal, setup completion). */
  | { type: 'project.updated'; runId: string; project: Project }
  /** Latest plan usage as seen by a live session. Account-wide, not specific to the run. */
  | { type: 'usage.status'; runId: string; usage: UsageStatus }

/** Payload of the main -> renderer `app:focusRun` message sent when a notification is clicked. */
export interface FocusRunTarget {
  projectId: string
  runId: string
}

// ---------- AI drafting ----------

export interface DraftRequest {
  projectId: string
  /** The user's instruction, e.g. "This is a Next.js + Postgres SaaS; I mostly build features and fix bugs." */
  instruction: string
  /** Whether to start from the existing roles or from scratch. */
  mode: 'replace' | 'revise'
}

export interface DraftResult {
  roles: Role[]
  rationale: string
}

// ---------- IPC surface ----------

export interface OrgAIApi {
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    /** Omit setupKind to skip AI setup and start with the default roles. */
    create(input: { name: string; path: string; brief: string; setupKind?: SetupKind }): Promise<Project>
    save(project: Project): Promise<Project>
    remove(id: string): Promise<void>
    pickDirectory(): Promise<string | null>
  }
  draft: {
    orgChart(req: DraftRequest): Promise<DraftResult>
  }
  setup: {
    /** Profile the working directory and start an Architect session. */
    start(input: { projectId: string; instruction?: string }): Promise<RunSummary>
    decide(input: { runId: string; proposalId: string; decision: ProposalDecision }): Promise<void>
    /** Answer an ask_user question from the Architect. */
    answer(input: { runId: string; questionId: string; answer: QuestionAnswer }): Promise<void>
  }
  maintenance: {
    /** Report branches still in the repository. */
    listWorktrees(projectId: string): Promise<PendingWorktree[]>
    /** Commit leftovers and merge one branch into the main checkout. */
    integrateWorktree(input: { projectId: string; branch: string }): Promise<MaintenanceResult>
    /** Delete one branch and its worktree, losing its work. */
    discardWorktree(input: { projectId: string; branch: string }): Promise<MaintenanceResult>
    /** The branch's changes against the main checkout. */
    diffWorktree(input: { projectId: string; branch: string }): Promise<WorktreeDiff>
    /** Remove the files OrgAI added to the repository. Refuses while report branches hold work. */
    uninstallRepo(projectId: string): Promise<MaintenanceResult>
  }
  runs: {
    /** `scaffold` marks a new project's first build run so the setup banner can step aside. */
    start(input: { projectId: string; prompt: string; scaffold?: boolean }): Promise<RunSummary>
    send(input: { runId: string; text: string }): Promise<void>
    interrupt(runId: string): Promise<void>
    stop(runId: string): Promise<void>
    list(projectId: string): Promise<RunSummary[]>
    /** Load a past run with its agents and transcript. null when nothing was persisted. */
    get(runId: string): Promise<RunRecord | null>
    decide(input: { runId: string; requestId: string; decision: PermissionDecision }): Promise<void>
    /** Start a new run that resumes a finished run's session, so the orchestrator keeps its memory. */
    continue(input: { runId: string; text: string }): Promise<RunSummary>
    /** Answer a merge review: merge, discard or hold the report's branch. */
    decideMerge(input: { runId: string; reviewId: string; decision: MergeDecision }): Promise<void>
    /** A paused run: continue it now instead of waiting for the usage window to reset. */
    resumeNow(runId: string): Promise<RunSummary>
    /** A paused run: keep it paused; the user continues it by hand. */
    cancelAutoResume(runId: string): Promise<void>
  }
  permissions: {
    /** Allow rules saved in the project's .claude/settings.local.json, e.g. "Bash(npm:*)". */
    list(projectId: string): Promise<string[]>
    /** Remove one saved allow rule; returns the remaining rules. */
    remove(input: { projectId: string; rule: string }): Promise<string[]>
  }
  onRunEvent(cb: (event: RunEvent) => void): () => void
  /** A clicked OS notification asks the renderer to show this run. */
  onFocusRun(cb: (target: FocusRunTarget) => void): () => void
  usage: {
    /** Read plan usage now, without a run. null when the provider cannot report it. */
    refresh(): Promise<UsageStatus | null>
  }
  notifications: {
    /** Global on/off for OS attention notifications. The renderer persists the choice. */
    setEnabled(enabled: boolean): Promise<void>
  }
  auth: {
    status(): Promise<AuthStatusResult>
  }
  settings: {
    get(): Promise<AppSettingsInfo>
    set(s: AppSettings): Promise<AppSettingsInfo>
  }
  app: {
    /** Open a file or folder with the OS default handler. Resolves to an error message, or '' on success. */
    openPath(path: string): Promise<string>
    /** Open the main-process logs folder in the system file manager. */
    openLogs(): Promise<void>
    /** Absolute path of the current main-process log file. */
    logPath(): Promise<string>
  }
}

export const IPC = {
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsCreate: 'projects:create',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsPickDir: 'projects:pickDirectory',
  draftOrgChart: 'draft:orgChart',
  runsStart: 'runs:start',
  runsSend: 'runs:send',
  runsInterrupt: 'runs:interrupt',
  runsStop: 'runs:stop',
  runsList: 'runs:list',
  runsGet: 'runs:get',
  runsDecide: 'runs:decide',
  runsContinue: 'runs:continue',
  runsResumeNow: 'runs:resumeNow',
  runsCancelAutoResume: 'runs:cancelAutoResume',
  runEvent: 'runs:event',
  setupStart: 'setup:start',
  setupDecide: 'setup:decide',
  setupAnswer: 'setup:answer',
  maintListWorktrees: 'maintenance:listWorktrees',
  maintIntegrate: 'maintenance:integrateWorktree',
  maintDiscard: 'maintenance:discardWorktree',
  maintUninstall: 'maintenance:uninstallRepo',
  maintDiff: 'maintenance:diff',
  mergesDecide: 'merges:decide',
  authStatus: 'auth:status',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appOpenPath: 'app:openPath',
  appFocusRun: 'app:focusRun',
  appSetNotifications: 'app:setNotifications',
  usageRefresh: 'usage:refresh',
  appOpenLogs: 'app:openLogs',
  appLogPath: 'app:logPath',
  permissionsList: 'permissions:list',
  permissionsRemove: 'permissions:remove'
} as const
