import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, ConnectionEvent, FocusRunTarget, McpLibraryInfo, RunEvent } from '@shared/types'
import { HARNESS_PROJECT_ID, IPC, runWindowHash } from '@shared/types'
import { appUrlMatcher, isExternalWebUrl, scopedWindow, shouldBlockNavigation } from './windowScope'
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
import { harnessProject } from './mcp/assist'
import { McpLibraryStore } from './store/mcpLibrary'
import { applyShellPath } from './shellEnv'
import { installAppMenu } from './appMenu'
import { MockAdapter } from './runtime/mock'
import { SetupService } from './setup/service'
import { MaintenanceService } from './maintenance'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { dataDirOverride, installLogging } from './log'
import { buildSettingsInfo, windowBackground } from './appInfo'

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
let settingsStore: SettingsStore | undefined

/** Native menus, scrollbars, dialogs and prefers-color-scheme in the renderer follow AppSettings.appearance.theme. */
function applyTheme(s: AppSettings): void {
  if (nativeTheme.themeSource !== s.appearance.theme) nativeTheme.themeSource = s.appearance.theme
}

/** Every window hears about a save, so a second window and the deprecated notifications mirror stay in step. */
function broadcastSettings(s: AppSettings): void {
  if (!settingsStore) return
  const info = buildSettingsInfo(s, { dataDir: settingsStore.dataDir, appVersion: app.getVersion() })
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, info)
  }
}

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

function broadcastMcpLibrary(entries: McpLibraryInfo[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.mcpLibraryChanged, entries)
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

/** URL schemes already logged as refused by the window-open handler; each is logged once. */
const refusedSchemes = new Set<string>()

function refuseExternal(url: string): void {
  let scheme = 'invalid'
  try {
    scheme = new URL(url).protocol
  } catch {
    // keep 'invalid'
  }
  if (refusedSchemes.has(scheme)) return
  refusedSchemes.add(scheme)
  console.warn(`Refused to open a ${scheme} link outside the app; only http and https links open in the browser.`)
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
    backgroundColor: windowBackground(settingsStore?.get().appearance.theme ?? 'dark', nativeTheme.shouldUseDarkColors),
    title: 'OrgAI',
    // Packaged builds take the icon from the executable; in development use the generated PNG.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // The preload is built as an ES module (index.mjs, package.json "type": "module"), which Electron cannot load
      // in a sandboxed renderer. It uses only contextBridge and ipcRenderer, so a CommonJS preload could run sandboxed
      // (see Risks in .orgai/ARCHITECTURE.md).
      sandbox: false,
      contextIsolation: true
    }
  })

  windowScopes.set(win, scope)
  win.on('closed', () => windowScopes.delete(win))
  win.on('ready-to-show', () => win.show())
  notifier?.attach(win)
  // window.open and target=_blank never create a window: http(s) links go to the user's browser, anything else
  // (file:, custom protocols, javascript:) is refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    else refuseExternal(url)
    return { action: 'deny' }
  })
  // The window never leaves the app's own renderer. In-page navigations (location.hash, so the #/run/... routes)
  // do not fire will-navigate (Electron docs), and a reload is not a navigation, so they are unaffected.
  const isAppUrl = appUrlMatcher(process.env.ELECTRON_RENDERER_URL, pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  // The same guard covers frame navigations, so an iframe cannot be pointed elsewhere either. It fails closed.
  const guard = (e: { url: string; isMainFrame?: boolean; preventDefault(): void }): void => {
    if (!shouldBlockNavigation(isAppUrl, e.url, e.isMainFrame ?? true)) return
    e.preventDefault()
    console.warn(`Blocked a navigation away from the app to ${String(e.url).slice(0, 200)}`)
  }
  win.webContents.on('will-navigate', guard)
  win.webContents.on('will-redirect', guard)
  win.webContents.on('will-frame-navigate', guard)

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
  settingsStore = settings
  applyTheme(settings.get())
  settings.onChange((s) => {
    applyTheme(s)
    broadcastSettings(s)
  })
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
  const mockAdapter = process.env.ORGAI_MOCK === '1'
  /** The virtual project of harness-level runs (library MCP assistant), from the current settings. */
  const harness = () => harnessProject(settings.get(), dataDir, { mock: mockAdapter })
  const projectOrHarness = (projectId: string) => (projectId === HARNESS_PROJECT_ID ? harness() : projects.get(projectId))
  const mcp = new McpService({
    projects,
    secrets,
    library: new McpLibraryStore(dataDir),
    openExternal: (url) => shell.openExternal(url),
    onLibraryChanged: broadcastMcpLibrary,
    // Library changes that save a project (unlink on remove, promote) reach every window like a run's project update.
    onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project })
  })
  const setup = new SetupService(projects, {
    removeMcpSecrets: (projectId, serverId) => mcp.removeServerSecrets(projectId, serverId),
    mcp: {
      libraryEntries: () => mcp.libraryEntries(),
      applyProposal: (projectId, payload) => mcp.applyProposal(projectId, payload),
      applyLibraryProposal: (payload) => mcp.applyLibraryProposal(payload)
    }
  })
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
    ...(mockAdapter ? { mock: new MockAdapter() } : {})
  }
  runManager = new RunManager(adapters, broadcast, runStore, setup, keepRunsFor, {
    resolveProject: (projectId) => projectOrHarness(projectId),
    opusGuardThreshold: () => settings.get().opusGuardThreshold,
    catalog: () => connections.catalog(),
    resolveConnection: (project, choice) => connections.runConnection(project, choice),
    fastModel: (_project, choice) => connections.fastModel(choice),
    mcp: {
      enabledServers: (project) => mcp.enabledServers(project),
      resolve: (projectId, spec, extra) => mcp.resolve(projectId, spec, extra),
      persistInstall: (projectId, spec, values, scope) => mcp.persistInstall(projectId, spec, values, scope),
      withLibrary: (project) => mcp.withLibrary(project),
      prepareForRun: (projectId, specs) => mcp.prepareForRun(projectId, specs),
      libraryEntries: () => mcp.libraryEntries(),
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
    harnessProject: harness,
    openRunWindow
  })
  connections.init()
  app.on('before-quit', () => connections.dispose())
  notifier = new Notifier({
    projectOfRun: (runId) => {
      const summary = runManager?.summaryOf(runId)
      if (!summary) return undefined
      const project = projectOrHarness(summary.projectId)
      return { projectId: summary.projectId, kind: summary.kind, autoContinue: project?.autoContinue !== false, maxAutoContinues: project?.maxAutoContinues }
    },
    projectName: (projectId) => projectOrHarness(projectId)?.name,
    windows: liveWindowScopes,
    // AppSettings.notifications is the single source of truth, read fresh at every decision.
    enabled: () => settings.get().notifications !== false
  })

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
  const knownProjects = new Set([...projects.list().map((p) => p.id), HARNESS_PROJECT_ID])
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
