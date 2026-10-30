import { create } from 'zustand'
import { useMemo } from 'react'
import { isOpenStatus } from '../lib/runChains'
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

export type View = 'projects' | 'settings' | 'run' | 'appSettings'
/** 'reply' sends to the viewed session; 'new' starts another run even while one is open. */
export type ComposerMode = 'reply' | 'new'
export type SettingsTab = 'org' | 'project'
/** Tabs of the live view's side panel. */
export type SideTab = 'transcript' | 'plan' | 'logs' | 'runs'

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

function emptyRun(summary: RunSummary): RunState {
  return { summary, agents: {}, transcript: [], permissions: [], proposals: [], questions: [], mergeReviews: [], logs: [], partial: {}, messages: [], mcpInstalls: [], mcpResolved: {} }
}

interface AppState {
  projects: Project[]
  selectedProjectId: string | null
  view: View
  settingsTab: SettingsTab
  selectedRoleId: string | null
  runs: Record<string, RunState>
  activeRunByProject: Record<string, string>
  selectedAgentId: string | null
  auth: AuthStatusResult | null
  drafting: boolean
  draftResult: DraftResult | null
  draftError: string | null
  /** Runs hidden from the run strip (finished runs the user closed). */
  dismissedRuns: Record<string, true>
  composerMode: ComposerMode
  /** Selected tab of the live view's side panel. */
  sideTab: SideTab
  setSideTab(tab: SideTab): void
  /** Latest plan usage reported by any live session. */
  usage: UsageStatus | null
  /** Ask the main process to read plan usage now (no run needed). */
  refreshUsage(): Promise<void>

  /** App-wide connections (records plus live status). null until the first load. */
  /** Static app facts (version, folders, mock availability). null until loaded. */
  appInfo: AppInfo | null
  loadAppInfo(): Promise<void>
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
  setSettingsTab(tab: SettingsTab): void
  selectRole(id: string | null): void
  selectAgent(id: string | null): void
  createProject(input: { name: string; path: string; brief: string; setupKind?: SetupKind }): Promise<Project>
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
  loadHistory(): Promise<void>
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
  decideMerge(reviewId: string, decision: MergeDecision): Promise<void>
  handleEvent(e: RunEvent): void
  /** Replace a placeholder summary (created by an event of an unknown run) with the real one. */
  fillSummary(runId: string): Promise<void>
  setComposerMode(mode: ComposerMode): void
  /** Hide a finished run from the run strip. Stops viewing it if it was the viewed run. */
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
  const t = saveTimers.get(project.id)
  if (t) clearTimeout(t)
  saveTimers.set(
    project.id,
    setTimeout(() => {
      saveTimers.delete(project.id)
      void window.orgai.projects.save(project)
    }, 350)
  )
}

export const selectedProject = (s: AppState): Project | undefined =>
  s.projects.find((p) => p.id === s.selectedProjectId)

export const activeRun = (s: AppState): RunState | undefined => {
  if (!s.selectedProjectId) return undefined
  const runId = s.activeRunByProject[s.selectedProjectId]
  return runId ? s.runs[runId] : undefined
}

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

/** Show a run that continues an earlier one (Continue, Resume now). */
function showContinuation(summary: RunSummary): void {
  const { getState, setState } = useAppStore
  getState().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
  setState((s) => ({
    // Events may have landed before the IPC call returned; keep them and take the real summary.
    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, resumedFrom: summary.resumedFrom } } },
    activeRunByProject: { ...s.activeRunByProject, [summary.projectId]: summary.id },
    selectedAgentId: 'root',
    view: 'run'
  }))
  void getState().loadHistory()
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  view: 'projects',
  settingsTab: 'org',
  selectedRoleId: null,
  runs: {},
  activeRunByProject: {},
  selectedAgentId: null,
  auth: null,
  drafting: false,
  draftResult: null,
  draftError: null,
  dismissedRuns: {},
  composerMode: 'reply',
  sideTab: 'transcript',
  usage: null,
  appInfo: null,
  connections: null,
  connectionsError: null,
  models: {},
  modelsError: {},
  login: null,
  remapNotices: [],

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
    const saved = await window.orgai.projects.save(project)
    get().replaceProject(saved)
    return saved
  },

  replaceProject(project) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }))
  },

  setSideTab(tab) {
    set({ sideTab: tab })
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
    void get().loadConnections()
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
    set({ selectedProjectId: id, selectedRoleId: null, selectedAgentId: null, draftResult: null, draftError: null, history: [], composerMode: 'reply' })
    void get().loadHistory()
  },

  setView(view) {
    set({ view })
  },

  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },

  selectRole(id) {
    set({ selectedRoleId: id })
  },

  selectAgent(id) {
    set({ selectedAgentId: id })
  },

  async createProject(input) {
    const project = await window.orgai.projects.create(input)
    set((s) => ({ projects: [project, ...s.projects], selectedProjectId: project.id, view: 'settings' }))
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
    set({ history })
  },

  async openRun(runId) {
    const project = selectedProject(get())
    if (!project) return
    const live = get().runs[runId]
    if (!live) {
      const record = await window.orgai.runs.get(runId)
      if (!record) return
      set((s) => ({
        runs: { ...s.runs, [runId]: { ...record, permissions: [], proposals: [], questions: [], mergeReviews: [], logs: record.logs, partial: {}, messages: [], mcpInstalls: [], mcpResolved: {} } }
      }))
    }
    set((s) => ({ activeRunByProject: { ...s.activeRunByProject, [project.id]: runId }, selectedAgentId: 'root', view: 'run', composerMode: 'reply' }))
  },

  async startRun(prompt, opts) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.runs.start({ projectId: project.id, prompt, scaffold: opts?.scaffold, images: opts?.images })
    get().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
    set((s) => ({
      // Events may have landed before the IPC call returned; keep them and take the real summary.
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run',
      composerMode: 'reply'
    }))
  },

  async startSetup(instruction) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.setup.start({ projectId: project.id, instruction })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run'
    }))
    await get().loadProjects()
  },

  async startMcpAssist(instruction) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.mcp.startAssist({ projectId: project.id, instruction })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run'
    }))
  },

  async startRetro(runId) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.setup.retro({ projectId: project.id, runId })
    set((s) => ({
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run'
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
    set((s) => {
      const existing = s.runs[e.runId]
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
        case 'merge.request':
          run.mergeReviews = [...(run.mergeReviews ?? []), e.review]
          break
        case 'merge.resolved':
          run.mergeReviews = (run.mergeReviews ?? []).filter((m) => m.id !== e.reviewId)
          break
        case 'run.cost':
          run.summary = { ...run.summary, totalCostUsd: e.totalCostUsd }
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
          if (request) run.mcpResolved = { ...(run.mcpResolved ?? {}), [e.requestId]: { request, outcome: e.outcome } }
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
      return { runs: { ...s.runs, [e.runId]: run } }
    })
  },

  setComposerMode(mode) {
    set({ composerMode: mode })
  },

  dismissRun(runId) {
    set((s) => {
      const projectId = s.runs[runId]?.summary.projectId
      const dismissedRuns = { ...s.dismissedRuns, [runId]: true as const }
      const activeRunByProject = { ...s.activeRunByProject }
      if (projectId && activeRunByProject[projectId] === runId) {
        // Never leave the canvas empty while the project has another run: prefer an open one, else the newest.
        const all = runsOfProject(s, projectId)
        const continued = new Set(all.map((r) => r.summary.resumedFrom).filter(Boolean))
        const rest = all.filter((r) => r.summary.id !== runId && !dismissedRuns[r.summary.id] && !continued.has(r.summary.id))
        const next = rest.find((r) => isOpenStatus(r.summary.status)) ?? rest[0]
        if (next) activeRunByProject[projectId] = next.summary.id
        else delete activeRunByProject[projectId]
        return { dismissedRuns, activeRunByProject, ...(next ? { selectedAgentId: 'root' } : {}) }
      }
      return { dismissedRuns, activeRunByProject }
    })
  },

  async focusRun(projectId, runId) {
    if (!get().projects.some((p) => p.id === projectId)) return
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    set((s) => {
      const { [runId]: _shown, ...dismissedRuns } = s.dismissedRuns
      return { dismissedRuns }
    })
    await get().openRun(runId)
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
        const summary = { ...run.summary, projectId, kind, prompt, startedAt, ...(resumedFrom ? { resumedFrom } : {}) }
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
