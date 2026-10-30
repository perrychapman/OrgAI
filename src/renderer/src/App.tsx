import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { activeRun, runsOfProject, selectedProject, useAppStore, useRunIndexes } from './store/useAppStore'
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
  const isHarness = selectedId === HARNESS_PROJECT_ID
  // Project-wide: any run of this project that waits for the user.
  const waitingHere = useAppStore((s) => (s.selectedProjectId ? runsOfProject(s, s.selectedProjectId).some(needsYou) : false))
  const indexes = useRunIndexes()
  useRunTabShortcuts()

  useEffect(() => {
    void init()
    void useAppStore.getState().loadAppInfo()
  }, [init])

  // The window title names the viewed run, so the OS task switcher and notifications show which run is on screen.
  const runIndex = run ? indexes.get(run.summary.id) : undefined
  useEffect(() => {
    document.title = run && view === 'run' ? `OrgAI · ${runTag(runIndex)} · ${shortPrompt(run.summary.prompt, 40)}` : 'OrgAI'
  }, [run, runIndex, view])

  const badge = run || waitingHere ? runStatus(run?.summary.status ?? 'idle', { waiting: waitingHere || (run ? needsYou(run) : false), endedWithApp: !!run?.summary.endedWithApp }) : undefined

  return (
    <div className="app">
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
      <Sidebar />

      <main className="main" id="main-content" tabIndex={-1}>
        <ErrorBoundary resetKey={`${view}:${selectedId}:${run?.summary.id ?? ''}`} onReset={() => setView('projects')}>
          {view === 'appSettings' ? (
            <AppSettingsView />
          ) : view === 'projects' || !project ? (
            <ProjectsView />
          ) : (
            <>
              <div className="topbar">
                <h1>{isHarness ? 'MCP library assistant' : project.name}</h1>
                {!isHarness && (
                  <span className="pill" title={project.path}>
                    {project.path}
                  </span>
                )}
                <div className="spacer" />
                {badge && (
                  <span className={`pill run-status ${badge.tone}`} title={badge.note}>
                    <span className="dot" /> {run?.summary.kind === 'setup' ? 'setup · ' : ''}
                    {badge.word}
                  </span>
                )}
                <SaveIndicator />
                <div className="tabs" role="group" aria-label="Project sections">
                  <button type="button" className={view === 'run' ? 'active' : ''} aria-current={view === 'run' ? 'page' : undefined} onClick={() => setView('run')}>
                    Live
                  </button>
                  <button type="button" className={view === 'history' ? 'active' : ''} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}>
                    History
                  </button>
                  {!isHarness && (
                    <button type="button" className={view === 'org' ? 'active' : ''} aria-current={view === 'org' ? 'page' : undefined} onClick={() => setView('org')}>
                      Org chart
                    </button>
                  )}
                  {!isHarness && (
                    <button
                      type="button"
                      className={view === 'settings' ? 'active' : ''}
                      aria-current={view === 'settings' ? 'page' : undefined}
                      aria-label="Project settings"
                      onClick={() => setView('settings')}
                    >
                      Settings
                    </button>
                  )}
                  {isHarness && (
                    <button type="button" data-testid="harness-back" onClick={() => useAppStore.getState().openMcpLibrary()}>
                      Back to MCP library
                    </button>
                  )}
                </div>
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
