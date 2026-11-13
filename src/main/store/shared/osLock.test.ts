import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LockAbortedError,
  LockBusyError,
  LockFileUnsafeError,
  _osLockStateCount,
  acquireOsLock,
  ensureLockFile,
  lockFileProblem,
  probeOsLock
} from './osLock'
import { killAndWait } from './testing/viteNode'

let dir: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oslock-'))
})
afterEach(async () => {
  // Wait for the children to exit first: on Windows a lock file a live child holds cannot be unlinked (EBUSY).
  await killAndWait(children)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A child process that takes `mode` on `path` with plain node:sqlite and prints "held" (or "busy"), then waits. */
function holder(path: string, mode: 'exclusive' | 'shared'): Promise<ChildProcess> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA busy_timeout = 0')
    try {
      if (${JSON.stringify(mode)} === 'exclusive') db.exec('BEGIN EXCLUSIVE')
      else { db.exec('BEGIN'); db.prepare('SELECT count(*) FROM sqlite_schema').get() }
      process.stdout.write('held\\n')
    } catch (e) { process.stdout.write('busy\\n') }
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', (d: Buffer) => (String(d).startsWith('held') ? resolve(child) : reject(new Error(String(d)))))
    child.once('error', reject)
  })
}

const killed = (c: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve()
    c.once('exit', () => resolve())
    c.kill('SIGKILL')
  })

describe('osLock in one process', () => {
  it('a claim on a held exclusive lock fails at once; after release it succeeds', async () => {
    const p = join(dir, 'a.lock')
    const h = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    await expect(acquireOsLock(p, 'shared', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    h.release()
    h.release()
    const h2 = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    h2.release()
    expect(_osLockStateCount()).toBe(0)
  })

  it('shared holders share one hold; exclusive waits for all of them', async () => {
    const p = join(dir, 's.lock')
    const a = await acquireOsLock(p, 'shared', { waitMs: 0 })
    const b = await acquireOsLock(p, 'shared', { waitMs: 0 })
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    a.release()
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    const waiting = acquireOsLock(p, 'exclusive', { waitMs: 2000 })
    b.release()
    const x = await waiting
    x.release()
    expect(_osLockStateCount()).toBe(0)
  })

  it('in-process exclusive waiters are served in FIFO order', async () => {
    const p = join(dir, 'f.lock')
    const first = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    const order: string[] = []
    const w1 = acquireOsLock(p, 'exclusive', { waitMs: 3000 }).then((h) => {
      order.push('w1')
      h.release()
    })
    const w2 = acquireOsLock(p, 'exclusive', { waitMs: 3000 }).then((h) => {
      order.push('w2')
      h.release()
    })
    first.release()
    await Promise.all([w1, w2])
    expect(order).toEqual(['w1', 'w2'])
  })

  it('a wait times out with LockBusyError and an abort signal cancels a wait', async () => {
    const p = join(dir, 't.lock')
    const h = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 60 })).rejects.toBeInstanceOf(LockBusyError)
    const ac = new AbortController()
    const waiting = acquireOsLock(p, 'exclusive', { waitMs: 5000, signal: ac.signal })
    ac.abort()
    await expect(waiting).rejects.toBeInstanceOf(LockAbortedError)
    h.release()
    expect(_osLockStateCount()).toBe(0)
  })

  it('the lock file stays empty with no SQLite sibling after use', async () => {
    const p = join(dir, 'z.lock')
    ;(await acquireOsLock(p, 'exclusive', { waitMs: 0 })).release()
    ;(await acquireOsLock(p, 'shared', { waitMs: 0 })).release()
    expect(statSync(p).size).toBe(0)
    for (const s of ['-journal', '-wal', '-shm']) expect(existsSync(p + s)).toBe(false)
  })
})

describe('osLock across processes', () => {
  it('an exclusive holder in another process blocks a claim; kill -9 releases it', async () => {
    const p = join(dir, 'x.lock')
    ensureLockFile(p)
    const child = await holder(p, 'exclusive')
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    await expect(acquireOsLock(p, 'shared', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    expect(probeOsLock(p)).toBe('held')
    await killed(child)
    expect(probeOsLock(p)).toBe('free')
    ;(await acquireOsLock(p, 'exclusive', { waitMs: 0 })).release()
  })

  it('a waiter gets the lock when the other process dies', async () => {
    const p = join(dir, 'w.lock')
    ensureLockFile(p)
    const child = await holder(p, 'exclusive')
    const waiting = acquireOsLock(p, 'exclusive', { waitMs: 5000 })
    setTimeout(() => child.kill('SIGKILL'), 150)
    ;(await waiting).release()
  })

  it('shared holders in two processes coexist and exclude an exclusive claim', async () => {
    const p = join(dir, 'sh.lock')
    ensureLockFile(p)
    await holder(p, 'shared')
    const mine = await acquireOsLock(p, 'shared', { waitMs: 0 })
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    // A shared hold is not an exclusive one: the probe reports free.
    expect(probeOsLock(p)).toBe('free')
    mine.release()
  })

  it.skipIf(process.platform === 'win32')('a stopped (SIGSTOP) holder keeps its lock', async () => {
    const p = join(dir, 'stop.lock')
    ensureLockFile(p)
    const child = await holder(p, 'exclusive')
    child.kill('SIGSTOP')
    await expect(acquireOsLock(p, 'exclusive', { waitMs: 300 })).rejects.toBeInstanceOf(LockBusyError)
    child.kill('SIGCONT')
    await killed(child)
    ;(await acquireOsLock(p, 'exclusive', { waitMs: 0 })).release()
  })

  it('a same-process probe of a held lock leaves another process excluded', async () => {
    const p = join(dir, 'pp.lock')
    const mine = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    expect(probeOsLock(p)).toBe('held')
    const script = `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(${JSON.stringify(p)})
      db.exec('PRAGMA busy_timeout = 0')
      try { db.exec('BEGIN EXCLUSIVE'); process.stdout.write('acquired') } catch { process.stdout.write('busy') }
    `
    const out = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
      let s = ''
      c.stdout!.on('data', (d: Buffer) => (s += String(d)))
      c.on('exit', () => resolve(s))
    })
    expect(out).toBe('busy')
    mine.release()
  })
})

describe('lock file checks', () => {
  it('a probe never creates the file', () => {
    const p = join(dir, 'missing.lock')
    expect(probeOsLock(p)).toBe('missing')
    expect(existsSync(p)).toBe(false)
  })

  it('a journal left by a killed exclusive holder does not block the next holder', async () => {
    const p = join(dir, 'left.lock')
    ensureLockFile(p)
    const child = await holder(p, 'exclusive')
    expect(existsSync(p + '-journal')).toBe(true)
    await killed(child)
    expect(lockFileProblem(p)).toBeNull()
    expect(probeOsLock(p)).toBe('free')
    ;(await acquireOsLock(p, 'exclusive', { waitMs: 0 })).release()
    expect(statSync(p).size).toBe(0)
    expect(existsSync(p + '-journal')).toBe(false)
  })

  it('a non-empty file, a link and a file with a WAL file beside it fail closed', async () => {
    const full = join(dir, 'full.lock')
    writeFileSync(full, 'x')
    expect(lockFileProblem(full)).toMatch(/not empty/)
    await expect(acquireOsLock(full, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockFileUnsafeError)
    expect(() => probeOsLock(full)).toThrow(LockFileUnsafeError)

    const target = join(dir, 'target.lock')
    ensureLockFile(target)
    const link = join(dir, 'link.lock')
    try {
      symlinkSync(target, link)
    } catch (e) {
      // Windows without Developer Mode or elevation refuses file symlinks (EPERM). A junction needs no privilege and
      // lstat reports it as a link too, which is the property under test (the link check comes first).
      if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e
      const linkTarget = join(dir, 'linked-dir')
      mkdirSync(linkTarget)
      symlinkSync(linkTarget, link, 'junction')
    }
    expect(lockFileProblem(link)).toMatch(/link/)
    await expect(acquireOsLock(link, 'shared', { waitMs: 0 })).rejects.toBeInstanceOf(LockFileUnsafeError)

    const j = join(dir, 'j.lock')
    ensureLockFile(j)
    writeFileSync(j + '-wal', '')
    expect(lockFileProblem(j)).toMatch(/-wal/)
    await expect(acquireOsLock(j, 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockFileUnsafeError)
    expect(_osLockStateCount()).toBe(0)
  })
})
