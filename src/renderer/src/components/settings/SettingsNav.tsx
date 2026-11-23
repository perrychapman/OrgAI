import type { KeyboardEvent, ReactElement, ReactNode } from 'react'

export interface SettingsNavItem {
  /** Pane id (not a DOM id). */
  id: string
  label: string
  /** One line under the pane heading (ui-overhaul boards: the page's subtitle). */
  description?: string
}

/**
 * One group of the settings menu: "App" or "Project: <name>". Each group is its own native tablist (roving tabindex,
 * arrows and Home / End inside the group); Tab moves from one group to the next. Every entry is a tab of the one
 * Settings view: picking one shows its pane in place, App or project alike.
 */
export interface SettingsNavGroup {
  /** 'app' or 'project'. Also namespaces the tab ids (pane ids repeat across groups: both have a 'general'). */
  key: string
  heading: ReactNode
  /** Accessible name of the group's tablist. */
  label: string
  items: SettingsNavItem[]
}

/** DOM id of a pane's tab button. Stable so the tabpanel can point at it and e2e can find it. */
export const settingsTabId = (idBase: string, group: string, pane: string): string => `${idBase}-tab-${group}-${pane}`
/** DOM id of the page's tabpanel. */
export const settingsPanelId = (idBase: string): string => `${idBase}-panel`

/**
 * The shared settings menu (ui-overhaul `snav`): one glass panel with an "App" group and a "Project" group, both
 * native tablists controlling the one panel `SettingsPage` renders. A left rail at wide container widths, a
 * horizontal strip when narrow (CSS decides).
 */
export function SettingsNav({
  groups,
  active,
  onSelect,
  idBase
}: {
  groups: SettingsNavGroup[]
  active: { group: string; pane: string }
  onSelect: (group: string, pane: string) => void
  idBase: string
}): ReactElement {
  return (
    <nav className="settings-nav glass" aria-label="Settings menu">
      {groups.map((g) => {
        const current = g.key === active.group ? active.pane : null
        // A group without the active pane keeps its first tab in the Tab order.
        const tabStop = current ?? g.items[0]?.id
        const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
          const from = g.items.findIndex((it) => document.activeElement?.id === settingsTabId(idBase, g.key, it.id))
          const i = from >= 0 ? from : 0
          let next = i
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % g.items.length
          else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + g.items.length) % g.items.length
          else if (e.key === 'Home') next = 0
          else if (e.key === 'End') next = g.items.length - 1
          else return
          e.preventDefault()
          onSelect(g.key, g.items[next].id)
          document.getElementById(settingsTabId(idBase, g.key, g.items[next].id))?.focus()
        }
        return (
          <div key={g.key} className="settings-nav-group" data-group={g.key}>
            <div className="settings-nav-head" aria-hidden="true">
              {g.heading}
            </div>
            <div className="settings-nav-tabs" role="tablist" aria-label={g.label} aria-orientation="vertical" onKeyDown={onKeyDown}>
              {g.items.map((it) => {
                const on = current === it.id
                return (
                  <button
                    key={it.id}
                    type="button"
                    role="tab"
                    id={settingsTabId(idBase, g.key, it.id)}
                    className={`settings-nav-item${on ? ' active' : ''}`}
                    aria-selected={on}
                    aria-controls={settingsPanelId(idBase)}
                    tabIndex={it.id === tabStop ? 0 : -1}
                    data-testid={`settings-tab-${g.key}-${it.id}`}
                    onClick={() => onSelect(g.key, it.id)}
                  >
                    {it.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )
}
