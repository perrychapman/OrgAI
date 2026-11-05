import { app, BrowserWindow, dialog, nativeImage, nativeTheme, safeStorage, shell } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, FocusRunTarget, RunEvent } from '@shared/types'
import { IPC, runWindowHash } from '@shared/types'
import { appUrlMatcher, isExternalWebUrl, scopedWindow, shouldBlockNavigation } from './windowScope'
import { applyShellPath } from './shellEnv'
import { installAppMenu, menuActionSender } from './appMenu'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { canWriteDir, dataDirOverride, installLogging, log, pickLogsDir } from './log'
import { installElectronLogHooks } from './electronLogHooks'
import { acquireHostOwnership, HostAlreadyRunningError, HostStartingOrBusyError, type HostOwnership } from './host/ownership'
import { bootOrgAIHost, type OrgAIHost } from './host/bootstrap'
import type { HostRuntimeEnv } from './host/runtimeEnv'
import { windowBackground } from './appInfo'
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

/** The booted host (stores, services, runs, the event bus; host/bootstrap.ts); set once whenReady has built it. */
let host: OrgAIHost | undefined
let notifier: Notifier | undefined
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
/** Where main.log goes; picked below once the lock is ours. */
let logsDir = join(userDataDir, 'logs')
/** What the host is told about this process (logging, app:info, settings:changed). */
function runtimeEnv(): HostRuntimeEnv {
  return { userDataDir, logsDir, appVersion: app.getVersion(), isPackaged: app.isPackaged, electronVersion: process.versions.electron }
}
if (gotLock) {
  // app.getPath('logs') is ~/Library/Logs/<name> on macOS (where Console.app looks); on Windows and Linux it is
  // <userData>/logs. If it throws or is read-only (sandboxed or managed Macs), use <userData>/logs.
  logsDir = pickLogsDir([() => app.getPath('logs'), () => join(userDataDir, 'logs')], canWriteDir)
  installLogging(runtimeEnv())
  installElectronLogHooks(app)
}
// Finder/Dock launches on macOS get a minimal PATH; take the login shell's before anything spawns claude, codex or MCP servers.
applyShellPath()
if (process.platform === 'win32') app.setAppUserModelId('com.orgai.app')

/** Native menus, scrollbars, dialogs and prefers-color-scheme in the renderer follow AppSettings.appearance.theme. */
function applyTheme(s: AppSettings): void {
  if (nativeTheme.themeSource !== s.appearance.theme) nativeTheme.themeSource = s.appearance.theme
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
    backgroundColor: windowBackground(host?.settings.get().appearance.theme ?? 'dark', nativeTheme.shouldUseDarkColors),
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
  // Stores, services, adapters, background probes and housekeeping (cli-spec 3.2(2) step 4); markReady at its end.
  const h = bootOrgAIHost({
    env: runtimeEnv(),
    dataDir,
    hostKind: 'desktop',
    ownership: owned,
    safeStorage,
    openExternal: (url) => shell.openExternal(url),
    desktop: { openRunWindow },
    mock: process.env.ORGAI_MOCK === '1',
    onDrained: () => app.quit()
  })
  host = h
  const settings = h.settings
  applyTheme(settings.get())
  settings.onChange((s) => applyTheme(s))
  // Every push on the host's bus reaches every window (so a second window and the deprecated notifications mirror
  // stay in step); run events also go to the notifier.
  h.events.on((channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
    if (channel !== IPC.runEvent) return
    try {
      notifier?.handle(payload as RunEvent)
    } catch (e) {
      console.error('Notification failed:', e)
    }
  })
  notifier = new Notifier({
    projectOfRun: (runId) => {
      const summary = h.runs.summaryOf(runId)
      if (!summary) return undefined
      const project = h.projectOrHarness(summary.projectId)
      return { projectId: summary.projectId, kind: summary.kind, autoContinue: project?.autoContinue !== false, maxAutoContinues: project?.maxAutoContinues }
    },
    projectName: (projectId) => h.projectOrHarness(projectId)?.name,
    windows: liveWindowScopes,
    // AppSettings.notifications is the single source of truth, read fresh at every decision.
    enabled: () => settings.get().notifications !== false
  })
  // Open windows keep the desktop host busy (cli-spec 3.2(4) interactiveClients).
  h.activity.addSource('interactiveClients', () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
  // `events` given: registerIpc leaves forwarding the bus to windows to the listener above.
  registerIpc({ ...h.services, openRunWindow, events: h.events, dispatcher: h.dispatcher })
  app.on('before-quit', () => h.dispose())
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
    liveCount: () => host?.runs.liveRunCount() ?? 0,
    stopAll: () => host?.runs.stopAll({ reason: 'quit' }) ?? Promise.resolve(),
    markQuit: () => host?.runs.markQuit(),
    deadlineMs: QUIT_STOP_DEADLINE_MS,
    quit: () => app.quit(),
    warn: (m) => console.warn(m)
  })
)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
