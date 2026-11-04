import { useSyncExternalStore } from 'react'
import { EMPTY_MENU_STATE, isMenuAction, isVirtualProjectId, type MenuAction, type MenuState } from '@shared/types'
import { isRunLive, openNewChat, openNewProject, useAppStore, type RunState } from '../store/useAppStore'
import { menuHandlerFor, runMenuAction } from './menuRegistry'
import { offersSaveAsProject } from './assistants'
import { waitingItems } from './needsYou'
import { APP_SETTINGS_PANES, APP_SETTINGS_SECTIONS, requestAppSettingsSection, requestSkillLibrary } from './settingsTarget'
import { toggleSidebar } from './useSidebarCollapsed'

/**
 * The renderer side of the native application menu (docs/design/ux-review-menu.md). `routeMenuAction` is installed
 * once by `useAppMenu`; keyboard handlers reach it through `runMenuAction` (lib/menuRegistry). A screen-local handler
 * (registerMenuHandler) wins; otherwise the store fallback below runs, else the action is announced as not applicable.
 */

type State = ReturnType<typeof useAppStore.getState>
type MenuSource = Pick<State, 'selectedProjectId' | 'view' | 'draftPage' | 'activeRunByProject' | 'runs' | 'projects'>

// ---- tiny external stores (dialog open flag, app-wide announcement) ----

function signal<T>(initial: T): { get(): T; set(v: T): void; subscribe(fn: () => void): () => void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (v) => {
      if (Object.is(v, value)) return
      value = v
      for (const fn of [...listeners]) fn()
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}

const shortcutsSignal = signal(false)
const announceSignal = signal('')

export const openKeyboardShortcuts = (): void => shortcutsSignal.set(true)
export const closeKeyboardShortcuts = (): void => shortcutsSignal.set(false)
export const isKeyboardShortcutsOpen = (): boolean => shortcutsSignal.get()
export function useKeyboardShortcutsOpen(): boolean {
  return useSyncExternalStore(shortcutsSignal.subscribe, shortcutsSignal.get, shortcutsSignal.get)
}
export const currentMenuAnnouncement = (): string => announceSignal.get()
/** The app-wide live region's current text (AppMenuLayer renders it). */
export function useMenuAnnouncement(): string {
  return useSyncExternalStore(announceSignal.subscribe, announceSignal.get, announceSignal.get)
}

// ---- viewed run and menu state ----

/** The run tab on screen: a selected project, view 'run', not the New run page, with a loaded run. */
export function viewedRunOf(s: MenuSource): RunState | undefined {
  const pid = s.selectedProjectId
  if (!pid || s.view !== 'run' || s.draftPage[pid]) return undefined
  const id = s.activeRunByProject[pid]
  return id ? s.runs[id] : undefined
}

/** Any run in the store waits on a decision. */
function anyDecision(runs: Record<string, RunState>): boolean {
  return Object.values(runs).some((r) => !!r.summary.projectId && waitingItems(r).length > 0)
}

/** What the window shows, as the five booleans main needs to grey out menu items. */
export function menuStateFor(s: MenuSource): MenuState {
  const pid = s.selectedProjectId
  const hasProject = !!pid && s.view !== 'projects' && s.view !== 'appSettings' && (isVirtualProjectId(pid) || s.projects.some((p) => p.id === pid))
  const run = hasProject ? viewedRunOf(s) : undefined
  return {
    hasProject,
    hasRun: !!run,
    runLive: !!run && isRunLive(run),
    chatRun: !!run && !isRunLive(run) && offersSaveAsProject(run.summary),
    hasDecision: anyDecision(s.runs)
  }
}

/** True when `b` differs from `a` in any of the five booleans (the hook sends only then). */
export function menuStateChanged(a: MenuState, b: MenuState): boolean {
  return (
    a.hasProject !== b.hasProject || a.hasRun !== b.hasRun || a.runLive !== b.runLive || a.chatRun !== b.chatRun || a.hasDecision !== b.hasDecision
  )
}

export { EMPTY_MENU_STATE }

// ---- announcements ----

let announceTimer: ReturnType<typeof setTimeout> | null = null
let announceClear: ReturnType<typeof setTimeout> | null = null

/**
 * Says why an action did nothing, once per press, politely. With the run tabs on screen it uses their visible
 * status line (`setTabNotice`); elsewhere the app-wide sr-only status region, cleared first so a repeat is read again.
 */
export function announceMenu(text: string): void {
  const st = useAppStore.getState()
  if (st.view === 'run' && menuStateFor(st).hasProject) {
    st.setTabNotice(text)
    return
  }
  if (announceTimer) clearTimeout(announceTimer)
  if (announceClear) clearTimeout(announceClear)
  announceSignal.set('')
  announceTimer = setTimeout(() => {
    announceSignal.set(text)
    announceClear = setTimeout(() => announceSignal.set(''), 4000)
  }, 60)
}

// ---- shared actions ----

/** Opens a run in its own window; a failure becomes a notice. */
export function openRunWindow(projectId: string, runId: string): void {
  window.orgai.window
    .openRun({ projectId, runId })
    .catch((err: unknown) =>
      useAppStore
        .getState()
        .setTabNotice(`Could not open a new window: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'unknown error'}`)
    )
}

/** Ctrl/Cmd+W and Window > Close tab: closes the New run page or hides a finished tab; a working run stays. Silent when there is nothing to close. */
export function closeCurrentTab(): void {
  const st = useAppStore.getState()
  const pid = st.selectedProjectId
  if (!pid || st.view !== 'run') return
  const runId = st.draftPage[pid] ? undefined : st.activeRunByProject[pid]
  const run = runId ? st.runs[runId] : undefined
  if (!run) {
    if (st.draftPage[pid]) st.closeDraft()
    return
  }
  if (isRunLive(run)) st.setTabNotice('A working run stays open. End its session first.')
  else st.dismissRun(run.summary.id)
}

function openSettings(target: string): void {
  requestAppSettingsSection(target)
  useAppStore.getState().setView('appSettings')
  window.dispatchEvent(new Event('orgai:settings-section'))
}

function jumpTo(projectId: string, runId: string, item: { key: string; kind: string } | undefined): void {
  void useAppStore
    .getState()
    .jumpToDecision(projectId, runId, item && item.kind !== 'plan' ? item.key : undefined)
    .catch((err: unknown) => console.warn('menu: could not jump to the decision', err))
}

const NO_PROJECT = 'Open a project first.'
const NO_RUN = 'Open a run first.'
const NO_CANVAS = 'Open a run on Live to use the canvas.'

/** The store fallback for one action: returns the sentence to announce when it does not apply. */
function fallback(action: MenuAction): string | void {
  const st = useAppStore.getState()
  const pid = st.selectedProjectId
  const inProject = menuStateFor(st).hasProject
  switch (action) {
    case 'new-project':
      return openNewProject()
    case 'new-chat':
      return void openNewChat()
    case 'open-chat':
      return void st.openAssistant('quick')
    case 'open-mcp-assistant':
      return void st.openAssistant('harness')
    case 'open-skill-assistant':
      return void st.openAssistant('skills')
    case 'new-run':
      if (!pid || !inProject) return NO_PROJECT
      if (st.view !== 'run') st.setView('run')
      st.openDraft()
      st.focusComposer()
      return
    case 'show-live':
    case 'show-history':
      if (!pid || !inProject) return NO_PROJECT
      return st.setView(action === 'show-live' ? 'run' : 'history')
    case 'show-team':
    case 'show-project-settings':
      if (!pid || !inProject) return NO_PROJECT
      if (isVirtualProjectId(pid)) return 'Assistants have no team or settings.'
      return st.setView(action === 'show-team' ? 'team' : 'settings')
    case 'open-app-settings':
      return openSettings(APP_SETTINGS_PANES.general)
    case 'open-connections':
      return openSettings(APP_SETTINGS_SECTIONS.connections)
    case 'open-connectors':
      return openSettings(APP_SETTINGS_PANES.mcpLibrary)
    case 'open-skill-library':
      requestSkillLibrary()
      st.setView('appSettings')
      window.dispatchEvent(new Event('orgai:settings-section'))
      return
    case 'open-about':
      return openSettings(APP_SETTINGS_SECTIONS.about)
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'keyboard-shortcuts':
      return openKeyboardShortcuts()
    case 'close-tab':
      return closeCurrentTab()
    case 'interrupt-run': {
      const run = viewedRunOf(st)
      if (!run) return NO_RUN
      if (run.summary.status !== 'running') return 'This run is not working right now.'
      return void st.interrupt()
    }
    case 'end-session': {
      const run = viewedRunOf(st)
      if (!run) return NO_RUN
      if (!isRunLive(run)) return 'This session has already ended.'
      return void st.stopRun()
    }
    case 'go-to-decision': {
      const runId = pid ? st.activeRunByProject[pid] : undefined
      const run = runId ? st.runs[runId] : undefined
      const first = run ? waitingItems(run)[0] : undefined
      if (!pid || !run || !first) return 'No decision is waiting on this run.'
      return jumpTo(pid, run.summary.id, first)
    }
    case 'show-needs-you': {
      const waiting = Object.values(st.runs)
        .filter((r) => !!r.summary.projectId && waitingItems(r).length > 0)
        .sort((a, b) => a.summary.startedAt - b.summary.startedAt)[0]
      if (!waiting) return 'Nothing needs you right now.'
      return jumpTo(waiting.summary.projectId, waiting.summary.id, waitingItems(waiting)[0])
    }
    case 'org-retrospective':
    case 'save-chat-as-project':
      return 'Not available for this run.'
    case 'open-run-window': {
      const run = viewedRunOf(st)
      if (!run) return NO_RUN
      return openRunWindow(run.summary.projectId, run.summary.id)
    }
    case 'toggle-conversation':
    case 'toggle-hide-finished':
    case 'canvas-fit':
    case 'canvas-zoom-in':
    case 'canvas-zoom-out':
      return NO_CANVAS
  }
}

/** Routes one menu action; ignores unknown names and never throws. */
export function routeMenuAction(action: unknown): void {
  if (!isMenuAction(action)) return
  try {
    const handler = menuHandlerFor(action)
    const said = handler ? handler() : fallback(action)
    if (typeof said === 'string' && said) announceMenu(said)
  } catch (err) {
    console.warn('menu: action failed', action, err)
  }
}

export { runMenuAction }

// ---- keyboard shortcuts table (the dialog reads this one table) ----

export interface ShortcutDef {
  group: 'General' | 'Runs' | 'Canvas'
  label: string
  /** Alternatives; each is the keys pressed together. 'Mod' is Ctrl, or Cmd on a Mac. */
  combos: string[][]
  /** Extra condition, shown as a caption. */
  note?: string
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { group: 'General', label: 'New project', combos: [['Mod', 'N']] },
  { group: 'General', label: 'New chat', combos: [['Mod', 'Shift', 'N']] },
  { group: 'General', label: 'App settings', combos: [['Mod', ',']] },
  { group: 'General', label: 'Collapse or expand the sidebar', combos: [['Mod', 'B']] },
  { group: 'General', label: 'Live, History, Team, Project settings', combos: [['Mod', '1'], ['Mod', '2'], ['Mod', '3'], ['Mod', '4']] },
  { group: 'Runs', label: 'New run', combos: [['Mod', 'T']] },
  { group: 'Runs', label: 'Close tab', combos: [['Mod', 'W']] },
  { group: 'Runs', label: 'Go to decision', combos: [['Mod', '.'], ['Alt', 'D']] },
  { group: 'Runs', label: 'Open the tab menu', combos: [['Shift', 'F10']], note: 'on a focused tab' },
  { group: 'Runs', label: 'Hide a finished tab', combos: [['Delete']], note: 'on a focused tab' },
  { group: 'Canvas', label: 'Zoom in', combos: [['+']], note: 'with the canvas focused' },
  { group: 'Canvas', label: 'Zoom out', combos: [['-']], note: 'with the canvas focused' },
  { group: 'Canvas', label: 'Fit to view', combos: [['0']], note: 'with the canvas focused' }
]

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac/i.test(nav.userAgentData?.platform || nav.platform || '')
}

/** One key's label: Mod becomes Ctrl or Cmd, Alt becomes Option on a Mac. */
export function keyLabel(key: string, mac: boolean): string {
  if (key === 'Mod') return mac ? 'Cmd' : 'Ctrl'
  if (key === 'Alt' && mac) return 'Option'
  return key
}
