// The deep-link id tables live in the app atlas (src/shared/view/atlas.ts) so the reference service, open_in_app and
// the renderer read one source. Renderer imports keep using './settingsTarget' (settingsTarget.test.ts pins the
// re-exports to the atlas's own objects); the sessionStorage hand-offs below stay renderer-only.
import { APP_SETTINGS_PANES, APP_SETTINGS_SECTIONS, PROJECT_SECTION_EVENT, projectPaneForSection, type ProjectSettingsPane, type ProjectSettingsSection } from '@shared/view/atlas'
export {
  ADVANCED_SECTIONS,
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  PROJECT_ADVANCED_SECTIONS,
  PROJECT_SECTION_EVENT,
  PROJECT_SETTINGS_PANES,
  PROJECT_SETTINGS_SECTIONS,
  advancedPaneForSection,
  appPaneForSection,
  normalizeProjectPane,
  projectPaneForSection
} from '@shared/view/atlas'
export type { AppSettingsPane, ProjectSettingsPane, ProjectSettingsSection } from '@shared/view/atlas'

const KEY = 'orgai.pendingSettingsSection'

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
