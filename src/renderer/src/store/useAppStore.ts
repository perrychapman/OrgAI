import { normalizeView } from '../lib/teamView'
import { droppedExtrasMessage } from '../lib/folderLists'
import { rulesChangedProject } from '../lib/rulesChange'
import { clearKnowledgePrefs } from '../lib/knowledgePrefs'
import { isTeamSurfaceRun } from '../lib/runSurface'
import { useTeamAssistantStore } from './teamAssistant'
import { create } from 'zustand'
import { useMemo } from 'react'
import { defaultRunToOpen } from '../lib/needsYou'
import { assistantRunToOpen } from '../lib/assistantNav'
import { secretsNextFor, type ProposalNext } from '../lib/proposalNext'
import type { KnowledgeFocusRequest } from '../lib/knowledge'
import { addRecalled, cleanRecalledEvent, type RecalledEvent } from '../lib/runKnowledge'
import { adoptEndFacts, statusEventEndFacts, CHAIN_EAGER_MEMBERS, CHAIN_FETCH_CONCURRENCY, CHAIN_WALK_MAX_HOPS, chainGroups, chainIdsToLoad, chainKeyOf, chainOf, needsYou, runBatched, type ChainGroup } from '../lib/runChains'
import { cutWhile, settleEndedAgents } from '../lib/runStatus'
import { readOpenTabs, sameRunSummaries, tabsSignature, writeOpenTabs } from '../lib/openTabs'
import { mergePendingCards, type PendingCards } from '../lib/pendingCards'
import { runIndexMap } from '../lib/runLabels'
import { cleanIpcError } from '../lib/ipcError'
import { withRunTitle } from '../lib/runTitle'
import { describeRemap, type ProjectChanges } from '../lib/remap'
import type {
  AppInfo,
  AgentInstance,
  AgentMessage,
  AuthStatusResult,
  ConnectionEvent,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginUpdate,
  McpInstallOutcome,
  McpInstallRequest,
  ProviderModel,
  RemapResult,
  DraftRequest,
  DraftResult,
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRequest,
  Project,
  ImageAttachment,
  Proposal,
  ProposalDecision,
  ProposalOutcome,
  PermissionRuleDecision,
  PermissionRuleRequest,
  QuestionAnswer,
  Role,
  RunEvent,
  RunPlan,
  RunSummary,
  SetupKind,
  TranscriptEntry,
  UsageStatus,
  UserQuestion
} from '@shared/types'
import { HARNESS_PROJECT_ID, QUICK_PROJECT_ID, SKILLS_PROJECT_ID, VIRTUAL_PROJECT_IDS, isVirtualProjectId, parseRunWindowHash } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import type { ProjectKind, QuickRunInput, QuickRunPromoteResult, SkillAssistInput, VirtualProjectId } from '@shared/types'
import type { OrgTemplateInfo, OrgTemplateSaveInput, ProjectRemoveResult, RunTeam, TeamFilesStatus } from '@shared/types'
import { displayProject, type RunLayout } from '../lib/assistants'

/** Project tabs: run (Live), history, knowledge (engagements only), team (Team; was 'org', see lib/teamView normalizeView), settings. projects and appSettings are app-level. */
/** The Banner after an agent import: what came in, and what Undo restores. */
export interface ImportNotice {
  /** What replaced the chart: an agent import (default) or a team template (templates:apply). One notice per project. */
  source?: 'import' | 'template'
  count: number
  summary: string
  previousRoles: Role[]
  /** The roles right after the import. Undo is only offered while the chart still matches them. */
  importedRoles: Role[]
  state: 'available' | 'busy' | 'reverted' | 'error' | 'expired'
  error?: string
}

export type View = 'projects' | 'team' | 'settings' | 'run' | 'history' | 'knowledge' | 'appSettings'
/** Tabs of the live view's side panel. The side tab is remembered per run. */
export type SideTab = 'transcript' | 'plan' | 'usage' | 'knowledge' | 'logs'

/** What a request to open one item in a run's Knowledge side tab names (ids first, else kind and name, else a note title). */
export interface RunKnowledgeRequest {
  nodeId?: string
  kind?: string
  name?: string
  noteTitle?: string
}

/**
 * The run side tab's own state, per conversation chain (docs/design/knowledge-graph-2.md section 3.1): the search text,
 * the open item and the Back stack survive a tab switch. `request` is a pending open from a transcript link or RunMeta
 * in a run window; the tab resolves and clears it.
 */
export interface RunKnowledgeUi {
  query: string
  openId: string | null
  stack: string[]
  request?: RunKnowledgeRequest
}

export const EMPTY_RUN_KNOWLEDGE: RunKnowledgeUi = { query: '', openId: null, stack: [] }

/** A half-typed message. Kept per run (and per project for the New run page) so it survives tab switches. */
export interface ComposerDraft {
  text: string
  images: ImageAttachment[]
}
/** Key of the New run page's draft for a project. Run drafts use the run id. */
export const newRunDraftKey = (projectId: string): string => `new:${projectId}`
export const isDraftEmpty = (d: ComposerDraft | undefined): boolean => !d || (d.text.trim().length === 0 && d.images.length === 0)
/** Autosave feedback shown by the topbar indicator (spec 12.5). */
export interface SaveStatus {
  state: 'idle' | 'saving' | 'saved' | 'error'
  at?: number
  message?: string
}

export interface LogLine {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface RunState {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  transcript: TranscriptEntry[]
  permissions: PermissionRequest[]
  proposals: Proposal[]
  /** Open ask_user questions from the Architect. */
  questions: UserQuestion[]
  /** Open request_permission_rules cards. */
  ruleRequests: PermissionRuleRequest[]
  /** Finished reports waiting for the user to merge, hold or discard their branch. */
  mergeReviews: MergeReview[]
  logs: LogLine[]
  /** agent id -> text it is streaming right now. Live only, never persisted. */
  partial: Record<string, string>
  /** Latest agent-to-agent messages (at most MAX_MESSAGES), drawn as edges for a few seconds. Live only. */
  messages: AgentMessage[]
  /** Work runs: the orchestrator's plan, once it set one. */
  plan?: RunPlan
  /** Open request_mcp_install approvals. */
  mcpInstalls: McpInstallRequest[]
  /** Answered installs (secret-free outcomes), keyed by request id, kept so the card shows its resolution. */
  mcpResolved: Record<string, { request: McpInstallRequest; outcome: McpInstallOutcome }>
  /**
   * Ended runs loaded from a record: what the run was doing when it ended (lib/runStatus cutWhile, read before the
   * agents were settled). Only meaningful for a run cut by OrgAI closing.
   */
  cutWhile?: 'working' | 'waiting'
}

/** A model-change notice (Banner). Per project it keeps the pre-change copy so Undo can restore it. */
export interface RemapNoticeState {
  id: string
  cause: string
  at: number
  projects: (ProjectChanges & {
    before?: Pick<Project, 'roles' | 'provider'>
    undo: 'available' | 'busy' | 'reverted' | 'error' | 'gone'
    undoError?: string
  })[]
}

const MAX_MESSAGES = 100

/** How many decisions (cards, questions, installs) the run still waits on. */
export function pendingDecisionCount(r: Pick<RunState, 'permissions' | 'proposals' | 'questions' | 'ruleRequests' | 'mergeReviews' | 'mcpInstalls'>): number {
  return r.permissions.length + r.proposals.length + (r.questions?.length ?? 0) + (r.ruleRequests?.length ?? 0) + (r.mergeReviews?.length ?? 0) + (r.mcpInstalls?.length ?? 0)
}

function emptyRun(summary: RunSummary): RunState {
  return { summary, agents: {}, transcript: [], permissions: [], proposals: [], questions: [], ruleRequests: [], mergeReviews: [], logs: [], partial: {}, messages: [], mcpInstalls: [], mcpResolved: {} }
}

/** Where an MCP deep link should land after the view switches (cleared by the receiving section). */
export type McpFocus = { kind: 'library'; libraryId?: string } | { kind: 'server'; projectId: string; serverId?: string; /** Open the server's edit form with its first missing secret focused. */ edit?: boolean }

interface AppState {
  projects: Project[]
  /** The virtual projects behind the Assistants rows (Chat, MCP assistant, Skill assistant), loaded on first use. Never in `projects`. */
  virtualProjects: Partial<Record<VirtualProjectId, Project>>
  /** Load a virtual project (projects.get; a null or failed answer becomes a display project). */
  loadVirtualProject(id: VirtualProjectId): Promise<Project>
  /** An instruction a start page should prefill (e.g. "Configure with AI"), per assistant. */
  assistantSeed: Partial<Record<VirtualProjectId, string>>
  clearAssistantSeed(id: VirtualProjectId): void
  /** Select an assistant: the run that needs you, else the last viewed, else the start page. `instruction` seeds the start page. */
  /** `fresh` (or an instruction) shows the start page; a plain open shows a live run, else the start page. */
  openAssistant(id: VirtualProjectId, opts?: { instruction?: string; fresh?: boolean }): Promise<void>
  /** Start a Chat (quick run) and show it. */
  startQuick(input: QuickRunInput): Promise<RunSummary>
  /** Start the Skill assistant: library scope shows it on the Skill assistant row, project scope on that project's Live tab. */
  startSkillAssist(input: SkillAssistInput): Promise<RunSummary>
  /** Save a quick run's chain as a project. On 'created' the project is selected and the run opened. */
  promoteQuick(runId: string, name: string): Promise<QuickRunPromoteResult>
  mcpFocus: McpFocus | null
  /**
   * A pending request to select one item on the Knowledge tab (a transcript row's link, a settings link). KnowledgeView
   * resolves it (lib/knowledge.ts resolveFocus) once it has its data and clears it through clearKnowledgeFocus.
   */
  knowledgeFocus: KnowledgeFocusRequest | null
  /** Open the project's Knowledge tab, on one item when the request names one (ids first, else kind and name, else a note title). */
  openKnowledgeItem(req: KnowledgeFocusRequest): void
  clearKnowledgeFocus(): void
  /** Selected project-settings pane per project id (lib/settingsTarget PROJECT_SETTINGS_PANES); absent means General. */
  projectSettingsPane: Record<string, string>
  setProjectSettingsPane(projectId: string, pane: string): void
  /** Show the app settings MCP library, optionally on one entry. */
  openMcpLibrary(libraryId?: string): void
  /** Show a project's settings on its MCP servers section, optionally on one server. */
  openProjectMcp(projectId: string, serverId?: string, opts?: { edit?: boolean }): void
  clearMcpFocus(): void
  /** Start the library-level MCP assistant (a harness run), select the MCP assistant row and show the run; resolves with its summary. */
  startLibraryAssist(instruction?: string, allowBuild?: boolean): Promise<RunSummary>
  selectedProjectId: string | null
  view: View
  /** Bumped by openNewProject(); the Dashboard opens its New project form when it changes. */
  newProjectRequest: number
  saveStatus: SaveStatus
  selectedRoleId: string | null
  runs: Record<string, RunState>
  activeRunByProject: Record<string, string>
  selectedAgentId: string | null
  auth: AuthStatusResult | null
  drafting: boolean
  draftResult: DraftResult | null
  draftError: string | null
  /** Runs hidden from the run tabs (finished runs the user closed). They stay reachable in History. */
  dismissedRuns: Record<string, true>
  /** Projects whose workspace shows the blank New run page instead of a run. */
  draftPage: Record<string, true>
  /** Composer drafts by run id, or newRunDraftKey(projectId) for the New run page. */
  composerDrafts: Record<string, ComposerDraft>
  setComposerDraft(key: string, draft: ComposerDraft): void
  /** Side panel tab per run. */
  sideTabByRun: Record<string, SideTab>
  /** Live view layout the user picked per run (conversation or canvas); absent means `runLayoutFor`'s default. */
  runLayoutByRun: Record<string, RunLayout>
  /** After the user approves a skills or MCP proposal: the pointer shown in the run's metadata line. */
  noteProposalNext(runId: string, next: ProposalNext | null): void
  setRunLayout(runId: string, layout: RunLayout): void
  /** Select the side tab of the viewed run. */
  setSideTab(tab: SideTab): void
  /** `knowledge.recalled` events per run (ids and time only), in arrival order; not saved with the run, so empty after a relaunch. */
  knowledgeRecalledByRun: Record<string, RecalledEvent[]>
  /** The run Knowledge side tab's state per chain (the key is the chain's first run id). */
  runKnowledgeByChain: Record<string, RunKnowledgeUi>
  /** Merge a change into the chain's side-tab state (the chain of `runId`). */
  patchRunKnowledge(runId: string, patch: Partial<RunKnowledgeUi>): void
  /** Show the run's Knowledge side tab, on one item when `request` names it (a run window's stand-in for the Knowledge tab). */
  openRunKnowledge(runId: string, request?: RunKnowledgeRequest): void
  /** Short inline message next to the run tabs (e.g. after hiding a tab). */
  tabNotice: string | null
  setTabNotice(message: string): void
  /** Unread notes from other runs (run.message 'in'), per run id. Cleared when the run is viewed. */
  unreadByRun: Record<string, number>
  /** Show runs that are live in the main process but not in this window yet. */
  loadLiveRuns(): Promise<void>
  /** Run whose first decision card should take focus once its view is on screen. */
  pendingDecisionFocus: string | null
  /** The request id that jump asked to open (a specific card in the tray); null opens the default card. */
  pendingDecisionRequest: string | null
  clearDecisionFocus(): void
  /** The chain member the user asked to see (History, a link): the merged feed scrolls to its divider once. Cleared by the view. */
  chainFocusRun: string | null
  /** Load the records of `runId`'s chain members that are not in `runs` yet (lazy, cached, one fetch per id in flight). */
  loadChain(runId: string): Promise<void>
  /** How many of a chain's newest members load (chain key -> count); missing means CHAIN_EAGER_MEMBERS. */
  chainLoadLimit: Record<string, number>
  /** "Load earlier sessions": widen the chain's load window by CHAIN_EAGER_MEMBERS and load the next batch. */
  loadEarlierSessions(runId: string): Promise<void>
  /** Run whose composer should open on "Continue this run" (set by History's Continue). */
  continueIntent: string | null
  /** Open a finished run with its composer preset to Continue, and focus the composer. */
  /** `projectId` selects that project first (the Dashboard's Continue); omitted inside a project. */
  continueFromHistory(runId: string, projectId?: string): Promise<void>
  /** Show the blank New run page for the selected project. */
  openDraft(): void
  /** Close the New run page and drop its draft. */
  closeDraft(): void
  /** Pick a workspace for the selected project when it has none: its newest run, else the New run page. */
  ensureWorkspace(): Promise<void>
  /** Select a project and open the run that needs the user, else the last viewed one, else the newest. */
  openProject(projectId: string): Promise<void>
  /** Select the project, open the run and ask its decision card to take focus. */
  jumpToDecision(projectId: string, runId: string, requestId?: string): Promise<void>
  /** Latest plan usage reported by any live session. */
  usage: UsageStatus | null
  /** Latest report per connection (missing connection = anthropic). `usage` is the anthropic entry. */
  usageByConnection: Partial<Record<ConnectionId, UsageStatus>>
  /** Ask the main process to read plan usage now (no run needed). */
  refreshUsage(): Promise<void>

  /** App-wide connections (records plus live status). null until the first load. */
  /** Static app facts (version, folders, mock availability). null until loaded. */
  appInfo: AppInfo | null
  loadAppInfo(): Promise<void>
  /**
   * The effective default connection: the connections:list entry with `isDefault` (main decides it from the stored
   * choice and the live statuses), never the raw AppSettings.defaultConnection. Every consumer (connection cards, the
   * New project line, the assistants' model lines, usage) reads this one value. null until the list is loaded.
   * Reloaded on settings:changed, connection.status events and after a connection record changes.
   */
  defaultConnection: ConnectionId | null
  /** AppSettings.defaultConnectionChosen: the user picked the default (true) or main picks it (false). null until loaded. */
  defaultConnectionChosen: boolean | null
  /**
   * The stored AppSettings.defaultConnection (the user's pick while defaultConnectionChosen is true). Only for telling
   * whether the effective default is that pick or a fallback (lib/connectionLabel.ts `defaultMode`). null until loaded.
   */
  defaultConnectionStored: ConnectionId | null
  /** Counts successful setDefaultConnection calls, so every card can clear its own earlier refusal. */
  defaultConnectionChanges: number
  /** Load the connection list and the chosen flag, and start following settings:changed (idempotent). */
  loadDefaultConnection(): Promise<void>
  /** connections:setDefault: an id makes it the chosen default, null returns to automatic. Rejects with a readable refusal. */
  setDefaultConnection(id: ConnectionId | null): Promise<void>
  connections: ConnectionInfo[] | null
  connectionsError: string | null
  /** Model catalogs by connection. */
  models: Partial<Record<ConnectionId, ProviderModel[]>>
  modelsError: Partial<Record<ConnectionId, string | undefined>>
  /** Latest ChatGPT login progress. */
  login: ConnectionLoginUpdate | null
  remapNotices: RemapNoticeState[]
  loadConnections(): Promise<void>
  loadModels(id: ConnectionId, refresh?: boolean): Promise<void>
  /** Replace one connection entry after a connections.* call. */
  setConnectionInfo(info: ConnectionInfo): void
  /** Show a notice for results. `before` holds the pre-change copies of the projects, for Undo. */
  pushRemapNotice(cause: string, results: RemapResult[], before: Project[]): void
  dismissRemapNotice(id: string): void
  /** Agent import: a pending request to open the review dialog on the Team tab, and the notice after an apply. */
  importRequest: { projectId: string; fresh: boolean } | null
  importNotices: Record<string, ImportNotice>
  proposalNextByRun: Record<string, ProposalNext>
  /** The secret-free outcome of each resolved proposal (by proposal id), from the proposal.resolved event. */
  proposalOutcomes: Record<string, ProposalOutcome>
  /** Per project: bumped when saved permission rules may have changed (project-scope grant, project.updated). */
  rulesChangedByProject: Record<string, number>
  /** Latest team-files status per project (lib/teamFiles.ts). Filled by listAttention at boot, status() and the push. */
  teamFilesByProject: Record<string, TeamFilesStatus>
  setTeamFilesStatus(status: TeamFilesStatus): void
  loadTeamFilesAttention(): Promise<void>
  /** Calls teamFiles.status (which may write a project's files the first time) and stores the answer; null on failure. */
  refreshTeamFiles(projectId: string): Promise<TeamFilesStatus | null>
  requestImport(request: { projectId: string; fresh: boolean } | null): void
  recordImport(projectId: string, notice: Omit<ImportNotice, 'state' | 'error'>): void
  undoImport(projectId: string): Promise<void>
  dismissImportNotice(projectId: string): void
  undoRemap(noticeId: string, projectId: string): Promise<void>
  /** Save a project right away and replace the store copy with what the main process returns. */
  saveProjectNow(project: Project): Promise<Project>
  replaceProject(project: Project): void
  handleConnectionEvent(e: ConnectionEvent): void

  init(): Promise<void>
  loadProjects(): Promise<void>
  selectProject(id: string | null): void
  setView(view: View): void
  setSaveStatus(status: SaveStatus): void
  trackSave<T>(fn: () => Promise<T>): Promise<T>
  selectRole(id: string | null): void
  selectAgent(id: string | null): void
  createProject(
    input: {
      name: string
      path: string
      brief: string
      setupKind?: SetupKind
      kind?: ProjectKind
      mock?: boolean
      client?: string
      referenceDirectories?: string[]
      /** Start from a saved team template (ProjectCreateInput.templateId). */
      templateId?: string
    },
    opts?: { onExtrasError?: (err: unknown) => void }
  ): Promise<Project>
  updateProject(project: Project): void
  updateRoles(projectId: string, mutate: (roles: Role[]) => Role[]): void
  /** projects:remove; resolves to main's counts of what was deleted. */
  removeProject(id: string): Promise<ProjectRemoveResult>
  /** The Dashboard notice after "Forget this engagement" (name and main's counts); null when none. */
  forgetNotice: { name: string; result: ProjectRemoveResult } | null
  setForgetNotice(notice: { name: string; result: ProjectRemoveResult } | null): void

  /** Saved team templates (templates:list); null until loaded. */
  templates: OrgTemplateInfo[] | null
  templatesError: string | null
  loadTemplates(): Promise<void>
  /** templates:saveFromProject; refreshes the list. Rejects with main's refusal. */
  saveTemplate(input: OrgTemplateSaveInput): Promise<OrgTemplateInfo>
  /** templates:remove; replaces the list with the remaining ones. */
  removeTemplate(templateId: string): Promise<void>
  /**
   * templates:apply (mode 'replace'): replaces the store's project and records the project's chart notice with
   * source 'template' (Undo restores previousRoles through undoImport). Rejects with main's refusal.
   */
  applyTemplate(projectId: string, template: Pick<OrgTemplateInfo, 'id' | 'name'>): Promise<void>

  /** `team: 'single'` starts an Ask run (one assistant, conversation layout). */
  startRun(prompt: string, opts?: { scaffold?: boolean; images?: ImageAttachment[]; team?: RunTeam }): Promise<void>
  /** Start an Architect session for the selected project. */
  startSetup(instruction?: string): Promise<void>
  /** Start the MCP assistant run (kind 'mcp-assist') for the selected project and show it. */
  startMcpAssist(instruction?: string): Promise<void>
  /** Architect session that reviews a finished run and revises the org chart. */
  startRetro(runId: string): Promise<void>
  /** Past runs of the selected project, newest first. */
  history: RunSummary[]
  /** Past runs of every project, newest first (the sidebar's "last run" line). */
  historyByProject: Record<string, RunSummary[]>
  loadHistory(): Promise<void>
  loadAllHistory(): Promise<void>
  /** Show a past run on the canvas. */
  openRun(runId: string): Promise<void>
  sendMessage(text: string, images?: ImageAttachment[]): Promise<void>
  /** Start a new run that resumes a finished run's session, and show it. */
  continueRun(fromRunId: string, text: string, images?: ImageAttachment[]): Promise<void>
  /** A paused run: continue it now instead of at the usage window's reset. */
  resumeNow(runId: string): Promise<void>
  /** A paused run: drop its auto-resume; it stays paused until the user continues it. */
  cancelAutoResume(runId: string): Promise<void>
  /** Bumped to ask the live view's composer to take focus (e.g. "Continue" in the Runs tab). */
  composerFocusToken: number
  focusComposer(): void
  interrupt(): Promise<void>
  stopRun(): Promise<void>
  decide(requestId: string, decision: PermissionDecision): Promise<void>
  decideProposal(proposalId: string, decision: ProposalDecision): Promise<void>
  answerQuestion(questionId: string, answer: QuestionAnswer): Promise<void>
  /** Answer a request_permission_rules card. */
  decideRules(requestId: string, decision: PermissionRuleDecision): Promise<void>
  decideMerge(reviewId: string, decision: MergeDecision): Promise<void>
  handleEvent(e: RunEvent): void
  /** Replace a placeholder summary (created by an event of an unknown run) with the real one. */
  fillSummary(runId: string): Promise<void>
  /** Hide a finished run's tab. Stops viewing it if it was the viewed run. */
  dismissRun(runId: string): void
  /** Select a project and view one of its runs (e.g. from a clicked notification). */
  focusRun(projectId: string, runId: string): Promise<void>

  draftOrgChart(req: Omit<DraftRequest, 'projectId'>): Promise<void>
  applyDraft(): void
  discardDraft(): void
}

let unsubscribeEvents: (() => void) | null = null
/** Bumped by every setTabNotice call; only the newest call may show or clear the notice. */
let tabNoticeSeq = 0
/** Runs whose real summary is being fetched after an event created a placeholder. */
const summaryLookups = new Set<string>()
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function debouncedSave(project: Project): void {
  useAppStore.getState().setSaveStatus({ state: 'saving' })
  const t = saveTimers.get(project.id)
  if (t) clearTimeout(t)
  saveTimers.set(
    project.id,
    setTimeout(() => {
      saveTimers.delete(project.id)
      void useAppStore.getState().trackSave(() => window.orgai.projects.save(project)).catch(() => undefined)
    }, 350)
  )
}

/** Open the Chat assistant on its start page (a new chat), whatever it showed before. */
export async function openNewChat(): Promise<void> {
  await useAppStore.getState().openAssistant('quick', { fresh: true })
}

/** Show the Dashboard and open its New project form. */
export function openNewProject(): void {
  useAppStore.setState((s) => ({ view: 'projects', newProjectRequest: s.newProjectRequest + 1 }))
}

export const selectedProject =(s: AppState): Project | undefined =>
  s.selectedProjectId && isVirtualProjectId(s.selectedProjectId) ? s.virtualProjects[s.selectedProjectId] : s.projects.find((p) => p.id === s.selectedProjectId)

/** The run the workspace shows. Undefined on the New run page. */
export const activeRun = (s: AppState): RunState | undefined => {
  if (!s.selectedProjectId || s.draftPage[s.selectedProjectId]) return undefined
  const runId = s.activeRunByProject[s.selectedProjectId]
  return runId ? s.runs[runId] : undefined
}

const HIDDEN_NOTICE = 'Hidden. Find it in History.'
const LIVE_RUN_STATUSES = new Set(['starting', 'running', 'idle', 'stopping'])
export const isRunLive = (run: RunState): boolean => LIVE_RUN_STATUSES.has(run.summary.status)

/** Every run of a project known to the renderer: live runs first, then newest first. */
export const runsOfProject = (s: AppState, projectId: string): RunState[] =>
  Object.values(s.runs)
    .filter((r) => r.summary.projectId === projectId && !isTeamSurfaceRun(r.summary))
    .sort((a, b) => Number(isRunLive(b)) - Number(isRunLive(a)) || b.summary.startedAt - a.summary.startedAt)

/** Runs of the selected project. Returns a fresh array: use with `useShallow`. */
export const projectRuns = (s: AppState): RunState[] => (s.selectedProjectId ? runsOfProject(s, s.selectedProjectId) : [])

/**
 * Summaries of the selected project's runs: the persisted history merged with the live renderer state (which is
 * fresher), newest first. Used to work out session chains.
 */
export function useProjectSummaries(): RunSummary[] {
  const history = useAppStore((s) => s.history)
  const runs = useAppStore((s) => s.runs)
  const projectId = useAppStore((s) => s.selectedProjectId)
  return useMemo(() => {
    const byId = new Map<string, RunSummary>(history.map((h) => [h.id, h]))
    for (const r of Object.values(runs)) if (r.summary.projectId === projectId && !isTeamSurfaceRun(r.summary)) byId.set(r.summary.id, r.summary)
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  }, [history, runs, projectId])
}

/** State patch that shows a run in its project's workspace: leaves the New run page, un-hides the tab. */
function showRunPatch(s: AppState, projectId: string, requestedId: string): Partial<AppState> {
  // One conversation per chain: the tab always shows the chain's newest loaded member, and un-hides the whole chain.
  const members = chainOf(summariesOf(s, projectId), requestedId)
  const runId = [...members].reverse().find((m) => s.runs[m.id])?.id ?? requestedId
  const { [projectId]: _draft, ...draftPage } = s.draftPage
  const dismissedRuns = { ...s.dismissedRuns }
  const unreadByRun = { ...s.unreadByRun }
  for (const id of [runId, requestedId, ...members.map((m) => m.id)]) {
    delete dismissedRuns[id]
    delete unreadByRun[id]
  }
  return { activeRunByProject: { ...s.activeRunByProject, [projectId]: runId }, selectedAgentId: 'root', view: 'run', draftPage, dismissedRuns, unreadByRun }
}

/** Summaries of one project: its persisted history merged with the runs the renderer holds (fresher). */
function summariesOf(s: AppState, projectId: string): RunSummary[] {
  const byId = new Map<string, RunSummary>()
  for (const h of s.historyByProject[projectId] ?? (s.selectedProjectId === projectId ? s.history : [])) byId.set(h.id, h)
  for (const r of Object.values(s.runs)) if (r.summary.projectId === projectId && !isTeamSurfaceRun(r.summary)) byId.set(r.summary.id, r.summary)
  return [...byId.values()]
}

/** A run record from the main process as renderer state. Pending cards are not in a record; events fill them. */
/**
 * Cards still open in the main process, for a window that missed their *.request events (fresh renderer, run window).
 */
async function seedPendingCards(runId: string): Promise<void> {
  const api = window.orgai.runs
  try {
    const cards = await api.pendingCards(runId)
    // The run may not be in the store yet (record still loading); retry briefly once it is.
    for (let i = 0; i < 20 && !useAppStore.getState().runs[runId]; i++) await new Promise((r) => setTimeout(r, 100))
    useAppStore.setState((s) => {
      const run = s.runs[runId]
      if (!run) return {}
      return { runs: { ...s.runs, [runId]: { ...run, ...mergePendingCards(run, cards) } } }
    })
  } catch {
    /* unknown run or old main process: events still fill the store */
  }
}

function stateFromRecord(record: Omit<RunState, 'permissions' | 'proposals' | 'questions' | 'ruleRequests' | 'mergeReviews' | 'partial' | 'messages' | 'mcpInstalls' | 'mcpResolved'>): RunState {
  // What the run was doing when it was cut, read before the agents are settled (H4); then no ended run keeps a live label.
  const ended = record.summary.status === 'finished' || record.summary.status === 'error'
  const cut = ended ? cutWhile(record.agents) : undefined
  const agents = settleEndedAgents(record.summary, record.agents)
  return { ...record, agents, ...(cut ? { cutWhile: cut } : {}), permissions: [], proposals: [], questions: [], ruleRequests: [], mergeReviews: [], logs: record.logs, partial: {}, messages: [], mcpInstalls: [], mcpResolved: {} }
}

/**
 * Tabs of a project: one run per session chain (its newest loaded member), hidden chains left out, ordered by the
 * chain's first member start (oldest first).
 */
function tabEntriesOf(s: AppState, projectId: string): { run: RunState; group: ChainGroup<RunSummary> }[] {
  if (!Object.values(s.runs).some((r) => r.summary.projectId === projectId)) return []
  const out: { run: RunState; group: ChainGroup<RunSummary> }[] = []
  for (const g of chainGroups(summariesOf(s, projectId))) {
    const run = [...g.members]
      .reverse()
      .map((m) => s.runs[m.id])
      .find((r): r is RunState => !!r)
    if (!run || isTeamSurfaceRun(run.summary)) continue
    if (s.dismissedRuns[run.summary.id] && s.activeRunByProject[projectId] !== run.summary.id) continue
    out.push({ run, group: g })
  }
  return out.sort((a, b) => a.group.first.startedAt - b.group.first.startedAt || a.group.first.id.localeCompare(b.group.first.id))
}

function tabRunsOf(s: AppState, projectId: string): RunState[] {
  return tabEntriesOf(s, projectId).map((x) => x.run)
}

// ---------- Chain loading and open-tab restore (docs/design/ux-review-continue.md H1, M2) ----------

/**
 * The run.status event carries endedBy / endedWhile (statusEventEndFacts) but not every end fact (error text, a record
 * from an older main process): the persisted rows do. A terminal run adopts them as a fallback; a live one never does. Returns a `runs` patch, or {} when nothing differs.
 */
function adoptRowsPatch(s: AppState, rows: readonly RunSummary[]): Partial<AppState> {
  let runs: Record<string, RunState> | null = null as Record<string, RunState> | null
  for (const row of rows) {
    const run: RunState | undefined = (runs ?? s.runs)[row.id]
    if (!run) continue
    const next = adoptEndFacts(run.summary, row)
    if (!next) continue
    runs = { ...(runs ?? s.runs), [row.id]: { ...run, summary: next } }
  }
  return runs ? { runs } : {}
}

/** One delayed history reload per project after a run ends, so the end facts events do not carry arrive. */
const endReloads = new Map<string, ReturnType<typeof setTimeout>>()
function reloadHistoryAfterEnd(projectId: string): void {
  if (!projectId || endReloads.has(projectId)) return
  endReloads.set(
    projectId,
    setTimeout(() => {
      endReloads.delete(projectId)
      void window.orgai.runs
        .list(projectId)
        .then((rows) => {
          const history = rows.filter((h) => !isTeamSurfaceRun(h))
          useAppStore.setState((s) => ({
            historyByProject: { ...s.historyByProject, [projectId]: history },
            ...(s.selectedProjectId === projectId ? { history } : {}),
            ...adoptRowsPatch(s, history)
          }))
        })
        .catch(() => undefined)
    }, 400)
  )
}

const chainFetches = new Map<string, Promise<void>>()
/** Latest openRun request per project (a stale, slower one gives way). */
const openRunRequests = new Map<string, number>()

/** Fetches one run record into the store unless it is loaded or already on its way. Events that created the run meanwhile win. */
function fetchRun(id: string): Promise<void> {
  if (useAppStore.getState().runs[id]) return Promise.resolve()
  const pending = chainFetches.get(id)
  if (pending) return pending
  const p = window.orgai.runs
    .get(id)
    .then((record) => {
      if (record) useAppStore.setState((s) => (s.runs[id] ? {} : { runs: { ...s.runs, [id]: stateFromRecord(record) } }))
    })
    .catch(() => undefined)
    .finally(() => chainFetches.delete(id))
  chainFetches.set(id, p)
  return p
}

const restoredTabs = new Map<string, Promise<string | undefined>>()

/**
 * The first settle of a real project after launch: loads the newest member of each remembered chain so its tab is
 * back. Resolves to the remembered viewed chain's newest member (the run to open when nothing needs you).
 */
function restoreOpenTabs(projectId: string): Promise<string | undefined> {
  const known = restoredTabs.get(projectId)
  if (known) return known
  const p = (async () => {
    if (isVirtualProjectId(projectId)) return undefined
    const remembered = readOpenTabs(projectId)
    const sums = summariesOf(useAppStore.getState(), projectId)
    const newestOfKey = (key: string): string | undefined => chainOf(sums, key).at(-1)?.id
    const ids = remembered.chains.map(newestOfKey).filter((id): id is string => !!id)
    await runBatched(ids, CHAIN_FETCH_CONCURRENCY, fetchRun)
    return remembered.viewed ? newestOfKey(remembered.viewed) : undefined
  })()
  restoredTabs.set(projectId, p)
  return p
}

let tabsWatch: (() => void) | null = null
/** Writes each restored project's tab set and viewed chain to localStorage whenever they change. */
function watchOpenTabs(): void {
  if (tabsWatch) return
  const written = new Map<string, string>()
  const signatures = new Map<string, string>()
  tabsWatch = useAppStore.subscribe((s, prev) => {
    const othersSame = s.history === prev.history && s.dismissedRuns === prev.dismissedRuns && s.activeRunByProject === prev.activeRunByProject && s.draftPage === prev.draftPage && s.historyByProject === prev.historyByProject
    if (othersSame && (s.runs === prev.runs || sameRunSummaries(s.runs, prev.runs))) return
    for (const [projectId, state] of restoreDone) {
      if (!state || isVirtualProjectId(projectId)) continue
      // Streamed events change `runs` constantly; rebuild the chains only when something that decides the tabs changed.
      const sums = summariesOf(s, projectId)
      const viewedId = s.draftPage[projectId] ? undefined : s.activeRunByProject[projectId]
      const dismissed = sums.filter((r) => s.dismissedRuns[r.id]).map((r) => r.id)
      const signature = tabsSignature(sums, dismissed, viewedId, !!s.draftPage[projectId])
      if (signatures.get(projectId) === signature) continue
      signatures.set(projectId, signature)
      const entries = tabEntriesOf(s, projectId)
      const chains = entries.map((x) => x.group.key)
      const viewed = viewedId ? (entries.find((x) => x.group.members.some((m) => m.id === viewedId))?.group.key ?? viewedId) : undefined
      const sig = JSON.stringify([chains, viewed])
      if (written.get(projectId) === sig) continue
      written.set(projectId, sig)
      writeOpenTabs(projectId, { chains, ...(viewed ? { viewed } : {}) })
    }
  })
}
/** Projects whose remembered tabs are back: only then do we overwrite what was remembered. */
const restoreDone = new Map<string, boolean>()
function markTabsRestored(projectId: string): void {
  if (isVirtualProjectId(projectId)) return
  restoreDone.set(projectId, true)
  watchOpenTabs()
}

/** Opens the project's newest run (or the New run page) when its workspace shows nothing yet. */
async function settleWorkspace(projectId: string): Promise<void> {
  const { getState, setState } = useAppStore
  await getState().loadHistory()
  // The first settle after launch brings the remembered tabs back (M2); the remembered viewed chain is the fallback "last viewed".
  const remembered = await restoreOpenTabs(projectId)
  try {
    const s = getState()
    if (s.selectedProjectId !== projectId || s.draftPage[projectId]) return
    const viewed = s.activeRunByProject[projectId]
    if (viewed && s.runs[viewed]) {
      if (!s.selectedAgentId) setState({ selectedAgentId: 'root' })
      return
    }
    // An assistant opens a live run or its start page, never an ended run.
    const target = isVirtualProjectId(projectId)
      ? assistantRunToOpen(runsOfProject(s, projectId), viewed)
      : defaultRunToOpen(runsOfProject(s, projectId), s.historyByProject[projectId] ?? [], viewed ?? remembered)
    if (target) await getState().openRun(target)
    else setState((cur) => (cur.draftPage[projectId] ? {} : { draftPage: { ...cur.draftPage, [projectId]: true as const } }))
  } finally {
    markTabsRestored(projectId)
  }
}

/** Show a run that continues an earlier one (Continue, Resume now). */
function showContinuation(summary: RunSummary): void {
  const { getState, setState } = useAppStore
  getState().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
  setState((s) => ({
    // Events may have landed before the IPC call returned; keep them and take the real summary.
    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, resumedFrom: summary.resumedFrom } } },
    ...showRunPatch(s, summary.projectId, summary.id),
    // M3: focus stays in the composer after a send that switches run ids.
    composerFocusToken: s.composerFocusToken + 1
  }))
  void getState().loadHistory()
}

/**
 * A run started from an assistant start page: take its summary (events may have landed first), select the project
 * it lives in (a virtual one is loaded first) and show it on the Live tab.
 */
async function showStartedAssistant(summary: RunSummary, home: string): Promise<void> {
  const { getState, setState } = useAppStore
  if (isVirtualProjectId(home)) await getState().loadVirtualProject(home)
  getState().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
  setState((s) => ({
    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, quick: summary.quick } } }
  }))
  if (getState().selectedProjectId !== home) getState().selectProject(home)
  setState((s) => showRunPatch(s, summary.projectId || home, summary.id))
  void getState().loadHistory()
}

/** Store a usage report under its connection, so one provider's probe never replaces another's. */
function putUsage(st: { usageByConnection: Partial<Record<ConnectionId, UsageStatus>>; usage: UsageStatus | null }, u: UsageStatus): { usageByConnection: Partial<Record<ConnectionId, UsageStatus>>; usage: UsageStatus | null } {
  const key: ConnectionId = u.connection ?? 'anthropic'
  return { usageByConnection: { ...st.usageByConnection, [key]: u }, usage: key === 'anthropic' ? u : st.usage }
}

let defaultConnectionWatch: (() => void) | null = null
let connectionsReloadTimer: ReturnType<typeof setTimeout> | null = null

/** The effective default from a connections:list result (exactly one entry has isDefault; null when none does). */
function effectiveDefaultOf(list: ConnectionInfo[] | null | undefined): ConnectionId | null {
  return list?.find((c) => c.isDefault)?.connection.id ?? null
}

/**
 * Re-read connections:list soon (coalesced): a status change or an edited record can move the effective default,
 * and only main decides it.
 */
function scheduleConnectionsReload(): void {
  if (connectionsReloadTimer) return
  connectionsReloadTimer = setTimeout(() => {
    connectionsReloadTimer = null
    void useAppStore.getState().loadConnections()
  }, 150)
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  virtualProjects: {},
  assistantSeed: {},
  mcpFocus: null,
  knowledgeFocus: null,
  projectSettingsPane: {},
  selectedProjectId: null,
  view: 'projects',
  newProjectRequest: 0,
  saveStatus: { state: 'idle' },
  selectedRoleId: null,
  runs: {},
  activeRunByProject: {},
  selectedAgentId: null,
  auth: null,
  drafting: false,
  draftResult: null,
  draftError: null,
  dismissedRuns: {},
  draftPage: {},
  composerDrafts: {},
  sideTabByRun: {},
  knowledgeRecalledByRun: {},
  runKnowledgeByChain: {},
  runLayoutByRun: {},
  tabNotice: null,
  unreadByRun: {},
  pendingDecisionFocus: null,
  pendingDecisionRequest: null,
  continueIntent: null,
  chainFocusRun: null,
  async loadChain(runId) {
    const projectId = get().runs[runId]?.summary.projectId || get().selectedProjectId || ''
    // Walk back along resumedFrom: each fetched record can name an earlier member the summaries did not know yet.
    // Only the newest members load eagerly (M2); earlier ones wait for "Load earlier sessions". Fetches go out in small batches.
    const tried = new Set<string>()
    for (let hop = 0; hop < CHAIN_WALK_MAX_HOPS; hop++) {
      const sums = summariesOf(get(), projectId)
      const limit = get().chainLoadLimit[chainKeyOf(sums, runId)] ?? CHAIN_EAGER_MEMBERS
      const ids = chainIdsToLoad(sums, runId, tried, limit)
      if (ids.length === 0) break
      for (const id of ids) tried.add(id)
      await runBatched(ids, CHAIN_FETCH_CONCURRENCY, fetchRun)
    }
  },
  chainLoadLimit: {},
  async loadEarlierSessions(runId) {
    const projectId = get().runs[runId]?.summary.projectId || get().selectedProjectId || ''
    const key = chainKeyOf(summariesOf(get(), projectId), runId)
    set((s) => ({ chainLoadLimit: { ...s.chainLoadLimit, [key]: (s.chainLoadLimit[key] ?? CHAIN_EAGER_MEMBERS) + CHAIN_EAGER_MEMBERS } }))
    await get().loadChain(runId)
  },
  historyByProject: {},
  usage: null,
  usageByConnection: {},
  appInfo: null,
  connections: null,
  connectionsError: null,
  models: {},
  modelsError: {},
  login: null,
  remapNotices: [],
  importRequest: null,
  importNotices: {},
  proposalNextByRun: {},
  proposalOutcomes: {},
  rulesChangedByProject: {},
  teamFilesByProject: {},
  setTeamFilesStatus(status) {
    set((s) => ({ teamFilesByProject: { ...s.teamFilesByProject, [status.projectId]: status } }))
  },
  async loadTeamFilesAttention() {
    try {
      const list = await window.orgai.teamFiles.listAttention()
      set((s) => {
        const next = { ...s.teamFilesByProject }
        for (const st of list) next[st.projectId] = st
        return { teamFilesByProject: next }
      })
    } catch {
      /* optional: the Team tab loads its own status */
    }
  },
  async refreshTeamFiles(projectId) {
    try {
      const status = await window.orgai.teamFiles.status({ projectId })
      get().setTeamFilesStatus(status)
      return status
    } catch {
      return null
    }
  },

  defaultConnection: null,
  defaultConnectionChosen: null,
  defaultConnectionStored: null,
  defaultConnectionChanges: 0,
  async loadDefaultConnection() {
    if (!defaultConnectionWatch) {
      // Another window, the Connections pane or main's automatic rewrite changed the default: re-read the effective one.
      defaultConnectionWatch = window.orgai.onSettingsChanged((n) => {
        set({ defaultConnectionChosen: n.defaultConnectionChosen === true, defaultConnectionStored: n.defaultConnection ?? null })
        scheduleConnectionsReload()
      })
    }
    await Promise.all([
      get().loadConnections(),
      window.orgai.settings
        .get()
        .then((s) => set({ defaultConnectionChosen: s.defaultConnectionChosen === true, defaultConnectionStored: s.defaultConnection ?? null }))
        .catch(() => undefined)
    ])
  },
  async setDefaultConnection(id) {
    // connections:setDefault is the only way to change the default (settings:set keeps it); it rejects with a
    // readable refusal ("OpenAI is not connected. ...") that callers show inline. null returns to automatic.
    const connections = await window.orgai.connections.setDefault(id)
    const effective = effectiveDefaultOf(connections)
    set((s) => ({
      connections,
      defaultConnection: effective,
      defaultConnectionChosen: id !== null,
      defaultConnectionStored: id ?? effective ?? s.defaultConnectionStored,
      defaultConnectionChanges: s.defaultConnectionChanges + 1
    }))
  },

  async loadAppInfo() {
    if (get().appInfo) return
    try {
      set({ appInfo: await window.orgai.app.info() })
    } catch {
      /* optional diagnostics; the mock toggle just stays hidden */
    }
  },

  async loadConnections() {
    try {
      const connections = await window.orgai.connections.list()
      set({ connections, connectionsError: null, defaultConnection: effectiveDefaultOf(connections) })
    } catch (e) {
      set({ connectionsError: (e as Error).message })
    }
  },

  async loadModels(id, refresh) {
    try {
      const list = refresh ? await window.orgai.models.refresh({ connection: id }) : await window.orgai.models.list({ connection: id })
      set((s) => ({ models: { ...s.models, [id]: list }, modelsError: { ...s.modelsError, [id]: undefined } }))
    } catch (e) {
      set((s) => ({ modelsError: { ...s.modelsError, [id]: (e as Error).message } }))
    }
  },

  setConnectionInfo(info) {
    set((s) => {
      const list = s.connections ?? []
      const exists = list.some((c) => c.connection.id === info.connection.id)
      // Keep the list's isDefault flags until the reload lands, so two cards never claim the default at once.
      return { connections: exists ? list.map((c) => (c.connection.id === info.connection.id ? { ...info, isDefault: c.isDefault } : c)) : [...list, info] }
    })
    // One edited record can carry a stale isDefault next to the others: re-read the whole list.
    scheduleConnectionsReload()
  },

  pushRemapNotice(cause, results, before) {
    const described = describeRemap(results, get().projects)
    if (described.length === 0) return
    const notice: RemapNoticeState = {
      id: `remap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      cause,
      at: Date.now(),
      projects: described.map((d) => {
        const snap = before.find((p) => p.id === d.projectId)
        return { ...d, before: snap ? { roles: snap.roles, provider: snap.provider } : undefined, undo: snap ? 'available' : 'gone' }
      })
    }
    set((s) => ({ remapNotices: [notice, ...s.remapNotices].slice(0, 10) }))
  },

  dismissRemapNotice(id) {
    set((s) => ({ remapNotices: s.remapNotices.filter((n) => n.id !== id) }))
  },

  requestImport(request) {
    set({ importRequest: request })
  },

  recordImport(projectId, notice) {
    set((s) => ({ importNotices: { ...s.importNotices, [projectId]: { ...notice, state: 'available' } } }))
  },

  async undoImport(projectId) {
    const notice = get().importNotices[projectId]
    const current = get().projects.find((p) => p.id === projectId)
    if (!notice || !current) return
    if (JSON.stringify(current.roles) !== JSON.stringify(notice.importedRoles)) {
      // The chart changed since the import: restoring the old one would drop those edits.
      set((s) => ({ importNotices: { ...s.importNotices, [projectId]: { ...notice, state: 'expired', error: undefined } } }))
      return
    }
    const patch = (p: Partial<ImportNotice>): void => set((s) => ({ importNotices: { ...s.importNotices, [projectId]: { ...s.importNotices[projectId], ...p } } }))
    patch({ state: 'busy', error: undefined })
    try {
      await get().saveProjectNow({ ...current, roles: notice.previousRoles })
      patch({ state: 'reverted' })
    } catch (e) {
      patch({ state: 'error', error: cleanIpcError(e) })
    }
  },

  dismissImportNotice(projectId) {
    set((s) => {
      const { [projectId]: _gone, ...importNotices } = s.importNotices
      return { importNotices }
    })
  },

  async undoRemap(noticeId, projectId) {
    const patchEntry = (patch: Partial<RemapNoticeState['projects'][number]>): void =>
      set((s) => ({
        remapNotices: s.remapNotices.map((n) =>
          n.id === noticeId ? { ...n, projects: n.projects.map((p) => (p.projectId === projectId ? { ...p, ...patch } : p)) } : n
        )
      }))
    const entry = get().remapNotices.find((n) => n.id === noticeId)?.projects.find((p) => p.projectId === projectId)
    const current = get().projects.find((p) => p.id === projectId)
    if (!entry?.before || !current) return
    patchEntry({ undo: 'busy', undoError: undefined })
    try {
      const restore = entry.before
      const roles = current.roles.map((r) => {
        const old = restore.roles.find((x) => x.id === r.id)
        return old ? { ...r, model: old.model, tier: old.tier } : r
      })
      await get().saveProjectNow({ ...current, roles, provider: restore.provider })
      patchEntry({ undo: 'reverted' })
      setTimeout(
        () =>
          set((s) => ({
            remapNotices: s.remapNotices
              .map((n) => (n.id === noticeId ? { ...n, projects: n.projects.filter((p) => p.projectId !== projectId) } : n))
              .filter((n) => n.projects.length > 0)
          })),
        5000
      )
    } catch (e) {
      patchEntry({ undo: 'error', undoError: (e as Error).message })
    }
  },

  async saveProjectNow(project) {
    const saved = await get().trackSave(() => window.orgai.projects.save(project))
    get().replaceProject(saved)
    return saved
  },

  replaceProject(project) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }))
  },

  noteProposalNext(runId, next) {
    set((s) => {
      if (!next) {
        if (!(runId in s.proposalNextByRun)) return {}
        const { [runId]: _gone, ...rest } = s.proposalNextByRun
        return { proposalNextByRun: rest }
      }
      // Servers waiting on a secret are the more useful pointer: a plain "saved" note never replaces it.
      if (next.kind === 'mcpProject' && s.proposalNextByRun[runId]?.kind === 'mcpSecrets') return {}
      return { proposalNextByRun: { ...s.proposalNextByRun, [runId]: next } }
    })
  },

  setRunLayout(runId, layout) {
    set((s) => ({ runLayoutByRun: { ...s.runLayoutByRun, [runId]: layout } }))
  },

  setSideTab(tab) {
    const runId = activeRun(get())?.summary.id
    if (runId) set((s) => ({ sideTabByRun: { ...s.sideTabByRun, [runId]: tab } }))
  },

  patchRunKnowledge(runId, patch) {
    set((s) => {
      const projectId = s.runs[runId]?.summary.projectId ?? ''
      const key = chainKeyOf(summariesOf(s, projectId), runId)
      const cur = s.runKnowledgeByChain[key] ?? EMPTY_RUN_KNOWLEDGE
      return { runKnowledgeByChain: { ...s.runKnowledgeByChain, [key]: { ...cur, ...patch } } }
    })
  },

  openRunKnowledge(runId, request) {
    get().patchRunKnowledge(runId, request ? { request, query: '', openId: null, stack: [] } : {})
    set((s) => ({ sideTabByRun: { ...s.sideTabByRun, [runId]: 'knowledge' } }))
  },

  setComposerDraft(key, draft) {
    set((s) => {
      if (isDraftEmpty(draft)) {
        if (!s.composerDrafts[key]) return {}
        const { [key]: _gone, ...rest } = s.composerDrafts
        return { composerDrafts: rest }
      }
      return { composerDrafts: { ...s.composerDrafts, [key]: draft } }
    })
  },

  clearDecisionFocus() {
    set({ pendingDecisionFocus: null, pendingDecisionRequest: null })
  },

  async continueFromHistory(runId, projectId) {
    // From the Dashboard no project is selected yet: select it and load the run first (H1).
    if (projectId && get().selectedProjectId !== projectId) await get().focusRun(projectId, runId)
    // Continue acts on the chain's newest member, which is the run the tab shows.
    const s = get()
    const newest = chainOf(summariesOf(s, s.selectedProjectId ?? ''), runId).at(-1)?.id ?? runId
    set({ continueIntent: newest })
    await get().openRun(runId)
    // L6: openRun can return early (a newer click, an unknown run); a stale intent must not fire on a later open.
    const after = get()
    const shown = after.selectedProjectId ? after.activeRunByProject[after.selectedProjectId] : undefined
    const showsChain = !!shown && chainOf(summariesOf(after, after.selectedProjectId ?? ''), newest).some((m) => m.id === shown)
    if (!showsChain) {
      set((st) => (st.continueIntent === newest ? { continueIntent: null } : {}))
      return
    }
    get().focusComposer()
  },

  openDraft() {
    const id = get().selectedProjectId
    if (!id) return
    set((s) => ({ draftPage: { ...s.draftPage, [id]: true as const }, view: 'run' }))
  },

  closeDraft() {
    const id = get().selectedProjectId
    if (!id) return
    set((s) => {
      const { [id]: _d, ...draftPage } = s.draftPage
      const { [newRunDraftKey(id)]: _text, ...composerDrafts } = s.composerDrafts
      return { draftPage, composerDrafts }
    })
    void settleWorkspace(id)
  },

  async ensureWorkspace() {
    const id = get().selectedProjectId
    if (id) await settleWorkspace(id)
  },

  async loadVirtualProject(id) {
    const known = get().virtualProjects[id]
    if (known) return known
    const loaded = await window.orgai.projects.get(id).catch(() => null)
    // An older main process answers null: render a display project (label, no folder, no roles).
    const project: Project = loaded ?? displayProject(id)
    set((s) => ({ virtualProjects: { ...s.virtualProjects, [id]: s.virtualProjects[id] ?? project } }))
    return get().virtualProjects[id] ?? project
  },

  clearAssistantSeed(id) {
    set((s) => {
      if (!(id in s.assistantSeed)) return {}
      const { [id]: _seed, ...assistantSeed } = s.assistantSeed
      return { assistantSeed }
    })
  },

  async openAssistant(id, opts) {
    await get().loadVirtualProject(id)
    const instruction = opts?.instruction
    if (instruction) set((s) => ({ assistantSeed: { ...s.assistantSeed, [id]: instruction } }))
    // A seeded instruction or a fresh entry belongs on the start page, not behind a run. Set it before selecting, so
    // the workspace settling that selectProject starts cannot open a run over it.
    const fresh = Boolean(instruction || opts?.fresh)
    if (fresh) set((s) => ({ draftPage: { ...s.draftPage, [id]: true as const } }))
    if (get().selectedProjectId !== id) get().selectProject(id)
    set({ view: 'run' })
    await get().loadHistory()
    if (fresh) {
      if (!get().draftPage[id]) set((s) => ({ draftPage: { ...s.draftPage, [id]: true as const } }))
      return
    }
    const s = get()
    const target = assistantRunToOpen(runsOfProject(s, id), s.activeRunByProject[id])
    if (target) await get().openRun(target)
    else get().openDraft()
  },

  async openProject(projectId) {
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    await get().loadHistory()
    const remembered = await restoreOpenTabs(projectId)
    const s = get()
    const target = defaultRunToOpen(runsOfProject(s, projectId), s.historyByProject[projectId] ?? [], s.activeRunByProject[projectId] ?? remembered)
    if (target) await get().openRun(target)
    else get().openDraft()
    markTabsRestored(projectId)
  },

  async jumpToDecision(projectId, runId, requestId) {
    await get().focusRun(projectId, runId)
    if (isTeamSurfaceRun(get().runs[runId]?.summary)) {
      // A Team-tab Architect session: the Team tray switches to Design and focuses that card.
      useTeamAssistantStore.getState().requestDesign(projectId, runId, requestId ?? null)
      return
    }
    set({ pendingDecisionFocus: runId, pendingDecisionRequest: requestId ?? null })
  },

  async refreshUsage() {
    try {
      const usage = await window.orgai.usage.refresh()
      if (usage) set((st) => putUsage(st, usage))
    } catch {
      /* provider could not report usage */
    }
  },

  async init() {
    // React StrictMode mounts twice in development; subscribing twice would double every transcript entry.
    if (unsubscribeEvents) return
    unsubscribeEvents = window.orgai.onRunEvent((e) => get().handleEvent(e))
    window.orgai.onFocusRun(({ projectId, runId }) => void get().focusRun(projectId, runId))
    window.orgai.onConnectionEvent((e) => get().handleConnectionEvent(e))
    // Team files: the push keeps every known status fresh; listAttention seeds the ones that need the user.
    window.orgai.onTeamFilesChanged?.((status) => get().setTeamFilesStatus(status))
    void get().loadTeamFilesAttention()
    await get().loadProjects()
    void get().loadAllHistory()
    void get().loadConnections()
    // Runs already live in the main process (a second window, or this window after a reload): show them everywhere.
    await get().loadLiveRuns()
    // A window opened for one run carries its target in the hash.
    const target = parseRunWindowHash(window.location.hash)
    if (target) await get().focusRun(target.projectId, target.runId)
    try {
      const auth = await window.orgai.auth.status()
      set({ auth })
    } catch {
      set({ auth: { loggedIn: false, mode: 'subscription' } })
    }
  },

  async loadProjects() {
    const projects = await window.orgai.projects.list()
    set({ projects })
  },

  selectProject(id) {
    const changed = get().selectedProjectId !== id
    set({
      selectedProjectId: id,
      selectedRoleId: null,
      selectedAgentId: changed ? null : get().selectedAgentId,
      draftResult: null,
      draftError: null,
      ...(changed ? { history: get().historyByProject[id ?? ''] ?? [] } : {})
    })
    if (id) void settleWorkspace(id)
  },

  setView(requested) {
    // A remembered or stale 'org' (the tab's old id) opens Team.
    const view = normalizeView<View>(requested)
    set((s) => {
      const id = view === 'run' ? activeRun(s)?.summary.id : undefined
      if (!id || !s.unreadByRun[id]) return { view }
      const { [id]: _read, ...unreadByRun } = s.unreadByRun
      return { view, unreadByRun }
    })
  },

  setSaveStatus(status) {
    set({ saveStatus: status })
  },

  /** Wraps an autosaving call: shows "Saving…", then "Saved HH:MM" or the error. */
  async trackSave<T>(fn: () => Promise<T>): Promise<T> {
    set({ saveStatus: { state: 'saving' } })
    try {
      const out = await fn()
      set({ saveStatus: { state: 'saved', at: Date.now() } })
      return out
    } catch (e) {
      set({ saveStatus: { state: 'error', at: Date.now(), message: (e as Error).message } })
      throw e
    }
  },

  selectRole(id) {
    set({ selectedRoleId: id })
  },

  selectAgent(id) {
    set({ selectedAgentId: id })
  },

  async createProject(input, opts) {
    const { client, referenceDirectories, ...createInput } = input
    const project = await window.orgai.projects.create(createInput)
    const land = (): void => set({ selectedProjectId: project.id, view: 'team' })
    set((s) => ({ projects: [project, ...s.projects] }))
    // client and reference folders are not part of ProjectCreateInput: one direct save right after create. A failure
    // keeps the project in the list but does not land on it: the callback fires, the form shows the error
    // and the caller selects the project itself when the user chooses to open it.
    if (client || (referenceDirectories && referenceDirectories.length > 0)) {
      try {
        const saved = await get().saveProjectNow({
          ...project,
          ...(client ? { client } : {}),
          ...(referenceDirectories && referenceDirectories.length > 0 ? { referenceDirectories } : {})
        })
        // Main drops folders inside, containing or equal to the project folder (and cleans the rest); say so rather than
        // landing as if they were kept. The form keeps the user there with the note and an Open button.
        const dropped = droppedExtrasMessage(referenceDirectories ?? [], saved, client)
        if (dropped) {
          opts?.onExtrasError?.(new Error(dropped))
          return saved
        }
        land()
        return saved
      } catch (err) {
        opts?.onExtrasError?.(err)
        return project
      }
    }
    land()
    return project
  },

  updateProject(project) {
    set((s) => {
      const notice = s.importNotices[project.id]
      // The first chart edit after an import ends Undo: it would discard that edit.
      const expire =
        notice && (notice.state === 'available' || notice.state === 'error') && JSON.stringify(project.roles) !== JSON.stringify(notice.importedRoles)
      return {
        projects: s.projects.map((p) => (p.id === project.id ? project : p)),
        ...(expire ? { importNotices: { ...s.importNotices, [project.id]: { ...notice, state: 'expired' as const, error: undefined } } } : {})
      }
    })
    debouncedSave(project)
  },

  updateRoles(projectId, mutate) {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project) return
    get().updateProject({ ...project, roles: mutate(project.roles) })
  },

  forgetNotice: null,

  setForgetNotice(notice) {
    set({ forgetNotice: notice })
  },

  templates: null,
  templatesError: null,

  async loadTemplates() {
    try {
      const templates = await window.orgai.templates.list()
      set({ templates, templatesError: null })
    } catch (e) {
      set({ templatesError: cleanIpcError(e) })
    }
  },

  async saveTemplate(input) {
    const saved = await window.orgai.templates.saveFromProject(input)
    await get().loadTemplates()
    return saved
  },

  async removeTemplate(templateId) {
    const templates = await window.orgai.templates.remove(templateId)
    set({ templates, templatesError: null })
  },

  async applyTemplate(projectId, template) {
    const result = await window.orgai.templates.apply({ projectId, templateId: template.id, mode: 'replace' })
    get().replaceProject(result.project)
    // The newer notice replaces an import notice: one Undo per chart.
    get().recordImport(projectId, {
      source: 'template',
      count: result.project.roles.length,
      summary: `Team replaced with ${template.name}.`,
      previousRoles: result.previousRoles,
      importedRoles: result.project.roles
    })
  },

  async removeProject(id) {
    const result = await window.orgai.projects.remove(id)
    clearKnowledgePrefs(id)
    set((s) => {
      // H2: the project's runs go with it, so the Dashboard (attention column, hero, tiles, Cost card) stops counting them.
      const gone = new Set<string>()
      for (const r of Object.values(s.runs)) if (r.summary.projectId === id) gone.add(r.summary.id)
      for (const h of s.historyByProject[id] ?? []) gone.add(h.id)
      const { [id]: _hist, ...historyByProject } = s.historyByProject
      const { [id]: _active, ...activeRunByProject } = s.activeRunByProject
      const { [id]: _draft, ...draftPage } = s.draftPage
      const runs = Object.fromEntries(Object.entries(s.runs).filter(([runId]) => !gone.has(runId)))
      const dismissedRuns = Object.fromEntries(Object.entries(s.dismissedRuns).filter(([runId]) => !gone.has(runId))) as Record<string, true>
      const knowledgeRecalledByRun = Object.fromEntries(Object.entries(s.knowledgeRecalledByRun).filter(([runId]) => !gone.has(runId)))
      const sideTabByRun = Object.fromEntries(Object.entries(s.sideTabByRun).filter(([runId]) => !gone.has(runId)))
      // Keyed by the chain's oldest member, a run id of the project.
      const runKnowledgeByChain = Object.fromEntries(Object.entries(s.runKnowledgeByChain).filter(([chain]) => !gone.has(chain)))
      const wasSelected = s.selectedProjectId === id
      return {
        projects: s.projects.filter((p) => p.id !== id),
        selectedProjectId: wasSelected ? null : s.selectedProjectId,
        view: wasSelected ? 'projects' : s.view,
        historyByProject,
        activeRunByProject,
        draftPage,
        runs,
        dismissedRuns,
        knowledgeRecalledByRun,
        sideTabByRun,
        runKnowledgeByChain,
        ...(wasSelected ? { history: [] } : {})
      }
    })
    return result
  },

  history: [],

  async loadHistory() {
    const project = selectedProject(get())
    if (!project) {
      set({ history: [] })
      return
    }
    const history = (await window.orgai.runs.list(project.id)).filter((h) => !isTeamSurfaceRun(h))
    // The selection may have moved while the list was loading.
    set((s) => ({
      historyByProject: { ...s.historyByProject, [project.id]: history },
      ...(s.selectedProjectId === project.id ? { history } : {}),
      ...adoptRowsPatch(s, history)
    }))
  },

  async loadAllHistory() {
    const ids = [...get().projects.map((p) => p.id), ...VIRTUAL_PROJECT_IDS]
    const entries = await Promise.all(ids.map(async (id) => [id, (await window.orgai.runs.list(id).catch(() => [] as RunSummary[])).filter((h) => !isTeamSurfaceRun(h))] as const))
    set((s) => ({ historyByProject: { ...s.historyByProject, ...Object.fromEntries(entries) }, ...adoptRowsPatch(s, entries.flatMap(([, rows]) => rows)) }))
  },

  async openRun(runId) {
    const project = selectedProject(get())
    if (!project) return
    // A slower, older request must not override a newer click in the same project.
    const request = (openRunRequests.get(project.id) ?? 0) + 1
    openRunRequests.set(project.id, request)
    // One conversation per chain: load every member (the feed is complete on first paint), then show the newest.
    await get().loadChain(runId)
    if (openRunRequests.get(project.id) !== request) return
    if (!get().runs[runId]) return
    const members = chainOf(summariesOf(get(), project.id), runId)
    const newestId = [...members].reverse().find((m) => get().runs[m.id])?.id ?? runId
    set((s) => ({ ...showRunPatch(s, project.id, newestId), chainFocusRun: newestId === runId ? null : runId }))
  },

  async loadLiveRuns() {
    try {
      const live = await window.orgai.runs.listLive()
      for (const summary of live) {
        void seedPendingCards(summary.id)
        if (get().runs[summary.id]) continue
        const record = await window.orgai.runs.get(summary.id)
        if (!record) continue
        // Events may have created the run while the record loaded.
        set((s) => (s.runs[summary.id] ? {} : { runs: { ...s.runs, [summary.id]: stateFromRecord(record) } }))
      }
    } catch {
      /* the main process could not list live runs; events still fill the store */
    }
  },

  setTabNotice(message) {
    // Each call owns the notice until a newer one: an older timer never clears it, and a repeat of the same text is
    // cleared first and set again on the next tick so the always-mounted status region reads it again.
    const seq = ++tabNoticeSeq
    const show = (): void => {
      if (seq !== tabNoticeSeq) return
      set({ tabNotice: message })
      setTimeout(() => {
        if (seq === tabNoticeSeq) set((s) => (s.tabNotice === message ? { tabNotice: null } : {}))
      }, 4000)
    }
    if (get().tabNotice === message) {
      set({ tabNotice: null })
      setTimeout(show, 60)
    } else show()
  },

  async startRun(prompt, opts) {
    const project = selectedProject(get())
    // Assistants never start work runs through here (Chat has startQuick, the others their own start calls).
    if (!project || isVirtualProjectId(project.id)) return
    const summary = await window.orgai.runs.start({
      projectId: project.id,
      prompt,
      scaffold: opts?.scaffold,
      images: opts?.images,
      ...(opts?.team === 'single' ? { team: 'single' as const } : {})
    })
    get().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
    set((s) => ({
      // Events may have landed before the IPC call returned; keep them and take the real summary.
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, team: summary.team } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
  },

  async startSetup(instruction) {
    const project = selectedProject(get())
    if (!project) return
    // An engagement has no repository to scan, so the visible prompt and the run title read as a request to begin.
    const text = instruction ?? (projectKindOf(project) === 'engagement' ? 'Set up this project with me.' : undefined)
    const summary = await window.orgai.setup.start({ projectId: project.id, instruction: text })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
    await get().loadProjects()
  },

  openMcpLibrary(libraryId) {
    set({ view: 'appSettings', mcpFocus: { kind: 'library', libraryId } })
  },

  openProjectMcp(projectId, serverId, opts) {
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    // Connections live in Team > Catalog; TeamView opens that tab and the connections section focuses the row.
    set({ view: 'team', mcpFocus: { kind: 'server', projectId, serverId, ...(opts?.edit ? { edit: true } : {}) } })
  },

  setProjectSettingsPane(projectId, pane) {
    set((s) => ({ projectSettingsPane: { ...s.projectSettingsPane, [projectId]: pane } }))
  },

  clearMcpFocus() {
    set({ mcpFocus: null })
  },

  openKnowledgeItem(req) {
    if (get().selectedProjectId !== req.projectId) get().selectProject(req.projectId)
    set({ view: 'knowledge', knowledgeFocus: req })
  },

  clearKnowledgeFocus() {
    set({ knowledgeFocus: null })
  },

  async startLibraryAssist(instruction, allowBuild) {
    const summary = await window.orgai.mcp.startAssist({ scope: 'library', instruction, ...(allowBuild ? { allowBuild: true } : {}) })
    await showStartedAssistant(summary, HARNESS_PROJECT_ID)
    return summary
  },

  async startQuick(input) {
    const summary = await window.orgai.runs.startQuick(input)
    await showStartedAssistant(summary, QUICK_PROJECT_ID)
    return summary
  },

  async startSkillAssist(input) {
    const summary = await window.orgai.skills.startAssist(input)
    // Library scope runs on the Skill assistant row; project scope belongs to the project it was started on.
    const home = input.scope === 'library' || !input.projectId ? SKILLS_PROJECT_ID : summary.projectId || input.projectId
    await showStartedAssistant(summary, home)
    return summary
  },

  async promoteQuick(runId, name) {
    const result = await window.orgai.runs.promoteQuick({ runId, name })
    if (result.kind === 'existing') return result
    const { project, run } = result
    set((s) => ({
      projects: s.projects.some((p) => p.id === project.id) ? s.projects.map((p) => (p.id === project.id ? project : p)) : [...s.projects, project],
      // The run.moved events may not have landed yet: take the new home from the result.
      ...(s.runs[run.id] ? { runs: { ...s.runs, [run.id]: { ...s.runs[run.id], summary: { ...s.runs[run.id].summary, ...run } } } } : {})
    }))
    const history = await window.orgai.runs.list(project.id).catch(() => [run])
    set((s) => ({ historyByProject: { ...s.historyByProject, [project.id]: history.filter((h) => !isTeamSurfaceRun(h)) } }))
    get().selectProject(project.id)
    set({ view: 'run' })
    await get().openRun(run.id)
    return result
  },

  async startMcpAssist(instruction) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.mcp.startAssist({ projectId: project.id, instruction })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
  },

  async startRetro(runId) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.setup.retro({ projectId: project.id, runId })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
    await get().loadProjects()
  },

  async sendMessage(text, images) {
    const run = activeRun(get())
    if (!run) return
    await window.orgai.runs.send({ runId: run.summary.id, text, images })
  },

  async continueRun(fromRunId, text, images) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.runs.continue({ runId: fromRunId, text, images })
    showContinuation(summary)
  },

  async resumeNow(runId) {
    const summary = await window.orgai.runs.resumeNow(runId)
    showContinuation(summary)
  },

  async cancelAutoResume(runId) {
    await window.orgai.runs.cancelAutoResume(runId)
  },

  composerFocusToken: 0,

  focusComposer() {
    set((s) => ({ composerFocusToken: s.composerFocusToken + 1 }))
  },

  async interrupt() {
    const run = activeRun(get())
    if (run) await window.orgai.runs.interrupt(run.summary.id)
  },

  async stopRun() {
    const run = activeRun(get())
    try {
      if (run) await window.orgai.runs.stop(run.summary.id)
    } finally {
      // M3: End session must not strand focus; the composer takes it back, also when the stop call fails.
      get().focusComposer()
    }
  },

  async decide(requestId, decision) {
    const run = activeRun(get())
    if (run) await window.orgai.runs.decide({ runId: run.summary.id, requestId, decision })
  },

  async decideProposal(proposalId, decision) {
    const run = activeRun(get())
    if (run) await window.orgai.setup.decide({ runId: run.summary.id, proposalId, decision })
  },

  async decideRules(requestId, decision) {
    const run = activeRun(get())
    if (run) await window.orgai.permissions.decideRequest({ runId: run.summary.id, requestId, decision })
  },

  async answerQuestion(questionId, answer) {
    const run = activeRun(get())
    if (run) await window.orgai.setup.answer({ runId: run.summary.id, questionId, answer })
  },

  async decideMerge(reviewId, decision) {
    const run = activeRun(get())
    if (run) await window.orgai.runs.decideMerge({ runId: run.summary.id, reviewId, decision })
  },

  handleConnectionEvent(e) {
    switch (e.type) {
      case 'connection.status':
        set((s) => ({
          connections: s.connections?.map((c) => (c.connection.id === e.connection ? { ...c, status: e.status } : c)) ?? s.connections
        }))
        // A connect or disconnect can move the effective default (main decides it).
        scheduleConnectionsReload()
        return
      case 'connection.login':
        set({ login: e.login })
        return
      case 'models.updated':
        // `changed === false`: same model ids as before, so keep the existing list (no re-render); only the
        // refresh time moves. (Remap notices come from projects.remapped, which main sends only on a real change.)
        set((s) => ({
          ...(e.changed === false && s.models[e.connection] ? {} : { models: { ...s.models, [e.connection]: e.models } }),
          modelsError: { ...s.modelsError, [e.connection]: undefined },
          connections:
            e.refreshedAt && s.connections
              ? s.connections.map((c) => (c.connection.id === e.connection ? { ...c, modelsRefreshedAt: e.refreshedAt, modelsError: undefined } : c))
              : s.connections
        }))
        return
      case 'projects.remapped': {
        // Snapshot the renderer copies before reloading, so Undo can restore them.
        const before = get().projects
        const results = e.results.filter((r) => r.changes.length > 0)
        if (results.length === 0) return
        const cause: Record<string, string> = {
          connected: 'after connecting',
          catalog: 'after the model list changed on',
          tierModels: 'after changing the tier mapping on',
          switched: 'after switching connection to',
          manual: 'after a manual update on'
        }
        const first = results[0]
        const name = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }[first.connection]
        void get()
          .loadProjects()
          .then(() => get().pushRemapNotice(`${cause[first.reason] ?? 'after a change to'} ${name}`, results, before))
          .catch(() => undefined)
        return
      }
    }
  },

  handleEvent(e) {
    const rulesProject = rulesChangedProject(e, (runId) => get().runs[runId]?.summary.projectId)
    if (rulesProject) set((s) => ({ rulesChangedByProject: { ...s.rulesChangedByProject, [rulesProject]: (s.rulesChangedByProject[rulesProject] ?? 0) + 1 } }))
    if (e.type === 'project.updated') {
      set((s) => ({ projects: s.projects.map((p) => (p.id === e.project.id ? e.project : p)) }))
      return
    }
    // What agents looked up or were given: ids and time only, kept per run for the Knowledge side tab.
    if (e.type === 'knowledge.recalled') {
      const ev = cleanRecalledEvent(e)
      if (ev) set((s) => ({ knowledgeRecalledByRun: { ...s.knowledgeRecalledByRun, [e.runId]: addRecalled(s.knowledgeRecalledByRun[e.runId], ev) } }))
      return
    }
    // Plan usage is account-wide: keep the latest, whichever run reported it.
    if (e.type === 'usage.status') {
      set((st) => putUsage(st, e.usage))
      return
    }
    // Keep the outcome. A cancelled resolution (run ended) is not the user's choice: it sets no notice and clears none.
    if (e.type === 'proposal.resolved') {
      set((s) => {
        const proposal = s.runs[e.runId]?.proposals.find((p) => p.id === e.proposalId)
        const out: Partial<AppState> = { proposalOutcomes: { ...s.proposalOutcomes, [e.proposalId]: e.decision } }
        const home = s.runs[e.runId]?.summary.projectId
        const next = !e.cancelled && proposal && home ? secretsNextFor(proposal, e.decision, home) : null
        if (next) out.proposalNextByRun = { ...s.proposalNextByRun, [e.runId]: next }
        return out
      })
    }
    // A note from another run: the transcript already carries it (a persisted system row); here it only marks the tab unread.
    if (e.type === 'run.message') {
      if (e.direction === 'in') {
        set((s) => {
          const looking = s.view === 'run' && activeRun(s)?.summary.id === e.runId
          // A run we never loaded (or one that already ended) has no tab to mark.
          const known = s.runs[e.runId]
          return looking || !known || !isRunLive(known) ? {} : { unreadByRun: { ...s.unreadByRun, [e.runId]: (s.unreadByRun[e.runId] ?? 0) + 1 } }
        })
      }
      return
    }
    // A promoted quick run: the run (and its history row) now belongs to the new project.
    if (e.type === 'run.moved') {
      set((s) => {
        const move = (list: RunSummary[] | undefined): RunSummary[] | undefined => list?.map((h) => (h.id === e.runId ? { ...h, projectId: e.projectId } : h))
        const row = (s.historyByProject[e.fromProjectId] ?? []).find((h) => h.id === e.runId) ?? s.runs[e.runId]?.summary
        const historyByProject = { ...s.historyByProject }
        if (historyByProject[e.fromProjectId]) historyByProject[e.fromProjectId] = historyByProject[e.fromProjectId].filter((h) => h.id !== e.runId)
        if (row) {
          const target = move(historyByProject[e.projectId]) ?? []
          historyByProject[e.projectId] = target.some((h) => h.id === e.runId) ? target : [{ ...row, projectId: e.projectId }, ...target].sort((a, b) => b.startedAt - a.startedAt)
        }
        const run = s.runs[e.runId]
        const activeRunByProject = { ...s.activeRunByProject }
        if (activeRunByProject[e.fromProjectId] === e.runId) delete activeRunByProject[e.fromProjectId]
        return {
          historyByProject,
          activeRunByProject,
          ...(run ? { runs: { ...s.runs, [e.runId]: { ...run, summary: { ...run.summary, projectId: e.projectId } } } } : {}),
          ...(s.selectedProjectId ? { history: historyByProject[s.selectedProjectId] ?? s.history } : {})
        }
      })
      return
    }
    set((s) => {
      const existing = s.runs[e.runId]
      // A title for a run the store never loaded: the record already carries it when fetched. No placeholder run.
      if (e.type === 'run.title' && !existing) {
        const title = e.title
        return {
          history: withRunTitle(s.history, e.runId, title),
          historyByProject: Object.fromEntries(Object.entries(s.historyByProject).map(([id, list]) => [id, withRunTitle(list, e.runId, title)]))
        }
      }
      const run: RunState = existing
        ? { ...existing }
        : emptyRun({ id: e.runId, projectId: '', kind: 'work', prompt: '', status: 'starting', startedAt: Date.now(), totalCostUsd: 0 })
      // A run nobody opened yet (another run of this project, or another project's): fetch its real summary.
      if (!existing) queueMicrotask(() => void get().fillSummary(e.runId))
      switch (e.type) {
        case 'run.status':
          run.summary = {
            ...run.summary,
            status: e.status,
            surface: e.surface ?? run.summary.surface,
            sessionId: e.sessionId ?? run.summary.sessionId,
            error: e.error ?? run.summary.error,
            endedAt: e.status === 'finished' || e.status === 'error' || e.status === 'paused' ? Date.now() : run.summary.endedAt,
            pausedUntil: e.pausedUntil ?? run.summary.pausedUntil,
            pauseReason: e.pauseReason ?? run.summary.pauseReason,
            autoResume: e.autoResume ?? run.summary.autoResume,
            // How it ended, right away (the status word after End session); adoptEndFacts stays the fallback for older events.
            ...statusEventEndFacts(e)
          }
          // A run that ended or paused has no open decisions: main cancels them, and no card keeps live-looking buttons (H4).
          if (e.status === 'finished' || e.status === 'error' || e.status === 'paused') {
            run.permissions = []
            run.proposals = []
            run.questions = []
            run.ruleRequests = []
            run.mergeReviews = []
            run.mcpInstalls = []
            run.mcpResolved = {}
            run.partial = {}
          }
          // H4: an ended run's agents never keep Thinking / Waiting for you (the same object comes back when main already settled them).
          if (e.status === 'finished' || e.status === 'error') run.agents = settleEndedAgents(run.summary, run.agents)
          if (e.status === 'finished' || e.status === 'error' || e.status === 'running' || e.status === 'paused') void get().loadHistory()
          if (e.status === 'finished' || e.status === 'error' || e.status === 'paused') reloadHistoryAfterEnd(run.summary.projectId)
          break
        case 'agent.upsert':
          run.agents = { ...run.agents, [e.agent.id]: e.agent }
          break
        case 'agent.remove': {
          const { [e.agentId]: _removed, ...rest } = run.agents
          run.agents = rest
          break
        }
        case 'agent.partial': {
          const { [e.agentId]: _cleared, ...others } = run.partial
          run.partial = e.text ? { ...others, [e.agentId]: e.text } : others
          break
        }
        case 'transcript':
          // The same entry can arrive twice (duplicate subscription, replay); keep one.
          if (run.transcript.length && run.transcript[run.transcript.length - 1].id === e.entry.id) break
          run.transcript = run.transcript.length > 5000 ? [...run.transcript.slice(-4000), e.entry] : [...run.transcript, e.entry]
          break
        case 'permission.request':
          run.permissions = [...run.permissions, e.request]
          break
        case 'permission.resolved':
          run.permissions = run.permissions.filter((p) => p.id !== e.requestId)
          break
        case 'proposal.request':
          run.proposals = [...run.proposals, e.proposal]
          break
        case 'proposal.resolved':
          run.proposals = run.proposals.filter((p) => p.id !== e.proposalId)
          break
        case 'question.request':
          run.questions = [...(run.questions ?? []), e.question]
          break
        case 'question.resolved':
          run.questions = (run.questions ?? []).filter((q) => q.id !== e.questionId)
          break
        case 'rules.request':
          run.ruleRequests = [...(run.ruleRequests ?? []), e.request]
          break
        case 'rules.resolved':
          run.ruleRequests = (run.ruleRequests ?? []).filter((r) => r.id !== e.requestId)
          break
        case 'merge.request':
          run.mergeReviews = [...(run.mergeReviews ?? []), e.review]
          break
        case 'merge.resolved':
          run.mergeReviews = (run.mergeReviews ?? []).filter((m) => m.id !== e.reviewId)
          break
        case 'run.cost':
          run.summary = { ...run.summary, totalCostUsd: e.totalCostUsd }
          break
        case 'run.usage':
          // The host's usage is the truth for the run; totalCostUsd mirrors it (null = unknown keeps the last figure).
          run.summary = { ...run.summary, usage: e.usage, totalCostUsd: e.usage.costUsd ?? run.summary.totalCostUsd }
          break
        case 'run.title':
          run.summary = { ...run.summary, title: e.title }
          break
        case 'plan.updated':
          run.plan = e.plan
          break
        case 'mcpInstall.request':
          run.mcpInstalls = [...(run.mcpInstalls ?? []).filter((r) => r.id !== e.request.id), e.request]
          break
        case 'mcpInstall.resolved': {
          const request = (run.mcpInstalls ?? []).find((r) => r.id === e.requestId)
          run.mcpInstalls = (run.mcpInstalls ?? []).filter((r) => r.id !== e.requestId)
          // A cancelled request (the run ended) leaves no answered card behind.
          if (request && !e.cancelled) run.mcpResolved = { ...(run.mcpResolved ?? {}), [e.requestId]: { request, outcome: e.outcome } }
          break
        }
        case 'log':
          run.logs = [...run.logs.slice(-300), { at: Date.now(), level: e.level, message: e.message }]
          break
        case 'agent.message': {
          const { type: _type, runId: _runId, ...message } = e
          run.messages = [...(run.messages ?? []).slice(-(MAX_MESSAGES - 1)), message]
          break
        }
      }
      const next: Partial<AppState> = { runs: { ...s.runs, [e.runId]: run } }
      // A title can land after the run ended: the history rows carry it too.
      if (e.type === 'run.title') {
        const withTitle = (list: RunSummary[]): RunSummary[] => withRunTitle(list, e.runId, e.title)
        next.history = withTitle(s.history)
        next.historyByProject = Object.fromEntries(Object.entries(s.historyByProject).map(([id, list]) => [id, withTitle(list)]))
      }
      // Terminal run: its tab no longer has anything unread to show.
      if ((e.type === 'run.status' && (e.status === 'finished' || e.status === 'error')) && s.unreadByRun[e.runId]) {
        const { [e.runId]: _u, ...rest } = s.unreadByRun
        next.unreadByRun = rest
      }
      return next
    })
    // The last open decision resolved (answered or cancelled): hand focus back to the composer (M15).
    if (e.type.endsWith('.resolved') && !e.type.startsWith('mcp')) {
      const st = get()
      const r = st.runs[e.runId]
      if (r && activeRun(st)?.summary.id === e.runId && st.view === 'run' && pendingDecisionCount(r) === 0) get().focusComposer()
    }
    if (e.type === 'mcpInstall.resolved') {
      const st = get()
      const r = st.runs[e.runId]
      if (r && activeRun(st)?.summary.id === e.runId && st.view === 'run' && pendingDecisionCount(r) === 0) get().focusComposer()
    }
  },

  dismissRun(runId) {
    set((s) => {
      const run = s.runs[runId]
      if (!run || isRunLive(run)) return {}
      const projectId = run.summary.projectId
      // Hiding a tab hides its whole chain.
      const dismissedRuns = { ...s.dismissedRuns, [runId]: true as const }
      const unreadByRun = { ...s.unreadByRun }
      for (const m of chainOf(summariesOf(s, projectId), runId)) {
        dismissedRuns[m.id] = true
        delete unreadByRun[m.id]
      }
      delete unreadByRun[runId]
      const tabNotice = HIDDEN_NOTICE
      if (s.activeRunByProject[projectId] !== runId) return { dismissedRuns, unreadByRun, tabNotice }
      // Hiding the viewed tab moves to its right neighbour, else the left one; with no tab left, the New run page.
      const tabs = tabRunsOf(s, projectId)
      const at = tabs.findIndex((r) => r.summary.id === runId)
      const rest = tabs.filter((r) => r.summary.id !== runId)
      const next = rest[Math.min(at, rest.length - 1)]
      const activeRunByProject = { ...s.activeRunByProject }
      if (next) {
        activeRunByProject[projectId] = next.summary.id
        return { dismissedRuns, unreadByRun, activeRunByProject, selectedAgentId: 'root', tabNotice }
      }
      delete activeRunByProject[projectId]
      return { dismissedRuns, unreadByRun, activeRunByProject, draftPage: { ...s.draftPage, [projectId]: true as const }, tabNotice }
    })
    setTimeout(() => set((s) => (s.tabNotice === HIDDEN_NOTICE ? { tabNotice: null } : {})), 5000)
  },

  async focusRun(projectId, runId) {
    if (isVirtualProjectId(projectId)) {
      // A virtual project is not in projects:list, so load it on demand.
      await get().loadVirtualProject(projectId)
    } else if (!get().projects.some((p) => p.id === projectId)) return
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    // L7: the chain key comes from the project's summaries; with History in first the view mounts once under its final key.
    if (get().historyByProject[projectId] === undefined) await get().loadHistory().catch(() => undefined)
    if (!get().runs[runId]) {
      const record = await window.orgai.runs.get(runId).catch(() => null)
      if (record) set((st) => (st.runs[runId] ? {} : { runs: { ...st.runs, [runId]: stateFromRecord(record) } }))
    }
    if (isTeamSurfaceRun(get().runs[runId]?.summary)) {
      // A Team-tab Architect session lives in the Team tray, not on the Live strip: land on the Team tab.
      set({ view: 'team' })
      await seedPendingCards(runId)
      return
    }
    await get().openRun(runId)
    await seedPendingCards(runId)
  },

  async fillSummary(runId) {
    if (summaryLookups.has(runId)) return
    summaryLookups.add(runId)
    try {
      const record = await window.orgai.runs.get(runId)
      if (!record) return
      set((s) => {
        const run = s.runs[runId]
        if (!run) return {}
        const { projectId, kind, prompt, startedAt, resumedFrom, surface } = record.summary
        // Keep live fields (status, cost) from events; take identity fields from the main process.
        const title = run.summary.title ?? record.summary.title
        const summary = { ...run.summary, projectId, kind, prompt, startedAt, ...(resumedFrom ? { resumedFrom } : {}), ...(surface ? { surface } : {}), ...(title ? { title } : {}) }
        const agents = Object.keys(run.agents).length ? run.agents : record.agents
        // A paused run the user is looking at was resumed automatically: follow it to its continuation.
        const viewed = s.activeRunByProject[projectId]
        // A newer member of the viewed chain (auto-resume, a continue from another window) takes the tab: the tab shows the chain's newest member.
        const follow = !!resumedFrom && viewed === resumedFrom
        return {
          runs: { ...s.runs, [runId]: { ...run, summary, agents } },
          ...(follow ? { activeRunByProject: { ...s.activeRunByProject, [projectId]: runId }, selectedAgentId: 'root' } : {})
        }
      })
    } catch {
      // The run vanished; its placeholder simply stays unassigned.
    } finally {
      summaryLookups.delete(runId)
    }
  },

  async draftOrgChart(req) {
    const project = selectedProject(get())
    if (!project) return
    set({ drafting: true, draftError: null, draftResult: null })
    try {
      const result = await window.orgai.draft.orgChart({ ...req, projectId: project.id })
      set({ draftResult: result, drafting: false })
    } catch (e) {
      set({ draftError: (e as Error).message, drafting: false })
    }
  },

  applyDraft() {
    const s = get()
    const project = selectedProject(s)
    if (!project || !s.draftResult) return
    s.updateProject({ ...project, roles: s.draftResult.roles })
    set({ draftResult: null, selectedRoleId: null })
  },

  discardDraft() {
    set({ draftResult: null, draftError: null })
  }
}))

/**
 * Run index (R1, R2, ...) of every known run, per project and stable by start order. Subscribes to a compact
 * key, so it re-renders only when a run appears, not on every event.
 */
export function useRunIndexes(): Map<string, number> {
  const key = useAppStore((s) => {
    const seen = new Map<string, string>()
    for (const [projectId, list] of Object.entries(s.historyByProject)) for (const h of list) seen.set(h.id, `${projectId}/${h.id}@${h.startedAt}`)
    for (const r of Object.values(s.runs)) if (r.summary.projectId && !isTeamSurfaceRun(r.summary)) seen.set(r.summary.id, `${r.summary.projectId}/${r.summary.id}@${r.summary.startedAt}`)
    return [...seen.values()].sort().join('|')
  })
  return useMemo(() => {
    const byProject = new Map<string, { id: string; startedAt: number }[]>()
    for (const part of key.split('|')) {
      if (!part) continue
      const slash = part.indexOf('/')
      const at = part.lastIndexOf('@')
      const projectId = part.slice(0, slash)
      const list = byProject.get(projectId) ?? []
      list.push({ id: part.slice(slash + 1, at), startedAt: Number(part.slice(at + 1)) })
      byProject.set(projectId, list)
    }
    const out = new Map<string, number>()
    for (const list of byProject.values()) for (const [id, n] of runIndexMap(list)) out.set(id, n)
    return out
  }, [key])
}

/** Runs across all projects that wait for the user. Returns a fresh array: use with `useShallow`. */
export const waitingRuns = (s: AppState): RunState[] => Object.values(s.runs).filter((r) => r.summary.projectId && needsYou(r))

/**
 * The loaded members of `runId`'s session chain, oldest first (the run itself included). Members whose records are
 * not loaded yet are missing until `loadChain` fetches them. Chains come from the selected project's summaries.
 */
export function useChainRuns(runId: string | undefined): RunState[] {
  const summaries = useProjectSummaries()
  const runs = useAppStore((s) => s.runs)
  return useMemo(() => {
    if (!runId) return []
    const members = chainOf(summaries, runId)
    const list = (members.length ? members.map((m) => m.id) : [runId]).map((id) => runs[id]).filter((r): r is RunState => !!r)
    return list
  }, [summaries, runs, runId])
}

/** Runs of the selected project that have a tab (not hidden), oldest first. Fresh array: use with `useShallow`. */
export const projectTabRuns = (s: AppState): RunState[] => (s.selectedProjectId ? tabRunsOf(s, s.selectedProjectId) : [])

/**
 * activeRunByProject follows a chain to its newest loaded member: when a newer member enters `runs` (an earlier
 * member was viewed), the pointer moves to it, so no consumer sees a stale older member.
 */
let knownRunCount = 0
useAppStore.subscribe((s, prev) => {
  if (s.runs === prev.runs) return
  const count = Object.keys(s.runs).length
  if (count === knownRunCount) return
  knownRunCount = count
  let next: Record<string, string> | null = null
  for (const [projectId, viewed] of Object.entries(s.activeRunByProject)) {
    if (!s.runs[viewed]) continue
    const newest = chainOf(summariesOf(s, projectId), viewed)
      .reverse()
      .find((m) => s.runs[m.id])
    if (newest && newest.id !== viewed && newest.startedAt > s.runs[viewed].summary.startedAt) next = { ...(next ?? s.activeRunByProject), [projectId]: newest.id }
  }
  if (next) useAppStore.setState({ activeRunByProject: next })
})
