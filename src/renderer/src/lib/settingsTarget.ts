const KEY = 'orgai.pendingSettingsSection'

/** Section ids of the App settings page. Each lives inside one pane (see `appPaneForSection`). */
export const APP_SETTINGS_SECTIONS = {
  appearance: 'appsettings-section-appearance',
  notifications: 'appsettings-section-notifications',
  /** General > Canvas (visible; a deep link focuses the checked style option). */
  canvas: 'appsettings-section-canvas',
  connections: 'appsettings-section-connections',
  modelPrices: 'appsettings-section-model-prices',
  mcpLibrary: 'appsettings-section-mcp-library',
  skillLibrary: 'skill-library',
  /** General > New projects (visible). */
  newProjects: 'appsettings-section-new-projects',
  /** General > Advanced > "Assistant models" group (a SettingsGroup id; its heading takes focus). */
  assistantModels: 'appsettings-section-assistant-models',
  /** Connections > Advanced > Costs. */
  costs: 'appsettings-section-costs',
  /** Templates and kit > Team templates. */
  templates: 'appsettings-section-templates',
  about: 'appsettings-section-about'
} as const

/** The Advanced disclosure (SettingsAdvanced pane key) a section lives in; deep links open it before landing. */
export const ADVANCED_SECTIONS: Readonly<Record<string, 'app-general' | 'app-connections'>> = {
  [APP_SETTINGS_SECTIONS.assistantModels]: 'app-general',
  [APP_SETTINGS_SECTIONS.costs]: 'app-connections',
  [APP_SETTINGS_SECTIONS.modelPrices]: 'app-connections'
}

/** The App settings Advanced pane key holding a section, or undefined when the section is visible at rest. */
export function advancedPaneForSection(id: string): 'app-general' | 'app-connections' | undefined {
  return ADVANCED_SECTIONS[id]
}

/** Panes of the App settings page (one is shown at a time), in nav order. */
export const APP_SETTINGS_PANES = {
  general: 'general',
  connections: 'connections',
  mcpLibrary: 'mcp-library',
  skillLibrary: 'skill-library',
  /** Templates and kit (engagement-2 spec section 8; the kit part comes later). */
  kit: 'kit',
  about: 'about'
} as const
export type AppSettingsPane = (typeof APP_SETTINGS_PANES)[keyof typeof APP_SETTINGS_PANES]

/**
 * Panes of the project Settings tab, in nav order (config-review spec 4). The Connection section lives in General;
 * plugins moved to Team > Catalog.
 */
export const PROJECT_SETTINGS_PANES = {
  general: 'general',
  permissions: 'permissions',
  limits: 'limits',
  maintenance: 'maintenance'
} as const
export type ProjectSettingsPane = (typeof PROJECT_SETTINGS_PANES)[keyof typeof PROJECT_SETTINGS_PANES]

/** Pane ids saved before the restructure, mapped to the pane that now holds their content. */
const LEGACY_PROJECT_PANES: Record<string, ProjectSettingsPane> = { agents: 'permissions', connection: 'general', tools: 'general' }

/** A stored pane choice as a current pane: legacy ids map over, anything unknown is General. */
export function normalizeProjectPane(stored: string | null | undefined): ProjectSettingsPane {
  if (!stored) return 'general'
  if ((Object.values(PROJECT_SETTINGS_PANES) as string[]).includes(stored)) return stored as ProjectSettingsPane
  return LEGACY_PROJECT_PANES[stored] ?? 'general'
}

/** Section ids inside project Settings panes that deep links target. */
export const PROJECT_SETTINGS_SECTIONS = {
  permissions: 'settings-section-permissions',
  allowedFolders: 'settings-section-allowed-folders',
  rules: 'settings-section-rules',
  /** General > Connection (not a deep-link target of PermissionCard; listed for e2e and the pane map). */
  connection: 'settings-section-connection',
  /** Permissions > Advanced > Runs > the Team assistant select (Team tab "Team assistant settings"; the select takes focus). */
  teamAssistant: 'settings-section-team-assistant',
  /** General > Engagement plan (engagements only). */
  engagementPlan: 'settings-section-engagement-plan',
  /** General > Context notes (engagements only). */
  contextNotes: 'settings-section-context-notes'
} as const
export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[keyof typeof PROJECT_SETTINGS_SECTIONS]

const PROJECT_SECTION_PANE: Record<ProjectSettingsSection, ProjectSettingsPane> = {
  [PROJECT_SETTINGS_SECTIONS.permissions]: 'permissions',
  [PROJECT_SETTINGS_SECTIONS.allowedFolders]: 'permissions',
  [PROJECT_SETTINGS_SECTIONS.rules]: 'permissions',
  [PROJECT_SETTINGS_SECTIONS.connection]: 'general',
  [PROJECT_SETTINGS_SECTIONS.teamAssistant]: 'permissions',
  [PROJECT_SETTINGS_SECTIONS.engagementPlan]: 'general',
  [PROJECT_SETTINGS_SECTIONS.contextNotes]: 'general'
}

/** Project targets inside a pane's Advanced disclosure (SettingsAdvanced pane key); deep links open it before landing. */
export const PROJECT_ADVANCED_SECTIONS: Readonly<Partial<Record<ProjectSettingsSection, 'project-permissions' | 'project-limits'>>> = {
  [PROJECT_SETTINGS_SECTIONS.teamAssistant]: 'project-permissions'
}

/** The project Settings pane holding a section id; undefined when unknown. */
export function projectPaneForSection(id: string): ProjectSettingsPane | undefined {
  return (PROJECT_SECTION_PANE as Record<string, ProjectSettingsPane>)[id]
}

/** Window event a mounted project Settings pane listens to after `requestProjectSettingsSection`. */
export const PROJECT_SECTION_EVENT = 'orgai:project-settings-section'

const PROJECT_SECTION_KEY = 'orgai.pendingProjectSection'

/**
 * Ask project Settings to scroll to and focus a section the next time its pane mounts (or now, through
 * PROJECT_SECTION_EVENT). Unknown ids are dropped. The caller still selects the project, the pane and the view.
 */
export function requestProjectSettingsSection(id: ProjectSettingsSection): void {
  if (!projectPaneForSection(id)) return
  try {
    sessionStorage.setItem(PROJECT_SECTION_KEY, id)
  } catch {
    /* storage unavailable: the pane just opens at the top */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROJECT_SECTION_EVENT))
}

/** Read and clear the requested project section, when it lives in `pane` (null otherwise; the request is kept). */
export function takeProjectSettingsSection(pane: ProjectSettingsPane): ProjectSettingsSection | null {
  try {
    const id = sessionStorage.getItem(PROJECT_SECTION_KEY)
    if (!id) return null
    if (projectPaneForSection(id) !== pane) return null
    sessionStorage.removeItem(PROJECT_SECTION_KEY)
    return id as ProjectSettingsSection
  } catch {
    return null
  }
}

const APP_SECTION_PANE: Record<string, AppSettingsPane> = {
  [APP_SETTINGS_SECTIONS.appearance]: 'general',
  [APP_SETTINGS_SECTIONS.notifications]: 'general',
  [APP_SETTINGS_SECTIONS.canvas]: 'general',
  [APP_SETTINGS_SECTIONS.connections]: 'connections',
  [APP_SETTINGS_SECTIONS.modelPrices]: 'connections',
  [APP_SETTINGS_SECTIONS.costs]: 'connections',
  [APP_SETTINGS_SECTIONS.newProjects]: 'general',
  [APP_SETTINGS_SECTIONS.assistantModels]: 'general',
  [APP_SETTINGS_SECTIONS.mcpLibrary]: 'mcp-library',
  [APP_SETTINGS_SECTIONS.skillLibrary]: 'skill-library',
  [APP_SETTINGS_SECTIONS.templates]: 'kit',
  [APP_SETTINGS_SECTIONS.about]: 'about'
}

/**
 * The App settings pane that contains a section id (a pane id maps to itself); undefined when unknown or removed
 * (the old Defaults pane and its rows: the page then opens on General).
 */
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

const CONNECTOR_KEY = 'orgai.pendingConnector'

/** A connector id is lowercase kebab-case (letters, digits, single hyphens), at most 64 characters. */
export function isConnectorId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
}

/**
 * Open App settings > Connectors with one service's tile scrolled to, focused and briefly highlighted. A bad id is dropped.
 * The caller still switches the view and, when App settings is already open, dispatches `orgai:settings-section`.
 */
export function requestConnector(connectorId: string): void {
  if (!isConnectorId(connectorId)) return
  requestAppSettingsSection(APP_SETTINGS_PANES.mcpLibrary)
  try {
    sessionStorage.setItem(CONNECTOR_KEY, connectorId)
  } catch {
    /* storage unavailable: the pane just opens without the highlight */
  }
}

/** Read and clear the requested connector id (null when none or invalid). */
export function takeConnectorTarget(): string | null {
  try {
    const id = sessionStorage.getItem(CONNECTOR_KEY)
    if (id !== null) sessionStorage.removeItem(CONNECTOR_KEY)
    return isConnectorId(id) ? id : null
  } catch {
    return null
  }
}

const PRICE_KEY = 'orgai.pendingModelPrice'

/**
 * Open App settings > Connections > Model prices (its pane's Advanced opened first, then scrolled to and focused), optionally with the add form pre-filled
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

const TEAM_ORIGIN_KEY = 'orgai.teamOrigin'

export interface TeamOrigin {
  projectId: string
  /** The role that was selected when the deep link started, if any. */
  roleId?: string
}

/** Remember that a deep link into App settings started on the Team tab, so the destination can offer "Back to Team". */
export function rememberTeamOrigin(origin: TeamOrigin): void {
  try {
    sessionStorage.setItem(TEAM_ORIGIN_KEY, JSON.stringify(origin))
  } catch {
    /* storage unavailable: no Back button */
  }
}

/** Read the Team origin without clearing it (null when none or malformed). */
export function peekTeamOrigin(): TeamOrigin | null {
  try {
    const raw = sessionStorage.getItem(TEAM_ORIGIN_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<TeamOrigin> | null
    if (!v || typeof v.projectId !== 'string' || v.projectId.length === 0 || v.projectId.length > 200) return null
    if (v.roleId !== undefined && (typeof v.roleId !== 'string' || v.roleId.length > 200)) return null
    return v.roleId ? { projectId: v.projectId, roleId: v.roleId } : { projectId: v.projectId }
  } catch {
    return null
  }
}

export function clearTeamOrigin(): void {
  try {
    sessionStorage.removeItem(TEAM_ORIGIN_KEY)
  } catch {
    /* nothing to clear */
  }
}
