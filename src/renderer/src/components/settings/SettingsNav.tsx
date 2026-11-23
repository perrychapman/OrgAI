import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'

export interface SettingsNavItem {
  /** Pane id (not a DOM id). */
  id: string
  label: string
  /** One line under the pane heading (ui-overhaul boards: the page's subtitle). */
  description?: string
}

/** A menu entry that leaves this page for the other settings page (App settings <-> a project's Settings). */
export interface SettingsNavLink {
  id: string
  label: string
  onOpen: () => void
}

/** The other settings page's group in the shared menu: a heading and its entries (buttons that navigate). */
export interface SettingsNavOtherGroup {
  heading: ReactNode
  links: SettingsNavLink[]
  /** Where the group sits relative to this page's own tabs. */
  position: 'before' | 'after'
  /** Accessible name of the group's list. */
  label: string
}

/** DOM id of a pane's tab button. Stable so the tabpanel can point at it and e2e can find it. */
export const settingsTabId = (idBase: string, pane: string): string => `${idBase}-tab-${pane}`
/** DOM id of the page's tabpanel. */
export const settingsPanelId = (idBase: string): string => `${idBase}-panel`

/**
 * The shared settings menu (ui-overhaul `snav`): one glass panel with an "App" group and a "Project" group. This
 * page's own panes are a native tablist (roving tabindex, arrow keys, Home/End; selection follows focus); the other
 * page's entries are plain buttons that navigate there (they are not tabs because they leave this page). A left rail
 * at wide container widths, a horizontal strip when narrow (CSS decides). The panel the tabs control is rendered by
 * `SettingsPage`.
 */
export function SettingsNav({
  items,
  active,
  onSelect,
  idBase,
  label,
  heading,
  other
}: {
  items: SettingsNavItem[]
  active: string
  onSelect: (id: string) => void
  idBase: string
  label: string
  /** Caption above this page's tabs ("App", "Project: Notes API"). */
  heading?: ReactNode
  other?: SettingsNavOtherGroup
}): ReactElement {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = items.findIndex((it) => it.id === active)
    let next = i
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % items.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else return
    e.preventDefault()
    onSelect(items[next].id)
    document.getElementById(settingsTabId(idBase, items[next].id))?.focus()
  }
  const own = (
    <div className="settings-nav-group">
      {heading && (
        <div className="settings-nav-head" aria-hidden="true">
          {heading}
        </div>
      )}
      <div className="settings-nav-tabs" role="tablist" aria-label={label} aria-orientation="vertical" onKeyDown={onKeyDown}>
        {items.map((it) => {
          const on = active === it.id
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              id={settingsTabId(idBase, it.id)}
              className={`settings-nav-item${on ? ' active' : ''}`}
              aria-selected={on}
              aria-controls={settingsPanelId(idBase)}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(it.id)}
            >
              {it.label}
            </button>
          )
        })}
      </div>
    </div>
  )
  const otherGroup = other && other.links.length > 0 && (
    <div className="settings-nav-group is-other" role="group" aria-label={other.label}>
      <div className="settings-nav-head" aria-hidden="true">
        {other.heading}
      </div>
      <ul className="settings-nav-links">
        {other.links.map((l) => (
          <li key={l.id}>
            <button type="button" className="settings-nav-item is-link" data-testid={`settings-nav-link-${l.id}`} onClick={l.onOpen}>
              <span>{l.label}</span>
              <ArrowUpRight className="settings-nav-link-icon" size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <nav className="settings-nav glass" aria-label="Settings menu">
      {other?.position === 'before' && otherGroup}
      {own}
      {other?.position === 'after' && otherGroup}
    </nav>
  )
}
