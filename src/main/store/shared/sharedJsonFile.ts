/**
 * One JSON file shared by several orgai processes (docs/design/parallel-sessions.md 4.4).
 *
 * - `read()` is a cached parse revalidated by `statSync` (size, mtime in nanoseconds, inode) on every call, so a write
 *   by another process shows up on the very next read. A file that fails to parse keeps the last good copy for reads
 *   (the failure is recorded in `lastError`); `update` refuses while the on-disk content is unparseable.
 * - `update(fn)` takes the `config` transaction lock (order 12; reused when this async context already holds it),
 *   re-reads the file from disk ignoring the cache, applies `fn` to a private deep copy, writes with `writeFileAtomic`
 *   (unique temp name, fsync, rename), refreshes the cache stamp and releases. The cached object is never handed to
 *   `fn` and never mutated.
 * - `onExternalChange(cb)` fires from `read()` when it meets a stamp this process did not write.
 *
 * Electron-free; relative imports only.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from './atomicWrite'
import { ORDER, dataLockPath, withLocks, type LockSpec } from './lockOrder'

export interface SharedJsonFileOptions<T> {
  /** Absolute path of the JSON file. */
  file: string
  /** The control directory (`controlPaths(root).root`); the `config` lock lives in `<controlDir>/locks`. */
  controlDir: string
  /** Validate and normalise the parsed JSON. Throw to reject it. */
  parse: (raw: unknown) => T
  /** The value of a missing file. Called fresh each time. */
  empty: () => T
  /** Default: 2-space JSON plus a newline. */
  serialize?: (value: T) => string
  /** How long `update` waits for the `config` lock; default the order's budget (waitFor(ORDER.config), 15 s). */
  waitMs?: number
}

/** `missing` for an absent file, else size:mtimeNs:ino. */
type Stamp = string

const MISSING: Stamp = 'missing'

function stampOf(file: string): Stamp {
  try {
    const st = statSync(file, { bigint: true })
    return `${st.size}:${st.mtimeNs}:${st.ino}`
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return MISSING
    throw e
  }
}

export class SharedJsonFile<T> {
  private readonly file: string
  private readonly controlDir: string
  private readonly parseFn: (raw: unknown) => T
  private readonly emptyFn: () => T
  private readonly serializeFn: (value: T) => string
  private readonly waitMs: number | undefined
  private readonly listeners = new Set<(value: T) => void>()

  /** Stamp the cache (or the recorded failure) corresponds to; null before the first read. */
  private stamp: Stamp | null = null
  private cached: T | null = null
  private failure: Error | null = null
  /** Stamp of the last write made by this process. */
  private ownStamp: Stamp | null = null

  constructor(opts: SharedJsonFileOptions<T>) {
    this.file = opts.file
    this.controlDir = opts.controlDir
    this.parseFn = opts.parse
    this.emptyFn = opts.empty
    this.serializeFn = opts.serialize ?? ((v) => JSON.stringify(v, null, 2) + '\n')
    this.waitMs = opts.waitMs
  }

  /** The parse error of the current on-disk content, or null when it is readable. */
  get lastError(): Error | null {
    return this.failure
  }

  /** Subscribe to changes another process made; returns the unsubscribe function. */
  onExternalChange(cb: (value: T) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  read(): T {
    const stamp = stampOf(this.file)
    if (this.stamp === stamp && (this.cached !== null || this.failure !== null)) return this.cached ?? this.emptyFn()
    const first = this.stamp === null
    const external = !first && stamp !== this.ownStamp
    this.stamp = stamp
    if (stamp === MISSING) {
      this.cached = this.emptyFn()
      this.failure = null
    } else {
      try {
        this.cached = this.parseFn(this.parseFile())
        this.failure = null
      } catch (e) {
        this.failure = e instanceof Error ? e : new Error(String(e))
        if (this.cached === null) this.cached = this.emptyFn()
      }
    }
    if (external) for (const cb of [...this.listeners]) cb(this.cached as T)
    return this.cached as T
  }

  async update(fn: (current: T) => T | Promise<T>): Promise<T> {
    mkdirSync(dirname(dataLockPath(this.controlDir, 'config')), { recursive: true, mode: 0o700 })
    const spec: LockSpec = {
      key: 'config',
      path: dataLockPath(this.controlDir, 'config'),
      mode: 'exclusive',
      kind: 'transaction',
      order: ORDER.config,
      ...(this.waitMs !== undefined ? { waitMs: this.waitMs } : {})
    }
    return withLocks([spec], async () => {
      const current = this.readFresh()
      const next = await fn(structuredClone(current))
      const text = this.serializeFn(next)
      // Validate our own output before it reaches disk, so a bad `fn` result cannot poison the file.
      const reparsed = this.parseFn(JSON.parse(text))
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileAtomic(this.file, text)
      const stamp = stampOf(this.file)
      this.ownStamp = stamp
      this.stamp = stamp
      this.cached = reparsed
      this.failure = null
      return next
    })
  }

  private parseFile(): unknown {
    return JSON.parse(readFileSync(this.file, 'utf8'))
  }

  /** Read from disk ignoring the cache; refuses unparseable content. */
  private readFresh(): T {
    const before = stampOf(this.file)
    if (before === MISSING) return this.emptyFn()
    try {
      return this.parseFn(this.parseFile())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot update ${this.file}: its content could not be read (${msg}). Fix or remove the file.`)
    }
  }
}
