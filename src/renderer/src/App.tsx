import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { activeRun, runsOfProject, selectedProject, useAppStore, useRunIndexes } from './store/useAppStore'
import ProjectsView from './views/ProjectsView'
import SettingsView from './views/SettingsView'
import LiveRunView from './views/LiveRunView'
import AppSettingsView from './views/AppSettingsView'
import ErrorBoundary from './components/ui/ErrorBoundary'
import Sidebar from './components/Sidebar'
import RunHistory from './components/RunHistory'
import { useRunTabShortcuts } from './components/RunTabs'
import { needsYou } from './lib/runChains'
import { runTag, shortPrompt } from './lib/runLabels'
import { runStatus } from './lib/runStatus'

export default function App(): ReactElement {
  const init = useAppStore((s) => s.init)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const project = useAppStore(selectedProject)
  const run = useAppStore(activeRun)
  // Project-wide: any run of this project that waits for the user.
  const waitingHere = useAppStore((s) => (s.selectedProjectId ? runsOfProject(s, s.selectedProjectId).some(needsYou) : false))
  const indexes = useRunIndexes()
  useRunTabShortcuts()

  useEffect(() => {
    void init()
  }, [init])

  // The window title names the viewed run, so the OS task switcher and notifications show which run is on screen.
  const runIndex = run ? indexes.get(run.summary.id) : undefined
  useEffect(() => {
    document.title = run && view === 'run' ? `${runTag(runIndex)}: ${shortPrompt(run.summary.prompt, 40)} - OrgAI` : 'OrgAI'
  }, [run, runIndex, view])

  const badge = run || waitingHere ? runStatus(run?.summary.status ?? 'idle', { waiting: waitingHere || (run ? needsYou(run) : false), endedWithApp: !!run?.summary.endedWithApp }) : undefined

  return (
    <div className="app">
      <Sidebar />

      <main className="main">
        <ErrorBoundary resetKey={`${view}:${selectedId}:${run?.summary.id ?? ''}`} onReset={() => setView('projects')}>
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
                {badge && (
                  <span className={`pill run-status ${badge.tone}`} title={badge.note}>
                    <span className="dot" /> {run?.summary.kind === 'setup' ? 'setup · ' : ''}
                    {badge.word}
                  </span>
                )}
                <div className="tabs">
                  <button type="button" className={view === 'run' ? 'active' : ''} onClick={() => setView('run')}>
                    Live
                  </button>
                  <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
                    History
                  </button>
                  <button type="button" className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
                    Org chart &amp; settings
                  </button>
                </div>
              </div>
              {view === 'settings' ? <SettingsView project={project} /> : view === 'history' ? <RunHistory /> : <LiveRunView project={project} />}
            </>
          )}
        </ErrorBoundary>
      </main>
    </div>
  )
}
