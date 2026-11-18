import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { MoreHorizontal } from 'lucide-react'
import { Icon } from './Icon'
import { isMenuKey, nativeMenuWins, nextMenuIndex, placeAtAnchor, placeAtPoint, typeAheadIndex, type MenuNavKey } from '../../lib/contextMenu'

/**
 * The shared context menu (docs/design/context-menus.md). One implementation of placement, dismissal, roving focus and
 * focus return for every right-click / Menu key / Shift+F10 / "More actions" menu in the renderer.
 *
 *   const menu = useContextMenu<string>()
 *   <li onContextMenu={(e) => menu.onContextMenu(e, id)} onKeyDown={(e) => menu.onKeyDown(e, id)}>...</li>
 *   <MenuButton control={menu} target={id} label="More actions for X" />
 *   <ContextMenu control={menu} label={(id) => `Actions for ${id}`} items={(id) => [...]} />
 *
 * Right click is never the only path: a surface wires `onKeyDown` (Menu key, Shift+F10) on its focusable element, and
 * a surface that collapsed visible buttons into the menu shows a `MenuButton`.
 */

export interface MenuItem {
  id: string
  label: string
  icon?: LucideIcon
  onSelect: () => void
  /** Shown and focusable but not activatable (WAI-ARIA); `disabledReason` becomes its description. */
  disabled?: boolean
  disabledReason?: string
  /** Danger styling; the item keeps its own confirmation flow and sits last after a separator. */
  destructive?: boolean
  /** Tooltip (for example the keyboard shortcut). */
  title?: string
  testId?: string
}
export type MenuEntry = MenuItem | 'separator'

type Placement = { kind: 'point'; x: number; y: number } | { kind: 'anchor'; el: HTMLElement; align: 'start' | 'end' }

export interface ContextMenuState<T> {
  target: T
  /** Focus goes back here when the menu closes (if it is still in the document). */
  invoker: HTMLElement | null
  placement: Placement
  /** Bumped on every open, so reopening remounts the panel. */
  seq: number
}

export interface OpenOptions {
  /** Where focus goes when the invoker left the document (the action removed its row). */
  fallbackFocus?: () => HTMLElement | null
  /** For a keyboard open: the element to anchor to (default the event's currentTarget). */
  anchor?: HTMLElement
  /** For a keyboard open: the element focus returns to (default the anchor). */
  invoker?: HTMLElement
}

export interface ContextMenuControl<T> {
  state: ContextMenuState<T> | null
  /** `onContextMenu` for a surface. Does nothing (the platform text menu wins) in fields, on links and over a selection. */
  onContextMenu: (e: ReactMouseEvent<HTMLElement>, target: T, opts?: OpenOptions) => void
  /** `onKeyDown` for a surface: the Menu key or Shift+F10 open the menu anchored to the element. True when handled. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>, target: T, opts?: OpenOptions) => boolean
  /** Open anchored to an element (a More button, or a keyboard handler of the caller's own). */
  openFrom: (el: HTMLElement, target: T, align?: 'start' | 'end', opts?: OpenOptions) => void
  close: () => void
  /** @internal used by the panel. */
  fallback: () => HTMLElement | null
  /** @internal the panel reports the element and time of a dismissal, so a More button's own click does not reopen it. */
  dismissed: { el: HTMLElement | null; at: number }
}

const TEXT_INPUT_SKIP = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** The DOM facts for `nativeMenuWins`: an editable target, a link, or selected text touching the surface. */
function nativeWins(e: ReactMouseEvent<HTMLElement>): boolean {
  const t = e.target instanceof Element ? e.target : null
  const field = t?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  const editable = !!field && !(field instanceof HTMLInputElement && TEXT_INPUT_SKIP.has(field.type))
  const link = !!t?.closest('a[href]')
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
  const touches = !!sel && !sel.isCollapsed && sel.rangeCount > 0 && ((sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) || (sel.focusNode && e.currentTarget.contains(sel.focusNode)))
  return nativeMenuWins({ editable, link, selectedText: touches && sel ? sel.toString() : '' })
}

/** Menu-key events from inside a text field belong to the field. */
function inField(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  const f = el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  return !!f && !(f instanceof HTMLInputElement && TEXT_INPUT_SKIP.has(f.type))
}

export function useContextMenu<T>(): ContextMenuControl<T> {
  const [state, setState] = useState<ContextMenuState<T> | null>(null)
  const seq = useRef(0)
  const fallbackRef = useRef<(() => HTMLElement | null) | undefined>(undefined)
  // A keyboard open is followed by the platform's own contextmenu event on some systems: ignore that echo.
  const keyOpenAt = useRef(0)
  const dismissed = useRef<{ el: HTMLElement | null; at: number }>({ el: null, at: 0 })

  const open = useCallback((target: T, invoker: HTMLElement | null, placement: Placement, opts?: OpenOptions): void => {
    fallbackRef.current = opts?.fallbackFocus
    seq.current += 1
    setState({ target, invoker, placement, seq: seq.current })
  }, [])

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>, target: T, opts?: OpenOptions): void => {
      if (nativeWins(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (performance.now() - keyOpenAt.current < 600) return
      const el = e.currentTarget
      const fromPointer = e.button === 2 && (e.clientX !== 0 || e.clientY !== 0)
      if (fromPointer) open(target, opts?.invoker ?? el, { kind: 'point', x: e.clientX, y: e.clientY }, opts)
      else open(target, opts?.invoker ?? opts?.anchor ?? el, { kind: 'anchor', el: opts?.anchor ?? el, align: 'start' }, opts)
    },
    [open]
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, target: T, opts?: OpenOptions): boolean => {
      if (!isMenuKey(e) || inField(e.target)) return false
      e.preventDefault()
      e.stopPropagation()
      keyOpenAt.current = performance.now()
      const anchor = opts?.anchor ?? e.currentTarget
      open(target, opts?.invoker ?? anchor, { kind: 'anchor', el: anchor, align: 'start' }, opts)
      return true
    },
    [open]
  )

  const openFrom = useCallback(
    (el: HTMLElement, target: T, align: 'start' | 'end' = 'end', opts?: OpenOptions): void => {
      // The pointerdown on this same button just dismissed the menu: the click is the toggle closing it, not a reopen.
      const d = dismissed.current
      if (d.el === el && performance.now() - d.at < 400) {
        d.el = null
        return
      }
      open(target, opts?.invoker ?? el, { kind: 'anchor', el, align }, opts)
    },
    [open]
  )

  const close = useCallback(() => setState(null), [])
  const fallback = useCallback(() => fallbackRef.current?.() ?? null, [])

  return useMemo(() => ({ state, onContextMenu, onKeyDown, openFrom, close, fallback, dismissed: dismissed.current }), [state, onContextMenu, onKeyDown, openFrom, close, fallback])
}

/** The visible "More actions" button of a row or card: opens the same menu, anchored under it (end aligned). */
export function MenuButton<T>({
  control,
  target,
  label,
  testId,
  size = 'sm',
  fallbackFocus
}: {
  control: ContextMenuControl<T>
  target: T
  /** "More actions for <name>": the accessible name and the tooltip. */
  label: string
  testId?: string
  size?: 'sm' | 'md'
  fallbackFocus?: () => HTMLElement | null
}): ReactElement {
  const open = control.state !== null && control.state.target === target && control.state.placement.kind === 'anchor'
  return (
    <button
      type="button"
      className={`icon-btn size-${size}`}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid={testId}
      onClick={(e) => control.openFrom(e.currentTarget, target, 'end', { fallbackFocus })}
      onKeyDown={(e) => {
        // The Menu key on the More button opens the same menu.
        if (isMenuKey(e)) {
          e.preventDefault()
          control.openFrom(e.currentTarget, target, 'end', { fallbackFocus })
        }
      }}
    >
      <Icon icon={MoreHorizontal} size="sm" />
    </button>
  )
}

/** Renders the open menu of `control`, or nothing. `items` and `label` are computed from the menu's target. */
export function ContextMenu<T>({
  control,
  label,
  items,
  testId,
  className
}: {
  control: ContextMenuControl<T>
  label: string | ((target: T) => string)
  items: (target: T) => MenuEntry[]
  testId?: string
  className?: string
}): ReactElement | null {
  const st = control.state
  if (!st) return null
  const entries = items(st.target)
  if (!entries.some((e) => e !== 'separator')) return null
  return <MenuPanel key={st.seq} state={st} control={control} label={typeof label === 'function' ? label(st.target) : label} entries={entries} testId={testId} className={className} />
}

type CloseReason = 'escape' | 'tab' | 'select' | 'outside' | 'dismiss' | 'focusout'

function MenuPanel<T>({
  state,
  control,
  label,
  entries,
  testId,
  className
}: {
  state: ContextMenuState<T>
  control: ContextMenuControl<T>
  label: string
  entries: MenuEntry[]
  testId?: string
  className?: string
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const [placed, setPlaced] = useState(false)
  const controlRef = useRef(control)
  controlRef.current = control
  const items = entries.filter((e): e is MenuItem => e !== 'separator')

  const finish = useCallback(
    (reason: CloseReason): void => {
      if (closing.current) return
      closing.current = true
      const el = ref.current
      const active = document.activeElement
      const focusInside = !active || active === document.body || (!!el && el.contains(active))
      const c = controlRef.current
      if (reason === 'escape' || reason === 'tab' || reason === 'select' || ((reason === 'dismiss' || reason === 'outside') && focusInside)) {
        const inv = state.invoker
        const target = inv && inv.isConnected ? inv : c.fallback()
        target?.focus({ preventScroll: true })
      }
      try {
        el?.hidePopover()
      } catch {
        // Not open (no popover support): unmounting hides it.
      }
      c.close()
    },
    [state.invoker]
  )

  // Show in the top layer, place, then focus the first enabled item.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      el.showPopover()
    } catch {
      // Already open, or popover unsupported (the panel is position: fixed either way).
    }
    const size = { w: el.offsetWidth, h: el.offsetHeight }
    const vp = { w: window.innerWidth, h: window.innerHeight }
    const p = state.placement
    const at = p.kind === 'point' ? placeAtPoint({ x: p.x, y: p.y }, size, vp) : placeAtAnchor(p.el.getBoundingClientRect(), size, vp, p.align)
    el.style.left = `${at.x}px`
    el.style.top = `${at.y}px`
    // Unhide now, not on the next render: focus() on an element still under visibility: hidden does nothing.
    el.dataset.placed = 'true'
    setPlaced(true)
    const buttons = Array.from(el.querySelectorAll<HTMLElement>('[role=menuitem]'))
    ;(buttons.find((b) => b.getAttribute('aria-disabled') !== 'true') ?? buttons[0] ?? el).focus({ preventScroll: true })
  }, [state.placement])

  // Dismissal: a pointerdown outside, resize, a wheel scroll outside the menu, window blur, focus moving elsewhere.
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onDown = (e: PointerEvent): void => {
      if (el.contains(e.target as Node)) return
      // Remember a press on the invoker (a More button) so its click does not reopen the menu.
      const inv = state.invoker
      const onInvoker = !!inv && inv.contains(e.target as Node)
      finish('outside')
      const d = controlRef.current.dismissed
      d.el = onInvoker ? inv : null
      d.at = performance.now()
    }
    // The user scrolling (the wheel or a touchpad outside the menu) closes it. Programmatic scrolls do not: focusing the
    // invoker scrolls its tablist or list into view right as the menu opens, and a streaming transcript scrolls itself.
    // Keyboard scrolling cannot happen (the menu keeps every key) and a scrollbar drag starts with a pointerdown outside.
    const onWheel = (e: Event): void => {
      if (e.target instanceof Node && el.contains(e.target)) return
      finish('dismiss')
    }
    const onResize = (): void => finish('dismiss')
    const onBlur = (): void => finish('dismiss')
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget
      if (next instanceof Node && !el.contains(next)) finish('focusout')
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [finish, state.invoker])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // The menu may sit inside a list or tablist with its own keys (Enter, arrows, type-ahead): keep every key here.
    e.stopPropagation()
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      buttons[nextMenuIndex(at, e.key as MenuNavKey, buttons.length)]?.focus()
      return
    }
    if (e.key === 'Escape') {
      // preventDefault also keeps the Escape from closing a dialog under the menu.
      e.preventDefault()
      e.stopPropagation()
      finish('escape')
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      finish('tab')
      return
    }
    if (isMenuKey(e)) {
      e.preventDefault()
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const i = typeAheadIndex(
        at,
        e.key,
        items.map((it) => it.label)
      )
      if (i >= 0) {
        e.preventDefault()
        buttons[i]?.focus()
      }
    }
  }

  let n = 0
  return (
    <div
      ref={ref}
      popover="manual"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className={className ? `ctx-menu ${className}` : 'ctx-menu'}
      data-placed={placed ? 'true' : 'false'}
      data-testid={testId}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {entries.map((entry, i) => {
        if (entry === 'separator') return <div key={`sep-${i}`} role="separator" className="ctx-menu-sep" />
        const item = entry
        const idx = n++
        const reasonId = item.disabled && item.disabledReason ? `${testId ?? 'ctx'}-${state.seq}-${idx}-why` : undefined
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`ctx-menu-item${item.destructive ? ' danger' : ''}`}
            aria-disabled={item.disabled ? 'true' : undefined}
            aria-describedby={reasonId}
            title={item.disabled && item.disabledReason ? item.disabledReason : item.title}
            data-testid={item.testId}
            onClick={() => {
              if (item.disabled) return
              finish('select')
              item.onSelect()
              // The action may have removed the invoker (its row): fall back so focus never drops to the body.
              requestAnimationFrame(() => {
                const a = document.activeElement
                if (!a || a === document.body) controlRef.current.fallback()?.focus({ preventScroll: true })
              })
            }}
          >
            {item.icon ? <Icon icon={item.icon} size="sm" /> : <span className="ctx-menu-noicon" aria-hidden="true" />}
            <span className="ctx-menu-label">{item.label}</span>
            {reasonId && (
              <span id={reasonId} className="sr-only">
                {item.disabledReason}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
