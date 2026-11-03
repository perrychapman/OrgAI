import type { ReactElement, ReactNode, SyntheticEvent } from 'react'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { GroupHeadingLevelContext } from './SettingsSection'

/** Panes that have an Advanced disclosure (config-review spec 2). Not per project. */
export type SettingsAdvancedPane = 'app-general' | 'app-connections' | 'project-permissions' | 'project-limits'

/** localStorage key of a pane's remembered open state ('1' open, absent closed). */
export function advancedStorageKey(pane: SettingsAdvancedPane): string {
  return `orgai.settingsAdvanced.${pane}`
}

function readOpen(pane: SettingsAdvancedPane): boolean {
  try {
    return localStorage.getItem(advancedStorageKey(pane)) === '1'
  } catch {
    return false
  }
}

function writeOpen(pane: SettingsAdvancedPane, open: boolean): void {
  try {
    if (open) localStorage.setItem(advancedStorageKey(pane), '1')
    else localStorage.removeItem(advancedStorageKey(pane))
  } catch {
    /* storage unavailable: the disclosure just opens closed next time */
  }
}

/**
 * Open a pane's Advanced disclosure (deep links into it). Returns the details element, or null when the pane is not
 * mounted. Setting `open` fires the toggle event, which stores the state like a click. Never moves focus.
 */
export function openSettingsAdvanced(pane: SettingsAdvancedPane): HTMLDetailsElement | null {
  const el = document.querySelector<HTMLDetailsElement>(`details.settings-advanced[data-pane="${pane}"]`)
  if (el && !el.open) el.open = true
  return el
}

/**
 * The one "Advanced settings" disclosure at the end of a settings pane: a native details/summary (its visible text
 * is its accessible name), closed by default, open state remembered per pane. The body uses the same
 * SettingsGroup + SettingsCard + SettingRow pattern as the rest of the pane, always mounted (opening never moves focus).
 */
export function SettingsAdvanced({ paneKey, children }: { paneKey: SettingsAdvancedPane; children: ReactNode }): ReactElement {
  // Read once on mount; afterwards the DOM owns the open state and the toggle event stores it.
  const [initialOpen] = useState(() => readOpen(paneKey))
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>): void => writeOpen(paneKey, e.currentTarget.open)
  return (
    <details className="settings-advanced" data-testid="settings-advanced" data-pane={paneKey} open={initialOpen} onToggle={onToggle}>
      <summary className="settings-advanced-summary">
        <ChevronRight className="settings-advanced-chevron" size={14} aria-hidden="true" />
        Advanced settings
      </summary>
      <div className="settings-advanced-body">
        {/* Groups here sit directly under the pane's h2, so their titles are h3 (a SettingsSection inside resets to h4). */}
        <GroupHeadingLevelContext.Provider value={3}>{children}</GroupHeadingLevelContext.Provider>
      </div>
    </details>
  )
}
