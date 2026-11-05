import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { currentHostInstanceId } from '../host/identity'
import { isLiveProcess as defaultIsLiveProcess, selfStartTime } from '../host/processInfo'

/**
 * The repository lock (cli-spec 3.2 (5)). One lock per git repository, keyed by its common git dir, so the main
 * checkout and every linked worktree of one repository share it and two repositories never block each other.
 *
 * Lock order (single, global): 1. reentrancy check (the async call chain already holds this repository: run at once),
 * 2. the in-process promise queue of the repository, then the cross-process dir mutex `<commonDir>/orgai-repo.lock`,
 * 3. run. There is no second (per-checkout) level, so nested calls such as integrateWorktree(root) ->
 * commitLeftovers(wt) cannot deadlock against a concurrent commitLeftovers(wt) (spec R3-1).
 *
 * Callers above this lock (`WorktreeIntegrator.exclusive()` in integration.ts) are always taken first, outside it;
 * nothing inside a withRepoLock scope waits for a user (merge reviews run between two separate scopes).
 *
 * Pure Node: no electron import.
 */

export interface RepoLockLease {
  commonDir: string
  /** Set when the scope that took the lease exits; detached work that outlives it must queue again. */
  released: boolean
}

/** What owner.json in `<commonDir>/orgai-repo.lock` holds. */
export interface RepoLockOwner {
  pid: number
  processStartTime?: string
  hostInstanceId: string
  acquiredAt: number
  /** Random per acquisition, so a release never removes a lock dir someone else took over. */
  token?: string
}

export interface RepoLockRecoveryNotice {
  commonDir: string
  checkout: string
  lockDir: string
  reason: 'dead-owner' | 'missing-owner' | 'leftover'
  previousOwner?: RepoLockOwner
  /** index.lock / MERGE_HEAD files found after the reclaim. Reported only; never deleted. */
  leftovers: string[]
}

export class RepoLockTimeoutError extends Error {
  readonly commonDir: string
  readonly owner?: RepoLockOwner
  readonly waitedMs: number
  constructor(commonDir: string, waitedMs: number, owner?: RepoLockOwner) {
    const who = owner ? `process ${owner.pid} (host ${owner.hostInstanceId}, since ${new Date(owner.acquiredAt).toISOString()})` : 'an unknown process'
    super(`Timed out after ${waitedMs} ms waiting for the repository lock of ${commonDir}, held by ${who}.`)
    this.name = 'RepoLockTimeoutError'
    this.commonDir = commonDir
    this.owner = owner
    this.waitedMs = waitedMs
  }
}

export interface RepoLockConfig {
  timeoutMs?: number
  pollMs?: number
  heartbeatMs?: number
  /** Age after which a lock dir without a readable owner.json counts as stale. */
  missingOwnerGraceMs?: number
  onRecovery?: (notice: RepoLockRecoveryNotice) => void
  isLiveProcess?: (pid: number, startTime?: string) => boolean
}

const DEFAULTS = { timeoutMs: 60_000, pollMs: 100, heartbeatMs: 2000, missingOwnerGraceMs: 2000 }
let config: Required<Omit<RepoLockConfig, 'onRecovery'>> & Pick<RepoLockConfig, 'onRecovery'> = {
  ...DEFAULTS,
  isLiveProcess: (pid, start) => defaultIsLiveProcess(pid, start)
}

/** Change the lock's timings and hooks (tests, Wave 1 host). Fields left out keep their value; `reset` restores defaults. */
export function configureRepoLock(next: RepoLockConfig & { reset?: boolean }): void {
  const base = next.reset ? { ...DEFAULTS, isLiveProcess: (pid: number, start?: string) => defaultIsLiveProcess(pid, start), onRecovery: undefined } : config
  const { reset: _reset, ...rest } = next
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
  config = { ...base, ...defined }
}

export const LOCK_DIR_NAME = 'orgai-repo.lock'
const OWNER_FILE = 'owner.json'

/**
 * Path comparison key: forward slashes, no trailing slash, symlinks resolved where the path exists, case-folded on
 * Windows and macOS (case-insensitive default file systems) but not on Linux.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const key = realpathOfNearest(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key
}

/**
 * Real path of `p`, or for a path that does not exist (yet) the real path of its nearest existing ancestor plus
 * the rest, so /tmp/proj/.claude/worktrees/new keys like /private/tmp/proj/.claude/worktrees/new.
 */
function realpathOfNearest(p: string): string {
  if (!isAbsolute(p)) return p
  const rest: string[] = []
  let cur = p
  // Stop below the filesystem root: resolving "/" alone would turn a foreign path into C:\... on Windows.
  for (let parent = dirname(cur); parent !== cur; cur = parent, parent = dirname(cur)) {
    try {
      const real = realpathSync.native(cur)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      rest.push(basename(cur))
    }
  }
  return p
}

function gitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      done(error ? null : String(stdout).trim())
    })
  })
}

/** `git rev-parse --git-path <rel>` made absolute against the checkout, synchronously (null outside a repository). */
export function gitPathSync(checkout: string, rel: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', rel], {
      cwd: checkout,
      windowsHide: true,
      timeout: 10_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out ? resolve(checkout, out) : null
  } catch {
    return null
  }
}

/** `git rev-parse --git-path <rel>` made absolute against the checkout (null outside a repository). */
export async function gitPath(checkout: string, rel: string): Promise<string | null> {
  const out = await gitOut(checkout, ['rev-parse', '--git-path', rel])
  return out ? resolve(checkout, out) : null
}

interface CommonDir {
  /** Real absolute path, for file-system use. */
  path: string
  /** pathKey of it, for lock identity. */
  key: string
}

/** Resolved common dirs by pathKey(checkout). Only hits are cached, so a folder that becomes a repository later is seen. */
const commonDirCache = new Map<string, CommonDir>()

function nearestExisting(p: string): string | null {
  for (let cur = p, parent = dirname(cur); ; cur = parent, parent = dirname(cur)) {
    try {
      if (statSync(cur).isDirectory()) return cur
    } catch {
      /* missing: go up */
    }
    if (parent === cur) return null
  }
}

/** Lookups in flight by pathKey(checkout): concurrent callers share one, so they reach the queue in arrival order. */
const commonDirInflight = new Map<string, Promise<CommonDir | null>>()

function resolveCommonDir(checkout: string): Promise<CommonDir | null> {
  const ck = pathKey(checkout)
  const pending = commonDirInflight.get(ck)
  if (pending) return pending
  const hit = commonDirCache.get(ck)
  if (hit && existsSync(hit.path)) return Promise.resolve(hit)
  const lookup = lookupCommonDir(checkout, ck)
  commonDirInflight.set(ck, lookup)
  void lookup.then(() => {
    if (commonDirInflight.get(ck) === lookup) commonDirInflight.delete(ck)
  })
  return lookup
}

async function lookupCommonDir(checkout: string, ck: string): Promise<CommonDir | null> {
  // A checkout that is gone (a removed worktree) still belongs to the repository around it: ask from the nearest folder that exists.
  const cwd = nearestExisting(resolve(checkout))
  if (!cwd) return null
  let out = await gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  let line = out?.split(/\r?\n/).pop()?.trim()
  // git older than 2.31 has no --path-format: ask again and resolve the (maybe relative) answer ourselves.
  if (!line || !isAbsolute(line)) {
    out = await gitOut(cwd, ['rev-parse', '--git-common-dir'])
    line = out?.split(/\r?\n/).pop()?.trim()
    if (!line) return null
    line = resolve(cwd, line)
  }
  let real: string
  try {
    real = realpathSync.native(line)
  } catch {
    return null
  }
  const found = { path: real, key: pathKey(real) }
  commonDirCache.set(ck, found)
  return found
}

/** The repository's common git directory (real absolute path), or null when `checkoutPath` is not in a git repository. */
export async function commonGitDir(checkoutPath: string): Promise<string | null> {
  return (await resolveCommonDir(checkoutPath))?.path ?? null
}

/** Leases the current async call chain holds, by lock key. */
const heldLocks = new AsyncLocalStorage<Map<string, RepoLockLease>>()
/** Tail of each lock key's in-process queue. Removed when the last holder releases. */
const queues = new Map<string, Promise<void>>()
/** Lock keys whose lock dir this process currently holds. */
const heldDirs = new Set<string>()
let active = 0

/** Waiters plus holders inside withRepoLock right now (reentrant calls are not counted again). */
export function repoLockActivity(): number {
  return active
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function readOwner(lockDir: string): RepoLockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf8')) as Partial<RepoLockOwner> | null
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.pid) || typeof raw.hostInstanceId !== 'string' || typeof raw.acquiredAt !== 'number') {
      return undefined
    }
    return {
      pid: raw.pid as number,
      hostInstanceId: raw.hostInstanceId,
      acquiredAt: raw.acquiredAt,
      ...(typeof raw.processStartTime === 'string' ? { processStartTime: raw.processStartTime } : {}),
      ...(typeof raw.token === 'string' ? { token: raw.token } : {})
    }
  } catch {
    return undefined
  }
}

function newestMtime(lockDir: string): number | undefined {
  let newest: number | undefined
  for (const p of [lockDir, join(lockDir, OWNER_FILE), join(lockDir, `${OWNER_FILE}.tmp`)]) {
    try {
      const m = statSync(p).mtimeMs
      newest = newest === undefined ? m : Math.max(newest, m)
    } catch {
      /* missing */
    }
  }
  return newest
}

/** index.lock and MERGE_HEAD files a crashed holder may have left. Read-only. */
function inspectLeftovers(commonDir: string, checkout: string): string[] {
  const found: string[] = []
  const candidates = [join(commonDir, 'index.lock'), join(commonDir, 'MERGE_HEAD')]
  try {
    for (const name of readdirSync(join(commonDir, 'worktrees'))) {
      candidates.push(join(commonDir, 'worktrees', name, 'index.lock'), join(commonDir, 'worktrees', name, 'MERGE_HEAD'))
    }
  } catch {
    /* no linked worktrees */
  }
  const own = gitPathSync(checkout, 'MERGE_HEAD')
  if (own) candidates.push(own)
  const seen = new Set<string>()
  for (const c of candidates) {
    const k = pathKey(c)
    if (seen.has(k)) continue
    seen.add(k)
    if (existsSync(c)) found.push(c)
  }
  return found
}

interface DirLock {
  release(): void
}

/**
 * Take `<commonDir>/orgai-repo.lock`. The caller is at the head of the key's in-process queue, so no other lease of
 * this process holds it. Throws RepoLockTimeoutError when a live foreign owner keeps it past the timeout.
 */
async function acquireDirLock(common: CommonDir, checkout: string): Promise<DirLock | null> {
  const lockDir = join(common.path, LOCK_DIR_NAME)
  const started = Date.now()
  const self = { pid: process.pid, hostInstanceId: currentHostInstanceId() }
  for (;;) {
    try {
      mkdirSync(lockDir)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        // Not writable (read-only repository, permissions): keep the in-process lock and say so once per attempt.
        console.warn(`[repoLock] could not create ${lockDir} (${code ?? String(e)}); using the in-process lock only`)
        return null
      }
      const owner = readOwner(lockDir)
      let reason: RepoLockRecoveryNotice['reason'] | undefined
      if (owner) {
        if (owner.pid === self.pid && owner.hostInstanceId === self.hostInstanceId) {
          if (!heldDirs.has(common.key)) reason = 'leftover'
        } else if (!config.isLiveProcess(owner.pid, owner.processStartTime)) reason = 'dead-owner'
      } else {
        const mtime = newestMtime(lockDir)
        if (mtime === undefined) continue // vanished meanwhile: try mkdir again
        if (Date.now() - mtime > config.missingOwnerGraceMs) reason = 'missing-owner'
      }
      if (reason) {
        const stale = `${lockDir}.stale-${randomUUID()}`
        try {
          renameSync(lockDir, stale)
        } catch (re) {
          if ((re as NodeJS.ErrnoException).code === 'ENOENT') continue // another process reclaimed it first
          throw re
        }
        rmSync(stale, { recursive: true, force: true })
        const notice: RepoLockRecoveryNotice = {
          commonDir: common.path,
          checkout,
          lockDir,
          reason,
          ...(owner ? { previousOwner: owner } : {}),
          leftovers: inspectLeftovers(common.path, checkout)
        }
        console.warn(
          `[repoLock] reclaimed a stale repository lock at ${lockDir} (${reason}${owner ? `, pid ${owner.pid}` : ''})` +
            (notice.leftovers.length ? `; left untouched for the user: ${notice.leftovers.join(', ')}` : '')
        )
        try {
          config.onRecovery?.(notice)
        } catch {
          /* a listener never breaks the lock */
        }
        continue
      }
      const waited = Date.now() - started
      if (waited >= config.timeoutMs) throw new RepoLockTimeoutError(common.path, waited, owner)
      await sleep(Math.min(config.pollMs, Math.max(1, config.timeoutMs - waited)))
      continue
    }

    // Ours: publish the owner atomically.
    const mine: RepoLockOwner = {
      pid: self.pid,
      hostInstanceId: self.hostInstanceId,
      acquiredAt: Date.now(),
      token: randomUUID(),
      ...(selfStartTime() !== undefined ? { processStartTime: selfStartTime() } : {})
    }
    const ownerFile = join(lockDir, OWNER_FILE)
    try {
      writeFileSync(`${ownerFile}.tmp`, JSON.stringify(mine), 'utf8')
      renameSync(`${ownerFile}.tmp`, ownerFile)
    } catch (e) {
      rmSync(lockDir, { recursive: true, force: true })
      throw e
    }
    heldDirs.add(common.key)
    const beat = setInterval(() => {
      try {
        const now = new Date()
        utimesSync(ownerFile, now, now)
      } catch {
        /* reclaimed by someone else or gone; the release check handles it */
      }
    }, config.heartbeatMs)
    beat.unref?.()
    return {
      release() {
        clearInterval(beat)
        heldDirs.delete(common.key)
        const now = readOwner(lockDir)
        if (now?.token !== mine.token) {
          console.warn(`[repoLock] ${lockDir} was taken over while held; leaving it`)
          return
        }
        try {
          // Rename first so a concurrent reader never sees a half-removed dir as a lock without an owner.
          const gone = `${lockDir}.stale-${randomUUID()}`
          renameSync(lockDir, gone)
          rmSync(gone, { recursive: true, force: true })
        } catch {
          rmSync(lockDir, { recursive: true, force: true })
        }
      }
    }
  }
}

/**
 * Run `fn` holding the repository lock of `checkoutPath` (any checkout of the repository: main or linked worktree).
 * Serializes ALL git operations per repository (keyed by the common git dir), across processes through
 * `<commonDir>/orgai-repo.lock`, reentrant within one async call chain. A path outside any git repository gets an
 * in-process lock keyed by the path only. Callers queue in arrival order; a rejected fn releases the lock.
 */
export async function withRepoLock<T>(checkoutPath: string, fn: () => Promise<T>): Promise<T> {
  const common = await resolveCommonDir(checkoutPath)
  const key = common ? `git:${common.key}` : `path:${pathKey(checkoutPath)}`
  // Step 1: reentrancy, before any queue.
  const current = heldLocks.getStore()
  const existing = current?.get(key)
  if (existing && !existing.released) return fn()

  // Step 2: the in-process queue, then the cross-process lock dir.
  active++
  const prev = queues.get(key) ?? Promise.resolve()
  let releaseQueue!: () => void
  const mine = new Promise<void>((r) => (releaseQueue = r))
  const tail = prev.then(() => mine)
  queues.set(key, tail)
  let dir: DirLock | null = null
  try {
    await prev
    if (common) dir = await acquireDirLock(common, checkoutPath)
    // Step 3: run with a lease that ends with this scope.
    const lease: RepoLockLease = { commonDir: common?.path ?? checkoutPath, released: false }
    try {
      return await heldLocks.run(new Map([...(current ?? []), [key, lease]]), fn)
    } finally {
      lease.released = true
    }
  } finally {
    try {
      dir?.release()
    } finally {
      releaseQueue()
      if (queues.get(key) === tail) queues.delete(key)
      active--
    }
  }
}

/** Test helper: the lock dir path for a common dir. */
export function lockDirOf(commonDir: string): string {
  return join(commonDir, LOCK_DIR_NAME)
}
