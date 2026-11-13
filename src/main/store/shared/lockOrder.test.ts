import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CoordinatorRetry,
  LockOrderError,
  ORDER,
  assertHeld,
  cacheLockPath,
  coordinate,
  dataLockPath,
  heldLocks,
  upgradeHold,
  withLocks,
  type LockSpec
} from './lockOrder'
import { LockBusyError, _osLockStateCount, acquireOsLock, ensureLockFile, probeOsLock } from './osLock'

let control: string
const children: ChildProcess[] = []

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'lockorder-'))
  mkdirSync(join(control, 'locks'))
})
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  rmSync(control, { recursive: true, force: true })
})

const tx = (key: string, order: number, mode: 'exclusive' | 'shared' = 'exclusive'): LockSpec => ({
  key,
  path: dataLockPath(control, key),
  mode,
  kind: 'transaction',
  order,
  waitMs: 200
})
const claim = (key: string): LockSpec => ({ key, path: dataLockPath(control, key), mode: 'exclusive', kind: 'claim' })
const hold = (key: string): LockSpec => ({ key, path: dataLockPath(control, key), mode: 'shared', kind: 'hold' })

describe('withLocks', () => {
  it('acquires in order, exposes the held set, releases in reverse even on error', async () => {
    let seen: string[] = []
    await expect(
      withLocks([tx('config', ORDER.config), tx('team-p1', ORDER.team), claim('chain-run_a')], async () => {
        seen = heldLocks().map((h) => h.spec.key)
        assertHeld('config')
        assertHeld('team-p1', 'exclusive')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(seen).toEqual(['chain-run_a', 'team-p1', 'config'])
    expect(heldLocks()).toEqual([])
    expect(_osLockStateCount()).toBe(0)
  })

  it('reuses a held lock; held exclusive satisfies shared; held shared refuses exclusive', async () => {
    await withLocks([tx('team-p1', ORDER.team)], async () => {
      await withLocks([tx('team-p1', ORDER.team), tx('team-p1', ORDER.team)], async () => assertHeld('team-p1'))
      await withLocks([{ ...tx('team-p1', ORDER.team), mode: 'shared' }], async () => assertHeld('team-p1'))
    })
    await withLocks([hold('project-p1')], async () => {
      await expect(withLocks([{ ...hold('project-p1'), mode: 'exclusive', kind: 'claim' }], async () => 1)).rejects.toBeInstanceOf(
        LockOrderError
      )
    })
  })

  it('refuses a transaction lock below or equal to one already held; claims and holds are exempt', async () => {
    await withLocks([tx('config', ORDER.config)], async () => {
      await expect(withLocks([tx('team-p1', ORDER.team)], async () => 1)).rejects.toBeInstanceOf(LockOrderError)
      await withLocks([claim('chain-run_b'), hold('project-p2')], async () => assertHeld('chain-run_b'))
    })
    // Two locks of one order in one set (sorted keys) are fine; a second one later is not.
    await withLocks([tx('team-p2', ORDER.team), tx('team-p1', ORDER.team)], async () => {
      expect(heldLocks().map((h) => h.spec.key)).toEqual(['team-p1', 'team-p2'])
      await expect(withLocks([tx('team-p3', ORDER.team)], async () => 1)).rejects.toBeInstanceOf(LockOrderError)
    })
  })

  it('assertHeld names a missing lock', () => {
    expect(() => assertHeld('vault')).toThrow(/vault.*not held/)
  })

  it('async children inherit the held set', async () => {
    await withLocks([tx('outputs-p1', ORDER.outputs)], async () => {
      await Promise.resolve().then(() => assertHeld('outputs-p1'))
      await new Promise<void>((r) => setTimeout(() => (assertHeld('outputs-p1'), r()), 5))
    })
  })

  it('a claim on a lock another holder has fails at once', async () => {
    const p = dataLockPath(control, 'chain-run_x')
    const other = await acquireOsLock(p, 'exclusive', { waitMs: 0 })
    await expect(withLocks([claim('chain-run_x')], async () => 1)).rejects.toBeInstanceOf(LockBusyError)
    other.release()
  })
})

describe('coordinate', () => {
  it('retries when the lock set changes between the read and the acquisition', async () => {
    let n = 0
    const sets = [[tx('team-p1', ORDER.team)], [tx('team-p1', ORDER.team), tx('team-p2', ORDER.team)]]
    const r = await coordinate(
      () => sets[Math.min(n++, 1)],
      async () => heldLocks().map((h) => h.spec.key)
    )
    expect(r).toEqual(['team-p1', 'team-p2'])
  })

  it('a CoordinatorRetry releases everything, runs its before step with no lock held, and starts over', async () => {
    let attempts = 0
    let heldDuringBefore: number | null = null
    const r = await coordinate(
      () => [tx('vault', ORDER.vault)],
      async () => {
        attempts++
        if (attempts === 1) throw new CoordinatorRetry('vault changed', async () => void (heldDuringBefore = heldLocks().length))
        return 'ok'
      }
    )
    expect(r).toBe('ok')
    expect(attempts).toBe(2)
    expect(heldDuringBefore).toBe(0)
    expect(probeOsLock(dataLockPath(control, 'vault'))).toBe('free')
  })

  it('gives up after the retry budget', async () => {
    await expect(
      coordinate(
        () => [tx('vault', ORDER.vault)],
        async () => {
          throw new CoordinatorRetry('always')
        },
        { maxRetries: 2 }
      )
    ).rejects.toThrow(/could not settle/)
  })
})

/** A child process that holds a shared lock on `path` and prints "held". */
function sharedHolder(path: string): Promise<ChildProcess> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA busy_timeout = 0'); db.exec('BEGIN'); db.prepare('SELECT count(*) FROM sqlite_schema').get()
    process.stdout.write('held\\n'); setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)))
}

describe('upgradeHold', () => {
  it('upgrades inside the transaction lock when no other process holds the resource, and goes back to shared', async () => {
    await withLocks([hold('project-p1')], async () => {
      await withLocks([tx('team-p1', ORDER.team)], async () => {
        const v = await upgradeHold('project-p1', 'team-p1', async () => {
          assertHeld('project-p1', 'exclusive')
          expect(probeOsLock(dataLockPath(control, 'project-p1'))).toBe('held')
          return { value: 7, keepHold: true }
        })
        expect(v).toBe(7)
      })
      // Shared again: another shared holder is admitted, an exclusive claim is not.
      expect(probeOsLock(dataLockPath(control, 'project-p1'))).toBe('free')
      await expect(acquireOsLock(dataLockPath(control, 'project-p1'), 'exclusive', { waitMs: 0 })).rejects.toBeInstanceOf(LockBusyError)
    })
    expect(_osLockStateCount()).toBe(0)
  })

  it('reports busy and keeps the shared hold when another process holds the resource shared', async () => {
    const p = dataLockPath(control, 'project-p2')
    ensureLockFile(p)
    await sharedHolder(p)
    await withLocks([hold('project-p2')], async () => {
      await withLocks([tx('team-p2', ORDER.team)], async () => {
        await expect(upgradeHold('project-p2', 'team-p2', async () => ({ value: 1, keepHold: true }))).rejects.toBeInstanceOf(LockBusyError)
      })
      assertHeld('project-p2', 'shared')
    })
  })

  it('must run inside its transaction lock', async () => {
    await withLocks([hold('project-p3')], async () => {
      await expect(upgradeHold('project-p3', 'team-p3', async () => ({ value: 1, keepHold: true }))).rejects.toBeInstanceOf(LockOrderError)
    })
  })
})

describe('lock paths', () => {
  it('validates keys and hashes cache keys', () => {
    expect(dataLockPath('/c', 'chain-run_abc')).toBe(join('/c', 'locks', 'chain-run_abc.lock'))
    expect(() => dataLockPath('/c', '../x')).toThrow(LockOrderError)
    expect(() => dataLockPath('/c', 'a/b')).toThrow(LockOrderError)
    expect(cacheLockPath('/k', 'repo', '/Users/me/repo')).toMatch(/\/k\/repo-[0-9a-f]{32}\.lock$/)
  })
})
