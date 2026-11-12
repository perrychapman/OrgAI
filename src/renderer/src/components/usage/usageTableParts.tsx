import type { ReactElement, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import '../../styles/usage-tables.css'

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
