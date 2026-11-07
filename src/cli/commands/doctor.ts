/**
 * `orgai doctor` (cli-spec 6.1): checks of the install (how this CLI runs, the orgai shim on PATH; cli-spec 7), the
 * data folder, the host and the connections, printed as
 * ok / warn / fail lines (json: an array of { id, status, detail }). Exit 1 when any check fails, else 0. Never
 * prints a secret: auth and connection checks report states and labels only.
 */
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliShimPath, packagedLayout, parseCliShim, resourcesDirOfCliBundle, transientInstallReason } from '../../main/host/packagedLayout'
import { gitExecutable, neutralCwd } from '../../main/host/systemBinaries'
import { isProxyConnection, type AuthStatusResult, type ConnectionInfo, type DaemonInfo } from '../../shared/types'
import { devAppRoot } from '../client/launcher'
import { parseFlags } from '../flags'
import { emit, safeLine, styleFor } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type ConnectResult } from '../types'

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
  /** Where this module sits: out/cli in a bundle (packaged: `<Resources>/app.asar.unpacked/out/cli`). */
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

const SHIM_NOT_INSTALLED = 'The orgai command is not installed (App settings > General > Advanced settings > Terminal)'

/** How this CLI runs (cli-spec 7): packaged app, dev checkout or a standalone bundle; warns for a transient app copy. */
export function installCheck(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DoctorCheck {
  const bundleDir = doctorProbes.bundleDir()
  const res = resourcesDirOfCliBundle(bundleDir, platform)
  if (res !== undefined) {
    const electron = doctorProbes.electronVersion()
    const runtime = `${electron ? `Electron ${electron}, ` : ''}Node ${doctorProbes.nodeVersion()}`
    const transient = transientInstallReason(platform, res, env)
    return transient
      ? { id: 'install', status: 'warn', detail: `Packaged OrgAI at ${res} (${runtime}). ${transient}` }
      : { id: 'install', status: 'ok', detail: `Packaged OrgAI at ${res} (${runtime})` }
  }
  const root = devAppRoot(bundleDir)
  if (root) return { id: 'install', status: 'ok', detail: `Development checkout ${root}` }
  return { id: 'install', status: 'ok', detail: `Standalone bundle ${bundleDir}` }
}

/**
 * The user-level orgai shim (cli-spec 7(3)), read only: never written or repaired here. Missing is fine; a foreign
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
  const res = resourcesDirOfCliBundle(doctorProbes.bundleDir(), platform)
  const ownLauncher = res !== undefined ? packagedLayout(platform, res).launcher : undefined
  const fold = (p: string): string => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p)
  const same = (a: string, b: string): boolean => fold(doctorProbes.realpath(a)) === fold(doctorProbes.realpath(b))
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
    return { id: 'shim', status: 'warn', detail: `${shim} points at an OrgAI that is gone (${target}). Open OrgAI to update it` }
  }
  if (ownLauncher !== undefined && !same(target, ownLauncher)) {
    const fix = viaLink ? 'Point the link at this OrgAI, or remove it and install the orgai command from App settings' : 'Install the orgai command again from App settings to use this one'
    return { id: 'shim', status: 'warn', detail: `${shim} runs another OrgAI (${target}), not this one. ${fix}` }
  }
  const dir = (platform === 'win32' ? win32 : posix).dirname(shim)
  if (!onPath(dir, env, platform)) {
    const hint =
      platform === 'win32'
        ? `add ${dir} to your user Path (Settings > System > About > Advanced system settings > Environment Variables)`
        : `add it to your shell profile: export PATH="${dir}:$PATH"`
    return { id: 'shim', status: 'warn', detail: `${shim} is installed, but ${dir} is not on PATH; ${hint}` }
  }
  return { id: 'shim', status: 'ok', detail: `${shim}${viaLink ? ' (a link)' : ''} runs ${ownLauncher !== undefined ? 'this OrgAI' : 'OrgAI'} (${target})` }
}

/** True when `dir` is one of the PATH entries (case folded on Windows and macOS, trailing separators ignored). */
function onPath(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? win32 : posix
  const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1]) : env.PATH
  if (!raw) return false
  const norm = (v: string): string => {
    let out = p.normalize(v.replace(/^"(.*)"$/, '$1'))
    while (out.length > 1 && /[\\/]$/.test(out) && !/^[A-Za-z]:\\$/.test(out)) out = out.slice(0, -1)
    return platform === 'win32' || platform === 'darwin' ? out.toLowerCase() : out
  }
  const want = norm(dir)
  return raw.split(platform === 'win32' ? ';' : ':').some((entry) => entry.trim() !== '' && norm(entry.trim()) === want)
}

const MIN_NODE_MAJOR = 22
const CONNECTION_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

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
  checks.push(installCheck(ctx.platform, ctx.env))

  // Data folder
  const via = ctx.globals.dataDir ? '--data-dir' : ctx.env.ORGAI_DATA_DIR ? 'ORGAI_DATA_DIR' : 'the platform default'
  let dataExists = false
  try {
    dataExists = lstatSync(ctx.paths.dataDir).isDirectory()
  } catch {
    dataExists = false
  }
  add('data-dir', dataExists ? 'ok' : 'warn', `${ctx.paths.dataDir} (from ${via})${dataExists ? '' : ': does not exist yet (OrgAI creates it on first start)'}`)

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
    add('run-dir', 'ok', `${runDir} does not exist (no host has started on this data folder yet)`)
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
    add('daemon-json', daemonAlive ? 'ok' : 'warn', daemonAlive ? `Host ${parsed.hostInstanceId} (pid ${parsed.pid}, ${parsed.hostKind ?? 'unknown kind'}) is ${parsed.state}` : `daemon.json names pid ${parsed.pid}, which is not running (a stale file; the next host replaces it)`)
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    add('daemon-json', missing ? 'ok' : 'fail', missing ? 'No host is running' : `daemon.json could not be read: ${(e as Error).message}`)
  }

  // Socket, handshake, terminal access, version skew
  let conn: ConnectResult | undefined
  if (daemon && daemonAlive) {
    conn = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 2000 }).catch((e: unknown) => ({ ok: false, reason: 'unreachable', message: e instanceof Error ? e.message : String(e) }) as ConnectResult)
    if (conn.ok) {
      add('socket', 'ok', `Connected and verified the host (hostProof ok, ${conn.client.hello.hostKind})`)
      add('terminal-access', 'ok', 'Terminal access is on')
      const skew = conn.client.hello.versionSkewWarning
      add('version', skew ? 'warn' : 'ok', skew ? skew : `CLI ${ctx.version} matches OrgAI ${conn.client.hello.appVersion}`)
    } else if (conn.reason === 'disabled') {
      add('socket', 'ok', 'Connected; the host refused terminal clients')
      add('terminal-access', 'warn', conn.message || 'Terminal access is turned off in OrgAI (App settings)')
    } else if (conn.reason === 'starting') {
      add('socket', 'warn', 'The host is still starting')
    } else {
      add('socket', conn.reason === 'no_host' ? 'warn' : 'fail', `${conn.reason}: ${conn.message}`)
    }
  } else {
    add('socket', 'ok', 'Skipped: no host is running')
  }

  // Launcher
  const app = ctx.launcher.resolve()
  add('launcher', 'error' in app ? 'fail' : 'ok', 'error' in app ? app.error : `${app.command}${app.args.length ? ` ${app.args.join(' ')}` : ''} (${app.source})`)

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
  const hostMock = conn?.ok ? conn.client.hello.mock : undefined
  add('mock', 'ok', mock || hostMock ? `Mock mode${hostMock ? ' (the host runs the mock adapter)' : ''}: no tokens are spent` : 'Off')

  // Auth and connections (read scope; states only)
  if (conn?.ok) {
    const client = conn.client
    try {
      const auth = await client.call<AuthStatusResult>('auth:status', [])
      add('auth', auth.loggedIn ? 'ok' : 'warn', auth.loggedIn ? `Signed in (${auth.mode}${auth.method ? `, ${auth.method}` : ''})` : `Not signed in (${auth.mode})${auth.detail ? `: ${auth.detail}` : ''}`)
    } catch (e) {
      add('auth', 'warn', `Could not read the sign-in status: ${(e as Error).message}`)
    }
    try {
      const list = await client.call<ConnectionInfo[]>('connections:list', [])
      const parts = (Array.isArray(list) ? list : []).map((c) => {
        const name = isProxyConnection(c.connection) ? c.connection.name : (CONNECTION_NAMES[c.connection.id] ?? c.connection.id)
        return `${name} ${c.connection.enabled === false ? 'off' : c.status.state}${c.isDefault ? ' (default)' : ''}`
      })
      const anyConnected = (Array.isArray(list) ? list : []).some((c) => c.status.state === 'connected')
      add('connections', anyConnected || mock ? 'ok' : 'warn', parts.join(', ') || 'No connections')
    } catch (e) {
      add('connections', 'warn', `Could not list connections: ${(e as Error).message}`)
    }
    client.close()
  }

  const failed = checks.some((c) => c.status === 'fail')
  emit(ctx, { ok: !failed, checks }, () => {
    const st = styleFor(ctx)
    const mark = (s: CheckStatus): string => (s === 'ok' ? st.green('ok  ') : s === 'warn' ? st.yellow('warn') : st.red('fail'))
    return [...checks.map((c) => `${mark(c.status)}  ${c.id.padEnd(16)} ${safeLine(c.detail)}`), failed ? st.red('Some checks failed.') : 'All checks passed.']
  })
  return failed ? EXIT.failure : EXIT.ok
}
