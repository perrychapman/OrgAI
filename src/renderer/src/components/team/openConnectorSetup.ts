import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, rememberTeamOrigin, requestAppSettingsSection, requestConnector } from '../../lib/settingsTarget'

/**
 * Sign in or add a token for a connector: App settings > Connectors with the service's gallery tile scrolled to and
 * focused. A plain library entry (no connectorId) still lands on its library row. When started from the Team tab the
 * project and selected role are remembered so the gallery can offer "Back to Team".
 */
export function openConnectorSetup(connectorId: string | undefined, libraryId: string | undefined): void {
  const st = useAppStore.getState()
  if (st.view === 'team' && st.selectedProjectId) {
    rememberTeamOrigin({ projectId: st.selectedProjectId, ...(st.selectedRoleId ? { roleId: st.selectedRoleId } : {}) })
  }
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
  if (connectorId) {
    requestConnector(connectorId)
    st.setView('appSettings')
    return
  }
  st.openMcpLibrary(libraryId)
}
