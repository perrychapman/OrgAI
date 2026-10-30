import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { IconButton } from '../ui/IconButton'

/**
 * Right-hand panel of the editor and live grids (`.editor`, `.live`). It collapses to a 40px rail; the parent grid
 * narrows its column through `:has(> .side-panel[data-collapsed='true'])`, so the canvas takes the space.
 * It is a container (name "side"), so its content can use @container side queries.
 * `label` names the landmark and the toggle ("Hide <label>" / "Show <label>").
 */
export function SidePanel({
  label,
  children,
  defaultCollapsed = false,
  collapsible = true,
  testId
}: {
  label: string
  children: ReactNode
  defaultCollapsed?: boolean
  collapsible?: boolean
  testId?: string
}): ReactElement {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const isCollapsed = collapsible && collapsed
  return (
    <aside className="side side-panel" aria-label={label} data-collapsed={isCollapsed ? 'true' : 'false'} data-testid={testId}>
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
