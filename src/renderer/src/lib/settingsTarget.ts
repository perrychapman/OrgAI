const KEY = 'orgai.pendingSettingsSection'

/** Section ids of the App settings page. Each lives inside one pane (see `appPaneForSection`). */
export const APP_SETTINGS_SECTIONS = {
  appearance: 'appsettings-section-appearance',
  notifications: 'appsettings-section-notifications',
  connections: 'appsettings-section-connections',
  mcpLibrary: 'appsettings-section-mcp-library',
  defaults: 'appsettings-section-defaults',
  usage: 'appsettings-section-usage',
  about: 'appsettings-section-about'
} as const

/** Panes of the App settings page (one is shown at a time), in nav order. */
export const APP_SETTINGS_PANES = {
  general: 'general',
  connections: 'connections',
  mcpLibrary: 'mcp-library',
  defaults: 'defaults',
  about: 'about'
} as const
export type AppSettingsPane = (typeof APP_SETTINGS_PANES)[keyof typeof APP_SETTINGS_PANES]

/** Panes of the project Settings tab, in nav order. */
export const PROJECT_SETTINGS_PANES = {
  general: 'general',
  agents: 'agents',
  limits: 'limits',
  connection: 'connection',
  tools: 'tools',
  maintenance: 'maintenance'
} as const
export type ProjectSettingsPane = (typeof PROJECT_SETTINGS_PANES)[keyof typeof PROJECT_SETTINGS_PANES]

const APP_SECTION_PANE: Record<string, AppSettingsPane> = {
  [APP_SETTINGS_SECTIONS.appearance]: 'general',
  [APP_SETTINGS_SECTIONS.notifications]: 'general',
  [APP_SETTINGS_SECTIONS.connections]: 'connections',
  [APP_SETTINGS_SECTIONS.mcpLibrary]: 'mcp-library',
  [APP_SETTINGS_SECTIONS.defaults]: 'defaults',
  [APP_SETTINGS_SECTIONS.usage]: 'defaults',
  [APP_SETTINGS_SECTIONS.about]: 'about'
}

/** The App settings pane that contains a section id (a pane id maps to itself); undefined when unknown. */
export function appPaneForSection(id: string): AppSettingsPane | undefined {
  if ((Object.values(APP_SETTINGS_PANES) as string[]).includes(id)) return id as AppSettingsPane
  return APP_SECTION_PANE[id]
}

const PROJECT_SECTION_PANE: Record<string, ProjectSettingsPane> = {
  'settings-section-general': 'general',
  'settings-section-permissions': 'agents',
  'settings-section-rules': 'agents',
  'settings-section-behaviour': 'agents',
  'settings-section-limits': 'limits',
  'settings-section-connection': 'connection',
  'settings-section-mcp': 'tools',
  'settings-section-plugins': 'tools',
  'settings-section-maintenance': 'maintenance'
}

/** The project Settings pane that contains a section id; undefined when unknown. */
export function projectPaneForSection(id: string): ProjectSettingsPane | undefined {
  return PROJECT_SECTION_PANE[id]
}

/** Ask the App settings page to open on the pane holding a section the next time it mounts (e.g. "App settings > Connections"). */
export function requestAppSettingsSection(id: string): void {
  try {
    sessionStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable: the page just opens on General */
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
