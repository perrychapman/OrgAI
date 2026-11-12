import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { EMPTY_MENU_STATE, IPC, isMenuAction } from '../shared/types'
import type { AppNavigateEvent, MenuAction, MenuActionEvent, MenuState } from '../shared/types'
import { isAtlasSurfaceId } from '../shared/view/atlas'
import { logsDir } from './log'

/** The only URLs the Help menu ever opens. */
export const DOCS_URL = 'https://github.com/perrychapman/OrgAI'
export const ISSUES_URL = 'https://github.com/perrychapman/OrgAI/issues'

export interface MenuTemplateOptions {
  platform: NodeJS.Platform | string
  appName: string
  isDev: boolean
  send: (action: MenuAction) => void
  /** Only ever called with DOCS_URL or ISSUES_URL. */
  openExternal: (url: string) => void
  openLogs: () => void
  /** Opens OrgAI's data folder (Help > Open data folder). Main-only, no renderer involvement. */
  openDataFolder?: () => void
  /** Closes the focused window (Window > Close window on win32 / linux). */
  closeWindow?: () => void
  /** What the focused window shows; decides which items are enabled. Default: nothing open. */
  state?: MenuState
  /** What the main (unscoped) window shows; decides the items routed to 'main'. Default: `state`. */
  mainState?: MenuState
}

/**
 * The enablement rule of every menu action. Pure. Items not listed here are always enabled (new project, new chat,
 * assistants, settings, sidebar, help).
 */
export function menuItemEnabled(action: MenuAction, state: MenuState): boolean {
  switch (action) {
    case 'show-live':
    case 'show-history':
    case 'show-team':
    case 'show-project-settings':
    case 'new-run':
      return state.hasProject
    case 'close-tab':
    case 'open-run-window':
    case 'toggle-conversation':
    case 'toggle-hide-finished':
    case 'canvas-fit':
    case 'canvas-zoom-in':
    case 'canvas-zoom-out':
    case 'org-retrospective':
      return state.hasRun
    case 'interrupt-run':
    case 'end-session':
      return state.runLive
    case 'save-chat-as-project':
      return state.chatRun
    case 'go-to-decision':
    case 'show-needs-you':
      return state.hasDecision
    default:
      return true
  }
}

/** Rebuilds a state from untrusted input: a plain object, each field exactly `true` or false, extra keys dropped. */
export function cleanMenuState(input: unknown): MenuState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ...EMPTY_MENU_STATE }
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return { ...EMPTY_MENU_STATE }
  const o = input as Record<string, unknown>
  return {
    hasProject: o.hasProject === true,
    hasRun: o.hasRun === true,
    runLive: o.runLive === true,
    chatRun: o.chatRun === true,
    hasDecision: o.hasDecision === true
  }
}

/**
 * The application menu for every platform. Pure: nothing here calls electron, click handlers call the injected
 * functions. Renderer-routed items are built by `item()` so `id === action` always holds.
 *
 * Accelerators: the renderer already handles Ctrl+B, Ctrl+Shift+N, Ctrl+T, Ctrl+W and Ctrl+. itself, so on win32 /
 * linux those items set `registerAccelerator: false` (the hint is shown, the key is not consumed; Playwright
 * keyboard.press keeps working). On darwin the native menu consumes key equivalents, so the flag is left at its default
 * there (Cmd+W reaches the menu and sends close-tab). The only W accelerator is close-tab's: Electron's `close` role
 * carries a default CmdOrCtrl+W, so Window > Close window is a plain item with no accelerator, and darwin has no
 * window-closing item.
 */
export function buildMenuTemplate(opts: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const mac = opts.platform === 'darwin'
  const linux = opts.platform === 'linux'
  const { send } = opts
  const state = opts.state ?? EMPTY_MENU_STATE
  const mainState = opts.mainState ?? state

  const item = (
    action: MenuAction,
    label: string,
    accelerator?: string,
    rendererHandlesKey = false
  ): MenuItemConstructorOptions => {
    const it: MenuItemConstructorOptions = {
      id: action,
      label,
      enabled: menuItemEnabled(action, menuActionTarget(action) === 'main' ? mainState : state),
      click: () => send(action)
    }
    if (accelerator) {
      it.accelerator = accelerator
      if (rendererHandlesKey && !mac) it.registerAccelerator = false
    }
    return it
  }
  const sep: MenuItemConstructorOptions = { type: 'separator' }

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: opts.appName,
          submenu: [
            { role: 'about' },
            sep,
            item('open-app-settings', 'Settings…', 'CmdOrCtrl+,'),
            sep,
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            sep,
            { role: 'quit' }
          ]
        }
      ]
    : []

  const quit: MenuItemConstructorOptions = linux ? { role: 'quit', accelerator: 'Ctrl+Q' } : { role: 'quit' }

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      item('new-project', 'New project', 'CmdOrCtrl+N'),
      item('new-chat', 'New chat', 'CmdOrCtrl+Shift+N', true),
      sep,
      {
        label: 'Assistants',
        submenu: [
          item('open-chat', 'Chat'),
          item('open-mcp-assistant', 'MCP assistant'),
          item('open-skill-assistant', 'Skill assistant')
        ]
      },
      sep,
      item('close-tab', 'Close tab', 'CmdOrCtrl+W', true),
      sep,
      ...(mac ? [] : [item('open-app-settings', 'App settings', 'CmdOrCtrl+,')]),
      item('open-connections', 'Connections'),
      item('open-connectors', 'Connectors'),
      item('open-skill-library', 'Skill library'),
      ...(mac ? [] : [sep, quit])
    ]
  }

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' }
    ]
  }

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      item('show-live', 'Live', 'CmdOrCtrl+1'),
      item('show-history', 'History', 'CmdOrCtrl+2'),
      item('show-team', 'Team', 'CmdOrCtrl+3'),
      item('show-project-settings', 'Project settings', 'CmdOrCtrl+4'),
      sep,
      item('show-usage', 'Usage'),
      sep,
      item('toggle-sidebar', 'Toggle sidebar', 'CmdOrCtrl+B', true),
      {
        label: 'Canvas',
        submenu: [
          item('toggle-conversation', 'Show conversation'),
          item('toggle-hide-finished', 'Hide finished agents'),
          sep,
          item('canvas-zoom-in', 'Zoom in'),
          item('canvas-zoom-out', 'Zoom out'),
          item('canvas-fit', 'Fit canvas')
        ]
      },
      sep,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      sep,
      { role: 'togglefullscreen' },
      ...(opts.isDev
        ? ([sep, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
        : [])
    ]
  }

  const run: MenuItemConstructorOptions = {
    label: 'Run',
    submenu: [
      item('new-run', 'New run', 'CmdOrCtrl+T', true),
      item('open-run-window', 'Open in new window'),
      sep,
      item('go-to-decision', 'Go to decision', 'CmdOrCtrl+.', true),
      item('show-needs-you', 'Show what needs you'),
      sep,
      item('interrupt-run', 'Interrupt turn'),
      item('end-session', 'End session'),
      sep,
      item('save-chat-as-project', 'Save chat as project'),
      item('org-retrospective', 'Org retrospective')
    ]
  }

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }]
      : [{ role: 'minimize' }, { label: 'Close window', click: () => opts.closeWindow?.() }]
  }

  const help: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      { label: 'Documentation', click: () => opts.openExternal(DOCS_URL) },
      { label: 'Report an issue', click: () => opts.openExternal(ISSUES_URL) },
      item('keyboard-shortcuts', 'Keyboard shortcuts'),
      item('ask-about-orgai', 'Ask OrgAI about itself…'),
      sep,
      { label: 'Open logs folder', click: () => opts.openLogs() },
      { label: 'Open data folder', click: () => opts.openDataFolder?.() },
      sep,
      item('open-about', 'About OrgAI')
    ]
  }

  return [...appMenu, file, edit, view, run, windowMenu, help]
}

export interface WindowLike {
  id?: number
  isDestroyed(): boolean
  isMinimized?(): boolean
  restore?(): void
  focus?(): void
  show?(): void
  once?(event: 'closed', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

// Per-window menu bookkeeping, keyed by window id. A window is "ready" once its renderer has called menu.setState
// (the renderer does so on mount and on every change), so that first call is the readiness signal. Actions for a
// window that is not ready yet wait in its queue and flush, in order, on that first call.
export const MENU_QUEUE_CAP = 8
const windowStates = new Map<number, MenuState>()
const readyWindows = new Set<number>()
const queues = new Map<number, MenuAction[]>()
// open_in_app navigations waiting for a window's first menu.setState (same readiness signal as menu actions).
const navQueues = new Map<number, AppNavigateEvent[]>()
const tracked = new Set<number>()
let windowAccess: { focusedId: () => number | undefined; mainId: () => number | undefined } | null = null
let rebuild: ((focused: MenuState, main: MenuState) => void) | null = null

const sameState = (a: MenuState, b: MenuState): boolean =>
  a.hasProject === b.hasProject &&
  a.hasRun === b.hasRun &&
  a.runLive === b.runLive &&
  a.chatRun === b.chatRun &&
  a.hasDecision === b.hasDecision

/** Rebuilds the menu from the stored states: the focused window drives run items, the main window the rest. */
function refreshMenu(): void {
  if (!rebuild) return
  try {
    const focusedId = windowAccess?.focusedId() ?? currentFocusedId()
    const mainId = windowAccess?.mainId()
    const focused = (focusedId !== undefined ? windowStates.get(focusedId) : undefined) ?? EMPTY_MENU_STATE
    const main = (mainId !== undefined ? windowStates.get(mainId) : undefined) ?? EMPTY_MENU_STATE
    rebuild(focused, main)
  } catch (e) {
    console.warn(`Could not refresh the application menu: ${(e as Error).message}`)
  }
}

function currentFocusedId(): number | undefined {
  try {
    return BrowserWindow.getFocusedWindow()?.id
  } catch {
    return undefined
  }
}

/** Attaches the one 'closed' cleanup of a window, whether its first touch is a queued action or a state. */
function trackWindow(win: { id: number; once?(event: 'closed', listener: () => void): unknown }): void {
  const id = win.id
  if (tracked.has(id)) return
  tracked.add(id)
  win.once?.('closed', () => {
    windowStates.delete(id)
    readyWindows.delete(id)
    queues.delete(id)
    navQueues.delete(id)
    tracked.delete(id)
    refreshMenu()
  })
}

function enqueue(win: { id: number; once?(event: 'closed', listener: () => void): unknown }, action: MenuAction): void {
  trackWindow(win)
  const q = (queues.get(win.id) ?? []).filter((a) => a !== action)
  q.push(action)
  while (q.length > MENU_QUEUE_CAP) q.shift()
  queues.set(win.id, q)
}

/**
 * Where an action goes. 'main' = navigation (the unscoped main window, created when closed); 'focused' = run actions
 * (the window the user is in, which may be a run window). A Record so a new MenuAction fails typecheck until classified.
 */
const MENU_ACTION_TARGETS: Record<MenuAction, 'main' | 'focused'> = {
  'new-project': 'main',
  'new-chat': 'main',
  'open-chat': 'main',
  'open-mcp-assistant': 'main',
  'open-skill-assistant': 'main',
  'open-app-settings': 'main',
  'open-connections': 'main',
  'open-connectors': 'main',
  'open-skill-library': 'main',
  'open-about': 'main',
  'show-live': 'main',
  'show-history': 'main',
  'show-team': 'main',
  'show-project-settings': 'main',
  'toggle-sidebar': 'main',
  'keyboard-shortcuts': 'main',
  'new-run': 'focused',
  'close-tab': 'focused',
  'interrupt-run': 'focused',
  'end-session': 'focused',
  'go-to-decision': 'focused',
  'show-needs-you': 'main',
  'org-retrospective': 'focused',
  'save-chat-as-project': 'focused',
  'open-run-window': 'focused',
  'toggle-conversation': 'focused',
  'toggle-hide-finished': 'focused',
  'canvas-fit': 'focused',
  'canvas-zoom-in': 'focused',
  'canvas-zoom-out': 'focused',
  'ask-about-orgai': 'main',
  'show-usage': 'main'
}

export function menuActionTarget(action: MenuAction): 'main' | 'focused' {
  return MENU_ACTION_TARGETS[action]
}

/**
 * Returns the sender the menu uses. 'focused' actions go to the focused live window, else the main window, else the
 * first live window. 'main' actions go to the live unscoped main window (restored when minimized, focused when it was
 * not the focused one); with no main window, `createMain` makes one. Delivery to a window waits (queue of at most 8,
 * newest of each action) until its renderer's first menu.setState. Also tells the menu which windows are focused / main.
 * Scope comes only from main's own map. Never sends to a destroyed window and re-checks the action.
 */
export function menuActionSender<W extends WindowLike>(
  getFocused: () => W | null,
  getWindows: () => [W, unknown][],
  createMain?: () => W
): (action: MenuAction) => void {
  const live = (w: WindowLike | null | undefined): w is W => !!w && !w.isDestroyed() && !w.webContents.isDestroyed()
  const idOf = (w: W | null | undefined): number | undefined => (live(w) ? w.id : undefined)
  windowAccess = {
    focusedId: () => idOf(getFocused()),
    mainId: () => idOf(getWindows().find(([w, scope]) => scope === undefined && live(w))?.[0])
  }
  // Delivers at once to a ready, live window; otherwise queues (a window without an id cannot be tracked and gets it now).
  const deliver = (target: W, action: MenuAction): void => {
    if (!live(target)) return
    if (target.id !== undefined && !readyWindows.has(target.id)) {
      enqueue({ id: target.id, once: target.once?.bind(target) }, action)
      return
    }
    const payload: MenuActionEvent = { action }
    target.webContents.send(IPC.menuAction, payload)
  }
  return (action) => {
    if (!isMenuAction(action)) return
    try {
      const all = getWindows().filter(([w]) => live(w))
      const focusedRaw = getFocused()
      const focused = live(focusedRaw) ? focusedRaw : null
      const main = all.find(([, scope]) => scope === undefined)?.[0]
      if (menuActionTarget(action) === 'focused') {
        const target = (focused && all.some(([w]) => w === focused) ? focused : undefined) ?? main ?? all[0]?.[0]
        if (target) deliver(target, action)
        return
      }
      if (main) {
        if (main !== focused) {
          if (main.isMinimized?.()) main.restore?.()
          main.focus?.()
        }
        deliver(main, action)
        return
      }
      if (createMain) {
        // The new window queues the action until its renderer reports ready (first menu.setState).
        deliver(createMain(), action)
        return
      }
      const fallback = focused ?? all[0]?.[0]
      if (fallback) deliver(fallback, action)
    } catch (e) {
      console.warn(`Could not deliver menu action ${String(action)}: ${(e as Error).message}`)
    }
  }
}

/**
 * DesktopHooks.navigate: an agent's open_in_app. Goes to the live unscoped main window only; never creates one (an agent
 * must not reopen a window the user closed: answers false). Focus moves only while OrgAI is already the foreground app
 * (some OrgAI window is focused): then the main window is restored and focused. Otherwise it is never restored or
 * focused, so keystrokes meant for another app never land in OrgAI; it gets `flashFrame(true)` (taskbar / dock
 * attention) and the event is delivered in place (review M2). A window whose renderer has not yet called menu.setState
 * (its readiness signal; React has not mounted before then, so did-finish-load is too early) queues the event (at most
 * MENU_QUEUE_CAP, oldest dropped) and gets it on that first call. The event is re-validated here (known surface id,
 * string fields). Returns false when the event is invalid or no main window is open.
 */
export function navigateSender<W extends WindowLike & { flashFrame?(flag: boolean): void }>(
  getFocused: () => W | null,
  getWindows: () => [W, unknown][]
): (event: AppNavigateEvent) => boolean {
  const live = (w: WindowLike | null | undefined): w is W => !!w && !w.isDestroyed() && !w.webContents.isDestroyed()
  return (event) => {
    try {
      if (!event || typeof event !== 'object' || !isAtlasSurfaceId(event.surfaceId)) return false
      if (typeof event.runId !== 'string' || typeof event.agentLabel !== 'string' || event.agentLabel.length > 80) return false
      if (event.projectId !== undefined && typeof event.projectId !== 'string') return false
      const clean: AppNavigateEvent = {
        surfaceId: event.surfaceId,
        ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
        runId: event.runId,
        agentLabel: event.agentLabel
      }
      const all = getWindows().filter(([w]) => live(w))
      const focusedRaw = getFocused()
      const focused = live(focusedRaw) ? focusedRaw : null
      const main: W | undefined = all.find(([, scope]) => scope === undefined)?.[0]
      if (!live(main)) return false
      if (focused) {
        if (main !== focused) {
          if (main.isMinimized?.()) main.restore?.()
          main.focus?.()
        }
      } else {
        main.flashFrame?.(true)
      }
      if (main.id !== undefined && !readyWindows.has(main.id)) {
        trackWindow({ id: main.id, once: main.once?.bind(main) })
        const q = [...(navQueues.get(main.id) ?? []), clean]
        while (q.length > MENU_QUEUE_CAP) q.shift()
        navQueues.set(main.id, q)
        return true
      }
      main.webContents.send(IPC.appNavigate, clean)
      return true
    } catch (e) {
      console.warn(`Could not deliver app navigation: ${(e as Error).message}`)
      return false
    }
  }
}

/** Opens a Help URL only when it is exactly DOCS_URL or ISSUES_URL; anything else is refused with a warning. */
export function openHelpUrl(url: string, open: (url: string) => void): boolean {
  if (url !== DOCS_URL && url !== ISSUES_URL) {
    console.warn('Refused to open a Help URL that is not one of the two fixed ones.')
    return false
  }
  open(url)
  return true
}

/**
 * Stores a window's state (already cleaned). The first call marks the window ready and flushes its queued actions in
 * order. The menu is rebuilt when the state changed and the window is the focused or the main one; an equal state is a
 * no-op. A window with no state yet counts as EMPTY_MENU_STATE.
 */
export function setMenuState(
  win: {
    id: number
    once?(event: 'closed', listener: () => void): unknown
    isDestroyed?(): boolean
    webContents?: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
  },
  state: MenuState
): void {
  const id = win.id
  trackWindow(win)
  const prev = windowStates.get(id)
  const wasReady = readyWindows.has(id)
  windowStates.set(id, state)
  readyWindows.add(id)
  if (!wasReady) {
    const queued = queues.get(id) ?? []
    queues.delete(id)
    const queuedNav = navQueues.get(id) ?? []
    navQueues.delete(id)
    const wc = win.webContents
    if (wc && !win.isDestroyed?.() && !wc.isDestroyed()) {
      for (const action of queued) {
        try {
          const payload: MenuActionEvent = { action }
          wc.send(IPC.menuAction, payload)
        } catch (e) {
          console.warn(`Could not deliver menu action ${action}: ${(e as Error).message}`)
        }
      }
      for (const event of queuedNav) {
        try {
          wc.send(IPC.appNavigate, event)
        } catch (e) {
          console.warn(`Could not deliver app navigation: ${(e as Error).message}`)
        }
      }
    }
  }
  if (wasReady && prev && sameState(prev, state)) return
  const isFocused = (windowAccess?.focusedId() ?? currentFocusedId()) === id
  if (isFocused || windowAccess?.mainId() === id) refreshMenu()
}

export function installAppMenu(send: (action: MenuAction) => void): void {
  const build = (state: MenuState, mainState: MenuState): void => {
    try {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildMenuTemplate({
            platform: process.platform,
            appName: app.name || 'OrgAI',
            isDev: !app.isPackaged,
            send,
            state,
            mainState,
            openExternal: (url) =>
              openHelpUrl(url, (u) => {
                shell.openExternal(u).catch((e: Error) => console.warn(`Could not open ${u}: ${e.message}`))
              }),
            openLogs: () => {
              shell
                .openPath(logsDir())
                .then((err) => {
                  if (err) console.warn(`Could not open the logs folder: ${err}`)
                })
                .catch((e: Error) => console.warn(`Could not open the logs folder: ${e.message}`))
            },
            // ORGAI_DATA_DIR replaces userData at startup, so this is the data folder in every mode.
            openDataFolder: () => {
              shell
                .openPath(app.getPath('userData'))
                .then((err) => {
                  if (err) console.warn(`Could not open the data folder: ${err}`)
                })
                .catch((e: Error) => console.warn(`Could not open the data folder: ${e.message}`))
            },
            closeWindow: () => BrowserWindow.getFocusedWindow()?.close()
          })
        )
      )
    } catch (e) {
      console.warn(`Could not install the application menu: ${(e as Error).message}`)
    }
  }
  rebuild = build
  build(EMPTY_MENU_STATE, EMPTY_MENU_STATE)
  try {
    app.on('browser-window-focus', (_e, win) => {
      const mainId = windowAccess?.mainId()
      build(
        windowStates.get(win.id) ?? EMPTY_MENU_STATE,
        (mainId !== undefined ? windowStates.get(mainId) : undefined) ?? EMPTY_MENU_STATE
      )
    })
  } catch (e) {
    console.warn(`Could not watch window focus for the application menu: ${(e as Error).message}`)
  }
}
