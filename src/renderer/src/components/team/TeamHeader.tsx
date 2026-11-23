import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, FolderPlus, LayoutGrid, Check } from 'lucide-react'
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

/**
 * The chart's theme (owner decision 4: themes are a dropdown because more are coming). The Team editor draws the org
 * chart only (Pocket Office and the Factory floor are Live presentations), so it lists one checked choice and says where
 * the others are.
 */
function ThemeMenu({ compact }: { compact: boolean }): ReactElement {
  return (
    <Popover
      label="Chart theme"
      role="menu"
      placement="bottom-end"
      triggerClassName="btn sm team-header-btn team-theme-btn"
      triggerTestId="team-theme"
      testId="team-theme-menu"
      triggerLabel={compact ? 'Theme: Org chart' : undefined}
      triggerTitle={compact ? 'Theme: Org chart' : undefined}
      trigger={
        <>
          <span className="team-theme-swatch" aria-hidden="true" />
          {!compact && (
            <>
              <span className="team-theme-word">Theme</span>
              <span className="team-theme-name">Org chart</span>
              <Icon icon={ChevronDown} size="sm" />
            </>
          )}
        </>
      }
    >
      {({ close }) => (
        <div className="team-header-menu" role="presentation" onKeyDown={onMenuKey}>
          <button type="button" role="menuitemradio" aria-checked="true" className="team-header-menu-item" data-testid="team-theme-org-chart" onClick={close}>
            <span className="team-header-menu-check" aria-hidden="true">
              <Icon icon={Check} size="sm" />
            </span>
            Org chart
          </button>
          <p className="team-header-menu-note">Pocket Office and Factory floor show a running team on Work.</p>
        </div>
      )}
    </Popover>
  )
}

export interface TeamHeaderProps {
  roleCount: number
  /** Root reports that lead at least one role ("in N groups"); 0 hides the phrase. */
  groupCount?: number
  /** Add group: the Add role popover with the root as the manager. */
  onAddGroup?: () => void
  /** Import agent files (the same dialog as Start from > Import). */
  onImport?: () => void
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
export default function TeamHeader({ roleCount, groupCount = 0, onAddGroup, onImport, layout, onLayoutChange, onArrange, startFrom, files, addRole }: TeamHeaderProps): ReactElement {
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
        <span className="team-header-count">
          <span data-testid="team-role-count">{countText}</span>
          {groupCount > 0 && <span className="team-header-groups" data-testid="team-group-count">{` in ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}`}</span>}
        </span>
        {/* The problems chip (`team-problems-chip`) stays out of the DOM until the check is live (phase 4). */}
        {/* Empty until the Chart | List | Capabilities switch lands (phases 4 and 5). */}
        <div className="team-view-switch" data-testid="team-view-switch" />
      </div>
      <div className="team-header-right">
        {onAddGroup && (
          <button
            type="button"
            className="btn sm team-header-btn"
            data-testid="team-add-group"
            aria-label={compact ? 'Add group' : undefined}
            title={compact ? 'Add group: a lead who reports to the top of the team' : 'A lead who reports to the top of the team'}
            onClick={onAddGroup}
          >
            <Icon icon={FolderPlus} size="sm" />
            {!compact && <span>Add group</span>}
          </button>
        )}
        {onImport && (
          <button
            type="button"
            className="btn sm team-header-btn"
            data-testid="team-import"
            aria-label={compact ? 'Import agents' : undefined}
            title={compact ? 'Import agents' : 'Import agent files into this team'}
            onClick={onImport}
          >
            <Icon icon={Download} size="sm" />
            {!compact && <span>Import</span>}
          </button>
        )}
        <ThemeMenu compact={compact} />
        <LayoutMenu layout={layout} compact={compact} onLayoutChange={onLayoutChange} onArrange={onArrange} />
        <StartFromMenu {...startFrom} compact={compact} />
        <TeamFilesChip {...files} compact={compact} />
        {addRole}
      </div>
    </div>
  )
}
