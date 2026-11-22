/**
 * V8's compile cache for the two large chunks a host-backed command loads (out/cli/inprocHost.mjs and, for the terminal
 * UI, out/cli/tui.mjs). Parsing and compiling them is a fixed cost of every such command; with the cache Node reuses
 * the compiled code of an unchanged file. Measured on the built CLI: about 30 to 40 ms less per such command
 * (`orgai settings list` 237 ms -> 196 ms with NODE_COMPILE_CACHE set by hand, before this module existed).
 *
 * The cache lives in `<dataDir>/run/compile-cache` (mode 0700). Compiled code is trusted input to the process that
 * loads it, so it must sit where agents cannot write: `<dataDir>/run` is the folder agent tools are kept out of
 * (runtime/selfControlGate.ts), next to the session locks. It is never enabled for a command that starts no host
 * (those read the data folder and write nothing), and never against the user's own NODE_COMPILE_CACHE /
 * NODE_DISABLE_COMPILE_CACHE.
 *
 * Each orgai version has its own folder under it (two versions used in turn, a checkout beside an installed one, keep
 * their own compiled code). Folders of other versions that were not used for COMPILE_CACHE_KEEP_MS are removed. Any
 * failure is ignored: the cache is an optimisation.
 */
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import nodeModule from 'node:module'
import { join } from 'node:path'
import { CLI_VERSION } from './version'

export function compileCacheDir(dataDir: string): string {
  return join(dataDir, 'run', 'compile-cache')
}

/** A version's folder is removed once it has not been used for this long (14 days). */
export const COMPILE_CACHE_KEEP_MS = 14 * 24 * 60 * 60 * 1000

/** The folder name of a version: its text with anything but letters, digits, dot, dash and underscore replaced. */
export function versionFolder(version: string): string {
  return `v-${version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown'}`
}

let enabled = false

export interface CompileCacheOptions {
  env?: NodeJS.ProcessEnv
  version?: string
  /** `module.enableCompileCache` (tests inject a recorder). */
  enable?: (dir: string) => unknown
  now?: () => number
}

/** Enable the cache for modules loaded from now on. Once per process; returns the folder, or undefined when left off. */
export function enableCliCompileCache(dataDir: string, opts: CompileCacheOptions = {}): string | undefined {
  if (enabled) return undefined
  enabled = true
  const env = opts.env ?? process.env
  if (env.NODE_COMPILE_CACHE || env.NODE_DISABLE_COMPILE_CACHE) return undefined
  const enable = opts.enable ?? (nodeModule as unknown as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache
  if (typeof enable !== 'function') return undefined
  const version = opts.version ?? CLI_VERSION
  const now = opts.now ?? Date.now
  const root = compileCacheDir(dataDir)
  const dir = join(root, versionFolder(version))
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Used now: the folder's time is what the cleanup of other versions goes by.
    const at = new Date(now())
    utimesSync(dir, at, at)
    for (const name of readdirSync(root)) {
      if (name === versionFolder(version)) continue
      try {
        const other = join(root, name)
        // Another version's compiled code is never reused by this one; it goes once nobody has used it for a while.
        if (now() - statSync(other).mtimeMs > COMPILE_CACHE_KEEP_MS) rmSync(other, { recursive: true, force: true })
      } catch {
        /* another session removed it first, or it is in use */
      }
    }
    enable(dir)
    return dir
  } catch {
    return undefined
  }
}

/** Tests: let the next call enable again. */
export function _resetCompileCacheForTest(): void {
  enabled = false
}
