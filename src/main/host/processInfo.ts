import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * Process liveness and start time, for the host ownership protocol and the repo lock owner file (cli-spec 3.2).
 * Pure Node: never imports electron, so the CLI's `--host inproc` can use it.
 *
 * A pid alone is not an identity (pids are reused), so owners record their start time beside it. Every answer here
 * fails toward "alive": a stale-looking owner is only reported dead when the OS says so (ESRCH) or both start times are
 * known and differ.
 */

const EXEC_TIMEOUT_MS = 3000

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0
}

/**
 * The process's start time as an opaque, comparable string, or undefined when it cannot be read.
 * darwin: `ps -o lstart=` (second resolution), run with LC_ALL=C and TZ=UTC so the text never depends on the reader's
 * locale or time zone (two processes with different LANG / TZ must read one process's start time identically). linux: field 22 of /proc/<pid>/stat (clock ticks since boot).
 * win32: PowerShell StartTime in UTC, ISO 8601 (UNVERIFIED: never run on Windows from this code).
 * Compare values only from the same platform; the formats differ.
 */
export function processStartTime(pid: number): string | undefined {
  if (!validPid(pid)) return undefined
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: fixedPsEnv(),
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      return out || undefined
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // The command name (field 2) is in parentheses and may contain spaces or ')'; parse after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
      // rest[0] is field 3 (state), so field 22 (starttime) is rest[19].
      const start = rest[19]
      return start && /^\d+$/.test(start) ? start : undefined
    }
    if (process.platform === 'win32') {
      // UNVERIFIED on Windows: Get-Process StartTime may need elevation for other users' processes.
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`],
        { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return out || undefined
    }
  } catch {
    /* gone, no permission, tool missing or timed out */
  }
  return undefined
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

let selfStart: { value: string | undefined } | undefined

/** This process's start time, read once. */
export function selfStartTime(): string | undefined {
  selfStart ??= { value: processStartTime(process.pid) }
  return selfStart.value
}

export interface LiveProcessDeps {
  /** process.kill stand-in (signal 0 probe). */
  kill?: (pid: number, signal: 0) => unknown
  /** processStartTime stand-in. */
  startTimeOf?: (pid: number) => string | undefined
}

/**
 * True when `pid` is (probably) the same live process that recorded `startTime`. False only for an invalid pid, a
 * pid the OS says does not exist (ESRCH), or a start time that is known on both sides and differs (pid reuse).
 * EPERM (alive, another user's) and an unknown start time on either side answer true: never report dead when unsure.
 */
export function isLiveProcess(pid: number, startTime?: string, deps: LiveProcessDeps = {}): boolean {
  if (!validPid(pid)) return false
  const kill = deps.kill ?? ((p: number, s: 0) => process.kill(p, s))
  try {
    kill(pid, 0)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code
    // EPERM: it exists but belongs to someone else. Any other failure: unsure, so it stays a candidate.
    if (code === 'ESRCH') return false
  }
  if (startTime === undefined || startTime === '') return true
  const current = (deps.startTimeOf ?? processStartTime)(pid)
  if (current === undefined || current === '') return true
  return current === startTime
}

/** How long a confirmed start-time match is trusted before {@link isLiveProcessCached} reads the start time again. */
export const START_TIME_RECHECK_MS = 5000
const LIVENESS_CACHE_MAX = 256
/** `${pid}\0${startTime}` -> when the start time last matched. */
const confirmed = new Map<string, number>()

/**
 * {@link isLiveProcess} for polling loops (the repo lock, the startup mutex): reading another process's start time
 * spawns `ps` (darwin) or PowerShell (win32) synchronously, so once it matched for (pid, startTime) only the cheap
 * signal-0 probe runs until `recheckMs` has passed. A pid the OS reports gone is dead at once either way.
 */
export function isLiveProcessCached(
  pid: number,
  startTime?: string,
  deps: LiveProcessDeps & { now?: () => number; recheckMs?: number } = {}
): boolean {
  if (startTime === undefined || startTime === '') return isLiveProcess(pid, startTime, deps)
  const now = (deps.now ?? Date.now)()
  const key = `${pid}\0${startTime}`
  const at = confirmed.get(key)
  if (at !== undefined && now - at < (deps.recheckMs ?? START_TIME_RECHECK_MS)) {
    if (isLiveProcess(pid, undefined, deps)) return true
    confirmed.delete(key)
    return false
  }
  const live = isLiveProcess(pid, startTime, deps)
  if (live) {
    if (confirmed.size >= LIVENESS_CACHE_MAX) confirmed.clear()
    confirmed.set(key, now)
  } else confirmed.delete(key)
  return live
}
