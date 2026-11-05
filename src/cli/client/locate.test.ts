import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { platformUserDataDir, resolveDataDirs, userChoseDataDir } from './locate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveDataDirs', () => {
  it('--data-dir beats ORGAI_DATA_DIR beats the platform default', () => {
    const env = { ORGAI_DATA_DIR: '/env/dir' }
    expect(resolveDataDirs({ flag: '/flag/dir', env, platform: 'linux', home: '/h' })).toEqual({ userDataDir: '/flag/dir', dataDir: '/flag/dir/data' })
    expect(resolveDataDirs({ env, platform: 'linux', home: '/h' })).toEqual({ userDataDir: '/env/dir', dataDir: '/env/dir/data' })
    expect(resolveDataDirs({ env: { ORGAI_DATA_DIR: '  ' }, platform: 'linux', home: '/h' }).userDataDir).toBe('/h/.config/OrgAI')
  })

  it('resolves relative values against cwd', () => {
    expect(resolveDataDirs({ flag: 'rel/d', env: {}, platform: 'linux', cwd: '/work' }).userDataDir).toBe('/work/rel/d')
    expect(resolveDataDirs({ env: { ORGAI_DATA_DIR: ' ../e ' }, platform: 'linux', cwd: '/work/a' }).userDataDir).toBe('/work/e')
  })

  it('platform defaults', () => {
    expect(platformUserDataDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/OrgAI')
    expect(platformUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/OrgAI')
    expect(platformUserDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe('/xdg/OrgAI')
    expect(platformUserDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\OrgAI')
    expect(platformUserDataDir('win32', {}, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\OrgAI')
  })

  it('realpaths an existing folder and never creates a missing one', () => {
    const base = mkdtempSync(join(tmpdir(), 'loc-'))
    dirs.push(base)
    mkdirSync(join(base, 'real'))
    symlinkSync(join(base, 'real'), join(base, 'link'))
    const r = resolveDataDirs({ flag: join(base, 'link'), env: {} })
    expect(r.userDataDir).toBe(realpathSync(join(base, 'real')))
    expect(r.dataDir).toBe(join(realpathSync(join(base, 'real')), 'data'))
    const missing = resolveDataDirs({ flag: join(base, 'nope'), env: {} })
    expect(missing.userDataDir.endsWith('nope')).toBe(true)
  })

  it('userChoseDataDir: flag or env only', () => {
    expect(userChoseDataDir({ flag: 'x', env: {} })).toBe(true)
    expect(userChoseDataDir({ env: { ORGAI_DATA_DIR: '/d' } })).toBe(true)
    expect(userChoseDataDir({ env: { ORGAI_DATA_DIR: ' ' } })).toBe(false)
    expect(userChoseDataDir({ env: {} })).toBe(false)
  })
})
