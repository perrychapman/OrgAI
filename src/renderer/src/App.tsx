import type { ReactElement } from 'react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BellRing, Folder } from 'lucide-react'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { activeRun, selectedProject, useAppStore, useRunIndexes } from './store/useAppStore'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import OrgChartView from './views/OrgChartView'
import { SaveIndicator } from './components/layout/SaveIndicator'
import './styles/run-tabs.css'
import LiveRunView from './views/LiveRunView'
import AppSettingsView from './views/AppSettingsView'
import ErrorBoundary from './components/ui/ErrorBoundary'
import Sidebar from './components/Sidebar'
import RunHistory from './components/RunHistory'
import { useRunTabShortcuts } from './components/RunTabs'
import { Badge } from './components/ui/Badge'
import { Button } from './components/ui/Button'
import { Icon } from './components/ui/Icon'
import { Tabs, type TabItem } from './components/ui/Tabs'
import { needsYou } from './lib/runChains'
import { waitingItems } from './lib/needsYou'
import { runName, runTag } from './lib/runLabels'
import { folderName } from './lib/paths'
import { MAIN_MIN_PX, SIDEBAR_W, clampWidth, maxWidthFor, usePersistedWidth } from './lib/panelWidth'
import { toggleSidebar, useSidebarCollapsed } from './lib/useSidebarCollapsed'

type SectionView = 'run' | 'history' | 'org' | 'settings'
const SECTION_VIEWS: readonly string[] = ['run', 'history', 'org', 'settings']

export default function App(): ReactElement {
  const init = useAppStore((s) => s.init)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const project = useAppStore(selectedProject)
  const run = useAppStore(activeRun)
  const runsById = useAppStore((s) => s.runs)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const isHarness = selectedId === HARNESS_PROJECT_ID
  // Project-wide: every decision any run of this project waits on.
  const waitingHere = useMemo(() => {
    if (!selectedId) return { count: 0, first: undefined as string | undefined }
    const list = Object.values(runsById)
      .filter((r) => r.summary.projectId === selectedId && needsYou(r))
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
    return { count: list.reduce((n, r) => n + Math.max(1, waitingItems(r).length), 0), first: list[0]?.summary.id }
  }, [runsById, selectedId])
  const indexes = useRunIndexes()
  const { collapsed } = useSidebarCollapsed()
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
    void useAppStore.getState().loadAppInfo()
  }, [init])

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

  // The window title names the project and the viewed run first, so the OS task switcher and notifications show
  // which run is on screen. "OrgAI" never leads.
  const runIndex = run ? indexes.get(run.summary.id) : undefined
  useEffect(() => {
    const where = isHarness ? 'MCP library assistant' : project?.name
    if (view === 'appSettings') document.title = 'App settings · OrgAI'
    else if (!where || view === 'projects') document.title = 'OrgAI'
    else if (run && view === 'run') document.title = `${where} · ${runTag(runIndex)}: ${runName(run.summary)} · OrgAI`
    else document.title = `${where} · OrgAI`
  }, [run, runIndex, view, project, isHarness])

  const sections: TabItem[] = [
    { id: 'run', label: 'Live', testId: 'tab-live' },
    { id: 'history', label: 'History', testId: 'tab-history' },
    ...(isHarness
      ? []
      : [
          { id: 'org', label: 'Org chart', testId: 'tab-org' },
          { id: 'settings', label: 'Settings', testId: 'tab-settings' }
        ])
  ]
  const folder = project && !isHarness ? folderName(project.path) : ''
  const showFolder = !!project && !!folder && folder !== project.name

  return (
    <div className="app" data-sidebar={collapsed ? 'rail' : 'full'} style={{ '--sidebar-w': `${sidebarW}px` } as CSSProperties}>
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
          ) : view === 'projects' || !project ? (
            <ProjectsView />
          ) : (
            <>
              <div className="topbar project-topbar">
                <h1 title={isHarness ? undefined : project.name}>{isHarness ? 'MCP library assistant' : project.name}</h1>
                {showFolder && (
                  <span className="project-folder" data-testid="project-folder" title={project.path}>
                    <Icon icon={Folder} size="xs" />
                    <span className="project-folder-name">{folder}</span>
                  </span>
                )}
                <Tabs
                  tabs={sections}
                  value={SECTION_VIEWS.includes(view) ? view : 'run'}
                  onChange={(id) => setView(id as SectionView)}
                  label="Project sections"
                  idPrefix="project"
                  controls={false}
                  className="topbar-tabs"
                />
                <div className="spacer" />
                {isHarness && (
                  <Button size="sm" variant="ghost" testId="harness-back" onClick={() => useAppStore.getState().openMcpLibrary()}>
                    Back to MCP library
                  </Button>
                )}
                {view !== 'run' && waitingHere.count > 0 && (
                  <button
                    type="button"
                    className="topbar-needs"
                    data-testid="topbar-needs-you"
                    title="Jump to the decision"
                    onClick={() => waitingHere.first && void jumpToDecision(project.id, waitingHere.first)}
                  >
                    <Badge tone="attention" icon={BellRing}>
                      Needs you · {waitingHere.count}
                    </Badge>
                  </button>
                )}
                <SaveIndicator />
              </div>
              {view === 'settings' ? (
                <SettingsView project={project} />
              ) : view === 'org' ? (
                <OrgChartView project={project} />
              ) : view === 'history' ? (
                <RunHistory />
              ) : (
                <LiveRunView project={project} />
              )}
            </>
          )}
        </ErrorBoundary>
      </main>
    </div>
  )
}
