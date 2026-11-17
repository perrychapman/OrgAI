import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { APP_USER_MODEL_ID, appDetailsFor, regAddArgs, regExePath, registerWindowsAppIdentity, resolveIconPath, skipIdentityRegistration } from './appIdentity'

const REG = 'C:\\Windows\\System32\\reg.exe'
const KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`

describe('registerWindowsAppIdentity', () => {
  it('writes DisplayName and IconUri with exact argv and no shell', async () => {
    const calls: [string, string[], unknown][] = []
    await registerWindowsAppIdentity({
      platform: 'win32',
      iconPath: 'C:\\app\\build\\icon.ico',
      regExe: REG,
      run: async (f, a, o) => void calls.push([f, a, o])
    })
    expect(calls).toEqual([
      [REG, ['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'OrgAI', '/f'], { windowsHide: true, timeout: 5000 }],
      [REG, ['add', KEY, '/v', 'IconUri', '/t', 'REG_SZ', '/d', 'C:\\app\\build\\icon.ico', '/f'], { windowsHide: true, timeout: 5000 }]
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
  it('appDetailsFor quotes the relaunch command', () => {
    const d = appDetailsFor({ isPackaged: false, execPath: 'C:\\e\\electron.exe', appPath: 'C:\\p q', iconPath: 'C:\\i.ico' })
    expect(d.relaunchCommand).toBe('"C:\\e\\electron.exe" "C:\\p q"')
    expect(d.relaunchDisplayName).toBe('OrgAI')
    expect(d.appId).toBe(APP_USER_MODEL_ID)
    expect(appDetailsFor({ isPackaged: true, execPath: 'C:\\o.exe', appPath: 'x', iconPath: undefined }).relaunchCommand).toBe('"C:\\o.exe"')
  })
})
