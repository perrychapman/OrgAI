/**
 * Canonical process start tokens (docs/design/parallel-sessions.md 4.8 "One start token per platform").
 *
 * A token is a tagged string that identifies one process incarnation of a pid, read the same way for a single pid and
 * for the whole table, so the two can be compared:
 *
 * - darwin: `lstart:<ps lstart text, whitespace collapsed>` (`ps` with LC_ALL=C, TZ=UTC);
 * - linux:  `ticks:<n>`, `/proc/<pid>/stat` field 22 (no `ps`);
 * - win32:  `ft:<n>`, the UTC FILETIME of CIM `CreationDate` (a missing or zero creation date is no token).
 *
 * `null` means "the process exists but has no readable token". Tokens of different tags never compare equal. A failed
 * table read is `null` too and means "no information", never "dead". Electron-free; relative imports only.
 */
import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { neutralCwd, psExecutable, windowsPowerShellPath } from './systemBinaries'

export interface StartTokenRow {
  ppid: number
  token: string | null
}
export type StartTokenTable = Map<number, StartTokenRow>

/** How long one token read (ps / PowerShell) may take; a read that hits it reports null (no information). */
export const START_TOKEN_TIMEOUT_MS = 15_000
const TIMEOUT_MS = START_TOKEN_TIMEOUT_MS
const ENV = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC' })

/** True only when both tokens are non-null strings that are identical, tag included. */
export function sameStartToken(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a === b
}

// ---------- pure parsers ----------

/** `/proc/<pid>/stat` text to `{ ppid, token }`. The comm field may hold spaces and parentheses: split after the LAST ')'. */
export function parseLinuxStat(text: string): StartTokenRow | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const f = text.slice(close + 1).trim().split(/\s+/)
  // f[0] is field 3 (state); ppid is field 4, starttime field 22.
  const ppid = Number(f[1])
  const ticks = f[19]
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null
  if (ticks === undefined || !/^\d+$/.test(ticks)) return null
  return { ppid, token: `ticks:${ticks}` }
}

const darwinToken = (lstart: string): string | null => {
  const t = lstart.replace(/\s+/g, ' ').trim()
  return t ? `lstart:${t}` : null
}

/** `ps -A -o pid=,ppid=,lstart=` text (macOS). Unparsable lines are skipped. */
export function parsePsTokenTable(text: string): StartTokenTable {
  const out: StartTokenTable = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    out.set(pid, { ppid, token: darwinToken(m[3]) })
  }
  return out
}

const ftToken = (ticks: string): string | null => (/^\d{1,20}$/.test(ticks) && /[1-9]/.test(ticks) ? `ft:${ticks.replace(/^0+(?=\d)/, '')}` : null)

/** The PowerShell text printing "pid ppid ticks" per process (ticks 0 when CreationDate is missing). */
export const WIN32_TOKEN_TABLE_SCRIPT =
  "Get-CimInstance -ClassName Win32_Process | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToFileTimeUtc() }; '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $t }"

export function win32SingleScript(pid: number): string {
  return `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}'; if (-not $p) { 'GONE' } else { $t = 0; if ($p.CreationDate) { $t = $p.CreationDate.ToFileTimeUtc() }; "$t" }`
}

/** "pid ppid ticks" lines (Windows). */
export function parseWindowsTokenTable(text: string): StartTokenTable {
  const out: StartTokenTable = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    out.set(pid, { ppid, token: ftToken(m[3]) })
  }
  return out
}

/** Output of the single-pid script: 'GONE', or the tick count (0 or garbage is a null token). */
export function parseWindowsSingle(text: string): string | null | 'gone' {
  const t = text.trim()
  if (t === 'GONE') return 'gone'
  return ftToken(t)
}

// ---------- single pid (sync) ----------

/**
 * The start token of `pid`: a token, `null` (exists, token unreadable or the read failed) or 'gone' (does not exist).
 * Synchronous: the Claude spawn function must record before it returns.
 */
export function startTokenOfSync(pid: number, platform: NodeJS.Platform = process.platform): string | null | 'gone' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (platform === 'linux') {
      let text: string
      try {
        text = readFileSync(`/proc/${pid}/stat`, 'utf8')
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : null
      }
      return parseLinuxStat(text)?.token ?? null
    }
    if (platform === 'win32') {
      const ps = windowsPowerShellPath()
      const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', win32SingleScript(pid)], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        windowsHide: true,
        cwd: neutralCwd(),
        env: ENV(),
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return parseWindowsSingle(String(out))
    }
    const ps = psExecutable()
    if (!ps) return null
    try {
      const out = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        cwd: neutralCwd(),
        env: ENV(),
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const token = darwinToken(String(out))
      return token ?? 'gone'
    } catch (e) {
      // ps exits 1 with no output when the pid does not exist.
      const err = e as { status?: number | null; stdout?: unknown; code?: string }
      if (err.status === 1 && !String(err.stdout ?? '').trim() && err.code === undefined) return 'gone'
      return null
    }
  } catch {
    return null
  }
}

// ---------- whole table (async) ----------

async function readLinuxTable(): Promise<StartTokenTable | null> {
  let names: string[]
  try {
    names = (await readdir('/proc')).filter((n) => /^[0-9]+$/.test(n))
  } catch {
    return null
  }
  const out: StartTokenTable = new Map()
  await Promise.all(
    names.map(async (n) => {
      try {
        const row = parseLinuxStat(await readFile(`/proc/${n}/stat`, 'utf8'))
        if (row) out.set(Number(n), row)
      } catch {
        // the process exited while the table was read: simply absent
      }
    })
  )
  return out.size > 0 ? out : null
}

function readViaCommand(file: string, args: string[], parse: (t: string) => StartTokenTable): Promise<StartTokenTable | null> {
  return new Promise((resolve) => {
    try {
      let readerPid: number | undefined
      const child = execFile(
        file,
        args,
        { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: neutralCwd(), env: ENV() },
        (err, stdout) => {
          const table = parse(String(stdout ?? ''))
          // The reader itself (and a console host it started) are children of the host while it reads: leave them out.
          if (readerPid !== undefined) {
            table.delete(readerPid)
            for (const [pid, row] of [...table]) if (row.ppid === readerPid) table.delete(pid)
          }
          // ps exits non-zero when a process vanished mid-read but still prints the rest.
          if (table.size === 0 || (err && table.size < 2)) resolve(null)
          else resolve(table)
        }
      )
      readerPid = child.pid
    } catch {
      resolve(null)
    }
  })
}

/** The whole table as `pid -> { ppid, token }`, or null when it cannot be read (no information; never "dead"). Never rejects. */
export async function readStartTokenTable(platform: NodeJS.Platform = process.platform): Promise<StartTokenTable | null> {
  try {
    if (platform === 'linux') return await readLinuxTable()
    if (platform === 'win32') {
      return await readViaCommand(
        windowsPowerShellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN32_TOKEN_TABLE_SCRIPT],
        parseWindowsTokenTable
      )
    }
    const ps = psExecutable()
    if (!ps) return null
    return await readViaCommand(ps, ['-A', '-o', 'pid=,ppid=,lstart='], parsePsTokenTable)
  } catch {
    return null
  }
}
