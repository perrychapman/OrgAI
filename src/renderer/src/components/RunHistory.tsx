import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, ExternalLink, Files, FolderPlus, History as HistoryIcon, Play, Search } from 'lucide-react'
import { ContextMenu, useContextMenu, type MenuEntry } from './ui/ContextMenu'
import { openRunWindow } from '../lib/menuActions'
import type { RunSummary } from '@shared/types'
import { QUICK_PROJECT_ID, RUN_KIND_LABELS, isVirtualProjectId } from '@shared/types'
import { activeRun, selectedProject, useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { Cost } from './ui/Cost'
import { runCostInput, sumCosts } from '../lib/cost'
import { canContinueIn, chainGroups, isOpenStatus, type ChainGroup } from '../lib/runChains'
import { runTag } from '../lib/runLabels'
import { displayRunName } from '../lib/orgChange'
import { SegmentedControl } from './ui/SegmentedControl'
import { Button } from './ui/Button'
import { Chip, type ChipTone } from './ui/Chip'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { Icon } from './ui/Icon'
import UsageTrends from './UsageTrends'
import { outputsOfRuns } from '../lib/outputs'
import SaveAsProjectDialog from './assistants/SaveAsProjectDialog'
import { canPromote, offersRetro, offersSaveAsProject, SCRATCH_PROMOTE_REASON } from '../lib/assistants'
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  PERIOD_OPTIONS,
  bucketCounts,
  bucketOf,
  groupByDay,
  inPeriod,
  matchesQuery,
  runsLabel,
  takeDays,
  type HistoryBucket,
  type HistoryPeriod
} from '../lib/runHistory'
import { HistoryRow } from './history/HistoryRow'
import { HistoryDetail } from './history/HistoryDetail'
import { groupStatus } from './history/groupStatus'
import { openChainOutputs } from './history/openChainOutputs'
import '../styles/history.css'

type Filter = 'all' | 'work' | 'ask' | 'setup'
type HistoryView = 'runs' | 'trends'
type BucketFilter = 'all' | HistoryBucket

/** Conversations listed before "Show N older runs" (a day is never cut). */
const PAGE = 25

const BUCKET_TONE: Record<HistoryBucket, ChipTone> = { running: 'working', open: 'warning', finished: 'success', failed: 'danger', stopped: 'neutral' }

/** The running dots that pulse at once (motion-design: at most a dozen loops on a screen). */
const PULSE_MAX = 12

interface Entry {
  group: ChainGroup<RunSummary>
  bucket: HistoryBucket
  word: string
  outputTitles: string[]
}

/**
 * The History board: a search field, status chips with counts, a period and kind choice, the project's conversations
 * grouped by day (one native table per day, a real row each), and the selected conversation's detail beside them.
 * Opening a row switches to Live and shows the chain's tab. A chain of several sessions can be expanded to list them.
 */
export default function RunHistory(): ReactElement {
  const summaries = useProjectSummaries()
  const openRun = useAppStore((s) => s.openRun)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const startRetro = useAppStore((s) => s.startRetro)
  const current = useAppStore(activeRun)
  const indexes = useRunIndexes()
  const [filter, setFilter] = useState<Filter>('all')
  const [bucket, setBucket] = useState<BucketFilter>('all')
  const [period, setPeriod] = useState<HistoryPeriod>('all')
  const [query, setQuery] = useState('')
  // The scope is remembered only while this view stays mounted (not across sessions); "All runs" is the default.
  const [scope, setScope] = useState<'all' | 'running'>('all')
  const [limit, setLimit] = useState(PAGE)
  const [view, setView] = useState<HistoryView>('runs')
  const project = useAppStore(selectedProject)
  const isChat = project?.id === QUICK_PROJECT_ID
  const [saving, setSaving] = useState<RunSummary | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The outputs index feeds the "N outputs" chips and the detail panel; fetch it once when History opens and it is not loaded yet.
  const outputsLoaded = useAppStore((s) => (project ? s.outputsByProject[project.id] !== undefined : true))
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const outputsIndex = useAppStore((s) => (project ? s.outputsByProject[project.id] : undefined))
  useEffect(() => {
    if (project && !outputsLoaded) void loadOutputs(project.id)
  }, [project, outputsLoaded, loadOutputs])

  const groups = useMemo(() => chainGroups(summaries), [summaries])
  // The shared status word of every conversation, as one string so a store change that moves no status re-renders nothing here.
  const wordsKey = useAppStore((s) => groups.map((g) => groupStatus(s.runs[g.newest.id], g.newest, project).word).join('|'))
  const viewedKey = current ? groups.find((g) => g.members.some((m) => m.id === current.summary.id))?.key : undefined
  const now = useMemo(() => Date.now(), [groups, period])

  const entries = useMemo<Entry[]>(() => {
    const words = wordsKey.split('|')
    return groups.map((g, i) => {
      const word = words[i] as ReturnType<typeof groupStatus>['word']
      const ids = new Set(g.members.map((m) => m.id))
      const outs = g.first.kind === 'work' && !g.first.quick ? outputsOfRuns(outputsIndex, ids) : []
      return { group: g, bucket: bucketOf(word), word, outputTitles: outs.flatMap((o) => [o.title, o.fileName, o.relPath]) }
    })
  }, [groups, wordsKey, outputsIndex])

  // "Running now": conversations whose newest session is working or waiting on the user (the shared status words).
  const runningNow = useMemo(() => entries.filter((e) => e.word === 'Running' || e.word === 'Needs you').length, [entries])
  // Scope, kind, period and search narrow the list; the chips count what is left, then the chip narrows it once more.
  const narrowed = useMemo(
    () =>
      entries.filter(({ group: g, word, outputTitles }) => {
        if (scope === 'running' && word !== 'Running' && word !== 'Needs you') return false
        const kindOk = filter === 'all' || (filter === 'ask' ? g.first.team === 'single' : filter === 'work' ? g.first.kind === 'work' && g.first.team !== 'single' : g.first.kind === 'setup')
        if (!kindOk || !inPeriod(g.newest.startedAt, period, now)) return false
        return matchesQuery([displayRunName(g.first), g.first.prompt, g.newest.prompt, runTag(indexes.get(g.first.id)), word, g.newest.error, ...outputTitles], query)
      }),
    [entries, scope, filter, period, query, indexes, now]
  )
  const counts = useMemo(() => bucketCounts(narrowed.map((e) => e.bucket)), [narrowed])
  const shown = useMemo(() => (bucket === 'all' ? narrowed : narrowed.filter((e) => e.bucket === bucket)), [narrowed, bucket])
  const { days, hidden } = useMemo(() => {
    const all = groupByDay(shown, (e) => e.group.newest.startedAt, now)
    const t = takeDays(all, limit)
    return { days: t.shown, hidden: t.hidden }
  }, [shown, limit, now])
  const visible = useMemo(() => days.flatMap((d) => d.items), [days])
  const selected = visible.find((e) => e.group.key === selectedKey) ?? visible[0]
  const runningKeys = useMemo(() => new Set(visible.filter((e) => e.bucket === 'running').slice(0, PULSE_MAX).map((e) => e.group.key)), [visible])

  // After "Show older runs" the button is gone: focus lands on the first row it revealed.
  useEffect(() => {
    if (!focusKey) return
    listRef.current?.querySelector<HTMLElement>(`tr[data-chain="${CSS.escape(focusKey)}"] button.hb-main`)?.focus()
    setFocusKey(null)
  }, [focusKey, visible])

  const menu = useContextMenu<string>()
  // If the row unmounts under the menu (Save as project, Retrospective), focus lands on the first Open button.
  const fallbackFocus = (): HTMLElement | null => document.querySelector<HTMLElement>('.hb-table button.run-open') ?? document.querySelector<HTMLElement>('.hb-table')
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
        label: 'Save as project',
        icon: FolderPlus,
        testId: 'history-save-as-project',
        disabled: !ok,
        disabledReason: ok ? undefined : SCRATCH_PROMOTE_REASON,
        onSelect: () => setSaving(newest)
      })
    }
    if (retro) entries.push({ id: 'retro', label: 'Retrospective', icon: HistoryIcon, testId: 'history-retro', title: 'Have the Architect review this run and revise the org chart where roles struggled', onSelect: () => void startRetro(newest.id) })
    return entries
  }

  // Up and Down move between the rows' title buttons; the table keeps one Tab stop per control, as before.
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('hb-main')) return
    const mains = [...(listRef.current?.querySelectorAll<HTMLElement>('button.hb-main') ?? [])]
    const next = mains[mains.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) {
      e.preventDefault()
      next.focus()
    }
  }

  const noRuns = summaries.length === 0
  const narrowing = filter !== 'all' || bucket !== 'all' || period !== 'all' || query.trim() !== ''
  const filtering = narrowing || scope !== 'all'
  const clearFilters = (): void => {
    setScope('all')
    setFilter('all')
    setBucket('all')
    setPeriod('all')
    setQuery('')
  }
  const showKind = !(project && isVirtualProjectId(project.id))
  // Select the (stable) live record, never the derived status object: a selector that returns a new object every time never settles.
  const selectedLive = useAppStore((s) => (selected ? s.runs[selected.group.newest.id] : undefined))
  const selectedStatus = useMemo(() => (selected ? groupStatus(selectedLive, selected.group.newest, project) : undefined), [selected, selectedLive, project])

  return (
    <div className="history hb" data-testid="history">
      <div className="hb-head">
        <h2>History</h2>
        <div className="hb-head-controls">
          {view === 'runs' && !noRuns && (
            <div data-testid="history-scope">
              <SegmentedControl<'all' | 'running'>
                label="Which runs"
                value={scope}
                options={[
                  { value: 'running', label: `Running now · ${runningNow}`, title: 'Runs that are working or waiting on you' },
                  { value: 'all', label: `All runs · ${entries.length}` }
                ]}
                onChange={setScope}
              />
            </div>
          )}
          <SegmentedControl<HistoryView>
            label="History view"
            value={view}
            options={[
              { value: 'runs', label: 'Runs' },
              { value: 'trends', label: 'Trends' }
            ]}
            onChange={setView}
          />
        </div>
      </div>
      {view === 'trends' ? (
        <div className="hb-trends glass">{project ? <UsageTrends projectId={project.id} /> : null}</div>
      ) : noRuns ? (
        <div className="history-empty hb-empty">
          <Icon icon={HistoryIcon} size="lg" />
          <p>No runs yet. Give the team a goal on the Live tab; every run you start is kept here.</p>
        </div>
      ) : (
        <div className="hb-body">
          <div className="hb-grid">
            <section className="hb-list" aria-label="Runs of this project" ref={listRef} onKeyDown={onListKeyDown}>
              <div className="hb-toolbar">
                <div className="hb-search">
                  <span className="hb-search-icon" aria-hidden="true">
                    <Icon icon={Search} size="sm" />
                  </span>
                  <Input type="search" aria-label="Search runs and what they changed" placeholder="Search runs and what they changed" value={query} onChange={setQuery} data-testid="history-search" />
                </div>
                <div className="hb-chips" role="group" aria-label="Show runs by status">
                  <Chip selected={bucket === 'all'} count={narrowed.length} onClick={() => setBucket('all')} data-testid="history-chip-all">
                    All
                  </Chip>
                  {BUCKET_ORDER.filter((b) => counts[b] > 0 || bucket === b).map((b) => (
                    <Chip key={b} selected={bucket === b} count={counts[b]} tone={BUCKET_TONE[b]} onClick={() => setBucket(bucket === b ? 'all' : b)} data-testid={`history-chip-${b}`}>
                      {BUCKET_LABEL[b]}
                    </Chip>
                  ))}
                </div>
                <div className="hb-selects">
                  {showKind && (
                    <Select
                      label="Show runs of kind"
                      value={filter}
                      options={[
                        { value: 'all', label: 'All kinds' },
                        { value: 'work', label: RUN_KIND_LABELS.work },
                        { value: 'ask', label: 'Ask' },
                        { value: 'setup', label: RUN_KIND_LABELS.setup }
                      ]}
                      onChange={(v) => setFilter(v as Filter)}
                    />
                  )}
                  <Select label="Period" value={period} options={PERIOD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} onChange={(v) => setPeriod(v as HistoryPeriod)} />
                </div>
              </div>
              <p className="sr-only" role="status" data-testid="history-count">
                {narrowed.length === 0 ? 'No runs match.' : `${runsLabel(shown.length)} shown.`}
              </p>
              {shown.length === 0 && scope === 'running' && !narrowing ? (
                <div className="history-empty hb-empty" data-testid="history-scope-empty">
                  <p>Nothing is running now.</p>
                  <Button
                    size="sm"
                    onClick={() => {
                      setScope('all')
                      // The button leaves with the empty state: keep the keyboard in the scope control.
                      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=history-scope] input:checked')?.focus())
                    }}
                    testId="history-scope-clear"
                  >
                    Show all runs
                  </Button>
                </div>
              ) : shown.length === 0 ? (
                <div className="history-empty hb-empty">
                  <p>{filtering ? `No ${filter === 'all' ? '' : `${filter === 'work' ? RUN_KIND_LABELS.work.toLowerCase() : filter} `}runs match these choices.` : 'No runs in this project.'}</p>
                  {filtering && (
                    <Button size="sm" onClick={clearFilters} testId="history-clear">
                      Show all runs
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  {days.map((d) => {
                    const members = d.items.flatMap((e) => e.group.members)
                    return (
                      <div className="hb-day glass" key={d.key} data-testid="history-day">
                        <table className="hb-table" data-chat={isChat || undefined}>
                          <caption>
                            <div className="hb-day-head">
                              <span className="hb-day-label">{d.label}</span>
                              <span className="hb-day-total tabular">
                                {runsLabel(d.items.length)} {'·'} <Cost value={sumCosts(members.map(runCostInput))} />
                              </span>
                            </div>
                          </caption>
                          <colgroup>
                            <col className="hb-col-main" />
                            {isChat && <col className="hb-col-folder" />}
                            <col className="hb-col-agents" />
                            <col className="hb-col-time" />
                            <col className="hb-col-cost" />
                            <col className="hb-col-act" />
                          </colgroup>
                          <thead className="sr-only">
                            <tr>
                              <th scope="col">Run</th>
                              {isChat && <th scope="col">Folder</th>}
                              <th scope="col">Agents</th>
                              <th scope="col">Time</th>
                              <th scope="col">Cost</th>
                              <th scope="col">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.items.map((e) => (
                              <HistoryRow
                                key={e.group.key}
                                group={e.group}
                                indexes={indexes}
                                viewed={viewedKey === e.group.key}
                                selected={selected?.group.key === e.group.key}
                                pulse={runningKeys.has(e.group.key)}
                                isExpanded={!!expanded[e.group.key]}
                                onToggle={() => setExpanded((x) => ({ ...x, [e.group.key]: !x[e.group.key] }))}
                                onSelect={() => setSelectedKey(e.group.key)}
                                onOpen={(id) => openRun(id)}
                                chat={isChat}
                                menu={menu}
                                fallbackFocus={fallbackFocus}
                              />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  })}
                  {hidden > 0 && (
                    <button
                      type="button"
                      className="hb-older"
                      data-testid="history-older"
                      onClick={() => {
                        setFocusKey(shown[visible.length]?.group.key ?? null)
                        setLimit(0)
                      }}
                    >
                      Show {hidden} older {hidden === 1 ? 'run' : 'runs'}
                    </button>
                  )}
                </>
              )}
            </section>
            {selected && selectedStatus && (
              <HistoryDetail
                group={selected.group}
                indexes={indexes}
                status={selectedStatus}
                outputs={selected.group.first.kind === 'work' && !selected.group.first.quick ? outputsOfRuns(outputsIndex, selected.group.members.map((m) => m.id)) : []}
                onOpen={(id) => void openRun(id)}
                onContinue={(id) => void continueFromHistory(id)}
                onOpenOutputs={(id) => openChainOutputs(id, openRun)}
              />
            )}
          </div>
        </div>
      )}
      <ContextMenu control={menu} label={(key) => `Actions for ${tagOf(key)}`} items={menuItems} testId="history-menu" />
      {saving && <SaveAsProjectDialog summary={saving} onClose={() => setSaving(null)} />}
    </div>
  )
}
