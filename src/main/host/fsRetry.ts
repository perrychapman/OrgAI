import { renameSync as fsRenameSync } from 'node:fs'

/**
 * `renameSync` that rides out the transient Windows failures (review M6): Defender, the search indexer or a backup
 * agent briefly holding a handle without FILE_SHARE_DELETE makes MoveFileEx answer EPERM, EBUSY or EACCES for a few
 * milliseconds. Those codes are retried on win32 only (on POSIX they are permanent); every other error, and the last
 * failure, is thrown as is. Synchronous on purpose (callers are sync release paths): it sleeps with Atomics.wait,
 * about 310 ms in all by default. Pure Node.
 */

export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** Delays between attempts (ms): 6 attempts in all. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160]

export interface RenameRetryOptions {
  platform?: NodeJS.Platform
  /** fs.renameSync stand-in (tests). */
  rename?: (from: string, to: string) => void
  /** Synchronous sleep stand-in (tests). */
  sleepSync?: (ms: number) => void
  delaysMs?: readonly number[]
}

const sleepCell = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : undefined

/** Blocks the thread for `ms` (Atomics.wait; a busy loop where SharedArrayBuffer is unavailable). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return
  if (sleepCell) {
    Atomics.wait(sleepCell, 0, 0, ms)
    return
  }
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin */
  }
}

export function renameSyncRetry(from: string, to: string, opts: RenameRetryOptions = {}): void {
  const platform = opts.platform ?? process.platform
  const rename = opts.rename ?? fsRenameSync
  const delays = platform === 'win32' ? (opts.delaysMs ?? RENAME_RETRY_DELAYS_MS) : []
  const sleep = opts.sleepSync ?? sleepSync
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code
      if (attempt >= delays.length || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw e
      sleep(delays[attempt])
    }
  }
}
