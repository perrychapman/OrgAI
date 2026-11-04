import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, OPENAI_PLACEHOLDER_MODELS, defaultTierModels, engagementRoles, newProject } from '@shared/defaults'
import type { ConnectionId, Project } from '@shared/types'
import { ORG_TEMPLATES_MAX } from '@shared/types'
import type { ModelContext } from './import/model'
import { TemplateService } from './templates'

let dataDir: string
let stored: Project[]
let changed: Project[]

const contexts: Record<ConnectionId, ModelContext> = {
  anthropic: { connection: 'anthropic', catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) },
  openai: { connection: 'openai', catalog: OPENAI_PLACEHOLDER_MODELS, tierModels: defaultTierModels(OPENAI_PLACEHOLDER_MODELS) },
  litellm: { connection: 'litellm', catalog: [], tierModels: {} }
}

function service(): TemplateService {
  return new TemplateService({
    dataDir,
    projects: {
      get: (id) => stored.find((p) => p.id === id) ?? null,
      save: (p) => {
        const i = stored.findIndex((x) => x.id === p.id)
        if (i >= 0) stored[i] = p
        return p
      }
    },
    modelContext: (id) => contexts[id],
    withAdapter: (p) => (p.provider.connection === 'openai' ? { ...p, provider: { ...p.provider, id: 'codex' } } : p),
    onProjectChanged: (p) => changed.push(p)
  })
}

const make = (name: string, over: Partial<Project> = {}): Project => ({ ...newProject({ name, path: join(dataDir, name) , brief: '' }), ...over })

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-tpl-'))
  stored = []
  changed = []
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('TemplateService save and list', () => {
  it('saves a project chart as a template, no ids, grants or secrets in the file', () => {
    const p = make('Shop')
    p.roles = p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: ['srv1'], skills: ['sk1'] } : r))
    stored.push(p)
    const svc = service()
    const info = svc.saveFromProject({ projectId: p.id, name: '  Starter team ', description: 'A\nsmall team' })
    expect(info).toMatchObject({ name: 'Starter team', description: 'A\nsmall team', kind: 'code', roleCount: p.roles.length })
    expect(info.id).toMatch(/^tpl_/)
    const root = p.roles.find((r) => r.reportsTo === null)!
    expect(info.roleNames[0]).toBe(root.name)
    expect([...info.roleNames].sort()).toEqual(p.roles.map((r) => r.name).sort())
    expect(info.roleNames.length).toBeLessThanOrEqual(40)
    expect(svc.list()).toEqual([info])
    const file = readFileSync(join(dataDir, 'org-templates', info.id, 'org.json'), 'utf8')
    const doc = JSON.parse(file)
    expect(doc.format).toBe('orgai.org/1')
    expect(doc.roles).toHaveLength(p.roles.length)
    for (const r of p.roles) expect(file).not.toContain(r.id)
    expect(file).not.toContain('srv1')
    expect(file).not.toContain('sk1')
    expect(readdirSync(join(dataDir, 'org-templates')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('records the engagement kind', () => {
    const p = make('Study', { kind: 'engagement' })
    stored.push(p)
    expect(service().saveFromProject({ projectId: p.id, name: 'Study team' }).kind).toBe('engagement')
  })

  it('refuses bad names and descriptions', () => {
    const p = make('Shop')
    stored.push(p)
    const svc = service()
    for (const name of ['', '   ', 'x'.repeat(81), 'a​b', 'a\nb', 'a\u0007b', 5 as unknown as string]) {
      expect(() => svc.saveFromProject({ projectId: p.id, name }), String(name)).toThrow()
    }
    expect(() => svc.saveFromProject({ projectId: p.id, name: 'ok', description: 'x'.repeat(501) })).toThrow(/500/)
    expect(() => svc.saveFromProject({ projectId: p.id, name: 'ok', description: 'a‮b' })).toThrow(/hidden/)
    expect(() => svc.saveFromProject({ projectId: p.id, name: 'x'.repeat(80), description: 'x'.repeat(500) })).not.toThrow()
    expect(svc.list()).toHaveLength(1)
  })

  it('refuses unknown, virtual and role-less projects', () => {
    const svc = service()
    expect(() => svc.saveFromProject({ projectId: 'nope', name: 'x' })).toThrow('Project not found')
    expect(() => svc.saveFromProject({ projectId: 'quick', name: 'x' })).toThrow('Project not found')
    const empty = make('Empty', { roles: [] })
    stored.push(empty)
    expect(() => svc.saveFromProject({ projectId: empty.id, name: 'x' })).toThrow(/no roles/)
  })

  it('refuses at the cap', () => {
    const p = make('Shop')
    stored.push(p)
    const templates = Array.from({ length: ORG_TEMPLATES_MAX }, (_, i) => ({ id: `tpl_${i}`, name: `T${i}`, description: '', kind: 'code', roleCount: 1, createdAt: i, updatedAt: i }))
    mkdirSync(join(dataDir, 'org-templates'), { recursive: true })
    writeFileSync(join(dataDir, 'org-templates', 'templates.json'), JSON.stringify({ version: 1, templates }))
    const svc = service()
    expect(svc.list()).toHaveLength(ORG_TEMPLATES_MAX)
    expect(() => svc.saveFromProject({ projectId: p.id, name: 'one more' })).toThrow(/at most 100/)
  })

  it('drops junk index entries and survives a junk index', () => {
    mkdirSync(join(dataDir, 'org-templates'), { recursive: true })
    const file = join(dataDir, 'org-templates', 'templates.json')
    writeFileSync(file, '{ not json')
    expect(service().list()).toEqual([])
    const good = { id: 'tpl_a1', name: 'Good', description: '', kind: 'code', roleCount: 2, roleNames: ['Lead', 'Dev'], createdAt: 1, updatedAt: 2 }
    writeFileSync(
      file,
      JSON.stringify({
        templates: [null, 3, { ...good, id: '../x' }, { ...good, id: 'other_1' }, { ...good, id: 'tpl_b', name: '' }, { ...good, id: 'tpl_c', kind: 'weird' }, { ...good, id: 'tpl_d', name: 'a\u0007b' }, good, good]
      })
    )
    expect(service().list()).toEqual([good])
  })

  it('sorts newest first', () => {
    mkdirSync(join(dataDir, 'org-templates'), { recursive: true })
    const e = (id: string, updatedAt: number) => ({ id, name: id, description: '', kind: 'code', roleCount: 1, createdAt: 0, updatedAt })
    writeFileSync(join(dataDir, 'org-templates', 'templates.json'), JSON.stringify({ templates: [e('tpl_old', 1), e('tpl_new', 9)] }))
    expect(service().list().map((t) => t.id)).toEqual(['tpl_new', 'tpl_old'])
  })
})

describe('TemplateService apply', () => {
  function saved(): { svc: TemplateService; src: Project; id: string } {
    const src = make('Source')
    stored.push(src)
    const svc = service()
    return { svc, src, id: svc.saveFromProject({ projectId: src.id, name: 'T' }).id }
  }

  it('replace: round trip gives a fresh chart with new ids, mapped models, no grants', () => {
    const { svc, src, id } = saved()
    const target = make('Target', { roles: engagementRoles(contexts.anthropic).slice(0, 2).map((r) => ({ ...r, mcpServers: ['keep-me'] })) })
    stored.push(target)
    const result = svc.apply({ projectId: target.id, templateId: id, mode: 'replace' })
    expect(result.previousRoles).toEqual(target.roles)
    expect(result.project.roles.map((r) => r.slug).sort()).toEqual(src.roles.map((r) => r.slug).sort())
    expect(result.project.roles.filter((r) => r.reportsTo === null)).toHaveLength(1)
    const oldIds = new Set([...src.roles, ...target.roles].map((r) => r.id))
    for (const r of result.project.roles) {
      expect(oldIds.has(r.id)).toBe(false)
      expect(r.mcpServers ?? []).toEqual([])
      expect(r.skills ?? []).toEqual([])
      expect(typeof r.model).toBe('string')
    }
    expect(stored.find((p) => p.id === target.id)!.roles).toEqual(result.project.roles)
    expect(changed).toHaveLength(1)
  })

  it('merge: keeps existing roles and adds the template under the existing root', () => {
    const { svc, src, id } = saved()
    const target = make('Target')
    stored.push(target)
    const result = svc.apply({ projectId: target.id, templateId: id, mode: 'merge' })
    expect(result.project.roles.length).toBeGreaterThan(target.roles.length)
    for (const r of target.roles) expect(result.project.roles.some((x) => x.id === r.id)).toBe(true)
    expect(result.project.roles.filter((r) => r.reportsTo === null)).toHaveLength(1)
    expect(result.project.roles.length).toBeLessThanOrEqual(target.roles.length + src.roles.length)
  })

  it('maps models to the target project connection and adapter', () => {
    const { svc, id } = saved()
    const target = make('Target')
    target.provider = { ...target.provider, id: 'codex', connection: 'openai' }
    stored.push(target)
    const result = svc.apply({ projectId: target.id, templateId: id, mode: 'replace' })
    expect(result.project.provider.id).toBe('codex')
    const openaiIds = new Set(OPENAI_PLACEHOLDER_MODELS.map((m) => m.id))
    for (const r of result.project.roles) expect(r.model === 'inherit' || openaiIds.has(r.model) || ['top', 'deep', 'everyday', 'fast'].includes(r.model), r.model).toBe(true)
  })

  it('refuses a bad mode, unknown template, unknown or virtual project', () => {
    const { svc, id, src } = saved()
    expect(() => svc.apply({ projectId: src.id, templateId: id, mode: 'add' as 'merge' })).toThrow()
    expect(() => svc.apply({ projectId: src.id, templateId: 'tpl_nope', mode: 'replace' })).toThrow('Template not found')
    expect(() => svc.apply({ projectId: src.id, templateId: '../x', mode: 'replace' })).toThrow('Template not found')
    expect(() => svc.apply({ projectId: 'nope', templateId: id, mode: 'replace' })).toThrow('Project not found')
    expect(() => svc.apply({ projectId: 'harness', templateId: id, mode: 'replace' })).toThrow('Project not found')
  })

  it('fails when the template file is damaged', () => {
    const { svc, id, src } = saved()
    writeFileSync(join(dataDir, 'org-templates', id, 'org.json'), '{ nope')
    expect(() => svc.apply({ projectId: src.id, templateId: id, mode: 'replace' })).toThrow()
    expect(svc.forRun(id, src)).toBeNull()
  })

  it('refuses to read through a linked template folder', () => {
    const { svc, id, src } = saved()
    const outside = mkdtempSync(join(tmpdir(), 'orgai-tpl-out-'))
    try {
      writeFileSync(join(outside, 'org.json'), readFileSync(join(dataDir, 'org-templates', id, 'org.json')))
      rmSync(join(dataDir, 'org-templates', id), { recursive: true })
      try {
        symlinkSync(outside, join(dataDir, 'org-templates', id), 'junction')
      } catch {
        return // no link support here
      }
      expect(() => svc.apply({ projectId: src.id, templateId: id, mode: 'replace' })).toThrow(/plain folder/)
      expect(svc.forRun(id, src)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('TemplateService rolesForNewProject and forRun', () => {
  it('rolesForNewProject replaces the chart, saves nothing, and keeps the project on failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const src = make('Source', { kind: 'engagement' })
    src.roles = engagementRoles(contexts.anthropic)
    stored.push(src)
    const svc = service()
    const { id } = svc.saveFromProject({ projectId: src.id, name: 'Engagement team' })
    const fresh = make('Fresh')
    const next = svc.rolesForNewProject(fresh, id)
    expect(next.roles.map((r) => r.slug).sort()).toEqual(src.roles.map((r) => r.slug).sort())
    expect(next.id).toBe(fresh.id)
    expect(stored.find((p) => p.id === fresh.id)).toBeUndefined()
    expect(svc.rolesForNewProject(fresh, 'tpl_unknown')).toBe(fresh)
    expect(svc.rolesForNewProject(fresh, 42)).toBe(fresh)
    expect(warn).toHaveBeenCalled()
  })

  it('forRun returns name and roles without grant fields, or null for an unknown id', () => {
    const src = make('Source')
    stored.push(src)
    const svc = service()
    const { id } = svc.saveFromProject({ projectId: src.id, name: 'Named' })
    const target = make('Target')
    const run = svc.forRun(id, target)!
    expect(run.name).toBe('Named')
    expect(run.roles.length).toBe(src.roles.length)
    for (const r of run.roles) {
      expect('mcpServers' in r).toBe(false)
      expect('skills' in r).toBe(false)
    }
    expect(svc.forRun('tpl_none', target)).toBeNull()
  })
})

describe('TemplateService remove', () => {
  it('removes the entry and folder and returns the rest', () => {
    const src = make('Source')
    stored.push(src)
    const svc = service()
    const a = svc.saveFromProject({ projectId: src.id, name: 'A' })
    const b = svc.saveFromProject({ projectId: src.id, name: 'B' })
    const rest = svc.remove(a.id)
    expect(rest.map((t) => t.id)).toEqual([b.id])
    expect(readdirSync(join(dataDir, 'org-templates')).sort()).toEqual([b.id, 'templates.json'].sort())
    expect(() => svc.remove(a.id)).toThrow('Template not found')
    expect(() => svc.remove('../x')).toThrow('Template not found')
  })
})
