import type { ReactElement } from 'react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { BellRing, Briefcase, Code, Folder, Settings } from 'lucide-react'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { activeRun, openNewChat, selectedProject, useAppStore, useProjectSummaries, useRunIndexes } from './store/useAppStore'
import DashboardView from './views/DashboardView'
import SettingsView from './views/SettingsView'
import TeamView from './views/TeamView'
import KnowledgeView from './views/KnowledgeView'
import OutputsView from './views/OutputsView'
import { initTeamAssistant, seedTeamReview, useTeamReviewSummary } from './store/teamAssistant'
import { initTodos, useOpenTodoCount } from './store/todosStore'
import { todoScopeFor, todosCountLabel } from '@shared/view/todos'
import TodosView from './views/TodosView'
import { SaveIndicator } from './components/layout/SaveIndicator'
import './styles/run-tabs.css'
import './styles/assistants.css'
import LiveRunView from './views/LiveRunView'
import AppSettingsView from './views/AppSettingsView'
import UsageView from './views/UsageView'
import SchedulesView from './views/SchedulesView'
import InboxView from './views/InboxView'
import ProjectHomeView from './views/ProjectHomeView'
import ErrorBoundary from './components/ui/ErrorBoundary'
import Sidebar from './components/Sidebar'
import RunHistory from './components/RunHistory'
import { useRunTabShortcuts } from './components/RunTabs'
import AppMenuLayer from './components/AppMenuLayer'
import AppNavigateBanner from './components/AppNavigateBanner'
import AppBanners from './components/layout/AppBanners'
import CommandPalette from './components/layout/CommandPalette'
import { Badge } from './components/ui/Badge'
import { Button } from './components/ui/Button'
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

type SectionView = 'home' | 'run' | 'history' | 'outputs' | 'knowledge' | 'todos' | 'team' | 'settings'
const SECTION_VIEWS: readonly string[] = ['home', 'run', 'history', 'outputs', 'knowledge', 'todos', 'team', 'settings']

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
    initTodos()
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

  // Ctrl/Cmd+K opens the command palette (Search or jump to). It works from any field except a rich-text editor, and
  // never stacks on another open dialog; the sidebar's search button is the pointer way in.
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable) return
      e.preventDefault()
      if (paletteOpen) {
        setPaletteOpen(false)
        return
      }
      if (document.querySelector('dialog[open]')) return
      setPaletteOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

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
    else if (view === 'inbox') document.title = 'Inbox · OrgAI'
    else if (!where || view === 'projects') document.title = 'OrgAI'
    else if (run && view === 'run') document.title = `${where} · ${runTag(runIndex)}: ${displayRunName(first)} · OrgAI`
    else document.title = `${where} · OrgAI`
  }, [run, first, runIndex, view, project, isVirtual])

  const teamPending = teamSummary?.pendingCount ?? 0
  // Knowledge (docs/design/knowledge.md, rec 1): engagements only, between History and Team; never on the assistants.
  const hasKnowledge = !!project && !isVirtual && projectKindOf(project) === 'engagement'
  // To-dos: every stored project and Chat, never the MCP / Skill assistants. The tab carries the open count.
  const todoScope = project ? todoScopeFor(project.id) : null
  const hasTodos = todoScope !== null
  const openTodos = useOpenTodoCount(todoScope)
  const sections: TabItem[] = [
    // Home (ui-overhaul ProjectHome / EngagementHome): stored projects only, never the assistants.
    ...(isVirtual ? [] : [{ id: 'home', label: 'Home', testId: 'tab-home' }]),
    { id: 'run', label: 'Live', testId: 'tab-live' },
    { id: 'history', label: 'History', testId: 'tab-history' },
    // Outputs (docs/design/outputs.md section 1): every stored project, never the assistants.
    ...(isVirtual ? [] : [{ id: 'outputs', label: 'Files', testId: 'tab-outputs' }]),
    ...(hasKnowledge ? [{ id: 'knowledge', label: 'Knowledge', testId: 'tab-knowledge' }] : []),
    ...(hasTodos ? [{ id: 'todos', label: 'To-dos', testId: 'tab-todos', count: openTodos ?? 0, countLabel: todosCountLabel(openTodos ?? 0), countTestId: 'todos-tab-count' }] : []),
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
  const onProject = !!project && view !== 'projects' && !['appSettings', 'usage', 'schedules', 'inbox'].includes(view)
  const engagement = onProject && !!project && !isVirtual && projectKindOf(project) === 'engagement'
  const activeSection = SECTION_VIEWS.includes(view) && (view !== 'home' || !isVirtual) && (view !== 'knowledge' || hasKnowledge) && (view !== 'outputs' || !isVirtual) && (view !== 'todos' || hasTodos) ? view : 'run'
  // The palette offers the open project's other tabs under "This project".
  const tabsKey = onProject ? sections.map((t) => `${t.id}:${t.label}`).join('|') : ''
  const paletteTabs = useMemo(
    () => (tabsKey ? tabsKey.split('|').map((part) => ({ view: part.slice(0, part.indexOf(':')), label: part.slice(part.indexOf(':') + 1) })) : null),
    [tabsKey]
  )
  // The content area rises in when the user moves between app-level places or into or out of a project (not on first
  // paint); a tab change inside one project keeps the shorter view crossfade below.
  const routeKey = onProject ? 'project' : view === 'projects' || !project ? 'projects' : view
  const [seenRoute, setSeenRoute] = useState<{ key: string; rise: boolean }>({ key: routeKey, rise: false })
  if (seenRoute.key !== routeKey) setSeenRoute({ key: routeKey, rise: true })

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
      <Sidebar resize={{ value: sidebarW, min: SIDEBAR_W.min, max: sidebarMax, onChange: setSavedSidebarW, onReset: () => setSavedSidebarW(null) }} onOpenPalette={() => setPaletteOpen(true)} />

      <main className="main" id="main-content" tabIndex={-1} data-kind={engagement ? 'engagement' : undefined}>
        <ErrorBoundary resetKey={`${view}:${selectedId}:${run?.summary.id ?? ''}`} onReset={() => setView('projects')}>
          <div className={`main-route${seenRoute.rise ? ' motion-view' : ''}`} key={routeKey}>
          {!onProject && <AppBanners />}
          {view === 'appSettings' ? (
            <AppSettingsView />
          ) : view === 'usage' ? (
            <UsageView />
          ) : view === 'schedules' ? (
            <SchedulesView />
          ) : view === 'inbox' ? (
            <InboxView />
          ) : view === 'projects' || !project ? (
            <DashboardView />
          ) : (
            <>
              <div className="topbar project-topbar">
                <h1 title={isVirtual ? undefined : project.name}>{selectedId && isVirtualProjectId(selectedId) ? assistantLabel(selectedId) : project.name}</h1>
                {!isVirtual && (
                  <span className="kind-chip" data-testid="project-kind-chip" data-kind={engagement ? 'engagement' : 'code'}>
                    <Icon icon={engagement ? Briefcase : Code} size="xs" />
                    <span className="kind-chip-word">{engagement ? 'Engagement' : 'Code project'}</span>
                    <ProjectClient project={project} />
                  </span>
                )}
                {showFolder && (
                  <span className="project-folder" data-testid="project-folder" title={project.path}>
                    <Icon icon={Folder} size="xs" />
                    <span className="project-folder-name">{folder}</span>
                  </span>
                )}
                <Tabs
                  tabs={sections}
                  value={activeSection}
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
                {!isVirtual && (
                  <span className="topbar-settings">
                    <Button size="sm" icon={Settings} testId="project-settings-button" title={engagement ? 'Engagement settings' : 'Project settings'} onClick={() => setView('settings')}>
                      <span className="topbar-settings-text">{engagement ? 'Engagement settings' : 'Project settings'}</span>
                    </Button>
                  </span>
                )}
              </div>
              <AppBanners />
              <AppNavigateBanner />
              <div className={`view-root${seenView.fade ? ' motion-view' : ''}`} key={view}>
              {view === 'home' && !isVirtual ? (
                <ProjectHomeView key={project.id} project={project} />
              ) : view === 'settings' ? (
                <SettingsView project={project} />
              ) : view === 'outputs' && !isVirtual ? (
                <OutputsView key={project.id} project={project} />
              ) : view === 'knowledge' && hasKnowledge ? (
                <KnowledgeView key={project.id} project={project} />
              ) : view === 'todos' && hasTodos ? (
                <TodosView key={project.id} project={project} />
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
          </div>
        </ErrorBoundary>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} tabs={paletteTabs} activeView={activeSection} />
      <AppMenuLayer />
    </div>
  )
}
