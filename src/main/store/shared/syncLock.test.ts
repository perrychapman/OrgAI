import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { LockFileUnsafeError } from './osLock'
import { ReentrantSyncLock, SyncLockBusyError, probeSyncLock, trySyncLock } from './syncLock'
import { killAndWait, spawnViteNode } from './testing/viteNode'

let dir: string
let lockPath: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'synclock-'))
  lockPath = join(dir, 'a.lock')
})
afterEach(async () => {
  // A child still running holds the lock file open (EBUSY on Windows): wait for it before removing the folder.
  await killAndWait(children)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('trySyncLock', () => {
  it('creates an empty lock file, holds it, and frees it on release', () => {
    expect(probeSyncLock(lockPath)).toBe('missing')
    const h = trySyncLock(lockPath)
    expect(h).not.toBeNull()
    expect(statSync(lockPath).size).toBe(0)
    expect(probeSyncLock(lockPath)).toBe('held')
    h?.release()
    expect(probeSyncLock(lockPath)).toBe('free')
    // Nothing was ever written to the file, and no journal is left beside it.
    expect(statSync(lockPath).size).toBe(0)
    expect(existsSync(`${lockPath}-journal`)).toBe(false)
  })

  it('answers null while another holder in this process has it, and works again afterwards', () => {
    const first = trySyncLock(lockPath)
    expect(first).not.toBeNull()
    expect(trySyncLock(lockPath)).toBeNull()
    first?.release()
    first?.release() // idempotent
    const second = trySyncLock(lockPath)
    expect(second).not.toBeNull()
    second?.release()
  })

  it('fails closed on a lock file that is not an empty regular file', () => {
    writeFileSync(lockPath, 'not empty')
    expect(() => trySyncLock(lockPath)).toThrow(LockFileUnsafeError)
  })
})

describe('ReentrantSyncLock', () => {
  it('nests: only the outermost release gives the lock back', () => {
    const lock = new ReentrantSyncLock(lockPath)
    lock.acquire()
    lock.acquire()
    expect(lock.held).toBe(2)
    expect(trySyncLock(lockPath)).toBeNull()
    lock.release()
    expect(lock.held).toBe(1)
    expect(trySyncLock(lockPath)).toBeNull()
    lock.release()
    expect(lock.held).toBe(0)
    const other = trySyncLock(lockPath)
    expect(other).not.toBeNull()
    other?.release()
    lock.close()
  })

  it('run releases when fn throws, and returns its value otherwise', () => {
    const lock = new ReentrantSyncLock(lockPath)
    expect(lock.run(() => 7)).toBe(7)
    expect(() =>
      lock.run(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(lock.held).toBe(0)
    expect(probeSyncLock(lockPath)).toBe('free')
    lock.close()
  })

  it('waits with a growing jittered backoff and gives up with SyncLockBusyError after the budget', () => {
    const holder = trySyncLock(lockPath)
    let clock = 0
    const sleeps: number[] = []
    const lock = new ReentrantSyncLock(lockPath, {
      waitMs: 100,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms)
        clock += ms
      },
      random: () => 0.5 // exactly one step each time
    })
    expect(() => lock.acquire()).toThrow(SyncLockBusyError)
    expect(lock.held).toBe(0)
    // 1, 2, 4, 8, 16, then capped at 25 until the 100 ms budget is used up; the last sleep is cut to what is left.
    expect(sleeps.slice(0, 6)).toEqual([1, 2, 4, 8, 16, 25])
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(100)
    holder?.release()
    lock.acquire() // free now
    lock.release()
    lock.close()
  })

  it('takes the lock as soon as the holder lets go while it waits', () => {
    const holder = trySyncLock(lockPath)
    let tries = 0
    const lock = new ReentrantSyncLock(lockPath, {
      waitMs: 5000,
      sleep: () => {
        tries += 1
        if (tries === 3) holder?.release()
      }
    })
    lock.acquire()
    expect(tries).toBe(3)
    expect(lock.held).toBe(1)
    lock.release()
    lock.close()
  })

  // POSIX only: Windows does not let a file be deleted while a process has it open (SQLite opens it without delete
  // sharing), so a run folder cannot be removed under a live orgai there and the case cannot arise.
  it.skipIf(process.platform === 'win32')('reopens when the lock file was replaced on disk (a deleted run folder)', () => {
    const lock = new ReentrantSyncLock(lockPath)
    lock.run(() => undefined)
    unlinkSync(lockPath)
    // A second process would create a new file here: the old connection must not keep locking the unlinked inode.
    const other = trySyncLock(lockPath)
    expect(other).not.toBeNull()
    let clock = 0
    const waiter = new ReentrantSyncLock(lockPath, { waitMs: 10, now: () => clock, sleep: (ms) => void (clock += ms) })
    expect(() => waiter.acquire()).toThrow(SyncLockBusyError)
    other?.release()
    // `lock` still has its connection on the unlinked file: it must lock the new one instead.
    lock.acquire()
    expect(trySyncLock(lockPath)).toBeNull()
    lock.release()
    for (const l of [lock, waiter]) l.close()
  })
})

// Children run under the vite-node CLI with the module imported by absolute path (see sharedJsonFile.test.ts).
const modulePath = resolve(__dirname, 'syncLock.ts')

function childScript(body: string): string {
  const p = join(dir, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(
    p,
    `import { ReentrantSyncLock, trySyncLock } from ${JSON.stringify(modulePath)}
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const [lockPath, file, count] = process.argv.slice(2)
${body}
`
  )
  return p
}

function runChild(script: string, args: string[], onLine?: (line: string, child: ChildProcess) => void): Promise<number | null> {
  return new Promise((res, rej) => {
    const c = spawnViteNode(script, args, { stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() })
    children.push(c)
    let buf = ''
    c.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine?.(buf.slice(0, i), c)
        buf = buf.slice(i + 1)
      }
    })
    c.on('error', rej)
    c.on('exit', (code) => res(code))
  })
}

describe('a lock outlives its handle', () => {
  it('a handle nobody references any more still holds the lock after a garbage collection', async () => {
    // The holder drops every reference to its handle, forces a collection, and only then reports. Before the lock was
    // pinned, the connection's finalizer closed it and the lock was silently free.
    const script = childScript(`
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
;(() => { if (!trySyncLock(lockPath)) throw new Error('busy') })()
for (let i = 0; i < 5; i++) { gc(); new Array(1e5).fill(i) }
console.log('collected')
setInterval(() => {}, 1000)`)
    let state: string | undefined
    let killed: Promise<void> | undefined
    const exited = runChild(script, [lockPath, 'unused', '0'], (line, child) => {
      if (line !== 'collected' || killed) return
      state = probeSyncLock(lockPath)
      killed = new Promise<void>((r) => {
        child.once('exit', () => r())
        child.kill('SIGKILL')
      })
    })
    await exited
    await killed
    expect(state).toBe('held')
  }, 120_000)
})

describe('sync locks across processes', () => {
  it('two processes x 300 unlocked-looking read-modify-writes of one counter end at exactly 600', async () => {
    const file = join(dir, 'counter.txt')
    writeFileSync(file, '0')
    // The read and the write are separate calls with no atomicity of their own: only the lock makes the count exact.
    const script = childScript(`
const lock = new ReentrantSyncLock(lockPath, { waitMs: 240000 })
for (let i = 0; i < Number(count); i++) lock.run(() => writeFileSync(file, String(Number(readFileSync(file, 'utf8')) + 1)))
process.exit(0)`)
    const codes = await Promise.all([runChild(script, [lockPath, file, '300']), runChild(script, [lockPath, file, '300'])])
    expect(codes).toEqual([0, 0])
    expect(readFileSync(file, 'utf8')).toBe('600')
  }, 300_000)

  it('a holder that is killed loses the lock at once: the kernel releases it, no pid or age is consulted', async () => {
    const script = childScript(`
const h = trySyncLock(lockPath)
console.log(h ? 'held' : 'busy')
setInterval(() => {}, 1000)`)
    let killed: Promise<void> | undefined
    const exited = runChild(script, [lockPath, 'unused', '0'], (line, child) => {
      if (line !== 'held' || killed) return
      // The child holds it: this process cannot take it and sees it held.
      expect(trySyncLock(lockPath)).toBeNull()
      expect(probeSyncLock(lockPath)).toBe('held')
      killed = new Promise<void>((r) => {
        child.once('exit', () => r())
        child.kill('SIGKILL')
      })
    })
    await exited
    await killed
    expect(killed).toBeDefined()
    expect(probeSyncLock(lockPath)).toBe('free')
    const mine = trySyncLock(lockPath)
    expect(mine).not.toBeNull()
    mine?.release()
  }, 120_000)
})
