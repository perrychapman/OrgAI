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
 * Entries of an older orgai version are removed when the version changes (`version` stamp in the folder). Any failure
 * is ignored: the cache is an optimisation.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { join } from 'node:path'
import { CLI_VERSION } from './version'

export function compileCacheDir(dataDir: string): string {
  return join(dataDir, 'run', 'compile-cache')
}

let enabled = false

export interface CompileCacheOptions {
  env?: NodeJS.ProcessEnv
  version?: string
  /** `module.enableCompileCache` (tests inject a recorder). */
  enable?: (dir: string) => unknown
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
  const dir = compileCacheDir(dataDir)
  const stamp = join(dir, 'version')
  try {
    let current: string | undefined
    try {
      current = readFileSync(stamp, 'utf8')
    } catch {
      current = undefined
    }
    if (current !== version) {
      // Another orgai version's compiled code is never reused (its files changed); drop it rather than let it pile up.
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(stamp, version, { mode: 0o600 })
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
