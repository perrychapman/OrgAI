import { create } from 'zustand'
import type {
  AgentInstance,
  DraftRequest,
  DraftResult,
  PermissionDecision,
  PermissionRequest,
  Project,
  Proposal,
  ProposalDecision,
  Role,
  RunEvent,
  RunSummary,
  SetupKind,
  TranscriptEntry
} from '@shared/types'

export type View = 'projects' | 'settings' | 'run'
export type SettingsTab = 'org' | 'project'

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
  logs: LogLine[]
  /** agent id -> text it is streaming right now. Live only, never persisted. */
  partial: Record<string, string>
}

function emptyRun(summary: RunSummary): RunState {
  return { summary, agents: {}, transcript: [], permissions: [], proposals: [], logs: [], partial: {} }
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
  auth: { loggedIn: boolean; method?: string; detail?: string } | null
  drafting: boolean
  draftResult: DraftResult | null
  draftError: string | null

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

  startRun(prompt: string, opts?: { scaffold?: boolean }): Promise<void>
  /** Start an Architect session for the selected project. */
  startSetup(instruction?: string): Promise<void>
  /** Past runs of the selected project, newest first. */
  history: RunSummary[]
  loadHistory(): Promise<void>
  /** Show a past run on the canvas. */
  openRun(runId: string): Promise<void>
  sendMessage(text: string): Promise<void>
  interrupt(): Promise<void>
  stopRun(): Promise<void>
  decide(requestId: string, decision: PermissionDecision): Promise<void>
  decideProposal(proposalId: string, decision: ProposalDecision): Promise<void>
  handleEvent(e: RunEvent): void

  draftOrgChart(req: Omit<DraftRequest, 'projectId'>): Promise<void>
  applyDraft(): void
  discardDraft(): void
}

let unsubscribeEvents: (() => void) | null = null
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

  async init() {
    // React StrictMode mounts twice in development; subscribing twice would double every transcript entry.
    if (unsubscribeEvents) return
    unsubscribeEvents = window.orgai.onRunEvent((e) => get().handleEvent(e))
    await get().loadProjects()
    try {
      const auth = await window.orgai.auth.status()
      set({ auth })
    } catch {
      set({ auth: { loggedIn: false } })
    }
  },

  async loadProjects() {
    const projects = await window.orgai.projects.list()
    set({ projects })
  },

  selectProject(id) {
    set({ selectedProjectId: id, selectedRoleId: null, selectedAgentId: null, draftResult: null, draftError: null, history: [] })
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
        runs: { ...s.runs, [runId]: { ...record, permissions: [], proposals: [], logs: record.logs, partial: {} } }
      }))
    }
    set((s) => ({ activeRunByProject: { ...s.activeRunByProject, [project.id]: runId }, selectedAgentId: 'root', view: 'run' }))
  },

  async startRun(prompt, opts) {
    const project = selectedProject(get())
    if (!project) return
    const summary = await window.orgai.runs.start({ projectId: project.id, prompt, scaffold: opts?.scaffold })
    get().handleEvent({ type: 'run.status', runId: summary.id, status: summary.status })
    set((s) => ({
      // Events may have landed before the IPC call returned; keep them and take the real summary.
      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run'
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

  async sendMessage(text) {
    const run = activeRun(get())
    if (!run) return
    await window.orgai.runs.send({ runId: run.summary.id, text })
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

  handleEvent(e) {
    if (e.type === 'project.updated') {
      set((s) => ({ projects: s.projects.map((p) => (p.id === e.project.id ? e.project : p)) }))
      return
    }
    set((s) => {
      const existing = s.runs[e.runId]
      const run: RunState = existing
        ? { ...existing }
        : emptyRun({ id: e.runId, projectId: s.selectedProjectId ?? '', kind: 'work', prompt: '', status: 'starting', startedAt: Date.now(), totalCostUsd: 0 })
      switch (e.type) {
        case 'run.status':
          run.summary = {
            ...run.summary,
            status: e.status,
            sessionId: e.sessionId ?? run.summary.sessionId,
            error: e.error ?? run.summary.error,
            endedAt: e.status === 'finished' || e.status === 'error' ? Date.now() : run.summary.endedAt
          }
          if (e.status === 'finished' || e.status === 'error' || e.status === 'running') void get().loadHistory()
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
        case 'run.cost':
          run.summary = { ...run.summary, totalCostUsd: e.totalCostUsd }
          break
        case 'log':
          run.logs = [...run.logs.slice(-300), { at: Date.now(), level: e.level, message: e.message }]
          break
      }
      return { runs: { ...s.runs, [e.runId]: run } }
    })
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
