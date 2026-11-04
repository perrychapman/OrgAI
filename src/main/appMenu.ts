import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { EMPTY_MENU_STATE, IPC, isMenuAction } from '../shared/types'
import type { MenuAction, MenuActionEvent, MenuState } from '../shared/types'
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

  const item = (
    action: MenuAction,
    label: string,
    accelerator?: string,
    rendererHandlesKey = false
  ): MenuItemConstructorOptions => {
    const it: MenuItemConstructorOptions = {
      id: action,
      label,
      enabled: menuItemEnabled(action, state),
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
  isDestroyed(): boolean
  isMinimized?(): boolean
  restore?(): void
  focus?(): void
  show?(): void
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
    once?(event: string, listener: () => void): unknown
  }
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
  'show-needs-you': 'focused',
  'org-retrospective': 'focused',
  'save-chat-as-project': 'focused',
  'open-run-window': 'focused',
  'toggle-conversation': 'focused',
  'toggle-hide-finished': 'focused',
  'canvas-fit': 'focused',
  'canvas-zoom-in': 'focused',
  'canvas-zoom-out': 'focused'
}

export function menuActionTarget(action: MenuAction): 'main' | 'focused' {
  return MENU_ACTION_TARGETS[action]
}

/**
 * Returns the sender the menu uses. 'focused' actions go to the focused live window, else the main window, else the
 * first live window. 'main' actions go to the live unscoped main window (restored when minimized, focused when it was
 * not the focused one); with no main window, `createMain` makes one and the action is sent once it finishes loading.
 * Scope comes only from main's own map. Never sends to a destroyed window and re-checks the action.
 */
export function menuActionSender<W extends WindowLike>(
  getFocused: () => W | null,
  getWindows: () => [W, unknown][],
  createMain?: () => W
): (action: MenuAction) => void {
  const live = (w: WindowLike | null | undefined): w is W => !!w && !w.isDestroyed() && !w.webContents.isDestroyed()
  const deliver = (target: W, action: MenuAction): void => {
    if (!live(target)) return
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
        const created = createMain()
        const go = (): void => {
          try {
            deliver(created, action)
          } catch (e) {
            console.warn(`Could not deliver menu action ${action}: ${(e as Error).message}`)
          }
        }
        if (created.webContents.once) created.webContents.once('did-finish-load', go)
        else go()
        return
      }
      const fallback = focused ?? all[0]?.[0]
      if (fallback) deliver(fallback, action)
    } catch (e) {
      console.warn(`Could not deliver menu action ${String(action)}: ${(e as Error).message}`)
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

// Per-window states, keyed by window id. The focused window's state drives the menu.
const windowStates = new Map<number, MenuState>()
let rebuild: ((state: MenuState) => void) | null = null

/**
 * Stores a window's state (already cleaned) and rebuilds the application menu when that window is the focused one.
 * A window with no state yet counts as EMPTY_MENU_STATE.
 */
export function setMenuState(
  win: { id: number; once?(event: 'closed', listener: () => void): unknown },
  state: MenuState
): void {
  if (!windowStates.has(win.id)) {
    const id = win.id
    win.once?.('closed', () => windowStates.delete(id))
  }
  windowStates.set(win.id, state)
  try {
    if (BrowserWindow.getFocusedWindow()?.id === win.id) rebuild?.(state)
  } catch (e) {
    console.warn(`Could not refresh the application menu: ${(e as Error).message}`)
  }
}

export function installAppMenu(send: (action: MenuAction) => void): void {
  const build = (state: MenuState): void => {
    try {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildMenuTemplate({
            platform: process.platform,
            appName: app.name || 'OrgAI',
            isDev: !app.isPackaged,
            send,
            state,
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
  build(EMPTY_MENU_STATE)
  try {
    app.on('browser-window-focus', (_e, win) => build(windowStates.get(win.id) ?? EMPTY_MENU_STATE))
  } catch (e) {
    console.warn(`Could not watch window focus for the application menu: ${(e as Error).message}`)
  }
}
