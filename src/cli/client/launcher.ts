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
 * - A packaged app (Resources/bin launcher) is Wave 6: UNVERIFIED, not built.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DaemonInfo, HostKind } from '../../shared/types'
import { readDaemonInfo } from '../../main/host/ownership'
import { isLiveProcessCached } from '../../main/host/processInfo'
import type { HostLauncher } from '../types'
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

/** The environment a spawned host gets: no ORGAI_SECRET_*, no ELECTRON_RUN_AS_NODE, ORGAI_DATA_DIR only when chosen. */
export function hostSpawnEnv(env: NodeJS.ProcessEnv, opts: { userDataDir: string; userChoseDataDir: boolean }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith(SECRET_ENV_PREFIX) || k === 'ELECTRON_RUN_AS_NODE' || k === 'ORGAI_DATA_DIR') continue
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
    const root = devAppRoot(opts.bundleDir ?? moduleDir())
    if (root) {
      if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
        return { error: `The OrgAI app in ${root} is not built (run npm run build); set ORGAI_ELECTRON_PATH or use --host inproc` }
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

    spawn({ headless, run }) {
      const app = resolveApp()
      if ('error' in app) throw new Error(app.error)
      const args = [...app.args, ...(headless ? ['--headless-host'] : []), ...(run ? ['--run', run] : [])]
      const state: NonNullable<typeof child> = {}
      child = state
      const proc = spawnFn(app.command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
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
