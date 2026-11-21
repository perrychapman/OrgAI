import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'

/**
 * A definition on the label it defines (docs/design/dashboard-usage-redesign usage.md: the closed Definitions section is
 * retired). The tip is a `role="tooltip"` element that the label describes (`aria-describedby`), so a screen reader
 * reads it with the label; it shows on hover and on keyboard focus, and Esc hides it until the pointer or focus leaves
 * (WCAG 1.4.13: dismissible, hoverable, persistent). It is never the only way to read a value: it holds a definition only.
 */

/** Esc hides the tip of the closest host until pointer or focus leaves it. */
export const tipHandlers = {
  onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.dataset.tipOff) host.dataset.tipOff = 'true'
  },
  onBlur: (e: FocusEvent<HTMLElement>): void => {
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.contains(e.relatedTarget as Node | null)) delete host.dataset.tipOff
  },
  onPointerLeave: (e: PointerEvent<HTMLElement>): void => {
    const host = e.currentTarget.closest<HTMLElement>('[data-tip-host]')
    if (host && !host.matches(':focus-within')) delete host.dataset.tipOff
  }
}

/** The tooltip element itself; the label or tile that it defines points at it with aria-describedby={id}. */
export function DefinitionTip({ id, text, className }: { id: string; text: string; className?: string }): ReactElement {
  return (
    <span id={id} role="tooltip" className={className ? `usage-term-tip ${className}` : 'usage-term-tip'} data-testid="usage-term-tip">
      {text}
    </span>
  )
}

/** Time the pointer may take to travel from the label to its tip before the tip goes (WCAG 1.4.13 hoverable). */
const FLOAT_LEAVE_MS = 160

/**
 * A label that carries its definition: one keyboard stop (a native button, so the tip is reachable without a pointer),
 * the definition read as its description. Use inside a `dt`, a list item or a heading line; `align="end"` opens the tip
 * leftwards for a label near the right edge.
 *
 * `floating` is for a label inside a scroller or a table wrapper that would clip an absolutely placed tip: the tip then
 * lives in the top layer (a manual popover) and is placed from the label's rectangle, below it or above when there is no room.
 */
export default function DefinedTerm({
  text,
  children,
  align = 'start',
  testId = 'usage-term',
  floating = false
}: {
  text: string
  children: ReactNode
  align?: 'start' | 'end'
  testId?: string
  floating?: boolean
}): ReactElement {
  const id = useId()
  const btnRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (!floating) {
    return (
      <span className="usage-term-host" data-tip-host="" data-align={align} onPointerLeave={tipHandlers.onPointerLeave} onBlur={tipHandlers.onBlur}>
        {/* A native button: it has a role and a name, takes Tab and shows the tip on focus. It does nothing on press. */}
        <button type="button" className="usage-term" aria-describedby={id} data-testid={testId} onKeyDown={tipHandlers.onKeyDown}>
          {children}
        </button>
        <DefinitionTip id={id} text={text} />
      </span>
    )
  }

  const open = (): void => {
    window.clearTimeout(timer.current)
    const tip = tipRef.current
    const btn = btnRef.current
    if (!tip || !btn || typeof tip.showPopover !== 'function') return
    if (!tip.matches(':popover-open')) tip.showPopover()
    const r = btn.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    const left = align === 'end' ? r.right - w : r.left
    tip.style.left = `${Math.round(Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8)))}px`
    const below = r.bottom + 4
    tip.style.top = `${Math.round(below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below)}px`
  }
  const close = (): void => {
    window.clearTimeout(timer.current)
    const tip = tipRef.current
    if (tip && typeof tip.hidePopover === 'function' && tip.matches(':popover-open')) tip.hidePopover()
  }
  const closeSoon = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(close, FLOAT_LEAVE_MS)
  }
  const focused = (): boolean => btnRef.current?.matches(':focus') ?? false
  return (
    <span
      className="usage-term-host"
      onPointerEnter={open}
      onPointerLeave={() => {
        if (!focused()) closeSoon()
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className="usage-term"
        aria-describedby={id}
        data-testid={testId}
        onFocus={open}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
      >
        {children}
      </button>
      <span ref={tipRef} id={id} role="tooltip" popover="manual" className="usage-term-tip usage-term-float" data-testid="usage-term-tip">
        {text}
      </span>
    </span>
  )
}
