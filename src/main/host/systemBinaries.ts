import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * Absolute paths for the system programs the host and the CLI run (review H1). Windows' process search (libuv) looks
 * in the spawn's cwd before PATH, and the CLI's cwd is often an untrusted clone, so a bare `powershell.exe`, `icacls`,
 * `rundll32.exe` or `git` could run a planted copy. The convention (anthropicAuth.ts, repoClone.ts) is an absolute
 * `%SystemRoot%\System32\...` path plus `cwd: os.tmpdir()`; git, which is not a system program, is looked up on the
 * absolute PATH entries only and never in a cwd.
 *
 * Pure Node (fs, os, path): no electron import. The Windows paths are UNVERIFIED on Windows (unit-tested with
 * platform injection only).
 */

type Env = Readonly<Record<string, string | undefined>>

/** A drive path (`C:\...` / `C:/...`): never relative, never root-relative, never UNC. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/** `%SystemRoot%` (else `%windir%`) when it is a drive path, else `C:\Windows`. */
export function windowsSystemRoot(env: Env = process.env): string {
  for (const v of [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR]) {
    const t = v?.trim()
    if (t && DRIVE_PATH.test(t) && !/["%\0\r\n]/.test(t)) return win32.normalize(t).replace(/\\+$/, '')
  }
  return 'C:\\Windows'
}

/** `<SystemRoot>\System32\<name>`. */
export function system32Path(name: string, env: Env = process.env): string {
  return win32.join(windowsSystemRoot(env), 'System32', name)
}

/** Windows PowerShell 5.1, always present: `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`. */
export function windowsPowerShellPath(env: Env = process.env): string {
  return win32.join(windowsSystemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The cwd for a child that needs none: the temp dir, never the caller's (maybe untrusted) folder. */
export function neutralCwd(): string {
  return tmpdir()
}

export interface FindOnPathOptions {
  platform?: NodeJS.Platform
  env?: Env
  /** statSync(p).isFile() stand-in (tests). */
  isFile?: (p: string) => boolean
}

const defaultIsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * The first `name` on the absolute PATH entries (relative, empty and '.' entries are skipped, so the cwd is never
 * searched). win32: only `<dir>\<name>.exe` in a drive-path entry (never a .cmd / .bat shim, never UNC); quoted
 * entries are unquoted. Undefined when none is found. Never runs anything.
 */
export function findOnPath(name: string, opts: FindOnPathOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const isFile = opts.isFile ?? defaultIsFile
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const raw = (win ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? ''
  for (const entry of raw.split(win ? ';' : ':')) {
    const dir = win ? entry.trim().replace(/^"(.*)"$/, '$1') : entry
    if (!dir || /[\0\r\n]/.test(dir)) continue
    if (win ? !DRIVE_PATH.test(dir) : !posix.isAbsolute(dir)) continue
    const cand = p.join(dir, win ? `${name}.exe` : name)
    if (isFile(cand)) return cand
  }
  return undefined
}

/** Git for Windows' usual install folders, tried after PATH. */
function windowsGitFallbacks(env: Env): string[] {
  const out: string[] = []
  for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    const t = root?.trim()
    if (t && DRIVE_PATH.test(t)) out.push(win32.join(t, 'Git', 'cmd', 'git.exe'))
  }
  return out
}

export interface FixedBinaryOptions {
  platform?: NodeJS.Platform
  /** statSync(p).isFile() stand-in (tests). */
  isFile?: (p: string) => boolean
}

function fixedBinary(candidates: string[], opts: FixedBinaryOptions): string | undefined {
  if ((opts.platform ?? process.platform) === 'win32') return undefined
  const isFile = opts.isFile ?? defaultIsFile
  return candidates.find((c) => isFile(c))
}

/**
 * The POSIX `ps`: `/bin/ps`, else `/usr/bin/ps`. Never PATH. Undefined when neither exists (or on win32); callers then
 * report the process table / start time as unavailable, never fall back to a bare name.
 */
export function psExecutable(opts: FixedBinaryOptions = {}): string | undefined {
  return fixedBinary(['/bin/ps', '/usr/bin/ps'], opts)
}

/** The POSIX `lsof`: `/usr/sbin/lsof`, else `/usr/bin/lsof`. Never PATH; undefined when neither exists. */
export function lsofExecutable(opts: FixedBinaryOptions = {}): string | undefined {
  return fixedBinary(['/usr/sbin/lsof', '/usr/bin/lsof'], opts)
}

const gitCache = new Map<string, string | undefined>()

/**
 * The git to run. win32: an absolute `git.exe` from PATH (else Git for Windows' install folder), or undefined (git
 * counts as missing; a bare 'git' is never returned). Elsewhere: the absolute PATH hit, else the bare name (execvp only
 * searches a cwd for an empty or relative PATH entry, which `findOnPath` skips). Cached per platform and PATH.
 */
export function gitExecutable(opts: FindOnPathOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const key = `${platform}\0${platform === 'win32' ? (env.Path ?? env.PATH ?? env.path ?? '') : (env.PATH ?? '')}\0${env.ProgramFiles ?? ''}`
  if (!opts.isFile && gitCache.has(key)) return gitCache.get(key)
  const isFile = opts.isFile ?? defaultIsFile
  let found = findOnPath('git', { platform, env, isFile })
  if (!found && platform === 'win32') found = windowsGitFallbacks(env).find((c) => isFile(c))
  const result = found ?? (platform === 'win32' ? undefined : 'git')
  if (!opts.isFile) {
    if (gitCache.size > 16) gitCache.clear()
    gitCache.set(key, result)
  }
  return result
}
