import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { costView, type CostInput } from '../../lib/cost'
import { costFigureText } from '../../lib/usageCharts'
import '../../styles/usage-charts.css'

/** One cost figure on the page: "No price" for unknown (never $0), "+" and "~" as costView says, full value in the title. */
export function CostText({ value }: { value: CostInput }): ReactElement {
  const v = costView(value, { precision: 'page' })
  return (
    <span className={`cost cost-${v.kind}`} title={v.title || undefined}>
      {costFigureText(value)}
    </span>
  )
}

/** Three panels sit across from a 1280 px window (spec 9); under it they stack and show fewer rows. */
export function useWidePage(): boolean {
  const q = '(min-width: 1280px)'
  const [wide, setWide] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = (): void => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

export type RankState = 'known' | 'partial' | 'unknown'

export interface RankedItem {
  id: string
  /** Data attributes for the row (`data-id`, ...). */
  data: Record<string, string>
  /** A small mark before the name (engagements). */
  mark?: ReactNode
  /** Full name, the row's title. */
  name: string
  /** The clipped name drawn. */
  shown: string
  /** Muted line under the name. */
  sub?: ReactNode
  /** Bar length 0..1. */
  fraction: number
  state: RankState
  /** A CSS colour (a token reference). */
  fill: string
  cost: CostInput
  /** "14 runs" or "1.2M tokens". */
  detail: string
  /** Plain text after the detail ("3 retries"). */
  note?: string
  /** Rendered after the row button, outside it (a link such as "Set a price"). */
  extra?: ReactNode
  /** Row gets the selected look (a narrowing is on it). */
  selected?: boolean
  /** Extra sr-only text inside the button. */
  srText?: string
}

/** A horizontal bar in a row: solid, solid + hatched end (partial), or a dashed stub (unknown). */
function RankBar({ fraction, state, fill }: { fraction: number; state: RankState; fill: string }): ReactElement {
  const pid = `uch${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const pct = `${(fraction * 100).toFixed(2)}%`
  return (
    <svg className="uc-rank-bar" aria-hidden="true" focusable="false" height="10" width="100%">
      {state === 'unknown' ? (
        <rect x="0.5" y="0.5" width="24" height="9" fill="none" stroke="var(--chart-unknown)" strokeWidth="1" strokeDasharray="3 2" />
      ) : (
        <svg x="0" y="0" width={pct} height="10" overflow="hidden">
          <defs>
            <pattern id={pid} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-hatch)" strokeWidth="1.5" />
            </pattern>
          </defs>
          <rect x="0" y="0" width="100%" height="10" fill={fill} />
          {state === 'partial' && <rect x="100%" y="0" width="8" height="10" transform="translate(-8 0)" fill={`url(#${pid})`} />}
        </svg>
      )}
    </svg>
  )
}

/**
 * Ranked horizontal bars as a list of row buttons with one Tab stop (roving): Up/Down/Home/End move, Enter or click
 * activates, Right arrow, Shift+F10 or the Menu key ask for the row menu. Rows are plain list items, so a row's own
 * extra link stays a normal control after it.
 */
export function RankedBars({
  label,
  items,
  rowTestId,
  onActivate,
  onMenu,
  moreLabel
}: {
  label: string
  items: RankedItem[]
  rowTestId: string
  onActivate: (item: RankedItem) => void
  /** Open the row menu on the row's button (Right, Shift+F10, the Menu key, or the More button). */
  onMenu?: (item: RankedItem, anchor: HTMLElement) => void
  moreLabel?: (item: RankedItem) => string
}): ReactElement {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const [active, setActive] = useState<string | null>(null)
  const current = items.some((i) => i.id === active) ? active : (items[0]?.id ?? null)

  const focusAt = (i: number): void => {
    const it = items[Math.max(0, Math.min(items.length - 1, i))]
    if (!it) return
    setActive(it.id)
    refs.current.get(it.id)?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, item: RankedItem, i: number): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'ArrowDown') focusAt(i + 1)
    else if (e.key === 'ArrowUp') focusAt(i - 1)
    else if (e.key === 'Home') focusAt(0)
    else if (e.key === 'End') focusAt(items.length - 1)
    else if ((e.key === 'ArrowRight' && !e.shiftKey) || (e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      if (!onMenu) return
      onMenu(item, e.currentTarget)
    } else return
    e.preventDefault()
  }

  return (
    <ul className="uc-rank" aria-label={label}>
      {items.map((item, i) => (
        <li
          key={item.id}
          className="uc-rank-row"
          data-testid={rowTestId}
          data-state={item.state}
          data-selected={item.selected ? 'true' : undefined}
          {...Object.fromEntries(Object.entries(item.data).map(([k, v]) => [`data-${k}`, v]))}
        >
          <button
            type="button"
            className="uc-rank-main"
            tabIndex={item.id === current ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(item.id, el)
              else refs.current.delete(item.id)
            }}
            onFocus={() => setActive(item.id)}
            onClick={() => onActivate(item)}
            onKeyDown={(e) => onKey(e, item, i)}
            onContextMenu={(e) => {
              if (!onMenu) return
              e.preventDefault()
              onMenu(item, e.currentTarget)
            }}
            aria-pressed={item.selected ? true : undefined}
            title={item.name}
          >
            <span className="uc-rank-name">
              {item.mark}
              <span className="uc-rank-text">{item.shown}</span>
            </span>
            {item.sub && <span className="uc-rank-sub">{item.sub}</span>}
            <RankBar fraction={item.fraction} state={item.state} fill={item.fill} />
            <span className="uc-rank-cost">
              <CostText value={item.cost} />
            </span>
            <span className="uc-rank-detail">
              {item.detail}
              {item.note ? <span className="uc-rank-note">{item.note}</span> : null}
            </span>
            {item.srText && <span className="sr-only">{item.srText}</span>}
          </button>
          {onMenu && (
            <button
              type="button"
              className="uc-rank-more"
              tabIndex={-1}
              aria-label={moreLabel?.(item) ?? `More for ${item.name}`}
              onClick={(e) => onMenu(item, refs.current.get(item.id) ?? e.currentTarget)}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                <circle cx="13" cy="8" r="1.4" fill="currentColor" />
              </svg>
            </button>
          )}
          {item.extra}
        </li>
      ))}
    </ul>
  )
}

export interface MenuEntry {
  id: string
  label: string
  testId?: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * A small native popover menu opened on an anchor: mounted only while open, placed under the anchor's right edge,
 * Up/Down/Home/End move, Enter selects, Esc and outside click close and focus returns to the anchor.
 */
export function RowMenu({
  anchor,
  entries,
  label,
  testId,
  onClose
}: {
  anchor: HTMLElement
  entries: MenuEntry[]
  label: string
  testId: string
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      el.showPopover()
    } catch {
      /* already open */
    }
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
    let top = r.bottom + 4
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
    setPlaced(true)
  }, [anchor])

  useEffect(() => {
    const el = ref.current
    if (!el || !placed) return
    el.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  }, [placed])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = (e: Event): void => {
      if ((e as ToggleEvent).newState === 'closed') {
        onClose()
        anchor.focus()
      }
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [anchor, onClose])

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (e.key === 'ArrowDown') next = (at + 1) % buttons.length
    else if (e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = buttons.length - 1
    else if (e.key === 'ArrowLeft') {
      ref.current?.hidePopover()
      e.preventDefault()
      return
    } else return
    e.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div ref={ref} popover="auto" role="menu" aria-label={label} className="uc-menu" data-testid={testId} data-placed={placed} onKeyDown={onKey}>
      {entries.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          className="uc-menu-item"
          data-testid={m.testId}
          disabled={m.disabled}
          onClick={() => {
            const run = m.onSelect
            ref.current?.hidePopover()
            run()
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}
