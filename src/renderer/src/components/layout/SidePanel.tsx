import type { ReactElement, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { IconButton } from '../ui/IconButton'

const PREF_PREFIX = 'orgai.sidePanel.'

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
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(apply)
    ro.observe(parent)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCollapseBelow, persistKey])
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
  const isCollapsed = collapsible && collapsed
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
      {/* Stays mounted while collapsed so form state inside it survives. */}
      <div className="side-panel-body" hidden={isCollapsed}>
        {children}
      </div>
    </aside>
  )
}
