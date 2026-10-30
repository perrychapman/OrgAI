import fs from 'node:fs'
const p = 'src/renderer/src/store/useAppStore.ts'
let s = fs.readFileSync(p, 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10))
function rep(a, b) {
  if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80))
  s = s.replace(a, () => b)
}
rep("import { isOpenStatus } from '../lib/runChains'", "import { defaultRunToOpen } from '../lib/needsYou'")
rep(`export type View = 'projects' | 'settings' | 'run' | 'appSettings'
/** 'reply' sends to the viewed session; 'new' starts another run even while one is open. */
export type ComposerMode = 'reply' | 'new'
export type SettingsTab = 'org' | 'project'
/** Tabs of the live view's side panel. */
export type SideTab = 'transcript' | 'plan' | 'logs' | 'runs'`, `export type View = 'projects' | 'settings' | 'run' | 'history' | 'appSettings'
export type SettingsTab = 'org' | 'project'
/** Tabs of the live view's side panel. The side tab is remembered per run. */
export type SideTab = 'transcript' | 'plan' | 'logs'

/** A half-typed message. Kept per run (and per project for the New run page) so it survives tab switches. */
export interface ComposerDraft {
  text: string
  images: ImageAttachment[]
}
/** Key of the New run page's draft for a project. Run drafts use the run id. */
export const newRunDraftKey = (projectId: string): string => \`new:\${projectId}\`
export const isDraftEmpty = (d: ComposerDraft | undefined): boolean => !d || (d.text.trim().length === 0 && d.images.length === 0)`)
rep(`  /** Runs hidden from the run strip (finished runs the user closed). */
  dismissedRuns: Record<string, true>
  composerMode: ComposerMode
  /** Selected tab of the live view's side panel. */
  sideTab: SideTab
  setSideTab(tab: SideTab): void`, `  /** Runs hidden from the run tabs (finished runs the user closed). They stay reachable in History. */
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
  /** Run whose first decision card should take focus once its view is on screen. */
  pendingDecisionFocus: string | null
  clearDecisionFocus(): void
  /** Show the blank New run page for the selected project. */
  openDraft(): void
  /** Close the New run page and drop its draft. */
  closeDraft(): void
  /** Pick a workspace for the selected project when it has none: its newest run, else the New run page. */
  ensureWorkspace(): Promise<void>
  /** Select a project and open the run that needs the user, else the last viewed one, else the newest. */
  openProject(projectId: string): Promise<void>
  /** Select the project, open the run and ask its decision card to take focus. */
  jumpToDecision(projectId: string, runId: string): Promise<void>`)
rep(`  history: RunSummary[]
  loadHistory(): Promise<void>`, `  history: RunSummary[]
  /** Past runs of every project, newest first (the sidebar's "last run" line). */
  historyByProject: Record<string, RunSummary[]>
  loadHistory(): Promise<void>
  loadAllHistory(): Promise<void>`)
rep(`  setComposerMode(mode: ComposerMode): void
  /** Hide a finished run from the run strip. Stops viewing it if it was the viewed run. */`, `  /** Hide a finished run's tab. Stops viewing it if it was the viewed run. */`)
rep(`export const activeRun = (s: AppState): RunState | undefined => {
  if (!s.selectedProjectId) return undefined
  const runId`, `/** The run the workspace shows. Undefined on the New run page. */
export const activeRun = (s: AppState): RunState | undefined => {
  if (!s.selectedProjectId || s.draftPage[s.selectedProjectId]) return undefined
  const runId`)
rep(`/** Show a run that continues an earlier one`, `/** State patch that shows a run in its project's workspace: leaves the New run page, un-hides the tab. */
function showRunPatch(s: AppState, projectId: string, runId: string): Partial<AppState> {
  const { [projectId]: _draft, ...draftPage } = s.draftPage
  const { [runId]: _hidden, ...dismissedRuns } = s.dismissedRuns
  return { activeRunByProject: { ...s.activeRunByProject, [projectId]: runId }, selectedAgentId: 'root', view: 'run', draftPage, dismissedRuns }
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

/** Show a run that continues an earlier one`)
rep(`    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, resumedFrom: summary.resumedFrom } } },
    activeRunByProject: { ...s.activeRunByProject, [summary.projectId]: summary.id },
    selectedAgentId: 'root',
    view: 'run'
  }))`, `    runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId, resumedFrom: summary.resumedFrom } } },
    ...showRunPatch(s, summary.projectId, summary.id)
  }))`)
rep(`  dismissedRuns: {},
  composerMode: 'reply',
  sideTab: 'transcript',
  usage: null,`, `  dismissedRuns: {},
  draftPage: {},
  composerDrafts: {},
  sideTabByRun: {},
  tabNotice: null,
  pendingDecisionFocus: null,
  historyByProject: {},
  usage: null,`)
rep(`  setSideTab(tab) {
    set({ sideTab: tab })
  },`, `  setSideTab(tab) {
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
    set({ pendingDecisionFocus: null })
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

  async jumpToDecision(projectId, runId) {
    await get().focusRun(projectId, runId)
    set({ pendingDecisionFocus: runId })
  },`)
rep(`    await get().loadProjects()
    void get().loadConnections()`, `    await get().loadProjects()
    void get().loadAllHistory()
    void get().loadConnections()`)
rep(`    set({ selectedProjectId: id, selectedRoleId: null, selectedAgentId: null, draftResult: null, draftError: null, history: [], composerMode: 'reply' })
    void get().loadHistory()
  },`, `    const changed = get().selectedProjectId !== id
    set({
      selectedProjectId: id,
      selectedRoleId: null,
      selectedAgentId: changed ? null : get().selectedAgentId,
      draftResult: null,
      draftError: null,
      ...(changed ? { history: get().historyByProject[id ?? ''] ?? [] } : {})
    })
    if (id) void settleWorkspace(id)
  },`)
rep(`    const history = await window.orgai.runs.list(project.id)
    set({ history })
  },`, `    const history = await window.orgai.runs.list(project.id)
    // The selection may have moved while the list was loading.
    set((s) => ({ historyByProject: { ...s.historyByProject, [project.id]: history }, ...(s.selectedProjectId === project.id ? { history } : {}) }))
  },

  async loadAllHistory() {
    const entries = await Promise.all(get().projects.map(async (p) => [p.id, await window.orgai.runs.list(p.id).catch(() => [] as RunSummary[])] as const))
    set((s) => ({ historyByProject: { ...s.historyByProject, ...Object.fromEntries(entries) } }))
  },`)
rep(`    set((s) => ({ activeRunByProject: { ...s.activeRunByProject, [project.id]: runId }, selectedAgentId: 'root', view: 'run', composerMode: 'reply' }))
  },`, `    set((s) => showRunPatch(s, project.id, runId))
  },`)
rep(`      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run',
      composerMode: 'reply'
    }))`, `      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))`)
const blk = `      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      activeRunByProject: { ...s.activeRunByProject, [project.id]: summary.id },
      selectedAgentId: 'root',
      view: 'run'
    }))`
const blkNew = `      runs: { ...s.runs, [summary.id]: { ...(s.runs[summary.id] ?? emptyRun(summary)), summary: { ...summary, ...s.runs[summary.id]?.summary, kind: summary.kind, prompt: summary.prompt, projectId: summary.projectId } } },
      ...showRunPatch(s, project.id, summary.id)
    }))`
if (s.split(blk).length !== 4) throw new Error('expected 3 blocks, got ' + (s.split(blk).length - 1))
s = s.split(blk).join(blkNew)
const a = s.indexOf('  setComposerMode(mode) {')
const b = s.indexOf('  async fillSummary(runId) {')
if (a < 0 || b < 0) throw new Error('dismiss region')
s = s.slice(0, a) + `  dismissRun(runId) {
    set((s) => {
      const run = s.runs[runId]
      if (!run || isRunLive(run)) return {}
      const projectId = run.summary.projectId
      const dismissedRuns = { ...s.dismissedRuns, [runId]: true as const }
      const tabNotice = HIDDEN_NOTICE
      if (s.activeRunByProject[projectId] !== runId) return { dismissedRuns, tabNotice }
      // Hiding the viewed tab moves to its right neighbour, else the left one; with no tab left, the New run page.
      const tabs = tabRunsOf(s, projectId)
      const at = tabs.findIndex((r) => r.summary.id === runId)
      const rest = tabs.filter((r) => r.summary.id !== runId)
      const next = rest[Math.min(at, rest.length - 1)]
      const activeRunByProject = { ...s.activeRunByProject }
      if (next) {
        activeRunByProject[projectId] = next.summary.id
        return { dismissedRuns, activeRunByProject, selectedAgentId: 'root', tabNotice }
      }
      delete activeRunByProject[projectId]
      return { dismissedRuns, activeRunByProject, draftPage: { ...s.draftPage, [projectId]: true as const }, tabNotice }
    })
    setTimeout(() => set((s) => (s.tabNotice === HIDDEN_NOTICE ? { tabNotice: null } : {})), 5000)
  },

  async focusRun(projectId, runId) {
    if (!get().projects.some((p) => p.id === projectId)) return
    if (get().selectedProjectId !== projectId) get().selectProject(projectId)
    await get().openRun(runId)
  },

` + s.slice(b)
rep(`const LIVE_RUN_STATUSES`, `const HIDDEN_NOTICE = 'Hidden. Find it in History.'\nconst LIVE_RUN_STATUSES`)
fs.writeFileSync(p, s)
console.log('ok')
