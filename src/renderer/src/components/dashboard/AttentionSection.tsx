import type { FocusEvent, ReactElement, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'

export interface AttentionSectionProps<T> {
  testId: string
  title: string
  /** Shown in mono beside the title when above zero. */
  count: number
  items: readonly T[]
  /** Visible rows before "Show N more". */
  cap: number
  itemKey: (item: T) => string
  /** Returns the row's `li`. It must carry `data-row-key={itemKey(item)}` and mark its main button `data-row-main`. */
  renderItem: (item: T) => ReactNode
  /** One quiet line when there are no items; without it an empty section renders nothing. */
  empty?: string
  /** A control for the header (e.g. Mark all seen). */
  action?: ReactNode
}

/**
 * One section of the attention column (spec 4): h2 with a count, a list of rows capped with an in-place
 * "Show N more" / "Show fewer" ghost button, and the focus rule of spec 7: when the focused row disappears, focus
 * moves to the row now at its place, else to the section heading (tabIndex -1).
 */
export function AttentionSection<T>({ testId, title, count, items, cap, itemKey, renderItem, empty, action }: AttentionSectionProps<T>): ReactElement | null {
  const headingId = useId()
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const last = useRef<{ key: string; index: number } | null>(null)

  const hidden = Math.max(0, items.length - cap)
  const shown = expanded ? items : items.slice(0, cap)
  const keys = shown.map(itemKey)
  const keySignature = keys.join('\u0000')

  useLayoutEffect(() => {
    const prev = last.current
    if (!prev || keys.includes(prev.key)) return
    last.current = null
    const active = document.activeElement
    if (active && active !== document.body && active !== document.documentElement) return
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row-main]')
    const target = rows && rows.length > 0 ? rows[Math.min(prev.index, rows.length - 1)] : headingRef.current
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature])

  const onFocus = (e: FocusEvent<HTMLUListElement>): void => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]')
    const list = listRef.current
    if (!li || !list || !list.contains(li)) return
    const all = Array.from(list.querySelectorAll<HTMLElement>('[data-row-key]'))
    last.current = { key: li.dataset.rowKey ?? '', index: all.indexOf(li) }
  }
  const onBlur = (e: FocusEvent<HTMLUListElement>): void => {
    // Focus moved to another element: forget the row. A removed row blurs with no relatedTarget and is kept.
    if (e.relatedTarget) last.current = null
  }

  if (items.length === 0 && !empty) return null
  return (
    <section className="dash-section" data-testid={testId} aria-labelledby={headingId}>
      <div className="dash-section-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} data-section-heading="">
          {title}
        </h2>
        {count > 0 && <span className="dash-count">{count}</span>}
        {action && <span className="dash-section-action">{action}</span>}
      </div>
      {items.length === 0 ? (
        <p className="dash-empty">{empty}</p>
      ) : (
        <ul className="dash-rows" ref={listRef} onFocus={onFocus} onBlur={onBlur}>
          {shown.map((item) => renderItem(item))}
        </ul>
      )}
      {hidden > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} testId={`${testId}-more`}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </Button>
      )}
    </section>
  )
}
