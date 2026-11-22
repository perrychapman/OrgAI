/**
 * `node:sqlite`, loaded on first use and never at import time.
 *
 * Two reasons. The desktop app's main process imports the stores, and through them the lock modules, but never takes a
 * lock (it is the only process on its data folder), so it must not load a module its Electron build may not ship.
 * And on Node 22 and 24 the first load prints "ExperimentalWarning: SQLite is an experimental feature" on stderr, which
 * a command line tool must not show for a file lock: that one warning is dropped while the module loads (checked on
 * Node 22.22.3; Node 26 prints none). Every other warning passes through unchanged.
 *
 * Only the locking primitives use it (osLock.ts, syncLock.ts): `BEGIN EXCLUSIVE` on an empty file is the one
 * cross-process lock Node offers without a native addon that the kernel releases when its holder dies.
 *
 * Electron-free; relative imports only.
 */
import { createRequire } from 'node:module'

type Sqlite = typeof import('node:sqlite')

let loaded: Sqlite | undefined

function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const first = rest[0]
  const type = typeof first === 'string' ? first : (first as { type?: unknown } | undefined)?.type ?? (warning as { name?: unknown } | null)?.name
  if (type !== 'ExperimentalWarning') return false
  const text = typeof warning === 'string' ? warning : String((warning as { message?: unknown } | null)?.message ?? '')
  return /sqlite/i.test(text)
}

/** The module, loaded once. Throws when this runtime has no `node:sqlite`. */
export function sqlite(): Sqlite {
  if (loaded) return loaded
  const original = process.emitWarning
  process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
    if (isSqliteExperimentalWarning(warning, rest)) return
    ;(original as (...a: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    const builtin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite') as Sqlite | undefined
    loaded = builtin ?? (createRequire(import.meta.url)('node:sqlite') as Sqlite)
  } finally {
    process.emitWarning = original
  }
  return loaded
}

/** Test seam: forget the loaded module so the next call loads (and filters) again. */
export function _resetSqliteForTest(): void {
  loaded = undefined
}
