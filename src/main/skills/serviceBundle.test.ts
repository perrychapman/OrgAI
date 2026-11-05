import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SkillBundleInput, SkillLibraryInfo } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SkillService } from './service'

const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skillbundle-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let dataDir: string
let svc: SkillService
let libEvents: SkillLibraryInfo[][]

beforeEach(() => {
  dataDir = temp()
  libEvents = []
  svc = new SkillService({ dataDir, projects: new ProjectStore(dataDir), onLibraryChanged: (e) => libEvents.push(e) })
})

const b64 = (s: string) => Buffer.from(s).toString('base64')
const md = (body: string, extra = '') => `---\nname: bundled\ndescription: Use for bundled work.\n${extra}---\n${body}\n`
const bundle = (skillMd: string, more: { relPath: string; base64: string }[] = []): SkillBundleInput => ({
  name: 'bundled',
  files: [{ relPath: 'SKILL.md', base64: b64(skillMd) }, ...more]
})

/** Every name under the library dir, staging (`.tmp-`) and aside (`.old-`) folders included. */
function libDirNames(): string[] {
  const root = join(dataDir, 'skills')
  return existsSync(root) ? readdirSync(root) : []
}

describe('SkillService.libraryAddFromBundle', () => {
  it('adds an entry whose SKILL.md keeps only name and description', () => {
    const list = svc.libraryAddFromBundle(bundle(md('Do the bundled thing.', 'allowed-tools: Bash\nhooks: x\n'), [{ relPath: 'ref/notes.md', base64: b64('notes') }]))
    expect(list).toHaveLength(1)
    const entry = list[0].entry
    expect(entry).toMatchObject({ name: 'bundled', description: 'Use for bundled work.', source: 'user' })
    expect(entry.files.map((f) => f.path)).toEqual(['SKILL.md', 'ref/notes.md'])
    const stored = readFileSync(join(dataDir, 'skills', entry.id, 'SKILL.md'), 'utf8')
    expect(stored).toContain('name: bundled')
    expect(stored).toContain('description: "Use for bundled work."')
    expect(stored).not.toMatch(/allowed-tools|hooks/)
    expect(readFileSync(join(dataDir, 'skills', entry.id, 'ref', 'notes.md'), 'utf8')).toBe('notes')
    expect(svc.libraryRead({ libraryId: entry.id }).body).toContain('Do the bundled thing.')
    expect(libEvents).toHaveLength(1)
    expect(libDirNames()).toEqual([entry.id])
  })

  it('refuses shell-injection bodies with nothing written', () => {
    for (const body of ['Run !`git status` now', 'a\n```!\nls\n```']) {
      expect(() => svc.libraryAddFromBundle(bundle(md(body)))).toThrow(/Runs shell commands/)
    }
    expect(svc.libraryList()).toEqual([])
    expect(libDirNames()).toEqual([])
    expect(libEvents).toEqual([])
  })

  it('refuses an invalid bundle with nothing written', () => {
    expect(() => svc.libraryAddFromBundle(bundle(md('ok'), [{ relPath: '../x.md', base64: b64('x') }]))).toThrow(/not allowed/)
    expect(() => svc.libraryAddFromBundle({ name: 'bundled', files: [] })).toThrow(/no files/)
    expect(libDirNames()).toEqual([])
  })

  it('refuses a duplicate name and leaves no staging folder', () => {
    const first = svc.libraryAddFromBundle(bundle(md('one')))[0].entry
    expect(() => svc.libraryAddFromBundle(bundle(md('two')))).toThrow(/already has a skill named "bundled"/)
    expect(svc.libraryList().map((i) => i.entry.id)).toEqual([first.id])
    expect(libDirNames()).toEqual([first.id])
    expect(svc.libraryRead({ libraryId: first.id }).body).toContain('one')
  })

  it('uses the bundle name when SKILL.md has none', () => {
    const list = svc.libraryAddFromBundle({ name: 'from-bundle', files: [{ relPath: 'SKILL.md', base64: b64('---\ndescription: Use for it.\n---\nBody\n') }] })
    expect(list[0].entry.name).toBe('from-bundle')
    expect(libDirNames().every((n) => !n.includes('.tmp-') && !n.includes('.old-'))).toBe(true)
  })
})
