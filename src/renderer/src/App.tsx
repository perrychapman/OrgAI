import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { activeRun, selectedProject, useAppStore } from './store/useAppStore'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import LiveRunView from './views/LiveRunView'
import LogsLink from './components/LogsLink'

export default function App(): ReactElement {
  const init = useAppStore((s) => s.init)
  const projects = useAppStore((s) => s.projects)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const selectProject = useAppStore((s) => s.selectProject)
  const auth = useAppStore((s) => s.auth)
  const activeRunByProject = useAppStore((s) => s.activeRunByProject)
  const runs = useAppStore((s) => s.runs)
  const project = useAppStore(selectedProject)
  const run = useAppStore(activeRun)

  useEffect(() => {
    void init()
  }, [init])

  const isLive = (projectId: string): boolean => {
    const runId = activeRunByProject[projectId]
    const status = runId ? runs[runId]?.summary.status : undefined
    return status === 'running' || status === 'starting' || status === 'idle'
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">O</span>
          OrgAI
        </div>
        <div className="sidebar-section">
          <button className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>
            <span>▦</span> Projects
          </button>
        </div>
        <div className="sidebar-label">Workspaces</div>
        <div className="sidebar-section" style={{ overflow: 'auto' }}>
          {projects.length === 0 && <div style={{ padding: '6px 10px', color: 'var(--text-faint)' }}>No projects yet</div>}
          {projects.map((p) => (
            <button
              key={p.id}
              className={`nav-item ${selectedId === p.id && view !== 'projects' ? 'active' : ''}`}
              onClick={() => {
                selectProject(p.id)
                if (view === 'projects') setView('run')
              }}
              title={p.path}
            >
              <span className={`dot ${isLive(p.id) ? 'live' : ''}`} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <span className={`pill ${auth?.loggedIn ? 'ok' : auth ? 'danger' : ''}`}>
            <span className="dot" />
            {auth == null ? 'Checking Claude login…' : auth.loggedIn ? `Claude · ${auth.method ?? 'logged in'}` : 'Claude not logged in'}
          </span>
          <LogsLink />
        </div>
      </aside>

      <main className="main">
        {view === 'projects' || !project ? (
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
                <span className={`pill ${run.summary.status === 'running' || run.summary.status === 'starting' ? 'live' : run.summary.status === 'error' ? 'danger' : 'ok'}`}>
                  <span className="dot" /> {run.summary.kind === 'setup' ? 'setup · ' : ''}
                  {run.summary.status}
                </span>
              )}
              <div className="tabs">
                <button className={view === 'run' ? 'active' : ''} onClick={() => setView('run')}>
                  Live
                </button>
                <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
                  Org chart &amp; settings
                </button>
              </div>
            </div>
            {view === 'settings' ? <SettingsView project={project} /> : <LiveRunView project={project} />}
          </>
        )}
      </main>
    </div>
  )
}
