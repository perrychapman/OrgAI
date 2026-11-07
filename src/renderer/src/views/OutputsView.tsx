// The project tab "Outputs" (docs/design/outputs.md section 8): every output of the project, list first, with the shared
// OutputDetail in a side pane. Pattern: views/KnowledgeView.tsx (filter column, one-Tab-stop listbox, SidePanel detail).
import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Project, RunOutput } from '@shared/types'
import type { OutputsFilter } from '../lib/outputsList'
import {
  EMPTY_OUTPUTS_FILTER,
  OUTPUTS_PAGE,
  PRODUCED_ANNOUNCE_MS,
  STATUS_DEBOUNCE_MS,
  countLine,
  filterOutputs,
  groupByDay,
  idAfterRemoval,
  isFilterActive,
  kindCounts,
  newOutputIds,
  producedText,
  runOptionLabel,
  runOptions,
  sortNewest,
  statusText
} from '../lib/outputsList'
import { runName, runTag } from '../lib/runLabels'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../store/useAppStore'
import { SidePanel } from '../components/layout/SidePanel'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { OutputsFilters } from '../components/outputs/OutputsFilters'
import { OutputsList, type OutputsListHandle } from '../components/outputs/OutputsList'
import OutputDetail from '../components/outputs/OutputDetail'
import '../styles/outputs-view.css'

const NOTICE_MS = 8000
const DETAIL_HEADING_ID = 'output-detail-heading'

/** Two animation frames: after React committed and the browser laid out (a hidden pane shown). */
function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()))
}

const visible = (el: HTMLElement | null): el is HTMLElement => !!el && el.getClientRects().length > 0

export default function OutputsView({ project }: { project: Project }): ReactElement {
  const projectId = project.id
  const uid = useId()
  const list = useAppStore((s) => s.outputsByProject[projectId])
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const outputsFocus = useAppStore((s) => s.outputsFocus)
  const clearOutputsFocus = useAppStore((s) => s.clearOutputsFocus)
  const summaries = useProjectSummaries()
  const indexes = useRunIndexes()

  const [tried, setTried] = useState(false)
  const [filter, setFilter] = useState<OutputsFilter>(EMPTY_OUTPUTS_FILTER)
  const [limit, setLimit] = useState(OUTPUTS_PAGE)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [paneOpen, setPaneOpen] = useState(true)
  const [reveal, setReveal] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [spoken, setSpoken] = useState('')
  const listRef = useRef<OutputsListHandle>(null)
  const emptyRef = useRef<HTMLDivElement>(null)

  const load = useCallback((): void => {
    setTried(false)
    void loadOutputs(projectId).finally(() => setTried(true))
  }, [loadOutputs, projectId])
  useEffect(() => {
    load()
  }, [load])

  const loaded = list !== undefined
  const all = useMemo(() => sortNewest(list ?? []), [list])
  const filtered = isFilterActive(filter)
  const shownList = useMemo(() => filterOutputs(all, filter), [all, filter])
  const grouped = useMemo(() => groupByDay(shownList, Date.now(), limit), [shownList, limit])
  const visibleIds = useMemo(() => grouped.groups.flatMap((g) => g.items.map((o) => o.id)), [grouped])
  const kinds = useMemo(() => kindCounts(all), [all])
  const labelOf = useCallback(
    (runId: string): string | undefined => {
      const idx = indexes.get(runId)
      if (idx === undefined) return undefined
      return runOptionLabel(runTag(idx), runName(summaries.find((s) => s.id === runId)))
    },
    [indexes, summaries]
  )
  const runs = useMemo(() => runOptions(all, labelOf), [all, labelOf])
  const tagOf = useCallback((runId: string): string | undefined => {
    const idx = indexes.get(runId)
    return idx === undefined ? undefined : runTag(idx)
  }, [indexes])
  const selected: RunOutput | undefined = useMemo(() => all.find((o) => o.id === selectedId), [all, selectedId])
  const countText = countLine(shownList.length, all.length, filtered)

  const changeFilter = useCallback((next: Partial<OutputsFilter>): void => {
    setFilter((f) => ({ ...f, ...next }))
    setLimit(OUTPUTS_PAGE)
  }, [])
  const clearFilters = (): void => changeFilter({ ...EMPTY_OUTPUTS_FILTER })

  // A selected output that left the list (forgotten elsewhere) clears the selection.
  useEffect(() => {
    if (loaded && selectedId && !all.some((o) => o.id === selectedId)) setSelectedId(null)
  }, [loaded, all, selectedId])

  // ---- focus ----
  const focusHeading = useCallback((): void => {
    focusLater(() => {
      const heading = document.getElementById(DETAIL_HEADING_ID)
      if (visible(heading)) return heading
      return document.querySelector<HTMLElement>('[data-testid=outputs-detail] .side-rail button')
    })
  }, [])
  const select = useCallback((id: string): void => setSelectedId(id), [])
  const open = useCallback(
    (id: string): void => {
      setSelectedId(id)
      setPaneOpen(true)
      setReveal(`${id}:${Date.now()}`)
      focusHeading()
    },
    [focusHeading]
  )
  const focusRowOrEmpty = useCallback((id: string | null): void => {
    if (id && listRef.current) listRef.current.focusRow(id)
    else if (listRef.current) listRef.current.focusCurrent()
    else emptyRef.current?.focus()
  }, [])

  // ---- removal: focus the next row, else the list, else the empty state ----
  const [pendingRemoval, setPendingRemoval] = useState<{ removed: string; next: string | null } | null>(null)
  const onRemoved = useCallback(
    (id: string): void => {
      const next = idAfterRemoval(visibleIds, id)
      setSelectedId(next)
      setPendingRemoval({ removed: id, next })
    },
    [visibleIds]
  )
  useEffect(() => {
    if (!pendingRemoval) return
    if (all.some((o) => o.id === pendingRemoval.removed)) return
    setPendingRemoval(null)
    focusLater(() => {
      if (pendingRemoval.next) listRef.current?.focusRow(pendingRemoval.next)
      else if (listRef.current) listRef.current.focusCurrent()
      else emptyRef.current?.focus()
      return null
    })
  }, [pendingRemoval, all])

  // ---- notices ----
  useEffect(() => {
    if (!notice) return undefined
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [notice])

  // ---- status: the count line, debounced; live arrivals at most once per 5 s ----
  const status = statusText(shownList.length, all.length, filtered)
  useEffect(() => {
    const t = window.setTimeout(() => setSpoken(status), STATUS_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [status])
  const known = useRef<Set<string> | null>(null)
  const knownFor = useRef('')
  const produced = useRef({ pending: 0, lastAt: 0, timer: 0 as number | undefined })
  useEffect(() => {
    const p = produced.current
    return () => window.clearTimeout(p.timer)
  }, [])
  useEffect(() => {
    if (knownFor.current !== projectId) {
      knownFor.current = projectId
      known.current = null
    }
    if (!list) return
    const fresh = newOutputIds(known.current, list)
    known.current = new Set(list.map((o) => o.id))
    if (fresh.length === 0) return
    const p = produced.current
    p.pending += fresh.length
    if (p.timer) return
    const flush = (): void => {
      p.timer = undefined
      const n = p.pending
      p.pending = 0
      p.lastAt = Date.now()
      if (n > 0) setSpoken(producedText(n))
    }
    const wait = Math.max(0, PRODUCED_ANNOUNCE_MS - (Date.now() - p.lastAt))
    if (wait === 0) flush()
    else p.timer = window.setTimeout(flush, wait)
  }, [list, projectId])

  // ---- deep link: consumed once the list is loaded ----
  useEffect(() => {
    if (!outputsFocus || outputsFocus.projectId !== projectId) return
    if (!loaded) {
      if (tried) clearOutputsFocus()
      return
    }
    clearOutputsFocus()
    const target = outputsFocus.outputId ? all.find((o) => o.id === outputsFocus.outputId) : undefined
    if (target) {
      if (!shownList.some((o) => o.id === target.id)) setFilter(EMPTY_OUTPUTS_FILTER)
      setLimit(Math.max(OUTPUTS_PAGE, all.findIndex((o) => o.id === target.id) + 1))
      open(target.id)
      return
    }
    if (all.length === 0) {
      focusLater(() => emptyRef.current)
      return
    }
    focusLater(() => {
      listRef.current?.focusCurrent()
      return null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputsFocus, loaded, tried, projectId])

  const onPaneKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    // An open popover (More actions) closes itself first.
    if (document.querySelector(':popover-open')) return
    if (!selectedId) return
    e.preventDefault()
    focusRowOrEmpty(selectedId)
  }

  const empty = loaded && all.length === 0
  const noMatch = loaded && !empty && shownList.length === 0

  return (
    <div className="outputs-view" data-testid="outputs-view" data-project={projectId}>
      <OutputsFilters filter={filter} kinds={kinds} runs={runs} countText={countText} onChange={changeFilter} />
      <div className="outputs-main" data-testid="outputs-main">
        {tried && !loaded && (
          <Banner
            tone="danger"
            title="Outputs"
            testId="outputs-error"
            actions={
              <Button size="sm" onClick={load}>
                Retry
              </Button>
            }
          >
            OrgAI could not read the outputs list.
          </Banner>
        )}
        {!loaded ? (
          !tried && <p className="panel-note outputs-loading">Looking…</p>
        ) : empty ? (
          <div ref={emptyRef} tabIndex={-1} className="outputs-empty-wrap">
            <EmptyState compact testId="outputs-empty" title="No outputs yet." description="When agents produce documents, workbooks or diagrams, they appear here." />
          </div>
        ) : noMatch ? (
          <EmptyState
            compact
            testId="outputs-empty-filter"
            title="No outputs match."
            actions={
              <Button size="sm" testId="outputs-clear-filters" onClick={clearFilters}>
                Clear the filters
              </Button>
            }
          />
        ) : (
          <OutputsList
            ref={listRef}
            domId={`${uid}-list`}
            groups={grouped.groups}
            hidden={grouped.hidden}
            selectedId={selectedId}
            tagOf={tagOf}
            onSelect={select}
            onOpen={open}
            onShowMore={() => setLimit((l) => l + OUTPUTS_PAGE)}
          />
        )}
      </div>
      <SidePanel label="output preview" persistKey="outputs" autoCollapseBelow={1100} revealOn={reveal} open={paneOpen} onOpenChange={setPaneOpen} testId="outputs-detail">
        <div className="outputs-pane" data-testid="outputs-pane" onKeyDown={onPaneKey}>
          <p className="output-notice" data-testid="output-notice" role="status">
            {notice}
          </p>
          {selected ? (
            <OutputDetail key={selected.id} output={selected} autoFocus={false} onRemoved={onRemoved} onNotice={setNotice} />
          ) : (
            <p className="panel-note" data-testid="outputs-detail-empty">
              Select an output to preview it.
            </p>
          )}
        </div>
      </SidePanel>
      <p className="sr-only" role="status" data-testid="outputs-status">
        {spoken}
      </p>
    </div>
  )
}
