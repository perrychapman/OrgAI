/**
 * Synchronous cross-process locks on top of the osLock.ts mechanism (an empty file locked with SQLite's
 * `BEGIN EXCLUSIVE`; the kernel drops a dead process's locks, so no pid or age ever decides that a holder is gone).
 *
 * osLock.ts waits asynchronously and is built for locks held across awaits. The stores, however, are synchronous
 * (RunStore.upsert, ProjectStore.save, SettingsStore.set are called from synchronous code all over the host), and what
 * they need is small: a few milliseconds of mutual exclusion around "re-read the file, change it, write it back". This
 * module gives exactly that, and two lifetime locks:
 *
 * - {@link trySyncLock}: one attempt, no waiting. A session's own lock and its project claims (sessions.ts) are held
 *   this way for the life of the process.
 * - {@link ReentrantSyncLock}: the data folder's write lock (storeSync.ts). `acquire` blocks the thread, polling with a
 *   short jittered backoff, until the lock is free or the wait budget is spent. It must only be held inside synchronous
 *   code (never across an await), so a holder cannot be interleaved by its own process and keeps it for milliseconds.
 *
 * A path locked here is never used with osLock.ts's asynchronous API in the same process (its in-process queue does not
 * know these connections). Different connections of one process exclude each other like different processes do, so a
 * second `trySyncLock` on a held path answers null.
 *
 * Electron-free; relative imports only.
 */
import { lstatSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { LockFileUnsafeError, ensureLockFile, isBusy, isWindowsSharingViolation, lockFileProblem, probeOsLock } from './osLock'
import { sqlite } from './sqliteLoader'

/** The lock stayed held elsewhere for the whole wait budget. */
export class SyncLockBusyError extends Error {
  readonly code = 'busy'
  constructor(readonly path: string, readonly waitedMs: number) {
    super(`The lock ${path} stayed held by another orgai process for ${Math.round(waitedMs)} ms.`)
    this.name = 'SyncLockBusyError'
  }
}

export interface SyncLockHandle {
  readonly path: string
  /** Release once; further calls do nothing. */
  release(): void
}

/** First and largest poll step while waiting (ms). Each sleep is jittered between half and one and a half steps. */
export const SYNC_BACKOFF_START_MS = 1
export const SYNC_BACKOFF_CAP_MS = 25

const sleepCell = new Int32Array(new SharedArrayBuffer(4))

/** Block this thread for `ms` (Atomics.wait on a cell nobody notifies). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms)
}

function open(path: string): DatabaseSync {
  ensureLockFile(path)
  const problem = lockFileProblem(path)
  if (problem) throw new LockFileUnsafeError(path, problem)
  const db = new (sqlite().DatabaseSync)(path)
  try {
    db.exec('PRAGMA busy_timeout = 0')
    // No rollback journal file: an exclusive hold writes nothing (see osLock.ts).
    db.exec('PRAGMA journal_mode = MEMORY')
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK')
  } catch {
    /* closing next */
  }
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

const retryable = (e: unknown): boolean => isBusy(e) || isWindowsSharingViolation(e)

/**
 * Connections that hold a lock right now. A lock lasts until `release()` or the end of the process, never until its
 * handle happens to become unreachable: a collected connection is closed by its finalizer, which would give the lock
 * back silently (seen in a test child whose handle went out of scope). Holding the connection here rules that out.
 */
const holding = new Set<DatabaseSync>()

/**
 * Take the lock at `path` (created if missing) exclusively, trying once. Returns null when another holder has it, in
 * this process or another. Any other failure throws (an unsafe lock file fails closed).
 */
export function trySyncLock(path: string): SyncLockHandle | null {
  let db: DatabaseSync
  try {
    db = open(path)
  } catch (e) {
    if (retryable(e)) return null
    throw e
  }
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (e) {
    closeQuietly(db)
    if (retryable(e)) return null
    throw e
  }
  holding.add(db)
  let released = false
  return {
    path,
    release() {
      if (released) return
      released = true
      holding.delete(db)
      closeQuietly(db)
    }
  }
}

/** Test seam: how many locks taken with trySyncLock this process holds. */
export function _heldSyncLockCount(): number {
  return holding.size
}

/** Whether somebody holds the lock: 'held', 'free', or 'missing' when the file does not exist. Never creates or writes. */
export function probeSyncLock(path: string): 'held' | 'free' | 'missing' {
  return probeOsLock(path)
}

export interface ReentrantSyncLockOptions {
  /** How long `acquire` may block before SyncLockBusyError. Default 15 s. */
  waitMs?: number
  /** Test seams. */
  now?: () => number
  sleep?: (ms: number) => void
  random?: () => number
}

/**
 * One exclusive lock a process takes and gives back many times (the data folder's write lock). The connection stays
 * open between holds, so taking it is one `BEGIN EXCLUSIVE`; an idle connection holds nothing. Re-entrant: nested
 * `acquire` calls count, and only the outermost `release` gives the lock back.
 */
export class ReentrantSyncLock {
  private db: DatabaseSync | undefined
  /** Inode of the lock file the open connection belongs to: a replaced file (a deleted run folder) is reopened. */
  private ino: bigint | undefined
  private depth = 0
  private readonly waitMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => void
  private readonly random: () => number

  constructor(readonly path: string, opts: ReentrantSyncLockOptions = {}) {
    this.waitMs = opts.waitMs ?? 15_000
    this.now = opts.now ?? (() => performance.now())
    this.sleep = opts.sleep ?? sleepSync
    this.random = opts.random ?? Math.random
  }

  /** How deep the current hold is nested (0 = not held). */
  get held(): number {
    return this.depth
  }

  private inodeOf(): bigint | undefined {
    try {
      return lstatSync(this.path, { bigint: true }).ino
    } catch {
      return undefined
    }
  }

  /** The open connection for the file as it is on disk now. */
  private connection(): DatabaseSync {
    const ino = this.inodeOf()
    if (this.db && ino !== undefined && ino === this.ino) return this.db
    if (this.db) closeQuietly(this.db)
    this.db = undefined
    const db = open(this.path)
    this.db = db
    this.ino = this.inodeOf()
    return db
  }

  private tryOnce(): boolean {
    let db: DatabaseSync
    try {
      db = this.connection()
    } catch (e) {
      if (retryable(e)) return false
      throw e
    }
    try {
      db.exec('BEGIN EXCLUSIVE')
      return true
    } catch (e) {
      if (retryable(e)) return false
      throw e
    }
  }

  acquire(): void {
    if (this.depth > 0) {
      this.depth += 1
      return
    }
    const start = this.now()
    let step = SYNC_BACKOFF_START_MS
    for (;;) {
      if (this.tryOnce()) break
      const waited = this.now() - start
      if (waited >= this.waitMs) throw new SyncLockBusyError(this.path, waited)
      this.sleep(Math.min(step * (0.5 + this.random()), this.waitMs - waited))
      step = Math.min(step * 2, SYNC_BACKOFF_CAP_MS)
    }
    this.depth = 1
  }

  release(): void {
    if (this.depth === 0) return
    this.depth -= 1
    if (this.depth > 0) return
    try {
      if (this.db?.isTransaction) this.db.exec('ROLLBACK')
    } catch {
      // A connection that cannot roll back is dropped: closing it gives the lock back.
      if (this.db) closeQuietly(this.db)
      this.db = undefined
    }
  }

  /** Run `fn` holding the lock. `fn` must be synchronous: a promise would outlive the hold. */
  run<T>(fn: () => T): T {
    this.acquire()
    try {
      return fn()
    } finally {
      this.release()
    }
  }

  /** Close the connection (giving back any hold). The lock can be taken again afterwards. */
  close(): void {
    this.depth = 0
    if (this.db) closeQuietly(this.db)
    this.db = undefined
    this.ino = undefined
  }
}
