import { app, BrowserWindow, dialog, nativeImage, nativeTheme, safeStorage, screen, shell } from 'electron'
import { parseLargerThanScreen, parseWindowInactive, windowPlacement } from './windowPlacement'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, FocusRunTarget, RunEvent } from '@shared/types'
import { IPC, TEAM_FILES_IPC, runWindowHash } from '@shared/types'
import { appUrlMatcher, isExternalWebUrl, scopedWindow, shouldBlockNavigation } from './windowScope'
import { applyShellPath } from './shellEnv'
import { stopSystemCertRead, trustSystemCertificates } from './systemCerts'
import { installAppMenu, menuActionSender, navigateSender } from './appMenu'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { canWriteDir, dataDirOverride, installLogging, log, pickLogsDir } from './log'
import { installElectronLogHooks } from './electronLogHooks'
import { acquireHostOwnership, HostAlreadyRunningError, HostStartingOrBusyError, type HostOwnership } from './host/ownership'
import { bootOrgAIHost, type OrgAIHost } from './host/bootstrap'
import { openSecretStore } from './store/secrets'
import { unavailableCustodianFactory } from './store/unavailableCustodian'
import { checkDesktopFolder } from './store/productMarker'
import {
  CLOSE_PROMPT_BUTTONS,
  CLOSE_PROMPT_CANCEL_ID,
  closePromptChoice,
  closePromptText,
  reopenAfterCancel,
  windowAllClosedAction,
  type ClosePromptChoice
} from './hostLifecycle'
import type { HostRuntimeEnv } from './host/runtimeEnv'
import { windowBackground } from './appInfo'
import { installShutdownSignals, type ShutdownReason } from './host/shutdown'
import { beforeQuitHandler } from './desktopQuit'
import { orgaiCliRootsOf, setOrgaiCliRoots } from './runtime/selfControlGate'
import { createCliShimService, type CliShimService } from './host/shimInstaller'
import { RepoCloneService } from './repoClone'

// The certificate-reader child runs this binary with ELECTRON_RUN_AS_NODE=1; if a RunAsNode fuse is off it would boot a full app here.
if (process.env.ELECTRON_RUN_AS_NODE) process.exit(0)
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
/** This process's ownership of <dataDir>/run (cli-spec 3.2(2)); released by the shutdown and on process exit. */
let ownership: HostOwnership | undefined
/** True once whenReady has built the stores and the first window: the window handlers below wait for it. */
let booted = false
/** Set on the first before-quit that goes ahead: a second launch during a quit must not open a window in the quitting app. */
let quitting = false
/** Clones started from a window (desktop only); cancelled when the quit goes ahead. */
let repoClone: RepoCloneService | undefined

// The app is a host of its own: no socket, no terminal clients, no headless mode (standalone spec 5.1).
const hostKind = 'desktop' as const
// The self-control gate treats an interpreter run of a file in this install's out/cli or src/cli as the orgai CLI.
setOrgaiCliRoots(orgaiCliRootsOf(app.getAppPath()))
/** In background mode (no windows, kept alive for its activity); logged once per entry. */
let inBackground = false
/** The last-window close prompt (review H3) is showing. */
let closePromptOpen = false
/** Why the next quit happens (the shutdown coordinator's reason): the last window closing on Windows / Linux, else Quit. */
let quitReason: ShutdownReason = 'desktop-quit'
// A second launch on the same userData (Electron's single-instance lock) is answered by the incumbent: it brings a
// window forward.
app.on('second-instance', () => {
  if (!booted || quitting) {
    if (quitting) log.info('A second launch arrived while OrgAI is quitting; ignored (start OrgAI again once it has closed).')
    return
  }
  showDockIcon()
  const main = liveWindowScopes().find(([, scope]) => scope === undefined)?.[0]
  if (main) showWindow(main)
  else createWindow()
})
app.on('activate', () => {
  if (!booted || quitting) return
  showDockIcon()
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
// The lock is keyed by userData, so it is taken after setPath. An unpackaged dev build ('orgai') and the packaged
// 'OrgAI' share one userData folder on case-insensitive macOS, so the lock correctly makes them exclusive. The losing
// process exits at once, without touching <dataDir>/run.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.exit(0)
// The product marker (standalone spec 3.1): a folder the orgai CLI marked is refused (a dialog below, nothing else
// written there); an unmarked one gets the desktop marker.
const folderCheck = gotLock ? checkDesktopFolder(userDataDir) : {}
const folderRefused = folderCheck.refusal !== undefined

// Unpackaged (npm run dev, e2e) the name comes from package.json ("orgai"); on macOS that names ~/Library/Logs/<name>
// and the About entry. userData was set above, so it does not move.
if (!app.isPackaged) app.setName('OrgAI')
/** Where main.log goes; picked below once the lock is ours. */
let logsDir = join(userDataDir, 'logs')
/** What the host is told about this process (logging, app:info, settings:changed). */
function runtimeEnv(): HostRuntimeEnv {
  return { userDataDir, logsDir, appVersion: app.getVersion(), isPackaged: app.isPackaged, electronVersion: process.versions.electron }
}
if (gotLock && !folderRefused) {
  // app.getPath('logs') is ~/Library/Logs/<name> on macOS (where Console.app looks); on Windows and Linux it is
  // <userData>/logs. If it throws or is read-only (sandboxed or managed Macs), use <userData>/logs.
  logsDir = pickLogsDir([() => app.getPath('logs'), () => join(userDataDir, 'logs')], canWriteDir)
  installLogging(runtimeEnv())
  installElectronLogHooks(app)
}
// Finder/Dock launches on macOS get a minimal PATH; take the login shell's before anything spawns claude, codex or MCP servers.
// The login shell's own PATH (without OrgAI's additions) is kept for the orgai command shim's "on your PATH" check.
const shellPathResult = applyShellPath()
if (gotLock && !folderRefused) {
  // Trust the OS certificate store too (corporate / inspecting root CAs), before anything can fetch (issue #16). Only
  // once the lock is ours, so a second launch that exits at once never starts the macOS certificate-reader child.
  // On macOS the store is read in a child process (it can stall) and applied when that finishes; the quit below kills it.
  trustSystemCertificates()
}
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

function showDockIcon(): void {
  if (process.platform !== 'darwin') return
  void Promise.resolve(app.dock?.show()).catch(() => {})
}

/**
 * No windows, and the app keeps working in the background: the user chose "Keep working in the background" (review
 * H3: never without that answer). The idle exit then quits once nothing keeps the app busy
 * (ORGAI_DAEMON_IDLE_MINUTES, default 30).
 */
function goBackground(): void {
  windowScopes.clear()
  if (process.platform === 'darwin') app.dock?.hide()
  host?.activity.armIdleExit()
  if (!inBackground) {
    inBackground = true
    const counts = host?.activity.snapshot().counts ?? {}
    const busy = Object.entries(counts)
      .filter(([, n]) => typeof n === 'number' && n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')
    if (busy) log.info(`All windows closed while OrgAI is busy (${busy}); it keeps running in the background until its work is done.`)
    else log.info('All windows closed; OrgAI quits at its idle exit.')
  }
}

/** window:openRun (already validated): focus the window scoped to this run, or open one. */
function openRunWindow(target: FocusRunTarget): void {
  const existing = scopedWindow(liveWindowScopes(), target.runId)
  if (existing) showWindow(existing)
  else createWindow(target)
}

// Opt-in, read once: ORGAI_WINDOW_DISPLAY ('secondary' or a 1-based display number) and ORGAI_WINDOW_INACTIVE=1 let
// test and walkthrough windows open on another monitor without taking focus. Unset = the default behaviour.
const WINDOW_DISPLAY = process.env.ORGAI_WINDOW_DISPLAY
const WINDOW_INACTIVE = parseWindowInactive(process.env.ORGAI_WINDOW_INACTIVE)
// ORGAI_WINDOW_LARGER_THAN_SCREEN=1 (CI only, macOS): lets e2e windows exceed a small work area (constructor-only,
// ignored off macOS). Unset = unchanged.
const WINDOW_LARGER_THAN_SCREEN = parseLargerThanScreen(process.env.ORGAI_WINDOW_LARGER_THAN_SCREEN)
let windowDisplayNoted = false

function windowPlacementFor(width: number, height: number): { x: number; y: number } | null {
  if (WINDOW_DISPLAY === undefined) return null
  try {
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }))
    const result = windowPlacement(WINDOW_DISPLAY, displays, screen.getPrimaryDisplay().id, width, height)
    if (result.note && !windowDisplayNoted) {
      windowDisplayNoted = true
      log.info(result.note)
    }
    return result.position
  } catch (err) {
    log.warn(`Window placement failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * The one window factory. Every window, main or run-scoped, gets the same preload and security settings
 * (contextIsolation, the external-link handler). A run-scoped window loads the renderer with the hash
 * `#/run/<projectId>/<runId>`.
 */
function createWindow(scope?: FocusRunTarget): BrowserWindow {
  inBackground = false
  const width = scope ? 1280 : 1440
  const height = scope ? 840 : 920
  const placement = windowPlacementFor(width, height)
  const win = new BrowserWindow({
    width,
    height,
    ...(placement ? { x: placement.x, y: placement.y } : {}),
    minWidth: 1024,
    minHeight: 680,
    ...(WINDOW_LARGER_THAN_SCREEN ? { enableLargerThanScreen: true } : {}),
    show: false,
    autoHideMenuBar: false,
    backgroundColor: windowBackground(host?.settings.get().appearance.theme ?? 'dark', nativeTheme.shouldUseDarkColors),
    title: 'OrgAI',
    // Packaged builds take the icon from the executable; in development use the generated ICO (Windows) or PNG.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png') }),
    webPreferences: {
      // The preload is built as CommonJS (out/preload/index.cjs, electron.vite.config.ts; cli-spec 7(1)) with the
      // shared code bundled in, so it requires only 'electron' and runs in the sandboxed renderer.
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })

  windowScopes.set(win, scope)
  // The web contents id is read now: it is gone when 'closed' fires. A closed window's output watches end with it.
  const webContentsId = win.webContents.id
  win.on('closed', () => {
    windowScopes.delete(win)
    host?.services.outputWatcher?.dropOwner(`window:${webContentsId}`)
  })
  win.on('ready-to-show', () => (WINDOW_INACTIVE ? win.showInactive() : win.show()))
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
  if (folderCheck.refusal) {
    dialog.showErrorBox('OrgAI cannot use this folder', folderCheck.refusal)
    app.exit(2)
    return
  }
  if (folderCheck.warning) log.warn(folderCheck.warning)
  const dataDir = join(app.getPath('userData'), 'data')
  // Step 0 (cli-spec 3.2(2)): own <dataDir>/run before any store constructor, since RunStore rewrites live runs. The app
  // never listens on a socket (listen: false).
  try {
    ownership = await acquireHostOwnership({ dataDir, hostKind, appVersion: app.getVersion(), listen: false, singleInstanceLockHeld: gotLock })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error(`Host ownership failed: ${message}`)
    if (e instanceof HostAlreadyRunningError || e instanceof HostStartingOrBusyError) {
      dialog.showErrorBox('OrgAI is already running', `${message}\n\nQuit the other OrgAI using this data folder, then start OrgAI again.`)
    } else {
      // Every other failure (an unsafe or unwritable run folder, a full disk) would otherwise quit with no window at all.
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
  // Stores, services, adapters, background probes and housekeeping (cli-spec 3.2(2) step 4). The boot's markReady is
  // held back: the record turns 'ready' below, once the boot returned.
  let cliShimForStatus: CliShimService | undefined
  const bootOwnership = {
    get info() {
      return owned.info
    },
    ...(owned.runtimeDir ? { runtimeDir: owned.runtimeDir } : {}),
    markReady: () => true,
    markDraining: () => owned.markDraining(),
    release: () => owned.release()
  }
  // Wave 7 (cli-standalone.md 5.6): open secure storage (decrypt `check`, reconcile with secrets.json, create it when
  // absent) after ownership and before the boot, so the first
  // probes see the stored secrets. A custodian failure leaves the app in legacy-only mode (secrets.json,
  // as before) with a retry every 10 minutes and on window focus after a lock failure. The real custodians are the
  // default (macOS keychain, DPAPI, Secret Service, ORGAI_VAULT_KEY_FILE). A mock launch (e2e, verify-pack) must never
  // write an OS key item for a throwaway data folder, so it keeps the legacy-only mode unless a key file is named.
  const secretStore = await openSecretStore({
    dataDir,
    userDataDir,
    hostKind,
    product: 'desktop',
    cipher: safeStorage,
    log: (m) => log.info(m),
    ...(process.env.ORGAI_MOCK === '1' && !(process.env.ORGAI_VAULT_KEY_FILE ?? '').trim() ? { custodian: unavailableCustodianFactory } : {})
  })
  app.on('browser-window-focus', () => secretStore.retryOpen('focus'))
  const h = bootOrgAIHost({
    env: runtimeEnv(),
    dataDir,
    hostKind,
    ownership: bootOwnership,
    safeStorage,
    secretStore,
    openExternal: (url) => shell.openExternal(url),
    // The reference status snapshot reads the orgai command shim's state; the shim service is built after boot.
    cliShimStatus: () => {
      if (!cliShimForStatus) throw new Error('not ready')
      return cliShimForStatus.status()
    },
    desktop: {
      openRunWindow,
      // open_in_app: the live main window only, queued until its renderer is ready; focused only while OrgAI is the
      // foreground app, else flashed (appMenu.ts navigateSender, review M2). No main window open: false, never a new one.
      navigate: (event) => navigateSender(() => BrowserWindow.getFocusedWindow(), liveWindowScopes)(event),
      // outputs:delete moves the file to the OS trash (the service deletes for good when this is missing or throws).
      trashItem: (p) => shell.trashItem(p),
      teamFilesChanged: (status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(TEAM_FILES_IPC.teamFilesChanged, status)
        }
      }
    },
    mock: process.env.ORGAI_MOCK === '1',
    // Wave 7 (cli-standalone.md 4.3): the shutdown sequence releases ownership, then calls onDrained; a quit started
    // anywhere (Quit, a last window on Windows / Linux, idle exit, a signal) only leaves once it got here.
    // Repository clones the windows started are cancelled as soon as the drain starts (round 6 item 9).
    quiesce: () => repoClone?.dispose(),
    // At the hard limit (writers still in flight after 60 s, descendants killed): leave now; the exit hook releases.
    exitAtHardLimit: () => process.exit(0),
    // Chromium's own helpers (GPU, renderers, network and utility services) are not the host's work: killing them
    // only makes Chromium relaunch them. app.getAppMetrics lists them, re-read on every pass of the tree kill.
    shutdownExcludePids: () => app.getAppMetrics().map((m) => m.pid),
    onDrained: () => {
      quitting = true
      app.quit()
    }
  })
  host = h
  const settings = h.settings
  applyTheme(settings.get())
  settings.onChange((s) => applyTheme(s))
  owned.markReady()
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
  const cliShim = buildCliShim()
  cliShimForStatus = cliShim
  // Start a project from a repository (desktop only: progress goes to the calling window, a closed window cancels).
  const clones = new RepoCloneService({
    dataDir,
    mock: h.services.adapterIds.includes('mock'),
    // A clone never lands in a folder an existing project already uses (its folder, allowed or reference folders).
    projectFolders: () =>
      h.services.projects
        .list()
        .flatMap((p) => [p.path, ...(p.allowedDirectories ?? []), ...(p.referenceDirectories ?? [])])
        .filter((f): f is string => typeof f === 'string' && f.length > 0)
  })
  repoClone = clones
  // Team files: pending and problem states exist before the first focus; later checks run on window focus, at most once per 2 s.
  const teamFiles = h.services.teamFiles
  if (teamFiles) {
    void teamFiles.checkAll().catch((e) => log.warn(`Team files boot check failed: ${e instanceof Error ? e.message : String(e)}`))
    app.on('browser-window-focus', () => teamFiles.focused())
  }
  // Outputs: a window focus looks (stat only) for outside edits to the outputs opened this session and the newest ones
  // of the projects this app shows (scoped windows' projects plus every project whose outputs were opened); at most once
  // per 2 s. The watcher turns a settled change into an 'external' version.
  const outputWatcher = h.services.outputWatcher
  if (outputWatcher) {
    let lastOutputsCheck = 0
    app.on('browser-window-focus', () => {
      const now = Date.now()
      if (now - lastOutputsCheck < 2000) return
      lastOutputsCheck = now
      const ids = new Set(outputWatcher.openedProjectIds())
      for (const [, scope] of liveWindowScopes()) if (scope?.projectId) ids.add(scope.projectId)
      if (ids.size) outputWatcher.checkProjects([...ids])
    })
  }
  // `events` given: registerIpc leaves forwarding the bus to windows to the listener above.
  registerIpc({ ...h.services, openRunWindow, events: h.events, dispatcher: h.dispatcher, cliShim, repoClone: clones })
  installAppMenu(
    menuActionSender(() => BrowserWindow.getFocusedWindow(), liveWindowScopes, () => createWindow())
  )
  createWindow()
  booted = true
  // SIGINT / SIGTERM (and SIGHUP) end the host through the same sequence as Quit (forced: runs end continuable).
  installShutdownSignals(h.shutdown, { log: (m) => log.info(m) })
  // cli-spec 7(3): point an existing orgai command shim at this install when it runs an older form of this launcher or
  // a launcher that is gone (an app move or update); a newer or other-install shim stays. Never blocks boot, never creates a shim, never touches a foreign file.
  if (app.isPackaged && !process.env.ORGAI_DATA_DIR) {
    void cliShim
      .refreshOnLaunch()
      .then((outcome) => log.info(`orgai command shim at launch: ${outcome}`))
      .catch((e: unknown) => log.warn(`orgai command shim refresh failed: ${e instanceof Error ? e.message : String(e)}`))
  }
})

/**
 * The orgai command shim service (cli-spec 7(3)); phase 3 of the standalone spec replaces it with the installer.
 */
function buildCliShim(): CliShimService {
  const shellPath = shellPathResult?.shellPath ?? []
  return createCliShimService({
    platform: process.platform,
    isPackaged: app.isPackaged,
    dataDirOverride: !!dataOverride,
    resourcesPath: process.resourcesPath,
    userDataDir,
    home: homedir(),
    env: process.env,
    // POSIX: the login shell's own PATH, '' (unknown) when it printed none; process.env.PATH holds OrgAI's merged
    // additions (~/.local/bin among them), so it would always answer yes. Windows: the inherited user Path.
    ...(process.platform === 'win32' ? {} : { loginPath: shellPath.join(':') }),
    onInstalled: () => log.info('Installed the orgai command.')
  })
}

// Wave 7 (cli-standalone.md 4.3): will-quit does not release; the shutdown coordinator released ownership before the
// quit could get here. The process exit hook stays as the last resort (a crash path, app.exit before boot): the
// process's own writes end with it. release() is synchronous and idempotent.
process.on('exit', () => ownership?.release())

// One before-quit handler (desktopQuit.ts, unit-tested with a fake app): the shutdown coordinator holds the quit
// (preventDefault) until it released ownership: a forced drain (runs end through stopAll({ reason: 'quit' }) within
// 3 s, else markQuit writes them), the writers settle, ownership is released, then onDrained quits again and the
// handler lets that quit through.
app.on(
  'before-quit',
  beforeQuitHandler({
    host: () => host,
    quitting: () => quitting,
    markQuitting: () => {
      quitting = true
    },
    reason: () => quitReason,
    stopCertRead: () => stopSystemCertRead(),
    // Never strand the app: the exit hook releases ownership.
    exit: (code) => app.exit(code),
    warn: (m) => log.warn(m)
  })
)

/**
 * The last window closed on Windows or Linux while runs are working without the user (review H3): ask before going
 * to the background. Cancel (or Esc) brings a window back.
 */
async function askClose(workingRuns: number): Promise<void> {
  if (closePromptOpen) return
  closePromptOpen = true
  let choice: ClosePromptChoice = 'cancel'
  try {
    const { message, detail } = closePromptText(workingRuns)
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: [...CLOSE_PROMPT_BUTTONS],
      defaultId: 0,
      cancelId: CLOSE_PROMPT_CANCEL_ID,
      noLink: true,
      title: 'OrgAI',
      message,
      detail
    })
    choice = closePromptChoice(response)
  } catch (e) {
    log.warn(`The close prompt failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    closePromptOpen = false
  }
  // A quit started meanwhile, or a window came back (a second launch): nothing left to decide.
  if (quitting || liveWindowScopes().length > 0) return
  if (choice === 'background') {
    log.info('The user chose to keep OrgAI working in the background after closing its last window.')
    goBackground()
  } else if (choice === 'quit') {
    quitReason = 'window-closed'
    app.quit()
  } else {
    createWindow()
  }
}

// The last window closed (review H3): macOS stays (Dock), and Windows / Linux quit through the shutdown coordinator,
// asking first only while runs are working without the user: working runs never go to the background unasked.
app.on('window-all-closed', () => {
  // Nothing quits before boot.
  if (!booted) return
  const workingRuns = host ? host.runs.workingRunCount() : 0
  const action = windowAllClosedAction({ platform: process.platform, quitting, workingRuns })
  if (action === 'quit') {
    quitReason = 'window-closed'
    app.quit()
  } else if (action === 'ask') void askClose(workingRuns)
})
