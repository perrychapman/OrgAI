import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SKILL_MAX_FILES, SKILL_MAX_FILE_BYTES } from '@shared/types'
import { scanRepoSkills, scanSkillFolder } from './scan'

const FIXTURE = join(__dirname, 'fixtures', 'pdf')
const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skillscan-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function put(repo: string, rel: string, text: string): void {
  const abs = join(repo, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}
const md = (name: string, desc = 'Use for things.') => `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}`

/** A symlink or junction to a directory; null when the OS refuses. */
function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

describe('scanRepoSkills', () => {
  it('finds a skill with resources, lists scripts and digests it', () => {
    const repo = temp()
    cpSync(FIXTURE, join(repo, '.claude', 'skills', 'pdf'), { recursive: true })
    const s = scanRepoSkills(repo)
    expect(s.roots).toEqual(['.claude/skills'])
    expect(s.invalid).toEqual([])
    expect(s.skills).toHaveLength(1)
    const k = s.skills[0]
    expect(k).toMatchObject({ name: 'pdf', repoPath: '.claude/skills/pdf', root: '.claude/skills' })
    expect(k.files.map((f) => f.path)).toEqual(['SKILL.md', 'reference.md', 'scripts/fill.py'])
    expect(k.scripts).toEqual(['scripts/fill.py'])
    expect(k.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(scanRepoSkills(repo).digest).toBe(s.digest)
    writeFileSync(join(repo, '.claude', 'skills', 'pdf', 'reference.md'), 'changed')
    expect(scanRepoSkills(repo).digest).not.toBe(s.digest)
  })

  it('flags a shebang file without a script extension', () => {
    const repo = temp()
    put(repo, '.claude/skills/a/SKILL.md', md('a'))
    put(repo, '.claude/skills/a/run', '#!/bin/sh\necho hi\n')
    expect(scanRepoSkills(repo).skills[0].scripts).toEqual(['run'])
  })

  it('reads every root and sends bad folders to invalid without failing the scan', () => {
    const repo = temp()
    put(repo, '.claude/skills/ok/SKILL.md', md('ok'))
    put(repo, '.agents/skills/ok/SKILL.md', md('ok'))
    put(repo, '.github/skills/Bad/SKILL.md', md('Bad_Name'))
    put(repo, '.opencode/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\n')
    put(repo, '.opencode/skills/empty/README.md', 'not a skill')
    const s = scanRepoSkills(repo)
    expect(s.roots).toEqual(['.claude/skills', '.agents/skills', '.github/skills', '.opencode/skills'])
    expect(s.skills.map((k) => k.repoPath)).toEqual(['.claude/skills/ok', '.agents/skills/ok'])
    expect(s.invalid.map((i) => i.repoPath).sort()).toEqual(['.github/skills/Bad', '.opencode/skills/nodesc'])
    expect(s.invalid[0].reason).toBeTruthy()
  })

  it('reports a folder name that differs from the frontmatter name as a note', () => {
    const repo = temp()
    put(repo, '.claude/skills/folder/SKILL.md', md('other-name'))
    const s = scanRepoSkills(repo)
    expect(s.skills[0].name).toBe('other-name')
    expect(s.skills[0].notes.join(' ')).toMatch(/folder/)
  })

  it('skips symlinked folders and files, and a symlinked root', () => {
    const repo = temp()
    const outside = temp()
    put(outside, 'SKILL.md', md('evil'))
    put(repo, '.claude/skills/real/SKILL.md', md('real'))
    put(repo, '.claude/skills/withlink/SKILL.md', md('withlink'))
    const linked = tryLink(outside, join(repo, '.claude', 'skills', 'linked'))
    const inner = tryLink(outside, join(repo, '.claude', 'skills', 'withlink', 'res'))
    const rootLinked = tryLink(outside, join(repo, '.agents'))
    const s = scanRepoSkills(repo)
    expect(s.skills.map((k) => k.repoPath)).toEqual(['.claude/skills/real'])
    if (linked) expect(s.invalid.find((i) => i.repoPath === '.claude/skills/linked')?.reason).toMatch(/^symlink/)
    if (inner) expect(s.invalid.find((i) => i.repoPath === '.claude/skills/withlink')?.reason).toMatch(/^symlink/)
    if (rootLinked) expect(s.skills.some((k) => k.name === 'evil')).toBe(false)
  })

  it('never reads .git', () => {
    const repo = temp()
    put(repo, '.claude/skills/a/SKILL.md', md('a'))
    put(repo, '.claude/skills/a/.git/config', 'secret')
    put(repo, '.claude/skills/a/.git./x', 'secret')
    const s = scanRepoSkills(repo)
    expect(s.skills[0].files.map((f) => f.path)).toEqual(['SKILL.md'])
    expect(s.skills[0].notes.length).toBeGreaterThan(0)
  })

  it('marks a skill with too many files, a big file or a deep tree invalid', () => {
    const repo = temp()
    put(repo, '.claude/skills/many/SKILL.md', md('many'))
    for (let i = 0; i < SKILL_MAX_FILES; i++) put(repo, `.claude/skills/many/f${i}.txt`, 'x')
    put(repo, '.claude/skills/big/SKILL.md', md('big'))
    writeFileSync(join(repo, '.claude', 'skills', 'big', 'data.bin'), Buffer.alloc(SKILL_MAX_FILE_BYTES + 1))
    put(repo, '.claude/skills/deep/SKILL.md', md('deep'))
    put(repo, '.claude/skills/deep/a/b/c/d/e/f.txt', 'x')
    put(repo, '.claude/skills/fine/SKILL.md', md('fine'))
    const s = scanRepoSkills(repo)
    expect(s.skills.map((k) => k.name)).toEqual(['fine'])
    const why = Object.fromEntries(s.invalid.map((i) => [i.repoPath.split('/').pop(), i.reason]))
    expect(why.many).toMatch(/files/)
    expect(why.big).toMatch(/larger/)
    expect(why.deep).toMatch(/deeper/)
  })

  it('stops at 100 candidates with a warning', () => {
    const repo = temp()
    for (let i = 0; i < 103; i++) put(repo, `.claude/skills/s${String(i).padStart(3, '0')}/SKILL.md`, md(`s${i}`))
    const s = scanRepoSkills(repo)
    expect(s.skills).toHaveLength(100)
    expect(s.warnings.join(' ')).toMatch(/100/)
  })

  it('refuses a relative project path and a missing folder without throwing', () => {
    expect(scanRepoSkills('relative/dir').warnings.length).toBe(1)
    expect(scanRepoSkills(join(temp(), 'nope')).skills).toEqual([])
  })
})

describe('scanSkillFolder', () => {
  it('reads one folder with SKILL.md at its top', () => {
    const r = scanSkillFolder(FIXTURE)
    expect('skill' in r && r.skill.name).toBe('pdf')
  })
  it('reports readable reasons', () => {
    const d = temp()
    expect(scanSkillFolder('rel')).toMatchObject({ invalid: expect.stringMatching(/full path/) })
    expect(scanSkillFolder(join(d, 'missing'))).toMatchObject({ invalid: expect.any(String) })
    expect(scanSkillFolder(d)).toMatchObject({ invalid: expect.stringMatching(/SKILL\.md/) })
    const link = join(d, 'link')
    if (tryLink(FIXTURE, link)) expect(scanSkillFolder(link)).toMatchObject({ invalid: expect.stringMatching(/^symlink/) })
  })
})
