import type { ReactElement, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { PaneTitleContext } from './SettingsSection'
import { SettingsNav, settingsPanelId, settingsTabId, type SettingsNavItem, type SettingsNavOtherGroup } from './SettingsNav'

/**
 * Shared frame of both settings pages (ui-overhaul settings boards): the settings menu (a glass left rail from 640px
 * of container width, a strip above the content below that) and one tabpanel holding the active pane. The panel starts
 * with the page header: a scope caption ("App", "Project: Notes API"), an h2 reading the tab label (tabIndex -1, the
 * focus target after a deep link; sections inside are h3) and the pane's one-line description. Only the active pane
 * is rendered. `idBase` namespaces tab/panel ids ('app-settings', 'project-settings').
 */
export function SettingsPage({
  title,
  idBase,
  label,
  panes,
  active,
  onSelect,
  scope,
  navHeading,
  other,
  wide,
  headerActions,
  children
}: {
  /** Optional page heading above the layout. Omit when the topbar h1 already names the page. */
  title?: string
  idBase: string
  /** Accessible name of the tablist. */
  label: string
  panes: SettingsNavItem[]
  active: string
  onSelect: (pane: string) => void
  /** Caption above the pane heading. */
  scope?: ReactNode
  /** Caption above this page's tabs in the menu. */
  navHeading?: ReactNode
  /** The other settings page's group in the menu. */
  other?: SettingsNavOtherGroup
  /** The active pane uses the wide column (galleries with a detail panel). */
  wide?: boolean
  /** Buttons right of the pane heading (the board's primary page actions). */
  headerActions?: ReactNode
  /** The active pane's sections. */
  children: ReactNode
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  // Only a pane the user picked arrives with the view recipe; first render and deep links swap with no motion.
  const [picked, setPicked] = useState<string | null>(null)
  const pane = panes.find((p) => p.id === active)
  const paneLabel = pane?.label ?? ''
  return (
    <div className="settings-scroll" ref={scroller}>
      {title && <div className="settings-page-title">{title}</div>}
      <div className="settings-layout">
        <SettingsNav
          items={panes}
          active={active}
          idBase={idBase}
          label={label}
          heading={navHeading}
          other={other}
          onSelect={(id) => {
            if (id === active) return
            if (scroller.current) scroller.current.scrollTop = 0
            setPicked(id)
            onSelect(id)
          }}
        />
        <div
          key={active}
          className={`settings-col${wide ? ' is-wide' : ''}${picked === active ? ' motion-view' : ''}`}
          role="tabpanel"
          id={settingsPanelId(idBase)}
          aria-labelledby={settingsTabId(idBase, active)}
          data-pane={active}
        >
          <header className="settings-pane-head">
            <div className="settings-pane-heading">
              {scope && <div className="settings-pane-scope">{scope}</div>}
              <h2 className="settings-pane-title" id={`${idBase}-pane-title`} tabIndex={-1}>
                {paneLabel}
              </h2>
              {pane?.description && <p className="settings-pane-sub">{pane.description}</p>}
            </div>
            {headerActions && <div className="settings-pane-actions">{headerActions}</div>}
          </header>
          <PaneTitleContext.Provider value={paneLabel}>{children}</PaneTitleContext.Provider>
        </div>
      </div>
    </div>
  )
}
