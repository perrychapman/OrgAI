import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AppWindow, ChevronDown, ChevronRight, ExternalLink, Files, FolderPlus, History as HistoryIcon, Play } from 'lucide-react'
import { ContextMenu, MenuButton, useContextMenu, type ContextMenuControl, type MenuEntry } from './ui/ContextMenu'
import { openRunWindow } from '../lib/menuActions'
import type { RunSummary } from '@shared/types'
import { QUICK_PROJECT_ID, RUN_KIND_LABELS, isVirtualProjectId } from '@shared/types'
import { activeRun, selectedProject, useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { Cost } from './ui/Cost'
import { runCostInput, sumCosts } from '../lib/cost'
import { canContinueIn, chainGroups, isOpenStatus, lastActivityAt, needsYou, relativeTime, type ChainGroup } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { displayRunName, isOrgChangeRun, runKindWord } from '../lib/orgChange'
import { statusOfRun, statusText, type RunTone } from '../lib/runStatus'
import { SegmentedControl } from './ui/SegmentedControl'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Badge, type BadgeTone } from './ui/Badge'
import { Icon } from './ui/Icon'
import UsageTrends from './UsageTrends'
import { outputsCountLabel, outputsOfRuns } from '../lib/outputs'
import { revealOutputsTab } from './outputs/revealOutputsTab'
import SaveAsProjectDialog from './assistants/SaveAsProjectDialog'
import { canPromote, offersRetro, offersSaveAsProject, quickFolderLabel, SCRATCH_PROMOTE_REASON } from '../lib/assistants'

/** Untrusted prompt text in a tooltip is capped. */
const TIP_CHARS = 300
const memberRowId = (runId: string): string => `history-member-${runId}`

type Filter = 'all' | 'work' | 'ask' | 'setup'
type HistoryView = 'runs' | 'trends'

/** History is the one place status is content: the shared status words in the Badge status tones. */
const STATUS_BADGE: Record<RunTone, BadgeTone> = {
  'is-running': 'info',
  warn: 'attention',
  idle: 'neutral',
  paused: 'neutral',
  ok: 'success',
  danger: 'danger',
  stopped: 'neutral'
}

/** Open the conversation (the Live view), then its Outputs side tab with the list showing. */
function openChainOutputs(newestId: string, onOpen: (id: string) => Promise<void>): void {
  void onOpen(newestId)
    .then(() => {
      useAppStore.getState().openRunOutput(newestId, null)
      revealOutputsTab()
    })
    .catch(() => undefined)
}

/**
 * The History tab: one row per conversation (a session chain) as a table (prompt first, status, cost, age, kind) with
 * its actions. Rows are real table rows; every action is a real button. Opening a row switches to Live and shows the
 * chain's tab. A chain of several sessions can be expanded to list them.
 */
export default function RunHistory(): ReactElement {
  const summaries = useProjectSummaries()
  const openRun = useAppStore((s) => s.openRun)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const startRetro = useAppStore((s) => s.startRetro)
  const current = useAppStore(activeRun)
  const indexes = useRunIndexes()
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<HistoryView>('runs')
  const project = useAppStore(selectedProject)
  const isChat = project?.id === QUICK_PROJECT_ID
  const [saving, setSaving] = useState<RunSummary | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // The outputs index feeds the "N outputs" chips; fetch it once when History opens and it is not loaded yet.
  const outputsLoaded = useAppStore((s) => (project ? s.outputsByProject[project.id] !== undefined : true))
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  useEffect(() => {
    if (project && !outputsLoaded) void loadOutputs(project.id)
  }, [project, outputsLoaded, loadOutputs])

  const groups = useMemo(() => chainGroups(summaries), [summaries])
  // The kind filter applies to a chain by its first member.
  const shown = groups.filter(
    (g) =>
      filter === 'all' ||
      (filter === 'ask' ? g.first.team === 'single' : filter === 'work' ? g.first.kind === 'work' && g.first.team !== 'single' : g.first.kind === 'setup')
  )
  const viewedKey = current ? groups.find((g) => g.members.some((m) => m.id === current.summary.id))?.key : undefined

  const menu = useContextMenu<string>()
  // If the row unmounts under the menu (Save as project, Retrospective), focus lands on the first Open button.
  const fallbackFocus = (): HTMLElement | null => document.querySelector<HTMLElement>('.history-table button.run-open') ?? document.querySelector<HTMLElement>('.history-table')
  const tagOf = (key: string): string => {
    const g = groups.find((x) => x.key === key)
    return g ? runTag(indexes.get(g.first.id)) : 'run'
  }
  const menuItems = (key: string): MenuEntry[] => {
    const g = groups.find((x) => x.key === key)
    if (!g) return []
    const { first, newest, members } = g
    const open = isOpenStatus(newest.status)
    const st = useAppStore.getState()
    const outputCount = first.kind === 'work' && !first.quick ? outputsOfRuns(st.outputsByProject[first.projectId], members.map((m) => m.id)).length : 0
    const entries: MenuEntry[] = [{ id: 'open', label: 'Open', icon: ExternalLink, testId: 'history-menu-open', onSelect: () => void openRun(newest.id) }]
    entries.push({ id: 'window', label: 'Open in new window', icon: AppWindow, testId: 'history-menu-window', onSelect: () => openRunWindow(newest.projectId, newest.id) })
    if (canContinueIn(members, newest.id)) entries.push({ id: 'continue', label: 'Continue', icon: Play, testId: 'history-menu-continue', onSelect: () => void continueFromHistory(newest.id) })
    if (outputCount > 0) {
      entries.push({
        id: 'outputs',
        label: 'Open outputs',
        icon: Files,
        testId: 'history-menu-outputs',
        onSelect: () => openChainOutputs(newest.id, openRun)
      })
    }
    const save = isChat && offersSaveAsProject(newest) && !open
    const retro = offersRetro(newest)
    if (save || retro) entries.push('separator')
    if (save) {
      const ok = canPromote(newest).ok
      entries.push({
        id: 'save',
        label: 'Save as project...',
        icon: FolderPlus,
        testId: 'history-save-as-project',
        disabled: !ok,
        disabledReason: ok ? undefined : SCRATCH_PROMOTE_REASON,
        onSelect: () => setSaving(newest)
      })
    }
    if (retro) entries.push({ id: 'retro', label: 'Retrospective', testId: 'history-retro', title: 'Have the Architect review this run and revise the org chart where roles struggled', onSelect: () => void startRetro(newest.id) })
    return entries
  }

  return (
    <div className="history">
      <div className="history-bar">
        <h2>History</h2>
        <div className="history-bar-controls">
          <SegmentedControl<HistoryView>
            label="History view"
            value={view}
            options={[
              { value: 'runs', label: 'Runs' },
              { value: 'trends', label: 'Trends' }
            ]}
            onChange={setView}
          />
          {view === 'runs' && !(project && isVirtualProjectId(project.id)) && (
            <SegmentedControl<Filter>
              label="Show runs of kind"
              value={filter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'work', label: RUN_KIND_LABELS.work },
                { value: 'ask', label: 'Ask' },
                { value: 'setup', label: RUN_KIND_LABELS.setup }
              ]}
              onChange={setFilter}
            />
          )}
        </div>
      </div>
      {view === 'trends' ? (
        project ? (
          <UsageTrends projectId={project.id} />
        ) : null
      ) : summaries.length === 0 ? (
        <div className="history-empty">
          <Icon icon={HistoryIcon} size="lg" />
          <p>No runs yet. Give the team a goal on the Live tab; every run you start is kept here.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="history-empty">
          <p>No {filter === 'work' ? RUN_KIND_LABELS.work.toLowerCase() : filter} runs in this project.</p>
        </div>
      ) : (
        <div className="history-scroll">
          <table className="history-table" aria-label="Runs of this project">
            <thead>
              <tr>
                <th scope="col" className="col-prompt">
                  Prompt
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="col-cost">
                  Cost
                </th>
                <th scope="col" className="col-started">
                  Age
                </th>
                <th scope="col" className="col-kind">
                  Kind
                </th>
                {isChat && (
                  <th scope="col" className="col-folder">
                    Folder
                  </th>
                )}
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <HistoryChain
                  key={g.key}
                  group={g}
                  indexes={indexes}
                  viewed={viewedKey === g.key}
                  isExpanded={!!expanded[g.key]}
                  onToggle={() => setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))}
                  onOpen={(id) => openRun(id)}
                  onContinue={() => void continueFromHistory(g.newest.id)}
                  chat={isChat}
                  menu={menu}
                  fallbackFocus={fallbackFocus}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ContextMenu control={menu} label={(key) => `Actions for ${tagOf(key)}`} items={menuItems} testId="history-menu" />
      {saving && <SaveAsProjectDialog summary={saving} onClose={() => setSaving(null)} />}
    </div>
  )
}

function HistoryChain({
  group,
  indexes,
  viewed,
  isExpanded,
  onToggle,
  onOpen,
  onContinue,
  chat,
  menu,
  fallbackFocus
}: {
  group: ChainGroup<RunSummary>
  indexes: Map<string, number>
  viewed: boolean
  isExpanded: boolean
  onToggle: () => void
  onOpen: (id: string) => Promise<void>
  onContinue: () => void
  chat: boolean
  menu: ContextMenuControl<string>
  fallbackFocus: () => HTMLElement | null
}): ReactElement {
  const { first, newest, members } = group
  const liveNewest = useAppStore((s) => s.runs[newest.id])
  const proj = useAppStore(selectedProject)
  const status = statusOfRun(liveNewest ?? { summary: newest }, proj, !!liveNewest && needsYou(liveNewest))
  const words = statusText(status)
  const sessions = members.length
  const last = lastActivityAt(newest)
  const open = isOpenStatus(newest.status)
  const tag = runTag(indexes.get(first.id))
  const cost = useMemo(() => sumCosts(members.map(runCostInput)), [members])
  const orgChange = isOrgChangeRun(first)
  // What the conversation produced (docs/design/outputs.md section 12): every member run, from the loaded index.
  const outputCount = useAppStore((s) => (first.kind === 'work' && !first.quick ? outputsOfRuns(s.outputsByProject[first.projectId], members.map((m) => m.id)).length : 0))
  const openOutputs = (): void => openChainOutputs(newest.id, onOpen)
  // The Menu key / Shift+F10 on the row's Open button opens the row menu anchored to that button.
  const onRowKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('button.run-open') : null
    if (btn) menu.onKeyDown(e, group.key, { anchor: btn, invoker: btn, fallbackFocus })
  }
  return (
    <>
      <tr className={`run-row ${viewed ? 'active' : ''}`} data-chain={group.key} data-sessions={sessions} onContextMenu={(e) => menu.onContextMenu(e, group.key, { fallbackFocus })} onKeyDown={onRowKeyDown}>
        <td className="col-prompt">
          <div className="run-head">
            {sessions > 1 && <IconButton icon={isExpanded ? ChevronDown : ChevronRight} size="sm" label={`Sessions of ${tag}`} expanded={isExpanded} controls={isExpanded ? members.map((m) => memberRowId(m.id)).join(' ') : undefined} onClick={onToggle} testId="history-sessions-toggle" />}
            <div className="run-head-text">
              {first.title || orgChange ? (
                <>
                  <div className="run-name" title={displayRunName(first)}>
                    <span className="run-index">{tag}</span> {displayRunName(first)}
                  </div>
                  <div className="prompt muted" title={shortPrompt(first.prompt, TIP_CHARS)}>
                    {promptLine(first.prompt)}
                  </div>
                </>
              ) : (
                <div className="prompt" title={shortPrompt(first.prompt, TIP_CHARS)}>
                  <span className="run-index">{tag}</span> {promptLine(first.prompt)}
                </div>
              )}
            </div>
            {sessions > 1 && (
              <Badge tone="neutral" title={`${sessions} sessions in this conversation`}>
                {sessions} sessions
              </Badge>
            )}
            {outputCount > 0 && (
              <Button size="sm" variant="ghost" icon={Files} className="history-outputs" testId="history-outputs" ariaLabel={`Open ${outputCount} ${outputCount === 1 ? 'output' : 'outputs'} of ${tag}`} title="Open this conversation on its Outputs tab" onClick={openOutputs}>
                {outputsCountLabel(outputCount)}
              </Button>
            )}
          </div>
        </td>
        <td>
          <Badge tone={STATUS_BADGE[status.tone]} title={newest.pauseReason ?? status.note}>
            <span className="status-dot" aria-hidden="true" />
            {words}
          </Badge>
        </td>
        <td className="col-cost">
          <Cost value={cost} />
        </td>
        <td className="col-started" title={new Date(last).toLocaleString()}>
          {relativeTime(last)}
        </td>
        <td className="col-kind">
          <span data-testid="run-kind" data-kind={first.quick ? 'chat' : first.team === 'single' ? 'ask' : first.kind === 'work' ? 'work' : orgChange ? 'org-change' : first.kind}>
            <Badge tone={first.kind === 'setup' ? 'accent' : 'neutral'}>{runKindWord(first)}</Badge>
          </span>
        </td>
        {chat && (
          <td className="col-folder" data-testid="history-folder" title={first.quick?.scratch ? 'A private scratch folder' : first.quick?.folder}>
            {quickFolderLabel(first.quick)}
          </td>
        )}
        <td>
          <div className="run-row-actions">
            <Button size="sm" className="run-open" onClick={() => void onOpen(newest.id)} title={open ? 'Open this live run' : 'Open this run'}>
              Open
            </Button>
            {viewed && (
              <Badge tone="accent" title="This conversation is open on the Live tab">
                Open in Live
              </Badge>
            )}
            {canContinueIn(members, newest.id) && (
              <Button size="sm" variant="secondary" className="run-continue" title="Open this run and continue its session with its memory" onClick={onContinue}>
                Continue
              </Button>
            )}
            <MenuButton control={menu} target={group.key} label={`More actions for ${tag}`} testId="history-more" fallbackFocus={fallbackFocus} />
          </div>
        </td>
      </tr>
      {isExpanded &&
        members.map((m, i) => (
          <MemberRow key={m.id} member={m} number={i + 1} chat={chat} onOpen={() => void onOpen(m.id)} />
        ))}
    </>
  )
}

/** One session of an expanded chain: when it started, its prompt, cost and Open (which scrolls the feed to it). */
function MemberRow({ member, number, chat, onOpen }: { member: RunSummary; number: number; chat: boolean; onOpen: () => void }): ReactElement {
  const live = useAppStore((s) => s.runs[member.id])
  const proj = useAppStore(selectedProject)
  const status = statusOfRun(live ?? { summary: member }, proj, false)
  const started = new Date(member.startedAt)
  return (
    <tr className="run-member-row motion-enter" style={{ '--i': Math.min(number - 1, 5) } as CSSProperties} id={memberRowId(member.id)} data-run={member.id}>
      <td className="col-prompt">
        <div className="run-member">
          <span className="run-member-no">Session {number}</span>
          <span className="run-member-prompt" title={shortPrompt(member.prompt, TIP_CHARS)}>
            {promptLine(member.prompt)}
          </span>
        </div>
      </td>
      <td>{statusText(status)}</td>
      <td className="col-cost">
        <Cost value={runCostInput(member)} />
      </td>
      <td className="col-started" title={started.toLocaleString()}>
        {started.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
      </td>
      <td className="col-kind" />
      {chat && <td className="col-folder" />}
      <td>
        <div className="run-row-actions">
          <Button size="sm" className="run-member-open" ariaLabel={`Open session ${number}`} onClick={onOpen}>
            Open
          </Button>
        </div>
      </td>
    </tr>
  )
}

