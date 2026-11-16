import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _setAtomicWriteRenameForTest, writeFileAtomic } from './atomicWrite'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomicwrite-'))
})
afterEach(() => {
  _setAtomicWriteRenameForTest(null)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const transient = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('writeFileAtomic rename', () => {
  it('retries a transient Windows sharing failure (EPERM, EBUSY, EACCES) and lands the file', () => {
    const file = join(dir, 'a.json')
    const codes = ['EPERM', 'EBUSY', 'EACCES']
    let calls = 0
    _setAtomicWriteRenameForTest({
      platform: 'win32',
      sleepSync: () => {},
      rename: (from, to) => {
        if (calls < codes.length) throw transient(codes[calls++])
        renameSync(from, to)
      }
    })
    writeFileAtomic(file, '{"n":1}')
    expect(calls).toBe(3)
    expect(readFileSync(file, 'utf8')).toBe('{"n":1}')
    expect(readdirSync(dir)).toEqual(['a.json'])
  })

  it('does not retry on POSIX and removes its temp file when the rename fails', () => {
    const file = join(dir, 'b.json')
    let calls = 0
    _setAtomicWriteRenameForTest({
      platform: 'linux',
      rename: () => {
        calls++
        throw transient('EACCES')
      }
    })
    expect(() => writeFileAtomic(file, 'x')).toThrow('EACCES')
    expect(calls).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })
})
