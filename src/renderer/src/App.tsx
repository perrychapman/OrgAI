import type { ReactElement } from 'react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BellRing, Folder } from 'lucide-react'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { activeRun, openNewChat, selectedProject, useAppStore, useProjectSummaries, useRunIndexes } from './store/useAppStore'
import DashboardView from './views/DashboardView'
import SettingsView from './views/SettingsView'
import TeamView from './views/TeamView'
import KnowledgeView from './views/KnowledgeView'
import OutputsView from './views/OutputsView'
import { initTeamAssistant, seedTeamReview, useTeamReviewSummary } from './store/teamAssistant'
import { SaveIndicator } from './components/layout/SaveIndicator'
import './styles/run-tabs.css'
import './styles/assistants.css'
import LiveRunView from './views/LiveRunView'
import AppSettingsView from './views/AppSettingsView'
import UsageView from './views/UsageView'
import SchedulesView from './views/SchedulesView'
import ErrorBoundary from './components/ui/ErrorBoundary'
import Sidebar from './components/Sidebar'
import RunHistory from './components/RunHistory'
import { useRunTabShortcuts } from './components/RunTabs'
import AppMenuLayer from './components/AppMenuLayer'
import AppNavigateBanner from './components/AppNavigateBanner'
import { Badge } from './components/ui/Badge'
import { Icon } from './components/ui/Icon'
import { Tabs, type TabItem } from './components/ui/Tabs'
import { chainOf, needsYou } from './lib/runChains'
import { teamDecisionsFor, waitingItems } from './lib/needsYou'
import { openTeamFilesDecision, useTeamAttentionItems } from './lib/menuActions'
import { runTag } from './lib/runLabels'
import { displayRunName } from './lib/orgChange'
import { folderName } from './lib/paths'
import { assistantLabel } from './lib/assistants'
import ProjectClient from './components/ProjectClient'
import { FolderTrustPointer } from './components/FolderTrustNotice'
import { MAIN_MIN_PX, SIDEBAR_W, clampWidth, maxWidthFor, usePersistedWidth } from './lib/panelWidth'
import { toggleSidebar, useSidebarCollapsed } from './lib/useSidebarCollapsed'
import { useBellCue } from './lib/useBellCue'

type SectionView = 'run' | 'history' | 'outputs' | 'knowledge' | 'team' | 'settings'
const SECTION_VIEWS: readonly string[] = ['run', 'history', 'outputs', 'knowledge', 'team', 'settings']

export default function App(): ReactElement {
  const init = useAppStore((s) => s.init)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const project = useAppStore(selectedProject)
  const run = useAppStore(activeRun)
  const runsById = useAppStore((s) => s.runs)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const isVirtual = !!selectedId && isVirtualProjectId(selectedId)
  const teamSummary = useTeamReviewSummary(selectedId)
  // Project-wide: every decision any run of this project waits on.
  const waitingHere = useMemo(() => {
    if (!selectedId) return { count: 0, first: undefined as string | undefined }
    const list = Object.values(runsById)
      .filter((r) => r.summary.projectId === selectedId && needsYou(r))
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
    return { count: list.reduce((n, r) => n + Math.max(1, waitingItems(r).length), 0), first: list[0]?.summary.id }
  }, [runsById, selectedId])
  const teamItems = useTeamAttentionItems()
  const teamHere = selectedId ? teamDecisionsFor(teamItems, selectedId).length : 0
  // The topbar badge pings once when this project's decision count rises (never on mount, never when it falls).
  const bellCue = useBellCue(waitingHere.count + teamHere, selectedId ?? '')
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const { collapsed, motion: sidebarMotion } = useSidebarCollapsed()
  useRunTabShortcuts()
  // Drag-resizable sidebar: saved width (px) or the 232 px default, clamped so the main area keeps room.
  const [savedSidebarW, setSavedSidebarW] = usePersistedWidth('orgai.sidebarW')
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const sidebarMax = maxWidthFor(winW, MAIN_MIN_PX, SIDEBAR_W.min, SIDEBAR_W.max)
  const sidebarW = clampWidth(savedSidebarW ?? SIDEBAR_W.def, SIDEBAR_W.min, sidebarMax)

  useEffect(() => {
    void init()
    initTeamAssistant()
    void useAppStore.getState().loadAppInfo()
  }, [init])

  useEffect(() => {
    if (selectedId && !isVirtualProjectId(selectedId)) seedTeamReview(selectedId)
  }, [selectedId])

  // Ctrl/Cmd+B toggles the sidebar rail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable) return
      e.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Ctrl/Cmd+Shift+N opens a new Chat on its start page (an accelerator only; the buttons stay the way in).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'n') return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable) return
      e.preventDefault()
      void openNewChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The window title names the project and the viewed run first, so the OS task switcher and notifications show
  // which run is on screen. "OrgAI" never leads.
  // The title names the viewed chain by its first member (the conversation keeps one name across continues).
  const first = run ? (chainOf(summaries, run.summary.id)[0] ?? run.summary) : undefined
  const runIndex = first ? indexes.get(first.id) : undefined
  useEffect(() => {
    const where = selectedId && isVirtualProjectId(selectedId) ? assistantLabel(selectedId) : project?.name
    if (view === 'appSettings') document.title = 'App settings · OrgAI'
    else if (view === 'usage') document.title = 'Usage · OrgAI'
    else if (view === 'schedules') document.title = 'Schedules · OrgAI'
    else if (!where || view === 'projects') document.title = 'OrgAI'
    else if (run && view === 'run') document.title = `${where} · ${runTag(runIndex)}: ${displayRunName(first)} · OrgAI`
    else document.title = `${where} · OrgAI`
  }, [run, first, runIndex, view, project, isVirtual])

  const teamPending = teamSummary?.pendingCount ?? 0
  // Knowledge (docs/design/knowledge.md, rec 1): engagements only, between History and Team; never on the assistants.
  const hasKnowledge = !!project && !isVirtual && projectKindOf(project) === 'engagement'
  const sections: TabItem[] = [
    { id: 'run', label: 'Live', testId: 'tab-live' },
    { id: 'history', label: 'History', testId: 'tab-history' },
    // Outputs (docs/design/outputs.md section 1): every stored project, never the assistants.
    ...(isVirtual ? [] : [{ id: 'outputs', label: 'Outputs', testId: 'tab-outputs' }]),
    ...(hasKnowledge ? [{ id: 'knowledge', label: 'Knowledge', testId: 'tab-knowledge' }] : []),
    ...(isVirtual
      ? []
      : [
          { id: 'team', label: 'Team', testId: 'tab-team', count: teamPending, countLabel: `${teamPending} ${teamPending === 1 ? 'suggestion' : 'suggestions'}`, countTestId: 'team-tab-badge' },
          { id: 'settings', label: 'Settings', testId: 'tab-settings' }
        ])
  ]
  // The view crossfade (docs/design/motion.md 3.3) plays only when the user changed section inside one project that was
  // already shown: not for the first view, a project switch, a relaunch restore or arriving from the Dashboard.
  const sectionView = SECTION_VIEWS.includes(view) ? view : null
  const [seenView, setSeenView] = useState<{ view: string | null; project: string | null; fade: boolean }>({ view: sectionView, project: selectedId, fade: false })
  if (seenView.view !== sectionView || seenView.project !== selectedId) {
    setSeenView({ view: sectionView, project: selectedId, fade: seenView.view !== null && sectionView !== null && seenView.project === selectedId })
  }
  const folder = project && !isVirtual ? folderName(project.path) : ''
  const showFolder = !!project && !!folder && folder !== project.name

  return (
    <div className="app" data-sidebar={collapsed ? 'rail' : 'full'} data-sidebar-motion={sidebarMotion ?? undefined} style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
      >
        Skip to content
      </a>
      <a
        href="#sidebar"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('sidebar')?.focus()
        }}
      >
        Skip to sidebar
      </a>
      <Sidebar resize={{ value: sidebarW, min: SIDEBAR_W.min, max: sidebarMax, onChange: setSavedSidebarW, onReset: () => setSavedSidebarW(null) }} />

      <main className="main" id="main-content" tabIndex={-1}>
        <ErrorBoundary resetKey={`${view}:${selectedId}:${run?.summary.id ?? ''}`} onReset={() => setView('projects')}>
          {view === 'appSettings' ? (
            <AppSettingsView />
          ) : view === 'usage' ? (
            <UsageView />
          ) : view === 'schedules' ? (
            <SchedulesView />
          ) : view === 'projects' || !project ? (
            <DashboardView />
          ) : (
            <>
              <div className="topbar project-topbar">
                <h1 title={isVirtual ? undefined : project.name}>{selectedId && isVirtualProjectId(selectedId) ? assistantLabel(selectedId) : project.name}</h1>
                <ProjectClient project={project} />
                {showFolder && (
                  <span className="project-folder" data-testid="project-folder" title={project.path}>
                    <Icon icon={Folder} size="xs" />
                    <span className="project-folder-name">{folder}</span>
                  </span>
                )}
                <Tabs
                  tabs={sections}
                  value={SECTION_VIEWS.includes(view) && (view !== 'knowledge' || hasKnowledge) && (view !== 'outputs' || !isVirtual) ? view : 'run'}
                  onChange={(id) => setView(id as SectionView)}
                  label="Project sections"
                  idPrefix="project"
                  controls={false}
                  className="topbar-tabs"
                />
                <div className="spacer" />
                {!isVirtual && <FolderTrustPointer project={project} view={view} />}
                {view !== 'run' && !(view === 'team' && waitingHere.count === 0) && waitingHere.count + teamHere > 0 && (
                  <button
                    type="button"
                    className={`topbar-needs${bellCue.ring ? ' motion-ring' : ''}`}
                    data-ping={bellCue.ping ? '' : undefined}
                    onAnimationEnd={(e) => {
                      if (e.target === e.currentTarget) bellCue.onPingEnd()
                    }}
                    data-testid="topbar-needs-you"
                    title="Jump to the decision"
                    onClick={() => (waitingHere.first ? void jumpToDecision(project.id, waitingHere.first) : openTeamFilesDecision(project.id))}
                  >
                    <Badge tone="attention" icon={BellRing}>
                      Needs you · {waitingHere.count + teamHere}
                    </Badge>
                  </button>
                )}
                <SaveIndicator />
              </div>
              <AppNavigateBanner />
              <div className={`view-root${seenView.fade ? ' motion-view' : ''}`} key={view}>
              {view === 'settings' ? (
                <SettingsView project={project} />
              ) : view === 'outputs' && !isVirtual ? (
                <OutputsView key={project.id} project={project} />
              ) : view === 'knowledge' && hasKnowledge ? (
                <KnowledgeView key={project.id} project={project} />
              ) : view === 'team' ? (
                <TeamView project={project} />
              ) : view === 'history' ? (
                <RunHistory />
              ) : (
                <LiveRunView project={project} />
              )}
              </div>
            </>
          )}
        </ErrorBoundary>
      </main>
      <AppMenuLayer />
    </div>
  )
}
