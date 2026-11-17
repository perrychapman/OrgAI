import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { APP_USER_MODEL_ID, appDetailsFor, regAddArgs, regExePath, registerWindowsAppIdentity, quoteArg, resolveIconPath, shouldRegisterIdentity, skipIdentityRegistration, stableIconPath } from './appIdentity'

const REG = 'C:\\Windows\\System32\\reg.exe'
const KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`

describe('registerWindowsAppIdentity', () => {
  it('writes DisplayName and IconUri with exact argv and no shell', async () => {
    const calls: [string, string[], unknown][] = []
    await registerWindowsAppIdentity({
      platform: 'win32',
      iconPath: 'C:\\app\\build\\icon.ico',
      regExe: REG,
      env: { SystemRoot: 'D:\\Win' },
      run: async (f, a, o) => void calls.push([f, a, o])
    })
    expect(calls).toEqual([
      [REG, ['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'OrgAI', '/f'], { windowsHide: true, timeout: 5000, env: { SystemRoot: 'D:\\Win' } }],
      [REG, ['add', KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', 'C:\\app\\build\\icon.ico', '/f'], { windowsHide: true, timeout: 5000, env: { SystemRoot: 'D:\\Win' } }]
    ])
  })

  it('is a no-op off win32', async () => {
    let n = 0
    await registerWindowsAppIdentity({ platform: 'darwin', iconPath: '/x.png', run: async () => void n++ })
    expect(n).toBe(0)
  })

  it('skips IconUri when the icon file is missing', async () => {
    const calls: string[][] = []
    await registerWindowsAppIdentity({ platform: 'win32', iconPath: undefined, regExe: REG, run: async (_f, a) => void calls.push(a) })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('DisplayName')
  })

  it('fails open with one warning', async () => {
    const warns: string[] = []
    await expect(
      registerWindowsAppIdentity({
        platform: 'win32',
        iconPath: 'C:\\i.ico',
        run: async () => {
          throw new Error('denied')
        },
        warn: (m) => warns.push(m)
      })
    ).resolves.toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('denied')
  })
})

describe('helpers', () => {
  it('regAddArgs keeps a value with spaces as one argument', () => {
    expect(regAddArgs('IconUri', 'C:\\a b\\icon.ico')[7]).toBe('C:\\a b\\icon.ico')
  })
  it('regExePath is absolute under SystemRoot', () => {
    expect(regExePath({ SystemRoot: 'D:\\Win' })).toBe(join('D:\\Win', 'System32', 'reg.exe'))
  })
  it('resolveIconPath: unpackaged, packaged and missing', () => {
    const base = { appPath: join('/app'), resourcesPath: join('/res'), exists: () => true }
    expect(resolveIconPath({ ...base, platform: 'win32', isPackaged: false })).toBe(join('/app', 'build', 'icon.ico'))
    expect(resolveIconPath({ ...base, platform: 'linux', isPackaged: false })).toBe(join('/app', 'build', 'icon.png'))
    expect(resolveIconPath({ ...base, platform: 'win32', isPackaged: true })).toBe(join('/res', 'icon.ico'))
    expect(resolveIconPath({ ...base, platform: 'win32', isPackaged: true, exists: () => false })).toBeUndefined()
  })
  it('skips registration for data-dir overrides and the mock adapter', () => {
    expect(skipIdentityRegistration({})).toBe(false)
    expect(skipIdentityRegistration({ ORGAI_DATA_DIR: '/tmp/x' })).toBe(true)
    expect(skipIdentityRegistration({ ORGAI_MOCK: '1' })).toBe(true)
  })
  it('appDetailsFor quotes the relaunch command (unpackaged)', () => {
    const d = appDetailsFor({ isPackaged: false, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\p q', iconPath: 'C:\\i.ico' })
    expect(d.relaunchCommand).toBe('"C:\\e\\electron.exe" "C:\\p q"')
    expect(d.relaunchDisplayName).toBe('OrgAI')
    expect(d.appId).toBe(APP_USER_MODEL_ID)
    expect(d.appIconPath).toBe('C:\\i.ico')
  })
  it('installed packaged build passes only the appId', () => {
    expect(appDetailsFor({ isPackaged: true, execPath: 'C:\\o.exe', appPath: 'x', iconPath: 'C:\\i.ico' })).toEqual({ appId: APP_USER_MODEL_ID })
  })
  it('portable build relaunches through the portable file with the full details', () => {
    const d = appDetailsFor({ isPackaged: true, execPath: 'C:\\tmp\\o.exe', appPath: 'x', iconPath: 'C:\\ud\\app-icon.ico', portableFile: 'C:\\Apps\\OrgAI.exe' })
    expect(d).toMatchObject({ appId: APP_USER_MODEL_ID, relaunchCommand: '"C:\\Apps\\OrgAI.exe"', appIconPath: 'C:\\ud\\app-icon.ico', relaunchDisplayName: 'OrgAI' })
  })
  it('quoteArg strips quotes and trailing backslashes', () => {
    expect(quoteArg('C:\\a b\\')).toBe('"C:\\a b"')
    expect(quoteArg('C:\\a\\\\')).toBe('"C:\\a"')
    expect(quoteArg('a"b')).toBe('"ab"')
  })
  it('shouldRegisterIdentity: unpackaged and portable only, never under skip', () => {
    expect(shouldRegisterIdentity({ isPackaged: false }, {})).toBe(true)
    expect(shouldRegisterIdentity({ isPackaged: true }, {})).toBe(false)
    expect(shouldRegisterIdentity({ isPackaged: true }, { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' })).toBe(true)
    expect(shouldRegisterIdentity({ isPackaged: false }, { ORGAI_MOCK: '1' })).toBe(false)
    expect(shouldRegisterIdentity({ isPackaged: true }, { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe', ORGAI_DATA_DIR: 'D:\\d' })).toBe(false)
  })
  it('regExePath accepts only drive-absolute roots', () => {
    expect(regExePath({ SystemRoot: 'relative\\win' })).toBe(join('C:\\Windows', 'System32', 'reg.exe'))
    expect(regExePath({ SystemRoot: '\\\\evil\\share', windir: 'D:\\Win' })).toBe(join('D:\\Win', 'System32', 'reg.exe'))
    expect(regExePath({})).toBe(join('C:\\Windows', 'System32', 'reg.exe'))
  })
  it('reg.exe gets a minimal env, not process.env', async () => {
    const opts: unknown[] = []
    await registerWindowsAppIdentity({
      platform: 'win32',
      iconPath: undefined,
      env: { SystemRoot: 'D:\\Win', ANTHROPIC_API_KEY: 'secret' },
      run: async (_f, _a, o) => void opts.push(o)
    })
    expect(opts[0]).toEqual({ windowsHide: true, timeout: 5000, env: { SystemRoot: 'D:\\Win' } })
  })
})

describe('stableIconPath', () => {
  const mk = (sizes: Record<string, number>) => {
    const copies: [string, string][] = []
    return {
      copies,
      fs: { size: (p: string) => sizes[p], mkdir: () => {}, copy: (a: string, b: string) => void copies.push([a, b]) }
    }
  }
  const dest = join('C:\\ud', 'app-icon.ico')
  it('copies when missing', () => {
    const { fs, copies } = mk({ src: 10 })
    expect(stableIconPath({ iconPath: 'src', userDataDir: 'C:\\ud', fs })).toBe(dest)
    expect(copies).toEqual([['src', dest]])
  })
  it('copies when the size differs, not when equal', () => {
    const a = mk({ src: 10, [dest]: 9 })
    stableIconPath({ iconPath: 'src', userDataDir: 'C:\\ud', fs: a.fs })
    expect(a.copies).toHaveLength(1)
    const b = mk({ src: 10, [dest]: 10 })
    expect(stableIconPath({ iconPath: 'src', userDataDir: 'C:\\ud', fs: b.fs })).toBe(dest)
    expect(b.copies).toHaveLength(0)
  })
  it('fails open with one warning', () => {
    const warns: string[] = []
    const fs = { size: (p: string) => (p === 'src' ? 1 : undefined), mkdir: () => {}, copy: () => { throw new Error('disk full') } }
    expect(stableIconPath({ iconPath: 'src', userDataDir: 'C:\\ud', fs, warn: (m) => warns.push(m) })).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('disk full')
  })
  it('returns undefined without a source icon', () => {
    expect(stableIconPath({ iconPath: undefined, userDataDir: 'C:\\ud' })).toBeUndefined()
  })
})
