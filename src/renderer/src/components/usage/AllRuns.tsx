import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatTokens } from '../../lib/cost'
import { formatDateTime } from '../../lib/dates'
import { totalTokens } from '../../lib/trends'
import {
  RUN_ROW_PX,
  RUN_SORT_FIRST,
  RUNS_SHOWN,
  RUNS_WINDOW_AFTER,
  rowCacheHit,
  rowCostInput,
  rowKindWord,
  rowModels,
  rowName,
  rowStatusWord,
  rowTime,
  runsWindow,
  sortRunRows,
  type RunSortDir,
  type RunSortKey
} from '../../lib/usageRuns'
import { useAppStore } from '../../store/useAppStore'
import { CostText } from './RankedBars'
import type { UsagePanelProps } from './panelProps'
import { SortTh, useOverflowX } from './usageTableParts'
import '../../styles/usage-tables.css'

export interface AllRunsProps extends UsagePanelProps {
  /** The disclosure is open (a project drilldown or a deep link opens it, 4.8). */
  open: boolean
  onToggle: (open: boolean) => void
}

const COLUMNS = 9

function RunsTable({ rows }: { rows: ReturnType<typeof sortRunRows> }): ReactElement {
  const openRun = useAppStore((s) => s.openUsageRun)
  const [sort, setSort] = useState<{ key: RunSortKey; dir: RunSortDir }>({ key: 'when', dir: 'desc' })
  const [shown, setShown] = useState(RUNS_SHOWN)
  const sorted = useMemo(() => sortRunRows(rows, sort.key, sort.dir), [rows, sort])
  const visible = sorted.slice(0, shown)
  const windowed = visible.length > RUNS_WINDOW_AFTER

  const wrapRef = useRef<HTMLDivElement>(null)
  const over = useOverflowX(wrapRef)
  const [scroll, setScroll] = useState({ top: 0, height: 560 })
  const frame = useRef(0)
  const onScroll = useCallback((): void => {
    if (!windowed || frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = wrapRef.current
      if (el) setScroll({ top: el.scrollTop, height: el.clientHeight })
    })
  }, [windowed])
  useEffect(() => {
    const el = wrapRef.current
    if (windowed && el) setScroll({ top: el.scrollTop, height: el.clientHeight })
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [windowed, shown])

  // "Show N more" takes the button away: focus goes to the first newly shown row's open button (never body).
  const focusAfterMore = useRef<{ id: string; index: number } | null>(null)
  useEffect(() => {
    const want = focusAfterMore.current
    const wrap = wrapRef.current
    if (!want || !wrap) return
    focusAfterMore.current = null
    const find = (): HTMLElement | null => wrap.querySelector<HTMLElement>(`[data-run="${CSS.escape(want.id)}"] .usage-run-open`)
    const first = find()
    if (first) {
      first.focus()
      return
    }
    // A removed project's row has no button: the section heading is the stable fallback.
    if (wrap.querySelector(`[data-run="${CSS.escape(want.id)}"]`)) {
      document.getElementById('usage-runs-h')?.focus()
      return
    }
    // Windowed: bring the row into the rendered window, then focus it once it exists.
    wrap.scrollTop = Math.max(0, want.index * RUN_ROW_PX - wrap.clientHeight / 2)
    setScroll({ top: wrap.scrollTop, height: wrap.clientHeight })
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => (find() ?? document.getElementById('usage-runs-h'))?.focus()))
  }, [shown])

  const win = windowed ? runsWindow(visible.length, scroll.top, scroll.height) : { start: 0, end: visible.length, before: 0, after: 0 }
  const onSort = (key: RunSortKey): void => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: RUN_SORT_FIRST[key] }))
  const remaining = sorted.length - shown

  return (
    <>
      <div
        ref={wrapRef}
        className="usage-table-wrap usage-tbl-wrap usage-runs-scroll"
        data-windowed={windowed ? 'true' : undefined}
        onScroll={onScroll}
        {...(over || windowed ? { tabIndex: 0, role: 'region', 'aria-label': 'All runs table' } : {})}
      >
        <table className="usage-tbl usage-runs-table" data-testid="usage-runs-table" {...(windowed ? { 'aria-rowcount': visible.length + 1 } : {})}>
          <caption className="sr-only">All runs, sorted by {sort.key} {sort.dir === 'asc' ? 'ascending' : 'descending'}</caption>
          <thead>
            <tr {...(windowed ? { 'aria-rowindex': 1 } : {})}>
              <SortTh label="Run" col="run" active={sort.key} dir={sort.dir} onSort={onSort} sticky />
              <th scope="col">Project</th>
              <SortTh label="When" col="when" active={sort.key} dir={sort.dir} onSort={onSort} />
              <th scope="col">Kind</th>
              <th scope="col">Models</th>
              <SortTh label="Tokens" col="tokens" active={sort.key} dir={sort.dir} onSort={onSort} num />
              <SortTh label="Cost" col="cost" active={sort.key} dir={sort.dir} onSort={onSort} num />
              <th scope="col" className="num">
                Cache hit
              </th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {win.before > 0 && (
              <tr aria-hidden="true" className="usage-spacer" style={{ height: win.before }}>
                <td colSpan={COLUMNS} />
              </tr>
            )}
            {visible.slice(win.start, win.end).map((r, i) => {
              const name = rowName(r)
              const models = rowModels(r)
              const cache = rowCacheHit(r)
              const status = rowStatusWord(r)
              return (
                <tr
                  key={r.runId}
                  className="usage-run-row"
                  data-testid="usage-run-row"
                  data-run={r.runId}
                  data-project={r.projectId}
                  style={{ height: RUN_ROW_PX }}
                  {...(windowed ? { 'aria-rowindex': win.start + i + 2 } : {})}
                >
                  <th scope="row" className="sticky usage-run-cell">
                    {r.projectRemoved ? (
                      <span className="usage-run-name" title={name}>
                        {name}
                      </span>
                    ) : (
                      <button type="button" className="usage-run-open" data-testid="usage-run-open" title={`Open ${name}`} onClick={() => void openRun(r.projectId, r.runId)}>
                        {name}
                      </button>
                    )}
                    {r.live && <span className="usage-tag" title={status.note}>{status.word}</span>}
                  </th>
                  <td title={r.projectRemoved ? `${r.projectName}. Project removed` : r.projectName}>
                    <span className="usage-clip">{r.projectName}</span>
                    {r.projectRemoved && <span className="usage-cell-sub">Project removed</span>}
                  </td>
                  <td className="nowrap">{formatDateTime(r.startedAt)}</td>
                  <td className="nowrap">{rowKindWord(r)}</td>
                  <td title={models.title}>
                    <span className="usage-clip mono">{models.text}</span>
                  </td>
                  <td className="num" title={`${totalTokens(r.usage.tokens).toLocaleString()} tokens`}>
                    {r.legacy || r.usage.legacy ? '~' : ''}
                    {formatTokens(totalTokens(r.usage.tokens))}
                  </td>
                  <td className="num">
                    <CostText value={rowCostInput(r)} />
                  </td>
                  <td className="num" title={cache.title}>
                    {cache.text}
                  </td>
                  <td className="num">{rowTime(r)}</td>
                </tr>
              )
            })}
            {win.after > 0 && (
              <tr aria-hidden="true" className="usage-spacer" style={{ height: win.after }}>
                <td colSpan={COLUMNS} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <button type="button" className="btn ghost sm usage-more-btn" data-testid="usage-runs-more" onClick={() => {
            const next = sorted[shown]
            if (next) focusAfterMore.current = { id: next.runId, index: shown }
            setShown(sorted.length)
          }}>
          Show {remaining.toLocaleString()} more
        </button>
      )}
    </>
  )
}

export default function AllRuns({ data, open, onToggle }: AllRunsProps): ReactElement {
  const count = data.rows.length
  return (
    <section className="usage-panel" id="usage-runs" aria-labelledby="usage-runs-h" data-testid="usage-runs">
      <details className="usage-runs-details" open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
        <summary data-testid="usage-runs-summary">
          <h2 id="usage-runs-h" tabIndex={-1}>
            All runs, {count.toLocaleString()}
          </h2>
        </summary>
        {open && (count === 0 ? <p className="usage-note">No runs in this view.</p> : <RunsTable rows={data.rows} />)}
      </details>
    </section>
  )
}
