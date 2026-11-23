import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_NAME_MAX } from '@shared/types'
import { project } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SkillService } from './service'

const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skilldup-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const draft = (name: string, body = 'Do the thing.') => ({ name, description: `Use for ${name}.`, body })

let dataDir: string
let store: ProjectStore
let svc: SkillService

beforeEach(() => {
  dataDir = temp()
  store = new ProjectStore(dataDir)
  store.save(project({ path: temp() }))
  svc = new SkillService({ dataDir, projects: store })
})

function addFile(pid: string, sid: string, rel: string, text: string): void {
  const abs = join(dataDir, 'project-skills', pid, sid, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

describe('SkillService.duplicate', () => {
  it('copies as "<name> copy" then "copy 2", with files, no grants, source user', () => {
    const made = svc.create({ projectId: 'p1', draft: draft('review'), roleIds: ['r-eng'] })
    const id = made.skills[0].spec.id
    addFile('p1', id, 'ref/notes.md', 'notes')
    const list = svc.duplicate({ projectId: 'p1', skillId: id })
    expect(list.map((s) => s.spec.name)).toEqual(['review', 'review-copy'])
    const copy = list[1]
    expect(copy.spec).toMatchObject({ source: 'user', enabled: true, description: 'Use for review.' })
    expect(copy.spec.libraryId).toBeUndefined()
    expect(copy.spec.id).not.toBe(id)
    expect(copy.grantedTo).toEqual([])
    expect(copy.spec.files.map((f) => f.path).sort()).toEqual(['SKILL.md', 'ref/notes.md'])
    expect(readFileSync(join(dataDir, 'project-skills', 'p1', copy.spec.id, 'ref', 'notes.md'), 'utf8')).toBe('notes')
    expect(svc.read({ projectId: 'p1', skillId: copy.spec.id }).skillMd).toContain('name: review-copy')
    const again = svc.duplicate({ projectId: 'p1', skillId: id })
    expect(again.map((s) => s.spec.name)).toEqual(['review', 'review-copy', 'review-copy-2'])
    expect(store.get('p1')?.roles.find((r) => r.id === 'r-eng')?.skills).toEqual([id])
  })

  it('keeps a disabled original disabled and cuts long names to the limit', () => {
    const long = 'x'.repeat(SKILL_NAME_MAX)
    const id = svc.create({ projectId: 'p1', draft: draft(long) }).skills[0].spec.id
    svc.update({ projectId: 'p1', skillId: id, enabled: false })
    const copy = svc.duplicate({ projectId: 'p1', skillId: id })[1]
    expect(copy.spec.enabled).toBe(false)
    expect(copy.spec.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX)
    expect(copy.spec.name.endsWith('-copy')).toBe(true)
  })

  it('duplicates a linked library skill as a plain project skill', () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    const sid = svc.linkLibrary({ projectId: 'p1', libraryId: lib.id }).skills[0].spec.id
    const copy = svc.duplicate({ projectId: 'p1', skillId: sid })[1]
    expect(copy.spec.name).toBe('shared-copy')
    expect(copy.spec.libraryId).toBeUndefined()
    expect(copy.spec.source).toBe('user')
    expect(existsSync(join(dataDir, 'project-skills', 'p1', copy.spec.id, 'SKILL.md'))).toBe(true)
    expect(svc.libraryList()).toHaveLength(1)
  })

  it('refuses an unknown skill', () => {
    expect(() => svc.duplicate({ projectId: 'p1', skillId: 'ghost' })).toThrow(/not found/)
  })
})

describe('SkillService.exportTo', () => {
  function made(name = 'review-code'): string {
    const id = svc.create({ projectId: 'p1', draft: draft(name) }).skills[0].spec.id
    addFile('p1', id, 'ref/notes.md', 'notes')
    return id
  }

  it('creates a new slug folder with the files and never overwrites', async () => {
    const id = made()
    const dest = temp()
    const first = await svc.exportTo({ projectId: 'p1', skillId: id, destDir: dest })
    expect(first).toBe(join(dest, 'review-code'))
    expect(readFileSync(join(first, 'ref', 'notes.md'), 'utf8')).toBe('notes')
    expect(readFileSync(join(first, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(dataDir, 'project-skills', 'p1', id, 'SKILL.md'), 'utf8'))
    writeFileSync(join(first, 'mine.txt'), 'keep')
    const second = await svc.exportTo({ projectId: 'p1', skillId: id, destDir: dest })
    expect(second).toBe(join(dest, 'review-code-2'))
    expect(readFileSync(join(first, 'mine.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(dest).sort()).toEqual(['review-code', 'review-code-2'])
  })

  it('never names the export folder after a Windows device (con, nul, com1 ...) (security review L7)', async () => {
    const dest = temp()
    for (const name of ['con', 'nul', 'com1']) {
      const skillId = svc.create({ projectId: 'p1', draft: draft(name) }).skills.find((s) => s.spec.name === name)!.spec.id
      const out = await svc.exportTo({ projectId: 'p1', skillId, destDir: dest })
      expect(out).toBe(join(dest, `${name}-skill`))
      expect(existsSync(join(out, 'SKILL.md'))).toBe(true)
    }
  })

  it('refuses a relative, missing or non-directory destination', async () => {
    const id = made()
    const dest = temp()
    const file = join(dest, 'afile')
    writeFileSync(file, 'x')
    await expect(svc.exportTo({ projectId: 'p1', skillId: id, destDir: 'relative/dir' })).rejects.toThrow(/Choose a folder/)
    await expect(svc.exportTo({ projectId: 'p1', skillId: id, destDir: file })).rejects.toThrow(/not a folder/)
    await expect(svc.exportTo({ projectId: 'p1', skillId: id, destDir: join(dest, 'nope') })).rejects.toThrow(/not a folder/)
    expect(readdirSync(dest)).toEqual(['afile'])
  })

  it('does not export a symlinked file (the export refuses and writes nothing)', async () => {
    const id = made()
    const secretDir = temp()
    writeFileSync(join(secretDir, 'secret.txt'), 'secret')
    try {
      symlinkSync(join(secretDir, 'secret.txt'), join(dataDir, 'project-skills', 'p1', id, 'link.txt'), 'file')
    } catch {
      return // symlinks not permitted here (Windows without developer mode)
    }
    const dest = temp()
    await expect(svc.exportTo({ projectId: 'p1', skillId: id, destDir: dest })).rejects.toThrow()
    expect(readdirSync(dest)).toEqual([])
  })

  it('exports a linked library skill', async () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    const sid = svc.linkLibrary({ projectId: 'p1', libraryId: lib.id }).skills[0].spec.id
    const dest = temp()
    const out = await svc.exportTo({ projectId: 'p1', skillId: sid, destDir: dest })
    expect(existsSync(join(out, 'SKILL.md'))).toBe(true)
  })
})
