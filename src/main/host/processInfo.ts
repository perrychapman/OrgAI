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
 * darwin: `ps -o lstart=` (second resolution). linux: field 22 of /proc/<pid>/stat (clock ticks since boot).
 * win32: PowerShell StartTime in UTC, ISO 8601 (UNVERIFIED: never run on Windows from this code).
 * Compare values only from the same platform; the formats differ.
 */
export function processStartTime(pid: number): string | undefined {
  if (!validPid(pid)) return undefined
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
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
