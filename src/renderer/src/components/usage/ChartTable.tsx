import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import '../../styles/usage-charts.css'

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
  empty = 'Nothing to show.'
}: {
  /** `usage-<panel>-table`, on the table. */
  testId: string
  caption: string
  columns: ChartColumn[]
  rows: ChartRow[]
  empty?: string
}): ReactElement {
  const wrap = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const check = (): void => setScrolls(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length, columns.length])
  return (
    <details className="usage-table-details">
      <summary>Show as table</summary>
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
                  <th key={c.key} scope="col" className={c.numeric ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
    </details>
  )
}

function dataAttrs(d: Record<string, string> | undefined): Record<string, string> {
  if (!d) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(d)) out[`data-${k}`] = v
  return out
}
