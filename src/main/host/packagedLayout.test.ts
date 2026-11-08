import { describe, expect, it } from 'vitest'
import { cliLauncherName, cliShimPath, isOrgaiShim, packagedLayout, parseCliShim } from './packagedLayout'

const NOTE = 'orgai-shim v1: written by OrgAI (App settings > General > Advanced settings > Terminal). OrgAI updates or removes this file.'
const sq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
/** An old app's POSIX shim, written out by hand. */
const posixShim = (launcher: string, userDataDir?: string): string =>
  `#!/bin/sh\n# ${NOTE}\n` +
  (userDataDir === undefined ? '' : `if [ -z "\${ORGAI_DATA_DIR:-}" ]; then ORGAI_DATA_DIR=${sq(userDataDir)}; export ORGAI_DATA_DIR; fi\n`) +
  `exec ${sq(launcher)} "$@"\n`
/** An old app's Windows shim, written out by hand. */
const winShim = (launcher: string, userDataDir?: string): string =>
  ['@echo off', `rem ${NOTE}`, 'setlocal', ...(userDataDir === undefined ? [] : [`if not defined ORGAI_DATA_DIR set "ORGAI_DATA_DIR=${userDataDir}"`]), `"${launcher}" %*`, ''].join('\r\n')

describe('packagedLayout', () => {
  it('darwin', () => {
    expect(packagedLayout('darwin', '/Applications/OrgAI.app/Contents/Resources')).toEqual({
      resourcesDir: '/Applications/OrgAI.app/Contents/Resources',
      binDir: '/Applications/OrgAI.app/Contents/Resources/bin',
      launcher: '/Applications/OrgAI.app/Contents/Resources/bin/orgai',
      unpackedDir: '/Applications/OrgAI.app/Contents/Resources/app.asar.unpacked',
      cliBundleDir: '/Applications/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli',
      cliEntry: '/Applications/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli/orgai.mjs',
      appBinary: '/Applications/OrgAI.app/Contents/MacOS/OrgAI'
    })
  })

  it('win32', () => {
    const l = packagedLayout('win32', 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\')
    expect(l).toEqual({
      resourcesDir: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources',
      binDir: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\bin',
      launcher: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\bin\\orgai.cmd',
      unpackedDir: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\app.asar.unpacked',
      cliBundleDir: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\app.asar.unpacked\\out\\cli',
      cliEntry: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\resources\\app.asar.unpacked\\out\\cli\\orgai.mjs',
      appBinary: 'C:\\Users\\a b\\AppData\\Local\\Programs\\OrgAI\\OrgAI.exe'
    })
  })

  it('linux, appBinary normalized', () => {
    const l = packagedLayout('linux', '/opt/OrgAI/resources')
    expect(l.appBinary).toBe('/opt/OrgAI/orgai')
    expect(l.appBinary).not.toContain('..')
    expect(l.launcher).toBe('/opt/OrgAI/resources/bin/orgai')
    expect(l.cliEntry).toBe('/opt/OrgAI/resources/app.asar.unpacked/out/cli/orgai.mjs')
  })

  it('launcher names', () => {
    expect(cliLauncherName('win32')).toBe('orgai.cmd')
    expect(cliLauncherName('darwin')).toBe('orgai')
    expect(cliLauncherName('linux')).toBe('orgai')
  })
})

describe('cliShimPath', () => {
  it('per platform', () => {
    expect(cliShimPath('darwin', {}, '/Users/a')).toBe('/Users/a/.local/bin/orgai')
    expect(cliShimPath('linux', {}, '/home/a')).toBe('/home/a/.local/bin/orgai')
    expect(cliShimPath('win32', { LOCALAPPDATA: ' C:\\Users\\a\\AppData\\Local ' }, 'C:\\Users\\a')).toBe(
      'C:\\Users\\a\\AppData\\Local\\OrgAI\\bin\\orgai.cmd'
    )
  })

  it('falls back to home\\AppData\\Local without LOCALAPPDATA', () => {
    expect(cliShimPath('win32', {}, 'C:\\Users\\b')).toBe('C:\\Users\\b\\AppData\\Local\\OrgAI\\bin\\orgai.cmd')
    expect(cliShimPath('win32', { LOCALAPPDATA: '  ' }, 'C:\\Users\\b')).toBe('C:\\Users\\b\\AppData\\Local\\OrgAI\\bin\\orgai.cmd')
  })
})

describe('parseCliShim / isOrgaiShim (old app shims)', () => {
  it('POSIX: the data line is optional', () => {
    expect(parseCliShim(posixShim('/A/OrgAI.app/Contents/Resources/bin/orgai'), 'darwin')).toEqual({ launcher: '/A/OrgAI.app/Contents/Resources/bin/orgai' })
    expect(parseCliShim(posixShim('/opt/OrgAI/resources/bin/orgai', '/home/a/.config/OrgAI'), 'linux')).toEqual({
      launcher: '/opt/OrgAI/resources/bin/orgai',
      userDataDir: '/home/a/.config/OrgAI'
    })
  })

  it.each([
    "/Users/a b/My Apps/OrgAI.app/Contents/Resources/bin/orgai",
    "/Users/o'brien/OrgAI.app/Contents/Resources/bin/orgai",
    "/Users/x/'quoted'/'/bin/orgai'",
    '/Users/x/$HOME/`whoami`/$(id)/bin/orgai',
    '/Users/x/"dq"; rm -rf ~/bin/orgai'
  ])('POSIX quoted path: %s', (launcher) => {
    const userDataDir = launcher.replace('/bin/orgai', "/data dir/it's")
    expect(parseCliShim(posixShim(launcher, userDataDir), 'darwin')).toEqual({ launcher, userDataDir })
    expect(parseCliShim(posixShim(launcher), 'darwin')).toEqual({ launcher })
  })

  it('win32: CRLF shim with spaces, and the older `call` line', () => {
    const launcher = 'C:\\Program Files\\OrgAI\\resources\\bin\\orgai.cmd'
    const userDataDir = 'C:\\Users\\a b\\AppData\\Roaming\\OrgAI'
    expect(parseCliShim(winShim(launcher, userDataDir), 'win32')).toEqual({ launcher, userDataDir })
    expect(parseCliShim(winShim(launcher), 'win32')).toEqual({ launcher })
    const old = `@echo off\r\nrem orgai-shim v1: x\r\nsetlocal\r\ncall "${launcher}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    expect(parseCliShim(old, 'win32')).toEqual({ launcher })
  })

  it('win32: a leading %LOCALAPPDATA%-style variable is expanded from the environment', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\Jürgen\\AppData\\Local', APPDATA: 'C:\\Users\\Jürgen\\AppData\\Roaming\\' }
    const text = winShim('%LOCALAPPDATA%\\Programs\\OrgAI\\resources\\bin\\orgai.cmd', '%APPDATA%\\OrgAI')
    expect(parseCliShim(text, 'win32', env)).toEqual({
      launcher: 'C:\\Users\\Jürgen\\AppData\\Local\\Programs\\OrgAI\\resources\\bin\\orgai.cmd',
      userDataDir: 'C:\\Users\\Jürgen\\AppData\\Roaming\\OrgAI'
    })
  })

  it('isOrgaiShim and parseCliShim on foreign text', () => {
    expect(isOrgaiShim('#!/bin/sh\nexec /usr/local/lib/node_modules/orgai/bin/orgai "$@"\n')).toBe(false)
    expect(parseCliShim('#!/bin/sh\nexec /x "$@"\n', 'darwin')).toBeUndefined()
    expect(isOrgaiShim('')).toBe(false)
    expect(isOrgaiShim('1\n2\n3\n4\n5\n# orgai-shim v1\n')).toBe(false)
    expect(isOrgaiShim('#!/bin/sh\n# orgai-shim v2: future\n')).toBe(true)
    // An OrgAI marker but no exec line it can read.
    expect(parseCliShim('#!/bin/sh\n# orgai-shim v1: x\nexec /unquoted "$@"\n', 'darwin')).toBeUndefined()
    expect(parseCliShim('@echo off\r\nrem orgai-shim v1\r\n', 'win32')).toBeUndefined()
  })
})
