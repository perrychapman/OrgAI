import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, RunOutput } from '@shared/types'
import { runName } from '@shared/view/runLabels'
import type { OutputsFilter } from '../lib/outputsList'
import { EMPTY_OUTPUTS_FILTER, OUTPUTS_COUNT_ANNOUNCE_MS, OUTPUTS_PRODUCED_ANNOUNCE_MS, countLine, filterOutputs, idAfterRemoval, isOutputsFilterActive, kindCounts, newOutputIds, producedText, resolveOutputFocus, runOptions } from '../lib/outputsList'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { SidePanel } from '../components/layout/SidePanel'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import OutputDetail from '../components/outputs/OutputDetail'
import { OutputsFilters } from '../components/outputs/OutputsFilters'
import { OutputsList, type OutputsListHandle } from '../components/outputs/OutputsList'
import '../styles/outputs-view.css'

const HEADING_ID = 'output-detail-heading'
const EMPTY: readonly RunOutput[] = []
const NOTICE_MS = 8000
const NOW_TICK_MS = 60_000

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
  const lastSpoken = useRef(0)
  const spokenTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!loaded) return
    const prev = prevAll.current
    prevAll.current = all
    if (!prev) return
    const fresh = newOutputIds(prev, all).length
    if (fresh === 0) return
    pendingNew.current += fresh
    const flush = (): void => {
      const n = pendingNew.current
      pendingNew.current = 0
      spokenTimer.current = undefined
      lastSpoken.current = Date.now()
      if (n > 0) announce(producedText(n))
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

  // Esc in the pane returns to the row (a popover that is open takes its own Esc first).
  const onPaneKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
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
  return (
    <div className="outputs" data-testid="outputs-view" data-project={projectId}>
      <OutputsFilters filter={filter} kinds={kinds} runs={runs} countText={countText} onChange={changeFilter} />
      <div className="outputs-main" data-testid="outputs-main">
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
        ) : (
          <OutputsList ref={listRef} rows={rows} indexes={indexes} now={now} selectedId={selectedId} onSelect={selectItem} onOpen={openItem} />
        )}
      </div>
      <SidePanel label="output preview" persistKey="outputs" autoCollapseBelow={1100} revealOn={reveal} open={paneOpen} onOpenChange={setPaneOpen} testId="outputs-detail">
        <div className="outputs-detail-body" data-testid="outputs-detail-body" tabIndex={-1} onKeyDown={onPaneKeyDown}>
          {selected ? (
            <OutputDetail
              key={selected.id}
              output={selected}
              autoFocus={false}
              // The list update drives the next selection (the effect above); refetch so it cannot be missed.
              onRemoved={() => void loadOutputs(projectId)}
              onNotice={(text) => setNotice(text)}
            />
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
    </div>
  )
}
