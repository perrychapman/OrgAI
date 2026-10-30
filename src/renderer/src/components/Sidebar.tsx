import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { BellRing, ChevronDown, ChevronRight, LayoutGrid, Settings } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { isRunLive, useAppStore, useRunIndexes, waitingRuns, type RunState } from '../store/useAppStore'
import { waitingItems } from '../lib/needsYou'
import { needsYou, projectCounts, relativeTime } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { runStatus } from '../lib/runStatus'
import brandIcon from '../assets/brand/icon.png'
import NotificationsToggle from './NotificationsToggle'
import LogsLink from './LogsLink'
import UsageMeter from './UsageMeter'
import { Icon } from './ui/Icon'

/** Open runs of a project, the ones that need the user first, then the newest. */
function openRunsOf(runs: RunState[]): RunState[] {
  return runs
    .filter(isRunLive)
    .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.summary.startedAt - a.summary.startedAt)
}

export default function Sidebar(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const openProject = useAppStore((s) => s.openProject)
  const openRun = useAppStore((s) => s.openRun)
  const selectProject = useAppStore((s) => s.selectProject)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const auth = useAppStore((s) => s.auth)
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const viewedByProject = useAppStore((s) => s.activeRunByProject)
  const draftPage = useAppStore((s) => s.draftPage)
  const waiting = useAppStore(useShallow(waitingRuns))
  const indexes = useRunIndexes()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [needsOpen, setNeedsOpen] = useState(true)

  const allRuns = useMemo(() => Object.values(runs), [runs])
  const items = waiting.flatMap((r) => waitingItems(r))
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'Project'
  const inProject = (v: string): boolean => v !== 'projects' && v !== 'appSettings'

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-mark" src={brandIcon} alt="" width={26} height={26} />
        OrgAI
      </div>
      <div className="sidebar-section">
        <button type="button" className={`nav-item ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>
          <Icon icon={LayoutGrid} size="sm" /> Projects
        </button>
        <button type="button" className={`nav-item ${view === 'appSettings' ? 'active' : ''}`} onClick={() => setView('appSettings')}>
          <Icon icon={Settings} size="sm" /> Settings
        </button>
      </div>

      {items.length > 0 && (
        <div className="sidebar-section nav-needs">
          <button type="button" className="nav-item needs-you" aria-expanded={needsOpen} onClick={() => setNeedsOpen((o) => !o)}>
            <Icon icon={BellRing} size="md" />
            <span className="nav-text">
              <span className="nav-name">Needs you ({items.length})</span>
            </span>
            <Icon icon={needsOpen ? ChevronDown : ChevronRight} size="xs" />
          </button>
          {needsOpen && (
            <ul className="nav-runs" aria-label="Everything waiting for you">
              {waiting.flatMap((r) =>
                waitingItems(r).map((it) => (
                  <li key={it.key}>
                    <button
                      type="button"
                      className="nav-run waiting"
                      title={`${projectName(r.summary.projectId)} · Run ${runTag(indexes.get(r.summary.id))}: ${promptLine(r.summary.prompt)}\n${it.label}`}
                      onClick={() => void jumpToDecision(r.summary.projectId, r.summary.id)}
                    >
                      <span className="nav-run-main">
                        <span className="nav-run-where">
                          {projectName(r.summary.projectId)} · Run <span className="run-index">{runTag(indexes.get(r.summary.id))}</span>: {shortPrompt(r.summary.prompt, 28)}
                        </span>
                        <span className="nav-run-what">{it.label}</span>
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}

      <div className="sidebar-label">Workspaces</div>
      <div className="sidebar-section sidebar-projects">
        {projects.length === 0 && <div className="sidebar-empty">No projects yet</div>}
        {projects.map((p) => {
          const counts = projectCounts(allRuns, p.id)
          const state = counts.needsYou > 0 ? 'warn' : counts.open > 0 ? 'is-running' : ''
          const projectRuns = allRuns.filter((r) => r.summary.projectId === p.id)
          const open = openRunsOf(projectRuns)
          const expanded = open.length > 0 && !collapsed[p.id]
          const newest = [...(history[p.id] ?? []), ...projectRuns.map((r) => r.summary)].sort((a, b) => b.startedAt - a.startedAt)[0]
          const last = newest ? runStatus(newest.status, { endedWithApp: !!newest.endedWithApp }) : undefined
          const subtitle =
            open.length > 0
              ? [`${counts.open} open`, counts.needsYou > 0 ? `${counts.needsYou} needs you` : ''].filter(Boolean).join(' · ')
              : newest && last
                ? `Last run ${relativeTime(newest.startedAt)} · ${last.word}`
                : ''
          const active = selectedId === p.id && inProject(view)
          const viewedId = draftPage[p.id] ? undefined : viewedByProject[p.id]
          return (
            <div key={p.id} className="nav-project">
              <div className="nav-row">
                {open.length > 0 ? (
                  <button
                    type="button"
                    className="nav-chevron"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} open runs of ${p.name}`}
                    onClick={() => setCollapsed((c) => ({ ...c, [p.id]: expanded }))}
                  >
                    <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
                  </button>
                ) : (
                  <span className="nav-chevron-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`nav-item ${active ? 'active' : ''}`}
                  title={subtitle ? `${p.path}\n${subtitle}` : p.path}
                  onClick={() => {
                    void openProject(p.id)
                    if (!inProject(view)) setView('run')
                  }}
                >
                  <span className={`dot ${state}`} aria-hidden="true" />
                  <span className="nav-text">
                    <span className="nav-name">{p.name}</span>
                    {subtitle && <span className={`nav-counts ${counts.needsYou > 0 ? 'warn' : ''}`}>{subtitle}</span>}
                  </span>
                </button>
              </div>
              {expanded && (
                <ul className="nav-runs" aria-label={`Open runs of ${p.name}`}>
                  {open.map((r) => {
                    const st = runStatus(r.summary.status, { waiting: needsYou(r) })
                    const here = active && viewedId === r.summary.id
                    return (
                      <li key={r.summary.id}>
                        <button
                          type="button"
                          className={`nav-run ${here ? 'active' : ''}`}
                          aria-current={here ? 'true' : undefined}
                          title={`${runTag(indexes.get(r.summary.id))}: ${promptLine(r.summary.prompt)}\n${st.word}`}
                          onClick={() => {
                            if (selectedId !== p.id) selectProject(p.id)
                            void openRun(r.summary.id)
                          }}
                        >
                          <span className={`run-dot ${st.tone}`} aria-hidden="true" />
                          <span className="run-index">{runTag(indexes.get(r.summary.id))}</span>
                          <span className="nav-run-title">{shortPrompt(r.summary.prompt, 28)}</span>
                          <span className="sr-only">{st.word}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
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
  )
}
