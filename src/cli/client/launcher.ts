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
 * Wave 7 (cli-standalone.md 4.2): startBackground('node') starts the detached Node host instead, `process.execPath
 * <orgai.mjs> daemon run-node` with stdio appended to `<userDataDir>/logs/node-host.log` (refused on Electron).
 *
 * Order: env > packaged > dev checkout. The spawned app never inherits ELECTRON_RUN_AS_NODE (hostSpawnEnv), nor the
 * caller's cwd (hostSpawnCwd, review H1): the CLI often runs in an untrusted clone, Windows searches a spawn's cwd for
 * bare program names first, and a long-lived host would otherwise also keep that folder busy.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DaemonInfo, HostKind } from '../../shared/types'
import { readDaemonInfo } from '../../main/host/ownership'
import { packagedLayout, resourcesDirOfCliBundle } from '../../main/host/packagedLayout'
import { isLiveProcessCached } from '../../main/host/processInfo'
import type { DaemonRuntime, HostLauncher } from '../types'
import { SECRET_ENV_PREFIX } from '../secretOverlay'

export const APP_NOT_FOUND = 'OrgAI app not found; set ORGAI_ELECTRON_PATH or use --host inproc'
const POLL_MS = 150

/** The Node host's stdio file under `<userDataDir>/logs` (Wave 7, cli-standalone.md 4.2). */
export const NODE_HOST_LOG = 'node-host.log'
/** Past this size node-host.log is moved to {@link NODE_HOST_OLD_LOG} before the next Node host starts (review round 1). */
export const NODE_HOST_LOG_MAX_BYTES = 5 * 1024 * 1024
/** The one older generation of node-host.log (replaced at each rotation). */
export const NODE_HOST_OLD_LOG = 'node-host.old.log'

/**
 * Keep node-host.log bounded: when it is past `maxBytes`, rename it to node-host.old.log (replacing the older one). A
 * failure (a missing file, Windows refusing to rename a file a host still has open, a concurrent starter that rotated
 * first) leaves things as they are. Returns whether it rotated.
 */
export function rotateNodeHostLog(logsDir: string, maxBytes = NODE_HOST_LOG_MAX_BYTES): boolean {
  const file = join(logsDir, NODE_HOST_LOG)
  try {
    if (statSync(file).size <= maxBytes) return false
    renameSync(file, join(logsDir, NODE_HOST_OLD_LOG))
    return true
  } catch {
    return false
  }
}

/** The hidden command line a Node host runs: `<execPath> <orgai.mjs> daemon run-node`. */
export const NODE_HOST_ARGS = ['daemon', 'run-node'] as const
/** What `--runtime node` needs (cli-standalone.md 4.2). */
export const NODE_HOST_NEEDS_NODE = 'The Node background host comes with the npm package: npm i -g orgai'
/** Host kinds each background runtime becomes. */
export const RUNTIME_HOST_KINDS: Readonly<Record<DaemonRuntime, readonly HostKind[]>> = {
  app: ['headless-host', 'desktop'],
  node: ['node']
}

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
  /** The orgai.mjs a Node host runs (tests); default {@link cliBundleEntry}. */
  cliEntry?: string
}

/**
 * The orgai.mjs bundle a Node host runs: `<bundleDir>/orgai.mjs` (the bundle, whose chunks all sit in out/cli), else a
 * dev checkout's built `out/cli/orgai.mjs` (sources under vitest), else undefined.
 */
export function cliBundleEntry(bundleDir: string): string | undefined {
  const here = join(bundleDir, 'orgai.mjs')
  if (existsSync(here)) return here
  const root = devAppRoot(bundleDir)
  const built = root ? join(root, 'out', 'cli', 'orgai.mjs') : undefined
  return built && existsSync(built) ? built : undefined
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

function isOrgAIRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return pkg.name === 'orgai'
  } catch {
    return false
  }
}

/** The repo root of a dev checkout: two levels up from out/cli, three from src/cli/client. */
export function devAppRoot(bundleDir: string): string | undefined {
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    const dir = resolve(bundleDir, ...up)
    if (isOrgAIRoot(dir)) return dir
  }
  return undefined
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

  const resolveApp: HostLauncher['resolve'] = () => {
    const electronPath = env.ORGAI_ELECTRON_PATH?.trim()
    if (electronPath) {
      const appRoot = env.ORGAI_APP_ROOT?.trim()
      return { command: electronPath, args: appRoot ? [resolve(appRoot)] : [], source: 'env' }
    }
    const bundleDir = opts.bundleDir ?? moduleDir()
    const packaged = packagedApp(bundleDir, opts.platform ?? process.platform, opts.runtime ?? { execPath: process.execPath, electron: process.versions.electron })
    if (packaged) return packaged
    const root = devAppRoot(bundleDir)
    if (root) {
      if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
        return { error: `The OrgAI app in ${root} is not built (run npm run build); set ORGAI_ELECTRON_PATH or use --host inproc`, path: root }
      }
      const bin = electronBinaryOf(root, env)
      if (bin) return { command: bin, args: [root], source: 'dev' }
    }
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

  /**
   * Why the spawned app can no longer become ready, or undefined while it may. `d`: daemon.json as just read and
   * `hostKinds` the kinds the caller waits for.
   */
  const childFailure = (d: DaemonInfo | null, hostKinds?: readonly HostKind[]): string | undefined => {
    if (!child) return undefined
    if (child.error) return child.error.message
    const ex = child.exited
    // Exit 0 is a hand-off: the single-instance lock (or, for a Node host, the data folder) went to a running OrgAI,
    // which answers instead. A ready host of a kind the caller does not wait for never will: say so now, not at the
    // timeout.
    if (ex?.code === 0 && hostKinds && d?.state === 'ready' && d.hostKind !== undefined && !hostKinds.includes(d.hostKind) && isLive(d.pid, d.processStartTime)) {
      return `Another OrgAI host (${d.hostKind}, pid ${d.pid}) took this data folder first. See \`orgai daemon status\`.`
    }
    if (!ex || ex.code === 0) return undefined
    if (ex.code === 6) return 'OrgAI exited (code 6): another OrgAI host owns this data folder. See `orgai daemon status`.'
    return ex.code !== null ? `OrgAI exited (code ${ex.code}) before it was ready. See \`orgai daemon logs\`.` : `OrgAI was stopped (${ex.signal ?? 'signal'}) before it was ready.`
  }

  /** Spawn detached with the host environment and cwd, and track the child for waitForReady. */
  const launch = (command: string, args: string[], stdio: SpawnOptions['stdio']): { pid?: number } => {
    const state: NonNullable<typeof child> = {}
    child = state
    const proc = spawnFn(command, args, {
      detached: true,
      stdio,
      windowsHide: true,
      shell: false,
      cwd: (opts.cwd ?? hostSpawnCwd)(command),
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
      return launch(app.command, args, 'ignore')
    },

    startBackground(runtime, o = {}) {
      if (runtime === 'app') {
        const app = o.app ?? resolveApp()
        if ('error' in app) throw new Error(app.error)
        return { ...launch(app.command, [...app.args, '--headless-host'], 'ignore'), hostKinds: RUNTIME_HOST_KINDS.app }
      }
      const rt = opts.runtime ?? { execPath: process.execPath, electron: process.versions.electron }
      // Under the packaged launcher execPath is the Electron binary, and index.ts strips ELECTRON_RUN_AS_NODE.
      if (rt.electron) throw new Error(NODE_HOST_NEEDS_NODE)
      const entry = opts.cliEntry ?? cliBundleEntry(opts.bundleDir ?? moduleDir())
      if (!entry) throw new Error('The orgai bundle (orgai.mjs) was not found next to this command; build it with npm run build, or reinstall orgai.')
      const logsDir = join(opts.userDataDir, 'logs')
      mkdirSync(logsDir, { recursive: true, mode: 0o700 })
      rotateNodeHostLog(logsDir)
      const fd = openSync(join(logsDir, NODE_HOST_LOG), 'a', 0o600)
      try {
        // detached: setsid() on POSIX (no controlling terminal, no SIGHUP when this terminal closes); on Windows a new
        // process group, hidden.
        return { ...launch(rt.execPath, [entry, ...NODE_HOST_ARGS], ['ignore', fd, fd]), hostKinds: RUNTIME_HOST_KINDS.node }
      } finally {
        // The child holds its own copy of the descriptor.
        closeSync(fd)
      }
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
        const failure = childFailure(d, hostKinds)
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
