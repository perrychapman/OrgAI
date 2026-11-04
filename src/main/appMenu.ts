import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { IPC, isMenuAction } from '../shared/types'
import type { MenuAction, MenuActionEvent } from '../shared/types'
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
  /** Closes the focused window (Window > Close window on win32 / linux). */
  closeWindow?: () => void
}

/**
 * The application menu for every platform. Pure: nothing here calls electron, click handlers call the injected
 * functions. Renderer-routed items are built by `item()` so `id === action` always holds.
 *
 * Accelerators: the renderer already handles Ctrl+B, Ctrl+Shift+N and Ctrl+T itself, so on win32 / linux those items
 * set `registerAccelerator: false` (the hint is shown, the key is not consumed; Playwright keyboard.press keeps
 * working). On darwin the native menu consumes key equivalents, so the flag is left at its default there.
 * There is deliberately no Ctrl/Cmd+W anywhere: RunTabs.tsx swallows it. Electron's `close` role carries a default
 * CmdOrCtrl+W, so Window > Close window is a plain item with no accelerator, and darwin has no close item.
 */
export function buildMenuTemplate(opts: MenuTemplateOptions): MenuItemConstructorOptions[] {
  const mac = opts.platform === 'darwin'
  const { send } = opts

  const item = (
    action: MenuAction,
    label: string,
    accelerator?: string,
    rendererHandlesKey = false
  ): MenuItemConstructorOptions => {
    const it: MenuItemConstructorOptions = { id: action, label, click: () => send(action) }
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
      ...(mac ? [] : [item('open-app-settings', 'App settings', 'CmdOrCtrl+,')]),
      item('open-connections', 'Connections'),
      item('open-connectors', 'Connectors'),
      item('open-skill-library', 'Skill library'),
      ...(mac ? [] : [sep, { role: 'quit' } as MenuItemConstructorOptions])
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
      item('show-live', 'Live'),
      item('show-history', 'History'),
      item('show-team', 'Team'),
      item('show-project-settings', 'Project settings'),
      sep,
      item('toggle-sidebar', 'Toggle sidebar', 'CmdOrCtrl+B', true),
      item('toggle-hide-finished', 'Hide finished agents'),
      item('canvas-fit', 'Fit canvas'),
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
      item('interrupt-run', 'Interrupt'),
      item('end-session', 'End session'),
      sep,
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
      sep,
      item('open-about', 'About OrgAI')
    ]
  }

  return [...appMenu, file, edit, view, run, windowMenu, help]
}

interface WindowLike {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

/**
 * Returns the sender the menu uses: the focused window if it is alive, else the first live window. Never sends to a
 * destroyed window, does nothing without one, and re-checks the action.
 */
export function menuActionSender(
  getFocused: () => BrowserWindow | null,
  getAll: () => BrowserWindow[]
): (action: MenuAction) => void {
  const live = (w: WindowLike | null | undefined): w is WindowLike => !!w && !w.isDestroyed() && !w.webContents.isDestroyed()
  return (action) => {
    if (!isMenuAction(action)) return
    try {
      const focused = getFocused() as WindowLike | null
      const target = live(focused) ? focused : (getAll() as WindowLike[]).find((w) => live(w))
      if (!target) return
      const payload: MenuActionEvent = { action }
      target.webContents.send(IPC.menuAction, payload)
    } catch (e) {
      console.warn(`Could not deliver menu action ${String(action)}: ${(e as Error).message}`)
    }
  }
}

export function installAppMenu(send: (action: MenuAction) => void): void {
  try {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          platform: process.platform,
          appName: app.name || 'OrgAI',
          isDev: !app.isPackaged,
          send,
          openExternal: (url) => {
            shell.openExternal(url).catch((e: Error) => console.warn(`Could not open ${url}: ${e.message}`))
          },
          openLogs: () => {
            shell
              .openPath(logsDir())
              .then((err) => {
                if (err) console.warn(`Could not open the logs folder: ${err}`)
              })
              .catch((e: Error) => console.warn(`Could not open the logs folder: ${e.message}`))
          },
          closeWindow: () => BrowserWindow.getFocusedWindow()?.close()
        })
      )
    )
  } catch (e) {
    console.warn(`Could not install the application menu: ${(e as Error).message}`)
  }
}
