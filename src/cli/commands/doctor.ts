/**
 * `orgai doctor` (cli-spec 6.1): checks of the install, the data folder, the host and the connections, printed as
 * ok / warn / fail lines (json: an array of { id, status, detail }). Exit 1 when any check fails, else 0. Never
 * prints a secret: auth and connection checks report states and labels only.
 */
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthStatusResult, ConnectionInfo, DaemonInfo } from '../../shared/types'
import { parseFlags } from '../flags'
import { emit, safeLine, styleFor } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type ConnectResult } from '../types'

export type CheckStatus = 'ok' | 'warn' | 'fail'

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
  gitVersion: (): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())))
    })
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
    const raw = readFileSync(join(runDir, 'daemon.json'), 'utf8')
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
        const name = CONNECTION_NAMES[c.connection.id] ?? c.connection.id
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
