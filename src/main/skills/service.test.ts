import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_MAX_PER_PROJECT } from '@shared/types'
import type { Project, SkillLibraryInfo, SkillProposalItem, SkillsProposalPayload } from '@shared/types'
import { project } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SkillService } from './service'

const FIXTURE = join(__dirname, 'fixtures', 'pdf')
const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skills-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const draft = (name: string, body = 'Do the thing.') => ({ name, description: `Use for ${name}.`, body })

let dataDir: string
let repo: string
let store: ProjectStore
let svc: SkillService
let libEvents: SkillLibraryInfo[][]
let changed: Project[]

function build(): void {
  svc = new SkillService({ dataDir, projects: store, onLibraryChanged: (e) => libEvents.push(e), onProjectChanged: (p) => changed.push(p) })
}
beforeEach(() => {
  dataDir = temp()
  repo = temp()
  store = new ProjectStore(dataDir)
  store.save(project({ path: repo }))
  libEvents = []
  changed = []
  build()
})

function put(rel: string, text: string): void {
  const abs = join(repo, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}
const skillMd = (name: string, extra = '') => `---\nname: ${name}\ndescription: Use for ${name}.\n---\nBody ${name}${extra}`
const projFile = (pid: string, sid: string, rel = 'SKILL.md') => join(dataDir, 'project-skills', pid, sid, rel)

describe('project skills', () => {
  it('creates, lists, reads and grants', () => {
    const r = svc.create({ projectId: 'p1', draft: draft('review-code'), roleIds: ['r-eng'] })
    const info = r.skills[0]
    expect(info.spec).toMatchObject({ name: 'review-code', enabled: true, source: 'user' })
    expect(info.spec.files.map((f) => f.path)).toEqual(['SKILL.md'])
    expect(info.grantedTo).toEqual(['r-eng'])
    expect(r.project.roles.find((x) => x.id === 'r-eng')?.skills).toEqual([info.spec.id])
    expect(store.get('p1')?.skills).toHaveLength(1)
    const text = readFileSync(projFile('p1', info.spec.id), 'utf8')
    expect(text).toContain('name: review-code')
    const c = svc.read({ projectId: 'p1', skillId: info.spec.id })
    expect(c.body).toBe('Do the thing.')
    expect(c.skillMd).toBe(text)
    expect(svc.list('p1')).toHaveLength(1)
  })

  it('refuses bad drafts, duplicate names, unknown roles and unknown projects', () => {
    svc.create({ projectId: 'p1', draft: draft('one') })
    expect(() => svc.create({ projectId: 'p1', draft: draft('one') })).toThrow(/already has a skill named "one"/)
    expect(() => svc.create({ projectId: 'p1', draft: draft('Bad') })).toThrow(/lowercase/)
    expect(() => svc.create({ projectId: 'p1', draft: { ...draft('two'), description: 'a<b' } })).toThrow(/< or >/)
    expect(() => svc.create({ projectId: 'p1', draft: draft('three'), roleIds: ['ghost'] })).toThrow(/Unknown role: ghost/)
    expect(svc.list('p1')).toHaveLength(1)
    expect(() => svc.create({ projectId: 'nope', draft: draft('x') })).toThrow(/Project not found/)
    expect(() => svc.create({ projectId: '../x', draft: draft('x') })).toThrow(/Project not found/)
  })

  it('caps skills per project', () => {
    for (let i = 0; i < 100; i++) svc.create({ projectId: 'p1', draft: draft(`s${i}`) })
    expect(() => svc.create({ projectId: 'p1', draft: draft('extra') })).toThrow(/at most 100/)
  })

  it('updates the draft keeping resource files, and replaces the granted set', () => {
    const id = svc.create({ projectId: 'p1', draft: draft('one'), roleIds: ['r-eng', 'r-rev'] }).skills[0].spec.id
    writeFileSync(projFile('p1', id, 'extra.txt'), 'resource')
    const r = svc.update({ projectId: 'p1', skillId: id, draft: draft('renamed', 'New body'), roleIds: ['r-lead', 'r-eng'], enabled: false })
    expect(r.skills[0].spec).toMatchObject({ name: 'renamed', enabled: false })
    expect(r.skills[0].grantedTo.sort()).toEqual(['r-eng', 'r-lead'])
    expect(r.rolesUpdated).toEqual([{ roleId: 'r-rev', roleName: 'Reviewer' }])
    expect(existsSync(projFile('p1', id, 'extra.txt'))).toBe(true)
    expect(svc.read({ projectId: 'p1', skillId: id }).body).toBe('New body')
    expect(svc.read({ projectId: 'p1', skillId: id }).files.map((f) => f.path)).toEqual(['SKILL.md', 'extra.txt'])
    expect(r.skills[0].spec.digest).not.toBe(svc.create({ projectId: 'p1', draft: draft('zz') }).skills[1].spec.digest)
  })

  it('refuses a rename onto another skill and unknown ids', () => {
    svc.create({ projectId: 'p1', draft: draft('one') })
    const id = svc.create({ projectId: 'p1', draft: draft('two') }).skills[1].spec.id
    expect(() => svc.update({ projectId: 'p1', skillId: id, draft: draft('one') })).toThrow(/already has/)
    expect(() => svc.update({ projectId: 'p1', skillId: 'ghost' })).toThrow(/Skill not found/)
  })

  it('removes files and drops the grant from every role', () => {
    const id = svc.create({ projectId: 'p1', draft: draft('one'), roleIds: ['r-eng', 'r-rev'] }).skills[0].spec.id
    const r = svc.remove({ projectId: 'p1', skillId: id })
    expect(r.skills).toEqual([])
    expect(r.rolesUpdated?.map((x) => x.roleId).sort()).toEqual(['r-eng', 'r-rev'])
    expect(store.get('p1')?.roles.every((x) => !x.skills?.includes(id))).toBe(true)
    expect(existsSync(projFile('p1', id))).toBe(false)
  })

  it('removeProjectFiles deletes the project folder', () => {
    const id = svc.create({ projectId: 'p1', draft: draft('one') }).skills[0].spec.id
    svc.removeProjectFiles('p1')
    expect(existsSync(projFile('p1', id))).toBe(false)
    svc.removeProjectFiles('../..')
  })
})

describe('library', () => {
  it('creates, lists, reads, updates and notifies', () => {
    const list = svc.libraryCreate(draft('shared'))
    expect(list).toHaveLength(1)
    expect(libEvents).toHaveLength(1)
    const id = list[0].entry.id
    expect(existsSync(join(dataDir, 'skills', id, 'SKILL.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'skill-library.json'), 'utf8'))).toMatchObject({ version: 1 })
    expect(() => svc.libraryCreate(draft('shared'))).toThrow(/already has a skill named/)
    expect(svc.libraryRead({ libraryId: id }).body).toBe('Do the thing.')
    const up = svc.libraryUpdate({ libraryId: id, draft: draft('shared', 'Changed') })
    expect(up[0].entry.digest).not.toBe(list[0].entry.digest)
    expect(svc.libraryRead({ libraryId: id }).body).toBe('Changed')
    expect(libEvents).toHaveLength(2)
    expect(() => svc.libraryRead({ libraryId: 'ghost' })).toThrow(/not found/)
  })

  it('adds from a folder and refuses bad ones', () => {
    const list = svc.libraryAddFromFolder({ path: FIXTURE })
    expect(list[0].entry).toMatchObject({ name: 'pdf', source: 'user' })
    expect(list[0].entry.files.map((f) => f.path)).toEqual(['SKILL.md', 'reference.md', 'scripts/fill.py'])
    expect(() => svc.libraryAddFromFolder({ path: FIXTURE })).toThrow(/already has/)
    expect(() => svc.libraryAddFromFolder({ path: 'relative' })).toThrow(/full path/)
    expect(() => svc.libraryAddFromFolder({ path: temp() })).toThrow(/SKILL\.md/)
  })

  it('links a library skill: snapshot refreshed on read, grants, duplicate and name checks', () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    const r = svc.linkLibrary({ projectId: 'p1', libraryId: lib.id, roleIds: ['r-eng'] })
    const spec = r.skills[0].spec
    expect(spec).toMatchObject({ name: 'shared', source: 'library', libraryId: lib.id, enabled: true })
    expect(r.skills[0].grantedTo).toEqual(['r-eng'])
    expect(existsSync(projFile('p1', spec.id))).toBe(false)
    expect(() => svc.linkLibrary({ projectId: 'p1', libraryId: lib.id })).toThrow(/already linked/)
    expect(() => svc.linkLibrary({ projectId: 'p1', libraryId: 'ghost' })).toThrow(/not found/)
    svc.libraryUpdate({ libraryId: lib.id, draft: draft('shared', 'v2') })
    expect(changed.at(-1)?.skills?.[0].digest).not.toBe(spec.digest)
    expect(svc.list('p1')[0].spec.digest).not.toBe(spec.digest)
    expect(svc.read({ projectId: 'p1', skillId: spec.id }).body).toBe('v2')
    // A linked skill takes enabled and roleIds only.
    expect(() => svc.update({ projectId: 'p1', skillId: spec.id, draft: draft('shared') })).toThrow(/Edit it in the skill library/)
    const u = svc.update({ projectId: 'p1', skillId: spec.id, enabled: false, roleIds: [] })
    expect(u.skills[0].spec.enabled).toBe(false)
    expect(u.rolesUpdated).toEqual([{ roleId: 'r-eng', roleName: 'Engineer' }])
    // A project skill with the same name blocks a link.
    svc.create({ projectId: 'p1', draft: draft('other') })
    const other = svc.libraryCreate(draft('other'))[1].entry
    expect(() => svc.linkLibrary({ projectId: 'p1', libraryId: other.id })).toThrow(/already has a skill named "other"/)
  })

  it('removing a link keeps the library files', () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    const sid = svc.linkLibrary({ projectId: 'p1', libraryId: lib.id, roleIds: ['r-eng'] }).skills[0].spec.id
    const r = svc.remove({ projectId: 'p1', skillId: sid })
    expect(r.rolesUpdated).toHaveLength(1)
    expect(existsSync(join(dataDir, 'skills', lib.id, 'SKILL.md'))).toBe(true)
  })

  it('usedBy lists projects and the roles holding a grant', () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    svc.linkLibrary({ projectId: 'p1', libraryId: lib.id, roleIds: ['r-eng', 'r-rev'] })
    const used = svc.libraryList()[0].usedBy
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ projectId: 'p1', projectName: 'Test project' })
    expect(used[0].roleNames.sort()).toEqual(['Engineer', 'Reviewer'])
  })

  it('removing an entry unlinks every project and drops the grants', () => {
    store.save(project({ id: 'p2', path: repo }))
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    svc.linkLibrary({ projectId: 'p1', libraryId: lib.id, roleIds: ['r-eng'] })
    const sid2 = svc.linkLibrary({ projectId: 'p2', libraryId: lib.id, roleIds: ['r-lead'] }).skills[0].spec.id
    changed = []
    const out = svc.libraryRemove({ libraryId: lib.id })
    expect(out).toEqual([])
    expect(existsSync(join(dataDir, 'skills', lib.id))).toBe(false)
    for (const id of ['p1', 'p2']) {
      expect(store.get(id)?.skills).toEqual([])
      expect(store.get(id)?.roles.every((r) => !r.skills?.length)).toBe(true)
    }
    expect(changed.map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(libEvents.at(-1)).toEqual([])
    expect(sid2).toBeTruthy()
  })

  it('refuses a library rename onto a name a linking project already uses', () => {
    svc.create({ projectId: 'p1', draft: draft('taken') })
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    svc.linkLibrary({ projectId: 'p1', libraryId: lib.id })
    expect(() => svc.libraryUpdate({ libraryId: lib.id, draft: draft('taken') })).toThrow(/already has a skill named "taken"/)
  })

  it('promotes a project skill, keeping its id and grants, and refuses a duplicate library name', () => {
    const id = svc.create({ projectId: 'p1', draft: draft('mine'), roleIds: ['r-eng'] }).skills[0].spec.id
    writeFileSync(projFile('p1', id, 'extra.txt'), 'resource')
    const r = svc.promote({ projectId: 'p1', skillId: id })
    expect(r.skills[0].spec).toMatchObject({ id, source: 'library' })
    expect(r.skills[0].grantedTo).toEqual(['r-eng'])
    const entry = svc.libraryList()[0].entry
    expect(r.skills[0].spec.libraryId).toBe(entry.id)
    expect(readFileSync(join(dataDir, 'skills', entry.id, 'extra.txt'), 'utf8')).toBe('resource')
    expect(existsSync(projFile('p1', id))).toBe(false)
    expect(libEvents.length).toBeGreaterThan(0)
    expect(() => svc.promote({ projectId: 'p1', skillId: id })).toThrow(/already part/)
    store.save(project({ id: 'p2', path: repo }))
    svc.create({ projectId: 'p2', draft: draft('mine') })
    const id2 = svc.list('p2')[0].spec.id
    expect(() => svc.promote({ projectId: 'p2', skillId: id2 })).toThrow(/already has a skill named "mine"/)
    expect(existsSync(projFile('p2', id2))).toBe(true)
  })

  it('persists across a new service instance', () => {
    svc.libraryCreate(draft('shared'))
    build()
    expect(svc.libraryList()).toHaveLength(1)
  })
})

describe('forRun / withLibrary', () => {
  it('returns enabled, granted skills with absolute dirs and only the given roles', () => {
    const a = svc.create({ projectId: 'p1', draft: draft('a'), roleIds: ['r-eng', 'r-rev'] }).skills[0].spec.id
    svc.create({ projectId: 'p1', draft: draft('ungranted') })
    const off = svc.create({ projectId: 'p1', draft: draft('off'), roleIds: ['r-eng'] }).skills[2].spec.id
    svc.update({ projectId: 'p1', skillId: off, enabled: false })
    const p = store.get('p1') as Project
    const eng = p.roles.filter((r) => r.id === 'r-eng')
    const out = svc.forRun(p, eng)
    expect(out.map((s) => s.id)).toEqual([a])
    expect(out[0].roleIds).toEqual(['r-eng'])
    expect(out[0].dir).toBe(join(dataDir, 'project-skills', 'p1', a))
    expect(out[0].files[0].path).toBe('SKILL.md')
    expect(svc.forRun(p, [])).toEqual([])
  })

  it('keeps a link whose entry is gone (libraryMissing) but never runs it', () => {
    const lib = svc.libraryCreate(draft('shared'))[0].entry
    const sid = svc.linkLibrary({ projectId: 'p1', libraryId: lib.id, roleIds: ['r-eng'] }).skills[0].spec.id
    // The entry disappears behind the service's back (library index edited).
    rmSync(join(dataDir, 'skill-library.json'))
    build()
    const info = svc.list('p1')[0]
    expect(info.libraryMissing).toBe(true)
    expect(info.spec.id).toBe(sid)
    const p = store.get('p1') as Project
    expect(svc.forRun(p, p.roles)).toEqual([])
    expect(svc.withLibrary(p).skills?.[0].enabled).toBe(false)
    expect(() => svc.read({ projectId: 'p1', skillId: sid })).toThrow(/removed from the skill library/)
  })

  it('never throws', () => {
    const bad = project({ skills: [{ id: '../x', name: 'x' } as never], roles: [{ id: 'r', skills: ['../x'] } as never] })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(svc.forRun(bad, bad.roles)).toEqual([])
    spy.mockRestore()
  })

  it('leaves out a skill whose files are gone', () => {
    const id = svc.create({ projectId: 'p1', draft: draft('a'), roleIds: ['r-eng'] }).skills[0].spec.id
    rmSync(join(dataDir, 'project-skills', 'p1', id), { recursive: true })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = store.get('p1') as Project
    expect(svc.forRun(p, p.roles)).toEqual([])
    spy.mockRestore()
  })
})

describe('repo import', () => {
  const preview = () => svc.previewImport({ projectId: 'p1' })

  it('previews items with default actions and saves nothing', () => {
    cpSync(FIXTURE, join(repo, '.claude', 'skills', 'pdf'), { recursive: true })
    put('.agents/skills/pdf/SKILL.md', skillMd('pdf'))
    put('.github/skills/broken/SKILL.md', 'nothing')
    const p = preview()
    expect(p.roots).toEqual(['.claude/skills', '.agents/skills', '.github/skills'])
    expect(p.items.map((i) => [i.key, i.action])).toEqual([
      ['.claude/skills/pdf', 'add'],
      ['.agents/skills/pdf', 'skip']
    ])
    expect(p.items[1].duplicateOf).toBe('.claude/skills/pdf')
    expect(p.items[0].scripts).toEqual(['scripts/fill.py'])
    expect(p.items[0].body).toContain('Run `scripts/fill.py`')
    expect(p.invalid).toHaveLength(1)
    expect(store.get('p1')?.skills).toBeUndefined()
  })

  it('requires a digest and refuses a stale one', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    const p = preview()
    expect(() => svc.applyImport({ projectId: 'p1', digest: '' })).toThrow(/digest is required/)
    expect(() => svc.applyImport({ projectId: 'p1' } as never)).toThrow(/digest is required/)
    put('.claude/skills/a/SKILL.md', skillMd('a', ' changed'))
    expect(() => svc.applyImport({ projectId: 'p1', digest: p.digest })).toThrow('The skills folder changed since the preview; refresh it.')
    expect(store.get('p1')?.skills).toBeUndefined()
  })

  it('applies a snapshot copy, grants roles and never writes the repo', () => {
    cpSync(FIXTURE, join(repo, '.claude', 'skills', 'pdf'), { recursive: true })
    const before = readdirSync(join(repo, '.claude', 'skills', 'pdf'))
    const p = preview()
    const r = svc.applyImport({ projectId: 'p1', digest: p.digest, choices: [{ key: '.claude/skills/pdf', include: true, roleIds: ['r-eng'] }] })
    expect(r.added).toHaveLength(1)
    expect(r.updated).toEqual([])
    expect(r.undoId).toBeTruthy()
    const spec = r.skills[0].spec
    expect(spec).toMatchObject({ name: 'pdf', source: 'repo', repoPath: '.claude/skills/pdf', enabled: true })
    expect(spec.digest).toBe(p.items[0].digest)
    expect(r.skills[0].grantedTo).toEqual(['r-eng'])
    expect(readFileSync(projFile('p1', spec.id, 'scripts/fill.py'), 'utf8')).toContain('fill')
    expect(readdirSync(join(repo, '.claude', 'skills', 'pdf'))).toEqual(before)
    // A second preview sees it unchanged.
    expect(preview().items[0]).toMatchObject({ action: 'unchanged', existingSkillId: spec.id })
  })

  it('include false leaves a skill out; unknown keys and roles are refused', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    put('.claude/skills/b/SKILL.md', skillMd('b'))
    const p = preview()
    expect(() => svc.previewImport({ projectId: 'p1', choices: [{ key: 'nope', include: true }] })).toThrow(/Unknown skill/)
    expect(() => svc.previewImport({ projectId: 'p1', choices: [{ key: '.claude/skills/a', include: true, roleIds: ['ghost'] }] })).toThrow(/Unknown role/)
    expect(() => svc.previewImport({ projectId: 'p1', choices: Array.from({ length: 201 }, () => ({ key: '.claude/skills/a', include: true })) })).toThrow(/At most 200/)
    const r = svc.applyImport({ projectId: 'p1', digest: p.digest, choices: [{ key: '.claude/skills/b', include: false }] })
    expect(r.skills.map((s) => s.spec.name)).toEqual(['a'])
  })

  it('updates a changed skill keeping its grants, and flags name conflicts', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    const first = svc.applyImport({ projectId: 'p1', digest: preview().digest, choices: [{ key: '.claude/skills/a', include: true, roleIds: ['r-eng'] }] })
    const id = first.added[0]
    put('.claude/skills/a/SKILL.md', skillMd('a', ' v2'))
    const p = preview()
    expect(p.items[0]).toMatchObject({ action: 'update', existingSkillId: id })
    const r = svc.applyImport({ projectId: 'p1', digest: p.digest })
    expect(r.updated).toEqual([id])
    expect(r.skills[0].grantedTo).toEqual(['r-eng'])
    expect(r.skills[0].spec.digest).not.toBe(first.skills[0].spec.digest)
    expect(svc.read({ projectId: 'p1', skillId: id }).body).toContain('v2')
    // A user skill with the same name blocks a new import.
    svc.create({ projectId: 'p1', draft: draft('c') })
    put('.claude/skills/c/SKILL.md', skillMd('c'))
    const item = preview().items.find((i) => i.key === '.claude/skills/c')
    expect(item).toMatchObject({ action: 'skip', nameConflict: true })
  })

  it('undo restores files, skills and grants; it expires on the next mutation', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    const first = svc.applyImport({ projectId: 'p1', digest: preview().digest, choices: [{ key: '.claude/skills/a', include: true, roleIds: ['r-eng'] }] })
    const aId = first.added[0]
    expect(() => svc.undoImport({ projectId: 'p1', undoId: 'ghost' })).toThrow('Nothing to undo')
    // Second apply: update a (grant r-rev too) and add b.
    put('.claude/skills/a/SKILL.md', skillMd('a', ' v2'))
    put('.claude/skills/b/SKILL.md', skillMd('b'))
    const before = svc.read({ projectId: 'p1', skillId: aId }).skillMd
    const second = svc.applyImport({
      projectId: 'p1',
      digest: preview().digest,
      choices: [
        { key: '.claude/skills/a', include: true, roleIds: ['r-eng', 'r-rev'] },
        { key: '.claude/skills/b', include: true, roleIds: ['r-lead'] }
      ]
    })
    expect(second.skills).toHaveLength(2)
    // The first undo id expired when the second apply started.
    expect(() => svc.undoImport({ projectId: 'p1', undoId: first.undoId })).toThrow('Nothing to undo')
    const undone = svc.undoImport({ projectId: 'p1', undoId: second.undoId })
    expect(undone.skills.map((s) => s.spec.id)).toEqual([aId])
    expect(undone.skills[0].grantedTo).toEqual(['r-eng'])
    expect(svc.read({ projectId: 'p1', skillId: aId }).skillMd).toBe(before)
    expect(existsSync(projFile('p1', second.added[0]))).toBe(false)
    expect(store.get('p1')?.roles.find((r) => r.id === 'r-lead')?.skills ?? []).toEqual([])
    expect(existsSync(join(dataDir, 'project-skills', 'p1', '.undo', second.undoId))).toBe(false)
    expect(() => svc.undoImport({ projectId: 'p1', undoId: second.undoId })).toThrow('Nothing to undo')
  })

  it('a skill mutation expires the undo', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    const r = svc.applyImport({ projectId: 'p1', digest: preview().digest })
    svc.create({ projectId: 'p1', draft: draft('other') })
    expect(() => svc.undoImport({ projectId: 'p1', undoId: r.undoId })).toThrow('Nothing to undo')
    expect(existsSync(join(dataDir, 'project-skills', 'p1', '.undo'))).toBe(false)
  })

  it('clears stale backups at construction', () => {
    mkdirSync(join(dataDir, 'project-skills', 'p1', '.undo', 'old'), { recursive: true })
    build()
    expect(existsSync(join(dataDir, 'project-skills', 'p1', '.undo'))).toBe(false)
  })

  it('refuses when there is nothing to import', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    svc.applyImport({ projectId: 'p1', digest: preview().digest })
    expect(() => svc.applyImport({ projectId: 'p1', digest: preview().digest })).toThrow(/Nothing to import/)
  })

  it('re-reads the stored project path, not one the caller sends', () => {
    put('.claude/skills/a/SKILL.md', skillMd('a'))
    const p = svc.previewImport({ projectId: 'p1', path: '/etc' } as never)
    expect(p.items).toHaveLength(1)
  })
})

describe('applyProposal', () => {
  const item = (over: Partial<SkillProposalItem> = {}): SkillProposalItem => ({ action: 'create', scope: 'library', draft: draft('lib-skill'), ...over })
  const payload = (...items: SkillProposalItem[]): SkillsProposalPayload => ({ rationale: 'r', items })

  it('library session: creates and updates library entries, returns null', () => {
    expect(svc.applyProposal(null, payload(item()))).toBeNull()
    const entry = svc.libraryList()[0].entry
    expect(entry.name).toBe('lib-skill')
    expect(libEvents.length).toBeGreaterThan(0)
    expect(svc.applyProposal(null, payload(item({ action: 'update', libraryId: entry.id, draft: draft('lib-skill', 'Better.') })))).toBeNull()
    expect(svc.libraryRead({ libraryId: entry.id }).body).toBe('Better.')
  })

  it('library session refuses project items and writes nothing when any item fails', () => {
    expect(() => svc.applyProposal(null, payload(item(), item({ scope: 'project', draft: draft('p-skill') })))).toThrow(/only scope "library"/)
    expect(svc.libraryList()).toEqual([])
    expect(() => svc.applyProposal(null, payload(item({ draft: draft('good') }), item({ draft: draft('Bad Name') })))).toThrow(/lowercase/)
    expect(svc.libraryList()).toEqual([])
    expect(() => svc.applyProposal(null, payload(item({ draft: draft('x', 'run !`ls` now') })))).toThrow(/shell/i)
    expect(() => svc.applyProposal(null, { rationale: 'r', items: [] })).toThrow(/no items/)
  })

  it('project session: creates with role slugs, updates by name, mixes library items, returns the project', () => {
    const saved = svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('review-code'), roles: ['engineer'] }), item({ draft: draft('shared') })))
    expect(saved?.id).toBe('p1')
    expect(saved?.skills?.map((s) => s.name)).toEqual(['review-code'])
    const id = saved!.skills![0].id
    expect(saved?.roles.find((r) => r.slug === 'engineer')?.skills).toEqual([id])
    expect(svc.libraryList().map((l) => l.entry.name)).toEqual(['shared'])
    const upd = svc.applyProposal('p1', payload(item({ action: 'update', scope: 'project', draft: draft('review-code', 'v2'), roles: ['reviewer'] })))
    expect(svc.read({ projectId: 'p1', skillId: id }).body).toBe('v2')
    expect(upd?.roles.find((r) => r.slug === 'reviewer')?.skills).toEqual([id])
    expect(upd?.roles.find((r) => r.slug === 'engineer')?.skills ?? []).toEqual([])
    // roles omitted: grants stay
    const kept = svc.applyProposal('p1', payload(item({ action: 'update', scope: 'project', draft: draft('review-code', 'v3') })))
    expect(kept?.roles.find((r) => r.slug === 'reviewer')?.skills).toEqual([id])
  })

  describe('configuration actions', () => {
    const cfg = (over: Partial<SkillProposalItem>): SkillProposalItem => ({ action: 'grant', scope: 'project', draft: draft('ignored', ''), ...over })
    const skillNamed = (name: string) => store.get('p1')?.skills?.find((s) => s.name === name)
    const grantsOf = (slug: string) => store.get('p1')?.roles.find((r) => r.slug === slug)?.skills ?? []

    it('link: links a library entry and grants the named roles', () => {
      svc.libraryCreate(draft('shared'))
      const entry = svc.libraryList()[0].entry
      const saved = svc.applyProposal('p1', payload(cfg({ action: 'link', libraryId: entry.id, draft: draft('shared', ''), roles: ['engineer'] })))
      const s = saved!.skills!.find((x) => x.libraryId === entry.id)!
      expect(s.name).toBe('shared')
      expect(grantsOf('engineer')).toEqual([s.id])
      expect(svc.libraryList()).toHaveLength(1)
    })

    it('grant: roles is the complete list (empty ungrants everyone, omitted keeps), enabled toggles', () => {
      svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('review-code'), roles: ['engineer', 'reviewer'] })))
      const id = skillNamed('review-code')!.id
      svc.applyProposal('p1', payload(cfg({ draft: draft('review-code', ''), roles: ['reviewer'] })))
      expect(grantsOf('engineer')).toEqual([])
      expect(grantsOf('reviewer')).toEqual([id])
      svc.applyProposal('p1', payload(cfg({ draft: draft('review-code', ''), enabled: false })))
      expect(skillNamed('review-code')!.enabled).toBe(false)
      expect(grantsOf('reviewer')).toEqual([id])
      svc.applyProposal('p1', payload(cfg({ draft: draft('review-code', ''), enabled: true, roles: [] })))
      expect(skillNamed('review-code')!.enabled).toBe(true)
      expect(grantsOf('reviewer')).toEqual([])
      expect(svc.read({ projectId: 'p1', skillId: id }).body).toBe('Do the thing.')
    })

    it('remove: drops the project skill and its grants, never the library entry', () => {
      svc.libraryCreate(draft('shared'))
      const entry = svc.libraryList()[0].entry
      svc.linkLibrary({ projectId: 'p1', libraryId: entry.id, roleIds: ['r-eng'] })
      svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('own'), roles: ['engineer'] })))
      svc.applyProposal('p1', payload(cfg({ action: 'remove', draft: draft('shared', '') }), cfg({ action: 'remove', draft: draft('own', '') })))
      expect(store.get('p1')?.skills ?? []).toEqual([])
      expect(grantsOf('engineer')).toEqual([])
      expect(svc.libraryList().map((l) => l.entry.name)).toEqual(['shared'])
    })

    it('a link counts toward the per-project limit', () => {
      svc.libraryCreate(draft('shared'))
      const entry = svc.libraryList()[0].entry
      for (let i = 0; i < SKILL_MAX_PER_PROJECT; i++) svc.create({ projectId: 'p1', draft: draft(`s-${i}`) })
      expect(() => svc.applyProposal('p1', payload(cfg({ action: 'link', libraryId: entry.id, draft: draft('shared', '') })))).toThrow(/at most/)
    })

    it('a failure midway rolls back every config action', () => {
      svc.libraryCreate(draft('shared'))
      const entry = svc.libraryList()[0].entry
      svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('own'), roles: ['engineer'] })))
      const snap = () => JSON.stringify({ ...store.get('p1'), updatedAt: 0 })
      const before = snap()
      const real = svc.remove.bind(svc)
      vi.spyOn(svc, 'remove').mockImplementation((i) => {
        real(i)
        throw new Error('disk full')
      })
      expect(() =>
        svc.applyProposal('p1', payload(cfg({ action: 'link', libraryId: entry.id, draft: draft('shared', ''), roles: ['reviewer'] }), cfg({ action: 'remove', draft: draft('own', '') })))
      ).toThrow(/disk full/)
      expect(snap()).toBe(before)
      expect(svc.libraryList().map((l) => l.entry.name)).toEqual(['shared'])
    })
  })

  it('rolls everything back when a later item fails midway (L7)', () => {
    svc.libraryCreate(draft('keep'))
    const before = JSON.stringify(svc.libraryList().map((l) => l.entry.name))
    const real = svc.libraryCreate.bind(svc)
    let calls = 0
    vi.spyOn(svc, 'libraryCreate').mockImplementation((d) => {
      if (++calls === 2) throw new Error('disk full')
      return real(d)
    })
    expect(() =>
      svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('proj-one'), roles: ['engineer'] }), item({ draft: draft('lib-a') }), item({ draft: draft('lib-b') })))
    ).toThrow(/disk full/)
    expect(JSON.stringify(svc.libraryList().map((l) => l.entry.name))).toBe(before)
    expect(store.get('p1')?.skills ?? []).toEqual([])
    expect(store.get('p1')?.roles.every((r) => !(r.skills ?? []).length)).toBe(true)
    const projDir = join(dataDir, 'project-skills', 'p1')
    expect(existsSync(projDir) ? readdirSync(projDir).filter((n) => n !== '.undo') : []).toEqual([])
  })

  it('refuses unknown role slugs, duplicates, linked updates and unknown libraryIds without writing', () => {
    expect(() => svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('a-skill'), roles: ['ghost'] })))).toThrow(/no role "ghost"/)
    expect(store.get('p1')?.skills ?? []).toEqual([])
    svc.applyProposal('p1', payload(item({ scope: 'project', draft: draft('dup') })))
    expect(() => svc.applyProposal('p1', payload(item({ draft: draft('fresh') }), item({ scope: 'project', draft: draft('dup') })))).toThrow(/already has/)
    expect(svc.libraryList()).toEqual([])
    expect(() => svc.applyProposal('p1', payload(item({ action: 'update', libraryId: 'nope', draft: draft('x') })))).toThrow(/not a library skill/)
    svc.libraryCreate(draft('linked'))
    const entry = svc.libraryList()[0].entry
    svc.linkLibrary({ projectId: 'p1', libraryId: entry.id })
    expect(() => svc.applyProposal('p1', payload(item({ action: 'update', scope: 'project', draft: draft('linked', 'x') })))).toThrow(/linked to the skill library/)
    expect(() => svc.applyProposal('ghost', payload(item()))).toThrow(/Project not found/)
  })

  it('a library update that renames onto a name used by a linking project is refused before any write', () => {
    svc.libraryCreate(draft('shared'))
    const entry = svc.libraryList()[0].entry
    svc.linkLibrary({ projectId: 'p1', libraryId: entry.id })
    svc.create({ projectId: 'p1', draft: draft('taken') })
    expect(() => svc.applyProposal('p1', payload(item({ draft: draft('fresh-one') }), item({ action: 'update', libraryId: entry.id, draft: draft('taken') })))).toThrow(/already has a skill named "taken"/)
    expect(svc.libraryList().map((l) => l.entry.name)).toEqual(['shared'])
  })
})
