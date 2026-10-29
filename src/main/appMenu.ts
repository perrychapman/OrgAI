import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * The macOS application menu. Electron on macOS has no default Edit menu, and Cmd+C / V / A / Z work only through
 * menu roles, so without this the text fields cannot copy or paste. Other platforms keep the hidden menu bar
 * (BrowserWindow autoHideMenuBar) exactly as before. Call once after app is ready, before the first window.
 */
export function buildMacMenuTemplate(appName: string, isDev: boolean): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    ...(isDev ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    { label: 'View', submenu: view },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]
}

export function installAppMenu(): void {
  if (process.platform !== 'darwin') return
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacMenuTemplate(app.name || 'OrgAI', !app.isPackaged)))
  } catch (e) {
    console.warn(`Could not install the application menu: ${(e as Error).message}`)
  }
}
