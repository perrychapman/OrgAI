/**
 * Where an agent's open_in_app lands (docs/design/self-help.md). Main sends AppNavigateEvent { surfaceId, projectId?,
 * runId, agentLabel } to the main window; `navigationFor` turns it into a plan (pure, unit-tested) that
 * lib/useAppNavigate.ts performs through the store and the existing deep links, then announces.
 *
 * Every atlas surface has one entry in SURFACE_TARGETS (a total Record, so a new surface without a target fails
 * typecheck). Menu surfaces are not navigable: the plan only names the menu path.
 */
import type { AppNavigateEvent, ProjectKind, VirtualProjectId } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import {
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  PROJECT_SETTINGS_PANES,
  PROJECT_SETTINGS_SECTIONS,
  atlasSurface,
  isAtlasSurfaceId,
  type AtlasSurfaceId,
  type ProjectSettingsPane,
  type ProjectSettingsSection
} from '@shared/view/atlas'

export type ProjectViewId = 'run' | 'history' | 'knowledge' | 'team' | 'settings'
export type RunSideTab = 'transcript' | 'usage' | 'knowledge'

export type NavTarget =
  | { kind: 'dashboard'; newProject?: true }
  /** App settings: `target` is a pane or section id (requestAppSettingsSection); `advanced` opens that disclosure first. */
  | { kind: 'app'; target: string; advanced?: 'app-general' | 'app-connections' }
  | {
      kind: 'project'
      view: ProjectViewId
      /** Settings pane to show (view 'settings'). */
      pane?: ProjectSettingsPane
      /** Section deep link inside the pane (requestProjectSettingsSection). */
      section?: ProjectSettingsSection
      /** The pane's Advanced disclosure to open. */
      advanced?: 'project-permissions' | 'project-limits'
      /** Open the New run page. */
      draft?: true
    }
  | { kind: 'assistant'; id: VirtualProjectId }
  /** A part of the run view: the project's Live view (or the asking run when no project is given). */
  | { kind: 'run'; sideTab?: RunSideTab; composer?: true }
  | { kind: 'shell'; what: 'sidebar' | 'needs-you' | 'account' | 'shortcuts' }
  | { kind: 'menu' }

const app = (target: string, advanced?: 'app-general' | 'app-connections'): NavTarget => ({ kind: 'app', target, ...(advanced ? { advanced } : {}) })
const proj = (view: ProjectViewId, extra: Omit<Extract<NavTarget, { kind: 'project' }>, 'kind' | 'view'> = {}): NavTarget => ({ kind: 'project', view, ...extra })
const settings = (pane: ProjectSettingsPane, section?: ProjectSettingsSection, advanced?: 'project-permissions' | 'project-limits'): NavTarget =>
  proj('settings', { pane, ...(section ? { section } : {}), ...(advanced ? { advanced } : {}) })

/** One target per atlas surface. */
export const SURFACE_TARGETS: Readonly<Record<AtlasSurfaceId, NavTarget>> = {
  dashboard: { kind: 'dashboard' },
  'dashboard-new-project': { kind: 'dashboard', newProject: true },
  'dashboard-new-project-github': { kind: 'dashboard', newProject: true },
  'dashboard-new-project-template': { kind: 'dashboard', newProject: true },
  'dashboard-new-project-import': { kind: 'dashboard', newProject: true },
  'dashboard-needs-you': { kind: 'dashboard' },
  'app-sidebar': { kind: 'shell', what: 'sidebar' },
  'app-needs-you': { kind: 'shell', what: 'needs-you' },
  'app-account': { kind: 'shell', what: 'account' },
  'app-keyboard-shortcuts': { kind: 'shell', what: 'shortcuts' },
  'project-live': proj('run'),
  'project-new-run': proj('run', { draft: true }),
  'project-history': proj('history'),
  'project-history-runs': proj('history'),
  'project-history-trends': proj('history'),
  'project-knowledge': proj('knowledge'),
  'project-knowledge-list': proj('knowledge'),
  'project-knowledge-graph': proj('knowledge'),
  'project-team': proj('team'),
  'project-team-catalog': proj('team'),
  'project-team-catalog-skills': proj('team'),
  'project-team-catalog-connections': proj('team'),
  'project-team-catalog-plugins': proj('team'),
  'project-team-templates': proj('team'),
  'project-team-import': proj('team'),
  'project-team-assistant': proj('team'),
  'project-settings-general': settings(PROJECT_SETTINGS_PANES.general),
  'project-settings-connection': settings(PROJECT_SETTINGS_PANES.general, PROJECT_SETTINGS_SECTIONS.connection),
  'project-settings-engagement-plan': settings(PROJECT_SETTINGS_PANES.general, PROJECT_SETTINGS_SECTIONS.engagementPlan),
  'project-settings-context-notes': settings(PROJECT_SETTINGS_PANES.general, PROJECT_SETTINGS_SECTIONS.contextNotes),
  'project-settings-permissions': settings(PROJECT_SETTINGS_PANES.permissions, PROJECT_SETTINGS_SECTIONS.permissions),
  'project-settings-allowed-folders': settings(PROJECT_SETTINGS_PANES.permissions, PROJECT_SETTINGS_SECTIONS.allowedFolders),
  'project-settings-reference-folders': settings(PROJECT_SETTINGS_PANES.permissions, PROJECT_SETTINGS_SECTIONS.allowedFolders),
  'project-settings-rules': settings(PROJECT_SETTINGS_PANES.permissions, PROJECT_SETTINGS_SECTIONS.rules),
  'project-settings-folder-trust': settings(PROJECT_SETTINGS_PANES.permissions),
  'project-settings-team-assistant': settings(PROJECT_SETTINGS_PANES.permissions, PROJECT_SETTINGS_SECTIONS.teamAssistant),
  'project-settings-limits': settings(PROJECT_SETTINGS_PANES.limits),
  'project-settings-plan-guard': settings(PROJECT_SETTINGS_PANES.limits, undefined, 'project-limits'),
  'project-settings-maintenance': settings(PROJECT_SETTINGS_PANES.maintenance),
  'app-settings-general': app(APP_SETTINGS_PANES.general),
  'app-settings-general-appearance': app(APP_SETTINGS_SECTIONS.appearance),
  'app-settings-general-notifications': app(APP_SETTINGS_SECTIONS.notifications),
  'app-settings-general-canvas': app(APP_SETTINGS_SECTIONS.canvas),
  'app-settings-general-new-projects': app(APP_SETTINGS_SECTIONS.newProjects),
  'app-settings-general-motion': app(APP_SETTINGS_PANES.general, 'app-general'),
  'app-settings-general-assistant-models': app(APP_SETTINGS_SECTIONS.assistantModels),
  'app-settings-general-new-projects-advanced': app(APP_SETTINGS_PANES.general, 'app-general'),
  'app-settings-general-terminal': app(APP_SETTINGS_PANES.general, 'app-general'),
  'app-settings-connections': app(APP_SETTINGS_PANES.connections),
  'app-settings-connections-proxies': app(APP_SETTINGS_PANES.connections),
  'app-settings-connections-costs': app(APP_SETTINGS_SECTIONS.costs),
  'app-settings-connections-model-prices': app(APP_SETTINGS_SECTIONS.modelPrices),
  'app-settings-connectors': app(APP_SETTINGS_PANES.mcpLibrary),
  'app-settings-connectors-custom': app(APP_SETTINGS_SECTIONS.mcpLibrary),
  'app-settings-skill-library': app(APP_SETTINGS_SECTIONS.skillLibrary),
  'app-settings-kit': app(APP_SETTINGS_PANES.kit),
  'app-settings-kit-templates': app(APP_SETTINGS_SECTIONS.templates),
  'app-settings-about': app(APP_SETTINGS_SECTIONS.about),
  'chat-start': { kind: 'assistant', id: 'quick' },
  'mcp-assistant-start': { kind: 'assistant', id: 'harness' },
  'skill-assistant-start': { kind: 'assistant', id: 'skills' },
  'run-strip': { kind: 'run' },
  'run-toolbar': { kind: 'run' },
  'run-canvas-style': { kind: 'run' },
  'run-legend': { kind: 'run' },
  'run-side-panel': { kind: 'run', sideTab: 'transcript' },
  'run-transcript': { kind: 'run', sideTab: 'transcript' },
  'run-usage': { kind: 'run', sideTab: 'usage' },
  'run-knowledge': { kind: 'run', sideTab: 'knowledge' },
  'run-decision-tray': { kind: 'run' },
  'run-composer': { kind: 'run', composer: true },
  'run-conversation': { kind: 'run' },
  'menu-file': { kind: 'menu' },
  'menu-view': { kind: 'menu' },
  'menu-run': { kind: 'menu' },
  'menu-help': { kind: 'menu' }
}

/** What the window knows when the event arrives. */
export interface NavigationState {
  projects: readonly { id: string; name: string; kind?: ProjectKind }[]
  /** The asking run's project when the run is loaded (a virtual id for Chat and the assistants). */
  runProjectId?: string
}

export type NavigationPlan =
  | {
      ok: true
      target: NavTarget
      /** The project to select (project and run targets); absent for app-wide targets. */
      projectId?: string
      /** The breadcrumb with "Project" replaced by the project's name ("Notes API › Settings › Limits"). */
      path: string
      /** The visible banner and the announcement: "<agent> opened <path> for you." */
      message: string
      /** data-testid values of the surface (scrolled to after landing when nothing else took focus). */
      testIds: readonly string[]
    }
  | { ok: false; message: string; path?: string }

const SEP = ' › '

/** A plain label: no control or line characters, at most `max` characters. */
export function plainLabel(value: string, max = 80): string {
  const s = Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim())
  return s.length > max ? `${s.slice(0, max - 1).join('')}…` : s.join('')
}

/** The plan for one AppNavigateEvent. Never throws; an unknown surface or project is a refusal sentence. */
export function navigationFor(event: AppNavigateEvent, state: NavigationState): NavigationPlan {
  const who = plainLabel(typeof event?.agentLabel === 'string' ? event.agentLabel : '') || 'The assistant'
  if (!event || !isAtlasSurfaceId(event.surfaceId)) return { ok: false, message: `${who} tried to open a place OrgAI does not know.` }
  const surface = atlasSurface(event.surfaceId)
  const target = SURFACE_TARGETS[event.surfaceId]
  const crumbs = [...surface.path]
  const testIds = surface.testIds ?? []
  if (target.kind === 'menu') {
    const path = crumbs.slice(1).join(SEP) || crumbs.join(SEP)
    return { ok: false, path, message: `${who} pointed you to ${path} in the menu bar.` }
  }
  let projectId: string | undefined
  if (surface.scope === 'project' || surface.scope === 'engagement' || (surface.scope === 'run' && event.projectId !== undefined)) {
    const project = typeof event.projectId === 'string' ? state.projects.find((p) => p.id === event.projectId) : undefined
    if (!project || isVirtualProjectId(project.id)) return { ok: false, message: `${who} tried to open a project this window does not have.` }
    if (surface.scope === 'engagement' && project.kind !== 'engagement') return { ok: false, message: `${who} tried to open a place that only engagements have.` }
    projectId = project.id
    if (crumbs[0] === 'Project') crumbs[0] = plainLabel(project.name, 60) || 'Project'
  } else if (surface.scope === 'run') {
    // No project named: the run view part of the run that asked (a Chat run lives in the Chat assistant).
    projectId = state.runProjectId ?? 'quick'
    if (crumbs[0] === 'Project') crumbs[0] = isVirtualProjectId(projectId) ? 'This conversation' : (state.projects.find((p) => p.id === projectId)?.name ?? 'Project')
  }
  const path = crumbs.join(SEP)
  return { ok: true, target, ...(projectId ? { projectId } : {}), path, message: `${who} opened ${path} for you.`, testIds }
}
