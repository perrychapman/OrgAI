import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'

/**
 * Sign in or add a token for a connector: App settings > Connectors. Today this lands on the library row; when
 * `requestConnector(connectorId)` (lib/settingsTarget) is available here, call it after `requestAppSettingsSection`
 * so the gallery tile is scrolled into view and focused. This is the single place to swap.
 */
export function openConnectorSetup(connectorId: string | undefined, libraryId: string | undefined): void {
  void connectorId
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
  useAppStore.getState().openMcpLibrary(libraryId)
}
