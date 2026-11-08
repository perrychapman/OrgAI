/**
 * `orgai doctor` (cli-spec 6.1; cli-standalone-default.md 4.5): checks of the install (how this CLI runs, the orgai
 * command on PATH), the data folder and its product marker, whether another orgai owns the folder, the agent runtimes
 * and the vault custody, printed as ok / warn / fail lines (json: an array of { id, status, detail }). Hostless: it reads
 * files and never starts or talks to a host. Exit 1 when any check fails, else 0. Never prints a secret.
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliShimPath, parseCliShim } from '../../main/host/packagedLayout'
import { gitExecutable, neutralCwd } from '../../main/host/systemBinaries'
import type { DaemonInfo } from '../../shared/types'
import { readProductMarker } from '../../main/store/productMarker'
import { installChecks } from '../doctor/installChecks'
import { runtimeChecks } from '../doctor/runtimeChecks'
import { secretsChecks } from '../doctor/secretsChecks'
import type { DoctorCheckGroup } from '../doctor/types'
import { parseFlags } from '../flags'
import { emit, safeLine, styleFor } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export type CheckStatus = 'ok' | 'warn' | 'fail'

/** The largest daemon.json doctor reads (the host's own cap, ownership.ts DAEMON_JSON_MAX_BYTES). */
export const DAEMON_JSON_MAX_BYTES = 64 * 1024

export interface DoctorCheck {
  id: string
  status: CheckStatus
  detail: string
}

/** Injectable probes (tests). */
export const doctorProbes = {
  nodeVersion: (): string => process.versions.node,
  uid: (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined),
  pidAlive: (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  /** git by the path from gitExecutable, run from the temp dir: never a planted git.exe in the cwd (review H1). */
  gitVersion: (): Promise<string> =>
    new Promise((resolve, reject) => {
      const bin = gitExecutable()
      if (!bin) {
        reject(new Error('git.exe was not found on PATH'))
        return
      }
      execFile(bin, ['--version'], { timeout: 5000, windowsHide: true, cwd: neutralCwd() }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
    }),
  /** The Electron version when this CLI runs on the app's own binary (ELECTRON_RUN_AS_NODE), else undefined. */
  electronVersion: (): string | undefined => process.versions.electron,
  /** Where this module sits: out/cli in a bundle . */
  bundleDir: (): string => {
    try {
      return dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  },
  homeDir: (): string => homedir(),
  /** Reads a text file (throws as fs does: ENOENT when missing). */
  readText: (path: string): string => readFileSync(path, 'utf8'),
  exists: (path: string): boolean => existsSync(path),
  realpath: (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
}

/** A line of the packaged launcher (build/bin/orgai): a file at the shim path that reads through to it is a link to one. */
export const PACKAGED_LAUNCHER_MARK = 'The orgai command of a packaged OrgAI'

const SHIM_NOT_INSTALLED = 'No old app command found (nothing to remove)'

/** How this CLI runs: a development checkout or a standalone bundle. */
export function installCheck(): DoctorCheck {
  const bundleDir = doctorProbes.bundleDir()
  const root = devCheckoutRoot(bundleDir)
  if (root) return { id: 'install', status: 'ok', detail: `Development checkout ${root}` }
  return { id: 'install', status: 'ok', detail: `Standalone bundle ${bundleDir}` }
}

/** The checkout root when this bundle sits in out/cli (or src/cli/<dir>) of an OrgAI source checkout, else undefined. */
function devCheckoutRoot(bundleDir: string): string | undefined {
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    const root = resolve(bundleDir, ...up)
    if (root.split(/[\\/]+/).includes('node_modules')) continue
    if (existsSync(join(root, 'electron.vite.config.ts'))) return root
  }
  return undefined
}

/**
 * The old app's orgai shim (cli-spec 7(3)), read only: never written or repaired here. Missing is fine (nothing to remove); a foreign
 * file, a shim pointing at another install or at a missing launcher, and a shim folder that is not on PATH warn.
 */
export function shimCheck(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DoctorCheck {
  const shim = cliShimPath(platform, env, doctorProbes.homeDir())
  let text: string
  try {
    text = doctorProbes.readText(shim)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { id: 'shim', status: 'ok', detail: SHIM_NOT_INSTALLED }
    return { id: 'shim', status: 'warn', detail: `${shim} could not be read: ${(e as Error).message}` }
  }
  const fold = (p: string): string => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p)
  const parsed = parseCliShim(text, platform, env)
  let target: string
  let viaLink = false
  if (parsed) target = parsed.launcher
  else {
    // A link the user made to a packaged launcher (build/bin/orgai says links are followed) runs that OrgAI.
    const real = doctorProbes.realpath(shim)
    const linkToLauncher = fold(real) !== fold(shim) && text.includes(PACKAGED_LAUNCHER_MARK)
    if (!linkToLauncher) return { id: 'shim', status: 'warn', detail: `${shim} is not an OrgAI shim (another program's file); OrgAI leaves it alone` }
    target = real
    viaLink = true
  }
  if (!doctorProbes.exists(target)) {
    return { id: 'shim', status: 'warn', detail: `${shim} points at an OrgAI that is gone (${target}); it is the old app command. Install the standalone one: npm i -g orgai-cli` }
  }
  // Any live shim is the old app command: it is withdrawn, so it is never advised onto PATH.
  return { id: 'shim', status: 'warn', detail: `${shim}${viaLink ? ' (a link)' : ''} is the old OrgAI app command (no longer supported); remove it (App settings > Terminal, or delete the file) and install the standalone one: npm i -g orgai-cli` }
}

const MIN_NODE_MAJOR = 22

export const runDoctor: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
  const checks: DoctorCheck[] = []
  const add = (id: string, status: CheckStatus, detail: string): void => {
    checks.push({ id, status, detail })
  }

  // Node
  const nodeV = doctorProbes.nodeVersion()
  const major = Number(nodeV.split('.')[0])
  add('node', major >= MIN_NODE_MAJOR ? 'ok' : 'fail', major >= MIN_NODE_MAJOR ? `Node ${nodeV}` : `Node ${nodeV}; OrgAI needs Node ${MIN_NODE_MAJOR} or later`)

  // How this CLI runs (packaged app, dev checkout, standalone bundle)
  checks.push(installCheck())

  // Data folder
  const via = ctx.globals.dataDir ? '--data-dir' : ctx.env.ORGAI_CLI_DATA_DIR ? 'ORGAI_CLI_DATA_DIR' : 'the platform default'
  let dataExists = false
  try {
    dataExists = lstatSync(ctx.paths.dataDir).isDirectory()
  } catch {
    dataExists = false
  }
  add('data-dir', dataExists ? 'ok' : 'warn', `${ctx.paths.dataDir} (from ${via})${dataExists ? '' : ': does not exist yet (orgai creates it on first start)'}`)
  const marker = readProductMarker(ctx.paths.userDataDir)
  add(
    'product',
    marker.state === 'marked' && marker.product === 'orgai-cli' ? 'ok' : marker.state === 'absent' ? 'ok' : 'fail',
    marker.state === 'marked' ? `${ctx.paths.userDataDir} is marked ${marker.product}` : marker.state === 'absent' ? `${ctx.paths.userDataDir} has no product marker yet (orgai writes it on first start)` : `${ctx.paths.userDataDir}/product.json is not readable`
  )

  // run/ directory
  const runDir = join(ctx.paths.dataDir, 'run')
  let runDirOk = false
  try {
    const st = lstatSync(runDir)
    const problems: string[] = []
    if (st.isSymbolicLink()) problems.push('is a symbolic link')
    else if (!st.isDirectory()) problems.push('is not a folder')
    if (ctx.platform !== 'win32') {
      if ((st.mode & 0o777) !== 0o700) problems.push(`has mode ${(st.mode & 0o777).toString(8)}, expected 700`)
      const uid = doctorProbes.uid()
      if (uid !== undefined && st.uid !== uid) problems.push('is owned by another user')
    }
    runDirOk = problems.length === 0
    add('run-dir', runDirOk ? 'ok' : 'fail', runDirOk ? `${runDir} is private to you` : `${runDir} ${problems.join(', ')}`)
  } catch {
    add('run-dir', 'ok', `${runDir} does not exist (orgai has not run on this data folder yet)`)
  }

  // daemon.json
  let daemon: DaemonInfo | undefined
  let daemonAlive = false
  try {
    // Capped like the host's own reader (ownership.ts): a huge or odd file is reported, never read whole.
    const daemonPath = join(runDir, 'daemon.json')
    const st = lstatSync(daemonPath)
    if (!st.isFile()) throw new Error('it is not a regular file')
    if (st.size > DAEMON_JSON_MAX_BYTES) throw new Error(`it is larger than ${DAEMON_JSON_MAX_BYTES / 1024} KB`)
    const raw = readFileSync(daemonPath, 'utf8')
    const parsed = JSON.parse(raw) as DaemonInfo
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number' || typeof parsed.hostInstanceId !== 'string') throw new Error('unexpected shape')
    daemon = parsed
    daemonAlive = doctorProbes.pidAlive(parsed.pid)
    add('daemon-json', daemonAlive ? 'ok' : 'warn', daemonAlive ? `Another orgai is running (pid ${parsed.pid}${parsed.ownerCwd ? `, started in ${safeLine(parsed.ownerCwd)}` : ''}, ${parsed.state}); commands that need a host are refused until it quits` : `daemon.json names pid ${parsed.pid}, which is not running (a stale file; the next orgai replaces it)`)
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    add('daemon-json', missing ? 'ok' : 'fail', missing ? 'No other orgai is running on this folder' : `daemon.json could not be read: ${(e as Error).message}`)
  }

  // The orgai command on PATH (read only)
  checks.push(shimCheck(ctx.platform, ctx.env))

  // git
  try {
    add('git', 'ok', await doctorProbes.gitVersion())
  } catch (e) {
    add('git', 'warn', `git was not found on PATH (${(e as Error).message}); code projects need it for worktrees`)
  }

  // Mock mode
  const mock = ctx.env.ORGAI_MOCK === '1'
  add('mock', 'ok', mock ? 'Mock mode: no tokens are spent' : 'Off')

  // Wave 7 groups (src/cli/doctor): install channel and PATH, agent runtimes, secure storage. Each never throws.
  const groups: DoctorCheckGroup[] = [installChecks, runtimeChecks, secretsChecks]
  for (const group of groups) {
    try {
      checks.push(...(await group({ ctx })))
    } catch (e) {
      add('doctor', 'warn', `A check failed to run: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  const failed = checks.some((c) => c.status === 'fail')
  const warned = checks.filter((c) => c.status === 'warn').length
  emit(ctx, { ok: !failed, checks }, () => {
    const st = styleFor(ctx)
    const mark = (s: CheckStatus): string => (s === 'ok' ? st.green('ok  ') : s === 'warn' ? st.yellow('warn') : st.red('fail'))
    return [...checks.map((c) => `${mark(c.status)}  ${c.id.padEnd(16)} ${safeLine(c.detail)}`), failed ? st.red('Some checks failed.') : warned ? st.yellow(`${warned} ${warned === 1 ? 'check needs' : 'checks need'} a look (see the warnings above).`) : 'All checks passed.']
  })
  return failed ? EXIT.failure : EXIT.ok
}
