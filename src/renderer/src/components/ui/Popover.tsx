import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

const MARGIN = 8
const GAP = 6

/**
 * A panel on the native `popover` attribute (top layer, Esc and click-outside close come from the platform),
 * anchored to its own trigger button. The component renders the trigger so aria-expanded, aria-controls and
 * the focus return stay in one place. Children mount only while open; pass a function to get a `close()`.
 *
 * Positioning is plain JS (trigger rect, flipped and clamped into the viewport), not CSS anchor positioning,
 * so it does not depend on the Chromium version.
 */
export function Popover({
  trigger,
  triggerLabel,
  triggerClassName = 'btn ghost sm',
  children,
  label,
  role = 'dialog',
  placement = 'bottom-start',
  className,
  testId,
  triggerTestId,
  onOpenChange
}: {
  /** Content of the trigger button (icon and/or text). */
  trigger: ReactNode
  /** aria-label of the trigger when its content is an icon only. */
  triggerLabel?: string
  /** Class of the trigger button. Defaults to a small ghost button; pass `icon-btn size-md` for an icon trigger. */
  triggerClassName?: string
  children: ReactNode | ((api: { close: () => void }) => ReactNode)
  /** Accessible name of the panel. */
  label: string
  role?: 'dialog' | 'menu' | 'listbox' | 'group'
  placement?: PopoverPlacement
  className?: string
  testId?: string
  triggerTestId?: string
  onOpenChange?: (open: boolean) => void
}): ReactElement {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState(false)

  const place = useCallback(() => {
    const t = triggerRef.current
    const p = panelRef.current
    if (!t || !p) return
    const r = t.getBoundingClientRect()
    const w = p.offsetWidth
    const h = p.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = placement.startsWith('top') ? r.top - h - GAP : r.bottom + GAP
    // Flip when the preferred side overflows and the other one fits better.
    if (top + h > vh - MARGIN && r.top - h - GAP >= MARGIN) top = r.top - h - GAP
    else if (top < MARGIN && r.bottom + GAP + h <= vh - MARGIN) top = r.bottom + GAP
    let left = placement.endsWith('end') ? r.right - w : r.left
    left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN))
    top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN))
    p.style.top = `${Math.round(top)}px`
    p.style.left = `${Math.round(left)}px`
    setPlaced(true)
  }, [placement])

  // Native light dismiss and Esc change the popover state without React; mirror it from the toggle event.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onToggle = (e: Event): void => {
      const next = (e as ToggleEvent).newState === 'open'
      setOpen(next)
      if (!next) {
        setPlaced(false)
        const active = document.activeElement
        if (!active || active === document.body || el.contains(active)) triggerRef.current?.focus()
      }
      onOpenChange?.(next)
    }
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [onOpenChange])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // Focus moves in once the panel is placed (it is visibility:hidden, hence unfocusable, until then).
  useEffect(() => {
    const el = panelRef.current
    if (!open || !placed || !el) return
    const first = el.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ;(first ?? el).focus()
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onResize = (): void => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, place])

  const close = useCallback(() => {
    try {
      panelRef.current?.hidePopover()
    } catch {
      // Already closed.
    }
  }, [])

  return (
    <span className="popover-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        // React 19 maps these to popovertarget / popovertargetaction; the platform toggles the panel and
        // keeps the invoker click from fighting the light dismiss.
        popoverTarget={id}
        popoverTargetAction="toggle"
        aria-expanded={open}
        aria-haspopup={role === 'group' ? undefined : role}
        aria-controls={id}
        aria-label={triggerLabel}
        data-testid={triggerTestId}
      >
        {trigger}
      </button>
      <div
        ref={panelRef}
        id={id}
        popover="auto"
        role={role}
        aria-label={label}
        tabIndex={-1}
        className={className ? `popover-panel ${className}` : 'popover-panel'}
        data-placed={placed}
        data-testid={testId}
      >
        {open && (typeof children === 'function' ? children({ close }) : children)}
      </div>
    </span>
  )
}
