import { app, BrowserWindow, dialog, nativeImage, nativeTheme, safeStorage, shell } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, CapabilityProgressEvent, TeamReviewSummary, ConnectionEvent, ConnectionId,FocusRunTarget, McpLibraryInfo, RunEvent, SkillLibraryInfo } from '@shared/types'
import { HARNESS_PROJECT_ID, IPC, QUICK_PROJECT_ID, SKILLS_PROJECT_ID, isVirtualProjectId, runWindowHash } from '@shared/types'
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
import { CommunityPrices } from './connections/communityPrices'
import type { RuntimeAdapter } from './runtime/types'
import { McpService } from './mcp/service'
import { harnessProject } from './mcp/assist'
import { skillsProject } from './skills/assist'
import { QuickRunService, projectPeeks } from './quick/quickRuns'
import { sweepScratchDirs } from './quick/scratch'
import { McpLibraryStore } from './store/mcpLibrary'
import { SkillService } from './skills/service'
import { SkillEvaluationService } from './skills/evaluation'
import { CapabilityService } from './capabilities/service'
import { seedMockHome } from './capabilities/mockHome'
import { applyShellPath } from './shellEnv'
import { installAppMenu, menuActionSender } from './appMenu'
import { MockAdapter } from './runtime/mock'
import { sweepStaleSkillDirs } from './runtime/claudeSkills'
import { SetupService } from './setup/service'
import { MaintenanceService } from './maintenance'
import { registerIpc, harnessProjectFor, withEffectiveDefault, broadcastEngagementChanged } from './ipc'
import { AgentImportService } from './setup/import/importer'
import { TemplateService } from './setup/templates'
import { KitService } from './kit/service'
import { listNotes, orphanRunProjects, readNote, readRetainedRunProjects, saveNote } from './store/projectData'
import { knowledgeStore } from './store/knowledge'
import { Notifier } from './notifications'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { canWriteDir, dataDirOverride, installLogging, log, pickLogsDir } from './log'
import { installElectronLogHooks } from './electronLogHooks'
import { acquireHostOwnership, HostAlreadyRunningError, HostStartingOrBusyError, type HostOwnership } from './host/ownership'
import { buildSettingsInfo, windowBackground } from './appInfo'
import { quitGate } from './quitGate'

// Before anything reads a path: ORGAI_DATA_DIR (CI, e2e) replaces userData and moves logs under it, so a run never
// touches the real profile or ~/Library/Logs. app.setPath throws for a missing directory, so create it first. The
// folder is canonicalized (realpath) so the single-instance lock, the data dir and the host's run/ folder always
// name it one way (macOS /var vs /private/var, a symlinked profile).
const dataOverride = dataDirOverride()
const userDataDir = canonicalUserData(dataOverride?.userData ?? app.getPath('userData'))
app.setPath('userData', userDataDir)
if (dataOverride) {
  const overrideLogs = join(userDataDir, 'logs')
  mkdirSync(overrideLogs, { recursive: true })
  app.setAppLogsPath(overrideLogs)
}

function canonicalUserData(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true })
    return realpathSync(dir)
  } catch {
    return dir
  }
}

let runManager: RunManager | undefined
let notifier: Notifier | undefined
let settingsStore: SettingsStore | undefined
/** Set once constructed; broadcast() feeds it every usage.status so the idle probe merges onto a run's report. */
let usageMonitor: UsageMonitor | null = null
/** This process's ownership of <dataDir>/run (cli-spec 3.2(2)); released on will-quit and process exit. */
let ownership: HostOwnership | undefined
/** True once whenReady has built the stores and the first window: the window handlers below wait for it. */
let booted = false
/** Set on the first before-quit: a second launch during a quit must not open a window in the quitting app. */
let quitting = false

// A second launch on the same userData (Electron's single-instance lock) brings the running app forward instead.
// Wave 0: restore and focus the main window, or open one. (--headless-host argv handling comes with Wave 2.)
app.on('before-quit', () => {
  quitting = true
})
app.on('second-instance', () => {
  if (!booted) return
  if (quitting) {
    log.info('A second launch arrived while OrgAI is quitting; ignored (start OrgAI again once it has closed).')
    return
  }
  const main = liveWindowScopes().find(([, scope]) => scope === undefined)?.[0]
  if (main) showWindow(main)
  else createWindow()
})
app.on('activate', () => {
  if (booted && !quitting && BrowserWindow.getAllWindows().length === 0) createWindow()
})
// The lock is keyed by userData, so it is taken after setPath. An unpackaged dev build ('orgai') and the packaged
// 'OrgAI' share one userData folder on case-insensitive macOS, so the lock correctly makes them exclusive. The losing
// process exits at once, without touching <dataDir>/run.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.exit(0)

// Unpackaged (npm run dev, e2e) the name comes from package.json ("orgai"); on macOS that names ~/Library/Logs/<name>
// and the About entry. userData was set above, so it does not move.
if (!app.isPackaged) app.setName('OrgAI')
if (gotLock) {
  // app.getPath('logs') is ~/Library/Logs/<name> on macOS (where Console.app looks); on Windows and Linux it is
  // <userData>/logs. If it throws or is read-only (sandboxed or managed Macs), use <userData>/logs.
  const logsDir = pickLogsDir([() => app.getPath('logs'), () => join(userDataDir, 'logs')], canWriteDir)
  installLogging({ userDataDir, logsDir, appVersion: app.getVersion(), isPackaged: app.isPackaged, electronVersion: process.versions.electron })
  installElectronLogHooks(app)
}
// Finder/Dock launches on macOS get a minimal PATH; take the login shell's before anything spawns claude, codex or MCP servers.
applyShellPath()
if (process.platform === 'win32') app.setAppUserModelId('com.orgai.app')

/** Native menus, scrollbars, dialogs and prefers-color-scheme in the renderer follow AppSettings.appearance.theme. */
function applyTheme(s: AppSettings): void {
  if (nativeTheme.themeSource !== s.appearance.theme) nativeTheme.themeSource = s.appearance.theme
}

/** The effective default connection (ConnectionService.effectiveDefault); set once the service exists. */
let effectiveDefaultOf: (() => ConnectionId) | undefined
/** The defaultConnection last sent with settings:changed, so a moved effective default is re-broadcast once. */
let lastBroadcastDefault: ConnectionId | undefined

/**
 * Every window hears about a save, so a second window and the deprecated notifications mirror stay in step. The
 * payload's defaultConnection is the effective default (withEffectiveDefault), never the stored value.
 */
function broadcastSettings(s: AppSettings): void {
  if (!settingsStore) return
  const effective = effectiveDefaultOf?.() ?? s.defaultConnection
  lastBroadcastDefault = effective
  const info = buildSettingsInfo(withEffectiveDefault(s, effective), { dataDir: settingsStore.dataDir, appVersion: app.getVersion() })
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, info)
  }
}

/** How long after a LiteLLM run ends its key's spend is re-read (the proxy batches spend writes, ~10 s by default). */
const LITELLM_SPEND_DELAY_MS = 15_000

function broadcast(event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.runEvent, event)
  }
  usageMonitor?.observe(event)
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

function broadcastCapabilityProgress(event: CapabilityProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.capabilitiesProgress, event)
  }
}

function broadcastTeamReview(summary: TeamReviewSummary): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.capabilitiesReviewUpdated, summary)
  }
}

function broadcastSkillLibrary(entries: SkillLibraryInfo[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.skillLibraryChanged, entries)
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
    autoHideMenuBar: false,
    backgroundColor: windowBackground(settingsStore?.get().appearance.theme ?? 'dark', nativeTheme.shouldUseDarkColors),
    title: 'OrgAI',
    // Packaged builds take the icon from the executable; in development use the generated ICO (Windows) or PNG.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png') }),
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

app.whenReady().then(async () => {
  if (!gotLock) return
  const dataDir = join(app.getPath('userData'), 'data')
  // Step 0 (cli-spec 3.2(2)): own <dataDir>/run before any store constructor, since RunStore rewrites live runs.
  try {
    ownership = await acquireHostOwnership({ dataDir, hostKind: 'desktop', appVersion: app.getVersion() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error(`Host ownership failed: ${message}`)
    if (e instanceof HostAlreadyRunningError || e instanceof HostStartingOrBusyError) {
      dialog.showErrorBox('OrgAI is already running', `${message}\n\nQuit the other OrgAI (or the terminal host using this data folder), then start OrgAI again.`)
    } else {
      // Every other failure (an unsafe or unwritable run folder, a socket that cannot be created there, a full disk)
      // would otherwise quit with no window at all.
      dialog.showErrorBox(
        'OrgAI could not start',
        `OrgAI could not take ownership of its data folder:\n${message}\n\nData folder: ${dataDir}\nCheck that the folder is on a local disk you can write to, then start OrgAI again.`
      )
    }
    app.exit(6)
    return
  }
  const owned = ownership
  // In development the Dock would show Electron's icon; packaged builds take it from the bundle.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png')))
    } catch (err) {
      log.warn(`Could not set the Dock icon: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
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
    logInfo: (m) => log.info(m),
    // The effective default moved without a settings write (e.g. chosen mode, a removed key): re-broadcast once.
    onDefaultChanged: () => {
      if (effectiveDefaultOf && effectiveDefaultOf() !== lastBroadcastDefault) broadcastSettings(settings.get())
    },
    openExternal: (url) => shell.openExternal(url),
    // Models the Claude login offers (SDK supportedModels); the scripted mock answers its own list. `adapters` is
    // declared below and only read when discovery runs.
    anthropicModels: (auth) => {
      const adapter = process.env.ORGAI_MOCK === '1' ? (adapters as { mock?: RuntimeAdapter }).mock : (adapters.claude as RuntimeAdapter)
      return adapter?.listModels?.(auth) ?? Promise.resolve(null)
    }
  })
  effectiveDefaultOf = () => connections.effectiveDefault()
  lastBroadcastDefault = connections.effectiveDefault()
  // Community model prices (LiteLLM's public list): a cached fallback after the builtin table; AppSettings.communityPrices turns it off.
  const communityPrices = new CommunityPrices({ dataDir, enabled: () => settings.get().communityPrices !== false })
  const mockAdapter = process.env.ORGAI_MOCK === '1'
  /** The virtual project of harness-level runs (library MCP assistant), from the current settings. */
  const harness = () => harnessProject(connections.effectiveSettings(), dataDir, { mock: mockAdapter })
  // Set once RunManager exists (below); only read when a run or a window asks for a project.
  let quickRuns: QuickRunService | undefined
  let skillEvaluationService: SkillEvaluationService | undefined
  /** A stored project, or the display project of a virtual id (harness, quick, skills). */
  const projectOrHarness = (projectId: string) =>
    projectId === HARNESS_PROJECT_ID ? harness()
    : projectId === QUICK_PROJECT_ID ? quickRuns?.displayProject()
    : projectId === SKILLS_PROJECT_ID ? skillsProject(connections.effectiveSettings(), dataDir, { mock: mockAdapter })
    : projects.get(projectId)
  const mcp = new McpService({
    projects,
    secrets,
    library: new McpLibraryStore(dataDir),
    dataDir,
    openExternal: (url) => shell.openExternal(url),
    // ORGAI_MOCK=1 only: connector entries authorize and test without network (walkthroughs, e2e).
    mock: mockAdapter,
    onLibraryChanged: broadcastMcpLibrary,
    // Library changes that save a project (unlink on remove, promote) reach every window like a run's project update.
    onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project })
  })
  const skills = new SkillService({
    dataDir,
    projects,
    onLibraryChanged: broadcastSkillLibrary,
    onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project })
  })
  const templates = new TemplateService({
    dataDir,
    projects,
    modelContext: (id) => connections.importModelContext(id),
    withAdapter: (project) => connections.withAdapter(project),
    onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project })
  })
  const setup = new SetupService(projects, {
    dataDir,
    removeMcpSecrets: (projectId, serverId) => mcp.removeServerSecrets(projectId, serverId),
    mcp: {
      libraryEntries: () => mcp.libraryEntries(),
      applyProposal: (projectId, payload, opts) => mcp.applyProposal(projectId, payload, opts),
      applyLibraryProposal: (payload, opts) => mcp.applyLibraryProposal(payload, opts)
    },
    skills: { applyProposal: (projectId, payload, opts) => skills.applyProposal(projectId, payload, opts) },
    templates: () => templates.list()
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
  // A LiteLLM run that ends changed the key's spend: re-read it once the proxy has written it (it batches spend
  // writes); each end restarts the one timer, so the last run's spend is read. Set once the usage monitor exists.
  let refreshLiteLLMSpend: (() => void) | undefined
  let spendTimer: ReturnType<typeof setTimeout> | undefined
  // Set once RunManager exists; work-run ends feed the proactive Team review (never setup-like or harness runs).
  let capabilities: CapabilityService | undefined
  const runBroadcast = (event: RunEvent): void => {
    broadcast(event)
    if (event.type !== 'run.status' || !['finished', 'error', 'paused'].includes(event.status)) return
    if (event.status !== 'paused') {
      const summary = runManager?.summaryOf(event.runId)
      if (summary?.kind === 'work' && !isVirtualProjectId(summary.projectId)) capabilities?.runEnded(summary.projectId, event.runId)
    }
    if (runManager?.summaryOf(event.runId)?.connection !== 'litellm') return
    clearTimeout(spendTimer)
    spendTimer = setTimeout(() => {
      spendTimer = undefined
      refreshLiteLLMSpend?.()
    }, LITELLM_SPEND_DELAY_MS)
  }
  runManager = new RunManager(adapters, runBroadcast, runStore, setup, keepRunsFor, {
    dataDir,
    // "Always allow for project" cards: append folders / switch to Accept edits on the stored project (the store cleans them).
    saveProjectPermissions: (projectId, patch) =>
      projects.update(projectId, (p) => ({
        ...p,
        ...(patch.addDirectories?.length ? { allowedDirectories: [...(p.allowedDirectories ?? []), ...patch.addDirectories] } : {}),
        // Re-checked on the stored copy: the user may have changed the mode since the run started.
        ...(patch.acceptEdits && p.permissionMode === 'default' ? { permissionMode: 'acceptEdits' as const } : {})
      })),
    resolveProject: (projectId) => projectOrHarness(projectId),
    // Context notes for engagement_context (agent saves carry the run and role as the writer); the knowledge graph for
    // engagement_knowledge; both agent write paths push projects:engagementChanged. propose_org_chart fromTemplate.
    engagementNotes: {
      list: (projectId) => listNotes(dataDir, projectId),
      read: (projectId, noteId) => readNote(dataDir, projectId, noteId),
      save: (projectId, input, writer) => saveNote(dataDir, projectId, input, writer)
    },
    knowledge: knowledgeStore(dataDir),
    engagementChanged: broadcastEngagementChanged,
    orgTemplate: (templateId, project) => templates.forRun(templateId, project),
    // An auto-resumed build session gets its checked workspace back; a vanished one throws (resumeNow reports it).
    buildProject: (summary) => harnessProjectFor(summary, connections.effectiveSettings(), dataDir, mockAdapter),
    opusGuardThreshold: () => settings.get().opusGuardThreshold,
    catalog: () => connections.catalog(),
    appSettings: () => settings.get(),
    communityPrices: () => communityPrices.get(),
    resolveConnection: (project, choice) => connections.runConnection(project, choice),
    fastModel: (_project, choice) => connections.fastModel(choice),
    mcp: {
      enabledServers: (project) => mcp.enabledServers(project),
      resolve: (projectId, spec, extra) => mcp.resolve(projectId, spec, extra),
      persistInstall: (projectId, spec, values, scope) => mcp.persistInstall(projectId, spec, values, scope),
      withLibrary: (project) => mcp.withLibrary(project),
      prepareForRun: (projectId, specs) => mcp.prepareForRun(projectId, specs),
      skippedServers: (project) => mcp.skippedServers(project),
      libraryEntries: () => mcp.libraryEntries(),
      storeProposalSecrets: (projectId, payload, values) => mcp.storeProposalSecrets(projectId, payload, values),
      searchRegistry: (input) => mcp.registrySearch(input)
    },
    skills,
    // Chat: a continued or resumed quick run rebuilds its project from summary.quick.
    quickProject: (summary) => quickRuns?.projectFor(summary),
    // list_projects (quick runs only): stored projects with their newest run; never virtual ids, never secrets.
    listProjects: () => projectPeeks(projects.list(), (projectId) => runStore.list(projectId)[0]),
    // Skill assistant: the library plus (in a project session) the project's skills; reads never throw.
    skillAssist: {
      catalog: (projectId) => {
        try {
          return {
            library: skills.libraryList(),
            project: projectId ? skills.list(projectId) : [],
            ...(projectId ? { evaluation: skillEvaluationService?.last(projectId) ?? null } : {})
          }
        } catch (e) {
          console.warn(`Skill catalog unavailable: ${(e as Error).message}`)
          return { library: [], project: [] }
        }
      },
      read: (projectId, ref) => {
        try {
          if (typeof ref?.libraryId === 'string') return skills.libraryRead({ libraryId: ref.libraryId })
          if (typeof ref?.skillId === 'string' && projectId) return skills.read({ projectId, skillId: ref.skillId })
        } catch {
          /* unknown id: the tool reports it */
        }
        return null
      }
    }
  })
  const rm = runManager
  quickRuns = new QuickRunService({
    dataDir,
    settings: () => connections.effectiveSettings(),
    runs: rm,
    store: runStore,
    projects,
    prepare: (p) => connections.prepareNewProject(p),
    broadcast,
    mock: mockAdapter
  })
  const quick = quickRuns
  // A pruned or deleted quick run takes its scratch dir with it when no other run uses it.
  runStore.onRunsRemoved = (removed) => quick.runsRemoved(removed)
  const skillEvaluation = new SkillEvaluationService({
    dataDir,
    project: (projectId) => projects.get(projectId),
    listRuns: (projectId) => rm.list(projectId),
    getRun: (runId) => rm.get(runId),
    skills,
    complete: (project, input) => rm.completeForProject(project, input)
  })
  skillEvaluationService = skillEvaluation
  if (mockAdapter) seedMockHome(join(dataDir, 'mock-home'))
  capabilities = new CapabilityService({
    projects,
    skills,
    mcp,
    dataDir,
    complete: (project, input) => rm.completeForProject(project, input),
    listRuns: (projectId) => rm.list(projectId),
    getRun: (runId) => rm.get(runId),
    progress: broadcastCapabilityProgress,
    reviewUpdated: broadcastTeamReview,
    onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project }),
    // ORGAI_MOCK=1 only: local discovery reads seeded fixtures under the data dir, never the real home.
    homeDir: mockAdapter ? join(dataDir, 'mock-home') : homedir(),
    env: mockAdapter ? {} : process.env,
    platform: process.platform,
    mock: mockAdapter
  })
  const caps = capabilities
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
    openRunWindow,
    importer: new AgentImportService({
      projects,
      modelContext: (id) => connections.importModelContext(id),
      withAdapter: (project) => connections.withAdapter(project),
      onProjectChanged: (project) => broadcast({ type: 'project.updated', runId: '', project })
    }),
    skills,
    skillEvaluation,
    capabilities: caps,
    quick,
    templates,
    kit: new KitService({ appVersion: app.getVersion(), platform: process.platform, skills, mcp, templates }),
    // Lazy: the monitor is created after registerIpc.
    usage: { refresh: () => usageMonitor?.refresh() ?? Promise.resolve(null) }
  })
  connections.init()
  connections.startDiscovery()
  if (process.env.ORGAI_MOCK !== '1') communityPrices.start()
  app.on('before-quit', () => {
    caps.dispose()
    connections.dispose()
    communityPrices.dispose()
  })
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
  const monitor = new UsageMonitor({
    adapter: adapters.claude,
    auth: () => settings.get().providerAuth,
    broadcast,
    liveRuns: () => runManager?.liveRunCount() ?? 0,
    extraProbes: [() => connections.probeCodexUsage(), { key: 'litellm', probe: () => connections.probeLiteLLMUsage() }]
  })
  usageMonitor = monitor
  refreshLiteLLMSpend = () => void monitor.refreshProbe('litellm')
  app.on('before-quit', () => clearTimeout(spendTimer))
  monitor.start()
  app.on('before-quit', () => monitor.stop())

  // Housekeeping: runs of projects that no longer exist, runs past retention, record files nobody indexes.
  // The virtual projects (harness, quick, skills) own runs without being stored: their runs survive restarts.
  const knownProjects = new Set([...projects.list().map((p) => p.id), HARNESS_PROJECT_ID, QUICK_PROJECT_ID, SKILLS_PROJECT_ID])
  let dropped = 0
  for (const projectId of orphanRunProjects(runStore.allProjectIds(), knownProjects, readRetainedRunProjects(dataDir))) dropped += runStore.removeProject(projectId)
  dropped += runStore.prune(keepRunsFor)
  dropped += runStore.sweepOrphans()
  // Scratch dirs (Chat without a folder, MCP build workspaces) that no remaining run record points to.
  dropped += sweepScratchDirs(dataDir, runStore.all())
  sweepStaleSkillDirs()
  if (dropped) console.log(`Housekeeping removed ${dropped} stale run(s) or record file(s).`)
  // Stores built, probes started, housekeeping done: advertise the host as ready.
  owned.markReady()
  installAppMenu(
    menuActionSender(() => BrowserWindow.getFocusedWindow(), liveWindowScopes, () => createWindow())
  )
  createWindow()
  booted = true
})

// Give up <dataDir>/run ownership on the way out; the exit hook covers app.exit and paths that skip will-quit.
// release() is synchronous and idempotent.
app.on('will-quit', () => ownership?.release())
process.on('exit', () => ownership?.release())

/** Longest a quit waits for live runs to record their end (RunManager.stopAll) before it goes ahead anyway. */
const QUIT_STOP_DEADLINE_MS = 3000
// Live runs are cut by the app, not the user (RunSummary.endedBy 'app'): the first quit is held until stopAll has
// written them, or the deadline passes (then markQuit writes them synchronously). A re-entrant quit while stopAll is
// pending is held too and never calls stopAll again; one after the deadline is forced through. See quitGate.ts.
app.on(
  'before-quit',
  quitGate({
    liveCount: () => runManager?.liveRunCount() ?? 0,
    stopAll: () => runManager?.stopAll({ reason: 'quit' }) ?? Promise.resolve(),
    markQuit: () => runManager?.markQuit(),
    deadlineMs: QUIT_STOP_DEADLINE_MS,
    quit: () => app.quit(),
    warn: (m) => console.warn(m)
  })
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
