import type { ReactElement, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UsageOverviewRow } from '@shared/types'
import { formatTokens } from '../../lib/cost'
import { rowCacheHit, rowCostInput, rowName } from '../../lib/usageRuns'
import { useAppStore } from '../../store/useAppStore'
import '../../styles/usage-tables.css'
import '../../styles/usage-runs.css'

/** The chevron button at the start of a run row: toggles its detail row (one disclosure level, plan 2.7). */
export function RunToggle({ open, detailId, mounted, onToggle, name }: { open: boolean; detailId: string; mounted: boolean; onToggle: () => void; name: string }): ReactElement {
  // A fixed name; aria-expanded alone carries the state (Reviewer: the state was said twice and every row read the same).
  return (
    <button
      type="button"
      className="usage-run-toggle"
      data-testid="usage-run-toggle"
      aria-expanded={open}
      aria-controls={mounted ? detailId : undefined}
      aria-label={`Details of ${name}`}
      title={open ? 'Hide details' : 'Show details'}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/**
 * The in-table detail row of a run: a `.motion-collapse` grid (height 0fr to 1fr) whose closed content is
 * visibility: hidden, so it is out of the tab order and the accessibility tree. Mounted collapsed on first open and
 * opened one frame later so the first open glides too.
 */
export function RunDetailRow({ id, colSpan, open, row, why }: { id: string; colSpan: number; open: boolean; row: UsageOverviewRow; why?: string }): ReactElement {
  const openRun = useAppStore((s) => s.openUsageRun)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!open) {
      setReady(false)
      return undefined
    }
    const f = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(f)
  }, [open])
  const t = row.usage.tokens
  const cache = rowCacheHit(row)
  const unpriced = rowCostInput(row).costUsd === null
  const name = rowName(row)
  const shown = open && ready
  return (
    <tr className="usage-run-detail-row" data-open={shown ? 'true' : 'false'}>
      <td colSpan={colSpan}>
        <div id={id} className="motion-collapse usage-run-detail" data-testid="usage-run-detail" data-collapsed={shown ? 'false' : 'true'} role="group" aria-label={`Details of ${name}`}>
          <div>
            <div className="usage-run-detail-body">
              {why && <p className="usage-run-why">{why}</p>}
              <dl className="usage-run-facts">
                <div>
                  <dt>Tokens in</dt>
                  <dd>{formatTokens(t.input)}</dd>
                </div>
                <div>
                  <dt>Tokens out</dt>
                  <dd>{formatTokens(t.output)}</dd>
                </div>
                <div>
                  <dt>Cache hit</dt>
                  <dd title={cache.title}>{cache.text}</dd>
                </div>
              </dl>
              {unpriced && <p className="usage-run-unpriced">No price is known for this run, so its cost is not counted in the totals.</p>}
              {!row.projectRemoved && (
                <button type="button" className="btn ghost sm" data-testid="usage-run-open" onClick={() => void openRun(row.projectId, row.runId)}>
                  Open run
                </button>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  )
}

/** A sortable column header: a native button inside the th, `aria-sort` on the th (docs/design/usage-app.md 6.5, 7.3). */
export function SortTh<K extends string>({
  label,
  col,
  active,
  dir,
  onSort,
  num,
  sticky
}: {
  label: string
  col: K
  active: K
  dir: 'asc' | 'desc'
  onSort: (col: K) => void
  num?: boolean
  sticky?: boolean
}): ReactElement {
  const on = active === col
  return (
    <th scope="col" className={`${num ? 'num' : ''}${sticky ? ' sticky' : ''}`.trim() || undefined} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="usage-sort" onClick={() => onSort(col)} data-testid={`usage-sort-${col}`}>
        {label}
        <span className="usage-sort-mark" aria-hidden="true">
          {on ? (dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  )
}

/** True while the element scrolls sideways (the wrapper then becomes a keyboard stop). */
export function useOverflowX(ref: RefObject<HTMLElement | null>): boolean {
  const [over, setOver] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setOver(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const table = el.firstElementChild
    if (table) ro.observe(table)
    return () => ro.disconnect()
  }, [ref])
  return over
}

/** The scroll wrapper of a usage table: sideways scroll inside it, never the page; a tab stop only while it scrolls. */
export function TableWrap({ label, children, className }: { label: string; children: ReactNode; className?: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const over = useOverflowX(ref)
  return (
    <div ref={ref} className={`usage-table-wrap usage-tbl-wrap${className ? ` ${className}` : ''}`} {...(over ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}>
      {children}
    </div>
  )
}
