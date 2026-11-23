/**
 * A named lock one orgai session holds across awaits, on a data folder several sessions share
 * (docs/design/cli-sessions.md).
 *
 * The data folder's write lock (storeSync.ts) is for synchronous sections of a few milliseconds. Some work on a
 * project is one unit over several awaits (evolving its team: read the ledger, ask a model, change the team, write the
 * ledger) and must not interleave with the same work in another session. That work takes a lock of its own name here,
 * waits its turn for a bounded time, and gives it back when done. A session that ends while holding it lets it go
 * with the process (the lock is a kernel lock, syncLock.ts).
 *
 * In one process the caller serialises its own work (the same name is never taken twice at once here): this module
 * only keeps other processes out. With one process per data folder it is just `fn()`.
 *
 * Electron-free; relative imports only.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionBusyError, sessionsDirOf } from '../../host/sessions'
import { storeSyncFor } from './storeSync'
import { trySyncLock } from './syncLock'

/** How long a session waits for work of the same name in another session before it gives up. */
export const NAMED_LOCK_WAIT_MS = 60_000
const POLL_START_MS = 20
const POLL_CAP_MS = 250

export function namedLockPath(dataDir: string, name: string): string {
  return join(sessionsDirOf(dataDir), `work-${createHash('sha256').update(name).digest('hex').slice(0, 20)}.lock`)
}

/**
 * Run `fn` holding the lock `name` of `dataDir`. Waits up to `waitMs` for another session that holds it, then throws
 * SessionBusyError with `busy` as its message.
 */
export async function withNamedLock<T>(dataDir: string, name: string, fn: () => Promise<T>, opts: { waitMs?: number; busy?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  if (!storeSyncFor(dataDir).shared) return fn()
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const waitMs = opts.waitMs ?? NAMED_LOCK_WAIT_MS
  const path = namedLockPath(dataDir, name)
  mkdirSync(sessionsDirOf(dataDir), { recursive: true, mode: 0o700 })
  const start = Date.now()
  let step = POLL_START_MS
  let held = trySyncLock(path)
  while (!held) {
    const left = waitMs - (Date.now() - start)
    if (left <= 0) throw new SessionBusyError(opts.busy ?? 'Another orgai session is doing the same work; try again when it is done.')
    await sleep(Math.min(step, left))
    step = Math.min(step * 2, POLL_CAP_MS)
    held = trySyncLock(path)
  }
  try {
    return await fn()
  } finally {
    held.release()
  }
}
