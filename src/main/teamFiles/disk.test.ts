import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEAM_FILES_MAX_ROLE_BYTES } from '@shared/types'
import { readTeamFolder, removeOrgaiIfEmpty, removeTeamFolderFiles, teamFilesStampOf, writeTeamFiles } from './disk'
import { parseTeamFiles } from './parse'
import { serializeTeam } from './serialize'
import { sampleDoc } from './doc.fixture'

let root: string
let proj: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-disk-'))
  proj = join(root, 'proj')
  outside = join(root, 'outside')
  mkdirSync(proj)
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const dir = process.platform === 'win32' ? 'junction' : 'dir'

/** A link to a folder; undefined (the test notes it and returns) where the OS refuses. */
function linkDir(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, dir)
    return true
  } catch {
    return false
  }
}

/** A link at `at` pointing outside the project: a file symlink, or a junction where the OS has no file symlinks. */
function linkFile(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, 'file')
    return true
  } catch {
    // Windows without the symlink privilege: a junction is a link that lstat reports the same way.
    const folder = `${target}-dir`
    mkdirSync(folder, { recursive: true })
    return linkDir(folder, at)
  }
}

function lay(files: ReturnType<typeof serializeTeam>): void {
  for (const f of files) {
    const abs = join(proj, ...f.path.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, f.data)
  }
}

describe('readTeamFolder', () => {
  it('reads what serializeTeam wrote, in the shape parse expects', () => {
    lay(serializeTeam(sampleDoc()))
    const r = readTeamFolder(proj)
    expect(r.orgaiOk).toBe(true)
    expect(r.readProblems).toEqual([])
    expect(r.agentsDirExists).toBe(true)
    const parsed = parseTeamFiles(r.files, { base: null, agentsDirExists: true })
    expect(parsed.problems).toEqual([])
    expect(parsed.doc?.roles.length).toBe(sampleDoc().roles.length)
  })

  it('a folder without .orgai is fine and empty', () => {
    const r = readTeamFolder(proj)
    expect(r).toMatchObject({ orgaiOk: true, files: [], agentsDirExists: false })
  })

  it('refuses a network or device project path', () => {
    for (const p of ['\\\\server\\share\\x', '\\\\?\\C:\\x', '//host/share/x']) {
      const r = readTeamFolder(p)
      if (process.platform === 'win32' || p.startsWith('//')) expect(r.orgaiOk).toBe(false)
      expect(r.files).toEqual([])
    }
    expect(readTeamFolder('relative/path').orgaiOk).toBe(false)
  })

  it('a symlinked .orgai is refused: nothing is read and nothing is written through it', () => {
    lay(serializeTeam(sampleDoc()))
    rmSync(join(proj, '.orgai'), { recursive: true })
    mkdirSync(join(outside, 'agents'), { recursive: true })
    writeFileSync(join(outside, 'team.json'), '{}')
    writeFileSync(join(outside, 'agents', 'evil.md'), '---\nname: x\n---\nx')
    if (!linkDir(outside, join(proj, '.orgai'))) return
    const r = readTeamFolder(proj)
    expect(r.orgaiOk).toBe(false)
    expect(r.files).toEqual([])
    expect(r.readProblems[0].file).toBe('.orgai')
    const w = writeTeamFiles(proj, serializeTeam(sampleDoc()), [], [])
    expect(w.written).toEqual([])
    expect(readdirSync(outside).sort()).toEqual(['agents', 'team.json'])
    expect(readFileSync(join(outside, 'team.json'), 'utf8')).toBe('{}')
    expect(teamFilesStampOf(proj)).toBe('bad')
  })

  it('a symlinked role file is a problem for that path; the others are read', () => {
    lay(serializeTeam(sampleDoc()))
    const target = join(outside, 'secret.md')
    writeFileSync(target, '---\nname: "Stolen"\n---\nprompt from outside')
    const first = sampleDoc().roles[0].slug
    rmSync(join(proj, '.orgai', 'agents', `${first}.md`))
    if (!linkFile(target, join(proj, '.orgai', 'agents', `${first}.md`))) return
    const r = readTeamFolder(proj)
    expect(r.readProblems.map((p) => p.file)).toContain(`.orgai/agents/${first}.md`)
    expect(r.files.map((f) => f.path)).not.toContain(`.orgai/agents/${first}.md`)
    expect(r.files.length).toBeGreaterThan(2)
    expect(r.files.every((f) => !f.data.toString().includes('prompt from outside'))).toBe(true)
    // The held path is never overwritten or removed.
    const held = [`.orgai/agents/${first}.md`]
    const w = writeTeamFiles(proj, serializeTeam(sampleDoc()), [`.orgai/agents/${first}.md`], held)
    expect(w.written).not.toContain(held[0])
    expect(readFileSync(target, 'utf8')).toContain('prompt from outside')
  })

  it('a symlinked skill folder is a problem for that path and is never entered or removed', () => {
    const doc = sampleDoc()
    lay(serializeTeam(doc))
    const skill = doc.skills[0]
    if (!skill) return
    const folder = join(proj, '.orgai', 'skills', skill.name)
    rmSync(folder, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: x\ndescription: y\n---\nbody')
    if (!linkDir(outside, folder)) return
    const r = readTeamFolder(proj)
    expect(r.readProblems.map((p) => p.file)).toContain(`.orgai/skills/${skill.name}`)
    expect(r.files.some((f) => f.path.startsWith(`.orgai/skills/${skill.name}/`))).toBe(false)
    const w = writeTeamFiles(proj, [], [`.orgai/skills/${skill.name}`], [])
    expect(w.removed).toEqual([])
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true)
  })

  it('a link inside a skill folder makes that skill a problem', () => {
    const doc = sampleDoc()
    lay(serializeTeam(doc))
    const skill = doc.skills[0]
    if (!skill) return
    if (!linkFile(join(outside, 'x.txt'), join(proj, '.orgai', 'skills', skill.name, 'link.txt'))) return
    const r = readTeamFolder(proj)
    expect(r.readProblems.map((p) => p.file)).toContain(`.orgai/skills/${skill.name}`)
    expect(r.readProblems[0].message).toMatch(/link/i)
  })

  it('a role file over the cap is passed on larger than the cap so parse can name it', () => {
    lay(serializeTeam(sampleDoc()))
    const first = sampleDoc().roles[0].slug
    writeFileSync(join(proj, '.orgai', 'agents', `${first}.md`), Buffer.alloc(TEAM_FILES_MAX_ROLE_BYTES + 10, 97))
    const r = readTeamFolder(proj)
    const f = r.files.find((x) => x.path === `.orgai/agents/${first}.md`)!
    expect(f.data.length).toBeGreaterThan(TEAM_FILES_MAX_ROLE_BYTES)
    expect(f.data.length).toBeLessThanOrEqual(TEAM_FILES_MAX_ROLE_BYTES + 1)
    const parsed = parseTeamFiles(r.files, { base: null, agentsDirExists: true })
    expect(parsed.problems.some((p) => p.file === `.orgai/agents/${first}.md`)).toBe(true)
  })
})

describe('teamFilesStampOf', () => {
  it('changes when a file is added, resized or touched, and not otherwise', () => {
    lay(serializeTeam(sampleDoc()))
    const a = teamFilesStampOf(proj)
    expect(teamFilesStampOf(proj)).toBe(a)
    const file = join(proj, '.orgai', 'team.json')
    writeFileSync(file, `${readFileSync(file, 'utf8')} `)
    const b = teamFilesStampOf(proj)
    expect(b).not.toBe(a)
    utimesSync(file, new Date(2020, 1, 1), new Date(2020, 1, 1))
    expect(teamFilesStampOf(proj)).not.toBe(b)
    writeFileSync(join(proj, '.orgai', 'agents', 'extra.md'), 'x')
    expect(teamFilesStampOf(proj)).not.toBe(b)
  })
})

describe('writeTeamFiles', () => {
  it('writes through a temp file, creates .orgai as a plain folder and reports what it wrote', () => {
    const files = serializeTeam(sampleDoc())
    const w = writeTeamFiles(proj, files, [], [])
    expect(w.written.sort()).toEqual(files.map((f) => f.path).sort())
    expect(w.skipped).toEqual([])
    expect(readdirSync(join(proj, '.orgai', 'agents')).some((n) => n.endsWith('.tmp'))).toBe(false)
  })

  it('never touches held paths or anything under or over them', () => {
    const files = serializeTeam(sampleDoc())
    lay(files)
    const first = sampleDoc().roles[0].slug
    const path = `.orgai/agents/${first}.md`
    writeFileSync(join(proj, path), 'conflicted', 'utf8')
    const w = writeTeamFiles(proj, files, [], [path, '.orgai/skills'])
    expect(w.written).not.toContain(path)
    expect(w.written.some((p) => p.startsWith('.orgai/skills/'))).toBe(false)
    expect(readFileSync(join(proj, path), 'utf8')).toBe('conflicted')
  })

  it('refuses to write over a link or a non-file and leaves it alone', () => {
    lay(serializeTeam(sampleDoc()))
    const first = sampleDoc().roles[0].slug
    const target = join(outside, 'victim.md')
    writeFileSync(target, 'victim')
    rmSync(join(proj, '.orgai', 'agents', `${first}.md`))
    if (!linkFile(target, join(proj, '.orgai', 'agents', `${first}.md`))) return
    const w = writeTeamFiles(proj, serializeTeam(sampleDoc()), [], [])
    expect(w.skipped).toContain(`.orgai/agents/${first}.md`)
    expect(readFileSync(target, 'utf8')).toBe('victim')
  })

  it('does not write through a linked subfolder', () => {
    lay(serializeTeam(sampleDoc()))
    rmSync(join(proj, '.orgai', 'agents'), { recursive: true })
    if (!linkDir(outside, join(proj, '.orgai', 'agents'))) return
    const w = writeTeamFiles(proj, serializeTeam(sampleDoc()), [], [])
    expect(w.written.some((p) => p.startsWith('.orgai/agents/'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
  })

  it('rejects unsafe paths', () => {
    const w = writeTeamFiles(proj, [{ path: '.orgai/../evil.txt', data: Buffer.from('x') }, { path: '../evil.txt', data: Buffer.from('x') }, { path: '.orgai/agents/ok.md', data: Buffer.from('x') }], ['.orgai/..', '/etc/passwd'], [])
    expect(w.written).toEqual(['.orgai/agents/ok.md'])
    expect(existsSync(join(root, 'evil.txt'))).toBe(false)
  })

  it('replaces a skill as a unit: stray files of the old version go, removal needs only plain files', () => {
    const doc = sampleDoc()
    const skill = doc.skills[0]
    if (!skill) return
    lay(serializeTeam(doc))
    writeFileSync(join(proj, '.orgai', 'skills', skill.name, 'old-extra.txt'), 'old')
    const w = writeTeamFiles(proj, serializeTeam(doc).filter((f) => f.path.startsWith(`.orgai/skills/${skill.name}/`)), [], [])
    expect(w.removed).toContain(`.orgai/skills/${skill.name}/old-extra.txt`)
    expect(existsSync(join(proj, '.orgai', 'skills', skill.name, 'old-extra.txt'))).toBe(false)
    const r = writeTeamFiles(proj, [], [`.orgai/skills/${skill.name}`], [])
    expect(r.removed).toEqual([`.orgai/skills/${skill.name}`])
  })
})

describe('removal for maintenance', () => {
  it('removes team.json, mcp.json, agents and skills, keeps org.json and cleans an empty .orgai', () => {
    lay(serializeTeam(sampleDoc()))
    writeFileSync(join(proj, '.orgai', 'org.json'), '{}')
    const removed = removeTeamFolderFiles(proj)
    expect(removed).toEqual(expect.arrayContaining(['.orgai/team.json', '.orgai/agents']))
    expect(readdirSync(join(proj, '.orgai'))).toEqual(['org.json'])
    expect(removeOrgaiIfEmpty(proj)).toBe(false)
    rmSync(join(proj, '.orgai', 'org.json'))
    expect(removeOrgaiIfEmpty(proj)).toBe(true)
    expect(existsSync(join(proj, '.orgai'))).toBe(false)
  })

  it('never follows a link: a linked agents folder is unlinked, its target survives', () => {
    lay(serializeTeam(sampleDoc()))
    rmSync(join(proj, '.orgai', 'agents'), { recursive: true })
    writeFileSync(join(outside, 'keep.md'), 'keep')
    if (!linkDir(outside, join(proj, '.orgai', 'agents'))) return
    removeTeamFolderFiles(proj)
    expect(readFileSync(join(outside, 'keep.md'), 'utf8')).toBe('keep')
    expect(existsSync(join(proj, '.orgai', 'agents'))).toBe(false)
  })
})
