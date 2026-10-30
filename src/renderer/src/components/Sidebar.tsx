import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { AuthStatusResult, ConnectionStatus } from '@shared/types'
import { BellRing, ChevronDown, ChevronRight, LayoutGrid, PanelLeftClose, Settings } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { isRunLive, useAppStore, useRunIndexes, waitingRuns, type RunState } from '../store/useAppStore'
import { waitingItems } from '../lib/needsYou'
import { needsYou, projectCounts } from '../lib/runChains'
import { promptLine, runName, runTag } from '../lib/runLabels'
import { isStoppedRun, runStatus, statusOfRun } from '../lib/runStatus'
import { projectStatus } from '../lib/projectStatus'
import { initials } from '../lib/layout'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../lib/settingsTarget'
import { useSidebarCollapsed } from '../lib/useSidebarCollapsed'
import UsageMeter, { tightestWindow, UsageBar } from './UsageMeter'
import { BrandLockup } from './layout/BrandLockup'
import { Icon } from './ui/Icon'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'

const MOCK_TIP = 'ORGAI_MOCK is on: runs use scripted data, no tokens are spent'

/** Open runs of a project, the ones that need the user first, then the newest. */
function openRunsOf(runs: RunState[]): RunState[] {
  return runs
    .filter(isRunLive)
    .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.summary.startedAt - a.summary.startedAt)
}

/** The account row follows the Anthropic connection's status (what the Connections panel shows); the login probe only adds detail. */
function claudePill(auth: AuthStatusResult | null, status: ConnectionStatus | undefined): { tone: string; label: string; title?: string } {
  if (status) {
    const detail = status.detail ?? auth?.detail
    if (status.state === 'connected') {
      const how = auth?.mode === 'apiKey' ? `API key (${auth.envVar})` : (status.account ?? auth?.method ?? 'connected')
      return { tone: 'ok', label: `Claude · ${how}`, title: detail }
    }
    if (status.state === 'connecting') return { tone: 'warn', label: 'Claude · connecting…', title: detail }
    if (status.state === 'error') return { tone: 'danger', label: 'Claude · error', title: detail }
    return { tone: 'warn', label: 'Claude · not connected', title: detail }
  }
  if (auth == null) return { tone: '', label: 'Checking Claude login…' }
  if (auth.mode === 'apiKey') return { tone: 'warn', label: auth.envVarSet ? `Claude · API key (${auth.envVar})` : `Claude · ${auth.envVar} not set`, title: auth.detail }
  return auth.loggedIn ? { tone: 'ok', label: `Claude · ${auth.method ?? 'logged in'}`, title: auth.detail } : { tone: 'danger', label: 'Claude not logged in', title: auth.detail }
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
  const usage = useAppStore((s) => s.usage)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  useEffect(() => {
    if (!connections) void loadConnections()
  }, [connections, loadConnections])
  const pill = claudePill(auth, connections?.find((c) => c.connection.id === 'anthropic')?.status)
  const mockAdapter = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const viewedByProject = useAppStore((s) => s.activeRunByProject)
  const draftPage = useAppStore((s) => s.draftPage)
  const waiting = useAppStore(useShallow(waitingRuns))
  const indexes = useRunIndexes()
  const { collapsed: rail, toggle, setCollapsed } = useSidebarCollapsed()
  const [collapsed, setCollapsedRuns] = useState<Record<string, boolean>>({})

  const allRuns = useMemo(() => Object.values(runs), [runs])
  const items = waiting.flatMap((r) => waitingItems(r))
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? 'Project'
  const inProject = (v: string): boolean => v !== 'projects' && v !== 'appSettings'
  const names = projects.map((p) => p.name)

  const account = mockAdapter ? { tone: 'ok', label: 'Mock adapter', title: undefined } : pill
  const tight = mockAdapter ? null : tightestWindow(usage)
  const needsLabel = `Needs you · ${items.length}`

  return (
    <aside className="sidebar" id="sidebar" tabIndex={-1} aria-label="Sidebar" data-collapsed={rail ? 'true' : 'false'}>
      <BrandLockup
        collapsed={rail}
        onExpand={() => setCollapsed(false)}
        tag={
          mockAdapter ? (
            <Badge tone="neutral" testId="mock-mode-badge" title={MOCK_TIP}>
              MOCK
            </Badge>
          ) : undefined
        }
        trailing={<IconButton icon={PanelLeftClose} label="Collapse sidebar" size="sm" testId="sidebar-toggle" onClick={toggle} />}
      />
      <div className="sidebar-section sidebar-nav">
        <button
          type="button"
          className={`nav-item ${view === 'projects' ? 'active' : ''}`}
          aria-current={view === 'projects' ? 'page' : undefined}
          aria-label={rail ? 'All projects' : undefined}
          title={rail ? 'All projects' : undefined}
          onClick={() => setView('projects')}
        >
          <Icon icon={LayoutGrid} size="sm" />
          {!rail && 'Projects'}
        </button>
        {items.length > 0 && (
          <Popover
            trigger={
              <>
                <Icon icon={BellRing} size="sm" />
                {rail ? <span className="nav-rail-count">{items.length}</span> : <span className="nav-text">{needsLabel}</span>}
                {!rail && <Icon icon={ChevronDown} size="xs" />}
              </>
            }
            triggerLabel={rail ? needsLabel : undefined}
            triggerClassName="nav-item needs-row"
            triggerTestId="needs-you-row"
            label="Everything waiting for you"
            placement="bottom-start"
            className="needs-popover"
            testId="needs-you-list"
          >
            {({ close }) => (
              <ul className="needs-list">
                {waiting.flatMap((r) =>
                  waitingItems(r).map((it) => (
                    <li key={it.key}>
                      <button
                        type="button"
                        className="needs-item"
                        title={`${projectName(r.summary.projectId)} · ${runTag(indexes.get(r.summary.id))}: ${promptLine(r.summary.prompt)}\n${it.label}`}
                        onClick={() => {
                          close()
                          void jumpToDecision(r.summary.projectId, r.summary.id)
                        }}
                      >
                        <span className="needs-where">
                          {projectName(r.summary.projectId)} · <span className="run-index">{runTag(indexes.get(r.summary.id))}</span>: {runName(r.summary)}
                        </span>
                        <span className="needs-what">{it.label}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </Popover>
        )}
      </div>

      {!rail && <div className="sidebar-label">Projects</div>}
      <div className="sidebar-section sidebar-projects">
        {projects.length === 0 && !rail && <div className="sidebar-empty">No projects yet</div>}
        {projects.map((p) => {
          const counts = projectCounts(allRuns, p.id)
          const projectRuns = allRuns.filter((r) => r.summary.projectId === p.id)
          const open = openRunsOf(projectRuns)
          const expanded = !rail && open.length > 0 && !collapsed[p.id]
          const newest = [...(history[p.id] ?? []), ...projectRuns.map((r) => r.summary)].sort((a, b) => b.startedAt - a.startedAt)[0]
          const last = newest ? runStatus(newest.status, { endedWithApp: !!newest.endedWithApp, stopped: isStoppedRun(projectRuns.find((x) => x.summary.id === newest.id)?.agents) }) : undefined
          const st = projectStatus({ open: open.length > 0 ? counts.open : 0, needsYou: counts.needsYou, newest: newest && last ? { startedAt: newest.startedAt, status: last } : undefined })
          const active = selectedId === p.id && inProject(view)
          const viewedId = draftPage[p.id] ? undefined : viewedByProject[p.id]
          const accessibleName = st.needsLabel ? `${p.name}, ${st.needsLabel}` : p.name
          return (
            <div key={p.id} className="nav-project">
              <div className="nav-row">
                {rail ? null : open.length > 0 ? (
                  <button
                    type="button"
                    className="nav-chevron"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Hide' : 'Show'} open runs of ${p.name}`}
                    onClick={() => setCollapsedRuns((c) => ({ ...c, [p.id]: expanded }))}
                  >
                    <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
                  </button>
                ) : (
                  <span className="nav-chevron-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`nav-item nav-project-btn ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  aria-label={rail ? accessibleName : undefined}
                  data-testid="nav-project"
                  data-name={p.name}
                  title={[rail ? accessibleName : '', p.path, st.subtitle].filter(Boolean).join('\n')}
                  onClick={() => {
                    void openProject(p.id)
                    if (!inProject(view)) setView('run')
                  }}
                >
                  {rail ? (
                    <span className="nav-initials">
                      {initials(p.name, names)}
                      <span className={`dot ${st.dot}`} aria-hidden="true" />
                    </span>
                  ) : (
                    <>
                      <span className={`dot ${st.dot}`} aria-hidden="true" />
                      <span className="nav-text">
                        <span className="nav-name">{p.name}</span>
                        {active && st.subtitle && <span className="nav-counts">{st.subtitle}</span>}
                      </span>
                      {st.needsYou > 0 && (
                        <Badge tone="attention" title={st.needsLabel}>
                          {st.needsYou}
                        </Badge>
                      )}
                    </>
                  )}
                </button>
              </div>
              {expanded && (
                <ul className="nav-runs" aria-label={`Open runs of ${p.name}`}>
                  {open.map((r) => {
                    const rs = statusOfRun(r, p, needsYou(r))
                    const here = active && viewedId === r.summary.id
                    return (
                      <li key={r.summary.id}>
                        <button
                          type="button"
                          className={`nav-run ${here ? 'active' : ''}`}
                          aria-current={here ? 'true' : undefined}
                          title={`${runTag(indexes.get(r.summary.id))}: ${promptLine(r.summary.prompt)}\n${rs.word}`}
                          onClick={() => {
                            if (selectedId !== p.id) selectProject(p.id)
                            void openRun(r.summary.id)
                          }}
                        >
                          <span className={`run-dot ${rs.tone}`} aria-hidden="true" />
                          <span className="run-index">{runTag(indexes.get(r.summary.id))}</span>
                          <span className="nav-run-title">{runName(r.summary)}</span>
                          <span className="sr-only">{rs.word}</span>
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
        <Popover
          trigger={
            <>
              <span className={`dot ${account.tone}`} aria-hidden="true" />
              <span className="account-label">{account.label}</span>
              {tight && !rail && <span className="account-pct">{Math.round(tight.pct)}%</span>}
              {!rail && <UsageBar usage={mockAdapter ? null : usage} />}
            </>
          }
          triggerLabel={rail ? account.label : undefined}
          triggerClassName="account-row"
          triggerTestId="auth-pill"
          label="Account and plan usage"
          placement="top-start"
          className="account-popover"
          testId="account-popover"
        >
          {({ close }) => (
            <div className="account-pop">
              <div className="account-pop-title">{account.label}</div>
              {account.title && <p className="account-pop-note">{account.title}</p>}
              {mockAdapter ? <p className="account-pop-note">Runs use scripted data. No plan limits apply.</p> : <UsageMeter />}
              <Button
                size="sm"
                variant="ghost"
                icon={Settings}
                onClick={() => {
                  close()
                  requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
                  setView('appSettings')
                }}
              >
                App settings: Connections
              </Button>
            </div>
          )}
        </Popover>
        <span className="sidebar-gear" data-active={view === 'appSettings'}>
          <IconButton icon={Settings} label="App settings" testId="app-settings-button" onClick={() => setView('appSettings')} />
        </span>
      </div>
    </aside>
  )
}
