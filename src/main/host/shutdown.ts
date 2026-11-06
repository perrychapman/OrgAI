/**
 * The shutdown coordinator (Wave 7, docs/design/cli-standalone.md 4.3 and round 6 items 5 and 9): one sequence for
 * every exit path (host.stop over the socket, the app's handoff stop, desktop Quit and the last window closing on
 * Windows / Linux, the headless and Node hosts' idle exit and signals, the inproc host's cleanup), ownership released
 * only once the owner's writes are done, and a process-wide registry of the child processes a host must kill when it
 * gives up at the hard limit (git under the repo lock, custodian helpers, agent CLIs).
 *
 * The sequence: the activity tracker drains (state 'draining', mutations refused with host_draining, background work
 * quiesced, runs stopped when forced) and waits until no writer is in flight (activity.ts SETTLE_KINDS, forced and
 * non-forced drains alike, with no deadline of its own); its onDrained runs from setImmediate, so the host.stop reply
 * is queued first; then HostSocketServer.closeGracefully(SOCKET_CLOSE_GRACE_MS), then ownership.release(), then the
 * entry point's exit (onReleased). While writers are in flight the host stays 'draining' and daemon.json stays, so no
 * contender can take the data folder. At SHUTDOWN_HARD_LIMIT_MS the coordinator stops waiting: it enumerates every
 * descendant of the host's pid from the process table (killHostDescendants; on Windows a row older than its claimed
 * parent is a stale-parent orphan and never a target; the desktop's own Electron helpers and the coordinator's own
 * table readers and taskkill.exe children are excluded), sends SIGTERM
 * (Windows `taskkill /PID`, never `/T`, whose tree walk trusts stale parent pids), waits KILL_TERM_GRACE_MS, sends
 * SIGKILL (`taskkill /PID /F`), and releases only once none of them is alive; when the table cannot be read it signals
 * the tracked children directly, and when it cannot be read or some survive it waits in KILL_STEP_MS steps up to
 * KILL_WAIT_MS before exiting anyway (logged). Every real host then exits (exitAtHardLimit) and its exit hook releases.
 *
 * Electron-free; relative imports only (noElectronImport.test.ts).
 */
import { execFile } from 'node:child_process'
import type {
  ActivityLeaseKind,
  HostActivitySnapshot,
  HostHandoffBlocker,
  HostHandoffFacts,
  HostState,
  HostStopInput,
  HostStopResult
} from '../../shared/types'
import { ACTIVITY_LEASE_KINDS, HOST_HANDOFF_BLOCKERS } from '../../shared/types'
import { neutralCwd, windowsPowerShellPath, system32Path } from './systemBinaries'

/** After this long a shutdown kills the tracked children and exits; the exit hooks then release ownership. */
export const SHUTDOWN_HARD_LIMIT_MS = 60_000
/** HostSocketServer.closeGracefully: how long queued frames (the host.stop reply) may take to flush. */
export const SOCKET_CLOSE_GRACE_MS = 2_000
/** The app's handoff (4.4): no waiting window unless the Node host takes longer than this to exit. */
export const HANDOFF_WINDOW_DELAY_MS = 1_000
/** The app's handoff: "Open when they finish" retries the stop this often. */
export const HANDOFF_RETRY_MS = 5_000
/** The app's handoff: no answer within this long (or an owner older than Wave 7) shows the busy-folder message. */
export const HANDOFF_ANSWER_TIMEOUT_MS = 5_000

/** Hard limit: SIGTERM, then this long before SIGKILL (round 6 item 5). */
export const KILL_TERM_GRACE_MS = 5_000
/** Hard limit: after SIGKILL (or with an unreadable process table), wait at most this long for the tree to be gone. */
export const KILL_WAIT_MS = 60_000
/** Hard limit: the step of that wait. */
export const KILL_STEP_MS = 1_000
/** How long one process-table read may take. */
export const PROCESS_TABLE_TIMEOUT_MS = 5_000

/** Every exit path the coordinator serves (4.3 "One shutdown coordinator"). */
export type ShutdownReason =
  | 'host.stop'
  | 'desktop-quit'
  | 'window-closed'
  | 'idle-exit'
  | 'signal'
  | 'inproc-cleanup'
  | 'handoff'

/** Where a shutdown is. 'released' is final: ownership is gone and the process may exit. */
export type ShutdownPhase = 'running' | 'draining' | 'settling' | 'closing' | 'released'

/**
 * The order (4.3): drain (mutations refused with host_draining, runs stopped when forced); the host.stop reply is
 * queued; writers settle (non-forced drains too); HostSocketServer.closeGracefully(SOCKET_CLOSE_GRACE_MS); release;
 * exit. While writers are in flight the host stays 'draining' and daemon.json stays. At SHUTDOWN_HARD_LIMIT_MS it
 * kills the host's descendants (killHostDescendants) and exits. onDrained runs from setImmediate, never inside
 * requestDrain.
 */
export interface ShutdownCoordinatorApi {
  /** Start the shutdown, or join the one in progress (a forced request upgrades a running non-forced one). */
  shutdown(reason: ShutdownReason, opts?: { force?: boolean }): Promise<void>
  phase(): ShutdownPhase
}

// ---------- Tracked child processes ----------

/** What the registry needs of a child (a ChildProcess fits). */
export interface TrackableChild {
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once?(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
}

interface Tracked {
  child: TrackableChild
  label: string
}

const tracked = new Set<Tracked>()

/**
 * Register a child the host must kill when it exits at the hard limit (git under the repo lock, the Codex app-server,
 * a repository clone, custodian helpers). Untracked automatically on 'exit', and on an 'error' of a child that never got
 * a pid (the spawn failed), when the child supports `once`; the returned function untracks it too (idempotent). Anything
 * that is not a child (a test double returning undefined) is ignored. Never throws.
 */
export function trackChildProcess(child: TrackableChild | null | undefined, label: string): () => void {
  if (!child || typeof child.kill !== 'function') return () => {}
  const entry: Tracked = { child, label }
  tracked.add(entry)
  const untrack = (): void => {
    tracked.delete(entry)
  }
  try {
    child.once?.('exit', untrack)
    child.once?.('error', () => {
      if (child.pid === undefined) untrack()
    })
  } catch {
    // A child without usable events stays tracked until the caller untracks it.
  }
  return untrack
}

/** Signal every tracked child and keep tracking it (the hard limit's SIGTERM step); returns how many took it. */
export function signalTrackedChildren(signal: NodeJS.Signals | number): number {
  let n = 0
  for (const entry of [...tracked]) {
    try {
      if (entry.child.kill(signal)) n++
    } catch {
      // Already gone.
    }
  }
  return n
}

/** Kill every tracked child (SIGKILL by default) and forget them; returns how many were signalled. Never throws. */
export function killTrackedChildren(signal: NodeJS.Signals | number = 'SIGKILL'): number {
  let n = 0
  for (const entry of [...tracked]) {
    tracked.delete(entry)
    try {
      if (entry.child.kill(signal)) n++
    } catch {
      // Already gone.
    }
  }
  return n
}

/** How many children are tracked now (by label prefix when given; tests and logs). */
export function trackedChildCount(labelPrefix?: string): number {
  if (labelPrefix === undefined) return tracked.size
  let n = 0
  for (const e of tracked) if (e.label.startsWith(labelPrefix)) n++
  return n
}

/** The pids of the tracked children that have one (the hard limit adds them to the process-tree targets). */
export function trackedChildPids(): number[] {
  const out: number[] = []
  for (const e of tracked) {
    const pid = e.child.pid
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) out.push(pid)
  }
  return out
}

// ---------- The coordinator's own helper processes ----------

/** How long an exited helper's pid stays known (a process-table read may have listed it while it still ran). */
export const HELPER_PID_LINGER_MS = 60_000

/** pid -> when it exited (undefined while it runs): the table readers and taskkill.exe the hard limit starts. */
const helpers = new Map<number, number | undefined>()

/**
 * Note one of the coordinator's own helper children (a process-table reader, a taskkill.exe) until it exits: it is a
 * child of the host while it runs, so without this a later pass would count it (and on Windows its conhost) as a
 * descendant to end, and taskkill its own helpers. Never throws.
 */
export function trackHelperProcess(
  child: { readonly pid?: number; once?(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown } | null | undefined,
  now: () => number = Date.now
): void {
  const pid = child?.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return
  const at = now()
  for (const [p, exited] of helpers) if (exited !== undefined && at - exited > HELPER_PID_LINGER_MS) helpers.delete(p)
  helpers.set(pid, undefined)
  const done = (): void => {
    if (helpers.has(pid) && helpers.get(pid) === undefined) helpers.set(pid, now())
  }
  try {
    child?.once?.('exit', done)
    child?.once?.('error', done)
  } catch {
    // No events: it stays known as running (excluded) until the process exits.
  }
}

/**
 * The helper pids a table read that started at `since` may still list: every helper running now, and every one that
 * exited at or after `since` (it may have exited while the table was read).
 */
export function shutdownHelperPids(since: number = Number.NEGATIVE_INFINITY): number[] {
  const out: number[] = []
  for (const [pid, exited] of helpers) if (exited === undefined || exited >= since) out.push(pid)
  return out
}

/** Tests: forget every helper. */
export function resetHelperProcessesForTests(): void {
  helpers.clear()
}

// ---------- The process table and the host's descendants (round 6 item 5) ----------

/** One process-table row. `start` identifies the process across pid reuse; `zombie` rows count as gone. */
export interface ProcessRow {
  pid: number
  ppid: number
  start?: string
  zombie?: boolean
}

export type ProcessTable = ReadonlyMap<number, ProcessRow>

/**
 * Parse a process table: POSIX `ps -A -o pid=,ppid=,stat=,lstart=` lines ("pid ppid stat <start text>"), or the
 * Windows reader's "pid ppid ticks" lines. Two-integer lines (no stat, no start) are accepted too. Anything else is
 * skipped.
 */
export function parseProcessTable(text: string): Map<number, ProcessRow> {
  const out = new Map<number, ProcessRow>()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\S+)(?:\s+(.*\S))?)?\s*$/.exec(raw)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    const row: ProcessRow = { pid, ppid }
    const third = m[3]
    const rest = m[4]
    if (third !== undefined && rest === undefined && /^\d+$/.test(third)) {
      // Windows: "pid ppid creationTicks".
      row.start = third
    } else if (third !== undefined) {
      // POSIX: "pid ppid stat lstart...".
      if (third.startsWith('Z')) row.zombie = true
      if (rest !== undefined) row.start = rest.replace(/\s+/g, ' ')
    }
    out.set(pid, row)
  }
  return out
}

/** A Windows row's creation time ("pid ppid ticks": FILETIME ticks); undefined for POSIX rows and unparsable text. */
function windowsTicks(row: ProcessRow | undefined): bigint | undefined {
  const s = row?.start
  if (s === undefined || !/^\d{1,20}$/.test(s)) return undefined
  try {
    return BigInt(s)
  } catch {
    return undefined
  }
}

/**
 * Is `child` really a child of `parent`? POSIX re-parents an orphan (to init or a subreaper), so a ppid always names a
 * live parent. Windows never re-parents: an orphan keeps its dead parent's pid as ParentProcessId, and once that pid is
 * reused the orphan would look like a child of the new process. So on Windows rows a child must not predate its parent
 * (creation ticks: child >= parent; a child whose creation time reads 0 under a parent with one is refused, the safe
 * side).
 */
function isChildOf(parent: ProcessRow | undefined, child: ProcessRow): boolean {
  const parentTicks = windowsTicks(parent)
  if (parentTicks === undefined || parentTicks <= BigInt(0)) return true
  const childTicks = windowsTicks(child)
  // Not a Windows row: nothing to compare (the POSIX rule applies). A Windows row reads 0 when CIM gave no CreationDate.
  if (childTicks === undefined) return true
  return childTicks >= parentTicks
}

/**
 * Every live (non-zombie) descendant of `rootPid` in the table, breadth first; never the root itself. A Windows row
 * whose creation time is older than its claimed parent's is a stale-parent orphan, not a child (isChildOf). Pids in
 * `exclude` are left out with their whole subtree (the desktop host's own Chromium helpers).
 */
export function descendantsOf(table: ProcessTable, rootPid: number, exclude?: ReadonlySet<number>): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of table.values()) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const out: ProcessRow[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()!
    const parent = table.get(pid)
    for (const row of children.get(pid) ?? []) {
      if (seen.has(row.pid)) continue
      if (!isChildOf(parent, row)) continue
      seen.add(row.pid)
      if (exclude?.has(row.pid)) continue
      queue.push(row.pid)
      if (!row.zombie) out.push(row)
    }
  }
  return out
}

/** Remove `pid` and every process under it (zombies included) from the table: the table reader's own tree. */
export function withoutTree(table: Map<number, ProcessRow>, pid: number): void {
  for (const row of descendantsOf(table, pid)) table.delete(row.pid)
  // descendantsOf skips zombies in its answer; drop any zombie child of the reader too.
  for (const row of [...table.values()]) if (row.ppid === pid) table.delete(row.pid)
  table.delete(pid)
}

/** The PowerShell text that prints "pid ppid creationTicks" per process (CIM Win32_Process). */
export const WIN32_PROCESS_TABLE_SCRIPT =
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToFileTimeUtc() }; '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $t }"

/**
 * Read the process table: POSIX `ps -A -o pid=,ppid=,stat=,lstart=` (LC_ALL=C, TZ=UTC so the start text is stable),
 * Windows the CIM Win32_Process table through Windows PowerShell (absolute path, neutral cwd). The reader's own process
 * and its descendants (ps lists itself; PowerShell may start a console host) are left out, since they are children of
 * the host while it reads. Resolves null when the table cannot be read (timeout, missing tool, empty output). Never
 * rejects.
 */
export function readProcessTable(opts: { platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<Map<number, ProcessRow> | null> {
  const platform = opts.platform ?? process.platform
  const timeout = opts.timeoutMs ?? PROCESS_TABLE_TIMEOUT_MS
  const [file, args] =
    platform === 'win32'
      ? [windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN32_PROCESS_TABLE_SCRIPT]]
      : ['ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart=']]
  return new Promise((resolve) => {
    try {
      let readerPid: number | undefined
      const child = execFile(
        file,
        args,
        { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: neutralCwd(), env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
        (err, stdout) => {
          const table = parseProcessTable(String(stdout ?? ''))
          if (readerPid !== undefined) withoutTree(table, readerPid)
          // ps exits non-zero on some systems when a process vanished mid-read but still prints the rest.
          if (table.size === 0) resolve(null)
          else if (err && table.size < 2) resolve(null)
          else resolve(table)
        }
      )
      readerPid = child.pid
      trackHelperProcess(child)
    } catch {
      resolve(null)
    }
  })
}

/**
 * The taskkill arguments for one process: `/PID <pid>` (SIGTERM), plus `/F` for SIGKILL. Never `/T`: the targets are
 * enumerated already (descendantsOf, with the stale-parent check), and taskkill's own tree walk trusts Windows'
 * ParentProcessId, which can name a reused pid, so it could reach an unrelated process.
 */
export function taskkillArgs(pid: number, signal: 'SIGTERM' | 'SIGKILL'): string[] {
  return ['/PID', String(pid), ...(signal === 'SIGKILL' ? ['/F'] : [])]
}

/** Send a signal to one process: POSIX process.kill, Windows `taskkill /PID <pid>` (/F for SIGKILL). Never throws. */
export function signalProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL', platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    try {
      const args = taskkillArgs(pid, signal)
      // taskkill (and its console host) is a child of this host while it runs: never a target of a later pass.
      trackHelperProcess(execFile(system32Path('taskkill.exe'), args, { windowsHide: true, timeout: 5_000, cwd: neutralCwd() }, () => {}))
    } catch {
      // taskkill missing: nothing else to try.
    }
    return
  }
  try {
    process.kill(pid, signal)
  } catch {
    // ESRCH: already gone; EPERM: not ours.
  }
}

export interface KillDescendantsOptions {
  /** Whose descendants (default process.pid). Never signalled itself. */
  rootPid?: number
  platform?: NodeJS.Platform
  /** The process table (default readProcessTable); null = it could not be read. */
  readTable?: () => Promise<ProcessTable | null>
  /** Signal one process (default signalProcess). */
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Extra pids to treat as targets while they are in the table (default the tracked children's pids). */
  extraPids?: () => number[]
  /**
   * Pids that are never targets, with everything under them (re-read on every pass): the desktop host's own Electron
   * processes (app.getAppMetrics: GPU, renderers, network and utility helpers), which Chromium would relaunch as fast as
   * they are killed. Default none.
   */
  excludePids?: () => number[]
  /**
   * The coordinator's own helpers a table read that started at `since` may list (default shutdownHelperPids: table
   * readers and taskkill.exe), left out with their subtrees like excludePids.
   */
  helperPids?: (since: number) => number[]
  /** The clock for helperPids' `since` (default Date.now). */
  now?: () => number
  /**
   * With an unreadable table: signal the tracked children directly (default signalTrackedChildren); returns how many
   * took it. ChildProcess.kill never signals a child that already exited, so a reused pid is never hit.
   */
  signalTracked?: (signal: 'SIGTERM' | 'SIGKILL') => number
  /** How many tracked children are left (default trackedChildCount). */
  trackedCount?: () => number
  termGraceMs?: number
  waitMs?: number
  stepMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (m: string) => void
}

export interface KillDescendantsResult {
  /** Descendants found and signalled, over every read. */
  found: number
  /** Still alive (or unknown, when the table never became readable) when it gave up; 0 = the tree is gone. */
  remaining: number
  /** The table could be read at least once. */
  tableReadable: boolean
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => globalThis.setTimeout(r, ms))

/**
 * Round 6 item 5: enumerate every descendant of the host's pid (not only the tracked children, so a git hook, an
 * agent's shell or an MCP server under an agent CLI are found; excludePids, the coordinator's own helpers (table
 * readers, taskkill.exe: helperPids) and their subtrees left out), SIGTERM them,
 * wait up to termGraceMs (less when all are gone), SIGKILL whatever is left (re-reading the table, so orphans that were
 * re-parented still count by pid and start time), then wait in stepMs steps up to waitMs until none is alive. When the
 * table cannot be read, the tracked children are signalled directly instead (SIGTERM at once, SIGKILL after the grace)
 * and it keeps re-reading in those steps for up to waitMs, then gives up (remaining unknown, reported as 1). Never
 * rejects.
 */
export async function killHostDescendants(opts: KillDescendantsOptions = {}): Promise<KillDescendantsResult> {
  const rootPid = opts.rootPid ?? process.pid
  const platform = opts.platform ?? process.platform
  const readTable = opts.readTable ?? (() => readProcessTable({ platform }))
  const send = opts.signal ?? ((pid: number, sig: 'SIGTERM' | 'SIGKILL') => signalProcess(pid, sig, platform))
  const extraPids = opts.extraPids ?? trackedChildPids
  const excludePids = opts.excludePids
  const helperPids = opts.helperPids ?? shutdownHelperPids
  const now = opts.now ?? Date.now
  const signalTracked = opts.signalTracked ?? signalTrackedChildren
  const trackedCount = opts.trackedCount ?? (() => trackedChildCount())
  const termGraceMs = opts.termGraceMs ?? KILL_TERM_GRACE_MS
  const waitMs = opts.waitMs ?? KILL_WAIT_MS
  const stepMs = Math.max(1, opts.stepMs ?? KILL_STEP_MS)
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => {})
  /** When the newest table read started (helpers that exited after it may still be listed in it). */
  let readStartedAt = now()
  const safeRead = async (): Promise<ProcessTable | null> => {
    readStartedAt = now()
    try {
      return await readTable()
    } catch {
      return null
    }
  }

  /** Every process we decided to end, by pid, with its start text when known (pid reuse guard). */
  const targets = new Map<number, string | undefined>()
  let tableReadable = false
  const excluded = (): Set<number> | undefined => {
    const out = new Set<number>()
    const add = (list: () => number[]): void => {
      try {
        for (const p of list()) if (Number.isSafeInteger(p) && p > 0 && p !== rootPid) out.add(p)
      } catch {
        // An unreadable list excludes nothing.
      }
    }
    if (excludePids) add(excludePids)
    add(() => helperPids(readStartedAt))
    return out.size ? out : undefined
  }
  const absorb = (table: ProcessTable): void => {
    const skip = excluded()
    for (const row of descendantsOf(table, rootPid, skip)) if (!targets.has(row.pid)) targets.set(row.pid, row.start)
    for (const pid of extraPids()) {
      const row = table.get(pid)
      if (pid !== rootPid && row && !row.zombie && !targets.has(pid) && !skip?.has(pid)) targets.set(pid, row.start)
    }
  }
  /** Targets still alive in this table: same pid, same start (when both are known), not a zombie. */
  const aliveIn = (table: ProcessTable): number[] => {
    const out: number[] = []
    for (const [pid, start] of targets) {
      const row = table.get(pid)
      if (!row || row.zombie) continue
      if (start !== undefined && row.start !== undefined && row.start !== start) continue
      out.push(pid)
    }
    return out
  }

  const plural = (n: number): string => `${n} ${n === 1 ? 'process' : 'processes'}`
  // SIGTERM.
  let table = await safeRead()
  let trackedSignalled = false
  if (table) {
    tableReadable = true
    absorb(table)
    for (const pid of targets.keys()) send(pid, 'SIGTERM')
    if (targets.size) log(`Shutdown: sent SIGTERM to ${targets.size} descendant process${targets.size === 1 ? '' : 'es'}.`)
  } else {
    // No table: the children this host tracks are the ones it can still reach, at once rather than after the wait.
    trackedSignalled = true
    const n = signalTracked('SIGTERM')
    log(`Shutdown: the process table could not be read; sent SIGTERM to ${plural(n)} this host tracks.`)
  }

  // Grace: stop early once every target is gone.
  if (targets.size || (trackedSignalled && trackedCount() > 0)) {
    for (let waited = 0; waited < termGraceMs; ) {
      const step = Math.min(stepMs, termGraceMs - waited)
      await sleep(step)
      waited += step
      table = await safeRead()
      if (table && aliveIn(table).length === 0 && descendantsOf(table, rootPid, excluded()).length === 0) break
      if (!table && trackedCount() === 0 && targets.size === 0) break
    }
  }

  // SIGKILL, then wait for the tree to be gone (or for a readable table) in steps.
  let killedOnce = false
  let trackedKilled = false
  for (let waited = 0; ; ) {
    table = await safeRead()
    if (!table && !trackedKilled) {
      // Still no table: SIGKILL what is tracked (after the grace), then keep trying to read it.
      trackedKilled = true
      const n = signalTracked('SIGKILL')
      if (n) log(`Shutdown: the process table could not be read; sent SIGKILL to ${plural(n)} this host tracks.`)
    }
    if (table) {
      tableReadable = true
      absorb(table)
      const alive = aliveIn(table)
      if (alive.length === 0) return { found: targets.size, remaining: 0, tableReadable }
      for (const pid of alive) send(pid, 'SIGKILL')
      if (!killedOnce) log(`Shutdown: sent SIGKILL to ${alive.length} descendant process${alive.length === 1 ? '' : 'es'} that outlived SIGTERM.`)
      killedOnce = true
    }
    if (waited >= waitMs) {
      const left = table ? aliveIn(table) : []
      const remaining = table ? left.length : Math.max(1, targets.size)
      log(
        table
          ? `Shutdown: ${remaining} descendant process${remaining === 1 ? '' : 'es'} still alive after ${waitMs} ms (pid ${left.slice(0, 10).join(', ')}); exiting anyway.`
          : `Shutdown: the process table could not be read for ${waitMs} ms; exiting without knowing whether descendants are gone.`
      )
      return { found: targets.size, remaining, tableReadable }
    }
    await sleep(stepMs)
    waited += stepMs
  }
}

// ---------- The coordinator ----------

/** The slice of HostActivityTracker the coordinator drives. */
export interface ShutdownActivity {
  requestDrain(input?: HostStopInput): Promise<HostStopResult>
  state(): HostState
  snapshot(): HostActivitySnapshot
  /** Stop waiting for writers (the hard limit took over); the tracker's onDrained is then never called. */
  abandonSettle(): void
}

/** What a shutdown that reached 'released' was. */
export interface ShutdownReleaseInfo {
  reason: ShutdownReason
  forced: boolean
  /** The hard limit ended it (descendants killed, writers abandoned). */
  hardLimit: boolean
}

export interface ShutdownCoordinatorOptions {
  /** HostOwnership.release (synchronous, idempotent). */
  release(): void
  /** HostSocketServer.closeGracefully; absent = no socket server (or it closes elsewhere). */
  closeSocket?: (graceMs: number) => Promise<void>
  /** Run state for a handoff stop and host.status (RunManager.handoffFacts plus the socket's terminal sessions). */
  handoffFacts?: () => HostHandoffFacts
  /**
   * Called once ownership is released (normal path or hard limit): the process may exit now (desktop: app.quit;
   * Node host: process.exit; inproc: resolve `closed`). A throw is logged.
   */
  onReleased?: (info: ShutdownReleaseInfo) => void
  /**
   * At the hard limit, after the descendants are gone and the socket closed: end the process now (process.exit), so the
   * exit hooks release ownership once no JavaScript of this host can run any more (4.3: "kills ... and exits; the exit
   * hooks release"). Every real host passes it (desktop and headless: process.exit; inproc and Node: startInprocHost's,
   * which tells the terminal and exits with EXIT.failure), because a hung in-process writer would otherwise still write
   * after the release. Absent (tests) = release here, then onReleased. If it returns, the coordinator releases and
   * calls onReleased as without it.
   */
  exitAtHardLimit?: (info: ShutdownReleaseInfo) => void
  hardLimitMs?: number
  socketGraceMs?: number
  /** The hard limit's tree kill (default killHostDescendants of this process, with excludePids and killTiming). */
  killDescendants?: () => Promise<KillDescendantsResult>
  /** Never killed at the hard limit, with their subtrees (the desktop: Electron's own helper processes). */
  excludePids?: () => number[]
  /** The default tree kill's waits (tests shorten them). */
  killTiming?: Pick<KillDescendantsOptions, 'termGraceMs' | 'waitMs' | 'stepMs'>
  log?: (m: string) => void
}

/** A non-forced shutdown(...) that the activity refused (something is busy). */
export class ShutdownRefusedError extends Error {
  constructor(readonly result: HostStopResult) {
    super('The host is busy; it was not stopped.')
    this.name = 'ShutdownRefusedError'
  }
}

/** The non-zero handoff blocker counts, or undefined when nothing blocks a handoff. */
export function handoffBlockersOf(facts: HostHandoffFacts): Partial<Record<HostHandoffBlocker, number>> | undefined {
  const out: Partial<Record<HostHandoffBlocker, number>> = {}
  let any = false
  for (const k of HOST_HANDOFF_BLOCKERS) {
    const n = facts[k]
    if (typeof n === 'number' && n > 0) {
      out[k] = n
      any = true
    }
  }
  return any ? out : undefined
}

/** The non-zero lease counts of a snapshot, or undefined when the host is idle. */
function busyLeases(snap: HostActivitySnapshot): Partial<Record<ActivityLeaseKind, number>> | undefined {
  const out: Partial<Record<ActivityLeaseKind, number>> = {}
  let any = false
  for (const k of ACTIVITY_LEASE_KINDS) {
    const n = snap.counts[k]
    if (n > 0) {
      out[k] = n
      any = true
    }
  }
  return any ? out : undefined
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

/**
 * The one shutdown sequence of a host (ShutdownCoordinatorApi). Build it first, construct the HostActivityTracker
 * with `activityHooks()`, then `attachActivity(tracker)`. Every drain the tracker starts (host.stop, idle exit, a
 * shutdown(...) call) runs through it, so the hard limit and the release order hold for all of them.
 */
export class ShutdownCoordinator implements ShutdownCoordinatorApi {
  private activity: ShutdownActivity | undefined
  private current: ShutdownPhase = 'running'
  private reason: ShutdownReason | undefined
  /** The reason the next drain start is attributed to (set by stop / shutdown right before requestDrain). */
  private pendingReason: ShutdownReason | undefined
  private forced = false
  private hardTimer: ReturnType<typeof setTimeout> | undefined
  private finishing = false
  private resolveReleased!: () => void
  private readonly releasedP: Promise<void>

  constructor(private readonly opts: ShutdownCoordinatorOptions) {
    this.releasedP = new Promise<void>((r) => (this.resolveReleased = r))
  }

  /** The HostActivityTracker options that route its drain through this coordinator. */
  activityHooks(): { onDrainStart: (force: boolean) => void; onSettling: () => void; onDrained: () => void } {
    return {
      onDrainStart: (force) => this.drainStarted(force),
      onSettling: () => {
        if (this.current === 'draining') this.current = 'settling'
      },
      onDrained: () => void this.finish(false)
    }
  }

  attachActivity(activity: ShutdownActivity): void {
    this.activity = activity
  }

  phase(): ShutdownPhase {
    return this.current
  }

  /** Resolves once ownership is released (never rejects). */
  released(): Promise<void> {
    return this.releasedP
  }

  /** host.status `handoff`; undefined when the host has no run state to report (or it could not be read). */
  handoffFacts(): HostHandoffFacts | undefined {
    return this.readHandoffFacts().facts
  }

  /** The run facts, and whether reading them threw (logged). No handoffFacts option = no facts, not a failure. */
  private readHandoffFacts(): { facts?: HostHandoffFacts; failed: boolean } {
    try {
      const facts = this.opts.handoffFacts?.()
      return facts ? { facts, failed: false } : { failed: false }
    } catch (e) {
      this.log(`Shutdown: reading the handoff facts failed: ${errText(e)}`)
      return { failed: true }
    }
  }

  /**
   * HostControl.stop (host.stop). `handoff` without force applies the stricter handoff predicate first (any live,
   * held or resumable run, or an open card, refuses with handoffBlockers); the activity's lease check follows in the
   * same synchronous step, so nothing can start in between. The predicate fails closed: when the run facts cannot be
   * read the handoff is refused with an empty handoffBlockers (a drain would end runs the user never saw listed; the
   * app then offers "Stop them and open"). Resolves once the drain settled (or with the refusal).
   */
  stop(input: HostStopInput = {}): Promise<HostStopResult> {
    const activity = this.need()
    const force = input.force === true
    if (this.current === 'running' && !force && input.handoff === true) {
      const read = this.readHandoffFacts()
      const blockers = read.failed ? {} : read.facts ? handoffBlockersOf(read.facts) : undefined
      if (blockers) {
        // Refused without touching the drain; the busy leases are reported too, as a plain stop would.
        const busy = busyLeases(activity.snapshot())
        return Promise.resolve({ stopping: false, handoffBlockers: blockers, ...(busy ? { refusedBecause: busy } : {}) })
      }
    }
    if (this.current === 'running') this.pendingReason = input.handoff === true && !force ? 'handoff' : 'host.stop'
    // A forced request that joins a drain under way upgrades it (the tracker runs forceStop once).
    if (force && this.current !== 'released') this.forced = true
    const result = activity.requestDrain({ force })
    this.pendingReason = undefined
    return result
  }

  /**
   * Start the shutdown, or join the one in progress (a forced request upgrades a non-forced one). Resolves once
   * ownership is released. A non-forced request the activity refuses (busy) rejects with ShutdownRefusedError.
   */
  async shutdown(reason: ShutdownReason, opts: { force?: boolean } = {}): Promise<void> {
    if (this.current === 'released') return
    const activity = this.need()
    if (this.current === 'running') this.pendingReason = reason
    if (opts.force === true) this.forced = true
    const result = activity.requestDrain({ force: opts.force === true })
    this.pendingReason = undefined
    const r = await result
    if (!r.stopping) throw new ShutdownRefusedError(r)
    await this.releasedP
  }

  private need(): ShutdownActivity {
    if (!this.activity) throw new Error('The shutdown coordinator has no activity tracker attached.')
    return this.activity
  }

  /** The tracker turned 'draining' (whoever asked): arm the hard limit once. */
  private drainStarted(force: boolean): void {
    if (force) this.forced = true
    if (this.current !== 'running') return
    this.current = 'draining'
    this.reason = this.pendingReason ?? 'idle-exit'
    const limit = this.opts.hardLimitMs ?? SHUTDOWN_HARD_LIMIT_MS
    this.log(`Shutdown (${this.reason}${force ? ', forced' : ''}): draining; ownership is kept until in-flight writes finish (at most ${Math.round(limit / 1000)} s).`)
    // Through globalThis at call time, so vi.useFakeTimers() replaces it. Not unref'd: an in-process host whose only
    // remaining work is a hung writer must still reach the hard limit.
    this.hardTimer = globalThis.setTimeout(() => void this.hardLimit(), limit)
  }

  /** Writers settled (or the hard limit took over): close the socket gracefully, release, hand over to the exit. */
  private async finish(hardLimit: boolean): Promise<void> {
    if (this.finishing) return
    this.finishing = true
    if (this.hardTimer !== undefined) globalThis.clearTimeout(this.hardTimer)
    this.hardTimer = undefined
    this.current = 'closing'
    if (this.opts.closeSocket) {
      const grace = this.opts.socketGraceMs ?? SOCKET_CLOSE_GRACE_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // closeGracefully is bounded by itself; the race only guards against one that never settles.
        await Promise.race([
          this.opts.closeSocket(grace),
          new Promise<void>((r) => (timer = globalThis.setTimeout(r, grace + 500)))
        ])
      } catch (e) {
        this.log(`Shutdown: closing the terminal connections failed: ${errText(e)}`)
      } finally {
        globalThis.clearTimeout(timer)
      }
    }
    const info: ShutdownReleaseInfo = { reason: this.reason ?? 'idle-exit', forced: this.forced, hardLimit }
    if (hardLimit && this.opts.exitAtHardLimit) {
      try {
        // Normally does not return: the process exits and its exit hook releases ownership.
        this.opts.exitAtHardLimit(info)
      } catch (e) {
        this.log(`Shutdown: exiting at the hard limit failed: ${errText(e)}`)
      }
    }
    try {
      this.opts.release()
    } catch (e) {
      this.log(`Shutdown: releasing host ownership failed: ${errText(e)}`)
    }
    this.current = 'released'
    this.resolveReleased()
    try {
      this.opts.onReleased?.(info)
    } catch (e) {
      this.log(`Shutdown: the exit step failed: ${errText(e)}`)
    }
  }

  /** SHUTDOWN_HARD_LIMIT_MS passed with writers still in flight: kill the process tree, then release and exit. */
  private async hardLimit(): Promise<void> {
    this.hardTimer = undefined
    if (this.finishing) return
    const limit = this.opts.hardLimitMs ?? SHUTDOWN_HARD_LIMIT_MS
    this.log(`Shutdown: writers still in flight after ${Math.round(limit / 1000)} s; ending this host's child processes and exiting.`)
    try {
      this.activity?.abandonSettle()
    } catch (e) {
      this.log(`Shutdown: abandoning the writer wait failed: ${errText(e)}`)
    }
    try {
      const kill =
        this.opts.killDescendants ??
        (() =>
          killHostDescendants({
            ...(this.opts.killTiming ?? {}),
            ...(this.opts.excludePids ? { excludePids: this.opts.excludePids } : {}),
            log: (m) => this.log(m)
          }))
      const r = await kill()
      if (r.remaining === 0) this.log(`Shutdown: ${r.found} descendant process${r.found === 1 ? '' : 'es'} ended; releasing the data folder.`)
    } catch (e) {
      this.log(`Shutdown: ending child processes failed: ${errText(e)}`)
    }
    // Whatever the tracked registry still holds (children without a pid, or already outside the tree).
    killTrackedChildren()
    await this.finish(true)
  }

  private log(m: string): void {
    this.opts.log?.(m)
  }
}

/**
 * Route SIGINT / SIGTERM (and SIGHUP on POSIX) of a background host process (the Node host, `daemon run-node`) to a
 * forced shutdown; a second signal while it runs is ignored (the hard limit bounds the wait). Returns an uninstall
 * function. The process exits through the coordinator's onReleased.
 */
export function installShutdownSignals(
  coordinator: Pick<ShutdownCoordinatorApi, 'shutdown'>,
  opts: { target?: Pick<NodeJS.Process, 'on' | 'off'>; platform?: NodeJS.Platform; log?: (m: string) => void } = {}
): () => void {
  const target = opts.target ?? process
  const platform = opts.platform ?? process.platform
  const signals: NodeJS.Signals[] = platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  let started = false
  const handler = (sig: NodeJS.Signals): void => {
    if (started) {
      opts.log?.(`Shutdown: ${sig} received again; the shutdown already under way finishes first.`)
      return
    }
    started = true
    opts.log?.(`Shutdown: ${sig} received; stopping every run and exiting.`)
    void coordinator.shutdown('signal', { force: true }).catch((e: unknown) => opts.log?.(`Shutdown after ${sig} failed: ${errText(e)}`))
  }
  for (const s of signals) target.on(s, handler)
  return () => {
    for (const s of signals) target.off(s, handler)
  }
}
