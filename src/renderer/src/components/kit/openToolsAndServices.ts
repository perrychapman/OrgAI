import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_PANES, requestAppSettingsSection } from '../../lib/settingsTarget'

/** What the hand-off needs, injectable so the order of the steps can be checked without a window. */
export interface ToolsAndServicesDeps {
  requestSection: (pane: string) => void
  setView: (view: 'appSettings') => void
  announce: () => void
}

const live: ToolsAndServicesDeps = {
  requestSection: requestAppSettingsSection,
  setView: (view) => useAppStore.getState().setView(view),
  announce: () => {
    window.dispatchEvent(new Event('orgai:settings-section'))
  }
}

/**
 * "Open Tools and services" after a kit import that needs secrets: ask for the connectors pane, switch to app Settings
 * (project settings ignore app deep links), then tell an already open Settings page to look again. The order matters:
 * the request is stored first so the page that mounts or wakes up finds it.
 */
export function openToolsAndServices(deps: ToolsAndServicesDeps = live): void {
  deps.requestSection(APP_SETTINGS_PANES.mcpLibrary)
  deps.setView('appSettings')
  deps.announce()
}
