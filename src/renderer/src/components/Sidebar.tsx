import type { ReactElement, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { AuthStatusResult, ConnectionId, ConnectionStatus, Project, RunSummary, UsageStatus, VirtualProjectId } from '@shared/types'
import { projectConnection } from '@shared/defaults'
import { BellRing, ChevronDown, ChevronRight, LayoutDashboard,MessageSquare, PanelLeftClose, Plug, Settings, Sparkles, type LucideIcon } from 'lucide-react'
import { ASSISTANT_ORDER, assistantLabel, displayProject, locationLabel } from '../lib/assistants'
import { useShallow } from 'zustand/react/shallow'
import { isRunLive, useAppStore, useRunIndexes, waitingRuns, type RunState } from '../store/useAppStore'
import { decisionCount, waitingItems } from '../lib/needsYou'
import { groupByClient, readCollapsedClients, writeCollapsedClients } from '../lib/clientGroups'
import { needsYou } from '../lib/runChains'
import { oneLine } from '../lib/decisionTitle'
import { promptLine, runName, runTag } from '../lib/runLabels'
import { isTeamSurfaceRun } from '../lib/runSurface'
import { statusOfRun, statusText } from '../lib/runStatus'
import { chainGroups } from '../lib/runChains'
import { projectStatus } from '../lib/projectStatus'
import { initials } from '../lib/layout'
import { currentPlatform, isMacPlatform, modKeyLabel } from '../lib/platform'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../lib/settingsTarget'
import { devBuildLabel, isDevBuild } from '../lib/buildChannel'
import { useSidebarCollapsed } from '../lib/useSidebarCollapsed'
import UsageMeter, { SpendBar, tightestWindow, UsageBar } from './UsageMeter'
import { CONNECTION_LABEL, currentConnection, spendAria, spendLabel, spendLevel } from '../lib/usage'
import { BrandLockup } from './layout/BrandLockup'
import { ResizeHandle } from './layout/ResizeHandle'
import { Icon } from './ui/Icon'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Popover } from './ui/Popover'

const MOCK_TIP = 'ORGAI_MOCK is on: runs use scripted data, no tokens are spent'

const ASSISTANT_ICONS: Record<VirtualProjectId, LucideIcon> = { quick: MessageSquare, harness: Plug, skills: Sparkles }

/** One sidebar row: a project or an assistant. */
interface NavEntry {
  id: string
  name: string
  /** The project record (a display project for an assistant), for run status. */
  project: Project
  testId: string
  dataAttr: Record<string, string>
  /** Tooltip lines before the status subtitle. */
  titleLines: string[]
  /** The mark in the 56 px rail: initials or an icon. */
  railMark: ReactNode
  /** Rail accessible name; default is "<name>, N need you". */
  accessibleName?: (decisions: number, needsLabel: string) => string
  onOpen(): void
}

/** Open runs of a project, the ones that need the user first, then the newest. */
function openRunsOf(runs: RunState[]): RunState[] {
  return runs
    .filter((r) => isRunLive(r) && !isTeamSurfaceRun(r.summary))
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

type Pill = { tone: string; label: string; title?: string }

/** Account row for a non-Anthropic connection: Codex follows its status, LiteLLM shows the key's spend. */
function connectionPill(id: 'openai' | 'litellm', status: ConnectionStatus | undefined, usage: UsageStatus | undefined): Pill {
  const name = CONNECTION_LABEL[id]
  const detail = status?.detail
  if (status?.state === 'error') return { tone: 'danger', label: `${name} · error`, title: detail }
  if (status?.state === 'connecting') return { tone: 'warn', label: `${name} · connecting…`, title: detail }
  if (!status || status.state === 'disconnected') return { tone: 'warn', label: `${name} · not connected`, title: detail }
  if (id === 'litellm') {
    const spend = usage?.spend
    if (!spend) return { tone: 'warn', label: 'LiteLLM · spend unavailable', title: detail }
    const level = spendLevel(spend)
    return { tone: level === 'danger' ? 'danger' : level === 'warn' ? 'warn' : 'ok', label: spendLabel(spend), title: spendAria(spend) }
  }
  return { tone: 'ok', label: `${name} · ${status.account ?? 'connected'}`, title: detail }
}

export default function Sidebar({
  resize
}: {
  /** Drag-resize wiring from App (width in px, range, change and reset). The handle shows only in the full sidebar. */
  resize: { value: number; min: number; max: number; onChange: (w: number) => void; onReset: () => void }
}): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const selectedId = useAppStore((s) => s.selectedProjectId)
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const openProject = useAppStore((s) => s.openProject)
  const openAssistant = useAppStore((s) => s.openAssistant)
  const virtualProjects = useAppStore((s) => s.virtualProjects)
  const openRun = useAppStore((s) => s.openRun)
  const selectProject = useAppStore((s) => s.selectProject)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const auth = useAppStore((s) => s.auth)
  const usageByConnection = useAppStore((s) => s.usageByConnection)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const loadDefaultConnection = useAppStore((s) => s.loadDefaultConnection)
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  useEffect(() => {
    if (!connections) void loadConnections()
  }, [connections, loadConnections])
  useEffect(() => {
    void loadDefaultConnection()
  }, [loadDefaultConnection])
  const openProjectRecord = projects.find((p) => p.id === selectedId)
  const current: ConnectionId = currentConnection(openProjectRecord && view !== 'projects' && view !== 'appSettings' ? projectConnection(openProjectRecord) : null, defaultConnection)
  const litellmOn = connections?.find((c) => c.connection.id === 'litellm')?.connection.enabled ?? false
  const currentUsage = current === 'litellm' && !litellmOn ? undefined : usageByConnection[current]
  const currentStatus = connections?.find((c) => c.connection.id === current)?.status
  const pill: Pill = current === 'anthropic' ? claudePill(auth, currentStatus) : connectionPill(current, currentStatus, currentUsage)
  const appVersion = useAppStore((s) => s.appInfo?.version)
  const devBuild = isDevBuild(appVersion)
  const devLabel = devBuild && appVersion ? devBuildLabel(appVersion) : ''
  const mockAdapter = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const viewedByProject = useAppStore((s) => s.activeRunByProject)
  const draftPage = useAppStore((s) => s.draftPage)
  const waiting = useAppStore(useShallow(waitingRuns))
  const indexes = useRunIndexes()
  const { collapsed: rail, toggle, setCollapsed } = useSidebarCollapsed()
  const [collapsed, setCollapsedRuns] = useState<Record<string, boolean>>({})
  const [collapsedClients, setCollapsedClients] = useState<Set<string>>(() => readCollapsedClients())

  const allRuns = useMemo(() => Object.values(runs), [runs])
  const items = waiting.flatMap((r) => waitingItems(r))
  const projectName = (id: string): string => locationLabel(id, projects)
  const inProject = (v: string): boolean => v !== 'projects' && v !== 'appSettings'
  const names = projects.map((p) => p.name)

  const account = mockAdapter ? { tone: 'ok', label: 'Mock adapter', title: undefined } : pill
  const tight = mockAdapter || current === 'litellm' ? null : tightestWindow(currentUsage)
  const needsLabel = `Needs you · ${items.length}`
  const sidebarKey = isMacPlatform(currentPlatform()) ? '⌘B' : `${modKeyLabel(currentPlatform())}+B`

  const newChatKey = isMacPlatform(currentPlatform()) ? '⌘⇧N' : 'Ctrl+Shift+N'

  /** Project rows and Assistants rows share one renderer so their DOM, status and open-run lists stay identical. */
  const renderEntry = (entry: NavEntry): ReactElement => {
    const { id, name, project: p } = entry
    const projectRuns = allRuns.filter((r) => r.summary.projectId === id)
    const visibleRuns = projectRuns.filter((r) => !isTeamSurfaceRun(r.summary))
    const open = openRunsOf(visibleRuns)
    const expanded = !rail && open.length > 0 && !collapsed[id]
    const newest = [...(history[id] ?? []), ...visibleRuns.map((r) => r.summary)].sort((a, b) => b.startedAt - a.startedAt)[0]
    const last = newest ? statusOfRun(projectRuns.find((x) => x.summary.id === newest.id) ?? { summary: newest }, p, false) : undefined
    // An open run's tag and name are its chain's first member's (one conversation, one name).
    const firstOf = new Map<string, RunSummary>()
    if (open.length > 0) {
      const known = new Map<string, RunSummary>((history[id] ?? []).map((h) => [h.id, h]))
      for (const r of visibleRuns) known.set(r.summary.id, r.summary)
      for (const g of chainGroups([...known.values()])) for (const m of g.members) firstOf.set(m.id, g.first)
    }
    // One unit per level: decisions (the same count as the Needs-you row and the bell), with the run count beside it.
    const st = projectStatus({ open: open.length, decisions: decisionCount(projectRuns), newest: newest && last ? { startedAt: newest.startedAt, status: last } : undefined })
    const active = selectedId === id && inProject(view)
    const viewedId = draftPage[id] ? undefined : viewedByProject[id]
    const accessibleName = entry.accessibleName ? entry.accessibleName(st.decisions, st.needsLabel) : st.needsLabel ? `${name}, ${st.needsLabel}` : name
    return (
      <div key={id} className="nav-project">
        <div className="nav-row">
          {rail ? null : open.length > 0 ? (
            <button
              type="button"
              className="nav-chevron"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} open runs of ${name}`}
              onClick={() => setCollapsedRuns((c) => ({ ...c, [id]: expanded }))}
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
            data-testid={entry.testId}
            {...entry.dataAttr}
            title={[rail ? accessibleName : '', ...entry.titleLines, st.subtitle].filter(Boolean).join('\n')}
            onClick={entry.onOpen}
          >
            {rail ? (
              <span className="nav-initials">
                {entry.railMark}
                <span className={`dot ${st.dot}`} aria-hidden="true" />
              </span>
            ) : (
              <>
                <span className={`dot ${st.dot}`} aria-hidden="true" />
                <span className="nav-text">
                  <span className="nav-name">{name}</span>
                  {active && st.subtitle && <span className="nav-counts">{st.subtitle}</span>}
                </span>
                {st.decisions > 0 && (
                  <Badge tone="attention" title={st.needsLabel}>
                    {st.decisions}
                  </Badge>
                )}
              </>
            )}
          </button>
        </div>
        {expanded && (
          <ul className="nav-runs" aria-label={`Open runs of ${name}`}>
            {open.map((r) => {
              const rs = statusOfRun(r, p, needsYou(r))
              const first = firstOf.get(r.summary.id) ?? r.summary
              const tag = runTag(indexes.get(first.id))
              const here = active && viewedId === r.summary.id
              return (
                <li key={r.summary.id}>
                  <button
                    type="button"
                    className={`nav-run ${here ? 'active' : ''}`}
                    aria-current={here ? 'true' : undefined}
                    title={`${tag}: ${oneLine(promptLine(first.prompt), 300)}\n${statusText(rs)}`}
                    onClick={() => {
                      if (selectedId !== id) selectProject(id)
                      void openRun(r.summary.id)
                    }}
                  >
                    <span className={`run-dot ${rs.tone}`} aria-hidden="true" />
                    <span className="run-index">{tag}</span>
                    <span className="nav-run-title">{runName(first)}</span>
                    <span className="sr-only">{statusText(rs)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  const projectEntries: NavEntry[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    project: p,
    testId: 'nav-project',
    dataAttr: { 'data-name': p.name },
    titleLines: [p.path],
    railMark: initials(p.name, names),
    onOpen: () => {
      void openProject(p.id)
      if (!inProject(view)) setView('run')
    }
  }))
  const entryById = new Map(projectEntries.map((e) => [e.id, e]))
  const grouping = groupByClient(projects)
  const toggleClient = (key: string): void =>
    setCollapsedClients((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writeCollapsedClients(next)
      return next
    })
  const assistantEntries: NavEntry[] = ASSISTANT_ORDER.map((id) => ({
    id,
    name: assistantLabel(id),
    project: virtualProjects[id] ?? displayProject(id),
    testId: 'nav-assistant',
    dataAttr: { 'data-id': id },
    titleLines: id === 'quick' ? [`New chat (${newChatKey})`] : [],
    railMark: <Icon icon={ASSISTANT_ICONS[id]} size="sm" />,
    accessibleName: (decisions) => (decisions > 0 ? `${assistantLabel(id)}, ${decisions} ${decisions === 1 ? 'decision' : 'decisions'}` : assistantLabel(id)),
    onOpen: () => void openAssistant(id)
  }))

  return (
    <aside className="sidebar" id="sidebar" tabIndex={-1} aria-label="Sidebar" data-collapsed={rail ? 'true' : 'false'}>
      <BrandLockup
        collapsed={rail}
        onExpand={() => setCollapsed(false)}
        railNote={[mockAdapter ? MOCK_TIP : '', devLabel].filter(Boolean).join('. ') || undefined}
        railPip={
          devBuild ? (
            <span className="brand-lockup-pip" data-testid="dev-build-badge" aria-hidden="true">
              D
            </span>
          ) : undefined
        }
        shortcut={sidebarKey}
        tag={
          mockAdapter || devBuild ? (
            <>
              {mockAdapter && (
                <Badge tone="neutral" testId="mock-mode-badge" title={MOCK_TIP}>
                  MOCK
                </Badge>
              )}
              {devBuild && (
                <span role="img" aria-label={devLabel} className="brand-lockup-devtag">
                  <Badge tone="info" testId="dev-build-badge" title={devLabel}>
                    Dev
                  </Badge>
                </span>
              )}
            </>
          ) : undefined
        }
        trailing={<IconButton icon={PanelLeftClose} label={`Collapse sidebar (${sidebarKey})`} size="sm" testId="sidebar-toggle" onClick={toggle} />}
      />
      <div className="sidebar-section sidebar-nav">
        <button
          type="button"
          className={`nav-item ${view === 'projects' ? 'active' : ''}`}
          aria-current={view === 'projects' ? 'page' : undefined}
          aria-label={rail ? 'Dashboard' : undefined}
          title={rail ? 'Dashboard' : undefined}
          onClick={() => setView('projects')}
        >
          <Icon icon={LayoutDashboard} size="sm" />
          {!rail && 'Dashboard'}
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
                        data-kind={it.kind}
                        title={`${it.label}\n${projectName(r.summary.projectId)} · ${runTag(indexes.get(r.summary.id))}: ${oneLine(promptLine(r.summary.prompt), 300)}`}
                        onClick={() => {
                          close()
                          void jumpToDecision(r.summary.projectId, r.summary.id, it.key)
                        }}
                      >
                        <span className="needs-what">{it.label}</span>
                        <span className="needs-where">
                          {projectName(r.summary.projectId)} · <span className="run-index">{runTag(indexes.get(r.summary.id))}</span>: {runName(r.summary)}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </Popover>
        )}
      </div>

      {!rail && <div className="sidebar-label">Assistants</div>}
      <div className="sidebar-section sidebar-assistants" role="group" aria-label="Assistants">
        {assistantEntries.map(renderEntry)}
      </div>

      {!rail && <div className="sidebar-label">Projects</div>}
      <div className="sidebar-section sidebar-projects">
        {projects.length === 0 && !rail && <div className="sidebar-empty">No projects yet</div>}
        {!grouping.showHeaders
          ? projectEntries.map(renderEntry)
          : grouping.groups.map((g, gi) => {
              const rows = g.items.map((p) => entryById.get(p.id)).filter((e): e is NavEntry => !!e)
              if (rail) {
                return (
                  <div key={g.key} className="nav-client-rail">
                    {gi > 0 && <hr className="nav-client-divider" aria-hidden="true" />}
                    {rows.map(renderEntry)}
                  </div>
                )
              }
              if (g.type === 'code') {
                return (
                  <div key={g.key} className="nav-client-group">
                    <div className="nav-client-label" data-testid="nav-client-code-label">
                      {g.label}
                    </div>
                    {rows.map(renderEntry)}
                  </div>
                )
              }
              const closed = collapsedClients.has(g.key)
              const need = g.items.reduce((n, p) => n + decisionCount(allRuns.filter((r) => r.summary.projectId === p.id)), 0)
              const panelId = `nav-client-rows-${gi}`
              return (
                <div key={g.key} className="nav-client-group">
                  <button
                    type="button"
                    className="nav-client-header"
                    aria-expanded={!closed}
                    aria-controls={panelId}
                    data-testid="nav-client-group"
                    data-client={g.label}
                    title={`${g.label} (${g.items.length})`}
                    onClick={() => toggleClient(g.key)}
                  >
                    <Icon icon={closed ? ChevronRight : ChevronDown} size="xs" />
                    <span className="nav-client-name">{g.label}</span>
                    <span className="nav-client-count">{` (${g.items.length})`}</span>
                    <span className="nav-client-fill" />
                    {closed && need > 0 && (
                      <Badge tone="attention" title={`${need} ${need === 1 ? 'decision needs' : 'decisions need'} you`}>
                        {need}
                      </Badge>
                    )}
                  </button>
                  <div id={panelId} role="group" aria-label={g.label} hidden={closed}>
                    {rows.map(renderEntry)}
                  </div>
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
              {!rail && !mockAdapter && (current === 'litellm' ? <SpendBar spend={currentUsage?.spend} /> : <UsageBar usage={currentUsage} />)}
            </>
          }
          triggerLabel={rail ? account.label : undefined}
          triggerTitle={rail ? account.label : undefined}
          triggerClassName="account-row"
          triggerTestId="auth-pill"
          label="Account, plan usage and spend"
          placement="top-start"
          className="account-popover"
          testId="account-popover"
        >
          {({ close }) => (
            <div className="account-pop">
              <div className="account-pop-title">{account.label}</div>
              {account.title && <p className="account-pop-note">{account.title}</p>}
              {mockAdapter ? <p className="account-pop-note">Runs use scripted data. No plan limits apply. No spend is tracked.</p> : <UsageMeter current={current} />}
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
      {!rail && <ResizeHandle label="Resize sidebar" edge="end" testId="sidebar-resize" {...resize} />}
    </aside>
  )
}
