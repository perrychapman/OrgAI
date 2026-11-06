/**
 * `orgai daemon status | start | stop | restart | logs` (cli-spec 6.3(6)). host.status ('read') and host.stop
 * ('configure') work across app versions, so these commands work even with a version skew.
 *
 * - status: host.status, or the daemon.json facts when no host answers. Exit 0 only when a ready host answers.
 * - start [--host daemon|inproc] [--foreground] [--timeout S]: a live host is reported as is (exit 0). --host inproc
 *   (also --foreground) runs a pure-Node host in this terminal until Ctrl+C. Otherwise the app starts headless
 *   (launcher), and the command waits for it to be ready (exit 6 on timeout).
 * - stop [--force] [--timeout S]: host.stop; a refusal lists the leases that block it (exit 1).
 * - restart [--force]: stop, then start.
 * - logs [--lines N] [--follow]: the tail of main.log (sanitized).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_HOST_KINDS, type ActivityLeaseKind, type DaemonInfo, type HostStatusResult, type HostStopResult } from '../../shared/types'
import { parseFlags } from '../flags'
import { emit, isJsonOutput, safe, safeLine, shortDuration, styleFor, warn, type Json } from '../output'
import { warnVersionSkew } from '../runRef'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type CommandFn, type HostClient } from '../types'
import { activityText } from './status'
import { intFlag } from './runs'

export const DEFAULT_START_TIMEOUT_S = 30
export const DEFAULT_STOP_TIMEOUT_S = 20
export const DEFAULT_LOG_LINES = 200
export const LOG_POLL_MS = 500
export const INPROC_BANNER = 'OrgAI host running in this terminal (inproc). Press Ctrl+C to stop.'

/** Timers, swappable in tests. */
export const daemonTimers = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
}

export const runDaemon: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const [sub, ...rest] = args
  switch (sub) {
    case 'status':
      return daemonStatus(ctx, rest)
    case 'start':
      return daemonStart(ctx, rest)
    case 'stop':
      return daemonStop(ctx, rest)
    case 'restart':
      return daemonRestart(ctx, rest)
    case 'logs':
      return daemonLogs(ctx, rest)
    default:
      throw new CliError(`${sub ? `Unknown daemon command "${sub}". ` : ''}Use: orgai daemon status | start | stop [--force] | restart [--force] | logs`, EXIT.usage)
  }
}

function noArgs(positionals: string[]): void {
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
}

/** host.status as text lines. */
function statusLines(ctx: CliContext, s: HostStatusResult): string[] {
  const st = styleFor(ctx)
  return [
    `${st.bold('OrgAI host:')} ${s.state} (${s.hostKind}) · OrgAI ${safeLine(s.appVersion)} · pid ${s.pid} · up ${shortDuration(Date.now() - s.startedAt)}${s.mock ? ' · mock' : ''}`,
    `  ${st.dim('Data folder:')} ${safeLine(s.dataDir)}`,
    `  ${st.dim('Activity:')} ${activityText(s.activity.counts) || 'idle'}`
  ]
}

function daemonFacts(d: DaemonInfo): Json {
  return { hostInstanceId: d.hostInstanceId, pid: d.pid, state: d.state, hostKind: d.hostKind ?? null, appVersion: d.appVersion ?? null, startedAt: d.startedAt }
}

/** Print a host.status (or the result of a failed connect) in the current format. */
function printHostStatus(ctx: CliContext, s: HostStatusResult, extra: Json = {}): void {
  emit(ctx, { running: true, ...extra, status: s }, () => statusLines(ctx, s))
}

async function fetchStatus(client: HostClient): Promise<HostStatusResult> {
  return client.call<HostStatusResult>('host.status', [])
}

async function daemonStatus(ctx: CliContext, args: string[]): Promise<number> {
  noArgs(parseFlags(args, {}).positionals)
  const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 0 })
  if (res.ok) {
    try {
      warnVersionSkew(ctx, res.client)
      const s = await fetchStatus(res.client)
      printHostStatus(ctx, s)
      return s.state === 'ready' ? EXIT.ok : EXIT.failure
    } finally {
      res.client.close()
    }
  }
  const snap = await ctx.readStore().catch(() => undefined)
  const d = res.daemon ?? snap?.daemon
  const alive = !!d && snap?.hostState !== 'stopped'
  emit(ctx, { running: alive, reason: res.reason, message: res.message, daemon: d ? daemonFacts(d) : null, dataDir: ctx.paths.dataDir }, () => {
    const st = styleFor(ctx)
    if (res.reason === 'no_host' || !alive) return [`No OrgAI host is running. ${st.dim(`(data folder ${safeLine(ctx.paths.dataDir)})`)}`]
    const facts = d ? ` (${[d.hostKind, d.appVersion ? `OrgAI ${safeLine(d.appVersion)}` : '', `pid ${d.pid}`, d.state].filter(Boolean).join(' · ')})` : ''
    return [`OrgAI host${facts}: ${safeLine(res.message || res.reason)}`]
  })
  return EXIT.failure
}

/** Start (or report) a host. `notInstanceId`: wait for a host other than this one (restart). */
async function startHost(ctx: CliContext, o: { timeoutS: number; foreground: boolean; notInstanceId?: string }): Promise<number> {
  const mode = ctx.globals.host
  const inproc = mode === 'inproc' || (o.foreground && mode !== 'daemon')
  if (o.foreground && mode === 'daemon') throw new CliError('--foreground runs the host in this terminal; it needs --host inproc.', EXIT.usage)

  if (!o.notInstanceId) {
    const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 0 })
    if (res.ok) {
      try {
        warnVersionSkew(ctx, res.client)
        printHostStatus(ctx, await fetchStatus(res.client), { alreadyRunning: true })
        return EXIT.ok
      } finally {
        res.client.close()
      }
    }
    if (res.reason === 'disabled' || res.reason === 'draining' || res.reason === 'starting') {
      if (res.reason === 'starting') {
        const ready = await ctx.launcher.waitForReady({ timeoutMs: o.timeoutS * 1000 })
        if (ready) return reportStarted(ctx, ready, true)
        throw new CliError(`The OrgAI host did not become ready within ${o.timeoutS} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
      }
      // A live host owns the data folder; we cannot start another one.
      const d = res.daemon
      emit(ctx, { running: true, alreadyRunning: true, reason: res.reason, message: res.message, daemon: d ? daemonFacts(d) : null }, () => [
        `An OrgAI host is already running${d ? ` (${[d.hostKind, `pid ${d.pid}`].filter(Boolean).join(', ')})` : ''}: ${safeLine(res.message)}`
      ])
      return res.reason === 'draining' ? EXIT.hostBusy : EXIT.ok
    }
    if (res.reason !== 'no_host') {
      // A live host owns the data folder but refused or did not answer this terminal (too many connections, an agent's
      // own process, a failed proof, a version it cannot speak, a hung socket). A spawned host would only exit 6 on
      // ownership, and its wait would report the incumbent as started: report the incumbent instead.
      const d = res.daemon
      const facts = d ? ` (${[d.hostKind, `pid ${d.pid}`].filter(Boolean).join(', ')})` : ''
      throw new CliError(
        `An OrgAI host is already running${facts} but this terminal cannot use it: ${res.message || res.reason}`,
        res.reason === 'auth_failed' ? EXIT.auth : EXIT.failure
      )
    }
  }

  if (inproc) return runInproc(ctx)

  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  let ready: DaemonInfo | null
  try {
    ctx.launcher.spawn({ headless: true })
    // Only a background host counts (a running desktop app takes the hand-off, a Node host is one too); an inproc
    // host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({
      timeoutMs: o.timeoutS * 1000,
      hostKinds: BACKGROUND_HOST_KINDS,
      ...(o.notInstanceId ? { notInstanceId: o.notInstanceId } : {})
    })
  } catch (e) {
    throw new CliError(`Could not start the OrgAI host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI host did not become ready within ${o.timeoutS} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  return reportStarted(ctx, ready, false)
}

async function reportStarted(ctx: CliContext, d: DaemonInfo, wasStarting: boolean): Promise<number> {
  const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS })
  if (res.ok) {
    try {
      warnVersionSkew(ctx, res.client)
      printHostStatus(ctx, await fetchStatus(res.client), { started: !wasStarting })
      return EXIT.ok
    } finally {
      res.client.close()
    }
  }
  emit(ctx, { running: true, started: !wasStarting, daemon: daemonFacts(d), note: res.message }, () => [
    `OrgAI host ready (${[d.hostKind, `pid ${d.pid}`].filter(Boolean).join(', ')}).`,
    ...(res.reason === 'disabled' ? [safeLine(res.message)] : [])
  ])
  return EXIT.ok
}

/** `--host inproc`: the host lives in this process until Ctrl+C (or until it stops on its own) and serves other terminals. */
async function runInproc(ctx: CliContext): Promise<number> {
  // This host serves other terminals until Ctrl+C: marked shared, so their ensureHost attaches to it (client/sharedHost.ts).
  const handle = await ctx.startInproc({ shared: true })
  emit(ctx, { running: true, inproc: true, status: handle.status() }, () => [INPROC_BANNER])
  let offSignal: () => void = () => undefined
  const code = await new Promise<number>((resolve) => {
    let stopping = false
    offSignal = ctx.signals.onInterrupt((sig) => {
      if (stopping) return
      stopping = true
      handle.stop(true).then(
        () => resolve(EXIT.ok),
        (e: unknown) => {
          warn(ctx, `Could not stop the host cleanly: ${e instanceof Error ? e.message : String(e)}`)
          resolve(sig === 'SIGINT' ? EXIT.sigint : EXIT.sigterm)
        }
      )
    })
    handle.closed.then(
      () => resolve(EXIT.ok),
      () => resolve(EXIT.failure)
    )
  })
  offSignal()
  if (!isJsonOutput(ctx)) ctx.io.stderr.write('OrgAI host stopped.\n')
  return code
}

async function daemonStart(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { foreground: { type: 'boolean' }, timeout: { type: 'string' } })
  noArgs(positionals)
  return startHost(ctx, { timeoutS: intFlag('timeout', values.timeout, DEFAULT_START_TIMEOUT_S, 3600) || DEFAULT_START_TIMEOUT_S, foreground: !!values.foreground })
}

const LEASE_WORDS: Record<ActivityLeaseKind, string> = {
  liveRuns: 'live runs',
  pausedAutoResumes: 'paused runs waiting to resume',
  inFlightRpcMutations: 'changes in progress',
  activeWorktreeOps: 'worktree operations',
  backgroundTasks: 'background tasks',
  activeOAuthFlows: 'sign-ins in progress',
  interactiveClients: 'attached terminals'
}

/** "live runs: 2, attached terminals: 1". */
export function leaseText(leases: Partial<Record<ActivityLeaseKind, number>>): string {
  return Object.entries(leases)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([k, n]) => `${LEASE_WORDS[k as ActivityLeaseKind] ?? k}: ${n}`)
    .join(', ')
}

/**
 * Stop the host. 'gone' when stopped (or none was running), else the exit code to return. Prints its own result unless
 * `quiet`.
 */
async function stopHost(ctx: CliContext, o: { force: boolean; timeoutS: number; quiet?: boolean }): Promise<{ code: number; stoppedId?: string; wasRunning: boolean }> {
  const res = await ctx.connect(['read', 'configure'], { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS })
  if (!res.ok) {
    if (res.reason === 'no_host') {
      if (!o.quiet) emit(ctx, { stopped: false, running: false }, () => ['No OrgAI host is running.'])
      return { code: EXIT.ok, wasRunning: false }
    }
    throw new CliError(res.message || `Could not reach the OrgAI host (${res.reason}).`, res.reason === 'auth_failed' ? EXIT.auth : EXIT.failure)
  }
  const client = res.client
  const id = client.hello.hostInstanceId
  let result: HostStopResult
  try {
    warnVersionSkew(ctx, client)
    result = await client.call<HostStopResult>('host.stop', [{ force: o.force }])
  } finally {
    client.close()
  }
  if (result.refusedBecause && Object.keys(result.refusedBecause).length > 0) {
    emit(ctx, { stopped: false, refusedBecause: result.refusedBecause }, () => [
      `The OrgAI host is busy (${leaseText(result.refusedBecause!) || 'activity'}).`,
      'Use --force to stop live runs and stop it anyway.'
    ])
    return { code: EXIT.failure, wasRunning: true }
  }
  const gone = await ctx.launcher.waitForGone({ timeoutMs: o.timeoutS * 1000, hostInstanceId: id })
  if (!gone) {
    emit(ctx, { stopped: false, timedOut: true }, () => [`The OrgAI host did not stop within ${o.timeoutS} s.`])
    return { code: EXIT.failure, wasRunning: true }
  }
  if (!o.quiet) emit(ctx, { stopped: true, hostInstanceId: id }, () => ['OrgAI host stopped.'])
  return { code: EXIT.ok, stoppedId: id, wasRunning: true }
}

async function daemonStop(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { force: { type: 'boolean' }, timeout: { type: 'string' } })
  noArgs(positionals)
  const timeoutS = intFlag('timeout', values.timeout, DEFAULT_STOP_TIMEOUT_S, 3600) || DEFAULT_STOP_TIMEOUT_S
  return (await stopHost(ctx, { force: !!values.force, timeoutS })).code
}

async function daemonRestart(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { force: { type: 'boolean' }, timeout: { type: 'string' }, foreground: { type: 'boolean' } })
  noArgs(positionals)
  const timeoutS = intFlag('timeout', values.timeout, DEFAULT_START_TIMEOUT_S, 3600) || DEFAULT_START_TIMEOUT_S
  const stopped = await stopHost(ctx, { force: !!values.force, timeoutS: DEFAULT_STOP_TIMEOUT_S, quiet: true })
  if (stopped.code !== EXIT.ok) return stopped.code
  if (stopped.wasRunning && !isJsonOutput(ctx)) ctx.io.stderr.write('OrgAI host stopped; starting it again.\n')
  // The old host is gone (waitForGone), so the next ready host is the new one.
  return startHost(ctx, { timeoutS, foreground: !!values.foreground, ...(stopped.stoppedId ? { notInstanceId: stopped.stoppedId } : {}) })
}

// ---------- logs ----------

/** main.log's path when no host tells us: darwin ~/Library/Logs/OrgAI (default data dir only), else <userDataDir>/logs. */
export function guessLogPath(ctx: CliContext): string {
  const chosen = !!ctx.globals.dataDir || !!ctx.env.ORGAI_DATA_DIR
  if (ctx.platform === 'darwin' && !chosen) return join(ctx.env.HOME || homedir(), 'Library', 'Logs', 'OrgAI', 'main.log')
  return join(ctx.paths.userDataDir, 'logs', 'main.log')
}

/** The last `n` lines of a file (reads at most the last 4 MB). */
export function tailFile(path: string, n: number): { text: string; size: number } {
  const size = statSync(path).size
  const max = 4 * 1024 * 1024
  const start = Math.max(0, size - max)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    if (start > 0) lines.shift()
    return { text: (n > 0 ? lines.slice(-n) : lines).join('\n'), size }
  } finally {
    closeSync(fd)
  }
}

function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

async function daemonLogs(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { lines: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } })
  noArgs(positionals)
  const n = intFlag('lines', values.lines, DEFAULT_LOG_LINES)
  let path: string | undefined
  const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 0 })
  if (res.ok) {
    path = await res.client.call<string>('app:logPath', []).catch(() => undefined)
    res.client.close()
  }
  if (typeof path !== 'string' || !path) path = guessLogPath(ctx)
  if (!existsSync(path)) throw new CliError(`No log file at ${safeLine(path)}.`, EXIT.failure)
  const tail = tailFile(path, n)
  if (isJsonOutput(ctx) && !values.follow) {
    emit(ctx, { path, lines: tail.text ? tail.text.split('\n') : [] }, () => [])
    return EXIT.ok
  }
  if (tail.text) ctx.io.stdout.write(`${safe(tail.text)}\n`)
  if (!values.follow) return EXIT.ok
  let offset = tail.size
  let stop = false
  const off = ctx.signals.onInterrupt(() => {
    stop = true
  })
  let carry = ''
  try {
    while (!stop) {
      await daemonTimers.sleep(LOG_POLL_MS)
      if (stop) break
      let size: number
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      if (size < offset) offset = 0 // rotated or truncated
      if (size === offset) continue
      const chunk = carry + readRange(path, offset, size)
      offset = size
      const nl = chunk.lastIndexOf('\n')
      if (nl === -1) {
        carry = chunk
        continue
      }
      carry = chunk.slice(nl + 1)
      ctx.io.stdout.write(`${safe(chunk.slice(0, nl))}\n`)
    }
  } finally {
    off()
  }
  return EXIT.ok
}
