import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { exitProps, useExitPresence } from '../../lib/useExitPresence'

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
  triggerTitle,
  triggerClassName = 'btn ghost sm',
  children,
  label,
  role = 'dialog',
  placement = 'bottom-start',
  className,
  testId,
  triggerTestId,
  triggerDescribedBy,
  onOpenChange
}: {
  /** id of an element that describes the trigger (aria-describedby). */
  triggerDescribedBy?: string
  /** Content of the trigger button (icon and/or text). */
  trigger: ReactNode
  /** aria-label of the trigger when its content is an icon only. */
  triggerLabel?: string
  /** Tooltip of the trigger (e.g. the full name of a rail icon). */
  triggerTitle?: string
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
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState(false)
  const [opening, setOpening] = useState(0)

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
    // The enter scales from the trigger's side (motion.md 3.2): the panel's own side after the flip and clamp.
    const above = top < r.top
    p.dataset.side = above ? 'top' : 'bottom'
    p.style.transformOrigin = `${above ? 'bottom' : 'top'} ${placement.endsWith('end') ? 'right' : 'left'}`
    setPlaced(true)
  }, [placement])

  // Close synchronously: a close and reopen in one task can coalesce into one open toggle.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const onBeforeToggle = (e: Event): void => {
      if ((e as ToggleEvent).newState !== 'closed') return
      setOpen(false)
      onOpenChangeRef.current?.(false)
    }
    const onToggle = (e: Event): void => {
      const next = (e as ToggleEvent).newState === 'open'
      if (next) {
        setOpen(true)
        setOpening((revision) => revision + 1)
        onOpenChangeRef.current?.(true)
      } else {
        // `placed` stays true: hiding the panel here would cut the CSS exit short. It is positioned again on the next open.
        const active = document.activeElement
        if (!active || active === document.body || el.contains(active)) triggerRef.current?.focus()
      }
    }
    el.addEventListener('beforetoggle', onBeforeToggle)
    el.addEventListener('toggle', onToggle)
    return () => {
      el.removeEventListener('beforetoggle', onBeforeToggle)
      el.removeEventListener('toggle', onToggle)
    }
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, opening, place])

  // Content that grows after the first placement (a list that finishes loading) is placed again, so the panel never
  // runs past the window edge.
  useEffect(() => {
    const p = panelRef.current
    if (!open || !p || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => place())
    ro.observe(p)
    return () => ro.disconnect()
  }, [open, place])

  // Focus moves in once the panel is placed (it is visibility:hidden, hence unfocusable, until then).
  useEffect(() => {
    const el = panelRef.current
    if (!open || !placed || !el) return
    const first = el.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ;(first ?? el).focus()
  }, [open, placed, opening])

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

  // Children mount while open plus one exit duration; the last render stays up (inert) so the exit fades real content.
  const exit = useExitPresence(open)
  const lastContent = useRef<ReactNode>(null)
  const content = typeof children === 'function' ? children({ close }) : children
  if (open) lastContent.current = content
  // Cleared in an effect, not in render: the hook's first pass after a close still reports unmounted before it lingers.
  const exitMounted = exit.mounted
  useEffect(() => {
    if (!exitMounted) lastContent.current = null
  }, [exitMounted])

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
        aria-describedby={triggerDescribedBy}
        title={triggerTitle}
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
        {...(exit.mounted ? exitProps(exit.state) : {})}
      >
        {exit.mounted && (open ? content : lastContent.current)}
      </div>
    </span>
  )
}
