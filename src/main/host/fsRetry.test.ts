import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENAME_RETRY_DELAYS_MS, renameSyncRetry, sleepSync } from './fsRetry'

const errno = (code: string): Error => Object.assign(new Error(code), { code })

describe('renameSyncRetry (review M6)', () => {
  it('rides out transient EPERM / EBUSY / EACCES on win32', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0
      const slept: number[] = []
      renameSyncRetry('a', 'b', {
        platform: 'win32',
        rename: () => {
          if (++calls < 3) throw errno(code)
        },
        sleepSync: (ms) => void slept.push(ms)
      })
      expect(calls).toBe(3)
      expect(slept).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2))
    }
  })

  it('gives up after the last delay and throws the last error', () => {
    let calls = 0
    expect(() =>
      renameSyncRetry('a', 'b', {
        platform: 'win32',
        rename: () => {
          calls++
          throw errno('EBUSY')
        },
        sleepSync: () => {}
      })
    ).toThrow('EBUSY')
    expect(calls).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
  })

  it('never retries other errors, nor anything on POSIX', () => {
    let calls = 0
    const rename = (): void => {
      calls++
      throw errno('ENOENT')
    }
    expect(() => renameSyncRetry('a', 'b', { platform: 'win32', rename, sleepSync: () => {} })).toThrow('ENOENT')
    expect(calls).toBe(1)
    calls = 0
    expect(() =>
      renameSyncRetry('a', 'b', {
        platform: 'darwin',
        rename: () => {
          calls++
          throw errno('EPERM')
        },
        sleepSync: () => {}
      })
    ).toThrow('EPERM')
    expect(calls).toBe(1)
  })

  it('renames real files', () => {
    const d = mkdtempSync(join(tmpdir(), 'orgai-ren-'))
    try {
      writeFileSync(join(d, 'a'), 'x')
      renameSyncRetry(join(d, 'a'), join(d, 'b'))
      expect(readFileSync(join(d, 'b'), 'utf8')).toBe('x')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('sleepSync blocks for about the time asked', () => {
    const t = Date.now()
    sleepSync(30)
    expect(Date.now() - t).toBeGreaterThanOrEqual(25)
  })
})
