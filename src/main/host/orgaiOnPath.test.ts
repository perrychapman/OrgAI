import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGED_LAUNCHER_MARK as DOCTOR_LAUNCHER_MARK } from '../../cli/commands/doctor'
import {
  PACKAGED_LAUNCHER_MARK,
  compareVersions,
  findOrgaiOnPath,
  isNetworkPathFor,
  orgaiCandidateNames,
  orgaiSourceWords,
  shadowedNewer,
  type OrgaiPathFs
} from './orgaiOnPath'
import { renderCliShim } from './packagedLayout'

const posixOnly = process.platform === 'win32' ? it.skip : it

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    expect(compareVersions('0.1.6', '0.1.7')).toBe(-1)
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.6-dev1', '0.1.6')).toBe(-1)
    expect(compareVersions('0.1.6', '0.1.6-dev9')).toBe(1)
    expect(compareVersions('0.1.6-dev2', '0.1.6-dev10')).toBe(-1)
    expect(compareVersions('0.1.6-1', '0.1.6-dev')).toBe(-1)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('junk', '1.0.0')).toBeUndefined()
  })
})

describe('orgaiCandidateNames', () => {
  it('is orgai on POSIX and PATHEXT order on Windows', () => {
    expect(orgaiCandidateNames('darwin')).toEqual(['orgai'])
    expect(orgaiCandidateNames('win32', {})).toEqual(['orgai.com', 'orgai.exe', 'orgai.bat', 'orgai.cmd'])
    expect(orgaiCandidateNames('win32', { PathExt: '.EXE;.CMD;bad;.cmd' })).toEqual(['orgai.exe', 'orgai.cmd'])
  })
})

describe('shadowedNewer and source words', () => {
  it('flags later entries newer than the first', () => {
    const entries = [
      { path: '/a/orgai', kind: 'npm' as const, version: '0.1.6' },
      { path: '/b/orgai', kind: 'app-shim' as const, version: '0.1.7' },
      { path: '/c/orgai', kind: 'unknown' as const },
      { path: '/d/orgai', kind: 'npm' as const, version: '0.1.5' }
    ]
    expect(shadowedNewer(entries).map((e) => e.path)).toEqual(['/b/orgai'])
    expect(shadowedNewer([{ path: '/x', kind: 'unknown' }, entries[1]])).toEqual([])
    expect(orgaiSourceWords({ kind: 'npm' })).toBe('from npm')
    expect(orgaiSourceWords({ kind: 'app-shim' })).toBe('of an OrgAI app')
  })
})

describe('findOrgaiOnPath on a real folder tree', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-onpath-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  posixOnly('reads an npm link, an app shim and an unknown file in PATH order', () => {
    // npm: <prefix>/bin/orgai -> ../lib/node_modules/orgai/out/cli/orgai.mjs
    const npmCli = join(root, 'npm', 'lib', 'node_modules', 'orgai', 'out', 'cli')
    mkdirSync(npmCli, { recursive: true })
    writeFileSync(join(npmCli, 'orgai.mjs'), '#!/usr/bin/env node\n')
    writeFileSync(join(npmCli, 'install.json'), JSON.stringify({ channel: 'npm', version: '0.1.6', commit: 'abc123' }))
    mkdirSync(join(root, 'npm', 'bin'))
    symlinkSync(join('..', 'lib', 'node_modules', 'orgai', 'out', 'cli', 'orgai.mjs'), join(root, 'npm', 'bin', 'orgai'))
    // An app shim running <res>/bin/orgai, whose bundle says app 0.1.7.
    const res = join(root, 'OrgAI.app', 'Contents', 'Resources')
    const appCli = join(res, 'app.asar.unpacked', 'out', 'cli')
    mkdirSync(appCli, { recursive: true })
    writeFileSync(join(appCli, 'install.json'), JSON.stringify({ channel: 'app', version: '0.1.7' }))
    mkdirSync(join(res, 'bin'))
    writeFileSync(join(res, 'bin', 'orgai'), `#!/bin/sh\n# ${PACKAGED_LAUNCHER_MARK} (cli-spec 7, Wave 6).\n`)
    mkdirSync(join(root, 'shim'))
    writeFileSync(join(root, 'shim', 'orgai'), renderCliShim({ platform: 'darwin', launcher: join(res, 'bin', 'orgai'), env: {} }))
    // A link to the packaged launcher itself.
    mkdirSync(join(root, 'linked'))
    symlinkSync(join(res, 'bin', 'orgai'), join(root, 'linked', 'orgai'))
    // Something else called orgai, a folder named orgai, and a missing folder.
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other', 'orgai'), '#!/bin/sh\necho hi\n')
    mkdirSync(join(root, 'dir', 'orgai'), { recursive: true })
    const pathList = [join(root, 'npm', 'bin'), join(root, 'missing'), join(root, 'dir'), join(root, 'shim'), `${join(root, 'npm', 'bin')}/`, 'relative/bin', join(root, 'linked'), join(root, 'other')].join(':')

    const found = findOrgaiOnPath({ platform: process.platform, pathList, env: {}, home: root })
    expect(found.map((e) => [e.kind, e.channel, e.version])).toEqual([
      ['npm', 'npm', '0.1.6'],
      ['app-shim', 'app', '0.1.7'],
      ['app-launcher', 'app', '0.1.7'],
      ['unknown', undefined, undefined]
    ])
    expect(found[0]).toMatchObject({ path: join(root, 'npm', 'bin', 'orgai'), commit: 'abc123' })
    expect(found[1].launcher).toBe(join(res, 'bin', 'orgai'))
    expect(shadowedNewer(found).map((e) => e.kind)).toEqual(['app-shim', 'app-launcher'])
  })

  posixOnly('a link to a checkout bundle without install.json reads as dev; a broken install.json gives no channel', () => {
    const cli = join(root, 'repo', 'out', 'cli')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'orgai.mjs'), '')
    mkdirSync(join(root, 'bin'))
    symlinkSync(join(cli, 'orgai.mjs'), join(root, 'bin', 'orgai'))
    expect(findOrgaiOnPath({ platform: process.platform, pathList: join(root, 'bin'), home: root })).toEqual([
      { path: join(root, 'bin', 'orgai'), kind: 'dev', bundleDir: cli, channel: 'dev' }
    ])
    writeFileSync(join(cli, 'install.json'), '{nope')
    expect(findOrgaiOnPath({ platform: process.platform, pathList: join(root, 'bin'), home: root })[0]).toEqual({ path: join(root, 'bin', 'orgai'), kind: 'dev', bundleDir: cli })
  })

  /** A packaged app's Resources with the launcher (real text when `marked`) and install.json; orgai.mjs when `entry`. */
  function packagedApp(name: string, opts: { marked: boolean; entry: boolean; version: string }): string {
    const res = join(root, name, 'Contents', 'Resources')
    const cli = join(res, 'app.asar.unpacked', 'out', 'cli')
    mkdirSync(cli, { recursive: true })
    writeFileSync(join(cli, 'install.json'), JSON.stringify({ channel: 'app', version: opts.version }))
    if (opts.entry) writeFileSync(join(cli, 'orgai.mjs'), '')
    mkdirSync(join(res, 'bin'))
    writeFileSync(join(res, 'bin', 'orgai'), opts.marked ? `#!/bin/sh\n# ${PACKAGED_LAUNCHER_MARK} (cli-spec 7, Wave 6).\n` : '#!/bin/sh\n')
    return res
  }

  posixOnly('the launcher folder itself on PATH (a plain file, not a link) reads as that app, by its text or its bundle', () => {
    const a = packagedApp('A.app', { marked: true, entry: false, version: '0.1.7' })
    const b = packagedApp('B.app', { marked: false, entry: true, version: '0.1.8' })
    const found = findOrgaiOnPath({ platform: process.platform, pathList: `${join(a, 'bin')}:${join(b, 'bin')}`, home: root })
    expect(found).toEqual([
      { path: join(a, 'bin', 'orgai'), kind: 'app-launcher', launcher: join(a, 'bin', 'orgai'), bundleDir: join(a, 'app.asar.unpacked', 'out', 'cli'), channel: 'app', version: '0.1.7' },
      { path: join(b, 'bin', 'orgai'), kind: 'app-launcher', launcher: join(b, 'bin', 'orgai'), bundleDir: join(b, 'app.asar.unpacked', 'out', 'cli'), channel: 'app', version: '0.1.8' }
    ])
    // The first now has a version, so the newer one behind it is flagged (8.2).
    expect(shadowedNewer(found).map((e) => e.version)).toEqual(['0.1.8'])
  })

  posixOnly('any other <X>/bin/orgai is not a launcher, as a file or through a link; a link to a shim reads as the shim', () => {
    // A user's own wrapper at ~/tools/bin/orgai: neither marked nor beside an OrgAI bundle.
    mkdirSync(join(root, 'tools', 'bin'), { recursive: true })
    writeFileSync(join(root, 'tools', 'bin', 'orgai'), '#!/bin/sh\nexec something "$@"\n')
    mkdirSync(join(root, 'bin'))
    symlinkSync(join(root, 'tools', 'bin', 'orgai'), join(root, 'bin', 'orgai'))
    expect(findOrgaiOnPath({ platform: process.platform, pathList: `${join(root, 'bin')}:${join(root, 'tools', 'bin')}`, home: root })).toEqual([
      { path: join(root, 'bin', 'orgai'), kind: 'unknown' },
      { path: join(root, 'tools', 'bin', 'orgai'), kind: 'unknown' }
    ])
    // /usr/local/bin/orgai -> ~/.local/bin/orgai (this app's shim): the shim's launcher, not "a launcher at ~/.local".
    const res = packagedApp('C.app', { marked: true, entry: true, version: '0.1.9' })
    mkdirSync(join(root, 'home', '.local', 'bin'), { recursive: true })
    writeFileSync(join(root, 'home', '.local', 'bin', 'orgai'), renderCliShim({ platform: 'darwin', launcher: join(res, 'bin', 'orgai'), env: {} }))
    mkdirSync(join(root, 'usrlocal'))
    symlinkSync(join(root, 'home', '.local', 'bin', 'orgai'), join(root, 'usrlocal', 'orgai'))
    expect(findOrgaiOnPath({ platform: process.platform, pathList: join(root, 'usrlocal'), home: root })).toEqual([
      { path: join(root, 'usrlocal', 'orgai'), kind: 'app-shim', launcher: join(res, 'bin', 'orgai'), bundleDir: join(res, 'app.asar.unpacked', 'out', 'cli'), channel: 'app', version: '0.1.9' }
    ])
  })

  it('the launcher mark matches doctor and both packaged launchers', () => {
    expect(PACKAGED_LAUNCHER_MARK).toBe(DOCTOR_LAUNCHER_MARK)
    for (const f of ['orgai', 'orgai.cmd']) expect(readFileSync(join(__dirname, '..', '..', '..', 'build', 'bin', f), 'utf8')).toContain(PACKAGED_LAUNCHER_MARK)
  })

  it('finds nothing for an empty PATH', () => {
    expect(findOrgaiOnPath({ platform: 'linux', pathList: '' })).toEqual([])
    expect(findOrgaiOnPath({ platform: 'linux', pathList: undefined })).toEqual([])
  })
})

describe('findOrgaiOnPath on Windows (fake fs)', () => {
  function fakeFs(files: Record<string, string>): Partial<OrgaiPathFs> {
    const key = (p: string): string => win32.normalize(p).toLowerCase()
    const map = new Map(Object.entries(files).map(([k, v]) => [key(k), v]))
    const st = (p: string): { isFile(): boolean; isSymbolicLink(): boolean; size: number } => {
      const v = map.get(key(p))
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isFile: () => true, isSymbolicLink: () => false, size: v.length }
    }
    return { lstat: st, stat: st, readText: (p) => map.get(key(p)) ?? '', realpath: (p) => p }
  }

  it('reads npm\'s orgai.cmd and an OrgAI shim', () => {
    const npmDir = 'C:\\Users\\u\\AppData\\Roaming\\npm'
    const res = 'C:\\Users\\u\\AppData\\Local\\Programs\\OrgAI\\resources'
    const fs = fakeFs({
      [`${npmDir}\\orgai.cmd`]: '@ECHO off\r\nGOTO start\r\n:start\r\n"%_prog%"  "%dp0%\\node_modules\\orgai\\out\\cli\\orgai.mjs" %*\r\n',
      [`${npmDir}\\node_modules\\orgai\\out\\cli\\install.json`]: JSON.stringify({ channel: 'npm', version: '0.2.0' }),
      'C:\\Users\\u\\AppData\\Local\\OrgAI\\bin\\orgai.cmd': renderCliShim({ platform: 'win32', launcher: `${res}\\bin\\orgai.cmd`, env: {} }),
      [`${res}\\app.asar.unpacked\\out\\cli\\install.json`]: JSON.stringify({ channel: 'app', version: '0.1.9' })
    })
    const found = findOrgaiOnPath({ platform: 'win32', pathList: `C:\\Users\\u\\AppData\\Local\\OrgAI\\bin;${npmDir}`, env: {}, fs })
    expect(found.map((e) => [e.kind, e.version])).toEqual([
      ['app-shim', '0.1.9'],
      ['npm', '0.2.0']
    ])
    expect(shadowedNewer(found).map((e) => e.path)).toEqual([`${npmDir}\\orgai.cmd`])
  })

  it('reads the launcher folder itself on PATH as that app', () => {
    const res = 'C:\\Program Files\\OrgAI\\resources'
    const fs = fakeFs({
      [`${res}\\bin\\orgai.cmd`]: `@echo off\r\nrem ${PACKAGED_LAUNCHER_MARK} (cli-spec 7, Wave 6): runs OrgAI.exe as Node on the CLI bundle.\r\n`,
      [`${res}\\app.asar.unpacked\\out\\cli\\install.json`]: JSON.stringify({ channel: 'app', version: '0.1.9', commit: 'abc' })
    })
    expect(findOrgaiOnPath({ platform: 'win32', pathList: `${res}\\bin`, env: {}, fs })).toEqual([
      { path: `${res}\\bin\\orgai.cmd`, kind: 'app-launcher', launcher: `${res}\\bin\\orgai.cmd`, bundleDir: `${res}\\app.asar.unpacked\\out\\cli`, channel: 'app', version: '0.1.9', commit: 'abc' }
    ])
    // Some other bin\orgai.cmd with neither the text nor a bundle beside it stays unknown.
    const other = fakeFs({ 'C:\\tools\\bin\\orgai.cmd': '@echo off\r\nnode x.js %*\r\n' })
    expect(findOrgaiOnPath({ platform: 'win32', pathList: 'C:\\tools\\bin', env: {}, fs: other })).toEqual([{ path: 'C:\\tools\\bin\\orgai.cmd', kind: 'unknown' }])
  })

  it('never touches a network folder on PATH (UNC, quoted or not)', () => {
    const touched: string[] = []
    const base = fakeFs({ 'C:\\npm\\orgai.cmd': '@echo off\r\n' })
    const fs: Partial<OrgaiPathFs> = {
      ...base,
      lstat: (p) => {
        touched.push(p)
        return base.lstat!(p)
      }
    }
    const found = findOrgaiOnPath({ platform: 'win32', pathList: '\\\\fileserver\\tools;"\\\\fs2\\bin";//fs3/x;\\\\?\\UNC\\fs4\\y;C:\\npm', env: { PATHEXT: '.CMD' }, fs })
    expect(found.map((e) => e.path)).toEqual(['C:\\npm\\orgai.cmd'])
    expect(touched).toEqual(['C:\\npm\\orgai.cmd'])
  })
})

describe('isNetworkPathFor', () => {
  it('matches UNC on win32 and the automounts on darwin only', () => {
    expect(isNetworkPathFor('win32', '\\\\server\\share')).toBe(true)
    expect(isNetworkPathFor('win32', '//server/share')).toBe(true)
    expect(isNetworkPathFor('win32', 'C:\\tools')).toBe(false)
    expect(isNetworkPathFor('darwin', '/net/host/x')).toBe(true)
    expect(isNetworkPathFor('darwin', '/Network/Servers')).toBe(true)
    expect(isNetworkPathFor('darwin', '/usr/local/bin')).toBe(false)
    expect(isNetworkPathFor('linux', '/net/host')).toBe(false)
  })
})
