import type { CSSProperties, FocusEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useArrival } from '../../lib/useArrival'
import { exitProps, tokenMs } from '../../lib/useExitPresence'
import { Button } from '../ui/Button'

/** How long a user-removal mark waits for its row to leave (an answer's `*.resolved` event) before it is forgotten. */
const EXIT_MARK_TTL_MS = 10_000

/**
 * Which rows left because the user did something (an answered inline decision, Clear). Only those play an exit
 * (docs/design/motion.md 2.3, 3.10): they fade and fold shut so the siblings glide up. A row that leaves because a run
 * ended elsewhere is never marked and goes at once, so no stale control lingers. One per section, from `useRowExits`.
 */
export interface RowExits {
  mark: (keys: Iterable<string>) => void
  unmark: (key: string) => void
  has: (key: string) => boolean
}

export function useRowExits(): RowExits {
  const ref = useRef<Set<string>>(new Set())
  return useMemo(
    () => ({
      mark: (keys: Iterable<string>) => {
        const marked = [...keys]
        for (const k of marked) ref.current.add(k)
        // A mark is for this one exit: forget it once the exit is over, so a key that comes back later and leaves for
        // another reason (a run ended elsewhere) goes at once (review L).
        window.setTimeout(() => {
          for (const k of marked) ref.current.delete(k)
        }, EXIT_MARK_TTL_MS)
      },
      unmark: (key: string) => {
        ref.current.delete(key)
      },
      has: (key: string) => ref.current.has(key)
    }),
    []
  )
}

/** What `renderItem` gets to say how its `li` moves: spread `rowMotionProps(motion, ownClassName)` onto it. */
export interface RowMotion {
  /** The row arrived after the list was shown (a batch arriving together staggers by `index`). */
  arrived: boolean
  index: number
  /** The row is leaving by the user's action: inert, aria-hidden, fading and folding shut. */
  leaving: boolean
}

export function rowMotionProps(motion: RowMotion, className: string): { className: string; style?: CSSProperties; 'data-state'?: 'in' | 'out'; inert?: boolean; 'aria-hidden'?: true } {
  if (motion.leaving) return { className: `${className} leave-collapse`, ...exitProps('out') }
  if (motion.arrived) return { className: `${className} motion-enter`, style: { ['--i' as string]: motion.index } }
  return { className }
}

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
  renderItem: (item: T, motion: RowMotion) => ReactNode
  /** One quiet line when there are no items; without it an empty section renders nothing. */
  empty?: string
  /** With no items the section stays mounted but `hidden`, with no empty line (the layout folds the column away). Needs `empty` unset. */
  quiet?: boolean
  /** A control for the header (e.g. Mark all seen). */
  action?: ReactNode
  /** Test id of the Show more button (default `${testId}-more`). */
  moreTestId?: string
  /** Rows that arrive after this turns true enter with `.motion-enter`; what is shown when it turns true is the baseline. */
  arrive?: boolean
  /** Keys the user removed, so those rows play their exit (see `useRowExits`). */
  exits?: RowExits
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
export function AttentionSection<T>({ testId, title, count, items, cap, itemKey, renderItem, empty, quiet, action, moreTestId, arrive, exits }: AttentionSectionProps<T>): ReactElement | null {
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

  // Arrival rule: the rows shown when `arrive` turns true are the baseline; later ones enter.
  const isNew = useArrival(keys, arrive ? 'live' : 'idle')
  let newCount = 0
  const motionOf = new Map<string, RowMotion>()
  for (const k of keys) motionOf.set(k, { arrived: !!arrive && isNew(k), index: arrive && isNew(k) ? newCount++ : 0, leaving: false })

  // User-driven exits: a marked row that left this render stays for one --dur-fast, inert, then goes.
  const [leaving, setLeaving] = useState<{ item: T; index: number }[]>([])
  const [prevRows, setPrevRows] = useState<{ sig: string; list: readonly T[] }>({ sig: keySignature, list: shown })
  if (prevRows.sig !== keySignature) {
    const keep = new Set(keys)
    const gone =
      exits && tokenMs('--dur-fast') > 0
        ? prevRows.list.map((item, index) => ({ item, index })).filter((r) => !keep.has(itemKey(r.item)) && exits.has(itemKey(r.item)))
        : []
    setPrevRows({ sig: keySignature, list: shown })
    setLeaving([...leaving.filter((l) => !keep.has(itemKey(l.item))), ...gone])
  }
  useEffect(() => {
    if (leaving.length === 0) return undefined
    const t = window.setTimeout(() => setLeaving([]), tokenMs('--dur-fast'))
    return () => window.clearTimeout(t)
  }, [leaving])
  const rows: { item: T; leaving: boolean }[] = shown.map((item) => ({ item, leaving: false }))
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) rows.splice(Math.min(l.index, rows.length), 0, { item: l.item, leaving: true })

  useLayoutEffect(() => {
    const prev = last.current
    if (!prev || keys.includes(prev.key)) return
    last.current = null
    const active = document.activeElement
    // Focus inside a row that is leaving counts as lost: that row is inert now.
    if (active && active !== document.body && active !== document.documentElement && !active.closest('[data-state="out"]')) return
    // A row still leaving is inert and cannot take focus.
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row-key]:not([data-state="out"]) [data-row-main]')
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

  if (rows.length === 0 && !empty && !quiet) return null
  return (
    <section ref={sectionRef} className="dash-section" data-testid={testId} aria-labelledby={headingId} hidden={rows.length === 0 && quiet ? true : undefined}>
      <div className="dash-section-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} data-section-heading="">
          {title}
        </h2>
        {count > 0 && <span className="dash-count">{count}</span>}
        {action && <span className="dash-section-action">{action}</span>}
      </div>
      {rows.length === 0 ? (
        empty ? <p className="dash-empty">{empty}</p> : null
      ) : (
        <ul className="dash-rows" ref={listRef} onFocus={onFocus} onBlur={onBlur}>
          {rows.map((r) => renderItem(r.item, r.leaving ? { arrived: false, index: 0, leaving: true } : (motionOf.get(itemKey(r.item)) as RowMotion)))}
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
