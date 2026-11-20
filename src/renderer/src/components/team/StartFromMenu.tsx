import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ChevronDown, LayoutTemplate } from 'lucide-react'
import type { Project } from '@shared/types'
import { Popover } from '../ui/Popover'
import { Icon } from '../ui/Icon'
import { useOrgChange } from './useOrgChange'
import { startFromItems, startFromLabel, type StartFromItemId } from '../../lib/startFrom'

/**
 * The header's "Start from" menu (spec docs/design/team-tab-overhaul.md 1.3): one place for the ways to (re)start a
 * team: a saved template, agent files found in the folder, the Architect, and saving this team as a template.
 */
export interface StartFromMenuProps {
  project: Project
  /** Agent files found and not imported (sum of agentCount over importSourcesFor): null while the scan runs, 'error' when it failed. */
  found: number | null | 'error'
  /** The accent dot on the button (found > 0 and the banner memory is not 'dismissed'). */
  dot: boolean
  /** An import was done for this project this session: the row says "Imported" instead of a count. */
  imported?: boolean
  /** Opening the menu while found > 0 counts as seeing it: TeamView writes the banner memory 'dismissed'. */
  onOpened: () => void
  /** Saved templates (store `templates`); undefined while loading. */
  templateCount: number | undefined
  roleCount: number
  /** Header width below 880 px: icon only, label in `title` and `aria-label`. */
  compact?: boolean
  onTemplate: () => void
  onImport: () => void
  onArchitect: () => void
  onSave: () => void
}

/** Arrow keys, Home and End move between the menu's items (a disabled item stays reachable to read its reason). */
function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

export default function StartFromMenu(props: StartFromMenuProps): ReactElement {
  const { project, found, dot, imported, onOpened, templateCount, roleCount, compact, onTemplate, onImport, onArchitect, onSave } = props
  const { liveRunId } = useOrgChange(project)
  const items = startFromItems({ found, templateCount, roleCount, sessionOpen: liveRunId !== null, imported })
  const label = startFromLabel(found, dot)
  const act: Record<StartFromItemId, () => void> = {
    template: onTemplate,
    import: onImport,
    architect: onArchitect,
    save: onSave
  }
  const side = (text: string | undefined, tone: 'accent' | 'muted' | undefined): ReactNode =>
    text ? <span className={`start-from-side${tone ? ` is-${tone}` : ''}`}>{text}</span> : null

  return (
    <Popover
      label="Start from"
      role="menu"
      placement="bottom-start"
      className="start-from-popover"
      triggerClassName={compact ? 'btn sm start-from-trigger is-compact' : 'btn sm start-from-trigger'}
      triggerTestId="team-start-from"
      testId="team-start-from-menu"
      triggerLabel={label}
      triggerTitle={compact ? 'Start from' : undefined}
      onOpenChange={(open) => {
        if (open) onOpened()
      }}
      trigger={
        <>
          <Icon icon={LayoutTemplate} size="sm" />
          {!compact && <span>Start from</span>}
          {!compact && <Icon icon={ChevronDown} size="sm" />}
          {dot && <span className="start-from-dot" aria-hidden="true" data-testid="team-start-from-dot" />}
        </>
      }
    >
      {({ close }) => (
        <div className="start-from-menu" role="presentation" onKeyDown={onMenuKey}>
          {items.map((it) => (
            <div key={it.id} className="start-from-group" role="presentation">
              {it.separatorBefore && <div className="start-from-sep" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className="start-from-item"
                data-testid={`start-from-${it.id}`}
                aria-disabled={it.disabled ? 'true' : undefined}
                onClick={() => {
                  if (it.disabled) return
                  close()
                  act[it.id]()
                }}
              >
                <span className="start-from-line">
                  <span className="start-from-title">{it.title}</span>
                  {side(it.side, it.sideTone)}
                </span>
                <span className="start-from-desc">{it.description}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </Popover>
  )
}
