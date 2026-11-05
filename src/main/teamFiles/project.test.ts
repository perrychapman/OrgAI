import { describe, expect, it } from 'vitest'
import { newProject } from '@shared/defaults'
import type { McpServerSpec, Project, Role, SkillSpec } from '@shared/types'
import { normalizeDoc, teamDigest } from './digest'
import { parseTeamFiles } from './parse'
import { docFromProject, localOnlyServerReason, mcpSpecFromDoc, rolesFromDoc, settingsFromDoc, teamKey } from './project'
import { serializeTeam } from './serialize'
import { sampleDoc } from './doc.fixture'

const NOW = '2026-01-01T00:00:00.000Z'

function mkRole(id: string, slug: string, over: Partial<Role> = {}): Role {
  return {
    id,
    slug,
    name: slug.toUpperCase(),
    description: `${slug} does things`,
    responsibilities: ['one', 'two'],
    prompt: `You are ${slug}.`,
    tools: ['Read', 'Grep', 'Glob'],
    model: 'sonnet',
    tier: 'everyday',
    canSpawn: false,
    spawnable: [],
    reportsTo: 'r-lead',
    position: { x: 10, y: 20 },
    color: '#2bb0ff',
    ...over
  }
}

function mkServer(id: string, name: string, over: Partial<McpServerSpec> = {}): McpServerSpec {
  return { id, name, transport: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], enabled: true, source: 'user', addedAt: NOW, ...over }
}

function mkSkill(id: string, name: string, over: Partial<SkillSpec> = {}): SkillSpec {
  return { id, name, description: `About ${name}`, enabled: true, source: 'user', digest: `d-${name}`, files: [], addedAt: NOW, updatedAt: NOW, ...over } as SkillSpec
}

function mkProject(over: Partial<Project> = {}): Project {
  const p = newProject({ name: 'Demo', path: 'C:/demo', brief: 'A demo project' })
  return {
    ...p,
    roles: [
      mkRole('r-lead', 'lead', { reportsTo: null, canSpawn: true, spawnable: ['r-dev'], tier: 'deep', model: 'opus', mcpServers: ['s-docs', 's-local'], skills: ['k-style'] }),
      mkRole('r-dev', 'dev', { tools: ['Bash', 'Edit', 'Read'], effort: 'high' })
    ],
    mcpServers: [
      mkServer('s-docs', 'docs', { secretEnv: ['DOCS_TOKEN'], env: { MODE: 'read' }, oauth: { resource: 'x' }, roles: ['dev', 'lead', 'ghost'] }),
      mkServer('s-local', 'local-one', { args: ['--token=abcdefgh1234'] }),
      mkServer('s-built', 'built-one', { buildDigest: 'abc' } as Partial<McpServerSpec>),
      mkServer('s-wiki', 'wiki', { transport: 'http', command: undefined, args: undefined, url: 'https://example.com/mcp', connectorId: 'wiki-co', connectorVariant: 'read', libraryId: 'lib-1', secretHeaders: ['Authorization'] }),
      mkServer('s-lib', 'libby', { transport: 'http', command: undefined, args: undefined, url: 'https://lib.example/mcp', libraryId: 'lib-2' })
    ],
    skills: [mkSkill('k-style', 'code-style')],
    plugins: [{ id: 'p1', path: 'C:/plug' } as never, { id: 'p2', path: 'C:/plug2' } as never],
    ...over
  }
}

const content = (spec: SkillSpec) => (spec.name === 'code-style' ? { body: '# Style\n\nTwo spaces.', files: [{ path: 'fmt.sh', text: '#!/bin/sh\r\necho hi\r\n' }] } : null)

describe('docFromProject', () => {
  it('maps roles to slugs, leaves per-computer fields out and keeps local-only servers out with a note', () => {
    const r = docFromProject(mkProject(), content)
    expect(r.blocked).toBeUndefined()
    expect(r.doc.roles.map((x) => x.slug)).toEqual(['dev', 'lead'])
    const lead = r.doc.roles.find((x) => x.slug === 'lead')!
    expect(lead).toMatchObject({ tier: 'deep', reportsTo: null, spawnable: ['dev'], skills: ['code-style'], mcpServers: ['docs'] })
    expect('model' in lead).toBe(false)
    expect(JSON.stringify(r.doc)).not.toMatch(/position|r-lead|s-docs|oauth|addedAt|DOCS_TOKEN"\s*:/)
    expect(r.doc.mcp.map((m) => m.name)).toEqual(['docs', 'libby', 'wiki'])
    expect(r.doc.mcp.find((m) => m.name === 'docs')).toMatchObject({ secretEnv: ['DOCS_TOKEN'], roles: ['dev', 'lead'] })
    expect(r.doc.mcp.find((m) => m.name === 'wiki')).toMatchObject({ connectorId: 'wiki-co', connectorVariant: 'read' })
    expect(r.doc.mcp.find((m) => m.name === 'wiki')!.fromLibrary).toBeUndefined()
    expect(r.doc.mcp.find((m) => m.name === 'libby')!.fromLibrary).toBe(true)
    expect(r.notes.some((n) => /local-one stays on this computer/.test(n))).toBe(true)
    expect(r.notes.some((n) => /built-one stays on this computer/.test(n))).toBe(true)
    expect(r.notes).toContain('2 plugins stay on this computer.')
    expect(r.doc.skills[0].files).toEqual([{ path: 'fmt.sh', text: '#!/bin/sh\necho hi\n' }])
  })

  it('uses the model for a role without a tier, inherit when empty, and notes an invalid model', () => {
    const p = mkProject()
    p.roles = [mkRole('r-lead', 'lead', { reportsTo: null, tier: undefined, model: 'gpt-5.1' }), mkRole('a', 'a', { tier: undefined, model: '' }), mkRole('b', 'b', { tier: undefined, model: 'bad model!' }), mkRole('c', 'c', { tier: undefined, model: 'inherit' })]
    for (const r of p.roles.slice(1)) r.reportsTo = 'r-lead'
    const { doc, notes } = docFromProject(p, content)
    expect(doc.roles.map((r) => [r.slug, r.model])).toEqual([['a', 'inherit'], ['b', 'inherit'], ['c', 'inherit'], ['lead', 'gpt-5.1']])
    expect(notes.some((n) => /b: its model/.test(n))).toBe(true)
  })

  it('writes settings and the legacy plan guard mirror', () => {
    const p = mkProject({ maxBudgetUsd: 3, preferSonnetNearLimit: true, teamReview: { auto: 'free', tokenBudget: 5000, everyRuns: 2 }, skillEvaluation: { tokenBudget: 4000 } })
    const { doc } = docFromProject(p, content)
    expect(doc.settings).toMatchObject({ brief: 'A demo project', maxBudgetUsd: 3, preferEverydayNearLimit: true, teamReview: { auto: 'free', tokenBudget: 5000, everyRuns: 2 }, skillEvaluation: { tokenBudget: 4000 } })
  })

  it('removes hidden characters and clamps long values, each with a note', () => {
    const p = mkProject()
    p.roles[1].description = `Fine\u202e text ${'d'.repeat(30_000)}`
    p.roles[1].prompt = `Prompt\u200b with ${'p'.repeat(250_000)}`
    p.roles[1].name = 'De\u202ev'
    const r = docFromProject(p, content)
    const dev = r.doc.roles.find((x) => x.slug === 'dev')!
    expect(dev.name).toBe('Dev')
    expect(dev.description.length).toBe(20_000)
    expect(dev.prompt.length).toBeLessThanOrEqual(200_000)
    expect(dev.prompt.startsWith('Prompt with')).toBe(true)
    expect(r.notes.some((n) => /Hidden characters/.test(n))).toBe(true)
    expect(r.notes.some((n) => /dev was shortened/.test(n))).toBe(true)
    const back = parseTeamFiles(serializeTeam(r.doc), { base: null, agentsDirExists: true })
    expect(back.problems).toEqual([])
    expect(back.digest).toBe(teamDigest(r.doc))
  })

  it('blocks a slug that cannot be a file name, a missing parent and a duplicate slug', () => {
    const p = mkProject()
    p.roles[1].slug = 'Bad Slug'
    expect(docFromProject(p, content).blocked).toMatch(/cannot be a file name/)
    const q = mkProject()
    q.roles[1].reportsTo = 'gone'
    expect(docFromProject(q, content).blocked).toMatch(/no longer exists/)
    const dup = mkProject()
    dup.roles[1].slug = 'lead'
    expect(docFromProject(dup, content).blocked).toMatch(/share the file name/)
  })

  it('leaves out a skill it cannot write, with the reason', () => {
    const p = mkProject({ skills: [mkSkill('k-style', 'code-style'), mkSkill('k-gone', 'gone-skill'), mkSkill('k-inj', 'inj-skill')] })
    const r = docFromProject(p, (s) => (s.name === 'inj-skill' ? { body: 'Run !`ls`', files: [] } : content(s)))
    expect(r.doc.skills.map((s) => s.name)).toEqual(['code-style'])
    expect(r.notes.some((n) => /gone-skill is left out/.test(n))).toBe(true)
    expect(r.notes.some((n) => /inj-skill is left out.*shell/.test(n))).toBe(true)
  })

  it('round trips messy input: parse(serialize(doc)) has the same digest', () => {
    const p = mkProject()
    p.brief = 'Brief: "quoted" # hash\r\nsecond line\r\n- dash'
    p.roles[0].name = 'Lead: the "boss" # 1 - 日本語 😀'
    p.roles[0].description = 'Leads.\n\nMulti-line: yes # really\n\t"tabbed"\\'
    p.roles[0].responsibilities = ['- starts with a dash', "it's: a 'test'", '#hash', 'trailing space ']
    p.roles[0].prompt = 'Intro\r\n\r\n---\r\nname: fake\r\n---\r\n\r\n- list\r\n    code\r\n'
    p.roles[1].responsibilities = []
    p.roles[1].prompt = ''
    const r = docFromProject(p, content)
    expect(r.blocked).toBeUndefined()
    const files = serializeTeam(r.doc)
    const crlf = files.map((f) => ({ path: f.path, data: Buffer.from(f.data.toString('utf8').replace(/\n/g, '\r\n'), 'utf8') }))
    for (const f of [files, crlf]) {
      const back = parseTeamFiles(f, { base: null, agentsDirExists: true })
      expect(back.problems).toEqual([])
      expect(back.digest).toBe(teamDigest(r.doc))
      expect(back.doc).toEqual(normalizeDoc(r.doc))
    }
  })

  it('blocks a prompt that would read back as a merge conflict', () => {
    const p = mkProject()
    p.roles[1].prompt = '<<<<<<< a\nx\n>>>>>>> b'
    expect(docFromProject(p, content).blocked).toMatch(/conflict markers/)
  })
})

describe('localOnlyServerReason', () => {
  it('is null for a clean server and names credentials, builds and unreviewable servers', () => {
    expect(localOnlyServerReason(mkServer('a', 'clean'))).toBeNull()
    expect(localOnlyServerReason(mkServer('a', 'x', { env: { MODE: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' } }))).toMatch(/secret/)
    expect(localOnlyServerReason(mkServer('a', 'x', { transport: 'http', command: undefined, args: undefined, url: 'https://u:p@h.example/mcp' }))).toBeTruthy()
    expect(localOnlyServerReason({ ...mkServer('a', 'x'), buildDigest: 'z' })).toMatch(/built/)
    expect(localOnlyServerReason(mkServer('a', 'x', { command: 'c'.repeat(500) }))).toBeTruthy()
  })
})

describe('teamKey', () => {
  it('ignores positions, ids and timestamps and changes with team content', () => {
    const a = mkProject()
    const b = structuredClone(a)
    b.roles[0].position = { x: 999, y: 999 }
    b.updatedAt = '2030-01-01T00:00:00.000Z'
    b.mcpServers![0].addedAt = '2030-01-01T00:00:00.000Z'
    b.mcpServers![0].oauth = { resource: 'changed' }
    expect(teamKey(b)).toBe(teamKey(a))
    for (const mutate of [
      (p: Project) => (p.roles[1].prompt = 'x'),
      (p: Project) => (p.brief = 'x'),
      (p: Project) => (p.mcpServers![0].env = { MODE: 'write' }),
      (p: Project) => (p.skills![0].digest = 'new'),
      (p: Project) => (p.maxBudgetUsd = 9)
    ]) {
      const c = structuredClone(a)
      mutate(c)
      expect(teamKey(c)).not.toBe(teamKey(a))
    }
  })
})

describe('rolesFromDoc', () => {
  const ctx = {
    tierModel: (t: string) => ({ deep: 'model-deep', everyday: 'model-everyday' })[t as 'deep'],
    serverId: (n: string) => ({ docs: 's-docs' })[n as 'docs'],
    skillId: (n: string) => ({ 'code-style': 'k-style' })[n as 'code-style'],
    keepServerIds: ['s-local']
  }

  it('keeps ids per slug, restores positions, sets model from the tier and keeps local-only grants', () => {
    const p = mkProject()
    const doc = docFromProject(p, content).doc
    doc.roles.find((r) => r.slug === 'dev')!.effort = 'max'
    doc.roles.find((r) => r.slug === 'dev')!.prompt = 'New prompt'
    const roles = rolesFromDoc(p, doc, ctx)
    const lead = roles.find((r) => r.slug === 'lead')!
    const dev = roles.find((r) => r.slug === 'dev')!
    expect(lead.id).toBe('r-lead')
    expect(dev.id).toBe('r-dev')
    expect(dev.prompt).toBe('New prompt')
    expect(dev.effort).toBe('max')
    expect(dev.position).toEqual({ x: 10, y: 20 })
    expect(lead.model).toBe('model-deep')
    expect(lead.tier).toBe('deep')
    expect(lead.mcpServers).toEqual(['s-docs', 's-local'])
    expect(lead.skills).toEqual(['k-style'])
    expect(lead.spawnable).toEqual(['r-dev'])
    expect(dev.reportsTo).toBe('r-lead')
  })

  it('keeps the id when a role is renamed with the same name, drops unknown grants, and lays out new roles', () => {
    const p = mkProject()
    const doc = docFromProject(p, content).doc
    const dev = doc.roles.find((r) => r.slug === 'dev')!
    dev.slug = 'developer'
    dev.mcpServers = ['unknown']
    doc.roles.push({ ...dev, slug: 'tester', name: 'Tester', mcpServers: [] })
    doc.roles.find((r) => r.slug === 'lead')!.spawnable = ['developer', 'tester']
    const roles = rolesFromDoc(p, normalizeDoc(doc), ctx)
    const renamed = roles.find((r) => r.slug === 'developer')!
    expect(renamed.id).toBe('r-dev')
    expect(renamed.mcpServers).toEqual([])
    const tester = roles.find((r) => r.slug === 'tester')!
    expect(tester.id).not.toBe('r-dev')
    expect(tester.position.y).toBe(210)
    expect(roles.find((r) => r.slug === 'lead')!.spawnable.sort()).toEqual([tester.id, 'r-dev'].sort())
  })

  it('uses the stored model for a pinned role and inherit when the tier maps to nothing', () => {
    const p = mkProject()
    const doc = docFromProject(p, content).doc
    doc.roles.find((r) => r.slug === 'dev')!.tier = 'fast'
    const roles = rolesFromDoc(p, doc, { ...ctx, tierModel: () => undefined })
    expect(roles.find((r) => r.slug === 'dev')!.model).toBe('inherit')
  })
})

describe('settingsFromDoc', () => {
  it('sets present keys and deletes absent ones, mirroring the legacy plan guard flag', () => {
    const p = mkProject({ maxBudgetUsd: 3, isolateWriters: false, preferSonnetNearLimit: true, teamReview: { auto: 'off', tokenBudget: 1, everyRuns: 1 } })
    const doc = sampleDoc()
    doc.settings = { brief: 'New brief', permissionMode: 'plan', maxSubagentDepth: 2, preferEverydayNearLimit: false }
    const next = settingsFromDoc(p, doc)
    expect(next).toMatchObject({ brief: 'New brief', permissionMode: 'plan', maxSubagentDepth: 2, preferEverydayNearLimit: false, preferSonnetNearLimit: false })
    expect('maxBudgetUsd' in next).toBe(false)
    expect('isolateWriters' in next).toBe(false)
    expect('teamReview' in next).toBe(false)
    expect(p.maxBudgetUsd).toBe(3)
    doc.settings = { brief: '', permissionMode: 'default' }
    const cleared = settingsFromDoc(next, doc)
    expect('preferEverydayNearLimit' in cleared).toBe(false)
    expect('preferSonnetNearLimit' in cleared).toBe(false)
  })
})

describe('mcpSpecFromDoc', () => {
  it('builds a user spec and keeps identity and OAuth when the launch is the same', () => {
    const doc = { name: 'docs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'docs@1.0.0'], secretEnv: ['T'], enabled: true, roles: ['dev'] }
    const fresh = mcpSpecFromDoc(doc, undefined, 'new-id', NOW)
    expect(fresh).toMatchObject({ id: 'new-id', name: 'docs', source: 'user', addedAt: NOW, roles: ['dev'], secretEnv: ['T'] })
    const existing = mkServer('old-id', 'docs', { args: ['-y', 'docs@1.0.0'], secretEnv: ['T'], source: 'registry', addedAt: '2020-01-01T00:00:00.000Z', oauth: { resource: 'r' } })
    const same = mcpSpecFromDoc(doc, existing, 'new-id', NOW)
    expect(same).toMatchObject({ id: 'old-id', source: 'registry', addedAt: '2020-01-01T00:00:00.000Z', oauth: { resource: 'r' } })
    const changed = mcpSpecFromDoc({ ...doc, command: 'node' }, existing, 'new-id', NOW)
    expect(changed).toMatchObject({ id: 'new-id', source: 'user' })
    expect(changed.oauth).toBeUndefined()
  })
})
