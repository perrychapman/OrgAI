import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection, requestConnector } from '../../lib/settingsTarget'

/**
 * Sign in or add a token for a connector: App settings > Connectors with the service's gallery tile scrolled to and
 * focused. A plain library entry (no connectorId) still lands on its library row.
 */
export function openConnectorSetup(connectorId: string | undefined, libraryId: string | undefined): void {
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
  if (connectorId) {
    requestConnector(connectorId)
    useAppStore.getState().setView('appSettings')
    return
  }
  useAppStore.getState().openMcpLibrary(libraryId)
}
