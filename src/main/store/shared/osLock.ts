/**
 * Operating-system file locks through SQLite (docs/design/parallel-sessions.md 4.1). A lock is a 0-byte file that is
 * never written: exclusive = `BEGIN EXCLUSIVE`, shared = `BEGIN` + a read of `sqlite_schema`, release = `ROLLBACK` and
 * close (COMMIT would write a 4 KB header; measured, docs/design/parallel-sessions-locktest). The kernel drops a dead
 * process's locks, so no pid, start time, heartbeat or age ever decides that a holder is gone.
 *
 * This module is the mechanism only: one coordinator per path and process (shared holders share one connection with a
 * reference count; exclusive waiters queue in FIFO order; claims never queue). Lock order, reentrancy per async context
 * and the lock catalogue live in lockOrder.ts.
 *
 * Lock files are never opened, read or closed outside SQLite: closing a raw descriptor would drop this process's POSIX
 * locks on the inode (SQLite "how to corrupt" 2.2). They are checked with lstat only.
 *
 * Electron-free; relative imports only.
 */
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type LockMode = 'exclusive' | 'shared'

/** The lock is held elsewhere (another process, or in-process for a claim). */
export class LockBusyError extends Error {
  readonly code = 'busy'
  constructor(readonly path: string, readonly mode: LockMode) {
    super(`The lock ${path} is held by another holder.`)
    this.name = 'LockBusyError'
  }
}

/** The lock file is not a plain empty file owned by this user (fail closed). */
export class LockFileUnsafeError extends Error {
  readonly code = 'unsafe'
  constructor(readonly path: string, readonly reason: string) {
    super(`The lock file ${path} cannot be used: ${reason}.`)
    this.name = 'LockFileUnsafeError'
  }
}

/** Waiting for the lock was cancelled (shutdown). */
export class LockAbortedError extends Error {
  readonly code = 'aborted'
  constructor(readonly path: string) {
    super(`Waiting for the lock ${path} was cancelled.`)
    this.name = 'LockAbortedError'
  }
}

export interface OsLockHandle {
  readonly path: string
  readonly mode: LockMode
  /** Release once; further calls do nothing. */
  release(): void
}

export interface AcquireOptions {
  /** 0 = a claim: try once, fail at once on any conflict (in-process or OS). */
  waitMs: number
  signal?: AbortSignal
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
}

/**
 * WAL-mode files never belong to a lock (nothing here sets WAL). This module's connections use
 * `journal_mode = MEMORY`, so they never create a `-journal` file. One may still exist: a holder that used SQLite's
 * default mode (an older build, a test child) creates one (512 bytes, zeroed header) and a crashed one leaves it behind;
 * it is never hot because nothing is written, and SQLite removes it when the database is empty (measured,
 * parallel-sessions-locktest). Such a file must be a plain file: SQLite opens, writes and deletes it by name, so a
 * planted link there would redirect those operations.
 */
const SIBLINGS = ['-wal', '-shm']

/**
 * Check a lock file without opening it: a regular, non-link file of size 0, owned by this user on POSIX, with no WAL
 * sibling files and no `-journal` beside it that is anything but a regular file. Returns the reason it is unusable,
 * or null.
 */
export function lockFileProblem(path: string, platform: NodeJS.Platform = process.platform): string | null {
  let st
  try {
    st = lstatSync(path)
  } catch (e) {
    return `it could not be checked (${(e as NodeJS.ErrnoException).code ?? String(e)})`
  }
  if (st.isSymbolicLink()) return 'it is a link'
  if (!st.isFile()) return 'it is not a regular file'
  if (st.size !== 0) return 'it is not empty'
  if (platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) return 'it is owned by another user'
  for (const s of SIBLINGS) if (existsSync(path + s)) return `it has a ${s} file beside it`
  let j
  try {
    j = lstatSync(path + '-journal')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return `its -journal file could not be checked (${code ?? String(e)})`
  }
  if (j && (j.isSymbolicLink() || !j.isFile())) return 'it has a -journal beside it that is not a regular file'
  return null
}

/** Create the lock file if it does not exist (O_CREAT|O_EXCL, 0600, closed before any SQLite connection opens it). */
export function ensureLockFile(path: string): void {
  // An existing entry is never opened here (lockFileProblem judges it next). Skipping the create attempt matters on
  // Windows, where an exclusive create of a file another process holds open can fail with EPERM instead of EEXIST.
  try {
    lstatSync(path)
    return
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    closeSync(openSync(path, 'wx', 0o600))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

function isBusy(e: unknown): boolean {
  const err = e as { errcode?: number; code?: string; message?: string }
  // SQLITE_BUSY (5); SQLITE_LOCKED (6) for a same-process table lock. node:sqlite puts the primary code in errcode.
  return err?.errcode === 5 || err?.errcode === 6 || /database is locked/i.test(String(err?.message ?? ''))
}

/**
 * Windows only: a sharing violation (another process, often a scanner, has the file open without sharing) shows up as
 * EACCES / EPERM (and EBUSY, libuv's mapping of ERROR_SHARING_VIOLATION) from Node or SQLITE_CANTOPEN (14) from
 * SQLite. Spec 4.1 "Waiting": retried like busy. Never on POSIX, where these are real errors and fail closed.
 */
export function isWindowsSharingViolation(e: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const err = e as { errcode?: number; code?: string } | null
  return err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.errcode === 14
}

function openConnection(path: string): DatabaseSync {
  const problem = lockFileProblem(path)
  if (problem) throw new LockFileUnsafeError(path, problem)
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 0')
    // No rollback journal file: an exclusive hold writes nothing, and a -journal path is one more name to trust.
    db.exec('PRAGMA journal_mode = MEMORY')
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

/** Try once on a fresh connection; returns the connection holding the lock, or null when busy. Other errors throw. */
function tryOsLock(path: string, mode: LockMode): DatabaseSync | null {
  let db: DatabaseSync
  try {
    db = openConnection(path)
  } catch (e) {
    if (isBusy(e) || isWindowsSharingViolation(e)) return null
    throw e
  }
  try {
    if (mode === 'exclusive') db.exec('BEGIN EXCLUSIVE')
    else {
      db.exec('BEGIN')
      db.prepare('SELECT count(*) FROM sqlite_schema').get()
    }
    return db
  } catch (e) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK')
    } catch {
      /* the connection is closed next */
    }
    db.close()
    if (isBusy(e) || isWindowsSharingViolation(e)) return null
    throw e
  }
}

function releaseConnection(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK')
  } finally {
    db.close()
  }
}

/**
 * Whether an exclusive holder exists, without creating the file or taking anything: open read-only, take a shared read
 * and give it back. 'missing' when the file does not exist. Hostless readers use only this.
 */
export function probeOsLock(path: string): 'held' | 'free' | 'missing' {
  if (!existsSync(path)) return 'missing'
  const problem = lockFileProblem(path)
  if (problem) throw new LockFileUnsafeError(path, problem)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || !existsSync(path)) return 'missing'
    throw e
  }
  try {
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN')
    db.prepare('SELECT count(*) FROM sqlite_schema').get()
    db.exec('ROLLBACK')
    return 'free'
  } catch (e) {
    if (isBusy(e)) return 'held'
    throw e
  } finally {
    db.close()
  }
}

// ---------- in-process coordinator ----------

interface Waiter {
  mode: LockMode
  resolve: () => void
}

interface PathState {
  shared: { db: DatabaseSync; count: number } | null
  exclusive: DatabaseSync | null
  /** In-process waiters for this path, FIFO. */
  queue: Waiter[]
}

const states = new Map<string, PathState>()

function stateOf(path: string): PathState {
  let st = states.get(path)
  if (!st) {
    st = { shared: null, exclusive: null, queue: [] }
    states.set(path, st)
  }
  return st
}

/** Whether this process can take `mode` on the path right now, as far as its own holders are concerned. */
function inProcessFree(st: PathState, mode: LockMode): boolean {
  if (st.exclusive) return false
  if (mode === 'shared') return true
  return !st.shared
}

function wakeNext(path: string): void {
  const st = states.get(path)
  if (!st) return
  const next = st.queue[0]
  if (next && inProcessFree(st, next.mode)) {
    st.queue.shift()
    next.resolve()
  }
  if (!st.shared && !st.exclusive && st.queue.length === 0) states.delete(path)
}

function makeHandle(path: string, mode: LockMode): OsLockHandle {
  let released = false
  return {
    path,
    mode,
    release() {
      if (released) return
      released = true
      const st = states.get(path)
      if (!st) return
      if (mode === 'exclusive') {
        const db = st.exclusive
        st.exclusive = null
        if (db) releaseConnection(db)
      } else if (st.shared) {
        st.shared.count -= 1
        if (st.shared.count === 0) {
          const db = st.shared.db
          st.shared = null
          releaseConnection(db)
        }
      }
      wakeNext(path)
    }
  }
}

/** One attempt with the in-process state: join an existing shared hold, or try the OS lock. */
function attempt(path: string, mode: LockMode): OsLockHandle | null {
  const st = stateOf(path)
  if (!inProcessFree(st, mode)) return null
  if (mode === 'shared' && st.shared) {
    st.shared.count += 1
    // The next queued waiter may be shared too: it can join now (FIFO chain of shared waiters).
    wakeNext(path)
    return makeHandle(path, mode)
  }
  let db: DatabaseSync | null
  try {
    ensureLockFile(path)
  } catch (e) {
    // Windows: a create racing another process's open (or a scanner) is a sharing violation, retried like busy.
    if (!isWindowsSharingViolation(e)) {
      wakeNext(path)
      throw e
    }
    return null
  }
  try {
    db = tryOsLock(path, mode)
  } catch (e) {
    wakeNext(path)
    throw e
  }
  if (!db) return null
  if (mode === 'shared') {
    st.shared = { db, count: 1 }
    // A shared waiter queued behind this one can join the new hold at once.
    wakeNext(path)
  } else st.exclusive = db
  return makeHandle(path, mode)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Acquire `mode` on the lock file at `path` (created if missing). `waitMs: 0` is a claim: one try, LockBusyError on any
 * conflict. Otherwise waits in FIFO order behind this process's other waiters and retries the OS lock with backoff
 * (5 ms doubling to 100 ms, ±25 % jitter) until `waitMs`, closing the connection between tries. Fails closed on every
 * error other than busy.
 */
export async function acquireOsLock(path: string, mode: LockMode, opts: AcquireOptions): Promise<OsLockHandle> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  if (opts.signal?.aborted) throw new LockAbortedError(path)

  if (opts.waitMs <= 0) {
    const st = stateOf(path)
    // A claim never queues: an in-process waiter ahead of it, or an in-process conflict, is a conflict.
    if (st.queue.length > 0) {
      wakeNext(path)
      throw new LockBusyError(path, mode)
    }
    const h = attempt(path, mode)
    if (!h) {
      wakeNext(path)
      throw new LockBusyError(path, mode)
    }
    return h
  }

  const deadline = now() + opts.waitMs
  const st = stateOf(path)
  // Queue behind in-process holders and earlier waiters (FIFO).
  if (st.queue.length > 0 || !inProcessFree(st, mode)) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { mode, resolve }
      st.queue.push(waiter)
      const onAbort = (): void => {
        const i = st.queue.indexOf(waiter)
        if (i >= 0) st.queue.splice(i, 1)
        reject(new LockAbortedError(path))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        const i = st.queue.indexOf(waiter)
        if (i >= 0) {
          st.queue.splice(i, 1)
          opts.signal?.removeEventListener('abort', onAbort)
          reject(new LockBusyError(path, mode))
        }
      }, Math.max(0, deadline - now()))
      waiter.resolve = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve()
      }
    })
  }

  let delay = 5
  for (;;) {
    if (opts.signal?.aborted) {
      wakeNext(path)
      throw new LockAbortedError(path)
    }
    const h = attempt(path, mode)
    if (h) return h
    const left = deadline - now()
    if (left <= 0) {
      wakeNext(path)
      throw new LockBusyError(path, mode)
    }
    const jittered = delay * (0.75 + random() * 0.5)
    await sleep(Math.min(jittered, left))
    delay = Math.min(delay * 2, 100)
  }
}

/** Restoring a shared hold failed during an upgrade or downgrade: the caller no longer holds anything on the path. */
export class LockLostError extends Error {
  readonly code = 'lost'
  constructor(readonly path: string) {
    super(`The hold on ${path} could not be restored.`)
    this.name = 'LockLostError'
  }
}

/**
 * Turn this process's only shared hold on a path into an exclusive one (parallel-sessions.md 4.1 "Upgrading a session
 * hold"). SQLite cannot upgrade a shared read in place: on the same connection ROLLBACK, then BEGIN EXCLUSIVE once; on
 * busy, take shared again at once and throw LockBusyError. The caller must hold the resource's transaction lock so no
 * other process tries the exclusive form meanwhile; then re-taking shared cannot fail (if it does, LockLostError).
 * Returns the exclusive handle; the shared handle is consumed.
 */
export function upgradeToExclusive(shared: OsLockHandle): OsLockHandle {
  const st = states.get(shared.path)
  if (!st?.shared || shared.mode !== 'shared') throw new Error(`upgradeToExclusive: ${shared.path} is not held shared`)
  if (st.shared.count !== 1 || st.queue.length > 0) throw new LockBusyError(shared.path, 'exclusive')
  const db = st.shared.db
  db.exec('ROLLBACK')
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (e) {
    if (!isBusy(e)) {
      st.shared = null
      releaseConnection(db)
      wakeNext(shared.path)
      throw e
    }
    try {
      db.exec('BEGIN')
      db.prepare('SELECT count(*) FROM sqlite_schema').get()
    } catch {
      st.shared = null
      releaseConnection(db)
      wakeNext(shared.path)
      throw new LockLostError(shared.path)
    }
    throw new LockBusyError(shared.path, 'exclusive')
  }
  st.shared = null
  st.exclusive = db
  // The old shared handle must not release anything any more.
  ;(shared as { release: () => void }).release = () => {}
  return makeHandle(shared.path, 'exclusive')
}

/** The reverse of upgradeToExclusive, inside the same transaction lock: ROLLBACK, take shared again on the connection. */
export function downgradeToShared(exclusive: OsLockHandle): OsLockHandle {
  const st = states.get(exclusive.path)
  if (!st?.exclusive || exclusive.mode !== 'exclusive') throw new Error(`downgradeToShared: ${exclusive.path} is not held exclusive`)
  const db = st.exclusive
  db.exec('ROLLBACK')
  st.exclusive = null
  try {
    db.exec('BEGIN')
    db.prepare('SELECT count(*) FROM sqlite_schema').get()
  } catch {
    releaseConnection(db)
    wakeNext(exclusive.path)
    throw new LockLostError(exclusive.path)
  }
  st.shared = { db, count: 1 }
  ;(exclusive as { release: () => void }).release = () => {}
  const handle = makeHandle(exclusive.path, 'shared')
  // Shared waiters that queued behind the exclusive hold can join the shared one now.
  wakeNext(exclusive.path)
  return handle
}

/** Test seam: how many paths have in-process state (should be 0 when nothing is held or waiting). */
export function _osLockStateCount(): number {
  return states.size
}
