import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { costView, type CostInput } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { tokenMs } from '../../lib/useExitPresence'
import { costFigureText } from '../../lib/usageCharts'
import { ribbonNote, ribbonTitle, type Ribbon } from '../../lib/usageRibbon'
import { enterIndex, flipPlan } from './rankFlip'
import '../../styles/usage-charts.css'

/** Rows shown before "Show all N" in every Where it went tab. */
export const RANK_TOP = 5

/** True for a short while after the user changed the Where it went tab: the rows rise in. */
export const RankEnterContext = createContext(false)
/**
 * The draw generation (0 = nothing to draw): ranked bars grow from the left and the ribbon wipes in each time it rises
 * (page arrival, a filter or metric change the person made, a tab they chose). Never for a background refresh.
 */
export const RankDrawContext = createContext(0)

/** The colour of the n-th ranked row where rows have no series of their own (models, roles, connections): s1..s5, then Other. */
export function rankFill(index: number): string {
  return index >= 0 && index < RANK_TOP ? `var(--chart-s${index + 1})` : 'var(--chart-other)'
}
/**
 * The filters the user last chose (a stable string). A reorder glides only within REORDER_ARM_MS of it changing, so a
 * silent refresh that reorders rows never animates (Reviewer M2).
 */
export const RankArmContext = createContext('')
const REORDER_ARM_MS = 5000

/** One cost figure on the page: "No price" for unknown (never $0), "+" and "~" as costView says, full value in the title. */
export function CostText({ value, title }: { value: CostInput; title?: string }): ReactElement {
  const v = costView(value, { precision: 'page' })
  return (
    <span className={`cost cost-${v.kind}`} title={title ?? (v.title || undefined)}>
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
  /** Replaces the cost's own title (why it is unknown). */
  costTitle?: string
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
  /** The series key this row stands for (compared with `highlighted`); defaults to `id`. */
  seriesKey?: string
}

/** A horizontal bar in a row: solid, solid + hatched end (partial), or a dashed stub (unknown). */
function RankBar({ fraction, state, fill, draw }: { fraction: number; state: RankState; fill: string; draw: number | null }): ReactElement {
  const pid = `uch${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const pct = `${(fraction * 100).toFixed(2)}%`
  return (
    <svg
      className={draw === null ? 'uc-rank-bar' : 'uc-rank-bar motion-draw-grow'}
      style={draw === null ? undefined : ({ '--i': draw } as CSSProperties)}
      aria-hidden="true"
      focusable="false"
      height="10"
      width="100%"
    >
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
  moreLabel,
  onHover,
  highlighted,
  ribbon
}: {
  /** The proportional ribbon that leads the rows (lib/usageRibbon.ts buildRibbon); omitted = none. */
  ribbon?: Ribbon
  label: string
  items: RankedItem[]
  rowTestId: string
  onActivate: (item: RankedItem) => void
  /** Open the row menu on the row's button (Right, Shift+F10, the Menu key, or the More button). */
  onMenu?: (item: RankedItem, anchor: HTMLElement) => void
  moreLabel?: (item: RankedItem) => string
  /** Pointer enter or focus on a row passes its item; leaving the list (pointer or focus) passes null. Never announced. */
  onHover?: (item: RankedItem | null) => void
  /** A series key; rows whose `seriesKey` (or id) equals it get data-highlight. */
  highlighted?: string | null
}): ReactElement {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const [active, setActive] = useState<string | null>(null)
  const current = items.some((i) => i.id === active) ? active : (items[0]?.id ?? null)
  const enter = useContext(RankEnterContext)
  const gen = useContext(RankDrawContext)
  const reduced = useReducedMotion()
  // The row a pointer or focus is on lights its ribbon segment (and the segment lights its row's highlight, below).
  const [peek, setPeek] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const lastLayout = useRef<{ keys: string[]; tops: Map<string, number> }>({ keys: [], tops: new Map() })
  const arm = useContext(RankArmContext)
  const armSeen = useRef({ arm, at: 0 })
  // A highlight dims the other rows only while some row matches it.
  const hlOn = highlighted != null && items.some((it) => (it.seriesKey ?? it.id) === highlighted)

  // FLIP (plan M10): the same rows in a new order glide from their old place (transform only, at most 8, none when
  // motion is reduced). offsetTop ignores any transform still running, so a second reorder starts from the real layout.
  useLayoutEffect(() => {
    const ul = listRef.current
    if (!ul) return
    if (armSeen.current.arm !== arm) armSeen.current = { arm, at: performance.now() }
    const keys = items.map((it) => it.id)
    // Same rows in the same order (hover, highlight, a refresh that kept the ranking): nothing to measure.
    if (keys.length === lastLayout.current.keys.length && keys.every((k, i) => k === lastLayout.current.keys[i])) return
    const armed = performance.now() - armSeen.current.at <= REORDER_ARM_MS
    const tops = new Map<string, number>()
    const els = Array.from(ul.children) as HTMLElement[]
    keys.forEach((k, i) => {
      const el = els[i]
      if (el) tops.set(k, el.offsetTop)
    })
    const prev = lastLayout.current
    lastLayout.current = { keys, tops }
    if (!armed || reduced || typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return
    const ms = tokenMs('--dur-slow')
    if (ms <= 1) return
    const plan = flipPlan(prev.keys, keys, prev.tops, tops)
    if (plan.length === 0) return
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-in-out').trim() || 'ease-in-out'
    for (const m of plan) {
      const el = els[keys.indexOf(m.key)]
      if (!el) continue
      for (const a of el.getAnimations()) a.cancel()
      el.animate([{ transform: `translateY(${m.delta}px)` }, { transform: 'none' }], { duration: ms, easing })
    }
  })

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

  const drawing = gen > 0 && !reduced
  // Only the rows that were there when this generation rose grow: a row that appears later (Show all, a background refresh)
  // never replays the draw.
  const drawnRef = useRef<{ gen: number; ids: Set<string> }>({ gen: -1, ids: new Set() })
  if (drawnRef.current.gen !== gen) drawnRef.current = { gen, ids: new Set(items.map((it) => it.id)) }
  const grows = (id: string): boolean => drawing && drawnRef.current.ids.has(id)
  const peekOn = peek !== null && !!ribbon?.segments.some((s) => s.id === peek)
  const ribbonNoteText = ribbon ? ribbonNote(ribbon) : ''
  const leave = (): void => {
    setPeek(null)
    onHover?.(null)
  }

  return (
    <>
      {ribbon && ribbon.segments.length > 0 && (
        // A pointer shortcut only: the rows below are the accessible path (names, figures, one Tab stop), so the ribbon is
        // hidden from assistive tech and holds no focus stops.
        <div className="uc-ribbon" data-testid="usage-where-ribbon" aria-hidden="true" data-hl={peekOn ? 'on' : undefined} onPointerLeave={leave}>
          <div key={gen} className={drawing ? 'uc-ribbon-track motion-draw-wipe' : 'uc-ribbon-track'} data-draw={gen}>
            {ribbon.segments.map((s) => {
              const item = s.id === null ? undefined : items.find((it) => it.id === s.id)
              return (
                <span
                  key={s.id ?? 'other'}
                  className="uc-ribbon-seg"
                  data-testid="usage-where-ribbon-seg"
                  data-id={s.id ?? 'other'}
                  data-other={s.id === null ? 'true' : undefined}
                  data-partial={s.partial ? 'true' : undefined}
                  data-peek={s.id !== null && s.id === peek ? 'true' : undefined}
                  title={ribbonTitle(s)}
                  style={{ flexGrow: s.share, background: s.fill }}
                  onPointerEnter={() => {
                    setPeek(s.id)
                    if (item) onHover?.(item)
                  }}
                  onClick={item ? () => onActivate(item) : undefined}
                />
              )
            })}
          </div>
        </div>
      )}
      {ribbonNoteText && (
        <p className="uc-ribbon-note" data-testid="usage-where-ribbon-note">
          {ribbonNoteText}
        </p>
      )}
    <ul
      ref={listRef}
      className="uc-rank"
      data-hl={hlOn ? 'on' : undefined}
      data-enter={enter ? 'true' : undefined}
      aria-label={label}
      onPointerLeave={leave}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave()
      }}
    >
      {items.map((item, i) => {
        const stagger = enter ? enterIndex(i) : null
        return (
        <li
          key={item.id}
          className={stagger === null ? 'uc-rank-row' : 'uc-rank-row motion-enter'}
          style={stagger === null ? undefined : ({ '--i': stagger } as CSSProperties)}
          data-testid={rowTestId}
          data-state={item.state}
          data-selected={item.selected ? 'true' : undefined}
          data-highlight={highlighted != null && (item.seriesKey ?? item.id) === highlighted ? 'true' : undefined}
          data-peek={ribbon && peek === item.id ? 'true' : undefined}
          onPointerEnter={() => {
            setPeek(item.id)
            onHover?.(item)
          }}
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
            onFocus={() => {
              setActive(item.id)
              setPeek(item.id)
              onHover?.(item)
            }}
            onClick={() => onActivate(item)}
            onKeyDown={(e) => onKey(e, item, i)}
            onContextMenu={(e) => {
              if (!onMenu) return
              e.preventDefault()
              onMenu(item, e.currentTarget)
            }}
            aria-current={item.selected ? 'true' : undefined}
            title={item.name}
          >
            <span className="uc-rank-name">
              {item.mark}
              <span className="uc-rank-text">{item.shown}</span>
            </span>
            {item.sub && <span className="uc-rank-sub">{item.sub}</span>}
            <RankBar key={gen} fraction={item.fraction} state={item.state} fill={item.fill} draw={grows(item.id) ? Math.min(i, 5) : null} />
            <span className="uc-rank-cost">
              <CostText value={item.cost} title={item.costTitle} />
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
        )
      })}
    </ul>
    </>
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
