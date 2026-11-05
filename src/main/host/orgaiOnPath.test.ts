import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions, findOrgaiOnPath, orgaiCandidateNames, orgaiSourceWords, shadowedNewer, type OrgaiPathFs } from './orgaiOnPath'
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
    writeFileSync(join(res, 'bin', 'orgai'), '#!/bin/sh\n')
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
})
