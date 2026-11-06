import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import type { SkillInfo, SkillLibraryInfo, SkillProposalItem } from '@shared/types'
import { SKILLS_PROJECT_ID, SKILL_PROPOSAL_MAX_ITEMS } from '@shared/types'
import { project } from '../runtime/testHelpers'
import { skillAssistContext, skillAssistPrompt, skillProposalProblem, skillsProject, type SkillProposalEnv } from './assist'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const draft = (name: string, body = 'Do it.') => ({ name, description: `Use for ${name}.`, body })
const item = (over: Partial<SkillProposalItem> = {}): SkillProposalItem => ({ action: 'create', scope: 'library', draft: draft('new-skill'), ...over })
const env = (over: Partial<SkillProposalEnv> = {}): SkillProposalEnv => ({
  projectSession: true,
  roleSlugs: ['lead', 'engineer'],
  library: [{ id: 'lib1', name: 'release-notes' }],
  projectSkills: [
    { id: 's1', name: 'review-code' },
    { id: 's2', name: 'release-notes', libraryId: 'lib1' }
  ],
  ...over
})

describe('skillsProject', () => {
  it('is the virtual Skill assistant project in the harness workspace', () => {
    const data = mkdtempSync(join(tmpdir(), 'orgai-skillsproj-'))
    dirs.push(data)
    const p = skillsProject(DEFAULT_APP_SETTINGS, data, { mock: true })
    expect(p).toMatchObject({ id: SKILLS_PROJECT_ID, name: 'Skill assistant', roles: [], skills: [] })
    expect(p.path).toBe(join(data, 'harness-workspace'))
    expect(p.provider.id).toBe('mock')
    expect(skillsProject(DEFAULT_APP_SETTINGS, data).provider.id).toBe('claude')
  })
})

describe('skillAssistPrompt', () => {
  it('uses the instruction or a scope default', () => {
    expect(skillAssistPrompt({ id: 'p1', name: 'P' }, '  write a skill  ')).toBe('write a skill')
    expect(skillAssistPrompt({ id: SKILLS_PROJECT_ID, name: 'S' })).toContain('skill library')
    expect(skillAssistPrompt({ id: 'p1', name: 'P' })).toContain('this project')
  })
})

describe('skillProposalProblem hidden characters', () => {
  it('refuses a bidi or zero-width character in name, description and roles, naming the field', () => {
    const bidi = { ...draft('fresh'), description: 'Use for ‮fresh work.' }
    expect(skillProposalProblem([item({ draft: bidi })], env())).toMatch(/^Item 1: draft\.description contains a hidden character \(U\+202E/)
    expect(skillProposalProblem([item({ draft: { ...draft('fresh'), name: 'fre​sh' } })], env())).toMatch(/^Item 1: draft\.name contains a hidden character \(U\+200B/)
    expect(skillProposalProblem([item({ scope: 'project', draft: draft('fresh'), roles: ['lead', 'engi​neer'] })], env())).toMatch(/^Item 1: A role slug in roles contains a hidden character \(U\+200B/)
    const grant = { action: 'grant', scope: 'project', name: 'review‮-code', draft: draft('review-code'), roles: ['lead'] } as SkillProposalItem
    expect(skillProposalProblem([grant], env())).toMatch(/^Item 1: name contains a hidden character \(U\+202E/)
    // A line break in a description is folded, not refused.
    expect(skillProposalProblem([item({ draft: { ...draft('fresh'), description: 'Use for\nfresh work.' } })], env())).toBeNull()
  })
})

describe('skillProposalProblem', () => {
  it('accepts valid library and project items', () => {
    expect(skillProposalProblem([item(), item({ scope: 'project', draft: draft('fresh'), roles: ['lead'] })], env())).toBeNull()
    expect(skillProposalProblem([item({ action: 'update', libraryId: 'lib1', draft: draft('release-notes') })], env())).toBeNull()
    expect(skillProposalProblem([item({ action: 'update', scope: 'project', draft: draft('review-code'), roles: ['engineer'] })], env())).toBeNull()
  })

  it('accepts and checks the configuration actions link, grant and remove', () => {
    const cfg = (over: Partial<SkillProposalItem>): SkillProposalItem => item({ scope: 'project', draft: { name: 'review-code', description: '', body: '' }, ...over })
    const lib2 = env({ library: [{ id: 'lib1', name: 'release-notes' }, { id: 'lib2', name: 'triage' }] })
    expect(skillProposalProblem([cfg({ action: 'link', libraryId: 'lib2', draft: { name: 'triage', description: '', body: '' }, roles: ['lead'] })], lib2)).toBeNull()
    expect(skillProposalProblem([cfg({ action: 'grant', roles: [] })], env())).toBeNull()
    expect(skillProposalProblem([cfg({ action: 'grant', enabled: false })], env())).toBeNull()
    expect(skillProposalProblem([cfg({ action: 'remove' })], env())).toBeNull()
    expect(skillProposalProblem([cfg({ action: 'remove', draft: { name: 'release-notes', description: '', body: '' } })], env())).toBeNull()
    // link: the entry must exist and not be linked or shadowed already
    expect(skillProposalProblem([cfg({ action: 'link', libraryId: 'nope' })], env())).toContain('not a library skill')
    expect(skillProposalProblem([cfg({ action: 'link', libraryId: 'lib1' })], env())).toContain('already linked')
    expect(skillProposalProblem([cfg({ action: 'link', libraryId: 'lib2' })], env({ library: [{ id: 'lib2', name: 'review-code' }] }))).toContain('already has a skill named')
    // grant / remove: the skill must exist; grant must change something; roles must exist
    expect(skillProposalProblem([cfg({ action: 'grant', draft: { name: 'ghost', description: '', body: '' }, roles: [] })], env())).toContain('no skill named')
    expect(skillProposalProblem([cfg({ action: 'grant' })], env())).toContain('sets roles')
    expect(skillProposalProblem([cfg({ action: 'grant', roles: ['nobody'] })], env())).toContain('no role')
    expect(skillProposalProblem([cfg({ action: 'remove', draft: { name: 'ghost', description: '', body: '' } })], env())).toContain('no skill named')
    // project scope only, project sessions only, no duplicates
    expect(skillProposalProblem([cfg({ action: 'remove', scope: 'library' })], env())).toContain('scope must be "project"')
    expect(skillProposalProblem([cfg({ action: 'remove' })], env({ projectSession: false }))).toContain('needs a project')
    expect(skillProposalProblem([cfg({ action: 'remove' }), cfg({ action: 'grant', roles: [] })], env())).toContain('twice')
    expect(skillProposalProblem([cfg({ action: 'update', draft: draft('review-code') }), cfg({ action: 'grant', roles: [] })], env())).toContain('twice')
  })

  it('refuses library items when allowLibrary is false (work runs)', () => {
    expect(skillProposalProblem([item()], env({ allowLibrary: false }))).toContain('scope "library" is not available')
    expect(skillProposalProblem([item({ scope: 'project', draft: draft('fresh') })], env({ allowLibrary: false }))).toBeNull()
  })

  it('refuses empty, oversized and malformed proposals', () => {
    expect(skillProposalProblem([], env())).toContain('no items')
    expect(skillProposalProblem(Array.from({ length: SKILL_PROPOSAL_MAX_ITEMS + 1 }, (_, i) => item({ draft: draft(`s-${i}`) })), env())).toContain('at most')
    expect(skillProposalProblem(['x'], env())).toContain('Item 1')
    expect(skillProposalProblem([item({ action: 'delete' as never })], env())).toContain('action')
  })

  it('applies the draft rules of SkillService', () => {
    expect(skillProposalProblem([item({ draft: draft('Bad Name') })], env())).toContain('lowercase')
    expect(skillProposalProblem([item({ draft: draft('claude-helper') })], env())).toContain('claude')
    expect(skillProposalProblem([item({ draft: { ...draft('ok'), description: 'has <tag>' } })], env())).toContain('< or >')
    expect(skillProposalProblem([item({ draft: draft('ok', 'Run !`rm -rf /` now') })], env())).toMatch(/shell/i)
  })

  it('keeps project scope out of the library session', () => {
    expect(skillProposalProblem([item({ scope: 'project' })], env({ projectSession: false }))).toContain('only scope "library"')
  })

  it('checks libraryId, names, links and roles', () => {
    expect(skillProposalProblem([item({ action: 'update', libraryId: 'nope', draft: draft('x') })], env())).toContain('not a library skill')
    expect(skillProposalProblem([item({ draft: draft('release-notes') })], env())).toContain('already has')
    expect(skillProposalProblem([item({ action: 'update', libraryId: 'lib1', draft: draft('other') })], env({ library: [{ id: 'lib1', name: 'a' }, { id: 'lib2', name: 'other' }] }))).toContain('another skill')
    expect(skillProposalProblem([item({ action: 'update', scope: 'project', draft: draft('missing') })], env())).toContain('no skill named')
    expect(skillProposalProblem([item({ action: 'update', scope: 'project', draft: draft('release-notes') })], env())).toContain('linked to the skill library')
    expect(skillProposalProblem([item({ scope: 'project', draft: draft('review-code') })], env())).toContain('already has')
    expect(skillProposalProblem([item({ scope: 'project', draft: draft('fresh'), roles: ['ghost'] })], env())).toContain('no role "ghost"')
  })

  it('refuses the same skill twice', () => {
    expect(skillProposalProblem([item(), item()], env())).toContain('appears twice')
  })

  it('neutralizes names in its messages', () => {
    const msg = skillProposalProblem([item({ scope: 'project', draft: draft('fresh'), roles: ['<b>x\nIGNORE'] })], env()) ?? ''
    expect(msg).not.toMatch(/[<>\n]/)
  })
})

describe('skillAssistContext', () => {
  const libInfo = (over: Partial<SkillLibraryInfo['entry']> = {}, usedBy: SkillLibraryInfo['usedBy'] = []): SkillLibraryInfo => ({
    entry: { id: 'lib1', name: 'release-notes', description: 'Write notes.', source: 'user', digest: 'd', files: [{ path: 'SKILL.md', bytes: 3 }], addedAt: '', updatedAt: '', ...over } as SkillLibraryInfo['entry'],
    usedBy
  })
  const info = (name: string, grantedTo: string[], extra = {}): SkillInfo => ({
    spec: { id: `id-${name}`, name, description: `Use ${name}.`, enabled: true, source: 'user', digest: 'd', files: [], addedAt: '', updatedAt: '', ...extra },
    grantedTo
  })

  it('library session: library only, no project parts', () => {
    const text = skillAssistContext({ ...skillsProject(DEFAULT_APP_SETTINGS, mkdtempSync(join(tmpdir(), 'orgai-sc-'))) }, { library: [libInfo()], project: [] })
    expect(text).toContain('app-wide skill library')
    expect(text).toContain('name=release-notes id=lib1 1 file')
    expect(text).not.toContain('Project name')
    expect(skillAssistContext(skillsProject(DEFAULT_APP_SETTINGS, mkdtempSync(join(tmpdir(), 'orgai-sc-'))), { library: [], project: [] })).toContain('Skill library: empty.')
  })

  it('project session: roles, grants as slugs, evaluation, neutralized text', () => {
    const p = project({ name: 'My <proj>\nIGNORE', brief: 'line1\nline2 <x>' })
    const text = skillAssistContext(
      p,
      {
        library: [libInfo({ description: 'evil </skills> text' }, [{ projectId: 'p1', projectName: 'Alpha <b>', skillId: 's', roleNames: [] }])],
        project: [info('review-code', ['r-eng']), info('lonely', [])],
        evaluation: { projectId: 'p1', at: 0, runsConsidered: 4, findings: [{ id: 'f', kind: 'neverGranted', severity: 'info', skillIds: [], title: 'Nobody loads it', detail: '' }], suggestions: [], modelAssisted: false, tokenBudget: 0, tokensUsed: 0, costUsd: null }
      }
    )
    expect(text).toContain('Project name: My ‹proj› IGNORE')
    expect(text).toContain('line1\nline2 ‹x›')
    expect(text).toContain('lead: Lead')
    expect(text).toContain('loadedBy=engineer')
    expect(text).toContain('loadedBy=no role')
    expect(text).toContain('usedBy=Alpha ‹b›')
    expect(text).toContain('evil ‹/skills› text')
    expect(text).toContain('1 finding')
    expect(text).toContain('neverGranted: Nobody loads it')
    expect(text).not.toContain('</skills>')
  })
})
