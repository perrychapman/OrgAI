import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { childPath, digestFiles, fileInfos, readStoredFolder, safeRelPath, writeFolder } from './files'

const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skillfiles-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const f = (path: string, text: string) => ({ path, data: Buffer.from(text) })

describe('childPath', () => {
  it('accepts safe ids and refuses traversal', () => {
    const base = temp()
    expect(childPath(base, 'p1', 'skill_1')).toBe(join(base, 'p1', 'skill_1'))
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.', 'x'.repeat(200)]) expect(() => childPath(base, bad)).toThrow('Invalid id')
  })
})

describe('safeRelPath', () => {
  it('refuses absolute, parent and backslash paths', () => {
    expect(safeRelPath('a/b.txt')).toBe(true)
    for (const bad of ['', '/a', '../a', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a']) expect(safeRelPath(bad)).toBe(false)
  })
})

describe('digestFiles', () => {
  it('depends on paths and contents, not order', () => {
    const a = digestFiles([f('a', '1'), f('b', '2')])
    expect(digestFiles([f('b', '2'), f('a', '1')])).toBe(a)
    expect(digestFiles([f('a', '1'), f('b', '3')])).not.toBe(a)
    expect(digestFiles([f('a', '1'), f('c', '2')])).not.toBe(a)
    expect(digestFiles([f('a', '12'), f('b', '')])).not.toBe(digestFiles([f('a', '1'), f('b', '2')]))
  })
  it('fileInfos puts SKILL.md first', () => {
    expect(fileInfos([f('z.txt', 'x'), f('SKILL.md', 'yy'), f('a.txt', '')])).toEqual([
      { path: 'SKILL.md', bytes: 2 },
      { path: 'a.txt', bytes: 0 },
      { path: 'z.txt', bytes: 1 }
    ])
  })
})

describe('writeFolder / readStoredFolder', () => {
  it('writes nested files, replaces a folder atomically and leaves no temp folders', () => {
    const base = temp()
    const dest = join(base, 'skill')
    writeFolder(dest, [f('SKILL.md', 'one'), f('sub/dir/x.txt', 'x')])
    expect(readFileSync(join(dest, 'sub', 'dir', 'x.txt'), 'utf8')).toBe('x')
    writeFolder(dest, [f('SKILL.md', 'two')])
    expect(readStoredFolder(dest).map((x) => x.path)).toEqual(['SKILL.md'])
    expect(readdirSync(base)).toEqual(['skill'])
  })
  it('refuses unsafe paths without writing', () => {
    const base = temp()
    expect(() => writeFolder(join(base, 'skill'), [f('../escape.txt', 'x')])).toThrow(/Unsafe/)
    expect(existsSync(join(base, 'escape.txt'))).toBe(false)
    expect(readdirSync(base)).toEqual([])
  })
  it('readStoredFolder reports a missing folder', () => {
    expect(() => readStoredFolder(join(temp(), 'nope'))).toThrow(/missing/)
    const d = temp()
    mkdirSync(join(d, 'a'))
    writeFileSync(join(d, 'a', 'SKILL.md'), 'x')
    expect(readStoredFolder(join(d, 'a'))).toHaveLength(1)
  })
})
