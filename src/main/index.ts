import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { RunEvent } from '@shared/types'
import { IPC } from '@shared/types'
import { ProjectStore } from './store/projects'
import { SettingsStore } from './store/settings'
import { RunStore } from './store/runs'
import { RunManager } from './runtime/runManager'
import { ClaudeAdapter } from './runtime/claude'
import { MockAdapter } from './runtime/mock'
import { SetupService } from './setup/service'
import { MaintenanceService } from './maintenance'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { installLogging } from './log'

installLogging()
if (process.platform === 'win32') app.setAppUserModelId('com.orgai.app')

let runManager: RunManager | undefined
let notifier: Notifier | undefined

function broadcast(event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.runEvent, event)
  }
  try {
    notifier?.handle(event)
  } catch (e) {
    console.error('Notification failed:', e)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    title: 'OrgAI',
    // Packaged builds take the icon from the executable; in development use the generated PNG.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())
  notifier?.attach(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const dataDir = join(app.getPath('userData'), 'data')
  const projects = new ProjectStore(dataDir)
  const settings = new SettingsStore(dataDir)
  const runStore = new RunStore(dataDir)
  const setup = new SetupService(projects)
  const keepRunsFor = (projectId: string): number => projects.get(projectId)?.keepRuns ?? DEFAULT_KEEP_RUNS
  // The scripted mock adapter (no tokens) is opt-in; a project uses it only when its provider.id is "mock".
  const adapters = { claude: new ClaudeAdapter(), ...(process.env.ORGAI_MOCK === '1' ? { mock: new MockAdapter() } : {}) }
  runManager = new RunManager(adapters, broadcast, runStore, setup, keepRunsFor)
  registerIpc(projects, runManager, setup, new MaintenanceService(projects), settings)
  notifier = new Notifier({
    projectOfRun: (runId) => {
      const summary = runManager?.summaryOf(runId)
      return summary ? { projectId: summary.projectId, kind: summary.kind } : undefined
    },
    projectName: (projectId) => projects.get(projectId)?.name
  })
  ipcMain.handle(IPC.appSetNotifications, (_e, enabled: boolean) => notifier?.setEnabled(!!enabled))

  // Housekeeping: runs of projects that no longer exist, runs past retention, record files nobody indexes.
  const knownProjects = new Set(projects.list().map((p) => p.id))
  let dropped = 0
  for (const projectId of new Set(runStore.allProjectIds())) if (!knownProjects.has(projectId)) dropped += runStore.removeProject(projectId)
  dropped += runStore.prune(keepRunsFor)
  dropped += runStore.sweepOrphans()
  if (dropped) console.log(`Housekeeping removed ${dropped} stale run(s) or record file(s).`)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void runManager?.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
