import type { ReactElement } from 'react'

export interface SettingsNavItem {
  /** DOM id of the section this item scrolls to. */
  id: string
  label: string
}

/** Sub-navigation of a settings page: a left rail at wide widths, a wrapped row when the page is narrow. */
export function SettingsNav({
  items,
  active,
  onSelect,
  label = 'Project settings sections'
}: {
  items: SettingsNavItem[]
  active: string
  onSelect: (id: string) => void
  label?: string
}): ReactElement {
  return (
    <nav className="settings-nav" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`settings-nav-item${active === it.id ? ' active' : ''}`}
          aria-current={active === it.id ? 'location' : undefined}
          onClick={() => onSelect(it.id)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  )
}
