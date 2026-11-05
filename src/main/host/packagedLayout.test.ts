import { describe, expect, it } from 'vitest'
import {
  CLI_SHIM_MARKER,
  CLI_SHIM_VERSION,
  shimMarkerVersion,
  cliLauncherName,
  cliShimPath,
  isOrgaiShim,
  packagedCliRoots,
  packagedLayout,
  parseCliShim,
  renderCliShim,
  resourcesDirOfCliBundle,
  transientInstallReason
} from './packagedLayout'

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

describe('resourcesDirOfCliBundle', () => {
  it('finds the resources dir of a packaged bundle', () => {
    expect(resourcesDirOfCliBundle('/Applications/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli', 'darwin')).toBe(
      '/Applications/OrgAI.app/Contents/Resources'
    )
    expect(resourcesDirOfCliBundle('/Applications/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli//', 'darwin')).toBe(
      '/Applications/OrgAI.app/Contents/Resources'
    )
    expect(resourcesDirOfCliBundle('C:\\P\\OrgAI\\resources\\app.asar.unpacked\\out\\cli\\', 'win32')).toBe('C:\\P\\OrgAI\\resources')
    expect(resourcesDirOfCliBundle('C:/P/OrgAI/resources/app.asar.unpacked/out/cli', 'win32')).toBe('C:\\P\\OrgAI\\resources')
  })

  it('is undefined for anything else', () => {
    expect(resourcesDirOfCliBundle('/Users/me/code/project/out/cli', 'darwin')).toBeUndefined()
    expect(resourcesDirOfCliBundle('/Users/me/OrgAI/out/cli', 'darwin')).toBeUndefined()
    expect(resourcesDirOfCliBundle('/x/app.asar/out/cli', 'darwin')).toBeUndefined()
    expect(resourcesDirOfCliBundle('/x/app.asar.unpacked/out', 'darwin')).toBeUndefined()
    expect(resourcesDirOfCliBundle('', 'darwin')).toBeUndefined()
    expect(resourcesDirOfCliBundle('C:\\code\\out\\cli', 'win32')).toBeUndefined()
  })
})

describe('packagedCliRoots', () => {
  it('app.asar and app.asar.unpacked give the bundle and bin folders', () => {
    const want = ['/A/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli', '/A/OrgAI.app/Contents/Resources/bin']
    expect(packagedCliRoots('/A/OrgAI.app/Contents/Resources/app.asar', 'darwin')).toEqual(want)
    expect(packagedCliRoots('/A/OrgAI.app/Contents/Resources/app.asar.unpacked', 'darwin')).toEqual(want)
    expect(packagedCliRoots('C:\\P\\resources\\app.asar', 'win32')).toEqual(['C:\\P\\resources\\app.asar.unpacked\\out\\cli', 'C:\\P\\resources\\bin'])
  })

  it('a dev root gives []', () => {
    expect(packagedCliRoots('/Users/me/OrgAI', 'darwin')).toEqual([])
    expect(packagedCliRoots('', 'darwin')).toEqual([])
  })
})

describe('transientInstallReason', () => {
  it('darwin translocation and disk images', () => {
    expect(transientInstallReason('darwin', '/private/var/folders/x/AppTranslocation/ABC/d/OrgAI.app/Contents/Resources', {})).toMatch(
      /Applications folder/
    )
    expect(transientInstallReason('darwin', '/Volumes/OrgAI/OrgAI.app/Contents/Resources', {})).toMatch(/Applications folder/)
    expect(transientInstallReason('darwin', '/Applications/OrgAI.app/Contents/Resources', {})).toBeUndefined()
  })

  it('linux AppImage, win32 portable', () => {
    expect(transientInstallReason('linux', '/tmp/.mount_x/resources', { APPIMAGE: '/home/a/OrgAI.AppImage' })).toBe(
      'The orgai command cannot be installed from an AppImage.'
    )
    expect(transientInstallReason('linux', '/opt/OrgAI/resources', {})).toBeUndefined()
    expect(transientInstallReason('win32', 'C:\\x', { PORTABLE_EXECUTABLE_DIR: 'D:\\' })).toBe(
      'The orgai command cannot be installed from the portable OrgAI.'
    )
    expect(transientInstallReason('win32', 'C:\\x', {})).toBeUndefined()
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

describe('renderCliShim / parseCliShim', () => {
  it('POSIX shape, LF endings, the data line only when given', () => {
    const text = renderCliShim({ platform: 'darwin', launcher: '/A/OrgAI.app/Contents/Resources/bin/orgai' })
    expect(text).toBe(
      '#!/bin/sh\n' +
        `# ${CLI_SHIM_MARKER}: written by OrgAI (App settings > General > Advanced settings > Terminal). OrgAI updates or removes this file.\n` +
        `exec '/A/OrgAI.app/Contents/Resources/bin/orgai' "$@"\n`
    )
    expect(text).not.toContain('\r')
    expect(text).not.toContain('ORGAI_DATA_DIR')
    const withData = renderCliShim({ platform: 'linux', launcher: '/opt/OrgAI/resources/bin/orgai', userDataDir: '/home/a/.config/OrgAI' })
    expect(withData).toContain(`if [ -z "\${ORGAI_DATA_DIR:-}" ]; then ORGAI_DATA_DIR='/home/a/.config/OrgAI'; export ORGAI_DATA_DIR; fi\n`)
    expect(parseCliShim(withData, 'linux')).toEqual({ launcher: '/opt/OrgAI/resources/bin/orgai', userDataDir: '/home/a/.config/OrgAI' })
  })

  it.each([
    "/Users/a b/My Apps/OrgAI.app/Contents/Resources/bin/orgai",
    "/Users/o'brien/OrgAI.app/Contents/Resources/bin/orgai",
    "/Users/x/'quoted'/'/bin/orgai'",
    '/Users/x/$HOME/`whoami`/$(id)/bin/orgai',
    '/Users/x/"dq"; rm -rf ~/bin/orgai'
  ])('POSIX round trip: %s', (launcher) => {
    const userDataDir = launcher.replace('/bin/orgai', "/data dir/it's")
    const text = renderCliShim({ platform: 'darwin', launcher, userDataDir })
    expect(parseCliShim(text, 'darwin')).toEqual({ launcher, userDataDir })
    expect(parseCliShim(renderCliShim({ platform: 'darwin', launcher }), 'darwin')).toEqual({ launcher })
  })

  it('win32 shape, CRLF, round trip with spaces', () => {
    const launcher = 'C:\\Program Files\\OrgAI\\resources\\bin\\orgai.cmd'
    const userDataDir = 'C:\\Users\\a b\\AppData\\Roaming\\OrgAI'
    const text = renderCliShim({ platform: 'win32', launcher, userDataDir })
    expect(text).toBe(
      [
        '@echo off',
        `rem ${CLI_SHIM_MARKER}: written by OrgAI (App settings > General > Advanced settings > Terminal). OrgAI updates or removes this file.`,
        'setlocal',
        `if not defined ORGAI_DATA_DIR set "ORGAI_DATA_DIR=${userDataDir}"`,
        `"${launcher}" %*`,
        ''
      ].join('\r\n')
    )
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/)
    expect(parseCliShim(text, 'win32')).toEqual({ launcher, userDataDir })
    const bare = renderCliShim({ platform: 'win32', launcher })
    expect(bare).not.toContain('ORGAI_DATA_DIR')
    expect(parseCliShim(bare, 'win32')).toEqual({ launcher })
    // No CALL: it would expand % in the user's arguments a second time and double carets (review M2).
    expect(text).not.toMatch(/^call /m)
    // A shim written with the older `call` line still parses (the launch refresh rewrites it).
    const old = `@echo off\r\nrem ${CLI_SHIM_MARKER}: x\r\nsetlocal\r\ncall "${launcher}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    expect(parseCliShim(old, 'win32')).toEqual({ launcher })
  })

  it('shimMarkerVersion reads the marker number', () => {
    expect(shimMarkerVersion(renderCliShim({ platform: 'darwin', launcher: '/a/bin/orgai' }))).toBe(CLI_SHIM_VERSION)
    expect(shimMarkerVersion('#!/bin/sh\n# orgai-shim v2: future\n')).toBe(2)
    expect(shimMarkerVersion('#!/bin/sh\nexec x "$@"\n')).toBeUndefined()
    expect(CLI_SHIM_MARKER).toBe(`orgai-shim v${CLI_SHIM_VERSION}`)
  })

  it('refuses unusable paths with a plain sentence', () => {
    expect(() => renderCliShim({ platform: 'darwin', launcher: '' })).toThrow(/empty/)
    expect(() => renderCliShim({ platform: 'darwin', launcher: 'bin/orgai' })).toThrow(/not absolute/)
    expect(() => renderCliShim({ platform: 'darwin', launcher: '/a\nb/orgai' })).toThrow(/line break/)
    expect(() => renderCliShim({ platform: 'darwin', launcher: '/a\rb/orgai' })).toThrow(/line break/)
    expect(() => renderCliShim({ platform: 'darwin', launcher: '/a\0b/orgai' })).toThrow(/NUL/)
    expect(() => renderCliShim({ platform: 'darwin', launcher: '/a/orgai', userDataDir: 'rel' })).toThrow(/not absolute/)
    expect(() => renderCliShim({ platform: 'win32', launcher: 'C:\\a"b\\orgai.cmd' })).toThrow(/quote or a percent/)
    expect(() => renderCliShim({ platform: 'win32', launcher: 'C:\\%PATH%\\orgai.cmd' })).toThrow(/quote or a percent/)
    expect(() => renderCliShim({ platform: 'win32', launcher: 'C:\\a\\orgai.cmd', userDataDir: 'C:\\a\nb' })).toThrow(/line break/)
    expect(() => renderCliShim({ platform: 'win32', launcher: '/posix/orgai.cmd' })).toThrow(/not absolute/)
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
