import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RunOutput } from '@shared/types'
import { runName } from '@shared/view/runLabels'
import type { OutputsFilter, OutputsViewMode, UpdatedVersion } from '../lib/outputsList'
import { EMPTY_OUTPUTS_FILTER, OUTPUTS_COUNT_ANNOUNCE_MS, OUTPUTS_PRODUCED_ANNOUNCE_MS, countLine, deletedText, filterOutputs, idAfterRemoval, isOutputsFilterActive, kindCounts, newOutputIds, outputsViewKey, producedText, readViewMode, resolveOutputFocus, runOptions, selectedText, updatedText, updatedVersions } from '../lib/outputsList'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { SidePanel } from '../components/layout/SidePanel'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { useDeleteOutputs } from '../components/outputs/DeleteOutputs'
import OutputDetail from '../components/outputs/OutputDetail'
import { OutputsFilters } from '../components/outputs/OutputsFilters'
import { OutputsGrid } from '../components/outputs/OutputsGrid'
import { OutputsList, type OutputsListHandle } from '../components/outputs/OutputsList'
import { OutputStepper, stepKeyHandler } from '../components/outputs/OutputStepper'
import '../styles/outputs-view.css'

const HEADING_ID = 'output-detail-heading'
const EMPTY: readonly RunOutput[] = []
const NOTICE_MS = 8000
const NOW_TICK_MS = 60_000
const VIEW_OPTIONS: { value: OutputsViewMode; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'grid', label: 'Grid' }
]

/** Focus whatever `find` returns once the DOM has settled (two frames: React commit, then layout). */
function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()))
}

const visible = (el: HTMLElement | null): el is HTMLElement => !!el && el.getClientRects().length > 0

/**
 * The project's Outputs tab (docs/design/outputs.md section 8): every output the agents produced or registered as a
 * filterable day-grouped list with a preview pane. List first, no CanvasFrame, the page never scrolls. The list comes
 * from the store (`outputsByProject`, kept fresh by `output.created` and `outputs:changed`), so a live arrival is
 * inserted without moving focus or selection; the view only announces it, at most once per 5 s. A store focus request
 * (`outputsFocus`) selects an output and opens the pane.
 */
export default function OutputsView({ project }: { project: Project }): ReactElement {
  const projectId = project.id
  const list = useAppStore((s) => s.outputsByProject[projectId])
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const setOutputs = useAppStore((s) => s.setOutputs)
  const seen = useAppStore((s) => s.outputSeenVersion)
  const outputsFocus = useAppStore((s) => s.outputsFocus)
  const clearOutputsFocus = useAppStore((s) => s.clearOutputsFocus)
  const indexes = useRunIndexes()
  const summaries = useProjectSummaries()
  const names = useMemo(() => new Map(summaries.map((s) => [s.id, runName(s)])), [summaries])
  const all = list ?? EMPTY
  const loaded = list !== undefined
  // Day groups are judged against a minute-level clock, not Date.now() per render.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    void loadOutputs(projectId)
  }, [projectId, loadOutputs])

  // ---- filters ----
  const [filter, setFilter] = useState<OutputsFilter>(EMPTY_OUTPUTS_FILTER)
  const changeFilter = useCallback((next: Partial<OutputsFilter>): void => setFilter((f) => ({ ...f, ...next })), [])
  const clearFilters = useCallback((): void => setFilter(EMPTY_OUTPUTS_FILTER), [])
  const filterActive = isOutputsFilterActive(filter)
  const rows = useMemo(() => filterOutputs(all, filter), [all, filter])
  const kinds = useMemo(() => kindCounts(all, filter), [all, filter])
  const runs = useMemo(() => runOptions(all, indexes, names), [all, indexes, names])
  const countText = countLine(rows.length, all.length)
  // A run filter whose run has no outputs any more (all forgotten) must not hide the whole list.
  useEffect(() => {
    if (filter.runId && loaded && !all.some((o) => o.runId === filter.runId)) setFilter((f) => ({ ...f, runId: '' }))
  }, [all, filter.runId, loaded])

  // ---- announcements (one polite region) ----
  const [status, setStatus] = useState('')
  const announce = useCallback((text: string): void => {
    // Clear first so the same sentence twice is spoken twice.
    setStatus('')
    requestAnimationFrame(() => setStatus(text))
  }, [])
  const countArmed = useRef(false)
  useEffect(() => {
    if (loaded) countArmed.current = true
  }, [loaded])
  useEffect(() => {
    if (!countArmed.current) return undefined
    const t = window.setTimeout(() => announce(countText), OUTPUTS_COUNT_ANNOUNCE_MS)
    return () => window.clearTimeout(t)
    // Spoken on filter changes only (the text follows the filter and the data).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])
  // New outputs: counted and spoken at most once per OUTPUTS_PRODUCED_ANNOUNCE_MS.
  const prevAll = useRef<readonly RunOutput[] | null>(null)
  const pendingNew = useRef(0)
  const pendingUpdated = useRef(new Map<string, UpdatedVersion>())
  const lastSpoken = useRef(0)
  const spokenTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!loaded) return
    const prev = prevAll.current
    prevAll.current = all
    if (!prev) return
    const fresh = newOutputIds(prev, all).length
    // A new version of a listed output never moves its row; it is only spoken ("Updated Project plan to version 3").
    for (const u of updatedVersions(prev, all)) pendingUpdated.current.set(u.id, u)
    if (fresh === 0 && pendingUpdated.current.size === 0) return
    pendingNew.current += fresh
    const flush = (): void => {
      const n = pendingNew.current
      const updated = [...pendingUpdated.current.values()]
      pendingNew.current = 0
      pendingUpdated.current.clear()
      spokenTimer.current = undefined
      lastSpoken.current = Date.now()
      const text = [n > 0 ? producedText(n) : '', updatedText(updated)].filter(Boolean).join('. ')
      if (text) announce(text)
    }
    if (spokenTimer.current !== undefined) return
    const wait = lastSpoken.current + OUTPUTS_PRODUCED_ANNOUNCE_MS - Date.now()
    if (wait <= 0) flush()
    else spokenTimer.current = window.setTimeout(flush, wait)
  }, [all, loaded, announce])
  useEffect(() => () => window.clearTimeout(spokenTimer.current), [])

  // ---- selection and the pane ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paneOpen, setPaneOpen] = useState(true)
  const [reveal, setReveal] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const listRef = useRef<OutputsListHandle>(null)
  const selected = selectedId ? (all.find((o) => o.id === selectedId) ?? null) : null

  const focusHeading = useCallback((): void => {
    focusLater(() => {
      const heading = document.getElementById(HEADING_ID)
      if (visible(heading)) return heading
      const body = document.querySelector<HTMLElement>('[data-testid=outputs-detail-body]')
      if (visible(body)) return body
      return document.querySelector<HTMLElement>('[data-testid=outputs-detail] .side-rail button')
    })
  }, [])
  const focusRow = useCallback((id: string | null): void => {
    requestAnimationFrame(() => listRef.current?.focusRow(id))
  }, [])
  useEffect(() => {
    if (!notice) return undefined
    const t = window.setTimeout(() => setNotice(''), NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [notice])
  const selectItem = useCallback((id: string | null): void => {
    setSelectedId(id)
    setNotice('')
  }, [])
  const openItem = useCallback(
    (id: string): void => {
      selectItem(id)
      setPaneOpen(true)
      setReveal(`${id}:${Date.now()}`)
      focusHeading()
    },
    [focusHeading, selectItem]
  )

  // ---- list or grid (kept per project) ----
  const [view, setView] = useState<OutputsViewMode>(() => {
    try {
      return readViewMode(localStorage.getItem(outputsViewKey(projectId)))
    } catch {
      return 'list'
    }
  })
  const changeView = useCallback(
    (next: OutputsViewMode): void => {
      setView(next)
      try {
        localStorage.setItem(outputsViewKey(projectId), next)
      } catch {
        /* storage unavailable: the choice lasts for this window */
      }
    },
    [projectId]
  )

  // ---- select mode and bulk delete (docs/design/outputs-2.md 12.4) ----
  const { deleteOutputs, dialog: deleteDialog } = useDeleteOutputs()
  const [selectMode, setSelectMode] = useState(false)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const selectToggle = useRef<HTMLButtonElement>(null)
  // Only what is still in the list counts as selected (a filter or a delete elsewhere can remove checked ids).
  const checkedRows = useMemo(() => all.filter((o) => checked.has(o.id)), [all, checked])
  const toggleChecked = useCallback((id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const leaveSelect = useCallback((focus: boolean): void => {
    setSelectMode(false)
    setChecked(new Set())
    if (focus) requestAnimationFrame(() => selectToggle.current?.focus())
  }, [])
  const onMainKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || !selectMode || e.defaultPrevented) return
    if ((e.target as HTMLElement).closest('[popover], dialog, [role=dialog]')) return
    e.preventDefault()
    leaveSelect(true)
  }
  const bulkDelete = async (): Promise<void> => {
    if (checkedRows.length === 0 || busy) return
    setBusy(true)
    try {
      const outcome = await deleteOutputs(checkedRows)
      if (!outcome) return
      if (outcome.list) setOutputs(projectId, outcome.list)
      else void loadOutputs(projectId)
      const gone = new Set(outcome.deleted)
      const lines = [outcome.deleted.length > 0 ? deletedText(outcome.deleted.length, outcome.deleted.length === 1 ? checkedRows.find((o) => o.id === outcome.deleted[0])?.title : undefined) : '', ...outcome.problems].filter(Boolean)
      announce(lines.join(' '))
      setNotice('')
      if (outcome.problems.length === 0) {
        setSelectMode(false)
        setChecked(new Set())
      } else {
        setChecked((prev) => new Set([...prev].filter((id) => !gone.has(id))))
      }
      // Focus: the next row that stays, else the list, else the search box (the empty state has nothing focusable).
      const left = new Set((outcome.list ?? all).map((o) => o.id))
      const at = rows.findIndex((o) => gone.has(o.id))
      const stays = (o: RunOutput): boolean => !gone.has(o.id) && left.has(o.id)
      const next = rows.slice(at < 0 ? 0 : at).find(stays) ?? [...rows].reverse().find(stays)
      if (next) focusRow(next.id)
      else focusLater(() => document.querySelector<HTMLElement>('[data-testid=outputs-search]'))
    } finally {
      setBusy(false)
    }
  }
  // The shown item left the index (Remove from list, Delete file, or a change elsewhere): the next row takes the
  // selection, else the previous one; focus moves only when it was inside this view's list or pane (it just unmounted).
  const prevRows = useRef<RunOutput[]>(rows)
  useEffect(() => {
    const before = prevRows.current
    prevRows.current = rows
    if (!selectedId || !loaded || all.some((o) => o.id === selectedId)) return
    const next = idAfterRemoval(before, selectedId)
    const target = next && rows.some((o) => o.id === next) ? next : (rows[0]?.id ?? null)
    // The "Deleted X." notice stays: only a selection by the user (or the timer) clears it.
    setSelectedId(target)
    const active = document.activeElement
    const lost = !active || active === document.body || !!active.closest('[data-testid=outputs-detail]') || !!active.closest('[data-testid=outputs-list]')
    if (!lost) return
    if (target) focusRow(target)
    else focusLater(() => document.querySelector<HTMLElement>('[data-testid=outputs-search]'))
  }, [all, rows, selectedId, loaded, focusRow])
  // ---- default selection: entering the tab shows the newest output (no focus move, no announcement) ----
  const defaulted = useRef(false)
  useEffect(() => {
    if (defaulted.current || !loaded || rows.length === 0 || selectedId) return
    if (outputsFocus && outputsFocus.projectId === projectId) return
    defaulted.current = true
    setSelectedId(rows[0].id)
  }, [loaded, rows, selectedId, outputsFocus, projectId])
  // ---- a deep link (store.openOutputItem) ----
  useEffect(() => {
    if (!outputsFocus || outputsFocus.projectId !== projectId || !loaded) return
    const target = resolveOutputFocus(all, outputsFocus.outputId)
    clearOutputsFocus()
    if (!target) return
    // A filter that hides the item steps aside for it.
    if (!filterOutputs(all, filter).some((o) => o.id === target.id)) setFilter(EMPTY_OUTPUTS_FILTER)
    openItem(target.id)
  }, [outputsFocus, projectId, loaded, all, filter, clearOutputsFocus, openItem])

  // Previous / next: a click keeps focus on the button, the keys put it on the new heading.
  const step = useCallback(
    (to: string, viaKeyboard: boolean): void => {
      selectItem(to)
      if (viaKeyboard) focusHeading()
    },
    [focusHeading, selectItem]
  )
  const onStepKey = stepKeyHandler(rows, selectedId, step)

  // Esc in the pane returns to the row (a popover that is open takes its own Esc first).
  const onPaneKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    onStepKey(e)
    if (e.key !== 'Escape' || e.defaultPrevented || !selectedId) return
    const t = e.target as HTMLElement
    try {
      if (t.closest('[popover]:popover-open') || t.closest('[role=dialog], dialog')) return
    } catch {
      /* :popover-open unsupported */
    }
    e.preventDefault()
    focusRow(selectedId)
  }

  const empty = loaded && all.length === 0
  const noMatch = loaded && all.length > 0 && rows.length === 0
  const listProps = { rows, selectedId, seen, selectMode, checked, onToggle: toggleChecked, onSelect: selectItem, onOpen: openItem }
  return (
    <div className="outputs" data-testid="outputs-view" data-project={projectId}>
      <OutputsFilters filter={filter} kinds={kinds} runs={runs} countText={countText} onChange={changeFilter} />
      <div className="outputs-main" data-testid="outputs-main" data-view={view} onKeyDown={onMainKeyDown}>
        <div className="outputs-toolbar" data-testid="outputs-toolbar">
          <h2 className="outputs-toolbar-title">Outputs</h2>
          <span data-testid="outputs-view-switch">
            <SegmentedControl<OutputsViewMode> label="View" value={view} options={VIEW_OPTIONS} onChange={changeView} />
          </span>
          <button type="button" ref={selectToggle} className="outputs-chip" data-testid="outputs-select-toggle" aria-pressed={selectMode} disabled={!loaded || all.length === 0} onClick={() => (selectMode ? leaveSelect(true) : setSelectMode(true))}>
            Select
          </button>
        </div>
        {!loaded ? (
          <p className="panel-note outputs-loading">Looking…</p>
        ) : empty ? (
          <EmptyState compact testId="outputs-empty" title="No outputs yet." description="When agents produce documents, workbooks or diagrams, they appear here." />
        ) : noMatch ? (
          <EmptyState
            compact
            testId="outputs-empty-filter"
            title="No outputs match."
            actions={
              filterActive ? (
                <Button size="sm" testId="outputs-clear-filters" onClick={clearFilters}>
                  Clear the filters
                </Button>
              ) : undefined
            }
          />
        ) : view === 'grid' ? (
          <OutputsGrid ref={listRef} {...listProps} />
        ) : (
          <OutputsList ref={listRef} {...listProps} indexes={indexes} now={now} />
        )}
        {selectMode && (
          <div className="outputs-bulk-bar" data-testid="outputs-bulk-bar">
            <span className="outputs-bulk-count" role="status" data-testid="outputs-bulk-count">
              {selectedText(checkedRows.length)}
            </span>
            <Button size="sm" testId="outputs-select-all" onClick={() => setChecked(new Set(rows.map((o) => o.id)))} disabled={rows.length === 0 || checkedRows.length === rows.length}>
              Select all shown
            </Button>
            <Button size="sm" variant="danger" testId="outputs-bulk-delete" disabled={checkedRows.length === 0 || busy} onClick={() => void bulkDelete()}>
              Delete
            </Button>
            <Button size="sm" testId="outputs-select-cancel" onClick={() => leaveSelect(true)}>
              Cancel
            </Button>
          </div>
        )}
      </div>
      <SidePanel label="output preview" persistKey="outputs" autoCollapseBelow={1100} revealOn={reveal} open={paneOpen} onOpenChange={setPaneOpen} testId="outputs-detail">
        <div className="outputs-detail-body" data-testid="outputs-detail-body" tabIndex={-1} onKeyDown={onPaneKeyDown}>
          {selected ? (
            <>
              <div className="outputs-stepbar">
                <OutputStepper rows={rows} id={selected.id} onStep={step} />
              </div>
              <OutputDetail
                key={selected.id}
                output={selected}
                autoFocus={false}
                // The list update drives the next selection (the effect above); refetch so it cannot be missed.
                onRemoved={() => void loadOutputs(projectId)}
                onNotice={(text) => setNotice(text)}
              />
            </>
          ) : (
            <p className="panel-note outputs-pick">Select an output to see its preview here.</p>
          )}
          <p className="outputs-notice" role="status" data-testid="output-notice">
            {notice}
          </p>
        </div>
      </SidePanel>
      <p className="sr-only" role="status" data-testid="outputs-status">
        {status}
      </p>
      {deleteDialog}
    </div>
  )
}
