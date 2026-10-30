import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { activeRun, selectedProject, useAppStore } from './store/useAppStore'
import NotificationsToggle from './components/NotificationsToggle'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import OrgChartView from './views/OrgChartView'
import { LayoutGrid, Settings as SettingsIcon } from 'lucide-react'
import { Icon } from './components/ui/Icon'
import { SaveIndicator } from './components/layout/SaveIndicator'
import brandIcon from './assets/brand/icon.png'
import LiveRunView from './views/LiveRunView'
import AppSettingsView from './views/AppSettingsView'
import LogsLink from './components/LogsLink'
import ErrorBoundary from './components/ui/ErrorBoundary'
import UsageMeter from './components/UsageMeter'
import { projectCounts } from './lib/runChains'

export default function App(): ReactElement {
  const init = useAppStore((s) => s.init)
  const projects = useAppStore((s) => s.projects)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const selectProject = useAppStore((s) => s.selectProject)
  const auth = useAppStore((s) => s.auth)
  const runs = useAppStore((s) => s.runs)
  const project = useAppStore(selectedProject)
  const run = useAppStore(activeRun)

  useEffect(() => {
    void init()
  }, [init])

  const allRuns = Object.values(runs)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={brandIcon} alt="" width={26} height={26} />
          OrgAI
        </div>
        <div className="sidebar-section">
          <button className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>
            <Icon icon={LayoutGrid} size="sm" /> Projects
          </button>
          <button className={`nav-item ${view === 'appSettings' ? 'active' : ''}`} onClick={() => setView('appSettings')}>
            <Icon icon={SettingsIcon} size="sm" /> Settings
          </button>
        </div>
        <div className="sidebar-label">Workspaces</div>
        <div className="sidebar-section" style={{ overflow: 'auto' }}>
          {projects.length === 0 && <div style={{ padding: '6px 10px', color: 'var(--text-faint)' }}>No projects yet</div>}
          {projects.map((p) => {
            const counts = projectCounts(allRuns, p.id)
            const state = counts.needsYou > 0 ? 'warn' : counts.open > 0 ? 'is-running' : ''
            const summary = [counts.open > 0 ? `${counts.open} open` : '', counts.needsYou > 0 ? `${counts.needsYou} needs you` : ''].filter(Boolean).join(' · ')
            return (
              <button
                key={p.id}
                className={`nav-item ${selectedId === p.id && view !== 'projects' && view !== 'appSettings' ? 'active' : ''}`}
                onClick={() => {
                  selectProject(p.id)
                  if (view === 'projects' || view === 'appSettings') setView('run')
                }}
                title={summary ? `${p.path}\n${summary}` : p.path}
              >
                <span className={`dot ${state}`} aria-hidden="true" />
                <span className="nav-text">
                  <span className="nav-name">{p.name}</span>
                  {summary && <span className={`nav-counts ${counts.needsYou > 0 ? 'warn' : ''}`}>{summary}</span>}
                </span>
              </button>
            )
          })}
        </div>
        <div className="sidebar-footer">
          <span
            className={`pill ${auth?.loggedIn ? 'ok' : auth?.mode === 'apiKey' ? 'warn' : auth ? 'danger' : ''}`}
            title={auth?.detail}
          >
            <span className="dot" />
            {auth == null
              ? 'Checking Claude login…'
              : auth.mode === 'apiKey'
                ? auth.envVarSet
                  ? `Claude · API key (${auth.envVar})`
                  : `Claude · ${auth.envVar} not set`
                : auth.loggedIn
                  ? `Claude · ${auth.method ?? 'logged in'}`
                  : 'Claude not logged in'}
          </span>
          <UsageMeter />
          <NotificationsToggle />
          <LogsLink />
        </div>
      </aside>

      <main className="main">
        <ErrorBoundary resetKey={`${view}:${selectedId}:${run?.summary.id ?? ""}`} onReset={() => setView("projects")}>
        {view === 'appSettings' ? (
          <AppSettingsView />
        ) : view === 'projects' || !project ? (
          <ProjectsView />
        ) : (
          <>
            <div className="topbar">
              <h1>{project.name}</h1>
              <span className="pill" title={project.path}>
                {project.path}
              </span>
              <div className="spacer" />
              {run && (
                <span className={`pill ${run.summary.status === 'running' || run.summary.status === 'starting' ? 'is-running' : run.summary.status === 'error' ? 'danger' : run.summary.status === 'paused' ? 'warn' : 'ok'}`}>
                  <span className="dot" /> {run.summary.kind === 'setup' ? 'setup · ' : ''}
                  {run.summary.endedWithApp && run.summary.status === 'finished' ? 'ended when OrgAI closed' : run.summary.status}
                </span>
              )}
              <SaveIndicator />
              <div className="tabs" role="group" aria-label="Project sections">
                <button className={view === 'run' ? 'active' : ''} aria-current={view === 'run' ? 'page' : undefined} onClick={() => setView('run')}>
                  Live
                </button>
                <button className={view === 'org' ? 'active' : ''} aria-current={view === 'org' ? 'page' : undefined} onClick={() => setView('org')}>
                  Org chart
                </button>
                <button
                  className={view === 'settings' ? 'active' : ''}
                  aria-current={view === 'settings' ? 'page' : undefined}
                  aria-label="Project settings"
                  onClick={() => setView('settings')}
                >
                  Settings
                </button>
              </div>
            </div>
            {view === 'settings' ? (
              <SettingsView project={project} />
            ) : view === 'org' ? (
              <OrgChartView project={project} />
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
