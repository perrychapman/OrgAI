import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleArgs, childPath, digestFiles, fileInfos, readBundle, readStoredFolder, safeRelPath, writeFolder } from './files'

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

describe('readBundle', () => {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')
  const MD = '---\nname: demo\ndescription: A demo skill.\n---\nDo the thing.\n'
  const bundle = (files: { relPath: string; base64: string }[]) => ({ name: 'demo', files })
  const ok = (extra: { relPath: string; base64: string }[] = []) => bundle([{ relPath: 'SKILL.md', base64: b64(MD) }, ...extra])
  const refused = (input: ReturnType<typeof bundle>): string => {
    const r = readBundle(input)
    expect(r.ok).toBe(false)
    return r.ok ? '' : r.reason
  }

  it('returns the decoded files of a valid bundle', () => {
    const r = readBundle(ok([{ relPath: 'ref/notes.md', base64: b64('notes') }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.map((x) => [x.path, x.data.toString()])).toEqual([
      ['SKILL.md', MD],
      ['ref/notes.md', 'notes']
    ])
  })

  it('refuses unsafe paths', () => {
    const bad = ['..', 'a/../b', '/abs', 'C:\\x', 'C:/x', '\\\\host\\s', '//host/s', 'a\\b', 'a\u0001b', 'a\u202eb.md', 'a\u200bb.md', 'CON', 'con.txt', 'sub/LPT9.md', 'nul', 'a:b', '.git/config', 'a/b/c/d/e/f.md', 'x.', '']
    for (const p of bad) expect(refused(ok([{ relPath: p, base64: b64('x') }])), p).not.toBe('')
    expect(readBundle(ok([{ relPath: 'a/b/c/d/f.md', base64: b64('x') }])).ok).toBe(true)
    expect(readBundle(ok([{ relPath: 'console.md', base64: b64('x') }])).ok).toBe(true)
  })

  it('refuses case-insensitive duplicates and too many files', () => {
    expect(refused(ok([{ relPath: 'a.md', base64: b64('1') }, { relPath: 'A.MD', base64: b64('2') }]))).toMatch(/same path/)
    const many = Array.from({ length: 50 }, (_, i) => ({ relPath: `f${i}.md`, base64: b64('x') }))
    expect(refused(ok(many))).toMatch(/More than 50/)
  })

  it('enforces the size caps', () => {
    const big = (n: number) => b64(Buffer.alloc(n, 0x61))
    expect(refused(bundle([{ relPath: 'SKILL.md', base64: big(256 * 1024 + 3) }]))).toMatch(/SKILL.md is larger than 256 KB/)
    expect(refused(bundle([{ relPath: 'SKILL.md', base64: big(256 * 1024 + 1) }]))).toMatch(/SKILL.md is larger than 256 KB/)
    expect(readBundle(bundle([{ relPath: 'SKILL.md', base64: big(256 * 1024) }])).ok).toBe(true)
    expect(refused(ok([{ relPath: 'r.md', base64: big(64 * 1024 + 1) }]))).toMatch(/r.md is larger than 64 KB/)
    expect(refused(ok([{ relPath: 'r.md', base64: big(64 * 1024 + 3) }]))).toMatch(/larger than 64 KB/)
    const parts = Array.from({ length: 17 }, (_, i) => ({ relPath: `p${i}.md`, base64: big(64 * 1024) }))
    expect(refused(ok(parts))).toMatch(/larger than 1 MB/)
  })

  it('refuses invalid base64, binary content and a missing SKILL.md', () => {
    expect(refused(ok([{ relPath: 'r.md', base64: 'ab$c' }]))).toMatch(/base64/)
    expect(refused(ok([{ relPath: 'r.md', base64: 'abc' }]))).toMatch(/base64/)
    expect(refused(ok([{ relPath: 'r.md', base64: 'a===' }]))).toMatch(/base64/)
    expect(refused(ok([{ relPath: 'r.md', base64: 'YR==' }]))).toMatch(/base64/)
    expect(refused(ok([{ relPath: 'r.bin', base64: b64(Buffer.from([0x61, 0, 0x62])) }]))).toMatch(/not a text file/)
    expect(refused(ok([{ relPath: 'r.bin', base64: b64(Buffer.from([0xff, 0xfe, 0x41])) }]))).toMatch(/not a text file/)
    expect(refused(bundle([{ relPath: 'notes.md', base64: b64('x') }]))).toMatch(/no SKILL.md/)
    expect(refused(bundle([{ relPath: 'sub/SKILL.md', base64: b64(MD) }]))).toMatch(/no SKILL.md/)
    expect(refused(bundle([]))).toMatch(/no files/)
  })
})

describe('bundleArgs', () => {
  it('rebuilds the input and drops extra fields', () => {
    expect(bundleArgs({ name: 'demo', extra: 1, files: [{ relPath: 'SKILL.md', base64: 'eA==', mode: 0o777 }] })).toEqual({ name: 'demo', files: [{ relPath: 'SKILL.md', base64: 'eA==' }] })
  })
  it('refuses non-objects and bad shapes', () => {
    const bad = [null, 'x', 1, [], new Date(), { files: [] }, { name: 'a' }, { name: 'a', files: [{ relPath: 1, base64: '' }] }, { name: 'a', files: Array.from({ length: 51 }, () => ({ relPath: 'a', base64: '' })) }]
    for (const b of bad) expect(() => bundleArgs(b)).toThrow()
  })
})
