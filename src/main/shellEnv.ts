import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * GUI apps launched from Finder or the Dock on macOS (and from a desktop launcher on Linux) inherit the minimal
 * launchd/session PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the one a terminal has. Homebrew, nvm, volta, uvx,
 * docker, claude and codex are then "not found". This resolves the login shell's PATH once at startup and merges
 * in well-known tool directories. Windows GUI apps inherit the full user PATH, so everything here is a no-op there.
 */

export interface ShellPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  timeoutMs?: number
  /** Runs `shell args` and returns stdout; throws on failure or timeout. Injectable for tests. */
  run?: (shell: string, args: string[], timeoutMs: number) => string
  exists?: (path: string) => boolean
  readdir?: (path: string) => string[]
  /** Unique marker seed; defaults to a random string. */
  seed?: string
}

export interface ShellPathResult {
  /** The PATH to use. Equals the current PATH when nothing was added. */
  path: string
  /** Where the additions came from. */
  fromShell: boolean
  /** Directories added, in order. */
  added: string[]
  /** Why the shell lookup was skipped or failed, if it was. */
  note?: string
}

/** Pull the value printed between the markers out of noisy shell output (rc files may print banners). */
export function parseMarkedValue(stdout: string, start: string, end: string): string | undefined {
  const s = stdout.lastIndexOf(start)
  if (s === -1) return undefined
  const from = s + start.length
  const e = stdout.indexOf(end, from)
  if (e === -1) return undefined
  const value = stdout.slice(from, e).trim()
  return value || undefined
}

/** Join PATH lists: entries of `first` keep their order, later lists only add what is missing. Empty entries drop. */
export function mergePaths(lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
  }
  return out
}

function splitPath(value: string | undefined, sep: string): string[] {
  return value ? value.split(sep).filter(Boolean) : []
}

/** Compare dotted versions numerically, newest first. Non-numeric parts sort last. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1
    const y = Number.isFinite(pb[i]) ? pb[i] : -1
    if (x !== y) return y - x
  }
  return 0
}

/** Well-known tool directories that exist on this machine. */
export function wellKnownDirs(
  home: string,
  exists: (p: string) => boolean = existsSync,
  readdir: (p: string) => string[] = (p) => readdirSync(p)
): string[] {
  const dirs = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin')
  ]
  try {
    const versions = join(home, '.nvm', 'versions', 'node')
    const newest = readdir(versions).filter((n) => /^v?\d/.test(n)).sort(compareVersionsDesc)[0]
    if (newest) dirs.push(join(versions, newest, 'bin'))
  } catch {
    /* no nvm */
  }
  dirs.push(join(home, '.cargo', 'bin'))
  return dirs.filter((d) => {
    try {
      return exists(d)
    } catch {
      return false
    }
  })
}

/** Shells that take `-ilc` and expand "$PATH" as one colon-joined string. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'oksh', 'yash'])

/**
 * Which shell to ask and what to run in it. POSIX shells print "$PATH". fish keeps PATH as a list (quoted expansion
 * joins with spaces before fish 3.0), so it prints `string join : $PATH`. csh/tcsh reject `-ilc` and nushell or
 * xonsh quote differently, so any other or relative SHELL falls back to the platform shell.
 */
export function shellInvocation(shellEnv: string | undefined, fallback: string, start: string, end: string): { shell: string; command: string } {
  const posix = (shell: string): { shell: string; command: string } => ({ shell, command: `printf '%s' "${start}$PATH${end}"` })
  if (!shellEnv || !shellEnv.startsWith('/')) return posix(fallback)
  const name = shellEnv.split('/').pop() ?? ''
  if (name === 'fish') return { shell: shellEnv, command: `printf '%s' '${start}'(string join : $PATH)'${end}'` }
  if (POSIX_SHELLS.has(name)) return posix(shellEnv)
  return posix(fallback)
}

function defaultRun(shell: string, args: string[], timeoutMs: number): string {
  return execFileSync(shell, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 1024 * 1024,
    windowsHide: true
  })
}

/**
 * Compute the PATH for this process. Never throws. On win32 (and any other platform) it returns the current PATH
 * unchanged. Existing PATH entries stay first, then the login shell's, then the well-known directories.
 */
export function resolveShellPath(opts: ShellPathOptions = {}): ShellPathResult {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const current = env.PATH ?? env.Path ?? ''
  if (platform !== 'darwin' && platform !== 'linux') return { path: current, fromShell: false, added: [], note: `not needed on ${platform}` }

  const home = opts.home ?? homedir()
  const seed = opts.seed ?? Math.random().toString(36).slice(2, 10)
  const start = `__ORGAI_PATH_${seed}_START__`
  const end = `__ORGAI_PATH_${seed}_END__`
  const fallbackShell = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const { shell, command } = shellInvocation(env.SHELL, fallbackShell, start, end)

  let shellPath: string[] = []
  let note: string | undefined
  try {
    // -i: interactive (zsh reads .zshrc, where nvm/volta/pyenv put themselves), -l: login (.zprofile, where Homebrew does).
    const out = (opts.run ?? defaultRun)(shell, ['-ilc', command], opts.timeoutMs ?? 3000)
    const value = parseMarkedValue(out, start, end)
    if (value) shellPath = splitPath(value, ':')
    else note = 'login shell printed no PATH'
  } catch (e) {
    // A shell that exits non-zero (a failing line at the end of .zshrc) may still have printed the PATH.
    const stdout = (e as { stdout?: unknown }).stdout
    const value = typeof stdout === 'string' ? parseMarkedValue(stdout, start, end) : undefined
    if (value) shellPath = splitPath(value, ':')
    note = `login shell failed: ${(e as Error).message.split('\n')[0]}`
  }

  const extra = wellKnownDirs(home, opts.exists, opts.readdir)
  const currentList = splitPath(current, ':')
  const merged = mergePaths([currentList, shellPath, extra])
  const added = merged.filter((d) => !currentList.includes(d))
  return { path: merged.join(':'), fromShell: shellPath.length > 0, added, ...(note ? { note } : {}) }
}

/** Set process.env.PATH from the login shell. Call once, first thing at startup, before anything spawns. Never throws. */
export function applyShellPath(opts: ShellPathOptions = {}): ShellPathResult | undefined {
  try {
    const result = resolveShellPath(opts)
    const env = opts.env ?? process.env
    if ((opts.platform ?? process.platform) === 'win32') return result
    if (result.path) env.PATH = result.path
    console.log(
      `PATH: ${result.added.length} entr${result.added.length === 1 ? 'y' : 'ies'} added` +
        `${result.fromShell ? ' (login shell)' : ''}${result.added.length ? `: ${result.added.slice(0, 6).join(', ')}` : ''}${result.note ? ` [${result.note}]` : ''}`
    )
    return result
  } catch (e) {
    console.warn(`PATH: could not resolve the shell PATH: ${(e as Error).message}`)
    return undefined
  }
}
