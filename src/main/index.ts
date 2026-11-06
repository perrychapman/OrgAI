import { app, BrowserWindow, dialog, nativeImage, nativeTheme, safeStorage, shell } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppSettings, DaemonInfo, FocusRunTarget, HostKind, RunEvent } from '@shared/types'
import { IPC, runWindowHash } from '@shared/types'
import { appUrlMatcher, isExternalWebUrl, scopedWindow, shouldBlockNavigation } from './windowScope'
import { applyShellPath } from './shellEnv'
import { stopSystemCertRead, trustSystemCertificates } from './systemCerts'
import { installAppMenu, menuActionSender } from './appMenu'
import { registerIpc } from './ipc'
import { Notifier } from './notifications'
import { canWriteDir, dataDirOverride, installLogging, log, pickLogsDir } from './log'
import { installElectronLogHooks } from './electronLogHooks'
import { acquireHostOwnership, HostAlreadyRunningError, HostStartingOrBusyError, readDaemonInfo, runDirOf, type HostOwnership } from './host/ownership'
import { bootOrgAIHost, type OrgAIHost } from './host/bootstrap'
import { openSecretStore } from './store/secrets'
import { HostSocketServer } from './host/socketServer'
import { currentHostInstanceId } from './host/identity'
import {
  CLOSE_PROMPT_BUTTONS,
  CLOSE_PROMPT_CANCEL_ID,
  closePromptChoice,
  closePromptText,
  parseHostArgs,
  quitPromptButtons,
  quitPromptNeeded,
  reopenAfterCancel,
  secondInstanceAction,
  windowAllClosedAction,
  type ClosePromptChoice
} from './hostLifecycle'
import type { HostRuntimeEnv } from './host/runtimeEnv'
import { windowBackground } from './appInfo'
import { installShutdownSignals, type ShutdownReason } from './host/shutdown'
import { beforeQuitHandler, willQuitHandler } from './desktopQuit'
import { connectHost } from '../cli/client/hostClient'
import {
  DesktopHandoff,
  handoffChoiceOf,
  handoffPageHtml,
  handoffUnavailableText,
  ownerExitCheck,
  type HandoffOutcome,
  type HandoffView
} from './handoff'
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
/** This process's ownership of <dataDir>/run (cli-spec 3.2(2)); released on will-quit and process exit. */
let ownership: HostOwnership | undefined
/** True once whenReady has built the stores and the first window: the window handlers below wait for it. */
let booted = false
/** Set on the first before-quit that goes ahead: a second launch during a quit must not open a window in the quitting app. */
let quitting = false
/** The host's socket server (cli-spec 3.3); created before ownership so every accepted connection reaches it. */
let server: HostSocketServer | undefined
/** Clones started from a window (desktop only); cancelled when the quit goes ahead. */
let repoClone: RepoCloneService | undefined

// cli-spec 3.2(1): --headless-host (started by the orgai command: no window, no Dock icon) and --run <id>. Parsed once;
// every lifecycle decision lives in hostLifecycle.ts.
const hostArgs = parseHostArgs(process.argv)
const hostKind: HostKind = hostArgs.headless ? 'headless-host' : 'desktop'
// The self-control gate treats an interpreter run of a file in this install's out/cli or src/cli as the orgai CLI.
setOrgaiCliRoots(orgaiCliRootsOf(app.getAppPath()))
/** In background mode (no windows, kept alive for its activity); logged once per entry. */
let inBackground = false
/** A prompt was answered "Stop all runs and quit" / "Stop and quit": the next quit goes through without asking. */
let quitAnswered = false
/** The quit comes from the activity drain (idle exit, host.stop): never prompt. */
let drainQuit = false
let quitPromptOpen = false
/** The last-window close prompt (review H3) is showing. */
let closePromptOpen = false
/** Why the next quit happens (the shutdown coordinator's reason): the last window closing on Windows / Linux, else Quit. */
let quitReason: ShutdownReason = 'desktop-quit'
/**
 * Wave 7 (cli-standalone.md 4.4): another host owns the data folder and this interactive launch waits for it to hand
 * over. While set, window-all-closed does not quit and second-instance / activate show the wait window again; no main
 * window is ever created (registerIpc has not run).
 */
let waitingForHandoff = false
/** The handoff in progress (its buttons and its current view). */
let handoff: DesktopHandoff | undefined
/** The small wait window of the handoff (no preload, JavaScript off; buttons are links to orgai-handoff:<choice>). */
let handoffWindow: BrowserWindow | undefined

// A second launch on the same userData (Electron's single-instance lock) is answered by the incumbent: a terminal
// host launch (--headless-host) only logs, anything else brings a window forward (and opens --run's run window).
app.on('second-instance', (_event, argv, _cwd, additionalData) => {
  if (waitingForHandoff && !booted) {
    // Still waiting for the owner to hand over: bring the wait window back, never a main window (4.4).
    const waiting = secondInstanceAction({ argv, additionalData, booted: true, quitting })
    if (waiting.kind === 'window') reshowHandoffWindow()
    return
  }
  const action = secondInstanceAction({ argv, additionalData, booted, quitting })
  if (action.kind === 'ignore') {
    if (quitting) log.info('A second launch arrived while OrgAI is quitting; ignored (start OrgAI again once it has closed).')
    return
  }
  if (action.kind === 'headless') {
    log.info('A terminal host launch found OrgAI already running.')
    return
  }
  showDockIcon()
  const main = liveWindowScopes().find(([, scope]) => scope === undefined)?.[0]
  if (main) showWindow(main)
  else createWindow()
  if (action.run) openRunById(action.run)
})
app.on('activate', () => {
  if (waitingForHandoff && !booted) {
    reshowHandoffWindow()
    return
  }
  if (!booted || quitting) return
  showDockIcon()
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
// The lock is keyed by userData, so it is taken after setPath. An unpackaged dev build ('orgai') and the packaged
// 'OrgAI' share one userData folder on case-insensitive macOS, so the lock correctly makes them exclusive. The losing
// process exits at once, without touching <dataDir>/run. additionalData tells the incumbent what this launch was
// (Chromium may reorder argv on some platforms).
const gotLock = app.requestSingleInstanceLock(
  hostArgs.run !== undefined ? { headless: hostArgs.headless, run: hostArgs.run } : { headless: hostArgs.headless }
)
if (!gotLock) app.exit(0)
// A terminal host never shows a Dock icon (macOS); a later window brings it back.
if (gotLock && hostArgs.headless && process.platform === 'darwin') app.dock?.hide()

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
// The login shell's own PATH (without OrgAI's additions) is kept for the orgai command shim's "on your PATH" check.
const shellPathResult = applyShellPath()
if (gotLock) {
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

/** A run id from --run: open its window when the host knows the run. */
function openRunById(runId: string): void {
  const summary = host?.runs.summary(runId)
  if (summary) openRunWindow({ projectId: summary.projectId, runId: summary.id })
  else log.info(`Asked to open run ${runId}, which this data folder does not have.`)
}

/**
 * No windows, and the host keeps serving in the background (cli-spec 3.2(1)): a --headless-host launch (daemon mode),
 * or a desktop launch whose user chose "Keep working in the background" (review H3: never without that answer). The
 * idle exit then quits once nothing keeps the host busy for ORGAI_DAEMON_IDLE_MINUTES.
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
    else log.info('All windows closed; this background host keeps serving terminal clients until its idle exit.')
  }
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
  inBackground = false
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
      // The preload is built as CommonJS (out/preload/index.cjs, electron.vite.config.ts; cli-spec 7(1)) with the
      // shared code bundled in, so it requires only 'electron' and runs in the sandboxed renderer.
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
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
  server = new HostSocketServer({
    dataDir,
    hostKind,
    hostInstanceId: currentHostInstanceId(),
    appVersion: app.getVersion(),
    mock: process.env.ORGAI_MOCK === '1',
    log: (m) => log.info(m)
  })
  const socketServer = server
  try {
    const got = await acquireDesktopOwnership(dataDir, socketServer)
    if (!got) {
      // The user chose Quit in the handoff's wait window.
      socketServer.close()
      app.exit(0)
      return
    }
    ownership = got
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    log.error(`Host ownership failed: ${message}`)
    socketServer.close()
    showHandoffWindow(undefined)
    if (hostArgs.headless) {
      // A terminal host has nobody to show a dialog to: the orgai command reads the exit code and the log.
    } else if (e instanceof HandoffUnavailableError) {
      const text = handoffUnavailableText(e.owner, runDirOf(dataDir))
      dialog.showErrorBox(text.title, text.detail)
    } else if (e instanceof HostAlreadyRunningError || e instanceof HostStartingOrBusyError) {
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
  // Stores, services, adapters, background probes and housekeeping (cli-spec 3.2(2) step 4). The boot's markReady is
  // held back: daemon.json turns 'ready' below, once the listener matches Terminal access, so a client that waits for
  // 'ready' never reads "listening: false" from a host about to listen.
  const bootOwnership = {
    get info() {
      return owned.info
    },
    ...(owned.runtimeDir ? { runtimeDir: owned.runtimeDir } : {}),
    markReady: () => true,
    markDraining: () => owned.markDraining(),
    release: () => owned.release()
  }
  // Wave 7 (cli-standalone.md 5.6): open the secret vault (decrypt `check`, reconcile with secrets.json, create it when
  // absent) after ownership and before the boot, for the desktop and the --headless-host boot alike, so the first
  // probes see secrets the orgai command stored. A custodian failure leaves the app in legacy-only mode (secrets.json,
  // as before) with a retry every 10 minutes and on window focus after a lock failure. No custodian factory is passed
  // yet: the default answers 'unavailable' until the platform custodians are wired in.
  const secretStore = await openSecretStore({ dataDir, userDataDir, hostKind, cipher: safeStorage, log: (m) => log.info(m) })
  app.on('browser-window-focus', () => secretStore.retryOpen('focus'))
  const h = bootOrgAIHost({
    env: runtimeEnv(),
    dataDir,
    hostKind,
    ownership: bootOwnership,
    safeStorage,
    secretStore,
    openExternal: (url) => shell.openExternal(url),
    desktop: { openRunWindow },
    mock: process.env.ORGAI_MOCK === '1',
    // Wave 7 (cli-standalone.md 4.3): the shutdown sequence flushes the host.stop reply, then releases ownership, then
    // calls onDrained; a quit started anywhere (Quit, a last window on Windows / Linux, host.stop, idle exit, a
    // signal) only leaves once it got here.
    closeSocket: (graceMs) => socketServer.closeGracefully(graceMs),
    terminalSessions: () => socketServer.terminalSessionCount(),
    // Repository clones the windows started are cancelled as soon as the drain starts (round 6 item 9).
    quiesce: () => repoClone?.dispose(),
    // At the hard limit (writers still in flight after 60 s, descendants killed): leave now; the exit hook releases.
    exitAtHardLimit: () => process.exit(0),
    // Chromium's own helpers (GPU, renderers, network and utility services) are not the host's work: killing them
    // only makes Chromium relaunch them. app.getAppMetrics lists them, re-read on every pass of the tree kill.
    shutdownExcludePids: () => app.getAppMetrics().map((m) => m.pid),
    onDrained: () => {
      drainQuit = true
      quitting = true
      app.quit()
    }
  })
  host = h
  socketServer.attach(h)
  const settings = h.settings
  applyTheme(settings.get())
  settings.onChange((s) => applyTheme(s))
  // Review M11: the listener and daemon.secret exist only while Terminal access is on; daemon.json turns 'ready' once
  // the first sync settled. Not awaited: on Windows the secret's ACL step may take a while and the window need not wait.
  // terminalAccess() is the stored switch, or this session of a --headless-host boot while the user has not chosen
  // (review H2: never saved), so a headless host listens without turning the desktop's Terminal access on.
  void syncTerminalListener(owned, h.terminalAccess().enabled).then((ok) => {
    if (!ok && hostArgs.headless) {
      // A terminal host without a listener serves nobody; the orgai command reads the exit code and the log.
      log.error('The terminal host could not open its connection point; quitting.')
      app.exit(6)
      return
    }
    owned.markReady()
  })
  settings.onChange(() => void syncTerminalListener(owned, h.terminalAccess().enabled))
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
  const cliShim = buildCliShim(h)
  // Start a project from a repository (desktop only: progress goes to the calling window, a closed window cancels).
  const clones = new RepoCloneService({
    dataDir,
    mock: process.env.ORGAI_MOCK === '1',
    // A clone never lands in a folder an existing project already uses (its folder, allowed or reference folders).
    projectFolders: () =>
      h.services.projects
        .list()
        .flatMap((p) => [p.path, ...(p.allowedDirectories ?? []), ...(p.referenceDirectories ?? [])])
        .filter((f): f is string => typeof f === 'string' && f.length > 0)
  })
  repoClone = clones
  // `events` given: registerIpc leaves forwarding the bus to windows to the listener above.
  registerIpc({ ...h.services, openRunWindow, events: h.events, dispatcher: h.dispatcher, cliShim, repoClone: clones })
  installAppMenu(
    menuActionSender(() => BrowserWindow.getFocusedWindow(), liveWindowScopes, () => createWindow())
  )
  // A terminal host opens no window; the first plain launch (second-instance) or a Dock click (activate) does.
  if (!hostArgs.headless) {
    createWindow()
    if (hostArgs.run) openRunById(hostArgs.run)
  }
  booted = true
  waitingForHandoff = false
  // SIGINT / SIGTERM (and SIGHUP) end the host through the same sequence as Quit (forced: runs end continuable).
  installShutdownSignals(h.shutdown, { log: (m) => log.info(m) })
  // cli-spec 7(3): point an existing orgai command shim at this install when it runs an older form of this launcher or
  // a launcher that is gone (an app move or update); a newer or other-install shim stays. Every launch
  // kind, headless included; never blocks boot, never creates a shim, never touches a foreign file.
  if (app.isPackaged && !process.env.ORGAI_DATA_DIR) {
    void cliShim
      .refreshOnLaunch()
      .then((outcome) => log.info(`orgai command shim at launch: ${outcome}`))
      .catch((e: unknown) => log.warn(`orgai command shim refresh failed: ${e instanceof Error ? e.message : String(e)}`))
  }
})

/**
 * Bind or close the host's listener (and write or remove daemon.secret) to match Terminal access (review M11). Calls
 * are serialized by the ownership handle. False when the listener could not be put in that state (logged).
 */
async function syncTerminalListener(owned: HostOwnership, on: boolean): Promise<boolean> {
  const was = owned.listening
  try {
    await owned.setListening(on)
    if (owned.listening !== was) log.info(on ? 'Terminal access is on: listening for terminal clients.' : 'Terminal access is off: stopped listening for terminal clients.')
    return true
  } catch (e) {
    log.warn(`Terminal access: could not ${on ? 'start' : 'stop'} listening for terminal clients: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * The orgai command shim service (cli-spec 7(3)). Installing it never turns Terminal access on by itself (review H2):
 * the App settings row asks the user to turn it on after an install.
 */
function buildCliShim(h: OrgAIHost): CliShimService {
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
    onInstalled: () => {
      if (!h.terminalAccess().enabled) log.info('Installed the orgai command; Terminal access stays off until the user turns it on.')
    }
  })
}

// Wave 7 (cli-standalone.md 4.3): will-quit no longer releases on its own; the shutdown coordinator released ownership
// before the quit could get here. The process exit hook stays as the last resort (a crash path, app.exit before boot):
// the process's own writes end with it. release() is synchronous and idempotent.
app.on('will-quit', willQuitHandler({ closeServer: () => server?.close() }))
process.on('exit', () => ownership?.release())

// One before-quit handler (desktopQuit.ts, unit-tested with a fake app), so the order is fixed: the terminal-clients
// prompt first (a cancelled or kept quit never reaches the shutdown, never marks the app quitting and never disposes
// the host), then the shutdown coordinator, which holds the quit (preventDefault) until it released ownership: a forced
// drain (runs end through stopAll({ reason: 'quit' }) within 3 s, else markQuit writes them), the writers settle, the
// terminal connections close, ownership is released, then onDrained quits again and the handler lets that quit through.
app.on(
  'before-quit',
  beforeQuitHandler({
    host: () => host,
    terminalClients: () => server?.attachedClientCount() ?? 0,
    promptNeeded: quitPromptNeeded,
    drainQuit: () => drainQuit,
    quitAnswered: () => quitAnswered,
    quitting: () => quitting,
    markQuitting: () => {
      quitting = true
    },
    promptOpen: () => quitPromptOpen,
    askQuit: (n) => void askQuit(n),
    reason: () => quitReason,
    stopCertRead: () => stopSystemCertRead(),
    // Never strand the app: the exit hook releases ownership.
    exit: (code) => app.exit(code),
    warn: (m) => log.warn(m)
  })
)

/**
 * An explicit quit while terminal clients are attached (cli-spec 3.2(1)). The spec's "N terminal run(s)" is counted as
 * attached terminal clients: no run is marked as started from the terminal yet.
 */
async function askQuit(terminalClients: number): Promise<void> {
  quitPromptOpen = true
  let response = 2
  try {
    const opts = {
      type: 'question' as const,
      buttons: quitPromptButtons(terminalClients),
      defaultId: 0,
      cancelId: 2,
      message: 'Terminals are still connected to OrgAI.',
      detail: 'OrgAI can keep running in the background for them, or stop every run and quit.'
    }
    const parent = BrowserWindow.getFocusedWindow()
    response = (parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)).response
  } catch (e) {
    log.warn(`The quit prompt failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    quitPromptOpen = false
  }
  if (response === 0) {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.close()
    goBackground()
  } else if (response === 1) {
    quitAnswered = true
    app.quit()
  } else if (reopenAfterCancel({ platform: process.platform, liveWindows: liveWindowScopes().length, quitting })) {
    // Cancel after the last window closed (Windows, Linux): never leave OrgAI running with nothing on screen.
    createWindow()
  }
}

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
    quitAnswered = true
    quitReason = 'window-closed'
    app.quit()
  } else {
    createWindow()
  }
}

// The last window closed (review H3): a --headless-host launch goes back to the background, macOS stays (Dock), and
// Windows / Linux quit through the shutdown coordinator, asking first only while runs are working without the user.
app.on('window-all-closed', () => {
  // The handoff's wait window was the only window (4.4): closing it never quits; neither does anything before boot.
  if (waitingForHandoff || !booted) return
  const workingRuns = host ? host.runs.workingRunCount() : 0
  const action = windowAllClosedAction({ platform: process.platform, launchedHeadless: hostArgs.headless, quitting, workingRuns })
  if (action === 'quit') {
    quitReason = 'window-closed'
    app.quit()
  }
  else if (action === 'background') goBackground()
  else if (action === 'ask') void askClose(workingRuns)
})

// ---------- Wave 7 (cli-standalone.md 4.4): the app opening while another host owns the data folder ----------

/** An owner that cannot hand over (no answer, older than Wave 7, or not a node / inproc host): the busy-folder dialog. */
class HandoffUnavailableError extends Error {
  constructor(readonly owner: DaemonInfo) {
    super(`The host that owns the data folder (pid ${owner.pid}) did not hand it over.`)
    this.name = 'HandoffUnavailableError'
  }
}

/**
 * Take <dataDir>/run ownership. On an interactive launch whose folder a Node host or the orgai command owns, run the
 * handoff (4.4) and retry once that process has exited (a contender that wins the race starts it again). undefined:
 * the user chose Quit. A --headless-host launch never hands over and never shows anything: it throws as before.
 */
async function acquireDesktopOwnership(dataDir: string, socketServer: HostSocketServer): Promise<HostOwnership | undefined> {
  for (;;) {
    try {
      // Review M11: no listener and no daemon.secret yet; they exist only while Terminal access is on (syncTerminalListener).
      return await acquireHostOwnership({ dataDir, hostKind, appVersion: app.getVersion(), listen: false, onConnection: (s) => socketServer.accept(s) })
    } catch (e) {
      if (hostArgs.headless || !(e instanceof HostAlreadyRunningError)) throw e
      const outcome = await runHandoff(dataDir, e.info)
      if (outcome === 'quit') return undefined
      if (outcome === 'unavailable') throw new HandoffUnavailableError(e.info)
      log.info(`The host that owned the data folder (pid ${e.info.pid}) has exited; taking over.`)
    }
  }
}

/** One handoff from `owner`, with the wait window as its UI. */
async function runHandoff(dataDir: string, owner: DaemonInfo): Promise<HandoffOutcome> {
  waitingForHandoff = true
  log.info(`The data folder is owned by a ${owner.hostKind ?? 'host'} (pid ${owner.pid}); asking it to hand over.`)
  const h = new DesktopHandoff({
    connect: async (timeoutMs) => {
      const r = await connectHost({
        dataDir,
        scopes: ['read', 'configure'],
        clientKind: 'desktop',
        clientVersion: app.getVersion(),
        cwd: homedir(),
        pid: process.pid,
        connectTimeoutMs: timeoutMs,
        callTimeoutMs: timeoutMs
      })
      if (r.ok) {
        const client = r.client
        return { client: { handoff: client.hello.handoff === true, call: (m, p, o) => client.call(m, p, o), close: () => client.close() } }
      }
      if (r.reason === 'draining') return { draining: true }
      return { failed: r.message }
    },
    // Cached liveness: a signal probe per poll, the start time (ps / PowerShell) re-read only every 30 s (the inproc wait
    // can last hours).
    exited: ownerExitCheck(() => readDaemonInfo(dataDir)),
    show: (view) => showHandoffWindow(view),
    log: (m) => log.info(m)
  })
  handoff = h
  try {
    return await h.run(owner)
  } finally {
    handoff = undefined
    showHandoffWindow(undefined)
  }
}

/** second-instance / activate while waiting: the wait window again (when the handoff shows one), focused. */
function reshowHandoffWindow(): void {
  showDockIcon()
  const view = handoff?.view()
  if (view) showHandoffWindow(view)
  if (handoffWindow && !handoffWindow.isDestroyed()) showWindow(handoffWindow)
}

/** Closing the wait window ourselves (a new view or the end of the handoff) is not the user's Quit. */
let closingHandoffWindow = false
/** The data: URL the wait window was last told to load: the one navigation its guard lets through. */
let handoffPageUrl = ''

/**
 * Show (create or update) the handoff's wait window, or close it (undefined). It loads only its own data: page with
 * JavaScript off and no preload; its buttons are links to orgai-handoff:<choice>, caught on navigation and never
 * loaded. Closing it is Quit on Windows and Linux (nothing else would be on screen); on macOS the Dock brings it back.
 */
function showHandoffWindow(view: HandoffView | undefined): void {
  if (!view) {
    const w = handoffWindow
    handoffWindow = undefined
    if (w && !w.isDestroyed()) {
      closingHandoffWindow = true
      try {
        w.destroy()
      } finally {
        closingHandoffWindow = false
      }
    }
    return
  }
  let win = handoffWindow
  if (!win || win.isDestroyed()) {
    const created = new BrowserWindow({
      width: 500,
      height: 280,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'OrgAI',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f7f7f8',
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
    })
    win = created
    handoffWindow = created
    created.on('closed', () => {
      if (handoffWindow === created) handoffWindow = undefined
      if (!closingHandoffWindow && process.platform !== 'darwin') handoff?.choose('quit')
    })
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Fails closed: every navigation but the page itself is stopped; a button's link only names a choice.
    const onNavigate = (e: { url: string; preventDefault(): void }): void => {
      if (e.url === handoffPageUrl) return
      e.preventDefault()
      const choice = handoffChoiceOf(e.url)
      if (choice) handoff?.choose(choice)
    }
    created.webContents.on('will-navigate', onNavigate)
    created.webContents.on('will-redirect', onNavigate)
    created.webContents.on('will-frame-navigate', onNavigate)
    created.once('ready-to-show', () => showWindow(created))
  }
  handoffPageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(handoffPageHtml(view, nativeTheme.shouldUseDarkColors))}`
  void win.loadURL(handoffPageUrl).catch((e: unknown) => log.warn(`The handoff wait window did not load: ${e instanceof Error ? e.message : String(e)}`))
}
