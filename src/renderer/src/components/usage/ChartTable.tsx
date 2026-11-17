import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ariaSort, nextSort, sortAnnouncement, sortRows, type SortState, type SortValue } from '../../lib/usageDashboard'
import '../../styles/usage-charts.css'
import '../../styles/usage-breakdown.css'

export interface ChartColumn {
  key: string
  label: string
  /** Right-aligned tabular figures. */
  numeric?: boolean
}

export interface ChartRow {
  key: string
  /** One cell per column, in order. */
  cells: ReactNode[]
  /** Plain data attributes for tests and styling. */
  data?: Record<string, string>
  /**
   * One sort key per column (lib/usageDashboard.ts SortValue: number, string, or null for unknown which sorts last).
   * When the rows carry these, the column headers become sort buttons. Dashboard increment 2.
   */
  sort?: SortValue[]
}

/**
 * A chart's table alternative: a native `details` "Show as table" holding a captioned table in a scroller that is one
 * Tab stop only while it overflows. The first column sticks.
 */
export function ChartTable({
  testId,
  caption,
  columns,
  rows,
  empty = 'Nothing to show.',
  announce,
  open,
  id
}: {
  /** Controlled mode: when set, no "Show as table" disclosure; the table shows only while true. */
  open?: boolean
  /** The wrapper's id in controlled mode, for the caller's aria-controls. */
  id?: string
  /** `usage-<panel>-table`, on the table. */
  testId: string
  caption: string
  columns: ChartColumn[]
  rows: ChartRow[]
  empty?: string
  /** Says "Sorted by ..." through the page's polite region after a header press. */
  announce?: (text: string) => void
}): ReactElement {
  const wrap = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  const [sort, setSort] = useState<SortState | null>(null)
  const sortable = rows.some((r) => r.sort)
  const colIndex = sort ? columns.findIndex((c) => c.key === sort.key) : -1
  const shownRows =
    sort && colIndex >= 0 ? sortRows(rows, (r) => r.sort?.[colIndex] ?? null, sort.dir) : rows
  const press = (c: ChartColumn): void => {
    const next = nextSort(sort, c.key, !!c.numeric)
    setSort(next)
    announce?.(sortAnnouncement(c.label, next.dir, !!c.numeric))
  }
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const check = (): void => setScrolls(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length, columns.length])
  const body = (
      <div
        ref={wrap}
        className="usage-table-wrap"
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? caption : undefined}
      >
        {rows.length === 0 ? (
          <p className="uc-table-empty">{empty}</p>
        ) : (
          <table className="uc-table" data-testid={testId}>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined} aria-sort={sortable ? ariaSort(sort, c.key) : undefined}>
                    {sortable ? (
                      <button type="button" className="uc-sort" data-testid="usage-table-sort" data-col={c.key} onClick={() => press(c)}>
                        <span>{c.label}</span>
                        <span className="uc-sort-glyph" aria-hidden="true">
                          {sort?.key === c.key && (
                            <svg viewBox="0 0 10 10" width="10" height="10" focusable="false">
                              <path d={sort.dir === 'asc' ? 'M5 2 L9 8 H1 Z' : 'M5 8 L9 2 H1 Z'} fill="currentColor" />
                            </svg>
                          )}
                        </span>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((r) => (
                <tr key={r.key} {...dataAttrs(r.data)}>
                  {r.cells.map((cell, i) =>
                    i === 0 ? (
                      <th key={i} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={i} className={columns[i]?.numeric ? 'num' : undefined}>
                        {cell}
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
  )
  // Controlled (increment 3): the caller's header button (aria-expanded, aria-controls = id) shows it; no details.
  if (open !== undefined) {
    return (
      <div id={id} className="usage-table-controlled" hidden={!open}>
        {open ? body : null}
      </div>
    )
  }
  return (
    <details className="usage-table-details">
      <summary>Show as table</summary>
      {body}
    </details>
  )
}

function dataAttrs(d: Record<string, string> | undefined): Record<string, string> {
  if (!d) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(d)) out[`data-${k}`] = v
  return out
}
