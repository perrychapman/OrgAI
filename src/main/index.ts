import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionEvent, FocusRunTarget, RunEvent } from '@shared/types'
import { IPC, runWindowHash } from '@shared/types'
import { scopedWindow } from './windowScope'
import { ProjectStore } from './store/projects'
import { SettingsStore } from './store/settings'
import { UsageMonitor } from './usageMonitor'
import { RunStore } from './store/runs'
import { RunManager } from './runtime/runManager'
import { ClaudeAdapter } from './runtime/claude'
import { CodexAdapter } from './runtime/codex'
import type { RunConnection } from './runtime/types'
import { SecretStore } from './store/secrets'
import { ConnectionService } from './connections/service'
import { McpService } from './mcp/service'
import { applyShellPath } from './shellEnv'
import { installAppMenu } from './appMenu'
import { MockAdapter } from './runtime/mock'
import { SetupService } from './setup/service'
import { MaintenanceService } from './maintenance'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { dataDirOverride, installLogging } from './log'

// Before anything reads a path: ORGAI_DATA_DIR (CI, e2e) replaces userData and moves logs under it, so a run never
// touches the real profile or ~/Library/Logs. app.setPath throws for a missing directory, so create it first.
const dataOverride = dataDirOverride()
if (dataOverride) {
  mkdirSync(dataOverride.logs, { recursive: true })
  app.setPath('userData', dataOverride.userData)
  app.setAppLogsPath(dataOverride.logs)
}
// Unpackaged (npm run dev, e2e) the name comes from package.json ("orgai"); on macOS that names ~/Library/Logs/<name>
// and the About entry. userData was fixed by Electron before this runs, so it does not move.
if (!app.isPackaged) app.setName('OrgAI')
installLogging()
// Finder/Dock launches on macOS get a minimal PATH; take the login shell's before anything spawns claude, codex or MCP servers.
applyShellPath()
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

function broadcastConnection(event: ConnectionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.connectionsEvent, event)
  }
}

/**
 * Every open window and its run scope: undefined = a main (unscoped) window, a target = a window opened with
 * window:openRun for that run. Windows share every broadcast; the scope only decides what the renderer shows
 * (it reads location.hash, `#/run/<projectId>/<runId>`, see runWindowHash) and which window a notification focuses.
 */
const windowScopes = new Map<BrowserWindow, FocusRunTarget | undefined>()

/** Live windows with their scopes, for the window pickers in windowScope.ts. */
function liveWindowScopes(): [BrowserWindow, FocusRunTarget | undefined][] {
  return [...windowScopes].filter(([w]) => !w.isDestroyed())
}

function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** window:openRun (already validated): focus the window scoped to this run, or open one. */
function openRunWindow(target: FocusRunTarget): void {
  const existing = scopedWindow(liveWindowScopes(), target.runId)
  if (existing) showWindow(existing)
  else createWindow(target)
}

/**
 * The one window factory. Every window, main or run-scoped, gets the same preload and security settings
 * (contextIsolation, the external-link handler). A run-scoped window loads the renderer with the hash
 * `#/run/<projectId>/<runId>`.
 */
function createWindow(scope?: FocusRunTarget): BrowserWindow {
  const win = new BrowserWindow({
    width: scope ? 1280 : 1440,
    height: scope ? 840 : 920,
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

  windowScopes.set(win, scope)
  win.on('closed', () => windowScopes.delete(win))
  win.on('ready-to-show', () => win.show())
  notifier?.attach(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const hash = scope ? runWindowHash(scope) : ''
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash}`)
  } else {
    // loadFile takes the fragment without its leading '#'.
    void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash: hash.slice(1) } : undefined)
  }
  return win
}

app.whenReady().then(() => {
  const dataDir = join(app.getPath('userData'), 'data')
  const projects = new ProjectStore(dataDir)
  const settings = new SettingsStore(dataDir)
  const runStore = new RunStore(dataDir)
  const secrets = new SecretStore(dataDir, safeStorage)
  const connections = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets,
    broadcast: broadcastConnection,
    openExternal: (url) => shell.openExternal(url)
  })
  const mcp = new McpService({ projects, secrets })
  const setup = new SetupService(projects, { removeMcpSecrets: (projectId, serverId) => mcp.removeServerSecrets(projectId, serverId) })
  const keepRunsFor = (projectId: string): number => projects.get(projectId)?.keepRuns ?? DEFAULT_KEEP_RUNS
  // complete() (org chart drafts) has no project: use the enabled Codex-capable connection, OpenAI first.
  const codexCompletion = (): RunConnection | undefined => {
    const c = settings.get().connections
    const connection = c.openai.enabled ? 'openai' : c.litellm.enabled ? 'litellm' : undefined
    if (!connection) return undefined
    try {
      return connections.runConnection(undefined, { adapter: 'codex', connection, mismatched: [] })
    } catch (e) {
      console.warn(`Codex completion connection unavailable: ${(e as Error).message}`)
      return undefined
    }
  }
  // The scripted mock adapter (no tokens) is opt-in; a project uses it only when its provider.id is "mock".
  const adapters = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter({ completionConnection: codexCompletion }),
    ...(process.env.ORGAI_MOCK === '1' ? { mock: new MockAdapter() } : {})
  }
  runManager = new RunManager(adapters, broadcast, runStore, setup, keepRunsFor, {
    resolveProject: (projectId) => projects.get(projectId),
    opusGuardThreshold: () => settings.get().opusGuardThreshold,
    catalog: () => connections.catalog(),
    resolveConnection: (project, choice) => connections.runConnection(project, choice),
    mcp: {
      enabledServers: (project) => mcp.enabledServers(project),
      resolve: (projectId, spec, extra) => mcp.resolve(projectId, spec, extra),
      persistInstall: (projectId, spec, values) => mcp.persistInstall(projectId, spec, values),
      searchRegistry: (input) => mcp.registrySearch(input)
    }
  })
  registerIpc({
    projects,
    runs: runManager,
    setup,
    maintenance: new MaintenanceService(projects),
    settings,
    connections,
    mcp,
    adapterIds: Object.keys(adapters),
    openRunWindow
  })
  connections.init()
  app.on('before-quit', () => connections.dispose())
  notifier = new Notifier({
    projectOfRun: (runId) => {
      const summary = runManager?.summaryOf(runId)
      if (!summary) return undefined
      const project = projects.get(summary.projectId)
      return { projectId: summary.projectId, kind: summary.kind, autoContinue: project?.autoContinue !== false, maxAutoContinues: project?.maxAutoContinues }
    },
    projectName: (projectId) => projects.get(projectId)?.name,
    windows: liveWindowScopes
  })
  ipcMain.handle(IPC.appSetNotifications, (_e, enabled: boolean) => notifier?.setEnabled(!!enabled))

  // Plan usage without a run: at boot, every 10 minutes while idle, and on request from the meter.
  const usageMonitor = new UsageMonitor({
    adapter: adapters.claude,
    auth: () => settings.get().providerAuth,
    broadcast,
    liveRuns: () => runManager?.liveRunCount() ?? 0,
    extraProbes: [() => connections.probeCodexUsage()]
  })
  ipcMain.handle(IPC.usageRefresh, () => usageMonitor.refresh())
  usageMonitor.start()
  app.on('before-quit', () => usageMonitor.stop())

  // Housekeeping: runs of projects that no longer exist, runs past retention, record files nobody indexes.
  const knownProjects = new Set(projects.list().map((p) => p.id))
  let dropped = 0
  for (const projectId of new Set(runStore.allProjectIds())) if (!knownProjects.has(projectId)) dropped += runStore.removeProject(projectId)
  dropped += runStore.prune(keepRunsFor)
  dropped += runStore.sweepOrphans()
  if (dropped) console.log(`Housekeeping removed ${dropped} stale run(s) or record file(s).`)
  installAppMenu()
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
