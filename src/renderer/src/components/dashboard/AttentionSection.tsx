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
  /** With no items the section stays mounted but `hidden`, with no empty line (the layout folds the column away). Needs `empty` unset. */
  quiet?: boolean
  /** A control for the header (e.g. Mark all seen). */
  action?: ReactNode
  /** Test id of the Show more button (default `${testId}-more`). */
  moreTestId?: string
}

const visible = (el: HTMLElement): boolean => !el.closest('[hidden]') && el.getClientRects().length > 0

/**
 * The heading to hand focus to when `section` goes away (spec 12.2): the next visible `[data-section-heading]` after it
 * in document order, else the previous one, else the topbar h1. Never body.
 */
export function headingAfter(section: Element | null): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-section-heading]')).filter((h) => !section?.contains(h) && visible(h))
  const next = section ? all.find((h) => section.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined
  const prev = section ? [...all].reverse().find((h) => section.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) : undefined
  return next ?? prev ?? document.querySelector<HTMLElement>('main .topbar h1')
}

/** Focus `target` after React has removed what is going away; never leaves focus on body. */
export function focusAfterRemoval(target: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const t = target && target.isConnected ? target : document.querySelector<HTMLElement>('main .topbar h1')
    if (!t) return
    if (!t.hasAttribute('tabindex')) t.tabIndex = -1
    t.focus({ preventScroll: true })
  })
}

/**
 * One section of the attention column (spec 4): h2 with a count, a list of rows capped with an in-place
 * "Show N more" / "Show fewer" ghost button, and the focus rule of spec 7: when the focused row disappears, focus
 * moves to the row now at its place, else to the section heading (tabIndex -1).
 */
export function AttentionSection<T>({ testId, title, count, items, cap, itemKey, renderItem, empty, quiet, action, moreTestId }: AttentionSectionProps<T>): ReactElement | null {
  const headingId = useId()
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
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
    if (rows && rows.length > 0) {
      rows[Math.min(prev.index, rows.length - 1)].focus({ preventScroll: true })
    } else if (quiet) {
      // The section is hidden now: its heading cannot take focus, so the next one does.
      focusAfterRemoval(headingAfter(sectionRef.current))
    } else {
      headingRef.current?.focus({ preventScroll: true })
    }
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

  if (items.length === 0 && !empty && !quiet) return null
  return (
    <section ref={sectionRef} className="dash-section" data-testid={testId} aria-labelledby={headingId} hidden={items.length === 0 && quiet ? true : undefined}>
      <div className="dash-section-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} data-section-heading="">
          {title}
        </h2>
        {count > 0 && <span className="dash-count">{count}</span>}
        {action && <span className="dash-section-action">{action}</span>}
      </div>
      {items.length === 0 ? (
        empty ? <p className="dash-empty">{empty}</p> : null
      ) : (
        <ul className="dash-rows" ref={listRef} onFocus={onFocus} onBlur={onBlur}>
          {shown.map((item) => renderItem(item))}
        </ul>
      )}
      {hidden > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} testId={moreTestId ?? `${testId}-more`}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </Button>
      )}
    </section>
  )
}
