import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostScope, Project, SkillImportPreview, SkillInfo, SkillLibraryInfo, SkillSpec } from '../../shared/types'
import { manageDeps } from '../manage'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, project, rpcError, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT, type CliContext } from '../types'
import { importChoices, loadableByNoRole, roleIdsFor, runSkills, skillsDeps } from './skills'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realManage = { ...manageDeps }
const realSkills = { ...skillsDeps }
afterEach(() => {
  Object.assign(manageDeps, realManage)
  Object.assign(skillsDeps, realSkills)
  resetSkewWarning()
})

const P: Project = project('p1', '/work', {
  name: 'Proj',
  roles: [
    { id: 'r1', slug: 'lead', name: 'Lead' },
    { id: 'r2', slug: 'writer', name: 'Writer' }
  ] as unknown as Project['roles']
})

const spec = (id: string, name: string, extra: Partial<SkillSpec> = {}): SkillSpec => ({
  id,
  name,
  description: `About ${name}`,
  enabled: true,
  source: 'user',
  digest: 'd',
  files: [{ path: 'SKILL.md', bytes: 10 }],
  addedAt: '',
  updatedAt: '',
  ...extra
})

const skills: SkillInfo[] = [
  { spec: spec('s1', 'pdf', { files: [{ path: 'SKILL.md', bytes: 1 }, { path: 'scripts/fill.py', bytes: 2 }] }), grantedTo: ['r1'] },
  { spec: spec('s2', 'evil\u001b[31mred', { description: 'desc \u001b]0;title\u0007' }), grantedTo: [] }
]

const mutation = (): unknown => ({ project: P, skills })

function setup(answers: Record<string, (p: unknown) => unknown> = {}, opts: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [P], 'skills:list': () => skills, ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: '/work', ...opts })
  return { client, ...f }
}

async function run(ctx: CliContext, args: string[]): Promise<{ code: number; message?: string }> {
  try {
    return { code: await runSkills(ctx, args) }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, message: e.message }
    throw e
  }
}

describe('skills list / show', () => {
  it('lists name, description, roles, flags; untrusted text sanitized', async () => {
    const f = setup()
    expect((await run(f.ctx, ['list'])).code).toBe(0)
    const out = f.out()
    expect(out).toContain('pdf')
    expect(out).toContain('Lead')
    expect(out).toContain('Includes scripts')
    expect(out).toContain('No role can load this')
    expect(out).not.toContain('\u001b')
    expect(out).not.toContain('\u0007')
  })

  it('json carries grants and the flags', async () => {
    const f = setup({}, { globals: { outputFormat: 'json' } })
    await run(f.ctx, ['list'])
    const j = JSON.parse(f.out())
    expect(j.schemaVersion).toBe(1)
    expect(j.skills[0]).toMatchObject({ id: 's1', grantedTo: [{ roleId: 'r1', roleName: 'Lead' }], loadableByNoRole: false, scripts: ['scripts/fill.py'] })
    expect(j.skills[1].loadableByNoRole).toBe(true)
  })

  it('show prints SKILL.md sanitized', async () => {
    const f = setup({ 'skills:read': () => ({ skillMd: '---\nname: pdf\n---\nHello \u001b[2Jworld\n', body: 'Hello', files: [{ path: 'SKILL.md', bytes: 5 }] }) })
    expect((await run(f.ctx, ['show', 'PDF'])).code).toBe(0)
    expect(f.client.callsOf('skills:read')).toEqual([[{ projectId: 'p1', skillId: 's1' }]])
    expect(f.out()).toContain('Hello')
    expect(f.out()).not.toContain('\u001b')
  })

  it('an unknown skill is exit 2', async () => {
    const f = setup()
    expect((await run(f.ctx, ['show', 'nope'])).code).toBe(EXIT.usage)
  })

  it('loadableByNoRole', () => {
    expect(loadableByNoRole(skills[0])).toBe(false)
    expect(loadableByNoRole({ ...skills[0], libraryMissing: true })).toBe(true)
    expect(loadableByNoRole({ spec: { ...skills[0].spec, enabled: false }, grantedTo: ['r1'] })).toBe(true)
  })
})

describe('skills create / update grant mapping', () => {
  it('create maps --role slugs to role ids', async () => {
    const f = setup({ 'skills:create': mutation })
    expect((await run(f.ctx, ['create', '--name', 'x', '--description', 'd', '--text', 'body', '--role', 'lead', '--role', 'Writer'])).code).toBe(0)
    expect(f.client.callsOf('skills:create')).toEqual([[{ projectId: 'p1', draft: { name: 'x', description: 'd', body: 'body' }, roleIds: ['r1', 'r2'] }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('create reads --file - from stdin', async () => {
    manageDeps.readStdin = async () => 'from stdin'
    const f = setup({ 'skills:create': mutation })
    await run(f.ctx, ['create', '--name', 'x', '--description', 'd', '--file', '-'])
    expect((f.client.callsOf('skills:create')[0] as [{ draft: { body: string } }])[0].draft.body).toBe('from stdin')
  })

  it('create needs a body and an unknown role is exit 2', async () => {
    expect((await run(setup().ctx, ['create', '--name', 'x', '--description', 'd'])).code).toBe(EXIT.usage)
    const f = setup({ 'skills:create': mutation })
    expect((await run(f.ctx, ['create', '--name', 'x', '--description', 'd', '--text', 'b', '--role', 'ghost'])).code).toBe(EXIT.usage)
    expect(f.client.callsOf('skills:create')).toEqual([])
  })

  it('update replaces roles, keeps the body when only the description changes', async () => {
    const f = setup({ 'skills:update': mutation, 'skills:read': () => ({ skillMd: '', body: 'old body', files: [] }) })
    expect((await run(f.ctx, ['update', 'pdf', '--description', 'new', '--role', 'writer'])).code).toBe(0)
    expect(f.client.callsOf('skills:update')).toEqual([[{ projectId: 'p1', skillId: 's1', draft: { name: 'pdf', description: 'new', body: 'old body' }, roleIds: ['r2'] }]])
  })

  it('update --no-roles and --disable', async () => {
    const f = setup({ 'skills:update': mutation })
    await run(f.ctx, ['update', 's1', '--no-roles', '--disable'])
    expect(f.client.callsOf('skills:update')).toEqual([[{ projectId: 'p1', skillId: 's1', enabled: false, roleIds: [] }]])
  })

  it('roleIdsFor', () => {
    expect(roleIdsFor(P, undefined)).toBeUndefined()
    expect(roleIdsFor(P, ['r2', 'LEAD'])).toEqual(['r2', 'r1'])
  })
})

describe('skills remove', () => {
  it('asks naming the roles, then removes', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), true)
    const f = setup({ 'skills:remove': mutation }, { stdinIsTTY: true })
    f.ctx.io.stdout.isTTY = true
    expect((await run(f.ctx, ['remove', 'pdf'])).code).toBe(0)
    expect(asked[0]).toContain('Lead')
    expect(f.client.callsOf('skills:remove')).toEqual([[{ projectId: 'p1', skillId: 's1' }]])
  })

  it('without a terminal and --yes is exit 2; declined is exit 1', async () => {
    const f = setup({ 'skills:remove': mutation })
    expect((await run(f.ctx, ['remove', 'pdf'])).code).toBe(EXIT.usage)
    manageDeps.ttyConfirm = async () => false
    const g = setup({ 'skills:remove': mutation }, { stdinIsTTY: true })
    g.ctx.io.stdout.isTTY = true
    expect((await run(g.ctx, ['remove', 'pdf'])).code).toBe(1)
    expect(g.client.callsOf('skills:remove')).toEqual([])
  })
})

describe('skills import', () => {
  const item = (key: string, name: string, extra: Partial<SkillImportPreview['items'][number]> = {}): SkillImportPreview['items'][number] => ({
    key,
    root: '.claude/skills',
    repoPath: key,
    name,
    description: 'd',
    body: '',
    files: [],
    totalBytes: 1,
    scripts: [],
    digest: 'x',
    action: 'add',
    notes: [],
    ...extra
  })
  const preview: SkillImportPreview = {
    items: [item('.claude/skills/a', 'a'), item('.claude/skills/b', 'b', { action: 'unchanged' }), item('.claude/skills/c', 'c', { nameConflict: true })],
    invalid: [{ repoPath: '.claude/skills/bad', reason: 'symlink inside' }],
    warnings: [],
    roots: ['.claude/skills'],
    digest: 'DIGEST'
  }

  it('previews, confirms and applies with the digest; prints the undo id', async () => {
    const f = setup({ 'skills:previewImport': () => preview, 'skills:applyImport': () => ({ project: P, skills, added: ['s9'], updated: [], undoId: 'undo_1' }) })
    expect((await run(f.ctx, ['import', '--yes'])).code).toBe(0)
    expect(f.client.callsOf('skills:applyImport')).toEqual([
      [
        {
          projectId: 'p1',
          digest: 'DIGEST',
          choices: [
            { key: '.claude/skills/a', include: true },
            { key: '.claude/skills/b', include: false },
            { key: '.claude/skills/c', include: false }
          ]
        }
      ]
    ])
    expect(f.out()).toContain('refused')
    expect(f.out()).toContain('undo-import undo_1')
  })

  it('a stale preview is exit 1', async () => {
    const f = setup({ 'skills:previewImport': () => preview, 'skills:applyImport': () => Promise.reject(rpcError({ code: 'bad_request', message: 'The skill folders changed since the preview.' })) })
    const r = await run(f.ctx, ['import', '--yes'])
    expect(r.code).toBe(1)
    expect(r.message).toContain('changed since the preview')
  })

  it('--skill picks one; an unknown one is exit 2', () => {
    expect(importChoices(preview, ['c']).map((c) => c.include)).toEqual([false, false, true])
    expect(() => importChoices(preview, ['zzz'])).toThrow(CliError)
  })

  it('nothing chosen: no apply, exit 0', async () => {
    const f = setup({ 'skills:previewImport': () => ({ ...preview, items: [preview.items[1]] }) })
    expect((await run(f.ctx, ['import'])).code).toBe(0)
    expect(f.out()).toContain('Nothing to import')
    expect(f.client.callsOf('skills:applyImport')).toEqual([])
  })
})

describe('skills evaluate / evaluation', () => {
  it('evaluate uses operate and a long timeout; prints the budget note', async () => {
    const report = { projectId: 'p1', at: 1, runsConsidered: 3, findings: [{ id: 'f1', kind: 'neverGranted', severity: 'warning', skillIds: [], title: 'No role has pdf', detail: '' }], suggestions: [], modelAssisted: false, skippedReason: 'budget', tokenBudget: 5000, tokensUsed: 0, costUsd: null }
    const f = setup({ 'skills:evaluate': () => report })
    const spy = vi.spyOn(FakeHostClient.prototype, 'call')
    expect((await run(f.ctx, ['evaluate'])).code).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read', 'operate'])
    expect((spy.mock.calls.find((c) => c[0] === 'skills:evaluate') as unknown[] | undefined)?.[2]).toMatchObject({ timeoutMs: 600_000 })
    spy.mockRestore()
    expect(f.out()).toContain('No role has pdf')
    expect(f.out()).toContain('token budget (5000)')
  })

  it('evaluation with none yet', async () => {
    const f = setup({ 'skills:lastEvaluation': () => null })
    expect((await run(f.ctx, ['evaluation'])).code).toBe(0)
    expect(f.out()).toContain('No skill evaluation yet')
  })
})

describe('skills library', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-skills-lib-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const entry = (id: string, name: string, usedBy: SkillLibraryInfo['usedBy'] = []): SkillLibraryInfo => ({
    entry: { id, name, description: 'd', source: 'user', digest: 'x', files: [{ path: 'SKILL.md', bytes: 1 }], addedAt: '', updatedAt: '' },
    usedBy
  })

  it('add sends the bundle and prints the new entry', async () => {
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: tidy\ndescription: Tidy up\n---\nBody\n')
    mkdirSync(join(dir, 'ref'))
    writeFileSync(join(dir, 'ref', 'a.md'), 'A')
    let listed = 0
    const f = setup({
      'skillLibrary:list': () => (listed++ === 0 ? [entry('L0', 'old')] : []),
      'skillLibrary:addFromBundle': () => [entry('L0', 'old'), entry('L1', 'tidy')]
    })
    expect((await run(f.ctx, ['library', 'add', dir, '--name', 'tidy'])).code).toBe(0)
    const [bundle] = f.client.callsOf('skillLibrary:addFromBundle')[0] as [{ name: string; files: { relPath: string; base64: string }[] }]
    expect(bundle.name).toBe('tidy')
    expect(bundle.files.map((x) => x.relPath)).toEqual(['SKILL.md', 'ref/a.md'])
    expect(Buffer.from(bundle.files[1].base64, 'base64').toString()).toBe('A')
    expect(f.out()).toContain('Added tidy (L1)')
  })

  it('a host refusal is exit 1 with the message (sanitized)', async () => {
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n!`rm -rf /`\n')
    const f = setup({
      'skillLibrary:list': () => [],
      'skillLibrary:addFromBundle': () => Promise.reject(rpcError({ code: 'bad_request', message: 'SKILL.md runs shell commands (!`cmd`); remove them.\u001b[31m' }))
    })
    const r = await run(f.ctx, ['library', 'add', dir])
    expect(r.code).toBe(1)
    expect(r.message).toContain('SKILL.md runs shell commands')
    expect(r.message).not.toContain('\u001b')
  })

  it('a bad folder fails before any host call', async () => {
    const f = setup()
    expect((await run(f.ctx, ['library', 'add', dir])).code).toBe(EXIT.usage)
    expect(f.connectCalls).toEqual([])
  })

  it('remove names the projects using it', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), true)
    const f = setup({ 'skillLibrary:list': () => [entry('L1', 'tidy', [{ projectId: 'p1', projectName: 'Proj', skillId: 's', roleNames: ['Lead'] }])], 'skillLibrary:remove': () => [] }, { stdinIsTTY: true })
    f.ctx.io.stdout.isTTY = true
    expect((await run(f.ctx, ['library', 'remove', 'tidy'])).code).toBe(0)
    expect(asked[0]).toContain('Proj (Lead)')
    expect(f.client.callsOf('skillLibrary:remove')).toEqual([[{ libraryId: 'L1' }]])
  })

  it('link resolves the library entry by name', async () => {
    const f = setup({ 'skillLibrary:list': () => [entry('L1', 'tidy')], 'skills:linkLibrary': mutation })
    await run(f.ctx, ['link', 'tidy', '--role', 'lead'])
    expect(f.client.callsOf('skills:linkLibrary')).toEqual([[{ projectId: 'p1', libraryId: 'L1', roleIds: ['r1'] }]])
  })
})

describe('skills promote / undo-import / apply-suggestion', () => {
  it('promote sends { projectId, skillId } to skills:promote', async () => {
    const f = setup({ 'skills:promote': mutation })
    expect((await run(f.ctx, ['promote', 'pdf'])).code).toBe(0)
    expect(f.client.callsOf('skills:promote')).toEqual([[{ projectId: 'p1', skillId: 's1' }]])
    expect(f.out()).toContain('Copied pdf to the skill library')
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    const g = setup({ 'skills:promote': mutation })
    expect((await run(g.ctx, ['promote', 'nope'])).code).toBe(EXIT.usage)
    expect(g.client.callsOf('skills:promote')).toEqual([])
  })

  it('undo-import sends { projectId, undoId } to skills:undoImport; a host refusal is exit 1', async () => {
    const f = setup({ 'skills:undoImport': mutation })
    expect((await run(f.ctx, ['undo-import', 'u_123'])).code).toBe(0)
    expect(f.client.callsOf('skills:undoImport')).toEqual([[{ projectId: 'p1', undoId: 'u_123' }]])
    expect(f.out()).toContain('Undid the skill import.')
    const g = setup({ 'skills:undoImport': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Nothing to undo' })) })
    const r = await run(g.ctx, ['undo-import', 'u_123'])
    expect(r.code).toBe(1)
    expect(r.message).toContain('Nothing to undo')
    expect((await run(setup().ctx, ['undo-import'])).code).toBe(EXIT.usage)
  })

  it('apply-suggestion sends { projectId, suggestionId, roleIds } to skills:applySuggestion', async () => {
    const f = setup({ 'skills:applySuggestion': mutation })
    expect((await run(f.ctx, ['apply-suggestion', 'sg_1', '--role', 'writer'])).code).toBe(0)
    expect(f.client.callsOf('skills:applySuggestion')).toEqual([[{ projectId: 'p1', suggestionId: 'sg_1', roleIds: ['r2'] }]])
    const g = setup({ 'skills:applySuggestion': mutation })
    expect((await run(g.ctx, ['apply-suggestion', 'sg_1'])).code).toBe(0)
    expect(g.client.callsOf('skills:applySuggestion')).toEqual([[{ projectId: 'p1', suggestionId: 'sg_1' }]])
    const h = setup({ 'skills:applySuggestion': mutation })
    expect((await run(h.ctx, ['apply-suggestion', 'sg_1', '--role', 'ghost'])).code).toBe(EXIT.usage)
    expect(h.client.callsOf('skills:applySuggestion')).toEqual([])
  })
})

describe('skills library create / update', () => {
  const entry = (id: string, name: string, usedBy: SkillLibraryInfo['usedBy'] = []): SkillLibraryInfo => ({
    entry: { id, name, description: 'd', source: 'user', digest: 'x', files: [{ path: 'SKILL.md', bytes: 1 }], addedAt: '', updatedAt: '' },
    usedBy
  })

  it('create sends a SkillDraft { name, description, body } to skillLibrary:create', async () => {
    const f = setup({ 'skillLibrary:create': () => [entry('L1', 'tidy')] }, { globals: { outputFormat: 'json' } })
    expect((await run(f.ctx, ['library', 'create', '--name', 'tidy', '--description', 'Tidy up', '--text', 'Do it'])).code).toBe(0)
    expect(f.client.callsOf('skillLibrary:create')).toEqual([[{ name: 'tidy', description: 'Tidy up', body: 'Do it' }]])
    expect(JSON.parse(f.out()).entry.id).toBe('L1')
    for (const args of [['library', 'create', '--description', 'd', '--text', 'b'], ['library', 'create', '--name', 'n', '--text', 'b'], ['library', 'create', '--name', 'n', '--description', 'd']]) {
      const g = setup({ 'skillLibrary:create': () => [] })
      expect((await run(g.ctx, args)).code).toBe(EXIT.usage)
      expect(g.connectCalls).toEqual([])
    }
  })

  it('update sends { libraryId, draft } keeping unchanged fields; without a new body it reads the current one', async () => {
    const f = setup({ 'skillLibrary:list': () => [entry('L1', 'tidy', [{ projectId: 'p1', projectName: 'Proj', skillId: 's', roleNames: [] }])], 'skillLibrary:read': () => ({ skillMd: '', body: 'Old body', files: [] }), 'skillLibrary:update': () => [entry('L1', 'tidy')] })
    expect((await run(f.ctx, ['library', 'update', 'tidy', '--description', 'New'])).code).toBe(0)
    expect(f.client.callsOf('skillLibrary:read')).toEqual([[{ libraryId: 'L1' }]])
    expect(f.client.callsOf('skillLibrary:update')).toEqual([[{ libraryId: 'L1', draft: { name: 'tidy', description: 'New', body: 'Old body' } }]])
    expect(f.out()).toContain('1 project linking it see the change')
    const g = setup({ 'skillLibrary:list': () => [entry('L1', 'tidy')], 'skillLibrary:update': () => [entry('L1', 'neat')] })
    expect((await run(g.ctx, ['library', 'update', 'L1', '--name', 'neat', '--text', 'New body'])).code).toBe(0)
    expect(g.client.callsOf('skillLibrary:read')).toEqual([])
    expect(g.client.callsOf('skillLibrary:update')).toEqual([[{ libraryId: 'L1', draft: { name: 'neat', description: 'd', body: 'New body' } }]])
    expect((await run(setup().ctx, ['library', 'update', 'tidy'])).code).toBe(EXIT.usage)
  })
})

describe('skills assist', () => {
  it('calls runInteractiveRun with skills:startAssist for the project', async () => {
    const calls: unknown[] = []
    skillsDeps.runInteractiveRun = async (_ctx, spec, flags) => (calls.push({ spec, flags }), 0)
    const f = setup()
    expect((await run(f.ctx, ['assist', 'review our skills'])).code).toBe(0)
    expect(calls).toEqual([
      {
        spec: expect.objectContaining({ channel: 'skills:startAssist', input: { projectId: 'p1', scope: 'project', instruction: 'review our skills' }, label: 'Skill assistant' }),
        flags: { inline: false, screenReader: false }
      }
    ])
  })

  it('--library needs no project', async () => {
    const calls: unknown[] = []
    skillsDeps.runInteractiveRun = async (_ctx, spec) => (calls.push(spec.input), 0)
    const f = setup({}, { cwd: '/elsewhere' })
    expect((await run(f.ctx, ['assist', '--library'])).code).toBe(0)
    expect(calls).toEqual([{ scope: 'library' }])
    expect(f.connectCalls).toEqual([])
  })

  it('no project and no --library is exit 2', async () => {
    skillsDeps.runInteractiveRun = async () => 0
    const r = await run(setup({}, { cwd: '/elsewhere' }).ctx, ['assist'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.message).toContain('--library')
  })
})

describe('routing', () => {
  it('a missing or unknown subcommand is exit 2', async () => {
    expect((await run(setup().ctx, [])).code).toBe(EXIT.usage)
    expect((await run(setup().ctx, ['frobnicate'])).code).toBe(EXIT.usage)
    expect((await run(setup().ctx, ['library'])).code).toBe(EXIT.usage)
  })
})
