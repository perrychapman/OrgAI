import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDirFor, buildsRoot, digestBuildDir, insideWorkspace, removeBuildDir, rewritePath, stageBuild } from './builds'

let data: string
let ws: string
beforeEach(() => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-builds-')))
  data = join(base, 'data')
  ws = join(base, 'ws')
  mkdirSync(data)
  mkdirSync(ws)
  writeFileSync(join(ws, 'server.js'), 'one')
})
afterEach(() => rmSync(join(data, '..'), { recursive: true, force: true }))

describe('buildDirFor / removeBuildDir', () => {
  it('accepts only id-shaped entry ids', () => {
    expect(buildDirFor(data, 'abc-1_x')).toBe(join(buildsRoot(data), 'abc-1_x'))
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '-lead', 'x'.repeat(65), 7, null, undefined]) expect(buildDirFor(data, bad)).toBeNull()
  })
  it('removes a build dir, and ignores a bad id or a missing dir without throwing', () => {
    const dir = buildDirFor(data, 'e1')!
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'f'), 'x')
    removeBuildDir(data, '../data')
    expect(existsSync(dir)).toBe(true)
    removeBuildDir(data, 'e1')
    expect(existsSync(dir)).toBe(false)
    expect(() => removeBuildDir(data, 'never-built')).not.toThrow()
  })
})

describe('stageBuild', () => {
  it('discard drops the staged copy and leaves no final dir', () => {
    const staged = stageBuild(data, 'e1', ws)
    expect(readdirSync(buildsRoot(data)).some((n) => n.startsWith('.tmp-e1'))).toBe(true)
    staged.discard()
    expect(readdirSync(buildsRoot(data))).toEqual([])
  })
  it('install moves the copy in; its digest matches digestBuildDir and changes with the content', () => {
    const a = stageBuild(data, 'e1', ws)
    const installed = a.install()
    installed.finish()
    expect(readFileSync(join(installed.dir, 'server.js'), 'utf8')).toBe('one')
    expect(digestBuildDir(installed.dir)).toBe(a.digest)
    writeFileSync(join(ws, 'server.js'), 'two')
    const b = stageBuild(data, 'e2', ws)
    expect(b.digest).not.toBe(a.digest)
    b.discard()
  })
  it('a digest depends on file names, not only bytes', () => {
    const a = stageBuild(data, 'e1', ws)
    const other = join(ws, '..', 'ws2')
    mkdirSync(other)
    writeFileSync(join(other, 'renamed.js'), 'one')
    const b = stageBuild(data, 'e2', other)
    expect(b.digest).not.toBe(a.digest)
    a.discard()
    b.discard()
  })
  it('replaces an earlier build; finish drops the old copy', () => {
    stageBuild(data, 'e1', ws).install().finish()
    writeFileSync(join(ws, 'server.js'), 'two')
    const installed = stageBuild(data, 'e1', ws).install()
    expect(readFileSync(join(installed.dir, 'server.js'), 'utf8')).toBe('two')
    installed.finish()
    expect(readdirSync(buildsRoot(data))).toEqual(['e1'])
  })
  it('rollback restores the earlier build, or removes a first build', () => {
    stageBuild(data, 'e1', ws).install().finish()
    writeFileSync(join(ws, 'server.js'), 'two')
    stageBuild(data, 'e1', ws).install().rollback()
    expect(readFileSync(join(buildsRoot(data), 'e1', 'server.js'), 'utf8')).toBe('one')
    const first = stageBuild(data, 'e9', ws).install()
    first.rollback()
    expect(existsSync(first.dir)).toBe(false)
  })
  it('refuses an id that is not id-shaped and a missing workspace', () => {
    expect(() => stageBuild(data, '../x', ws)).toThrow(/not valid/)
    expect(() => stageBuild(data, 'e1', join(ws, 'nope'))).toThrow()
    expect(existsSync(buildsRoot(data)) ? readdirSync(buildsRoot(data)) : []).toEqual([])
  })
})

describe('insideWorkspace / rewritePath', () => {
  it('is true only for an absolute path under the workspace', () => {
    expect(insideWorkspace(ws, join(ws, 'a', 'b.js'))).toBe(true)
    expect(insideWorkspace(ws, resolve(ws, '..', 'other', 'b.js'))).toBe(false)
    expect(insideWorkspace(ws, join(ws, '..', 'ws2', 'x'))).toBe(false)
    expect(insideWorkspace(ws, 'relative/file.js')).toBe(false)
    expect(insideWorkspace(ws, 42)).toBe(false)
    expect(insideWorkspace(ws, undefined)).toBe(false)
  })
  it('maps a workspace path to the same relative path under the copy', () => {
    expect(rewritePath(ws, join(data, 'copy'), join(ws, 'dist', 'index.js'))).toBe(join(data, 'copy', 'dist', 'index.js'))
  })
})
