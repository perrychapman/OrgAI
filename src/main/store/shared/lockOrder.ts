/**
 * Lock catalogue, order and reentrancy (docs/design/parallel-sessions.md 4.1-4.2) on top of osLock.ts.
 *
 * Three kinds of lock:
 * - claims never wait (`waitMs` 0): they succeed at once or throw LockBusyError, so they cannot take part in a deadlock
 *   and are exempt from the order;
 * - session holds are shared locks that never wait either (exempt from the order); `admission` is the one hold that
 *   waits, and it is taken first, before anything else, by the host (not through this module's order check);
 * - transaction locks wait (bounded) and are taken in strictly increasing `order`; several of one order in sorted key
 *   order.
 *
 * Every lock the current async context holds is recorded in an AsyncLocalStorage held-set. Asking for a lock already
 * held is reuse, mode-checked: held exclusive satisfies both modes; held shared satisfies only shared (asking for
 * exclusive throws LockOrderError: use upgradeHold). Async children inherit the held-set.
 *
 * Services call assertHeld(key) for every lock they need instead of acquiring it late: a coordinator acquires the whole
 * set up front (coordinate()). A failed assertion is a bug and is never caught as an ordinary failure.
 *
 * Electron-free; relative imports only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { acquireOsLock, downgradeToShared, upgradeToExclusive, type LockMode, type OsLockHandle } from './osLock'

export type LockKind = 'claim' | 'hold' | 'transaction'

/** Transaction lock orders (4.2 table). 7b is 7.5. */
export const ORDER = {
  library: 1,
  team: 2,
  repo: 3,
  oauth: 4,
  network: 5, // plan-usage-<key>, models-discovery, prices-refresh
  codexStart: 6,
  outputs: 7,
  outputFile: 7.5,
  knowledge: 8,
  projectData: 9, // notes-<pid>, engagement-<pid>, staffing-<pid>
  permissions: 10,
  vault: 11,
  config: 12
} as const

/** Wait budgets by order (4.2 table): 60 s up to and including codex-start, 15 s after. */
export function waitFor(order: number): number {
  return order <= ORDER.codexStart ? 60_000 : 15_000
}

export interface LockSpec {
  /** Unique key, e.g. `team-proj_1`, `config`, `chain-run_abc`. Also the file name stem for data-folder locks. */
  key: string
  /** Absolute path of the lock file. */
  path: string
  mode: LockMode
  kind: LockKind
  /** Required for transaction locks. */
  order?: number
  /** Override the wait budget (transaction locks only). */
  waitMs?: number
}

export interface HeldLock {
  spec: LockSpec
  handle: OsLockHandle
}

/** An out-of-order acquisition, a mode upgrade through reuse, or a missing held lock: always a bug. */
export class LockOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockOrderError'
  }
}

/** Thrown inside a coordinator to make it release everything, run `before`, and start over (vault, 6.7). */
export class CoordinatorRetry extends Error {
  constructor(readonly reason: string, readonly before?: () => Promise<void>) {
    super(`Coordinator retry: ${reason}`)
    this.name = 'CoordinatorRetry'
  }
}

type HeldSet = ReadonlyMap<string, HeldLock>

const storage = new AsyncLocalStorage<HeldSet>()

function current(): HeldSet {
  return storage.getStore() ?? new Map()
}

/** The locks the current async context holds. */
export function heldLocks(): HeldLock[] {
  return [...current().values()]
}

/** Assert that the current context holds `key` (in `mode`, when given: exclusive satisfies shared). */
export function assertHeld(key: string, mode?: LockMode): void {
  const h = current().get(key)
  if (!h) throw new LockOrderError(`Lock ${key} is required here but not held (acquire it in the coordinator's set).`)
  if (mode === 'exclusive' && h.spec.mode !== 'exclusive') throw new LockOrderError(`Lock ${key} is held shared, exclusive required.`)
}

function maxTransactionOrder(held: HeldSet): number {
  let m = 0
  for (const h of held.values()) if (h.spec.kind === 'transaction' && typeof h.spec.order === 'number') m = Math.max(m, h.spec.order)
  return m
}

function sortSpecs(specs: readonly LockSpec[]): LockSpec[] {
  // Claims and holds first (they never wait), then transaction locks by order, then key.
  const rank = (s: LockSpec): number => (s.kind === 'transaction' ? (s.order ?? Infinity) : -1)
  return [...specs].sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export interface WithLocksOptions {
  signal?: AbortSignal
}

/**
 * Acquire `specs` (deduplicated by key, sorted: claims and holds first, then transaction locks by order and key), run
 * `fn` with them added to the held-set, release in reverse order. Locks already held are reused (mode-checked). A
 * transaction lock whose order is not above every held transaction lock throws LockOrderError.
 */
export async function withLocks<T>(specs: readonly LockSpec[], fn: () => Promise<T>, opts: WithLocksOptions = {}): Promise<T> {
  const byKey = new Map<string, LockSpec>()
  for (const s of specs) {
    if (s.kind === 'transaction' && typeof s.order !== 'number') throw new LockOrderError(`Transaction lock ${s.key} has no order.`)
    const prev = byKey.get(s.key)
    if (prev && prev.mode !== s.mode) throw new LockOrderError(`Lock ${s.key} requested twice with different modes.`)
    byKey.set(s.key, s)
  }
  const held = current()
  const next = new Map(held)
  const acquired: HeldLock[] = []
  let maxOrder = maxTransactionOrder(held)
  try {
    for (const spec of sortSpecs([...byKey.values()])) {
      const already = held.get(spec.key)
      if (already) {
        if (spec.mode === 'exclusive' && already.spec.mode !== 'exclusive') {
          throw new LockOrderError(`Lock ${spec.key} is held shared; exclusive cannot be taken by reuse (use upgradeHold).`)
        }
        continue
      }
      let waitMs = 0
      if (spec.kind === 'transaction') {
        const order = spec.order as number
        if (!(order > maxOrder)) {
          throw new LockOrderError(`Lock ${spec.key} (order ${order}) taken after a lock of order ${maxOrder}.`)
        }
        waitMs = spec.waitMs ?? waitFor(order)
      }
      const handle = await acquireOsLock(spec.path, spec.mode, { waitMs, signal: opts.signal })
      const entry: HeldLock = { spec, handle }
      acquired.push(entry)
      next.set(spec.key, entry)
      // Several locks of one order are allowed in sorted key order; the next order must be higher.
      if (spec.kind === 'transaction') maxOrder = Math.max(maxOrder, (spec.order as number) - 1e-9)
    }
    return await storage.run(next, fn)
  } finally {
    // Release whatever handle each entry holds now (an upgrade/downgrade may have replaced it).
    for (const h of acquired.reverse()) h.handle.release()
  }
}

export interface CoordinateOptions extends WithLocksOptions {
  maxRetries?: number
}

/**
 * A coordinator (4.2): compute the lock set from a read, acquire it, re-compute it under the locks and check it is the
 * same (else release everything and retry), then run `fn`. A CoordinatorRetry thrown by `fn` releases everything, runs
 * its `before` with no lock held, and starts over. At most `maxRetries` (3) retries of either kind.
 */
export async function coordinate<T>(
  computeSet: () => Promise<readonly LockSpec[]> | readonly LockSpec[],
  fn: () => Promise<T>,
  opts: CoordinateOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  for (let attempt = 0; ; attempt++) {
    const set = await computeSet()
    const keys = (s: readonly LockSpec[]): string => [...new Set(s.map((x) => `${x.key}:${x.mode}`))].sort().join('|')
    const outcome: { again: CoordinatorRetry | 'set-changed' | null } = { again: null }
    const result = await withLocks(
      set,
      async () => {
        const recheck = await computeSet()
        if (keys(recheck) !== keys(set)) {
          outcome.again = 'set-changed'
          return undefined
        }
        try {
          return await fn()
        } catch (e) {
          if (e instanceof CoordinatorRetry) {
            outcome.again = e
            return undefined
          }
          throw e
        }
      },
      opts
    )
    const again = outcome.again
    if (again === null) return result as T
    if (attempt >= maxRetries) {
      throw again === 'set-changed'
        ? new Error('The locks this operation needs kept changing; try again.')
        : new Error(`The operation could not settle: ${again.reason}`)
    }
    if (again !== 'set-changed' && again.before) await again.before()
  }
}

/**
 * Upgrade the current context's shared session hold on `key` to exclusive (4.1), run `fn`, and turn it back into a
 * shared hold afterwards unless `fn` reports the resource gone. `insideKey` names the transaction lock the upgrade must
 * run inside (`team-<pid>` for `project-<pid>`; `repo-<repo>` for `repo-usage-<repo>`); it must be held.
 */
export async function upgradeHold<T>(key: string, insideKey: string, fn: () => Promise<{ value: T; keepHold: boolean }>): Promise<T> {
  assertHeld(insideKey)
  const held = current()
  const h = held.get(key)
  if (!h || h.spec.mode !== 'shared') throw new LockOrderError(`upgradeHold: ${key} is not held shared in this context.`)
  const exclusive = upgradeToExclusive(h.handle)
  const next = new Map(held)
  const exSpec: LockSpec = { ...h.spec, mode: 'exclusive' }
  next.set(key, { spec: exSpec, handle: exclusive })
  let keepHold = true
  try {
    const r = await storage.run(next, fn)
    keepHold = r.keepHold
    return r.value
  } finally {
    if (keepHold) {
      const shared = downgradeToShared(exclusive)
      ;(h as { handle: OsLockHandle }).handle = shared
    } else {
      exclusive.release()
    }
  }
}

// ---------- lock file paths ----------

const KEY_RE = /^[a-z][a-z0-9-]*(?:-[A-Za-z0-9_-]{1,100})?$/

/** A data-folder lock path: `<controlDir>/locks/<key>.lock`. The key is validated. */
export function dataLockPath(controlDir: string, key: string): string {
  if (!KEY_RE.test(key)) throw new LockOrderError(`Invalid lock key ${JSON.stringify(key)}.`)
  return join(controlDir, 'locks', `${key}.lock`)
}

/** A cache lock path keyed by an outside path: `<cacheLocksDir>/<kind>-<sha256(canonicalKey)[0..32]>.lock`. */
export function cacheLockPath(cacheLocksDir: string, kind: string, canonicalKey: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new LockOrderError(`Invalid cache lock kind ${JSON.stringify(kind)}.`)
  const hash = createHash('sha256').update(canonicalKey).digest('hex').slice(0, 32)
  return join(cacheLocksDir, `${kind}-${hash}.lock`)
}
