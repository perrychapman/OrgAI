const KEY = 'orgai.pendingSettingsSection'

/** Section ids of the App settings page. Each lives inside one pane (see `appPaneForSection`). */
export const APP_SETTINGS_SECTIONS = {
  appearance: 'appsettings-section-appearance',
  notifications: 'appsettings-section-notifications',
  connections: 'appsettings-section-connections',
  modelPrices: 'appsettings-section-model-prices',
  mcpLibrary: 'appsettings-section-mcp-library',
  skillLibrary: 'skill-library',
  defaults: 'appsettings-section-defaults',
  usage: 'appsettings-section-usage',
  about: 'appsettings-section-about'
} as const

/** Panes of the App settings page (one is shown at a time), in nav order. */
export const APP_SETTINGS_PANES = {
  general: 'general',
  connections: 'connections',
  mcpLibrary: 'mcp-library',
  skillLibrary: 'skill-library',
  defaults: 'defaults',
  about: 'about'
} as const
export type AppSettingsPane = (typeof APP_SETTINGS_PANES)[keyof typeof APP_SETTINGS_PANES]

/**
 * Panes of the project Settings tab, in nav order. `tools` (id kept for stored choices and links) is now "Plugins and skill
 * settings": skills and connections live in Team > Catalog (`openProjectMcp` in the store deep-links there).
 */
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
  [APP_SETTINGS_SECTIONS.modelPrices]: 'connections',
  [APP_SETTINGS_SECTIONS.mcpLibrary]: 'mcp-library',
  [APP_SETTINGS_SECTIONS.skillLibrary]: 'skill-library',
  [APP_SETTINGS_SECTIONS.defaults]: 'defaults',
  [APP_SETTINGS_SECTIONS.usage]: 'defaults',
  [APP_SETTINGS_SECTIONS.about]: 'about'
}

/** The App settings pane that contains a section id (a pane id maps to itself); undefined when unknown. */
export function appPaneForSection(id: string): AppSettingsPane | undefined {
  if ((Object.values(APP_SETTINGS_PANES) as string[]).includes(id)) return id as AppSettingsPane
  return APP_SECTION_PANE[id]
}

/**
 * Move focus to the active pane's heading (`SettingsPage` renders it with tabIndex -1) after a deep link switched
 * panes, so a keyboard user continues from the new pane instead of from the page top.
 */
export function focusPaneHeading(opts?: { preventScroll?: boolean }): void {
  document.querySelector<HTMLElement>('.settings-pane-title')?.focus({ preventScroll: opts?.preventScroll ?? false })
}

/** Ask the App settings page to open on the pane holding a section the next time it mounts (e.g. "App settings > Connections"). */
export function requestAppSettingsSection(id: string): void {
  try {
    sessionStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable: the page just opens on General */
  }
}

/** Ask App settings to open on the Skill library pane (Team > Catalog > Skills links here). The caller still switches the view. */
export function requestSkillLibrary(): void {
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.skillLibrary)
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

const PRICE_KEY = 'orgai.pendingModelPrice'

/**
 * Open App settings > Connections > Model prices (scrolled to and focused), optionally with the add form pre-filled
 * with a model id. The caller still switches the view (`setView('appSettings')`).
 */
export function requestModelPrice(model?: string): void {
  requestAppSettingsSection(APP_SETTINGS_SECTIONS.modelPrices)
  try {
    if (model) sessionStorage.setItem(PRICE_KEY, model.slice(0, 200))
    else sessionStorage.removeItem(PRICE_KEY)
  } catch {
    /* storage unavailable: the section just opens without a pre-filled model */
  }
}

/** Read and clear the model id to pre-fill in the Model prices add form. */
export function takeModelPriceTarget(): string | null {
  try {
    const m = sessionStorage.getItem(PRICE_KEY)
    if (m) sessionStorage.removeItem(PRICE_KEY)
    return m
  } catch {
    return null
  }
}
