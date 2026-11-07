/**
 * The app atlas: every place a user can reach in OrgAI, with its breadcrumb path, how to get there and the settings it
 * holds, plus one doc per AppSettings field, per Project field and per MenuAction. Pure data and helpers (no renderer,
 * DOM or React imports; noRendererImports.test.ts guards this folder).
 *
 * Why it stays true as the app grows: APP_SETTING_DOCS, PROJECT_SETTING_DOCS and MENU_ACTION_DOCS are
 * `Record<keyof …>` tables, so adding an AppSettings or Project field, or a MenuAction, without a doc fails
 * typecheck; atlas.test.ts checks every surface's reach, deep-link targets, settings paths and that every proposable
 * field has a surface. Every new screen, pane, section, tab, dialog or popover gets a surface here in the same change.
 *
 * Consumers: the main-process reference service (src/main/reference/appReference.ts, app_reference / app:reference),
 * open_in_app (surface ids only, never URLs) and the renderer (settingsTarget.ts re-exports the id tables below).
 *
 * SKELETON (Runtime Lead): the types, helpers and pinned ids are the contract; the Runtime Engineer completes the
 * surface list, the id tables and the docs (remove the casts marked TODO).
 */
import type { AppSettings, MenuAction, Project } from '../types'

/**
 * Every surface id, kebab-case, prefixed by where it lives: 'dashboard…', 'project-…' (project tabs and Settings
 * panes), 'app-settings-…', 'chat-…' / 'mcp-assistant-…' / 'skill-assistant-…', 'run-…' (run view parts), 'menu-…'.
 * Pinned ids (other briefs and tests use them; never rename): 'dashboard', 'dashboard-new-project', 'project-live',
 * 'project-history', 'project-knowledge', 'project-team', 'project-settings-general', 'project-settings-permissions',
 * 'app-settings-general', 'app-settings-general-appearance', 'app-settings-connections', 'chat-start'.
 */
export const ATLAS_SURFACE_IDS = [
  'dashboard',
  'dashboard-new-project',
  'project-live',
  'project-history',
  'project-knowledge',
  'project-team',
  'project-settings-general',
  'project-settings-permissions',
  'app-settings-general',
  'app-settings-general-appearance',
  'app-settings-connections',
  'chat-start'
] as const

export type AtlasSurfaceId = (typeof ATLAS_SURFACE_IDS)[number]

export type AtlasSurfaceKind = 'view' | 'pane' | 'section' | 'tab' | 'dialog' | 'popover' | 'menu'

/** Where a surface lives: app-wide, inside any project, only in engagements, inside a run, or an assistant. */
export type AtlasScope = 'app' | 'project' | 'engagement' | 'run' | 'assistant'

/** One way to reach a surface. `deepLink.target` is a section or pane id from the tables below. */
export type AtlasReach =
  | { via: 'sidebar'; label: string }
  | { via: 'menu'; action: MenuAction }
  | { via: 'shortcut'; label: string }
  | { via: 'tab'; label: string }
  | { via: 'button'; label: string; on: AtlasSurfaceId }
  | { via: 'deepLink'; target: string }

export interface AtlasSurface {
  id: AtlasSurfaceId
  /** The surface's own name as the UI shows it. */
  label: string
  /** Breadcrumb from the top, ending with `label`, e.g. ['App settings', 'General', 'Appearance']. */
  path: readonly string[]
  kind: AtlasSurfaceKind
  scope: AtlasScope
  /** What the user does there, one or two sentences. */
  summary: string
  /** Non-empty. */
  reach: readonly AtlasReach[]
  /** Setting field paths shown there: 'appearance.theme' (AppSettings) or 'project.permissionMode' (Project). */
  settings?: readonly string[]
  /** data-testid values of the surface's main elements, for e2e and walkthroughs. */
  testIds?: readonly string[]
}

/** How a settings field is controlled. 'agent' = written by agents through cards; 'main' = main-owned, never the user. */
export interface AtlasSettingDoc {
  /** What the field does, one or two sentences, in the UI's words. */
  summary: string
  /** Where the user changes or sees it; 'none' when no screen shows it. */
  surface: AtlasSurfaceId | 'none'
  control: 'user' | 'main' | 'deprecated' | 'agent'
  /** An agent may propose it on a card (APP_SETTINGS_PROPOSABLE_FIELDS / PROJECT_SETTINGS_PROPOSABLE_FIELDS). */
  proposable?: true
}

// ---------- Deep-link id tables (source of truth; renderer settingsTarget.ts re-exports them) ----------
// TODO(Runtime Engineer): copy APP_SETTINGS_SECTIONS, APP_SETTINGS_PANES, PROJECT_SETTINGS_PANES,
// PROJECT_SETTINGS_SECTIONS, ADVANCED_SECTIONS, PROJECT_ADVANCED_SECTIONS and the section -> pane maps verbatim.

// ---------- Surfaces ----------

export const ATLAS_SURFACES: readonly AtlasSurface[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: ['Dashboard'],
    kind: 'view',
    scope: 'app',
    summary: 'See what needs you, running and paused runs, recent changes and every project at a glance.',
    reach: [{ via: 'sidebar', label: 'Dashboard' }]
  }
]

const BY_ID: ReadonlyMap<string, AtlasSurface> = new Map(ATLAS_SURFACES.map((s) => [s.id, s]))

export function isAtlasSurfaceId(value: unknown): value is AtlasSurfaceId {
  return typeof value === 'string' && (ATLAS_SURFACE_IDS as readonly string[]).includes(value)
}

/** The surface of an id; undefined only for an id with no surface yet (atlas.test.ts requires one for every id). */
export function atlasSurface(id: AtlasSurfaceId): AtlasSurface | undefined {
  return BY_ID.get(id)
}

/** "App settings › General › Appearance" (the path joined with ' › '); the id itself for an id with no surface. */
export function atlasPath(id: AtlasSurfaceId): string {
  const s = BY_ID.get(id)
  return s ? s.path.join(' › ') : id
}

// ---------- Field and menu docs ----------

// TODO(Runtime Engineer): complete these and remove the casts, so a missing key fails typecheck.
export const APP_SETTING_DOCS = {} as Readonly<Record<keyof AppSettings, AtlasSettingDoc>>
export const PROJECT_SETTING_DOCS = {} as Readonly<Record<keyof Project, AtlasSettingDoc>>
export const MENU_ACTION_DOCS = {} as Readonly<Record<MenuAction, string>>
