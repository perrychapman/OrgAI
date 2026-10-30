import type { ReactElement, ReactNode } from 'react'
import { useRef } from 'react'
import { PaneTitleContext } from './SettingsSection'
import { SettingsNav, settingsPanelId, settingsTabId, type SettingsNavItem } from './SettingsNav'

/**
 * Shared frame of both settings pages: optional page title, the pane nav (left rail from 640px of container width,
 * tab strip above the content below that) and one tabpanel holding the active pane's sections. Only the active pane
 * is rendered. The panel starts with an h2 reading the tab label (tabIndex -1, the focus target after a deep link;
 * sections inside are h3). `idBase` namespaces tab/panel ids ('app-settings', 'project-settings').
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
  const paneLabel = panes.find((p) => p.id === active)?.label ?? ''
  return (
    <div className="settings-scroll" ref={scroller}>
      {title && <div className="settings-page-title">{title}</div>}
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
          <h2 className="settings-pane-title" id={`${idBase}-pane-title`} tabIndex={-1}>
            {paneLabel}
          </h2>
          <PaneTitleContext.Provider value={paneLabel}>{children}</PaneTitleContext.Provider>
        </div>
      </div>
    </div>
  )
}
