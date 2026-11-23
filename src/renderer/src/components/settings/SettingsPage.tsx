import type { ReactElement, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { PaneTitleContext } from './SettingsSection'
import { SettingsNav, settingsPanelId, settingsTabId, type SettingsNavGroup } from './SettingsNav'

/**
 * The one Settings view's frame (ui-overhaul settings boards): the settings menu (a glass left rail from 640px of
 * container width, a strip above the content below that) with its App and Project groups, and one tabpanel holding the
 * active pane. The panel starts with the page header: a scope caption ("App", "Project: Notes API"), an h2 reading the
 * tab label (tabIndex -1, the focus target after a deep link; sections inside are h3) and the pane's one-line
 * description. Only the active pane is rendered. `idBase` namespaces tab/panel ids.
 */
export function SettingsPage({
  title,
  idBase,
  groups,
  active,
  onSelect,
  scope,
  wide,
  headerActions,
  children
}: {
  /** Optional page heading above the layout. Omit when the topbar h1 already names the page. */
  title?: string
  idBase: string
  groups: SettingsNavGroup[]
  active: { group: string; pane: string }
  onSelect: (group: string, pane: string) => void
  /** Caption above the pane heading. */
  scope?: ReactNode
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
  const key = `${active.group}:${active.pane}`
  const pane = groups.find((g) => g.key === active.group)?.items.find((p) => p.id === active.pane)
  const paneLabel = pane?.label ?? ''
  return (
    <div className="settings-scroll" ref={scroller}>
      {title && <div className="settings-page-title">{title}</div>}
      <div className="settings-layout">
        <SettingsNav
          groups={groups}
          active={active}
          idBase={idBase}
          onSelect={(group, id) => {
            if (group === active.group && id === active.pane) return
            if (scroller.current) scroller.current.scrollTop = 0
            setPicked(`${group}:${id}`)
            onSelect(group, id)
          }}
        />
        <div
          key={key}
          className={`settings-col${wide ? ' is-wide' : ''}${picked === key ? ' motion-view' : ''}`}
          role="tabpanel"
          id={settingsPanelId(idBase)}
          aria-labelledby={settingsTabId(idBase, active.group, active.pane)}
          data-pane={active.pane}
          data-group={active.group}
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
