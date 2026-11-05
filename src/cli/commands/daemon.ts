/**
 * `orgai daemon status | start | stop | restart | logs` (cli-spec 6.3(6)). host.status ('read') and host.stop
 * ('configure') work across app versions, so these commands work even with a version skew.
 *
 * - status: host.status, or the daemon.json facts when no host answers. Exit 0 only when a ready host answers.
 * - start [--host daemon|inproc] [--runtime app|node] [--foreground] [--timeout S]: a live host is reported as is (exit
 *   0; exit 1 when --runtime names the other kind). --host inproc (also --foreground) runs a pure-Node host in this
 *   terminal until Ctrl+C. Otherwise a background host starts and the command waits for it to be ready (exit 6 on
 *   timeout): the app headless (launcher) with --runtime app, or the detached Node host (Wave 7, cli-standalone.md 4.2)
 *   with --runtime node; without --runtime, the app when the launcher finds one, else Node. A Node host is refused when
 *   install.json says 'app' or Terminal access is stored off, and asks once on a terminal for the Terminal access level
 *   when none was chosen (nodeHost.ts, 4.2.1).
 * - stop [--force] [--timeout S]: host.stop; a refusal lists the leases that block it (exit 1).
 * - restart [--force] [--runtime app|node]: stop, then start (the kind that ran, unless --runtime says otherwise).
 * - logs [--lines N] [--follow]: the tail of the newest log: the host's own, else `<userData>/logs/main.log` /
 *   `node-host.log` and, on macOS with the default data folder, `~/Library/Logs/OrgAI/main.log` (sanitized).
 * - run-node (hidden): the detached Node host itself (`startBackground('node')` spawns it); runs until it drains.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActivityLeaseKind, DaemonInfo, HostKind, HostStatusResult, HostStopResult, TerminalAccessLevel } from '../../shared/types'
import { NODE_HOST_LOG } from '../client/launcher'
import { parseFlags } from '../flags'
import { manageDeps } from '../manage'
import { nodeHostDeps, nodeHostRefusal } from '../nodeHost'
import { emit, isJsonOutput, note, safe, safeLine, shortDuration, styleFor, warn, type Json } from '../output'
import { warnVersionSkew } from '../runRef'
import { LEVEL_QUESTION, levelNote, parseLevelAnswer, writeTerminalAccess } from '../terminalAccessSettings'
import { CliError, EXIT, type CliContext, type CommandFn, type DaemonRuntime, type HostClient } from '../types'
import { activityText } from './status'
import { intFlag } from './runs'

export const DEFAULT_START_TIMEOUT_S = 30
export const DEFAULT_STOP_TIMEOUT_S = 20
export const DEFAULT_LOG_LINES = 200
export const LOG_POLL_MS = 500
const ELECTRON_HOST_KINDS = ['headless-host', 'desktop'] as const
export const INPROC_BANNER = 'OrgAI host running in this terminal (inproc). Press Ctrl+C to stop.'

/** Timers, swappable in tests. */
export const daemonTimers = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
}

/** How long `daemon run-node` lets the event loop empty after its drain before it exits anyway. */
export const NODE_HOST_EXIT_GRACE_MS = 2000

/** Process effects of the Node host and its level question, swappable in tests. */
export const daemonDeps = {
  ask: (prompt: string): Promise<string> => manageDeps.ttyAsk(prompt),
  writeLevel: (dataDir: string, level: TerminalAccessLevel): Promise<unknown> => writeTerminalAccess(dataDir, { level }),
  /** After a Node host drained: exit once the loop is empty, or after the grace even if a handle lingers. */
  exitSoon: (code: number): void => {
    process.exitCode = code
    setTimeout(() => process.exit(code), NODE_HOST_EXIT_GRACE_MS).unref()
  }
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
    case 'run-node':
      // Hidden (not in help or completions): what startBackground('node') runs.
      return runNodeHost(ctx, rest)
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

/** --runtime: 'app' | 'node', else a usage error; undefined when not given. */
export function runtimeFlag(raw: string | undefined): DaemonRuntime | undefined {
  if (raw === undefined) return undefined
  if (raw === 'app' || raw === 'node') return raw
  throw new CliError('--runtime must be app or node.', EXIT.usage)
}

/** The runtime a running host kind belongs to ('inproc' belongs to none). */
export function runtimeOfKind(kind: HostKind | undefined): DaemonRuntime | 'inproc' | undefined {
  if (kind === 'node') return 'node'
  if (kind === 'inproc') return 'inproc'
  return kind ? 'app' : undefined
}

/** "A Node host is already running; use `orgai daemon restart --runtime app`" (cli-standalone.md 4.2). */
export function otherKindRunning(kind: HostKind, wanted: DaemonRuntime): string {
  const words = kind === 'node' ? 'A Node' : kind === 'inproc' ? 'An in-process' : kind === 'headless-host' ? 'An app (headless)' : 'An app'
  return `${words} host is already running; use \`orgai daemon restart --runtime ${wanted}\``
}

/** Exit 1 when --runtime was given and a host of the other kind runs. */
function checkRuntime(explicit: DaemonRuntime | undefined, kind: HostKind | undefined): void {
  if (!explicit || !kind) return
  if (runtimeOfKind(kind) !== explicit) throw new CliError(otherKindRunning(kind, explicit), EXIT.failure)
}

/**
 * Start (or report) a host. `notInstanceId`: wait for a host other than this one (restart). `runtime`: --runtime as
 * given (checked against a running host); `runtimeDefault`: what to start when --runtime was not given (restart: the
 * kind that ran), else the app when the launcher finds one, else Node.
 */
async function startHost(
  ctx: CliContext,
  o: { timeoutS: number; foreground: boolean; notInstanceId?: string; runtime?: DaemonRuntime; runtimeDefault?: DaemonRuntime }
): Promise<number> {
  const mode = ctx.globals.host
  const inproc = mode === 'inproc' || (o.foreground && mode !== 'daemon')
  if (o.foreground && mode === 'daemon') throw new CliError('--foreground runs the host in this terminal; it needs --host inproc.', EXIT.usage)
  if (inproc && o.runtime) throw new CliError('--runtime starts a background host; it cannot be combined with --host inproc or --foreground.', EXIT.usage)

  if (!o.notInstanceId) {
    const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 0 })
    if (res.ok) {
      try {
        warnVersionSkew(ctx, res.client)
        const s = await fetchStatus(res.client)
        checkRuntime(o.runtime, s.hostKind)
        printHostStatus(ctx, s, { alreadyRunning: true })
        return EXIT.ok
      } finally {
        res.client.close()
      }
    }
    if (res.reason === 'disabled' || res.reason === 'draining' || res.reason === 'starting') {
      checkRuntime(o.runtime, res.daemon?.hostKind)
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

  const runtime = o.runtime ?? o.runtimeDefault ?? defaultRuntime(ctx)
  if (runtime === 'node') return startNodeHost(ctx, o)

  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  let ready: DaemonInfo | null
  try {
    ctx.launcher.spawn({ headless: true })
    // Only an Electron host counts (a running desktop app takes the hand-off); an inproc host's daemon.json never does.
    ready = await ctx.launcher.waitForReady({
      timeoutMs: o.timeoutS * 1000,
      hostKinds: ELECTRON_HOST_KINDS,
      ...(o.notInstanceId ? { notInstanceId: o.notInstanceId } : {})
    })
  } catch (e) {
    throw new CliError(`Could not start the OrgAI host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI host did not become ready within ${o.timeoutS} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  return reportStarted(ctx, ready, false)
}

/** No --runtime: the app when the launcher finds one, Node when there is none; a broken app is an error naming it. */
function defaultRuntime(ctx: CliContext): DaemonRuntime {
  const found = ctx.launcher.locate()
  if (found.status === 'found') return 'app'
  if (found.status === 'absent') return 'node'
  throw new CliError(found.message, EXIT.failure)
}

/**
 * The Terminal access level a Node host will grant, asked once (4.2.1, round 6 item 11): on a terminal with no stored
 * choice the question is asked and the answer stored (Enter keeps 'operate'); otherwise a note names the level and how
 * to change it. Runs while no host owns the data folder, so the write (under the startup mutex) never races a host.
 */
async function chooseLevelOnce(ctx: CliContext): Promise<void> {
  const stored = nodeHostDeps.terminalAccess(ctx.paths.dataDir)
  if (stored.levelChosen) return
  if (!ctx.io.stdinIsTTY || isJsonOutput(ctx)) {
    note(ctx, levelNote(stored.level))
    return
  }
  let level: TerminalAccessLevel | undefined
  for (let i = 0; i < 3 && !level; i++) {
    const answer = await daemonDeps.ask(LEVEL_QUESTION)
    level = answer.trim() === '' ? 'operate' : parseLevelAnswer(answer)
    if (!level) ctx.io.stderr.write('Answer full or operate.\n')
  }
  level ??= 'operate'
  await daemonDeps.writeLevel(ctx.paths.dataDir, level)
  note(ctx, levelNote(level))
}

/** Start the detached Node host (4.2) and wait for it. */
async function startNodeHost(ctx: CliContext, o: { timeoutS: number; notInstanceId?: string }): Promise<number> {
  const refusal = nodeHostRefusal(ctx)
  if (refusal) throw refusal
  if (!ctx.launcher.startBackground) throw new CliError('This orgai cannot start a Node background host.', EXIT.failure)
  await chooseLevelOnce(ctx)
  let ready: DaemonInfo | null
  try {
    const started = ctx.launcher.startBackground('node')
    ready = await ctx.launcher.waitForReady({
      timeoutMs: o.timeoutS * 1000,
      hostKinds: started.hostKinds,
      ...(o.notInstanceId ? { notInstanceId: o.notInstanceId } : {})
    })
  } catch (e) {
    throw new CliError(`Could not start the OrgAI Node host: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) throw new CliError(`The OrgAI Node host did not become ready within ${o.timeoutS} s. See \`orgai daemon logs\`.`, EXIT.hostBusy)
  return reportStarted(ctx, ready, false)
}

/**
 * `daemon run-node` (hidden): the detached Node host (HostKind 'node') in this process: the inproc host plus the idle
 * exit (bootstrap arms it for every background kind; ORGAI_DAEMON_IDLE_MINUTES, default 30) and the stored Terminal
 * access. Its stdio is node-host.log; it exits once it drained (host.stop, idle exit, SIGINT / SIGTERM).
 */
async function runNodeHost(ctx: CliContext, args: string[]): Promise<number> {
  noArgs(parseFlags(args, {}).positionals)
  if (!nodeHostDeps.terminalAccess(ctx.paths.dataDir).enabledForBackground) throw new CliError(NODE_HOST_TERMINAL_OFF_RUN, EXIT.failure)
  const handle = await ctx.startInproc({ hostKind: 'node' })
  const s = handle.status()
  ctx.io.stderr.write(`OrgAI Node host ${s.hostInstanceId} (pid ${s.pid}) ready for ${safeLine(s.dataDir)}.\n`)
  let offSignal: () => void = () => undefined
  const code = await new Promise<number>((resolve) => {
    let stopping = false
    offSignal = ctx.signals.onInterrupt((sig) => {
      if (stopping) return
      stopping = true
      handle.stop(true).then(
        () => resolve(EXIT.ok),
        (e: unknown) => {
          ctx.io.stderr.write(`Could not stop the host cleanly: ${safeLine(e instanceof Error ? e.message : String(e))}\n`)
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
  ctx.io.stderr.write('OrgAI Node host stopped.\n')
  daemonDeps.exitSoon(code)
  return code
}

/** run-node's own refusal (it is never started that way by orgai; someone ran it by hand). */
export const NODE_HOST_TERMINAL_OFF_RUN = 'Terminal access is off, so nothing could talk to a Node host; turn it on with `orgai terminal-access on`'

async function reportStarted(ctx: CliContext, d: DaemonInfo, wasStarting: boolean): Promise<number> {
  const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 2000 })
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

/** `--host inproc`: the host lives in this process until Ctrl+C (or until it stops on its own). */
async function runInproc(ctx: CliContext): Promise<number> {
  const handle = await ctx.startInproc()
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
  const { values, positionals } = parseFlags(args, { foreground: { type: 'boolean' }, timeout: { type: 'string' }, runtime: { type: 'string' } })
  noArgs(positionals)
  const runtime = runtimeFlag(values.runtime)
  return startHost(ctx, {
    timeoutS: intFlag('timeout', values.timeout, DEFAULT_START_TIMEOUT_S, 3600) || DEFAULT_START_TIMEOUT_S,
    foreground: !!values.foreground,
    ...(runtime ? { runtime } : {})
  })
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
  const res = await ctx.connect(['read', 'configure'], { clientKind: 'cli', waitStartingMs: 2000 })
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
  const { values, positionals } = parseFlags(args, { force: { type: 'boolean' }, timeout: { type: 'string' }, foreground: { type: 'boolean' }, runtime: { type: 'string' } })
  noArgs(positionals)
  const timeoutS = intFlag('timeout', values.timeout, DEFAULT_START_TIMEOUT_S, 3600) || DEFAULT_START_TIMEOUT_S
  const runtime = runtimeFlag(values.runtime)
  const background = !values.foreground && ctx.globals.host !== 'inproc'
  if (!background && runtime) throw new CliError('--runtime starts a background host; it cannot be combined with --host inproc or --foreground.', EXIT.usage)
  // Without --runtime, the kind that runs now comes back (a Node host stays a Node host).
  const was = runtimeOfKind(ctx.launcher.current()?.hostKind)
  const target = runtime ?? (was === 'node' || was === 'app' ? was : undefined)
  // A Node host that could not start is refused before the running host is stopped.
  if (background && target === 'node') {
    const refusal = nodeHostRefusal(ctx)
    if (refusal) throw refusal
  }
  const stopped = await stopHost(ctx, { force: !!values.force, timeoutS: DEFAULT_STOP_TIMEOUT_S, quiet: true })
  if (stopped.code !== EXIT.ok) return stopped.code
  if (stopped.wasRunning && !isJsonOutput(ctx)) ctx.io.stderr.write('OrgAI host stopped; starting it again.\n')
  // The old host is gone (waitForGone), so the next ready host is the new one.
  return startHost(ctx, {
    timeoutS,
    foreground: !!values.foreground,
    ...(stopped.stoppedId ? { notInstanceId: stopped.stoppedId } : {}),
    ...(runtime ? { runtime } : target ? { runtimeDefault: target } : {})
  })
}

// ---------- logs ----------

/**
 * The log files a host of this data folder may write, without asking it (Wave 7, cli-standalone.md 4.2):
 * `<userDataDir>/logs/main.log` (Node, inproc and a chosen data folder's app), `<userDataDir>/logs/node-host.log` (the
 * Node host's stdio) and, on macOS with the default data folder, the app's `~/Library/Logs/OrgAI/main.log`.
 */
export function logCandidates(ctx: CliContext): string[] {
  const chosen = !!ctx.globals.dataDir || !!ctx.env.ORGAI_DATA_DIR
  const out = [join(ctx.paths.userDataDir, 'logs', 'main.log'), join(ctx.paths.userDataDir, 'logs', NODE_HOST_LOG)]
  if (ctx.platform === 'darwin' && !chosen) out.push(join(ctx.env.HOME || homedir(), 'Library', 'Logs', 'OrgAI', 'main.log'))
  return out
}

/** The existing candidates, newest (last modified) first. */
export function existingLogs(paths: readonly string[]): string[] {
  const found: { path: string; mtime: number }[] = []
  for (const path of paths) {
    try {
      const st = statSync(path)
      if (st.isFile()) found.push({ path, mtime: st.mtimeMs })
    } catch {
      // missing
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path)
}

/**
 * The log to show when no host tells us: the newest existing candidate, else the one a host of this kind of install
 * would write first (darwin's ~/Library/Logs/OrgAI with the default data folder, else `<userDataDir>/logs/main.log`).
 */
export function guessLogPath(ctx: CliContext): string {
  const all = logCandidates(ctx)
  const macDefault = all.length > 2 ? all[2] : undefined
  return existingLogs(all)[0] ?? macDefault ?? all[0]
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
  if (typeof path !== 'string' || !path || !existsSync(path)) path = guessLogPath(ctx)
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
