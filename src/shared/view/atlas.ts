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
 */
import type { AppSettings, MenuAction, Project } from '../types'

/**
 * Every surface id, kebab-case, prefixed by where it lives: 'dashboard…', 'project-…' (project tabs and Settings
 * panes), 'app-settings-…', 'chat-…' / 'mcp-assistant-…' / 'skill-assistant-…', 'run-…' (run view parts), 'menu-…',
 * and 'app-…' for shell parts (sidebar, bell, account popover, shortcuts dialog).
 * Pinned ids (other briefs and tests use them; never rename): 'dashboard', 'dashboard-new-project', 'project-live',
 * 'project-history', 'project-knowledge', 'project-team', 'project-settings-general', 'project-settings-permissions',
 * 'app-settings-general', 'app-settings-general-appearance', 'app-settings-connections', 'chat-start'.
 */
export const ATLAS_SURFACE_IDS = [
  'dashboard',
  'dashboard-new-project',
  'dashboard-new-project-github',
  'dashboard-new-project-template',
  'dashboard-new-project-import',
  'dashboard-needs-you',
  'app-sidebar',
  'app-needs-you',
  'app-account',
  'app-keyboard-shortcuts',
  'project-live',
  'project-new-run',
  'project-history',
  'project-history-runs',
  'project-history-trends',
  'project-knowledge',
  'project-knowledge-list',
  'project-knowledge-graph',
  'project-team',
  'project-team-catalog',
  'project-team-catalog-skills',
  'project-team-catalog-connections',
  'project-team-catalog-plugins',
  'project-team-templates',
  'project-team-import',
  'project-team-assistant',
  'project-settings-general',
  'project-settings-connection',
  'project-settings-engagement-plan',
  'project-settings-context-notes',
  'project-settings-permissions',
  'project-settings-allowed-folders',
  'project-settings-reference-folders',
  'project-settings-rules',
  'project-settings-folder-trust',
  'project-settings-team-assistant',
  'project-settings-limits',
  'project-settings-plan-guard',
  'project-settings-maintenance',
  'app-settings-general',
  'app-settings-general-appearance',
  'app-settings-general-notifications',
  'app-settings-general-canvas',
  'app-settings-general-new-projects',
  'app-settings-general-motion',
  'app-settings-general-assistant-models',
  'app-settings-general-new-projects-advanced',
  'app-settings-general-terminal',
  'app-settings-connections',
  'app-settings-connections-proxies',
  'app-settings-connections-costs',
  'app-settings-connections-model-prices',
  'app-settings-connectors',
  'app-settings-connectors-custom',
  'app-settings-skill-library',
  'app-settings-kit',
  'app-settings-kit-templates',
  'app-settings-about',
  'chat-start',
  'mcp-assistant-start',
  'skill-assistant-start',
  'run-strip',
  'run-toolbar',
  'run-canvas-style',
  'run-legend',
  'run-side-panel',
  'run-transcript',
  'run-usage',
  'run-knowledge',
  'run-decision-tray',
  'run-composer',
  'run-conversation',
  'menu-file',
  'menu-view',
  'menu-run',
  'menu-help'
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

// ---------- Surfaces ----------

const APP = 'App settings'
const PROJ = 'Project'

export const ATLAS_SURFACES: readonly AtlasSurface[] = [
  // ----- Dashboard and New project -----
  {
    id: 'dashboard',
    label: 'Dashboard',
    path: ['Dashboard'],
    kind: 'view',
    scope: 'app',
    summary: 'See what needs you, running and paused runs, what happened since you last looked and every project at a glance. Open, delete or start a project from here.',
    reach: [{ via: 'sidebar', label: 'Dashboard' }],
    testIds: ['dashboard-hero', 'dash-projects', 'project-tile', 'dash-usage', 'dash-cost', 'dash-connections']
  },
  {
    id: 'dashboard-needs-you',
    label: 'Needs you',
    path: ['Dashboard', 'Needs you'],
    kind: 'section',
    scope: 'app',
    summary: 'The decisions waiting on you across projects, plus running, paused and recently ended runs. A row opens the run and its card.',
    reach: [{ via: 'sidebar', label: 'Dashboard' }],
    testIds: ['dash-needs-you', 'dash-needs-row', 'dash-running', 'dash-since', 'dash-paused']
  },
  {
    id: 'dashboard-new-project',
    label: 'New project',
    path: ['Dashboard', 'New project'],
    kind: 'dialog',
    scope: 'app',
    summary: 'Create a project from a folder. Choose Code or Engagement, name it, pick the folder, and choose how the team is set up (setup interview, found agents, a template or the default chart).',
    reach: [
      { via: 'button', label: 'New project', on: 'dashboard' },
      { via: 'menu', action: 'new-project' },
      { via: 'shortcut', label: 'Ctrl/Cmd+N' }
    ],
    testIds: ['new-project-dialog', 'project-kind', 'project-kind-option', 'new-project-submit', 'architect-setup', 'new-project-client', 'new-project-connection-select']
  },
  {
    id: 'dashboard-new-project-github',
    label: 'From GitHub',
    path: ['Dashboard', 'New project', 'From GitHub'],
    kind: 'section',
    scope: 'app',
    summary: 'Clone, or fork and clone, a repository by address into a folder you choose, then continue creating the project. Code projects only.',
    reach: [{ via: 'button', label: 'From GitHub', on: 'dashboard-new-project' }],
    testIds: ['repo-start-panel', 'repo-source', 'repo-parent', 'repo-clone', 'repo-clone-cancel']
  },
  {
    id: 'dashboard-new-project-template',
    label: 'Start from a template',
    path: ['Dashboard', 'New project', 'Start from a template'],
    kind: 'section',
    scope: 'app',
    summary: 'Give the new project a saved team template instead of the default chart or the setup interview.',
    reach: [{ via: 'button', label: 'Start from a template', on: 'dashboard-new-project' }],
    testIds: ['setup-choice-template', 'new-project-template']
  },
  {
    id: 'dashboard-new-project-import',
    label: 'Import found agents',
    path: ['Dashboard', 'New project', 'Import found agents'],
    kind: 'section',
    scope: 'app',
    summary: 'When the folder already holds agent definitions from other tools, choose to import them, run the setup interview or keep the default chart. Import opens a review after the project is created.',
    reach: [{ via: 'button', label: 'Create project and review import', on: 'dashboard-new-project' }],
    testIds: ['setup-choice', 'agents-found']
  },

  // ----- Shell -----
  {
    id: 'app-sidebar',
    label: 'Sidebar',
    path: ['Sidebar'],
    kind: 'view',
    scope: 'app',
    summary: 'Navigate to the Dashboard, the Assistants and your projects, with their open runs. It collapses to a narrow rail and can be resized.',
    reach: [{ via: 'menu', action: 'toggle-sidebar' }, { via: 'shortcut', label: 'Ctrl/Cmd+B' }],
    testIds: ['sidebar-toggle', 'sidebar-resize', 'nav-project', 'nav-assistant', 'app-settings-button']
  },
  {
    id: 'app-needs-you',
    label: 'Needs you',
    path: ['Sidebar', 'Needs you'],
    kind: 'popover',
    scope: 'app',
    summary: 'The bell row lists every decision waiting for you across projects; choosing one opens that card.',
    reach: [{ via: 'sidebar', label: 'Needs you' }, { via: 'menu', action: 'show-needs-you' }],
    testIds: ['needs-you-row', 'needs-you-list', 'topbar-needs-you']
  },
  {
    id: 'app-account',
    label: 'Account',
    path: ['Sidebar', 'Account'],
    kind: 'popover',
    scope: 'app',
    summary: 'The account row shows the connection, plan windows and spend; opening it lists each connection in use with its usage.',
    reach: [{ via: 'sidebar', label: 'Account row at the bottom' }],
    testIds: ['auth-pill', 'account-popover', 'usage-mini', 'spend-periods']
  },
  {
    id: 'app-keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    path: ['Help', 'Keyboard shortcuts'],
    kind: 'dialog',
    scope: 'app',
    summary: 'A list of every keyboard shortcut, grouped as General, Runs and Canvas.',
    reach: [{ via: 'menu', action: 'keyboard-shortcuts' }],
    testIds: ['keyboard-shortcuts-dialog']
  },

  // ----- Project tabs -----
  {
    id: 'project-live',
    label: 'Live',
    path: [PROJ, 'Live'],
    kind: 'tab',
    scope: 'project',
    summary: 'Watch a run: the agents on a canvas, run tabs, the transcript and a decision tray. Start a new run or continue a finished conversation here.',
    reach: [
      { via: 'tab', label: 'Live' },
      { via: 'menu', action: 'show-live' },
      { via: 'shortcut', label: 'Ctrl/Cmd+1' }
    ],
    testIds: ['tab-live', 'run-strip', 'run-tabs']
  },
  {
    id: 'project-new-run',
    label: 'New run',
    path: [PROJ, 'Live', 'New run'],
    kind: 'section',
    scope: 'project',
    summary: 'Write what the team should do and start a run. Choose Team to use the whole org chart or Ask for one assistant.',
    reach: [
      { via: 'menu', action: 'new-run' },
      { via: 'shortcut', label: 'Ctrl/Cmd+T' },
      { via: 'button', label: '+ tab', on: 'run-strip' }
    ],
    testIds: ['new-run-mode', 'folder-trust-notice']
  },
  {
    id: 'project-history',
    label: 'History',
    path: [PROJ, 'History'],
    kind: 'tab',
    scope: 'project',
    summary: 'Browse the project\'s past runs, one row per conversation, or switch to usage trends.',
    reach: [
      { via: 'tab', label: 'History' },
      { via: 'menu', action: 'show-history' },
      { via: 'shortcut', label: 'Ctrl/Cmd+2' }
    ],
    testIds: ['tab-history']
  },
  {
    id: 'project-history-runs',
    label: 'Runs',
    path: [PROJ, 'History', 'Runs'],
    kind: 'section',
    scope: 'project',
    summary: 'Each conversation as one row with its sessions, status and cost. Open one to read it or continue it.',
    reach: [{ via: 'button', label: 'Runs', on: 'project-history' }],
    testIds: ['history-sessions-toggle', 'history-folder']
  },
  {
    id: 'project-history-trends',
    label: 'Trends',
    path: [PROJ, 'History', 'Trends'],
    kind: 'section',
    scope: 'project',
    summary: 'Cost, tokens and run counts over time, by role, model and kind of run, with a CSV export.',
    reach: [{ via: 'button', label: 'Trends', on: 'project-history' }],
    testIds: ['usage-trends']
  },
  {
    id: 'project-knowledge',
    label: 'Knowledge',
    path: [PROJ, 'Knowledge'],
    kind: 'tab',
    scope: 'engagement',
    summary: 'What the engagement knows: people, organisations, decisions, risks and notes the team and you recorded. Engagements only.',
    reach: [{ via: 'tab', label: 'Knowledge' }],
    testIds: ['tab-knowledge', 'knowledge-search', 'knowledge-view-switch']
  },
  {
    id: 'project-knowledge-list',
    label: 'List',
    path: [PROJ, 'Knowledge', 'List'],
    kind: 'section',
    scope: 'engagement',
    summary: 'Items grouped by kind with filters; open one to edit its name, facts and relations, retire or delete it, or add a note.',
    reach: [{ via: 'button', label: 'List', on: 'project-knowledge' }],
    testIds: ['knowledge-row', 'knowledge-kind', 'knowledge-count']
  },
  {
    id: 'project-knowledge-graph',
    label: 'Graph',
    path: [PROJ, 'Knowledge', 'Graph'],
    kind: 'section',
    scope: 'engagement',
    summary: 'The same knowledge drawn as a connected graph, with possible connections you can confirm or dismiss.',
    reach: [{ via: 'button', label: 'Graph', on: 'project-knowledge' }],
    testIds: ['knowledge-neural', 'knowledge-inferred-links']
  },
  {
    id: 'project-team',
    label: 'Team',
    path: [PROJ, 'Team'],
    kind: 'tab',
    scope: 'project',
    summary: 'Edit the org chart: add roles, set prompts, models and tools, drag the layout and use the Team assistant\'s suggestions.',
    reach: [
      { via: 'tab', label: 'Team' },
      { via: 'menu', action: 'show-team' },
      { via: 'shortcut', label: 'Ctrl/Cmd+3' }
    ],
    testIds: ['tab-team', 'team-panel-tabs', 'role-model']
  },
  {
    id: 'project-team-catalog',
    label: 'Catalog',
    path: [PROJ, 'Team', 'Catalog'],
    kind: 'section',
    scope: 'project',
    summary: 'The skills, connections and plugins available to this project and which roles may use them.',
    reach: [{ via: 'button', label: 'Catalog', on: 'project-team' }],
    testIds: ['team-panel-tab-catalog', 'team-catalog']
  },
  {
    id: 'project-team-catalog-skills',
    label: 'Skills',
    path: [PROJ, 'Team', 'Catalog', 'Skills'],
    kind: 'section',
    scope: 'project',
    summary: 'Add, import, link from the library, evaluate and grant skills to roles.',
    reach: [{ via: 'button', label: 'Skills', on: 'project-team-catalog' }],
    testIds: ['skills-section', 'skill-row', 'skill-add-library', 'skill-new', 'skill-import', 'skill-evaluate']
  },
  {
    id: 'project-team-catalog-connections',
    label: 'Connections',
    path: [PROJ, 'Team', 'Catalog', 'Connections'],
    kind: 'section',
    scope: 'project',
    summary: 'Add connected services and MCP servers to the project and choose which roles can use them.',
    reach: [{ via: 'button', label: 'Connections', on: 'project-team-catalog' }],
    testIds: ['mcp-add-service', 'mcp-row', 'connected-service-row']
  },
  {
    id: 'project-team-catalog-plugins',
    label: 'Plugins',
    path: [PROJ, 'Team', 'Catalog', 'Plugins'],
    kind: 'section',
    scope: 'project',
    summary: 'Add plugins that load for this project\'s runs.',
    reach: [{ via: 'button', label: 'Plugins', on: 'project-team-catalog' }],
    testIds: ['plugin-add']
  },
  {
    id: 'project-team-templates',
    label: 'Templates',
    path: [PROJ, 'Team', 'Templates'],
    kind: 'popover',
    scope: 'project',
    summary: 'Save the current team as a template or apply a saved one to this project.',
    reach: [{ via: 'button', label: 'Templates', on: 'project-team' }],
    testIds: ['team-templates', 'team-template-save', 'team-template-apply', 'template-notice']
  },
  {
    id: 'project-team-import',
    label: 'Import from other tools',
    path: [PROJ, 'Team', 'Import from other tools'],
    kind: 'dialog',
    scope: 'project',
    summary: 'Read agent definitions other tools left in the folder, preview them and add or replace roles. Undo is offered after applying.',
    reach: [{ via: 'button', label: 'Import from other tools', on: 'project-team' }],
    testIds: ['import-dialog']
  },
  {
    id: 'project-team-assistant',
    label: 'Team assistant',
    path: [PROJ, 'Team', 'Team assistant'],
    kind: 'section',
    scope: 'project',
    summary: 'A tray under the chart that suggests tools and skills for the team from your runs and this computer. You apply or dismiss each suggestion.',
    reach: [{ via: 'button', label: 'Team assistant', on: 'project-team' }],
    testIds: ['team-assistant', 'capability-card', 'team-assistant-settings']
  },

  // ----- Project settings -----
  {
    id: 'project-settings-general',
    label: 'General',
    path: [PROJ, 'Settings', 'General'],
    kind: 'pane',
    scope: 'project',
    summary: 'The project\'s name, client or case, working directory and brief, plus its connection. Engagements add the plan and context notes.',
    reach: [
      { via: 'tab', label: 'Settings' },
      { via: 'menu', action: 'show-project-settings' },
      { via: 'shortcut', label: 'Ctrl/Cmd+4' }
    ],
    settings: ['project.name', 'project.client', 'project.path', 'project.brief'],
    testIds: ['tab-settings', 'project-path', 'project-client-input', 'project-kind-line']
  },
  {
    id: 'project-settings-connection',
    label: 'Connection',
    path: [PROJ, 'Settings', 'General', 'Connection'],
    kind: 'section',
    scope: 'project',
    summary: 'Choose which connection this project runs on and see the models its roles use.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.connection }],
    settings: ['project.provider'],
    testIds: ['project-connection-line', 'project-connection-option']
  },
  {
    id: 'project-settings-engagement-plan',
    label: 'Engagement plan',
    path: [PROJ, 'Settings', 'General', 'Engagement plan'],
    kind: 'section',
    scope: 'engagement',
    summary: 'Read and edit the engagement plan agents receive in their prompts, or start the setup interview again. Engagements only.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.engagementPlan }],
    testIds: ['engagement-plan-stale']
  },
  {
    id: 'project-settings-context-notes',
    label: 'Context notes',
    path: [PROJ, 'Settings', 'General', 'Context notes'],
    kind: 'section',
    scope: 'engagement',
    summary: 'See a count of the recorded knowledge, open the Knowledge tab and choose whether known items are added to what agents receive. Engagements only.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.contextNotes }],
    settings: ['project.knowledgeAutoContext'],
    testIds: ['knowledge-summary', 'knowledge-open', 'knowledge-auto-context']
  },
  {
    id: 'project-settings-permissions',
    label: 'Permissions',
    path: [PROJ, 'Settings', 'Permissions'],
    kind: 'pane',
    scope: 'project',
    summary: 'How much the agents may do without asking: permission mode, worktree isolation, merge review, run messaging and automatic continues.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_PANES.permissions }],
    settings: [
      'project.permissionMode',
      'project.isolateWriters',
      'project.reviewMerges',
      'project.runMessaging',
      'project.autoContinue',
      'project.maxAutoContinues'
    ],
    testIds: ['permission-mode-tradeoff', 'permissions-summary']
  },
  {
    id: 'project-settings-allowed-folders',
    label: 'Allowed folders',
    path: [PROJ, 'Settings', 'Permissions', 'Allowed folders'],
    kind: 'section',
    scope: 'project',
    summary: 'Extra folders agents may read and edit like the project folder.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.allowedFolders }],
    settings: ['project.allowedDirectories'],
    testIds: ['allowed-folder-add', 'allowed-folder-notice']
  },
  {
    id: 'project-settings-reference-folders',
    label: 'Reference folders',
    path: [PROJ, 'Settings', 'Permissions', 'Reference folders'],
    kind: 'section',
    scope: 'project',
    summary: 'Folders agents may read but not change, such as client material.',
    reach: [{ via: 'button', label: 'Reference folders', on: 'project-settings-permissions' }],
    settings: ['project.referenceDirectories']
  },
  {
    id: 'project-settings-rules',
    label: 'Saved permission rules',
    path: [PROJ, 'Settings', 'Permissions', 'Saved permission rules'],
    kind: 'section',
    scope: 'project',
    summary: 'Review, add and remove the rules saved when you chose "Always allow for project", including rules OrgAI does not use.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.rules }],
    testIds: ['rules-ignored', 'rule-ignored-row']
  },
  {
    id: 'project-settings-folder-trust',
    label: 'Folder config trust',
    path: [PROJ, 'Settings', 'Permissions', 'Folder config trust'],
    kind: 'section',
    scope: 'project',
    summary: 'Review the agent settings that came with the folder and allow or stop using them. Agents ignore them until you allow them.',
    reach: [{ via: 'button', label: 'Review', on: 'project-settings-permissions' }],
    settings: ['project.folderConfigTrust'],
    testIds: ['folder-trust-section', 'folder-trust-status', 'folder-trust-review-open', 'folder-trust-dialog']
  },
  {
    id: 'project-settings-team-assistant',
    label: 'Team assistant',
    path: [PROJ, 'Settings', 'Permissions', 'Advanced', 'Team assistant'],
    kind: 'section',
    scope: 'project',
    summary: 'Choose whether the Team assistant is off, runs free checks or also asks the model for suggestions.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_SECTIONS.teamAssistant }],
    settings: ['project.teamReview', 'project.skillEvaluation'],
    testIds: ['team-assistant-select']
  },
  {
    id: 'project-settings-limits',
    label: 'Limits',
    path: [PROJ, 'Settings', 'Limits'],
    kind: 'pane',
    scope: 'project',
    summary: 'Caps for a run: estimated cost, how many runs to keep, subagent depth and concurrency, and the plan window share.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_PANES.limits }],
    settings: [
      'project.maxBudgetUsd',
      'project.keepRuns',
      'project.maxSubagentDepth',
      'project.maxConcurrentSubagents',
      'project.maxWindowShare'
    ]
  },
  {
    id: 'project-settings-plan-guard',
    label: 'Plan guard',
    path: [PROJ, 'Settings', 'Limits', 'Advanced', 'Plan guard'],
    kind: 'section',
    scope: 'project',
    summary: 'Automatic, on or off: move new deep-tier reports to the everyday tier when a subscription plan window is nearly used up.',
    reach: [{ via: 'button', label: 'Advanced settings', on: 'project-settings-limits' }],
    settings: ['project.preferEverydayNearLimit'],
    testIds: ['plan-guard-line']
  },
  {
    id: 'project-settings-maintenance',
    label: 'Maintenance',
    path: [PROJ, 'Settings', 'Maintenance'],
    kind: 'pane',
    scope: 'project',
    summary: 'Refresh the architecture document, remove OrgAI files from the folder, forget an engagement, clear recorded knowledge or delete the project.',
    reach: [{ via: 'deepLink', target: PROJECT_SETTINGS_PANES.maintenance }],
    testIds: ['knowledge-clear', 'forget-confirm', 'maintenance-notice']
  },

  // ----- App settings -----
  {
    id: 'app-settings-general',
    label: 'General',
    path: [APP, 'General'],
    kind: 'pane',
    scope: 'app',
    summary: 'Appearance, notifications, canvas style and the starting values for new projects; Advanced holds motion, assistant models and terminal access.',
    reach: [
      { via: 'sidebar', label: 'App settings' },
      { via: 'menu', action: 'open-app-settings' },
      { via: 'shortcut', label: 'Ctrl/Cmd+,' }
    ],
    testIds: ['app-settings-button', 'settings-advanced']
  },
  {
    id: 'app-settings-general-appearance',
    label: 'Appearance',
    path: [APP, 'General', 'Appearance'],
    kind: 'section',
    scope: 'app',
    summary: 'Choose the theme (Dark, Light or System) and the accent colour.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.appearance }],
    settings: ['appearance.theme', 'appearance.accent'],
    testIds: ['appearance-section']
  },
  {
    id: 'app-settings-general-notifications',
    label: 'Notifications',
    path: [APP, 'General', 'Notifications'],
    kind: 'section',
    scope: 'app',
    summary: 'Turn desktop notifications on or off for runs that need attention or finish.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.notifications }],
    settings: ['notifications'],
    testIds: ['notifications-switch']
  },
  {
    id: 'app-settings-general-canvas',
    label: 'Canvas',
    path: [APP, 'General', 'Canvas'],
    kind: 'section',
    scope: 'app',
    summary: 'Pick how the org chart and live canvases look: background, layout, lines, how agents are drawn, accent tint and minimap, with a live sample.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.canvas }, { via: 'button', label: 'Canvas style', on: 'run-canvas-style' }],
    settings: [
      'appearance.canvas.pattern',
      'appearance.canvas.tint',
      'appearance.canvas.edges',
      'appearance.canvas.layout',
      'appearance.canvas.nodeStyle',
      'appearance.canvas.minimap'
    ],
    testIds: ['canvas-preview', 'canvas-preset', 'canvas-customise']
  },
  {
    id: 'app-settings-general-new-projects',
    label: 'New projects',
    path: [APP, 'General', 'New projects'],
    kind: 'section',
    scope: 'app',
    summary: 'The permission mode new projects start with. Existing projects keep their own.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.newProjects }],
    settings: ['defaultPermissionMode'],
    testIds: ['new-projects-section', 'default-mode-select']
  },
  {
    id: 'app-settings-general-motion',
    label: 'Motion',
    path: [APP, 'General', 'Advanced', 'Motion'],
    kind: 'section',
    scope: 'app',
    summary: 'Follow the system setting or always reduce motion.',
    reach: [{ via: 'button', label: 'Advanced settings', on: 'app-settings-general' }],
    settings: ['appearance.reduceMotion']
  },
  {
    id: 'app-settings-general-assistant-models',
    label: 'Assistant models',
    path: [APP, 'General', 'Advanced', 'Assistant models'],
    kind: 'section',
    scope: 'app',
    summary: 'Choose the model tier for the setup interview, the MCP assistant, the Skill assistant and Chat.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.assistantModels }],
    settings: ['setupModel', 'mcpAssistModel', 'skillAssistModel', 'quickRunModel'],
    testIds: ['assistant-models-note', 'skill-assist-model-row', 'quick-run-model-row']
  },
  {
    id: 'app-settings-general-new-projects-advanced',
    label: 'New projects (advanced)',
    path: [APP, 'General', 'Advanced', 'New projects (advanced)'],
    kind: 'section',
    scope: 'app',
    summary: 'The starting model tier for a new project\'s orchestrator and for its reports.',
    reach: [{ via: 'button', label: 'Advanced settings', on: 'app-settings-general' }],
    settings: ['defaultRootModel', 'defaultReportModel'],
    testIds: ['default-root-model-row', 'default-report-model-row']
  },
  {
    id: 'app-settings-general-terminal',
    label: 'Terminal',
    path: [APP, 'General', 'Advanced', 'Terminal'],
    kind: 'section',
    scope: 'app',
    summary: 'Allow terminal clients to connect, choose what they may do, and install the orgai command on your PATH.',
    reach: [{ via: 'button', label: 'Advanced settings', on: 'app-settings-general' }],
    settings: ['terminalServer', 'terminalAccessLevel'],
    testIds: ['terminal-server-switch', 'terminal-access-level', 'cli-shim-row']
  },
  {
    id: 'app-settings-connections',
    label: 'Connections',
    path: [APP, 'Connections'],
    kind: 'pane',
    scope: 'app',
    summary: 'Connect, test and disconnect providers, choose the one new projects use, and manage proxy connections. Advanced holds cost sources and model prices.',
    reach: [
      { via: 'menu', action: 'open-connections' },
      { via: 'deepLink', target: APP_SETTINGS_PANES.connections }
    ],
    settings: ['defaultConnection'],
    testIds: ['connection-card', 'connection-make-default', 'connection-default-auto', 'default-connection-badge']
  },
  {
    id: 'app-settings-connections-proxies',
    label: 'Proxies',
    path: [APP, 'Connections', 'Proxies'],
    kind: 'section',
    scope: 'app',
    summary: 'Add, test, edit and remove proxy connections that serve models over your own gateway.',
    reach: [{ via: 'button', label: 'Add proxy', on: 'app-settings-connections' }],
    testIds: ['proxies-heading', 'proxy-add', 'proxy-dialog', 'proxy-save', 'proxy-test']
  },
  {
    id: 'app-settings-connections-costs',
    label: 'Costs',
    path: [APP, 'Connections', 'Advanced', 'Costs'],
    kind: 'section',
    scope: 'app',
    summary: 'Choose whether a community price list fills in prices for models with no built-in price.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.costs }],
    settings: ['communityPrices'],
    testIds: ['community-prices-row', 'community-prices-switch']
  },
  {
    id: 'app-settings-connections-model-prices',
    label: 'Model prices',
    path: [APP, 'Connections', 'Advanced', 'Model prices'],
    kind: 'section',
    scope: 'app',
    summary: 'Set your own per-model prices, which win over every other source.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.modelPrices }],
    settings: ['modelPrices'],
    testIds: ['model-prices-unreported']
  },
  {
    id: 'app-settings-connectors',
    label: 'Connectors',
    path: [APP, 'Connectors'],
    kind: 'pane',
    scope: 'app',
    summary: 'A gallery of services to sign in to or add, with search and filters, then your presets and custom servers.',
    reach: [
      { via: 'menu', action: 'open-connectors' },
      { via: 'deepLink', target: APP_SETTINGS_PANES.mcpLibrary }
    ],
    testIds: ['connectors-section', 'connector-tile', 'connector-action', 'connector-dialog']
  },
  {
    id: 'app-settings-connectors-custom',
    label: 'Custom servers',
    path: [APP, 'Connectors', 'Custom servers'],
    kind: 'section',
    scope: 'app',
    summary: 'Add, edit, test and remove your own MCP servers, or ask the MCP assistant to configure one.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.mcpLibrary }],
    testIds: ['mcp-library-assist', 'presets-section']
  },
  {
    id: 'app-settings-skill-library',
    label: 'Skill library',
    path: [APP, 'Skill library'],
    kind: 'pane',
    scope: 'app',
    summary: 'The app-wide skills you can link into projects, with the projects and roles that use each.',
    reach: [
      { via: 'menu', action: 'open-skill-library' },
      { via: 'deepLink', target: APP_SETTINGS_SECTIONS.skillLibrary }
    ],
    testIds: ['skill-library-row', 'skill-library-used-by']
  },
  {
    id: 'app-settings-kit',
    label: 'Templates and kit',
    path: [APP, 'Templates and kit'],
    kind: 'pane',
    scope: 'app',
    summary: 'Manage team templates and export or import a practice kit of skills, servers, presets and templates in one file.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_PANES.kit }],
    testIds: ['templates-section', 'kit-section']
  },
  {
    id: 'app-settings-kit-templates',
    label: 'Team templates',
    path: [APP, 'Templates and kit', 'Team templates'],
    kind: 'section',
    scope: 'app',
    summary: 'The saved team templates you can apply to a project or start a project from.',
    reach: [{ via: 'deepLink', target: APP_SETTINGS_SECTIONS.templates }],
    testIds: ['templates-section']
  },
  {
    id: 'app-settings-about',
    label: 'About',
    path: [APP, 'About'],
    kind: 'pane',
    scope: 'app',
    summary: 'The version, data folder and links.',
    reach: [{ via: 'menu', action: 'open-about' }, { via: 'deepLink', target: APP_SETTINGS_SECTIONS.about }],
    testIds: ['about-block']
  },

  // ----- Assistants -----
  {
    id: 'chat-start',
    label: 'Chat',
    path: ['Assistants', 'Chat'],
    kind: 'view',
    scope: 'assistant',
    summary: 'Talk to a single assistant, optionally in a folder, and ask it about OrgAI itself or have it change settings through cards you approve. Save the chat as a project later.',
    reach: [
      { via: 'sidebar', label: 'Chat' },
      { via: 'menu', action: 'open-chat' },
      { via: 'menu', action: 'new-chat' },
      { via: 'menu', action: 'ask-about-orgai' },
      { via: 'shortcut', label: 'Ctrl/Cmd+Shift+N' }
    ],
    settings: ['quickRunModel'],
    testIds: ['assistant-start-quick', 'assistant-instruction', 'assistant-start', 'chat-folder-input', 'chat-allow-edits']
  },
  {
    id: 'mcp-assistant-start',
    label: 'MCP assistant',
    path: ['Assistants', 'MCP assistant'],
    kind: 'view',
    scope: 'assistant',
    summary: 'Describe a server or connection you want and the assistant proposes it for your approval; it can build a small server in a scratch workspace.',
    reach: [{ via: 'sidebar', label: 'MCP assistant' }, { via: 'menu', action: 'open-mcp-assistant' }],
    settings: ['mcpAssistModel'],
    testIds: ['assistant-start-harness', 'mcp-allow-build']
  },
  {
    id: 'skill-assistant-start',
    label: 'Skill assistant',
    path: ['Assistants', 'Skill assistant'],
    kind: 'view',
    scope: 'assistant',
    summary: 'Describe a skill you want and the assistant proposes it for your approval, for the library or a project.',
    reach: [{ via: 'sidebar', label: 'Skill assistant' }, { via: 'menu', action: 'open-skill-assistant' }],
    settings: ['skillAssistModel'],
    testIds: ['assistant-start-skills']
  },

  // ----- Run view -----
  {
    id: 'run-strip',
    label: 'Run strip',
    path: [PROJ, 'Live', 'Run strip'],
    kind: 'section',
    scope: 'run',
    summary: 'Run tabs, one per conversation, with Interrupt, End session and Org retrospective for the shown run.',
    reach: [
      { via: 'tab', label: 'Run tabs' },
      { via: 'menu', action: 'close-tab' },
      { via: 'menu', action: 'interrupt-run' },
      { via: 'menu', action: 'end-session' },
      { via: 'menu', action: 'org-retrospective' },
      { via: 'menu', action: 'open-run-window' },
      { via: 'menu', action: 'save-chat-as-project' }
    ],
    testIds: ['run-strip', 'run-tabs', 'run-save-as-project']
  },
  {
    id: 'run-toolbar',
    label: 'Canvas toolbar',
    path: [PROJ, 'Live', 'Canvas toolbar'],
    kind: 'section',
    scope: 'run',
    summary: 'Run details, the Hide finished agents switch, zoom and fit, the canvas style and legend, and the conversation toggle.',
    reach: [
      { via: 'menu', action: 'toggle-hide-finished' },
      { via: 'menu', action: 'canvas-fit' },
      { via: 'menu', action: 'canvas-zoom-in' },
      { via: 'menu', action: 'canvas-zoom-out' }
    ],
    testIds: ['run-meta', 'run-layout-toggle']
  },
  {
    id: 'run-canvas-style',
    label: 'Canvas style',
    path: [PROJ, 'Live', 'Canvas toolbar', 'Canvas style'],
    kind: 'popover',
    scope: 'run',
    summary: 'Pick a canvas style at once; More opens the Canvas section in App settings.',
    reach: [{ via: 'button', label: 'Canvas style', on: 'run-toolbar' }],
    testIds: ['canvas-style-button', 'canvas-style-popover', 'canvas-style-more']
  },
  {
    id: 'run-legend',
    label: 'Legend',
    path: [PROJ, 'Live', 'Canvas toolbar', 'Legend'],
    kind: 'popover',
    scope: 'run',
    summary: 'What the canvas colours and shapes mean.',
    reach: [{ via: 'button', label: 'Legend', on: 'run-toolbar' }],
    testIds: ['canvas-legend']
  },
  {
    id: 'run-side-panel',
    label: 'Side panel',
    path: [PROJ, 'Live', 'Side panel'],
    kind: 'section',
    scope: 'run',
    summary: 'Tabs for the Transcript, Plan, Usage, Knowledge (engagements) and Logs of the shown run. It resizes and collapses to a rail.',
    reach: [{ via: 'button', label: 'Side panel', on: 'project-live' }],
    testIds: ['side-tab-transcript', 'side-tab-plan', 'side-tab-usage', 'side-tab-knowledge', 'side-tab-logs']
  },
  {
    id: 'run-transcript',
    label: 'Transcript',
    path: [PROJ, 'Live', 'Side panel', 'Transcript'],
    kind: 'tab',
    scope: 'run',
    summary: 'What each agent said and did, with tool calls and notes OrgAI wrote.',
    reach: [{ via: 'button', label: 'Transcript', on: 'run-side-panel' }],
    testIds: ['side-tab-transcript']
  },
  {
    id: 'run-usage',
    label: 'Usage',
    path: [PROJ, 'Live', 'Side panel', 'Usage'],
    kind: 'tab',
    scope: 'run',
    summary: 'Cost, tokens, time and skills loaded for the run, by model and role.',
    reach: [{ via: 'button', label: 'Usage', on: 'run-side-panel' }],
    testIds: ['side-tab-usage', 'usage-skills']
  },
  {
    id: 'run-knowledge',
    label: 'Knowledge',
    path: [PROJ, 'Live', 'Side panel', 'Knowledge'],
    kind: 'tab',
    scope: 'engagement',
    summary: 'What the team recalled and recorded in this run. Engagement work runs only.',
    reach: [{ via: 'button', label: 'Knowledge', on: 'run-side-panel' }],
    testIds: ['side-tab-knowledge']
  },
  {
    id: 'run-decision-tray',
    label: 'Decision tray',
    path: [PROJ, 'Live', 'Decision tray'],
    kind: 'section',
    scope: 'run',
    summary: 'Cards that need your answer: permissions, questions, proposals and merge reviews.',
    reach: [{ via: 'menu', action: 'go-to-decision' }, { via: 'shortcut', label: 'Ctrl/Cmd+.' }],
    testIds: ['tray-announce', 'decision-card']
  },
  {
    id: 'run-composer',
    label: 'Composer',
    path: [PROJ, 'Live', 'Composer'],
    kind: 'section',
    scope: 'run',
    summary: 'Type to the running agent, attach images, or continue an ended conversation with its memory.',
    reach: [{ via: 'button', label: 'Composer', on: 'project-live' }],
    testIds: ['composer-cut-notice', 'go-to-latest']
  },
  {
    id: 'run-conversation',
    label: 'Conversation layout',
    path: [PROJ, 'Live', 'Conversation layout'],
    kind: 'section',
    scope: 'run',
    summary: 'Show the root agent\'s transcript as a conversation instead of the canvas, and switch back.',
    reach: [{ via: 'menu', action: 'toggle-conversation' }, { via: 'button', label: 'Show conversation', on: 'run-toolbar' }],
    testIds: ['run-layout-toggle', 'run-conversation', 'conversation-transcript']
  },

  // ----- Application menu -----
  {
    id: 'menu-file',
    label: 'File',
    path: ['Menu', 'File'],
    kind: 'menu',
    scope: 'app',
    summary: 'New project, New chat, Assistants, Close tab, App settings, Connections, Connectors and Skill library.',
    reach: [{ via: 'tab', label: 'Menu bar > File' }]
  },
  {
    id: 'menu-view',
    label: 'View',
    path: ['Menu', 'View'],
    kind: 'menu',
    scope: 'app',
    summary: 'Live, History, Team and Project settings, the sidebar toggle and the canvas items.',
    reach: [{ via: 'tab', label: 'Menu bar > View' }]
  },
  {
    id: 'menu-run',
    label: 'Run',
    path: ['Menu', 'Run'],
    kind: 'menu',
    scope: 'app',
    summary: 'New run, open in a new window, Go to decision, Show what needs you, Interrupt, End session, Save chat as project and Org retrospective.',
    reach: [{ via: 'tab', label: 'Menu bar > Run' }]
  },
  {
    id: 'menu-help',
    label: 'Help',
    path: ['Menu', 'Help'],
    kind: 'menu',
    scope: 'app',
    summary: 'Documentation, Report an issue, Keyboard shortcuts, Ask OrgAI about itself, the logs and data folders and About.',
    reach: [{ via: 'tab', label: 'Menu bar > Help' }, { via: 'menu', action: 'ask-about-orgai' }]
  }
]

const BY_ID: ReadonlyMap<string, AtlasSurface> = new Map(ATLAS_SURFACES.map((s) => [s.id, s]))

export function isAtlasSurfaceId(value: unknown): value is AtlasSurfaceId {
  return typeof value === 'string' && (ATLAS_SURFACE_IDS as readonly string[]).includes(value)
}

/** The surface of an id (every id has one; atlas.test.ts requires it). */
export function atlasSurface(id: AtlasSurfaceId): AtlasSurface {
  return BY_ID.get(id) as AtlasSurface
}

/** "App settings › General › Appearance" (the path joined with ' › '); the id itself for an id with no surface. */
export function atlasPath(id: AtlasSurfaceId): string {
  const s = BY_ID.get(id)
  return s ? s.path.join(' › ') : id
}

// ---------- Field and menu docs ----------
// These are total `Record<keyof …>` tables: a new AppSettings or Project field or MenuAction without a doc fails typecheck.

export const APP_SETTING_DOCS: Readonly<Record<keyof AppSettings, AtlasSettingDoc>> = {
  defaultPermissionMode: {
    summary: 'The permission mode new projects start with. Existing projects keep their own.',
    surface: 'app-settings-general-new-projects',
    control: 'user',
    proposable: true
  },
  defaultMaxBudgetUsd: {
    summary: 'Estimated-cost cap per run for new projects; unset means no cap. No screen shows it yet.',
    surface: 'none',
    control: 'user',
    proposable: true
  },
  defaultKeepRuns: { summary: 'How many runs new projects keep on disk. No screen shows it yet.', surface: 'none', control: 'user', proposable: true },
  defaultIsolateWriters: {
    summary: 'Whether new projects run file-editing reports in their own worktrees. No screen shows it yet.',
    surface: 'none',
    control: 'user',
    proposable: true
  },
  defaultRootModel: {
    summary: 'The model tier or id a new project\'s orchestrator starts with.',
    surface: 'app-settings-general-new-projects-advanced',
    control: 'user',
    proposable: true
  },
  defaultReportModel: {
    summary: 'The model tier or id a new project\'s other roles start with.',
    surface: 'app-settings-general-new-projects-advanced',
    control: 'user',
    proposable: true
  },
  setupModel: {
    summary: 'The model for the setup interview (the Architect), its revisions and the retrospective.',
    surface: 'app-settings-general-assistant-models',
    control: 'user',
    proposable: true
  },
  mcpAssistModel: {
    summary: 'The model for the MCP assistant.',
    surface: 'app-settings-general-assistant-models',
    control: 'user',
    proposable: true
  },
  skillAssistModel: {
    summary: 'The model for the Skill assistant.',
    surface: 'app-settings-general-assistant-models',
    control: 'user',
    proposable: true
  },
  quickRunModel: {
    summary: 'The model for Chat\'s single assistant.',
    surface: 'app-settings-general-assistant-models',
    control: 'user',
    proposable: true
  },
  providerAuth: {
    summary: 'A mirror of the Anthropic connection\'s sign-in mode, kept for older code. Change it on Connections.',
    surface: 'none',
    control: 'main'
  },
  connections: {
    summary: 'The built-in connections\' records (no secrets). Managed through the Connections cards.',
    surface: 'app-settings-connections',
    control: 'main'
  },
  proxies: {
    summary: 'The proxy connections, in order. Managed through the Proxies dialog, never saved as a plain setting.',
    surface: 'app-settings-connections-proxies',
    control: 'main'
  },
  defaultConnection: {
    summary: 'The connection new projects, Chat and the assistants use. Automatic unless you choose one on a connection card ("Use for new projects").',
    surface: 'app-settings-connections',
    control: 'main'
  },
  defaultConnectionChosen: {
    summary: 'Whether you picked the default connection yourself; false means OrgAI picks it automatically.',
    surface: 'app-settings-connections',
    control: 'main'
  },
  defaultConnectionReplaced: {
    summary: 'The connection an automatic switch replaced, so the default can move back when it reconnects.',
    surface: 'none',
    control: 'main'
  },
  notifications: {
    summary: 'Desktop notifications when a run needs attention or finishes.',
    surface: 'app-settings-general-notifications',
    control: 'user',
    proposable: true
  },
  appearance: {
    summary: 'Theme, accent colour, canvas style and reduced motion.',
    surface: 'app-settings-general-appearance',
    control: 'user',
    proposable: true
  },
  opusGuardThreshold: {
    summary: 'The weekly plan-window percentage at which the plan guard moves new deep-tier reports to the everyday tier. No screen shows it yet.',
    surface: 'none',
    control: 'user',
    proposable: true
  },
  defaultPreferEverydayNearLimit: {
    summary: 'Old default for the plan guard; new projects now leave it automatic.',
    surface: 'none',
    control: 'deprecated'
  },
  defaultPreferSonnetNearLimit: {
    summary: 'Older name of the same plan guard default, kept in step for old code.',
    surface: 'none',
    control: 'deprecated'
  },
  communityPrices: {
    summary: 'Use a community price list for models with no built-in price. On unless turned off.',
    surface: 'app-settings-connections-costs',
    control: 'user',
    proposable: true
  },
  defaultAutoContinue: {
    summary: 'Whether new projects keep going until the plan is complete. No screen shows it yet.',
    surface: 'none',
    control: 'user',
    proposable: true
  },
  defaultMaxAutoContinues: {
    summary: 'The most automatic continues per run for new projects. No screen shows it yet.',
    surface: 'none',
    control: 'user',
    proposable: true
  },
  modelPrices: {
    summary: 'Your own per-model prices; they win over every other price source.',
    surface: 'app-settings-connections-model-prices',
    control: 'user'
  },
  terminalServer: {
    summary: 'Terminal access: whether terminal clients such as the orgai command may connect.',
    surface: 'app-settings-general-terminal',
    control: 'user'
  },
  terminalAccessLevel: {
    summary: 'What terminal clients may do: read and operate by default, or Full to also decide and configure.',
    surface: 'app-settings-general-terminal',
    control: 'user'
  },
  terminalServerChosen: {
    summary: 'Whether you chose the Terminal access value yourself, so a background host does not override it.',
    surface: 'none',
    control: 'main'
  }
}

export const PROJECT_SETTING_DOCS: Readonly<Record<keyof Project, AtlasSettingDoc>> = {
  id: { summary: 'The project\'s stable id.', surface: 'none', control: 'main' },
  name: { summary: 'The project\'s name.', surface: 'project-settings-general', control: 'user' },
  path: { summary: 'The working directory agents operate in.', surface: 'project-settings-general', control: 'user' },
  kind: {
    summary: 'Code or Engagement, chosen when the project is created.',
    surface: 'dashboard-new-project',
    control: 'user'
  },
  referenceDirectories: {
    summary: 'Folders agents may read but never change.',
    surface: 'project-settings-reference-folders',
    control: 'user'
  },
  folderConfigTrust: {
    summary: 'Whether the folder\'s own agent settings may load; set by OrgAI and changed by reviewing them.',
    surface: 'project-settings-folder-trust',
    control: 'main'
  },
  client: {
    summary: 'Engagements: who the work is for, used to group projects.',
    surface: 'project-settings-general',
    control: 'user',
    proposable: true
  },
  allowedDirectories: {
    summary: 'Extra folders agents may read and edit like the project folder.',
    surface: 'project-settings-allowed-folders',
    control: 'user'
  },
  brief: {
    summary: 'Free text describing the project and its work.',
    surface: 'project-settings-general',
    control: 'user',
    proposable: true
  },
  provider: {
    summary: 'Which connection and models the project runs on.',
    surface: 'project-settings-connection',
    control: 'user'
  },
  permissionMode: {
    summary: 'How much agents may do without asking.',
    surface: 'project-settings-permissions',
    control: 'user',
    proposable: true
  },
  maxBudgetUsd: {
    summary: 'Estimated-cost cap per run; unset means no cap.',
    surface: 'project-settings-limits',
    control: 'user',
    proposable: true
  },
  maxSubagentDepth: {
    summary: 'How many levels of reports may spawn their own; automatic from the org chart unless set.',
    surface: 'project-settings-limits',
    control: 'user',
    proposable: true
  },
  maxConcurrentSubagents: {
    summary: 'The most reports running at once; automatic unless set.',
    surface: 'project-settings-limits',
    control: 'user',
    proposable: true
  },
  isolateWriters: {
    summary: 'Run file-editing reports in their own git worktrees and merge them back.',
    surface: 'project-settings-permissions',
    control: 'user',
    proposable: true
  },
  reviewMerges: {
    summary: 'Pause to review each worktree\'s diff before it merges.',
    surface: 'project-settings-permissions',
    control: 'user',
    proposable: true
  },
  keepRuns: { summary: 'How many runs to keep on disk.', surface: 'project-settings-limits', control: 'user' },
  maxWindowShare: {
    summary: 'Subscription plans: stop a run at this share of the five-hour window.',
    surface: 'project-settings-limits',
    control: 'user'
  },
  preferEverydayNearLimit: {
    summary: 'Plan guard: Automatic, On or Off.',
    surface: 'project-settings-plan-guard',
    control: 'user'
  },
  preferSonnetNearLimit: {
    summary: 'Older name of the plan guard setting.',
    surface: 'none',
    control: 'deprecated'
  },
  autoContinue: {
    summary: 'Keep going until the plan is complete.',
    surface: 'project-settings-permissions',
    control: 'user',
    proposable: true
  },
  maxAutoContinues: {
    summary: 'The most automatic continues per run.',
    surface: 'project-settings-permissions',
    control: 'user',
    proposable: true
  },
  runMessaging: {
    summary: 'Let this project\'s runs message other runs; on for code projects, off for engagements unless set.',
    surface: 'project-settings-permissions',
    control: 'user'
  },
  knowledgeAutoContext: {
    summary: 'Engagements: add known knowledge items to what agents receive.',
    surface: 'project-settings-context-notes',
    control: 'user'
  },
  roles: { summary: 'The org chart\'s roles.', surface: 'project-team', control: 'user' },
  mcpServers: {
    summary: 'The MCP servers and connected services this project\'s roles may use.',
    surface: 'project-team-catalog-connections',
    control: 'user'
  },
  plugins: { summary: 'Plugins loaded for this project\'s runs.', surface: 'project-team-catalog-plugins', control: 'user' },
  skills: { summary: 'The skills this project\'s roles may be granted.', surface: 'project-team-catalog-skills', control: 'user' },
  skillEvaluation: {
    summary: 'Whether the model step of skill evaluation runs; follows the Team assistant setting unless set.',
    surface: 'project-settings-team-assistant',
    control: 'user'
  },
  teamReview: {
    summary: 'The Team assistant\'s mode: off, free checks or AI suggestions.',
    surface: 'project-settings-team-assistant',
    control: 'user'
  },
  setup: { summary: 'The state of the setup interview and the saved architecture file.', surface: 'project-settings-maintenance', control: 'main' },
  createdAt: { summary: 'When the project was created.', surface: 'none', control: 'main' },
  updatedAt: { summary: 'When the project was last saved.', surface: 'none', control: 'main' }
}

export const MENU_ACTION_DOCS: Readonly<Record<MenuAction, string>> = {
  'new-project': 'File > New project: opens the New project dialog.',
  'new-chat': 'File > New chat: opens a fresh Chat start page.',
  'open-chat': 'File > Assistants > Chat: opens Chat, or the Chat run that needs you.',
  'open-mcp-assistant': 'File > Assistants > MCP assistant: opens the MCP assistant.',
  'open-skill-assistant': 'File > Assistants > Skill assistant: opens the Skill assistant.',
  'new-run': 'Run > New run: opens a new run page in the current project.',
  'interrupt-run': 'Run > Interrupt turn: stops the shown run\'s current turn without ending the session.',
  'end-session': 'Run > End session: ends the shown run\'s session.',
  'org-retrospective': 'Run > Org retrospective: asks the Architect to review how the team worked in the shown run.',
  'show-live': 'View > Live: shows the project\'s Live tab.',
  'show-history': 'View > History: shows the project\'s History tab.',
  'show-team': 'View > Team: shows the project\'s Team tab.',
  'show-project-settings': 'View > Project settings: shows the project\'s Settings tab.',
  'open-app-settings': 'File > App settings: opens App settings on General.',
  'open-connections': 'File > Connections: opens App settings on Connections.',
  'open-connectors': 'File > Connectors: opens App settings on Connectors.',
  'open-skill-library': 'File > Skill library: opens App settings on the Skill library.',
  'open-about': 'Help > About OrgAI: opens App settings on About.',
  'toggle-sidebar': 'View > Toggle sidebar: collapses or expands the sidebar.',
  'toggle-hide-finished': 'View > Canvas > Hide finished agents: folds finished agents on the live canvas.',
  'canvas-fit': 'View > Canvas > Fit canvas: fits the canvas to the window.',
  'keyboard-shortcuts': 'Help > Keyboard shortcuts: opens the shortcuts dialog.',
  'close-tab': 'File > Close tab: closes the shown run tab.',
  'go-to-decision': 'Run > Go to decision: jumps to the open decision card.',
  'show-needs-you': 'Run > Show what needs you: opens the list of waiting decisions.',
  'toggle-conversation': 'View > Canvas > Show conversation: switches the run between canvas and conversation layout.',
  'save-chat-as-project': 'Run > Save chat as project: turns a Chat run into a project in its folder.',
  'open-run-window': 'Run > Open in new window: shows the run in its own window.',
  'canvas-zoom-in': 'View > Canvas > Zoom in: zooms the live canvas in.',
  'canvas-zoom-out': 'View > Canvas > Zoom out: zooms the live canvas out.',
  'ask-about-orgai': 'Help > Ask OrgAI about itself…: opens Chat ready for a question about the app.'
}
