/**
 * HostLauncher (cli-spec 3.2(1)): find the OrgAI app, start it detached (`--headless-host` for a background host, or
 * a desktop window), and watch `<dataDir>/run/daemon.json` for it to become ready or go away.
 *
 * Where the app comes from:
 * - ORGAI_ELECTRON_PATH (plus an optional ORGAI_APP_ROOT passed as the first argument): source 'env'.
 * - A dev checkout: the bundle sits in `<repo>/out/cli` (or the source in `<repo>/src/cli/client` under vitest); the
 *   repo's package.json must be OrgAI's and `out/main/index.js` must be built. The Electron binary is read the way the
 *   electron package computes it (path.txt under node_modules/electron, ELECTRON_OVERRIDE_DIST_PATH honoured) but
 *   without requiring the package, which would download a missing binary with inherited stdio.
 * - A packaged app (cli-spec 7, Wave 6): the bundle sits in `<Resources>/app.asar.unpacked/out/cli`
 *   (packagedLayout.ts `resourcesDirOfCliBundle`), source 'packaged'. Under the packaged launcher the CLI already runs
 *   on the app's own binary (ELECTRON_RUN_AS_NODE=1, build/bin/orgai), so that execPath is the command; else the
 *   layout's app binary (`<Resources>/../MacOS/OrgAI`, `OrgAI.exe`, `orgai`). No arguments: the packaged app loads its
 *   own app.asar. Checked on a local unsigned macOS pack only; Windows and Linux packs are UNVERIFIED.
 *
 * - Installed app discovery (Wave 7, cli-standalone.md 4.1 step 3): macOS /Applications/OrgAI.app, then
 *   ~/Applications/OrgAI.app; Windows the NSIS per-user %LOCALAPPDATA%\Programs\OrgAI\OrgAI.exe, then the per-machine
 *   %ProgramFiles%\OrgAI\OrgAI.exe (default paths, UNVERIFIED for oneClick: false); Linux none (an AppImage has no fixed
 *   place). Source 'installed'. A candidate folder that exists but lacks its binary or app.asar is 'broken' (an error
 *   naming the path) unless a later candidate is complete.
 *
 * Which of these apply follows install.json (installInfo.ts, 3.5): the packaged layout only when it says 'app'; the dev
 * checkout only when there is no install.json at all AND the candidate root has electron.vite.config.ts and electron in
 * its devDependencies (an npm install's own package folder, also named orgai, is never a checkout; neither is a root
 * under node_modules). locate() answers found / absent / broken; only absent lets `--host auto` run in-process.
 *
 * Order: env > packaged > dev checkout > installed. The spawned app never inherits ELECTRON_RUN_AS_NODE (hostSpawnEnv), nor the
 * caller's cwd (hostSpawnCwd, review H1): the CLI often runs in an untrusted clone, Windows searches a spawn's cwd for
 * bare program names first, and a long-lived host would otherwise also keep that folder busy.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DaemonInfo, HostKind, InstallInfo } from '../../shared/types'
import { readDaemonInfo } from '../../main/host/ownership'
import { PACKAGED_PRODUCT_NAME, packagedLayout, resourcesDirOfCliBundle } from '../../main/host/packagedLayout'
import { isLiveProcessCached } from '../../main/host/processInfo'
import { readInstallInfo } from '../installInfo'
import type { HostLauncher, HostLauncherFound } from '../types'
import { SECRET_ENV_PREFIX } from '../secretOverlay'

export const APP_NOT_FOUND = 'OrgAI app not found; set ORGAI_ELECTRON_PATH or use --host inproc'
const POLL_MS = 150

/**
 * What a spawn returns (a ChildProcess fits). `on` is used for 'error' (the command could not be executed: Node emits
 * it on the next tick, and an unheard 'error' would crash the CLI) and 'exit' (the app quit before it was ready).
 */
export interface SpawnedChild {
  pid?: number
  unref(): void
  on?(event: string, listener: (...args: unknown[]) => void): unknown
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild

export interface LauncherOptions {
  dataDir: string
  /** The userDataDir; passed to the host as ORGAI_DATA_DIR only when the user chose it. */
  userDataDir: string
  userChoseDataDir: boolean
  env?: NodeJS.ProcessEnv
  /** Where this module (or the bundle) lives; default its own directory. */
  bundleDir?: string
  spawn?: SpawnFn
  isLive?: (pid: number, startTime?: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The runtime this CLI runs on (tests): default process.execPath and process.versions.electron. */
  runtime?: { execPath: string; electron?: string }
  /** Default process.platform (tests). */
  platform?: NodeJS.Platform
  /** The spawned host's cwd (tests); default {@link hostSpawnCwd}. */
  cwd?: (command: string) => string
  /** install.json as read (tests); default readInstallInfo next to the bundle. */
  installInfo?: InstallInfo
  /** The home folder for ~/Applications (tests); default env.HOME, else os.homedir(). */
  home?: string
  /** File existence for installed-app discovery and the checkout markers (tests); default fs.existsSync. */
  exists?: (path: string) => boolean
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where the spawned host runs: the app binary's own folder when the command is an absolute path to an existing
 * folder's file, else the home folder. Never the caller's cwd (review H1).
 */
export function hostSpawnCwd(command: string, deps: { home?: string; isDir?: (p: string) => boolean } = {}): string {
  const dirOk = deps.isDir ?? isDir
  if (isAbsolute(command)) {
    const dir = dirname(command)
    if (dirOk(dir)) return dir
  }
  return deps.home ?? homedir()
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** The marker file only a source checkout has (the npm package never ships it). */
export const CHECKOUT_MARKER = 'electron.vite.config.ts'

/** True when any segment of `dir` is node_modules (an installed package, never a checkout). */
function underNodeModules(dir: string): boolean {
  return resolve(dir)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === 'node_modules')
}

/**
 * An OrgAI source checkout (cli-standalone.md 4.1 step 3): package.json named orgai with electron in its
 * devDependencies, electron.vite.config.ts beside it, and not inside node_modules. The npm package is also named orgai
 * but has neither marker.
 */
export function isOrgAICheckout(dir: string, exists: (p: string) => boolean = existsSync): boolean {
  if (underNodeModules(dir)) return false
  if (!exists(join(dir, CHECKOUT_MARKER))) return false
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; devDependencies?: unknown }
    const dev = pkg.devDependencies
    return pkg.name === 'orgai' && !!dev && typeof dev === 'object' && !Array.isArray(dev) && Object.hasOwn(dev, 'electron')
  } catch {
    return false
  }
}

/** The repo root of a dev checkout: two levels up from out/cli, three from src/cli/client. */
export function devAppRoot(bundleDir: string, exists?: (p: string) => boolean): string | undefined {
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    const dir = resolve(bundleDir, ...up)
    if (isOrgAICheckout(dir, exists)) return dir
  }
  return undefined
}

/** One place an installed OrgAI may live. */
export interface InstalledAppCandidate {
  /** The folder whose presence means "installed here" (OrgAI.app, or the install folder on Windows). */
  root: string
  /** The app executable. */
  binary: string
  /** <resources>/app.asar */
  asar: string
}

/** An environment variable, matched case-insensitively on Windows (an injected env is a plain object). */
function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name]
  if (direct !== undefined || platform !== 'win32') return direct?.trim() || undefined
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key ? env[key]?.trim() || undefined : undefined
}

/**
 * Where installed-app discovery looks, in order (4.1 step 3): macOS /Applications then ~/Applications; Windows the
 * per-user NSIS folder then Program Files (only absolute values of LOCALAPPDATA / ProgramFiles); Linux none.
 */
export function installedAppCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): InstalledAppCandidate[] {
  if (platform === 'darwin') {
    const p = posix
    const roots = ['/Applications', ...(home && p.isAbsolute(home) ? [p.join(home, 'Applications')] : [])].map((d) => p.join(d, `${PACKAGED_PRODUCT_NAME}.app`))
    return roots.map((root) => {
      const layout = packagedLayout('darwin', p.join(root, 'Contents', 'Resources'))
      return { root, binary: layout.appBinary, asar: p.join(layout.resourcesDir, 'app.asar') }
    })
  }
  if (platform === 'win32') {
    const bases = [
      envValue(env, 'LOCALAPPDATA', platform) && win32.join(envValue(env, 'LOCALAPPDATA', platform)!, 'Programs'),
      envValue(env, 'ProgramFiles', platform)
    ].filter((b): b is string => !!b && win32.isAbsolute(b))
    return bases.map((base) => {
      const root = win32.join(base, PACKAGED_PRODUCT_NAME)
      const layout = packagedLayout('win32', win32.join(root, 'resources'))
      return { root, binary: layout.appBinary, asar: win32.join(layout.resourcesDir, 'app.asar') }
    })
  }
  return []
}

/** The installed app's broken-install error. */
export function installedAppBroken(root: string, missing: string): string {
  return `The OrgAI app at ${root} is incomplete (${missing} is missing); reinstall OrgAI, set ORGAI_ELECTRON_PATH or use --host inproc`
}

/**
 * Installed-app discovery: the first complete candidate is found; else the first candidate folder that exists but
 * lacks its binary or app.asar is broken (naming the missing path); else undefined (absent).
 */
export function discoverInstalledApp(
  candidates: readonly InstalledAppCandidate[],
  exists: (p: string) => boolean = existsSync
): HostLauncherFound | { error: string; path: string } | undefined {
  let broken: { error: string; path: string } | undefined
  for (const c of candidates) {
    if (!exists(c.root)) continue
    const missing = !exists(c.binary) ? c.binary : !exists(c.asar) ? c.asar : undefined
    if (missing === undefined) return { command: c.binary, args: [], source: 'installed' }
    broken ??= { error: installedAppBroken(c.root, missing), path: missing }
  }
  return broken
}

/** The Electron binary of the app root's electron package, or undefined when it is not installed. */
export function electronBinaryOf(appRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const pkgJson = createRequire(join(appRoot, 'package.json')).resolve('electron/package.json')
    const dir = dirname(pkgJson)
    const pathFile = join(dir, 'path.txt')
    const rel = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : ''
    const override = env.ELECTRON_OVERRIDE_DIST_PATH?.trim()
    const bin = override ? join(override, rel || 'electron') : rel ? join(dir, 'dist', rel) : undefined
    return bin && existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

/** The packaged app's missing-binary error. */
export function packagedAppMissing(path: string): string {
  return `The OrgAI app next to this orgai command is missing (${path}); reinstall OrgAI or set ORGAI_ELECTRON_PATH`
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  return real(a) === real(b)
}

/**
 * The packaged app for a bundle in `<Resources>/app.asar.unpacked/out/cli`, undefined for any other bundle folder.
 * The running binary wins when this CLI runs on Electron and that binary is the layout's app binary.
 */
export function packagedApp(
  bundleDir: string,
  platform: NodeJS.Platform,
  runtime: { execPath: string; electron?: string }
): { command: string; args: string[]; source: 'packaged' } | { error: string; path: string } | undefined {
  const res = resourcesDirOfCliBundle(bundleDir, platform)
  if (res === undefined) return undefined
  const { appBinary } = packagedLayout(platform, res)
  if (runtime.electron && runtime.execPath && samePath(runtime.execPath, appBinary)) return { command: runtime.execPath, args: [], source: 'packaged' }
  if (existsSync(appBinary)) return { command: appBinary, args: [], source: 'packaged' }
  return { error: packagedAppMissing(appBinary), path: appBinary }
}

/** Variables a command read a secret from (consumeSecretEnv); never handed to a spawned host. */
const consumedSecretVars = new Set<string>()

/**
 * Read a secret from the environment variable `name` (--from-env, --client-secret-from-env, decide --secret
 * NAME=VAR) and take it out of `env` at once, so a host this command starts later, and that host's agents, never
 * inherit it (review M13). hostSpawnEnv also leaves the name out from then on, whatever environment it is given.
 * Commands read their secrets before they connect (withHost may start a host).
 */
export function consumeSecretEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  consumedSecretVars.add(name)
  delete env[name]
  return value
}

/** Tests: forget the consumed names. */
export function resetConsumedSecretEnv(): void {
  consumedSecretVars.clear()
}

/**
 * The environment a spawned host gets: no ORGAI_SECRET_*, no variable a secret was read from (consumeSecretEnv), no
 * ELECTRON_RUN_AS_NODE, ORGAI_DATA_DIR only when chosen.
 */
export function hostSpawnEnv(env: NodeJS.ProcessEnv, opts: { userDataDir: string; userChoseDataDir: boolean }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith(SECRET_ENV_PREFIX) || k === 'ELECTRON_RUN_AS_NODE' || k === 'ORGAI_DATA_DIR') continue
    if (consumedSecretVars.has(k)) continue
    out[k] = v
  }
  if (opts.userChoseDataDir) out.ORGAI_DATA_DIR = opts.userDataDir
  return out
}

export function createLauncher(opts: LauncherOptions): HostLauncher {
  const env = opts.env ?? process.env
  const isLive = opts.isLive ?? ((pid: number, start?: string) => isLiveProcessCached(pid, start))
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const spawnFn: SpawnFn = opts.spawn ?? ((c, a, o) => nodeSpawn(c, a, o))

  const exists = opts.exists ?? existsSync
  const platform = opts.platform ?? process.platform
  let installInfo: InstallInfo | undefined = opts.installInfo

  const resolveApp: HostLauncher['resolve'] = () => {
    const electronPath = env.ORGAI_ELECTRON_PATH?.trim()
    if (electronPath) {
      const appRoot = env.ORGAI_APP_ROOT?.trim()
      return { command: electronPath, args: appRoot ? [resolve(appRoot)] : [], source: 'env' }
    }
    const bundleDir = opts.bundleDir ?? moduleDir()
    installInfo ??= readInstallInfo({ bundleDir })
    // The packaged layout only for a bundle install.json marks as the app's own (4.1 step 3).
    if (installInfo.source === 'file' && installInfo.channel === 'app') {
      const packaged = packagedApp(bundleDir, platform, opts.runtime ?? { execPath: process.execPath, electron: process.versions.electron })
      if (packaged) return packaged
    }
    // A dev checkout only without any install.json (an unreadable one is never a checkout).
    const root = installInfo.source === 'absent' ? devAppRoot(bundleDir, exists) : undefined
    if (root) {
      if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
        return { error: `The OrgAI app in ${root} is not built (run npm run build); set ORGAI_ELECTRON_PATH or use --host inproc`, path: root }
      }
      const bin = electronBinaryOf(root, env)
      if (bin) return { command: bin, args: [root], source: 'dev' }
    }
    const home = opts.home ?? (env.HOME?.trim() || homedir())
    const installed = discoverInstalledApp(installedAppCandidates(platform, env, home), exists)
    if (installed) return installed
    return { error: APP_NOT_FOUND }
  }

  const ready = (d: DaemonInfo | null, notInstanceId?: string, hostKinds?: readonly HostKind[]): d is DaemonInfo =>
    !!d &&
    d.state === 'ready' &&
    d.hostInstanceId !== notInstanceId &&
    // A daemon.json without hostKind comes from an older Electron host (inproc hosts always write theirs).
    (!hostKinds || d.hostKind === undefined || hostKinds.includes(d.hostKind)) &&
    isLive(d.pid, d.processStartTime)

  /** The last spawned app: a spawn error, or how it exited (code / signal) once it did. */
  let child: { error?: Error; exited?: { code: number | null; signal: string | null } } | undefined

  /** Why the spawned app can no longer become ready, or undefined while it may. */
  const childFailure = (): string | undefined => {
    if (!child) return undefined
    if (child.error) return child.error.message
    const ex = child.exited
    // Exit 0 is a hand-off: the single-instance lock went to a running OrgAI, which answers instead.
    if (!ex || ex.code === 0) return undefined
    if (ex.code === 6) return 'OrgAI exited (code 6): another OrgAI host owns this data folder. See `orgai daemon status`.'
    return ex.code !== null ? `OrgAI exited (code ${ex.code}) before it was ready. See \`orgai daemon logs\`.` : `OrgAI was stopped (${ex.signal ?? 'signal'}) before it was ready.`
  }

  return {
    resolve: resolveApp,

    locate() {
      const app = resolveApp()
      if (!('error' in app)) return { status: 'found', ...app }
      if (app.error === APP_NOT_FOUND) return { status: 'absent', message: app.error }
      // A missing packaged binary or an unbuilt dev checkout: the error carries the path it is about.
      return { status: 'broken', path: app.path ?? '', message: app.error }
    },

    spawn({ headless, run, app: located }) {
      const app = located ?? resolveApp()
      if ('error' in app) throw new Error(app.error)
      const args = [...app.args, ...(headless ? ['--headless-host'] : []), ...(run ? ['--run', run] : [])]
      const state: NonNullable<typeof child> = {}
      child = state
      const proc = spawnFn(app.command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
        cwd: (opts.cwd ?? hostSpawnCwd)(app.command),
        env: hostSpawnEnv(env, opts)
      })
      // Listen before the next tick: Node emits 'error' asynchronously, and with no listener it would crash the CLI.
      proc.on?.('error', (e) => {
        state.error ??= e instanceof Error ? e : new Error(String(e))
      })
      proc.on?.('exit', (code, signal) => {
        state.exited = { code: typeof code === 'number' ? code : null, signal: typeof signal === 'string' ? signal : null }
      })
      proc.unref()
      return proc.pid !== undefined ? { pid: proc.pid } : {}
    },

    current() {
      const d = readDaemonInfo(opts.dataDir)
      return d && isLive(d.pid, d.processStartTime) ? d : null
    },

    async waitForReady({ timeoutMs, notInstanceId, hostKinds }) {
      const deadline = now() + timeoutMs
      for (;;) {
        const d = readDaemonInfo(opts.dataDir)
        if (ready(d, notInstanceId, hostKinds)) return d
        const failure = childFailure()
        if (failure) throw new Error(failure)
        if (now() >= deadline) return null
        await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())))
      }
    },

    async waitForGone({ timeoutMs, hostInstanceId }) {
      const deadline = now() + timeoutMs
      for (;;) {
        const d = readDaemonInfo(opts.dataDir)
        if (!d || !isLive(d.pid, d.processStartTime) || (hostInstanceId !== undefined && d.hostInstanceId !== hostInstanceId)) return true
        if (now() >= deadline) return false
        await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())))
      }
    }
  }
}
