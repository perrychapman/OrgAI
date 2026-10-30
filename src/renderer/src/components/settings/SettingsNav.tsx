import type { KeyboardEvent, ReactElement } from 'react'

export interface SettingsNavItem {
  /** Pane id (not a DOM id). */
  id: string
  label: string
}

/** DOM id of a pane's tab button. Stable so the tabpanel can point at it and e2e can find it. */
export const settingsTabId = (idBase: string, pane: string): string => `${idBase}-tab-${pane}`
/** DOM id of the page's tabpanel. */
export const settingsPanelId = (idBase: string): string => `${idBase}-panel`

/**
 * Pane selector of a settings page: a native tablist (roving tabindex, arrow keys, Home/End; selection follows focus).
 * A left rail at wide container widths, a horizontal strip when narrow (CSS decides). The panel it controls is
 * rendered by `SettingsPage`.
 */
export function SettingsNav({
  items,
  active,
  onSelect,
  idBase,
  label
}: {
  items: SettingsNavItem[]
  active: string
  onSelect: (id: string) => void
  idBase: string
  label: string
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
  return (
    <div className="settings-nav" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
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
  )
}
