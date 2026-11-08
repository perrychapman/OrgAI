import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliUserDataDir, ignoresDesktopDataDir, platformUserDataDir, resolveDataDirs, userChoseDataDir } from './locate'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('resolveDataDirs', () => {
  it('--data-dir beats ORGAI_CLI_DATA_DIR beats the platform default; ORGAI_DATA_DIR is ignored', () => {
    const env = { ORGAI_CLI_DATA_DIR: '/env/dir', ORGAI_DATA_DIR: '/app/dir' }
    expect(resolveDataDirs({ flag: '/flag/dir', env, platform: 'linux', home: '/h' })).toEqual({ userDataDir: '/flag/dir', dataDir: '/flag/dir/data' })
    expect(resolveDataDirs({ env, platform: 'linux', home: '/h' })).toEqual({ userDataDir: '/env/dir', dataDir: '/env/dir/data' })
    expect(resolveDataDirs({ env: { ORGAI_CLI_DATA_DIR: '  ' }, platform: 'linux', home: '/h' }).userDataDir).toBe('/h/.config/orgai-cli')
    expect(resolveDataDirs({ env: { ORGAI_DATA_DIR: '/app/dir' }, platform: 'linux', home: '/h' }).userDataDir).toBe('/h/.config/orgai-cli')
  })

  it('resolves relative values against cwd', () => {
    expect(resolveDataDirs({ flag: 'rel/d', env: {}, platform: 'linux', cwd: '/work' }).userDataDir).toBe('/work/rel/d')
    expect(resolveDataDirs({ env: { ORGAI_CLI_DATA_DIR: ' ../e ' }, platform: 'linux', cwd: '/work/a' }).userDataDir).toBe('/work/e')
  })

  it('CLI platform defaults are orgai-cli, never the app OrgAI', () => {
    expect(cliUserDataDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/orgai-cli')
    expect(cliUserDataDir('linux', {}, '/home/u')).toBe('/home/u/.config/orgai-cli')
    expect(cliUserDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe('/xdg/orgai-cli')
    expect(cliUserDataDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\orgai-cli')
    expect(cliUserDataDir('win32', {}, 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Roaming\\orgai-cli')
  })

  it('the desktop defaults stay OrgAI (the folders the CLI refuses)', () => {
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
    symlinkSync(join(base, 'real'), join(base, 'link'), 'junction') // junction: no privilege needed on Windows, ignored on POSIX
    const r = resolveDataDirs({ flag: join(base, 'link'), env: {} })
    // locate.ts uses realpathSync.native, which expands 8.3 short names (RUNNER~1); the JS realpathSync keeps them.
    expect(r.userDataDir).toBe(realpathSync.native(join(base, 'real')))
    expect(r.dataDir).toBe(join(realpathSync.native(join(base, 'real')), 'data'))
    const missing = resolveDataDirs({ flag: join(base, 'nope'), env: {} })
    expect(missing.userDataDir.endsWith('nope')).toBe(true)
  })

  it('userChoseDataDir: flag or ORGAI_CLI_DATA_DIR only', () => {
    expect(userChoseDataDir({ flag: 'x', env: {} })).toBe(true)
    expect(userChoseDataDir({ env: { ORGAI_CLI_DATA_DIR: '/d' } })).toBe(true)
    expect(userChoseDataDir({ env: { ORGAI_DATA_DIR: '/d' } })).toBe(false)
    expect(userChoseDataDir({ env: { ORGAI_CLI_DATA_DIR: ' ' } })).toBe(false)
    expect(userChoseDataDir({ env: {} })).toBe(false)
  })

  it('ignoresDesktopDataDir: ORGAI_DATA_DIR set and no CLI override', () => {
    expect(ignoresDesktopDataDir({ env: { ORGAI_DATA_DIR: '/d' } })).toBe(true)
    expect(ignoresDesktopDataDir({ env: { ORGAI_DATA_DIR: '/d', ORGAI_CLI_DATA_DIR: '/c' } })).toBe(false)
    expect(ignoresDesktopDataDir({ flag: '/f', env: { ORGAI_DATA_DIR: '/d' } })).toBe(false)
    expect(ignoresDesktopDataDir({ env: {} })).toBe(false)
  })
})
