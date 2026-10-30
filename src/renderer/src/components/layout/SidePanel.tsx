import type { ReactElement, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { PANEL_W, nextWide, panelBudget, usePersistedWidth } from '../../lib/panelWidth'
import { ResizeHandle } from './ResizeHandle'

const PREF_PREFIX = 'orgai.sidePanel.'
const WIDTH_PREFIX = 'orgai.sidePanelW.'

function readPref(key: string | undefined): 'open' | 'closed' | null {
  if (!key) return null
  try {
    const v = localStorage.getItem(PREF_PREFIX + key)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}

/**
 * Right-hand panel of the editor and live grids (`.editor`, `.live`). It collapses to a 40px rail; the parent grid
 * narrows its column through `:has(> .side-panel[data-collapsed='true'])`, so the canvas takes the space.
 * It is a container (name "side"), so its content can use @container side queries.
 * `label` names the landmark and the toggle ("Hide <label>" / "Show <label>").
 *
 * `autoCollapseBelow` (px): when the panel's grid is narrower than this on first layout, it starts collapsed. The
 * user's own toggle is saved under `persistKey` (localStorage) and wins over that default from then on.
 * The panel is drag-resizable (a `ResizeHandle` on its left edge): the width is saved per `persistKey` (shared key
 * `default` without one) as `orgai.sidePanelW.<key>`, clamped to 280 px up to whatever leaves the canvas 280 px (no fixed max); when 280 px does not fit it shows as its rail. It drives
 * `--side-panel-w` on the parent grid; with no saved width the grid's own CSS default applies.
 * `revealOn`: when this value changes to a non-null value (a selected node), the panel opens without saving.
 */
export function SidePanel({
  label,
  children,
  defaultCollapsed = false,
  collapsible = true,
  testId,
  open,
  onOpenChange,
  autoCollapseBelow,
  persistKey,
  revealOn
}: {
  label: string
  children: ReactNode
  defaultCollapsed?: boolean
  collapsible?: boolean
  testId?: string
  /** Controlled expansion: lets the parent open the panel before moving focus into it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  autoCollapseBelow?: number
  persistKey?: string
  revealOn?: string | null
}): ReactElement {
  const ref = useRef<HTMLElement>(null)
  const [inner, setInner] = useState(() => {
    const saved = readPref(persistKey)
    return saved ? saved === 'closed' : defaultCollapsed
  })
  const collapsed = open === undefined ? inner : !open
  const [saved, setSaved] = usePersistedWidth(WIDTH_PREFIX + (persistKey ?? 'default'))
  const [sizes, setSizes] = useState({ panel: 0, parent: 0 })
  const budget = panelBudget(sizes.parent, saved)
  const max = budget.max
  // The grid column follows the saved width, re-clamped when the container shrinks (the saved value is kept).
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return undefined
    const measure = (): void => setSizes({ panel: el.offsetWidth, parent: parent.clientWidth })
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])
  const applied = budget.fits ? budget.width : null
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    if (applied === null) parent.style.removeProperty('--side-panel-w')
    else parent.style.setProperty('--side-panel-w', `${applied}px`)
    return () => {
      parent.style.removeProperty('--side-panel-w')
    }
  }, [applied])
  // With no saved choice the panel follows the width of its grid: collapsed below the threshold, open above it.
  // Measured before paint on mount, then on resize. A toggle by the user saves a choice and ends the following.
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (autoCollapseBelow === undefined || !parent) return undefined
    const apply = (): void => {
      if (readPref(persistKey)) return
      const narrow = parent.clientWidth < autoCollapseBelow
      setInner((was) => {
        if (was !== narrow) onOpenChange?.(!narrow)
        return narrow
      })
    }
    apply()
    // Window resizes only: dragging a resize handle (sidebar or panel) must not fold the panel.
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCollapseBelow, persistKey])
  // Parent grids can restyle for a wide panel (the Live view moves the composer into the panel column).
  // Hysteresis (wide at 480+, narrow again below 448) so a drag across the threshold does not flicker the layout.
  const [wasWide, setWasWide] = useState(false)
  const railed = collapsible && (collapsed || !budget.fits)
  const wide = !railed && nextWide(wasWide, sizes.panel)
  useEffect(() => {
    setWasWide(wide)
  }, [wide])
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent) return undefined
    if (wide) parent.setAttribute('data-side-wide', 'true')
    else parent.removeAttribute('data-side-wide')
    return () => parent.removeAttribute('data-side-wide')
  }, [wide])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (revealOn) {
      setInner(false)
      onOpenChange?.(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealOn])
  const setCollapsed = (c: boolean): void => {
    setInner(c)
    onOpenChange?.(!c)
    if (persistKey) {
      try {
        localStorage.setItem(PREF_PREFIX + persistKey, c ? 'closed' : 'open')
      } catch {
        /* storage unavailable */
      }
    }
  }
  // No room for the panel's minimum next to a 360 px canvas: show the rail (the saved width and choice are kept).
  const isCollapsed = collapsible && (collapsed || !budget.fits)
  return (
    <aside ref={ref} className="side side-panel" aria-label={label} data-collapsed={isCollapsed ? 'true' : 'false'} data-testid={testId}>
      {isCollapsed && (
        <div className="side-rail">
          <IconButton icon={PanelRightOpen} label={`Show ${label}`} size="sm" expanded={false} onClick={() => setCollapsed(false)} />
        </div>
      )}
      {!isCollapsed && collapsible && (
        <div className="side-panel-bar">
          <IconButton icon={PanelRightClose} label={`Hide ${label}`} size="sm" expanded onClick={() => setCollapsed(true)} />
        </div>
      )}
      {!isCollapsed && collapsible && sizes.panel > 0 && (
        <ResizeHandle
          label={`Resize ${label}`}
          edge="start"
          value={sizes.panel}
          min={PANEL_W.min}
          max={max}
          onChange={setSaved}
          onReset={() => setSaved(null)}
          testId="side-panel-resize"
        />
      )}
      {/* Stays mounted while collapsed so form state inside it survives. */}
      <div className="side-panel-body" hidden={isCollapsed}>
        {children}
      </div>
    </aside>
  )
}
