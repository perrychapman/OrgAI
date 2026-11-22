import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetCompileCacheForTest, compileCacheDir, enableCliCompileCache } from './compileCache'

let dataDir: string
beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'orgai-cc-')), 'data')
  _resetCompileCacheForTest()
})
afterEach(() => rmSync(join(dataDir, '..'), { recursive: true, force: true }))

describe('enableCliCompileCache', () => {
  it('enables the cache in <dataDir>/run/compile-cache, private to the user, once per process', () => {
    const calls: string[] = []
    const dir = enableCliCompileCache(dataDir, { env: {}, version: '1.2.3', enable: (d) => calls.push(d) })
    expect(dir).toBe(compileCacheDir(dataDir))
    expect(dir).toBe(join(dataDir, 'run', 'compile-cache'))
    expect(calls).toEqual([dir])
    expect(readFileSync(join(dir as string, 'version'), 'utf8')).toBe('1.2.3')
    if (process.platform !== 'win32') {
      expect(statSync(dir as string).mode & 0o777).toBe(0o700)
      // The run folder it sits in is made private too when this call creates it.
      expect(statSync(join(dataDir, 'run')).mode & 0o777).toBe(0o700)
    }
    // A second call in the same process does nothing.
    expect(enableCliCompileCache(dataDir, { env: {}, version: '1.2.3', enable: (d) => calls.push(d) })).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('keeps the entries of the same version and drops those of another one', () => {
    const dir = compileCacheDir(dataDir)
    mkdirSync(join(dir, 'v8-abc'), { recursive: true })
    writeFileSync(join(dir, 'v8-abc', 'entry'), 'compiled')
    writeFileSync(join(dir, 'version'), '1.0.0')
    enableCliCompileCache(dataDir, { env: {}, version: '1.0.0', enable: () => undefined })
    expect(existsSync(join(dir, 'v8-abc', 'entry'))).toBe(true)
    _resetCompileCacheForTest()
    enableCliCompileCache(dataDir, { env: {}, version: '1.1.0', enable: () => undefined })
    expect(existsSync(join(dir, 'v8-abc'))).toBe(false)
    expect(readFileSync(join(dir, 'version'), 'utf8')).toBe('1.1.0')
  })

  it("leaves the user's own choice alone and never throws", () => {
    const calls: string[] = []
    expect(enableCliCompileCache(dataDir, { env: { NODE_COMPILE_CACHE: '/somewhere' }, enable: (d) => calls.push(d) })).toBeUndefined()
    _resetCompileCacheForTest()
    expect(enableCliCompileCache(dataDir, { env: { NODE_DISABLE_COMPILE_CACHE: '1' }, enable: (d) => calls.push(d) })).toBeUndefined()
    expect(calls).toEqual([])
    expect(existsSync(compileCacheDir(dataDir))).toBe(false)
    _resetCompileCacheForTest()
    expect(
      enableCliCompileCache(dataDir, {
        env: {},
        enable: () => {
          throw new Error('unsupported')
        }
      })
    ).toBeUndefined()
  })
})
