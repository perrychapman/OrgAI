import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { neutralCwd, windowsPowerShellPath } from './systemBinaries'

/**
 * Process liveness and start time, for the host ownership protocol and the repo lock owner file (cli-spec 3.2).
 * Pure Node: never imports electron, so the CLI's `--host inproc` can use it.
 *
 * A pid alone is not an identity (pids are reused), so owners record their start time beside it. A stale-looking
 * owner is only reported dead when the OS says so (ESRCH) or both start times are known and differ. When either start
 * time is unknown the answer is 'unconfirmed' ({@link processLiveness}): {@link isLiveProcess} counts that as alive,
 * and callers that must not lock the user out forever (ownership.ts) fall back to other evidence for it (review M9).
 */

const EXEC_TIMEOUT_MS = 3000

/**
 * win32: how far two start times may differ and still name one process. This process's own value is computed in
 * process ({@link selfStartTime}: Node's time origin, a little after the OS creation time PowerShell reports), so the
 * two are compared as instants. A reused pid belongs to a process started after the first one exited.
 */
export const WIN32_START_TIME_TOLERANCE_MS = 10_000

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0
}

/**
 * The process's start time as an opaque, comparable string, or undefined when it cannot be read.
 * darwin: `ps -o lstart=` (second resolution), run with LC_ALL=C and TZ=UTC so the text never depends on the reader's
 * locale or time zone (two processes with different LANG / TZ must read one process's start time identically). linux:
 * field 22 of /proc/<pid>/stat (clock ticks since boot).
 * win32: PowerShell StartTime in UTC, ISO 8601, run by absolute path with the temp dir as cwd (review H1; UNVERIFIED:
 * never run on Windows from this code). Compare values with {@link sameStartTime}, only from the same platform.
 *
 * Synchronous: on darwin and win32 it blocks on a child process (up to 3 s). Prefer {@link processStartTimeAsync}.
 */
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!validPid(pid)) return undefined
  try {
    if (platform === 'darwin') {
      const out = execFileSync('ps', psArgs(pid), {
        encoding: 'utf8',
        env: fixedPsEnv(),
        cwd: neutralCwd(),
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      return out || undefined
    }
    if (platform === 'linux') return linuxStartTime(pid)
    if (platform === 'win32') {
      // UNVERIFIED on Windows: Get-Process StartTime may need elevation for other users' processes (then undefined).
      const out = execFileSync(windowsPowerShellPath(), winPsArgs(pid), {
        encoding: 'utf8',
        cwd: neutralCwd(),
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      return out || undefined
    }
  } catch {
    /* gone, no permission, tool missing or timed out */
  }
  return undefined
}

/**
 * {@link processStartTime} without blocking the event loop (review M10): on darwin and win32 the reader child runs
 * through execFile. Same values, same failures (undefined). Never rejects.
 */
export function processStartTimeAsync(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!validPid(pid)) return Promise.resolve(undefined)
  if (platform === 'linux') {
    try {
      return Promise.resolve(linuxStartTime(pid))
    } catch {
      return Promise.resolve(undefined)
    }
  }
  if (platform !== 'darwin' && platform !== 'win32') return Promise.resolve(undefined)
  const file = platform === 'darwin' ? 'ps' : windowsPowerShellPath()
  const args = platform === 'darwin' ? psArgs(pid) : winPsArgs(pid)
  return new Promise((done) => {
    try {
      execFile(
        file,
        args,
        { encoding: 'utf8', cwd: neutralCwd(), timeout: EXEC_TIMEOUT_MS, windowsHide: true, ...(platform === 'darwin' ? { env: fixedPsEnv() } : {}) },
        (err, stdout) => {
          const out = err ? '' : String(stdout ?? '').trim()
          done(out || undefined)
        }
      )
    } catch {
      done(undefined)
    }
  })
}

function psArgs(pid: number): string[] {
  return ['-o', 'lstart=', '-p', String(pid)]
}

function winPsArgs(pid: number): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`]
}

function linuxStartTime(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // The command name (field 2) is in parentheses and may contain spaces or ')'; parse after the last ')'.
  const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
  // rest[0] is field 3 (state), so field 22 (starttime) is rest[19].
  const start = rest[19]
  return start && /^\d+$/.test(start) ? start : undefined
}

/**
 * The caller's environment with every locale variable pinned to C and the time zone to UTC: BSD ps formats lstart with
 * strftime %c in local time, so LANG / LC_* / TZ would otherwise change the string.
 */
function fixedPsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'LANG' || k === 'LANGUAGE' || k === 'TZ' || k.startsWith('LC_')) continue
    env[k] = v
  }
  env.LC_ALL = 'C'
  env.LANG = 'C'
  env.TZ = 'UTC'
  return env
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * True when two recorded start times name the same process. Exact text everywhere but win32, where both must be ISO
 * instants within {@link WIN32_START_TIME_TOLERANCE_MS} (one side may be the in-process {@link selfStartTime}).
 */
export function sameStartTime(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === b) return true
  if (platform !== 'win32' || !ISO_INSTANT.test(a) || !ISO_INSTANT.test(b)) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= WIN32_START_TIME_TOLERANCE_MS
}

let selfStart: { value: string | undefined } | undefined

/**
 * This process's start time, read once. win32: computed in process from Node's time origin (no PowerShell on the main
 * thread before the first window, review M10); others read it with {@link sameStartTime}'s tolerance. Elsewhere the
 * OS value from {@link processStartTime} (ps on darwin is a few ms; /proc on linux).
 */
export function selfStartTime(platform: NodeJS.Platform = process.platform): string | undefined {
  selfStart ??= { value: platform === 'win32' ? inProcessStartTime() : processStartTime(process.pid, platform) }
  return selfStart.value
}

function inProcessStartTime(): string | undefined {
  const origin = typeof performance !== 'undefined' ? performance.timeOrigin : Date.now() - process.uptime() * 1000
  return Number.isFinite(origin) && origin > 0 ? new Date(Math.round(origin)).toISOString() : undefined
}

/** Tests: forget the cached {@link selfStartTime}. */
export function resetSelfStartTimeForTests(): void {
  selfStart = undefined
}

export interface LiveProcessDeps {
  /** process.kill stand-in (signal 0 probe). */
  kill?: (pid: number, signal: 0) => unknown
  /** processStartTime stand-in. */
  startTimeOf?: (pid: number) => string | undefined
  /** Default process.platform (the start time comparison, {@link sameStartTime}). */
  platform?: NodeJS.Platform
}

export interface LiveProcessDepsAsync extends Omit<LiveProcessDeps, 'startTimeOf'> {
  startTimeOf?: (pid: number) => string | undefined | Promise<string | undefined>
}

/**
 * - 'dead': an invalid pid, a pid the OS says does not exist (ESRCH), or a start time known on both sides that differs
 *   (pid reuse).
 * - 'same': the pid exists and both start times are known and match.
 * - 'unconfirmed': the pid exists (or the probe was unclear, e.g. EPERM) but a start time is unknown on either side, so
 *   it may be the recorded process or a stranger that got its pid.
 */
export type Liveness = 'dead' | 'same' | 'unconfirmed'

function signalProbe(pid: number, deps: { kill?: LiveProcessDeps['kill'] }): boolean {
  const kill = deps.kill ?? ((p: number, s: 0) => process.kill(p, s))
  try {
    kill(pid, 0)
  } catch (e) {
    // EPERM: it exists but belongs to someone else. Any other failure: unsure, so it stays a candidate.
    if ((e as NodeJS.ErrnoException | null)?.code === 'ESRCH') return false
  }
  return true
}

function judge(startTime: string | undefined, current: string | undefined, platform: NodeJS.Platform): Liveness {
  if (startTime === undefined || startTime === '' || current === undefined || current === '') return 'unconfirmed'
  return sameStartTime(current, startTime, platform) ? 'same' : 'dead'
}

/** See {@link Liveness}. Reads the start time synchronously ({@link processStartTime}). */
export function processLiveness(pid: number, startTime?: string, deps: LiveProcessDeps = {}): Liveness {
  if (!validPid(pid) || !signalProbe(pid, deps)) return 'dead'
  if (startTime === undefined || startTime === '') return 'unconfirmed'
  return judge(startTime, (deps.startTimeOf ?? processStartTime)(pid), deps.platform ?? process.platform)
}

/** {@link processLiveness} reading the start time without blocking ({@link processStartTimeAsync}). */
export async function processLivenessAsync(pid: number, startTime?: string, deps: LiveProcessDepsAsync = {}): Promise<Liveness> {
  if (!validPid(pid) || !signalProbe(pid, deps)) return 'dead'
  if (startTime === undefined || startTime === '') return 'unconfirmed'
  const read = deps.startTimeOf ?? ((p: number) => processStartTimeAsync(p))
  let current: string | undefined
  try {
    current = await read(pid)
  } catch {
    current = undefined
  }
  return judge(startTime, current, deps.platform ?? process.platform)
}

/**
 * True when `pid` is (probably) the same live process that recorded `startTime`: {@link processLiveness} is not
 * 'dead'. EPERM (alive, another user's) and an unknown start time on either side answer true: never report dead when
 * unsure.
 */
export function isLiveProcess(pid: number, startTime?: string, deps: LiveProcessDeps = {}): boolean {
  return processLiveness(pid, startTime, deps) !== 'dead'
}

/** How long a start-time answer is trusted before {@link isLiveProcessCached} reads the start time again. */
export const START_TIME_RECHECK_MS = 5000
const LIVENESS_CACHE_MAX = 256
/**
 * `${pid}\0${startTime}` -> the last non-dead answer and when it was read. An 'unconfirmed' answer is kept too (the
 * reader failed; asking again on every poll would spawn PowerShell each time), and it stays 'unconfirmed'.
 */
const answers = new Map<string, { at: number; state: Exclude<Liveness, 'dead'> }>()

function remember(key: string, now: number, state: Liveness): void {
  if (state === 'dead') {
    answers.delete(key)
    return
  }
  if (answers.size >= LIVENESS_CACHE_MAX) answers.clear()
  answers.set(key, { at: now, state })
}

/** The cached answer for `key` while it is fresh and the pid still exists; 'dead' once the OS says it is gone. */
function cachedAnswer(key: string, pid: number, now: number, deps: { kill?: LiveProcessDeps['kill']; recheckMs?: number }): Liveness | undefined {
  const hit = answers.get(key)
  if (!hit || now - hit.at >= (deps.recheckMs ?? START_TIME_RECHECK_MS)) return undefined
  if (validPid(pid) && signalProbe(pid, deps)) return hit.state
  answers.delete(key)
  return 'dead'
}

/**
 * {@link isLiveProcess} for polling loops (the CLI's host watchers): reading another process's start time spawns `ps`
 * (darwin) or PowerShell (win32) synchronously, so once it was read for (pid, startTime) only the cheap signal-0 probe
 * runs until `recheckMs` has passed. A pid the OS reports gone is dead at once either way.
 */
export function isLiveProcessCached(
  pid: number,
  startTime?: string,
  deps: LiveProcessDeps & { now?: () => number; recheckMs?: number } = {}
): boolean {
  if (startTime === undefined || startTime === '') return isLiveProcess(pid, startTime, deps)
  const now = (deps.now ?? Date.now)()
  const key = `${pid}\0${startTime}`
  const cached = cachedAnswer(key, pid, now, deps)
  if (cached !== undefined) return cached !== 'dead'
  const state = processLiveness(pid, startTime, deps)
  remember(key, now, state)
  return state !== 'dead'
}

/** {@link processLivenessAsync} with {@link isLiveProcessCached}'s cache (the host ownership and repo lock loops). */
export async function processLivenessCachedAsync(
  pid: number,
  startTime?: string,
  deps: LiveProcessDepsAsync & { now?: () => number; recheckMs?: number } = {}
): Promise<Liveness> {
  if (startTime === undefined || startTime === '') return processLivenessAsync(pid, startTime, deps)
  const now = (deps.now ?? Date.now)()
  const key = `${pid}\0${startTime}`
  const cached = cachedAnswer(key, pid, now, deps)
  if (cached !== undefined) return cached
  const state = await processLivenessAsync(pid, startTime, deps)
  remember(key, now, state)
  return state
}
