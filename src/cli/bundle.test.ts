import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSkillFolder, segmentProblem } from './bundle'
import { CliError, EXIT } from './types'

let dir: string
const SKILL_MD = '---\nname: pdf\ndescription: Fill PDF forms\n---\nUse the script.\n'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-bundle-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const put = (rel: string, content: string | Buffer): void => {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

async function usageError(p: Promise<unknown>): Promise<CliError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x
  )
  expect(e).toBeInstanceOf(CliError)
  expect((e as CliError).exitCode).toBe(EXIT.usage)
  return e as CliError
}

describe('readSkillFolder', () => {
  it('reads regular files with forward-slash relPaths, SKILL.md first, base64 content', async () => {
    put('SKILL.md', SKILL_MD)
    put('scripts/fill.py', 'print(1)\n')
    put('ref/deep/a.md', 'a')
    const b = await readSkillFolder(dir)
    expect(b.files.map((f) => f.relPath)).toEqual(['SKILL.md', 'ref/deep/a.md', 'scripts/fill.py'])
    expect(Buffer.from(b.files[0].base64, 'base64').toString()).toBe(SKILL_MD)
    expect(b.name).toBe(basename(dir))
    expect((await readSkillFolder(dir, { name: 'custom' })).name).toBe('custom')
  })

  it('skips symlinks, dot entries, .git and node_modules with a note', async () => {
    put('SKILL.md', SKILL_MD)
    put('real.md', 'x')
    // Windows: a file symlink needs a privilege (EPERM), a junction does not. lstat reports both as links.
    if (process.platform === 'win32') {
      mkdirSync(join(dir, 'realdir'))
      symlinkSync(join(dir, 'realdir'), join(dir, 'link.md'), 'junction')
    } else symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'))
    put('.env', 'SECRET=1')
    put('.git/config', 'x')
    put('node_modules/a/index.js', 'x')
    const notes: string[] = []
    const b = await readSkillFolder(dir, { notes })
    expect(b.files.map((f) => f.relPath)).toEqual(['SKILL.md', 'real.md'])
    expect(b.files.map((f) => f.relPath)).not.toContain('link.md')
    expect(notes.some((n) => n.includes('link.md') && n.includes('link'))).toBe(true)
    expect(notes.some((n) => n.includes('.env'))).toBe(true)
    expect(notes.some((n) => n.includes('node_modules'))).toBe(true)
  })

  it('refuses a missing SKILL.md', async () => {
    put('README.md', 'x')
    expect((await usageError(readSkillFolder(dir))).message).toContain('no SKILL.md')
  })

  it('refuses a missing folder or a file', async () => {
    await usageError(readSkillFolder(join(dir, 'nope')))
    put('f.md', 'x')
    await usageError(readSkillFolder(join(dir, 'f.md')))
  })

  it('refuses more than 50 files', async () => {
    put('SKILL.md', SKILL_MD)
    for (let i = 0; i < 50; i++) put(`f${String(i).padStart(2, '0')}.md`, 'x')
    expect((await usageError(readSkillFolder(dir))).message).toContain('more than 50 files')
  })

  it('refuses an oversize file (resource over 64 KB, SKILL.md over 256 KB)', async () => {
    put('SKILL.md', SKILL_MD)
    put('big.md', Buffer.alloc(64 * 1024 + 1, 'a'))
    expect((await usageError(readSkillFolder(dir))).message).toContain('big.md')
    rmSync(join(dir, 'big.md'))
    put('SKILL.md', Buffer.alloc(256 * 1024 + 1, 'a'))
    expect((await usageError(readSkillFolder(dir))).message).toContain('SKILL.md')
  })

  it('refuses a total over 1 MB', async () => {
    put('SKILL.md', SKILL_MD)
    for (let i = 0; i < 17; i++) put(`f${i}.md`, Buffer.alloc(64 * 1024, 'a'))
    expect((await usageError(readSkillFolder(dir))).message).toContain('1 MB')
  })

  // Windows cannot create these files (CON.txt is the console device, a:b.md an alternate data stream, a control
  // character is an invalid name), so there is nothing on disk for the walker to see there; the 'segmentProblem'
  // test below checks the same names on every platform.
  it.skipIf(process.platform === 'win32')('refuses a reserved name, a colon and a control character, naming the file', async () => {
    put('SKILL.md', SKILL_MD)
    put('CON.txt', 'x')
    expect((await usageError(readSkillFolder(dir))).message).toContain('CON.txt')
    rmSync(join(dir, 'CON.txt'))
    put('a:b.md', 'x')
    expect((await usageError(readSkillFolder(dir))).message).toContain("':'")
    rmSync(join(dir, 'a:b.md'))
    put('bad\u0007.md', 'x')
    expect((await usageError(readSkillFolder(dir))).message).toContain('control or hidden')
  })

  it('segmentProblem', () => {
    expect(segmentProblem('ok.md')).toBeNull()
    expect(segmentProblem('nul')).toMatch(/reserved/)
    expect(segmentProblem('lpt1.txt')).toMatch(/reserved/)
    expect(segmentProblem('a‮b')).toMatch(/hidden/)
    expect(segmentProblem('x.')).toMatch(/dot/)
    expect(segmentProblem('CON.txt')).toMatch(/reserved/)
    expect(segmentProblem('a:b.md')).toContain("':'")
    expect(segmentProblem('bad\u0007.md')).toContain('control or hidden')
  })
})
