/**
 * How a store stays correct when several orgai processes share its data folder (docs/design/cli-sessions.md).
 *
 * Every store here loads a JSON file once, keeps it in memory, and rewrites the whole file on a change. With one
 * process per data folder that is exact. With several, a process that writes its stale copy back would silently undo
 * what another one saved. A store therefore routes its file access through a `StoreSync`:
 *
 * - `load(file, load)`     the first read: remembers what was on disk.
 * - `refresh(file, reload)` before a read: re-reads when the file changed on disk since this process last read or
 *   wrote it. That is one `stat` per read (about a microsecond, measured), so a session sees what another one saved on
 *   its very next read; `checkMs` can space the checks out, and is 0 by default.
 * - `write(file, reload, fn)` a change: takes the data folder's write lock (one for the whole folder, so sections can
 *   nest and can never deadlock), re-reads the file if it changed, runs `fn` (which changes the in-memory state and
 *   writes the file), remembers the new stamp and lets the lock go. The change is thereby applied to the newest
 *   content, and concurrent writers queue for the few milliseconds a section takes.
 *
 * `fn` must be synchronous. The lock is only ever held inside synchronous code, so it is never held across an await and
 * a process cannot interleave with itself.
 *
 * The desktop app, and every test that does not ask for it, gets {@link SOLO}: the same calls with no lock, no stat and
 * no reload, i.e. exactly the behaviour the stores had before. Only the `orgai` in-process host installs a shared one
 * (`enableStoreSync`), keyed by data folder, before it builds its stores.
 *
 * Electron-free; relative imports only.
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { SessionHandle } from '../../host/sessions'
import { sessionLiveness, writeLockPath } from '../../host/sessions'
import { ReentrantSyncLock } from './syncLock'

export interface StoreSync {
  /** Several processes may share this data folder. */
  readonly shared: boolean
  /** This process's session id; '' when not shared. */
  readonly sessionId: string
  /** The first read of a store's file. */
  load(file: string, load: () => void): void
  /** Before a read: `reload` runs when the file changed on disk. Returns whether it ran. */
  refresh(file: string, reload: () => void): boolean
  /** A change to `file`: see the module comment. `reload` null = the caller keeps no state of this file. */
  write<T>(file: string, reload: (() => void) | null, fn: () => T): T
  /** Run `fn` holding the write lock, for a change that spans several files (each inner `write` nests). */
  locked<T>(fn: () => T): T
  /** Whether session `id` is running. Always false when not shared. */
  isSessionLive(id: string): boolean
  /**
   * This session must hold `projectId` to change it: claims it, or throws ProjectBusyError (host/sessions.ts) when
   * another session has it. A no-op when not shared.
   */
  requireProject(projectId: string, what?: string): void
  /** The session behind a shared sync. */
  readonly session?: SessionHandle
}

/** One process per data folder: no lock, no stat, no reload. */
export const SOLO: StoreSync = {
  shared: false,
  sessionId: '',
  load: (_file, load) => load(),
  refresh: () => false,
  write: (_file, _reload, fn) => fn(),
  locked: (fn) => fn(),
  isSessionLive: () => false,
  requireProject: () => {}
}

const MISSING = 'missing'

/** `missing`, else size:mtime(ns):inode. A rename over the file always changes the inode. */
export function fileStamp(file: string): string {
  try {
    const st = statSync(file, { bigint: true })
    return `${st.size}:${st.mtimeNs}:${st.ino}`
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return MISSING
    throw e
  }
}

export interface SharedStoreSyncOptions {
  /** A read re-checks the file at most this often (ms). Default 0: every read checks. */
  checkMs?: number
  /** How long a write may wait for the lock. Default: the lock's own (15 s). */
  waitMs?: number
  /** How long another session seen running is taken to still be running (ms). Default 500. */
  liveForMs?: number
  now?: () => number
}

/** The sync of a session on a shared data folder. */
export function createSharedStoreSync(session: SessionHandle, opts: SharedStoreSyncOptions = {}): StoreSync & { close(): void } {
  const checkMs = opts.checkMs ?? 0
  const now = opts.now ?? (() => performance.now())
  mkdirSync(dirname(writeLockPath(session.dataDir)), { recursive: true, mode: 0o700 })
  const lock = new ReentrantSyncLock(writeLockPath(session.dataDir), opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {})
  const stamps = new Map<string, string>()
  const checked = new Map<string, number>()
  const alive = sessionLiveness(session.dataDir, opts.liveForMs !== undefined ? { liveForMs: opts.liveForMs } : {})
  return {
    shared: true,
    sessionId: session.id,
    session,
    load(file, load) {
      // The stamp is taken before the read: a write landing in between leaves an older stamp, and the next check
      // reloads once more rather than missing it.
      const stamp = fileStamp(file)
      load()
      stamps.set(file, stamp)
      checked.set(file, now())
    },
    refresh(file, reload) {
      if (checkMs > 0) {
        const t = now()
        const last = checked.get(file)
        if (last !== undefined && t - last < checkMs) return false
        checked.set(file, t)
      }
      const stamp = fileStamp(file)
      if (stamp === stamps.get(file)) return false
      reload()
      stamps.set(file, stamp)
      return true
    },
    write(file, reload, fn) {
      lock.acquire()
      try {
        if (reload) {
          const stamp = fileStamp(file)
          if (stamp !== stamps.get(file)) {
            reload()
            stamps.set(file, stamp)
          }
        }
        const result = fn()
        stamps.set(file, fileStamp(file))
        checked.set(file, now())
        return result
      } finally {
        lock.release()
      }
    },
    locked: (fn) => lock.run(fn),
    isSessionLive: (id) => id === session.id || alive(id),
    requireProject: (projectId, what) => session.requireProject(projectId, what),
    close: () => lock.close()
  }
}

/**
 * One file of a store on a StoreSync: the first load in the constructor, `fresh()` before a read, `change()` around a
 * write. `load(first)` reads the file into the store; with `first` false it is a re-read of a file another session
 * changed, and must leave the store's memory alone when the file cannot be read (it is only ever replaced whole, so
 * that is damage from outside, and writing an emptied copy back would lose what the file held).
 */
export class SyncedFile {
  constructor(
    readonly file: string,
    private readonly sync: StoreSync,
    private readonly load: (first: boolean) => void
  ) {
    sync.load(file, () => load(true))
  }

  get shared(): boolean {
    return this.sync.shared
  }

  /** Before a read. Returns whether the file was re-read. */
  fresh(): boolean {
    return this.sync.refresh(this.file, () => this.load(false))
  }

  /** A change: under the write lock and on the newest content (shared), or directly (one process). */
  change<T>(fn: () => T): T {
    return this.sync.write(this.file, () => this.load(false), fn)
  }

  /**
   * A write that replaces the whole content with something that does not depend on what the file held (a freshly
   * fetched cache): under the write lock, without re-reading first, so the store's memory is not put back to the
   * older content just before it is written.
   */
  replace<T>(fn: () => T): T {
    return this.sync.write(this.file, null, fn)
  }
}

const registry = new Map<string, StoreSync>()

/** The sync for the stores of `dataDir`: the shared one a session installed, else {@link SOLO}. */
export function storeSyncFor(dataDir: string): StoreSync {
  return registry.get(resolve(dataDir)) ?? SOLO
}

/** Install `sync` for `dataDir` (before its stores are built). Returns the function that removes it again. */
export function enableStoreSync(dataDir: string, sync: StoreSync): () => void {
  const key = resolve(dataDir)
  registry.set(key, sync)
  return () => {
    if (registry.get(key) === sync) registry.delete(key)
  }
}
