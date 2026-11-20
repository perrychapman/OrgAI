import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleCheck, LayoutGrid, Check } from 'lucide-react'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import StartFromMenu, { type StartFromMenuProps } from './StartFromMenu'
import TeamFilesChip, { type TeamFilesChipProps } from './TeamFilesChip'
import type { TeamLayoutDirection } from '../../lib/teamPrefs'

/** Under this header width the Team files chip, Layout and Start from keep their icon only (label in title and aria-label). */
export const HEADER_COMPACT_BELOW = 800

const LAYOUT_CHOICES: { id: TeamLayoutDirection; label: string; testId: string }[] = [
  { id: 'top-down', label: 'Top to bottom', testId: 'team-layout-top-down' },
  { id: 'left-right', label: 'Left to right', testId: 'team-layout-left-right' }
]

/** Arrow keys, Home and End move between a menu's items; a disabled item stays reachable to read its reason. */
function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem], [role=menuitemradio]'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

/** The Layout menu: the Team chart's own direction (radio items), then "Arrange automatically". */
function LayoutMenu({ layout, compact, onLayoutChange, onArrange }: { layout: TeamLayoutDirection; compact: boolean; onLayoutChange: (value: TeamLayoutDirection) => void; onArrange: () => void }): ReactElement {
  return (
    <Popover
      label="Layout"
      role="menu"
      placement="bottom-end"
      triggerClassName="btn sm team-header-btn"
      triggerTestId="team-layout"
      testId="team-layout-menu"
      triggerLabel={compact ? 'Layout' : undefined}
      triggerTitle={compact ? 'Layout' : undefined}
      trigger={
        <>
          <Icon icon={LayoutGrid} size="sm" />
          {!compact && (
            <>
              <span>Layout</span>
              <Icon icon={ChevronDown} size="sm" />
            </>
          )}
        </>
      }
    >
      {({ close }) => <LayoutMenuBody layout={layout} onLayoutChange={onLayoutChange} onArrange={onArrange} close={close} />}
    </Popover>
  )
}

function LayoutMenuBody({ layout, onLayoutChange, onArrange, close }: { layout: TeamLayoutDirection; onLayoutChange: (value: TeamLayoutDirection) => void; onArrange: () => void; close: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // The checked direction takes focus, as a native radio group does (the popover would otherwise land on the first item).
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked=true]')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="team-header-menu" role="presentation" ref={ref} onKeyDown={onMenuKey}>
      {LAYOUT_CHOICES.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitemradio"
          aria-checked={layout === c.id}
          className="team-header-menu-item"
          data-testid={c.testId}
          onClick={() => {
            close()
            if (c.id !== layout) onLayoutChange(c.id)
          }}
        >
          <span className="team-header-menu-check" aria-hidden="true">
            {layout === c.id && <Icon icon={Check} size="sm" />}
          </span>
          {c.label}
        </button>
      ))}
      <div className="team-header-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="team-header-menu-item"
        data-testid="team-layout-arrange"
        onClick={() => {
          close()
          onArrange()
        }}
      >
        <span className="team-header-menu-check" aria-hidden="true" />
        Arrange automatically
      </button>
    </div>
  )
}

export interface TeamHeaderProps {
  roleCount: number
  layout: TeamLayoutDirection
  onLayoutChange: (value: TeamLayoutDirection) => void
  /** "Arrange automatically": lay every role out again, then fit. */
  onArrange: () => void
  startFrom: Omit<StartFromMenuProps, 'compact'>
  files: Omit<TeamFilesChipProps, 'compact'>
  /** The Add role control (AddRolePopover): the one primary button of the tab. */
  addRole: ReactNode
}

/**
 * The Team tab's one-row header (docs/design/team-tab-overhaul.md 1.1). It sits inside the shared FrameToolbar slot, so
 * the frame keeps its toolbar. Never wraps: under HEADER_COMPACT_BELOW the Team files chip, Layout and Start from keep
 * only their icon. The problems chip and the view switch are placeholders for phases 4 and 5.
 */
export default function TeamHeader({ roleCount, layout, onLayoutChange, onArrange, startFrom, files, addRole }: TeamHeaderProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  // The header's own width (it follows the frame, not the window): measured, not guessed from a media query.
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)))
    ro.observe(el)
    setWidth(Math.round(el.clientWidth))
    return () => ro.disconnect()
  }, [])
  const compact = width !== null && width < HEADER_COMPACT_BELOW
  const countText = `${roleCount} ${roleCount === 1 ? 'role' : 'roles'}`
  return (
    <div className="team-header" ref={rootRef} data-compact={compact ? 'true' : undefined} data-testid="team-header">
      <div className="team-header-left">
        <h1 className="team-header-title" data-testid="team-title" title={`Team, ${countText}`}>
          Team
        </h1>
        <span className="team-header-count" data-testid="team-role-count">
          {countText}
        </span>
        {/* Static in phase 2 (phase 4 makes it live): neutral, never "0 problems". */}
        <span className="team-problems-chip" data-state="none" data-testid="team-problems-chip" title="No problems">
          <Icon icon={CircleCheck} size="sm" />
          <span className="team-problems-text">No problems</span>
        </span>
        {/* Empty until the Chart | List | Capabilities switch lands (phases 4 and 5). */}
        <div className="team-view-switch" data-testid="team-view-switch" />
      </div>
      <div className="team-header-right">
        <LayoutMenu layout={layout} compact={compact} onLayoutChange={onLayoutChange} onArrange={onArrange} />
        <StartFromMenu {...startFrom} compact={compact} />
        <TeamFilesChip {...files} compact={compact} />
        {addRole}
      </div>
    </div>
  )
}
