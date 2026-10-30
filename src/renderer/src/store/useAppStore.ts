import { create } from 'zustand'
import { useMemo } from 'react'
import { defaultRunToOpen } from '../lib/needsYou'
import { needsYou } from '../lib/runChains'
import { mergePendingCards, type PendingCards } from '../lib/pendingCards'
import { runIndexMap } from '../lib/runLabels'
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
import { HARNESS_PROJECT_ID, parseRunWindowHash } from '@shared/types'

/** Project tabs: run (Live), history, org (Org chart), settings. projects and appSettings are app-level. */
export type View = 'projects' | 'org' | 'settings' | 'run' | 'history' | 'appSettings'
/** Tabs of the live view's side panel. The side tab is remembered per run. */
export type SideTab = 'transcript' | 'plan' | 'logs'

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
export type McpFocus = { kind: 'library'; libraryId?: string } | { kind: 'server'; projectId: string; serverId?: string }

interface AppState {
  projects: Project[]
  /** The virtual project that hosts library assistant runs. It is never in `projects`. */
  harnessProject: Project | null
  mcpFocus: McpFocus | null
  /** Selected project-settings pane per project id (lib/settingsTarget PROJECT_SETTINGS_PANES); absent means General. */
  projectSettingsPane: Record<string, string>
  setProjectSettingsPane(projectId: string, pane: string): void
  /** Show the app settings MCP library, optionally on one entry. */
  openMcpLibrary(libraryId?: string): void
  /** Show a project's settings on its MCP servers section, optionally on one server. */
  openProjectMcp(projectId: string, serverId?: string): void
  clearMcpFocus(): void
  /** Start the library-level MCP assistant (a harness run); resolves with its summary. */
  startLibraryAssist(instruction?: string): Promise<RunSummary>
  selectedProjectId: string | null
  view: View
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
  /** Select the side tab of the viewed run. */
  setSideTab(tab: SideTab): void
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
  /** Run whose composer should open on "Continue this run" (set by History's Continue). */
  continueIntent: string | null
  /** Open a finished run with its composer preset to Continue, and focus the composer. */
  continueFromHistory(runId: string): Promise<void>
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
  /** Ask the main process to read plan usage now (no run needed). */
  refreshUsage(): Promise<void>

  /** App-wide connections (records plus live status). null until the first load. */
  /** Static app facts (version, folders, mock availability). null until loaded. */
  appInfo: AppInfo | null
  loadAppInfo(): Promise<void>
  /** AppSettings.defaultConnection, mirrored for the Connections pane and the new-project form. null until loaded. */
  defaultConnection: ConnectionId | null
  loadDefaultConnection(): Promise<void>
  setDefaultConnection(id: ConnectionId): Promise<void>
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
  createProject(input: { name: string; path: string; brief: string; setupKind?: SetupKind; mock?: boolean }): Promise<Project>
  updateProject(project: Project): void
  updateRoles(projectId: string, mutate: (roles: Role[]) => Role[]): void
  removeProject(id: string): Promise<void>

  startRun(prompt: string, opts?: { scaffold?: boolean; images?: ImageAttachment[] }): Promise<void>
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

export const selectedProject = (s: AppState): Project | undefined =>
  s.selectedProjectId === HARNESS_PROJECT_ID && s.harnessProject ? s.harnessProject : s.projects.find((p) => p.id === s.selectedProjectId)

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
    .filter((r) => r.summary.projectId === projectId)
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
    for (const r of Object.values(runs)) if (r.summary.projectId === projectId) byId.set(r.summary.id, r.summary)
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
  }, [history, runs, projectId])
}

/** State patch that shows a run in its project's workspace: leaves the New run page, un-hides the tab. */
function showRunPatch(s: AppState, projectId: string, runId: string): Partial<AppState> {
  const { [projectId]: _draft, ...draftPage } = s.draftPage
  const { [runId]: _hidden, ...dismissedRuns } = s.dismissedRuns
  const { [runId]: _read, ...unreadByRun } = s.unreadByRun
  return { activeRunByProject: { ...s.activeRunByProject, [projectId]: runId }, selectedAgentId: 'root', view: 'run', draftPage, dismissedRuns, unreadByRun }
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
  return { ...record, permissions: [], proposals: [], questions: [], ruleRequests: [], mergeReviews: [], logs: record.logs, partial: {}, messages: [], mcpInstalls: [], mcpResolved: {} }
}

/** Runs of a project that have a tab (not hidden), oldest first. */
function tabRunsOf(s: AppState, projectId: string): RunState[] {
  return runsOfProject(s, projectId)
    .filter((r) => !s.dismissedRuns[r.summary.id] || s.activeRunByProject[projectId] === r.summary.id)
    .sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.id.localeCompare(b.summary.id))
}

/** Opens the project's newest run (or the New run page) when its workspace shows nothing yet. */
async function settleWorkspace(projectId: string): Promise<void> {
  const { getState, setState } = useAppStore
  await getState().loadHistory()
  const s = getState()
  if (s.selectedProjectId !== projectId || s.draftPage[projectId]) return
  const viewed = s.activeRunByProject[projectId]
  if (viewed && s.runs[viewed]) {
    if (!s.selectedAgentId) setState({ selectedAgentId: 'root' })
    return
  }
  const target = defaultRunToOpen(runsOfProject(s, projectId), s.historyByProject[projectId] ?? [], viewed)
  if (target) await getState().openRun(target)
  else setState((cur) => ({ draftPage: { ...cur.draftPage, [projectId]: true as const } }))
}

/** Show a run that continues an earlier one (Continue, Resume now). */
function showContinuation(summary: RunSummary): void {
  const { getState, setState } = useAppStore
  getState().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
  setState((s) => ({
    // Events may have landed before the IPC call returned; keep them and take the real summary.
    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, resumedFrom: summary.resumedFrom } } },
    ...showRunPatch(s, summary.projectId, summary.id)
  }))
  void getState().loadHistory()
}

let defaultConnectionWatch: (() => void) | null = null

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  harnessProject: null,
  mcpFocus: null,
  projectSettingsPane: {},
  selectedProjectId: null,
  view: 'projects',
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
  tabNotice: null,
  unreadByRun: {},
  pendingDecisionFocus: null,
  pendingDecisionRequest: null,
  continueIntent: null,
  historyByProject: {},
  usage: null,
  appInfo: null,
  connections: null,
  connectionsError: null,
  models: {},
  modelsError: {},
  login: null,
  remapNotices: [],

  defaultConnection: null,
  async loadDefaultConnection() {
    try {
      const s = await window.orgai.settings.get()
      set({ defaultConnection: s.defaultConnection ?? 'anthropic' })
      if (!defaultConnectionWatch) defaultConnectionWatch = window.orgai.onSettingsChanged((n) => set({ defaultConnection: n.defaultConnection ?? 'anthropic' }))
    } catch {
      // Unknown: callers fall back to Anthropic wording.
    }
  },
  async setDefaultConnection(id) {
    const { dataDir: _d, appVersion: _v, ...cur } = await window.orgai.settings.get()
    const saved = await window.orgai.settings.set({ ...cur, defaultConnection: id })
    set({ defaultConnection: saved.defaultConnection ?? id })
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
      set({ connections, connectionsError: null })
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
      return { connections: exists ? list.map((c) => (c.connection.id === info.connection.id ? info : c)) : [...list, info] }
    })
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

  setSideTab(tab) {
    const runId = activeRun(get())?.summary.id
    if (runId) set((s) => ({ sideTabByRun: { ...s.sideTabByRun, [runId]: tab } }))
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

  async continueFromHistory(runId) {
    set({ continueIntent: runId })
    await get().openRun(runId)
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

  async openProject(projectId) {
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    await get().loadHistory()
    const s = get()
    const target = defaultRunToOpen(runsOfProject(s, projectId), s.historyByProject[projectId] ?? [], s.activeRunByProject[projectId])
    if (target) await get().openRun(target)
    else get().openDraft()
  },

  async jumpToDecision(projectId, runId, requestId) {
    await get().focusRun(projectId, runId)
    set({ pendingDecisionFocus: runId, pendingDecisionRequest: requestId ?? null })
  },

  async refreshUsage() {
    try {
      const usage = await window.orgai.usage.refresh()
      if (usage) set({ usage })
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

  setView(view) {
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

  async createProject(input) {
    const project = await window.orgai.projects.create(input)
    set((s) => ({ projects: [project, ...s.projects], selectedProjectId: project.id, view: 'org' }))
    return project
  },

  updateProject(project) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }))
    debouncedSave(project)
  },

  updateRoles(projectId, mutate) {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project) return
    get().updateProject({ ...project, roles: mutate(project.roles) })
  },

  async removeProject(id) {
    await window.orgai.projects.remove(id)
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
      view: s.selectedProjectId === id ? 'projects' : s.view
    }))
  },

  history: [],

  async loadHistory() {
    const project = selectedProject(get())
    if (!project) {
      set({ history: [] })
      return
    }
    const history = await window.orgai.runs.list(project.id)
    // The selection may have moved while the list was loading.
    set((s) => ({ historyByProject: { ...s.historyByProject, [project.id]: history }, ...(s.selectedProjectId === project.id ? { history } : {}) }))
  },

  async loadAllHistory() {
    const entries = await Promise.all(get().projects.map(async (p) => [p.id, await window.orgai.runs.list(p.id).catch(() => [] as RunSummary[])] as const))
    set((s) => ({ historyByProject: { ...s.historyByProject, ...Object.fromEntries(entries) } }))
  },

  async openRun(runId) {
    const project = selectedProject(get())
    if (!project) return
    const live = get().runs[runId]
    if (!live) {
      const record = await window.orgai.runs.get(runId)
      if (!record) return
      set((s) => ({ runs: { ...s.runs, [runId]: stateFromRecord(record) } }))
    }
    set((s) => showRunPatch(s, project.id, runId))
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
    set({ tabNotice: message })
    setTimeout(() => set((s) => (s.tabNotice === message ? { tabNotice: null } : {})), 4000)
  },

  async startRun(prompt, opts) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.runs.start({ projectId: project.id, prompt, scaffold: opts?.scaffold, images: opts?.images })
    get().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
    set((s) => ({
      // Events may have landed before the IPC call returned; keep them and take the real summary.
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
  },

  async startSetup(instruction) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.setup.start({ projectId: project.id, instruction })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))
    await get().loadProjects()
  },

  openMcpLibrary(libraryId) {
    set({ view: 'appSettings', mcpFocus: { kind: 'library', libraryId } })
  },

  openProjectMcp(projectId, serverId) {
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    set((s) => ({ view: 'settings', mcpFocus: { kind: 'server', projectId, serverId }, projectSettingsPane: { ...s.projectSettingsPane, [projectId]: 'tools' } }))
  },

  setProjectSettingsPane(projectId, pane) {
    set((s) => ({ projectSettingsPane: { ...s.projectSettingsPane, [projectId]: pane } }))
  },

  clearMcpFocus() {
    set({ mcpFocus: null })
  },

  async startLibraryAssist(instruction) {
    const summary = await window.orgai.mcp.startAssist({ scope: 'library', instruction })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } }
    }))
    return summary
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
    if (run) await window.orgai.runs.stop(run.summary.id)
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
        return
      case 'connection.login':
        set({ login: e.login })
        return
      case 'models.updated':
        set((s) => ({ models: { ...s.models, [e.connection]: e.models } }))
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
    if (e.type === 'project.updated') {
      set((s) => ({ projects: s.projects.map((p) => (p.id === e.project.id ? e.project : p)) }))
      return
    }
    // Plan usage is account-wide: keep the latest, whichever run reported it.
    if (e.type === 'usage.status') {
      set({ usage: e.usage })
      return
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
            sessionId: e.sessionId ?? run.summary.sessionId,
            error: e.error ?? run.summary.error,
            endedAt: e.status === 'finished' || e.status === 'error' || e.status === 'paused' ? Date.now() : run.summary.endedAt,
            pausedUntil: e.pausedUntil ?? run.summary.pausedUntil,
            pauseReason: e.pauseReason ?? run.summary.pauseReason,
            autoResume: e.autoResume ?? run.summary.autoResume
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
          if (e.status === 'finished' || e.status === 'error' || e.status === 'running' || e.status === 'paused') void get().loadHistory()
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
      const dismissedRuns = { ...s.dismissedRuns, [runId]: true as const }
      const { [runId]: _unread, ...unreadByRun } = s.unreadByRun
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
    if (projectId === HARNESS_PROJECT_ID) {
      // The harness project is virtual: it is not in projects:list, so load it on demand.
      if (!get().harnessProject) {
        const harness = await window.orgai.projects.get(HARNESS_PROJECT_ID).catch(() => null)
        if (!harness) return
        set({ harnessProject: harness })
      }
    } else if (!get().projects.some((p) => p.id === projectId)) return
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
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
        const { projectId, kind, prompt, startedAt, resumedFrom } = record.summary
        // Keep live fields (status, cost) from events; take identity fields from the main process.
        const title = run.summary.title ?? record.summary.title
        const summary = { ...run.summary, projectId, kind, prompt, startedAt, ...(resumedFrom ? { resumedFrom } : {}), ...(title ? { title } : {}) }
        const agents = Object.keys(run.agents).length ? run.agents : record.agents
        // A paused run the user is looking at was resumed automatically: follow it to its continuation.
        const viewed = s.activeRunByProject[projectId]
        const follow = !!resumedFrom && viewed === resumedFrom && s.runs[resumedFrom]?.summary.pausedUntil !== undefined
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
    for (const r of Object.values(s.runs)) if (r.summary.projectId) seen.set(r.summary.id, `${r.summary.projectId}/${r.summary.id}@${r.summary.startedAt}`)
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

/** Runs of the selected project that have a tab (not hidden), oldest first. Fresh array: use with `useShallow`. */
export const projectTabRuns = (s: AppState): RunState[] => (s.selectedProjectId ? tabRunsOf(s, s.selectedProjectId) : [])
