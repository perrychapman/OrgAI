import type { ReactElement, ReactNode } from 'react'
import { useRef } from 'react'
import { SettingsNav, settingsPanelId, settingsTabId, type SettingsNavItem } from './SettingsNav'

/**
 * Shared frame of both settings pages: optional page title, the pane nav (left rail from 640px of container width,
 * tab strip above the content below that) and one tabpanel holding the active pane's sections. Only the active pane
 * is rendered. `idBase` namespaces tab/panel ids ('app-settings', 'project-settings').
 */
export function SettingsPage({
  title,
  idBase,
  label,
  panes,
  active,
  onSelect,
  children
}: {
  /** Page heading. Omit when the topbar h1 already names the page. */
  title?: string
  idBase: string
  /** Accessible name of the tablist. */
  label: string
  panes: SettingsNavItem[]
  active: string
  onSelect: (pane: string) => void
  /** The active pane's sections. */
  children: ReactNode
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  return (
    <div className="settings-scroll" ref={scroller}>
      {title && <h2 className="settings-page-title">{title}</h2>}
      <div className="settings-layout">
        <SettingsNav
          items={panes}
          active={active}
          idBase={idBase}
          label={label}
          onSelect={(id) => {
            if (id === active) return
            if (scroller.current) scroller.current.scrollTop = 0
            onSelect(id)
          }}
        />
        <div className="settings-col" role="tabpanel" id={settingsPanelId(idBase)} aria-labelledby={settingsTabId(idBase, active)}>
          {children}
        </div>
      </div>
    </div>
  )
}
