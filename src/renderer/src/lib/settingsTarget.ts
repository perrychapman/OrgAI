const KEY = 'orgai.pendingSettingsSection'

/** Section ids of the App settings page. */
export const APP_SETTINGS_SECTIONS = {
  appearance: 'appsettings-section-appearance',
  notifications: 'appsettings-section-notifications',
  connections: 'appsettings-section-connections',
  defaults: 'appsettings-section-defaults',
  about: 'appsettings-section-about'
} as const

/** Ask the App settings page to land on a section the next time it mounts (e.g. "Settings > Connections"). */
export function requestAppSettingsSection(id: string): void {
  try {
    sessionStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable: the page just opens at the top */
  }
}

/** Read and clear the requested section. */
export function takeAppSettingsSection(): string | null {
  try {
    const id = sessionStorage.getItem(KEY)
    if (id) sessionStorage.removeItem(KEY)
    return id
  } catch {
    return null
  }
}
