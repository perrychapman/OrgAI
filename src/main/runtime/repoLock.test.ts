import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentHostInstanceId } from '../host/identity'
import { processStartTime } from '../host/processInfo'
import {
  commonGitDir,
  configureRepoLock,
  lockDirOf,
  pathKey,
  repoLockActivity,
  RepoLockTimeoutError,
  withRepoLock,
  type RepoLockRecoveryNotice
} from './repoLock'

const tmps: string[] = []
function tmp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  tmps.push(d)
  return d
}

function git(cwd: string, args: string): string {
  return execSync(`git -c user.name=OrgAI-Test -c user.email=test@orgai.local ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function newRepo(): string {
  const r = tmp('orgai-lock-')
  git(r, 'init -q -b main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add -A')
  git(r, 'commit -q -m init')
  return r
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached')
    await sleep(5)
  }
}

let repo: string
let common: string
let notices: RepoLockRecoveryNotice[]
const children: ChildProcess[] = []

beforeEach(async () => {
  repo = newRepo()
  common = (await commonGitDir(repo))!
  notices = []
  configureRepoLock({ reset: true, onRecovery: (n) => notices.push(n) })
})

afterEach(() => {
  configureRepoLock({ reset: true })
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const staleDirs = (): string[] => readdirSync(common).filter((n) => n.startsWith('orgai-repo.lock.stale-'))

describe('commonGitDir', () => {
  it('resolves the main checkout and a linked worktree to one real common dir', async () => {
    expect(common).toBe(realpathSync.native(join(repo, '.git')))
    git(repo, 'worktree add -q -b wt1 ../wt1-' + repo.split('/').pop())
    const wt = join(repo, '..', 'wt1-' + repo.split('/').pop())
    tmps.push(wt)
    expect(pathKey((await commonGitDir(wt))!)).toBe(pathKey(common))
    expect(pathKey((await commonGitDir(join(repo, 'sub', 'missing')))!)).toBe(pathKey(common))
  })

  it('is null outside a git repository', async () => {
    expect(await commonGitDir(tmp('orgai-plain-'))).toBeNull()
    expect(await commonGitDir(join(tmpdir(), 'orgai-does-not-exist-xyz'))).toBeNull()
  })
})

describe('withRepoLock (repoLock.ts)', () => {
  it('holds <commonDir>/orgai-repo.lock with an owner file while running and removes it after', async () => {
    await withRepoLock(repo, async () => {
      const owner = JSON.parse(readFileSync(join(lockDirOf(common), 'owner.json'), 'utf8'))
      expect(owner.pid).toBe(process.pid)
      expect(owner.hostInstanceId).toBe(currentHostInstanceId())
      expect(typeof owner.acquiredAt).toBe('number')
    })
    expect(existsSync(lockDirOf(common))).toBe(false)
    expect(staleDirs()).toEqual([])
  })

  it('(d) detached work started inside a scope queues again once the scope has ended', async () => {
    const order: string[] = []
    const gate = deferred()
    const hold = deferred()
    let detached!: Promise<void>
    await withRepoLock(repo, async () => {
      detached = (async () => {
        await gate.promise
        await withRepoLock(repo, async () => {
          order.push('detached')
        })
      })()
    })
    const holder = withRepoLock(repo, async () => {
      order.push('c:start')
      await hold.promise
      order.push('c:end')
    })
    await until(() => order.includes('c:start'))
    gate.resolve()
    await sleep(100)
    // The released lease must not let the detached call slip in beside C.
    expect(order).toEqual(['c:start'])
    hold.resolve()
    await Promise.all([holder, detached])
    expect(order).toEqual(['c:start', 'c:end', 'detached'])
  })

  it('(e) blocks on a live foreign owner, times out, then reclaims it once the owner died', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(child)
    await until(() => child.pid !== undefined)
    const pid = child.pid!
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid, processStartTime: processStartTime(pid), hostInstanceId: 'abcdefabcdef', acquiredAt: Date.now() })
    )
    configureRepoLock({ timeoutMs: 300, pollMs: 20 })
    let ran = false
    const err = await withRepoLock(repo, async () => {
      ran = true
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepoLockTimeoutError)
    expect((err as RepoLockTimeoutError).commonDir).toBe(common)
    expect((err as RepoLockTimeoutError).owner?.pid).toBe(pid)
    expect(ran).toBe(false)
    expect(repoLockActivity()).toBe(0)
    expect(existsSync(lockDir)).toBe(true)

    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await exited
    await withRepoLock(repo, async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ reason: 'dead-owner', commonDir: common, previousOwner: { pid } })
    expect(staleDirs()).toEqual([])
    expect(existsSync(lockDir)).toBe(false)
  })

  it('(f) reports index.lock and MERGE_HEAD leftovers after a reclaim and never deletes them', async () => {
    git(repo, 'worktree add -q -b wtf ' + join(repo, '.claude', 'worktrees', 'agent-f'))
    const indexLock = join(common, 'index.lock')
    const wtIndexLock = join(common, 'worktrees', 'agent-f', 'index.lock')
    const mergeHead = join(common, 'MERGE_HEAD')
    writeFileSync(indexLock, '')
    writeFileSync(wtIndexLock, '')
    writeFileSync(mergeHead, '0000000000000000000000000000000000000000\n')
    // A lock dir with no owner file, older than the grace period (a crash between mkdir and the owner write).
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockDir, past, past)
    await withRepoLock(repo, async () => {})
    expect(notices).toHaveLength(1)
    expect(notices[0].reason).toBe('missing-owner')
    const found = notices[0].leftovers.map((p) => pathKey(p))
    for (const f of [indexLock, wtIndexLock, mergeHead]) {
      expect(found).toContain(pathKey(f))
      expect(existsSync(f)).toBe(true)
    }
    expect(staleDirs()).toEqual([])
  })

  it('waits on a fresh lock dir with no owner file yet instead of reclaiming it', async () => {
    mkdirSync(lockDirOf(common))
    configureRepoLock({ timeoutMs: 200, pollMs: 20, missingOwnerGraceMs: 10_000 })
    await expect(withRepoLock(repo, async () => {})).rejects.toBeInstanceOf(RepoLockTimeoutError)
    expect(notices).toEqual([])
  })

  it('puts a lock back when it changed hands between the dead-owner check and the rename', async () => {
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 999_999, hostInstanceId: 'dddddddddddd', acquiredAt: Date.now(), token: 'dead' }))
    let calls = 0
    configureRepoLock({
      timeoutMs: 200,
      pollMs: 20,
      isLiveProcess: (pid) => {
        calls++
        if (pid !== 999_999) return true
        // Another contender reclaims the dead lock and takes a fresh one while we are still checking.
        rmSync(lockDir, { recursive: true, force: true })
        mkdirSync(lockDir)
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: 'eeeeeeeeeeee', acquiredAt: Date.now(), token: 'fresh' }))
        return false
      }
    })
    await expect(withRepoLock(repo, async () => {})).rejects.toBeInstanceOf(RepoLockTimeoutError)
    expect(calls).toBeGreaterThan(1)
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token).toBe('fresh')
    expect(notices).toEqual([])
    expect(staleDirs()).toEqual([])
  })

  it('reclaims a leftover lock owned by this very process when no lease holds it', async () => {
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, hostInstanceId: currentHostInstanceId(), acquiredAt: Date.now() - 5 }))
    configureRepoLock({ timeoutMs: 500 })
    await withRepoLock(repo, async () => {})
    expect(notices.map((n) => n.reason)).toEqual(['leftover'])
  })

  it('treats the same pid with another host instance id as a live foreign owner', async () => {
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, hostInstanceId: '000000000000', acquiredAt: Date.now() }))
    configureRepoLock({ timeoutMs: 150, pollMs: 20 })
    await expect(withRepoLock(repo, async () => {})).rejects.toBeInstanceOf(RepoLockTimeoutError)
  })

  it('(g) refreshes owner.json mtime while held', async () => {
    configureRepoLock({ heartbeatMs: 20 })
    await withRepoLock(repo, async () => {
      const owner = join(lockDirOf(common), 'owner.json')
      const past = new Date(Date.now() - 60_000)
      utimesSync(owner, past, past)
      await sleep(150)
      expect(statSync(owner).mtimeMs).toBeGreaterThan(past.getTime() + 30_000)
    })
  })

  it('(i) repoLockActivity counts waiters plus the holder and returns to 0', async () => {
    expect(repoLockActivity()).toBe(0)
    const gate = deferred()
    let inside = false
    const a = withRepoLock(repo, async () => {
      inside = true
      await gate.promise
    })
    const b = withRepoLock(repo, async () => {})
    const c = withRepoLock(repo, async () => {})
    await until(() => inside && repoLockActivity() === 3)
    // A reentrant call is not counted again.
    expect(repoLockActivity()).toBe(3)
    gate.resolve()
    await Promise.all([a, b, c])
    expect(repoLockActivity()).toBe(0)
  })

  it('(j) a non-git path uses the in-process lock only', async () => {
    const plain = tmp('orgai-plain-')
    const order: string[] = []
    const gate = deferred()
    const a = withRepoLock(plain, async () => {
      order.push('a:start')
      expect(readdirSync(plain)).toEqual([])
      await gate.promise
      order.push('a:end')
    })
    const b = withRepoLock(plain, async () => {
      order.push('b')
    })
    await until(() => order.length > 0)
    await sleep(50)
    expect(order).toEqual(['a:start'])
    gate.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
    expect(readdirSync(plain)).toEqual([])
  })

  it('two unrelated repositories run concurrently', async () => {
    const other = newRepo()
    const gate = deferred()
    const order: string[] = []
    const a = withRepoLock(repo, async () => {
      order.push('a:start')
      await gate.promise
      order.push('a:end')
    })
    await until(() => order.length > 0)
    await withRepoLock(other, async () => {
      order.push('other')
    })
    gate.resolve()
    await a
    expect(order).toEqual(['a:start', 'other', 'a:end'])
  })

  it('a timed-out waiter releases its queue slot for the next caller', async () => {
    const lockDir = lockDirOf(common)
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, hostInstanceId: '111111111111', acquiredAt: Date.now() }))
    configureRepoLock({ timeoutMs: 100, pollMs: 10 })
    await expect(withRepoLock(repo, async () => {})).rejects.toBeInstanceOf(RepoLockTimeoutError)
    rmSync(lockDir, { recursive: true, force: true })
    expect(await withRepoLock(repo, async () => 7)).toBe(7)
  })
})
