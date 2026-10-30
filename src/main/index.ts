import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectionEvent, RunEvent } from '@shared/types'
import { IPC } from '@shared/types'
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
import { externalUrl, isTrustedRendererUrl, registerIpc, secureHandle, trustedRenderer } from './ipc'
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

const rendererFile = join(__dirname, '../renderer/index.html')
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL?.trim()
const rendererEntry = developmentRendererUrl || pathToFileURL(rendererFile).href
const rendererTrust = trustedRenderer(rendererEntry)

async function openExternal(raw: string): Promise<void> {
  const url = externalUrl(raw)
  if (!url) throw new Error('Blocked an unsafe external URL.')
  await shell.openExternal(url)
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

function broadcastConnection(event: ConnectionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.connectionsEvent, event)
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
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  notifier?.attach(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch((e) => console.warn((e as Error).message))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererTrust)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererTrust)) event.preventDefault()
  })

  if (developmentRendererUrl) {
    void win.loadURL(rendererEntry)
  } else {
    void win.loadFile(rendererFile)
  }
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
    openExternal
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
    trustedRenderer: rendererTrust
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
    projectName: (projectId) => projects.get(projectId)?.name
  })
  const handle = secureHandle(rendererTrust)
  handle(IPC.appSetNotifications, (_e, enabled: boolean) => notifier?.setEnabled(!!enabled))

  // Plan usage without a run: at boot, every 10 minutes while idle, and on request from the meter.
  const usageMonitor = new UsageMonitor({
    adapter: adapters.claude,
    auth: () => settings.get().providerAuth,
    broadcast,
    liveRuns: () => runManager?.liveRunCount() ?? 0,
    extraProbes: [() => connections.probeCodexUsage()]
  })
  handle(IPC.usageRefresh, () => usageMonitor.refresh())
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
