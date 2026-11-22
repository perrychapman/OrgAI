import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPILE_CACHE_KEEP_MS, _resetCompileCacheForTest, compileCacheDir, enableCliCompileCache, versionFolder } from './compileCache'

let dataDir: string
beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'orgai-cc-')), 'data')
  _resetCompileCacheForTest()
})
afterEach(() => rmSync(join(dataDir, '..'), { recursive: true, force: true }))

describe('enableCliCompileCache', () => {
  it("enables the cache in this version's folder under <dataDir>/run/compile-cache, private to the user, once per process", () => {
    const calls: string[] = []
    const dir = enableCliCompileCache(dataDir, { env: {}, version: '1.2.3', enable: (d) => calls.push(d) })
    expect(dir).toBe(join(compileCacheDir(dataDir), 'v-1.2.3'))
    expect(compileCacheDir(dataDir)).toBe(join(dataDir, 'run', 'compile-cache'))
    expect(calls).toEqual([dir])
    if (process.platform !== 'win32') {
      for (const d of [dir as string, compileCacheDir(dataDir), join(dataDir, 'run')]) expect(statSync(d).mode & 0o777).toBe(0o700)
    }
    // A second call in the same process does nothing.
    expect(enableCliCompileCache(dataDir, { env: {}, version: '1.2.3', enable: (d) => calls.push(d) })).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('two versions used in turn keep their own folder; one that nobody used for two weeks is removed', () => {
    const root = compileCacheDir(dataDir)
    const entry = (version: string): string => join(root, versionFolder(version), 'entry')
    const use = (version: string, at: number): void => {
      _resetCompileCacheForTest()
      const dir = enableCliCompileCache(dataDir, { env: {}, version, enable: () => undefined, now: () => at }) as string
      writeFileSync(join(dir, 'entry'), 'compiled')
    }
    const day = 24 * 60 * 60 * 1000
    const t0 = Date.now()
    use('1.0.0', t0)
    use('1.1.0-dev', t0 + day)
    use('1.0.0', t0 + 2 * day)
    // Neither wiped the other.
    expect([existsSync(entry('1.0.0')), existsSync(entry('1.1.0-dev'))]).toEqual([true, true])
    // 1.1.0-dev was last used a day in; 1.0.0 keeps being used, and past the limit the unused one goes.
    use('1.0.0', t0 + day + COMPILE_CACHE_KEEP_MS + 1000)
    expect([existsSync(entry('1.0.0')), existsSync(entry('1.1.0-dev'))]).toEqual([true, false])
  })

  it('a version becomes a safe folder name', () => {
    expect(versionFolder('0.1.9-dev1')).toBe('v-0.1.9-dev1')
    expect(versionFolder('../../etc/passwd')).toBe('v-.._.._etc_passwd')
    expect(versionFolder('')).toBe('v-unknown')
    // Whatever the text, the folder stays inside the cache root.
    const calls: string[] = []
    enableCliCompileCache(dataDir, { env: {}, version: '../../outside', enable: (d) => calls.push(d) })
    expect(calls[0]?.startsWith(compileCacheDir(dataDir))).toBe(true)
    expect(existsSync(join(dataDir, 'outside'))).toBe(false)
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
    // A folder that cannot be made (a file where the run folder would be) is no reason to fail either.
    _resetCompileCacheForTest()
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'run'), 'not a folder')
    expect(enableCliCompileCache(dataDir, { env: {}, enable: (d) => calls.push(d) })).toBeUndefined()
  })
})
