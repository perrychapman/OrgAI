import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, OPENAI_PLACEHOLDER_MODELS, defaultTierModels, engagementRoles, newProject } from '@shared/defaults'
import type { ConnectionId, Project } from '@shared/types'
import { ORG_TEMPLATES_MAX } from '@shared/types'
import { templateEngagementArgs } from '../host/args'
import type { ModelContext } from './import/model'
import { TemplateService } from './templates'
import { registerSession, writeLockPath } from '../host/sessions'
import { createSharedStoreSync, enableStoreSync } from '../store/shared/storeSync'
import { trySyncLock } from '../store/shared/syncLock'

let dataDir: string
let stored: Project[]

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
    modelContext: (id) => contexts[id]
  })
}

const make = (name: string, over: Partial<Project> = {}): Project => ({ ...newProject({ name, path: join(dataDir, name), brief: '' }), ...over })
const indexFile = (): string => join(dataDir, 'org-templates', 'templates.json')
const fullIndex = (): Record<string, unknown>[] =>
  Array.from({ length: ORG_TEMPLATES_MAX }, (_, i) => ({ id: `tpl_${i}`, name: `T${i}`, description: '', kind: 'code', roleCount: 1, createdAt: i, updatedAt: i }))
const CODE_SLUGS = ['implementer', 'orchestrator', 'researcher', 'reviewer']

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-tpl-builtin-'))
  stored = []
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('built-in templates', () => {
  it('are listed first, code then engagement, read-only and built from the starting charts', () => {
    const list = service().listWithBuiltIns()
    expect(list.slice(0, 2).map((t) => t.id)).toEqual(['builtin:code', 'builtin:engagement'])
    const [code, engagement] = list
    expect(code).toMatchObject({ builtIn: true, kind: 'code', roleCount: newProject({ name: 'x', path: 'x', brief: '' }).roles.length, createdAt: 0, updatedAt: 0 })
    expect(engagement).toMatchObject({ builtIn: true, kind: 'engagement', roleCount: engagementRoles().length })
    expect(code.roleNames[0]).toBe('Orchestrator')
    expect(engagement.roleNames[0]).toBe('Engagement Lead')
    expect(code.appliedCount).toBeUndefined()
    // Saved ones follow, and never carry builtIn.
    const src = make('Source')
    stored.push(src)
    const svc = service()
    const mine = svc.saveFromProject({ projectId: src.id, name: 'Mine' })
    expect(svc.listWithBuiltIns().map((t) => t.id)).toEqual(['builtin:code', 'builtin:engagement', mine.id])
    expect(mine.builtIn).toBeUndefined()
  })

  it('stay out of list() (the saved templates the kit, the Architect and the cap mean)', () => {
    const svc = service()
    expect(svc.list()).toEqual([])
    const src = make('Source')
    stored.push(src)
    const mine = svc.saveFromProject({ projectId: src.id, name: 'Mine' })
    expect(svc.list().map((t) => t.id)).toEqual([mine.id])
    expect(svc.remove(mine.id)).toEqual([])
  })

  it('are never stored and do not count against the cap', () => {
    const svc = service()
    expect(svc.listWithBuiltIns()).toHaveLength(2)
    expect(readdirSync(dataDir)).not.toContain('org-templates')
    mkdirSync(join(dataDir, 'org-templates'), { recursive: true })
    writeFileSync(indexFile(), JSON.stringify({ version: 1, templates: fullIndex() }))
    expect(svc.listWithBuiltIns()).toHaveLength(ORG_TEMPLATES_MAX + 2)
  })

  it('remove refuses them with a plain sentence and changes nothing', () => {
    const svc = service()
    for (const id of ['builtin:code', 'builtin:engagement']) {
      expect(() => svc.remove(id)).toThrow('This is one of the starting teams that come with OrgAI, so it cannot be removed. Duplicate it to make a copy you can change.')
    }
    expect(svc.listWithBuiltIns()).toHaveLength(2)
    expect(() => svc.remove('builtin:other')).toThrow('Template not found')
  })

  it('apply puts the starting chart on a project, in both modes', () => {
    const target = make('Target', { roles: engagementRoles(contexts.anthropic).slice(0, 2) })
    stored.push(target)
    const svc = service()
    const replaced = svc.apply({ projectId: target.id, templateId: 'builtin:code', mode: 'replace' })
    expect(replaced.previousRoles).toEqual(target.roles)
    expect(replaced.project.roles.map((r) => r.slug).sort()).toEqual(CODE_SLUGS)
    expect(replaced.project.roles.filter((r) => r.reportsTo === null)).toHaveLength(1)
    const merged = svc.apply({ projectId: target.id, templateId: 'builtin:engagement', mode: 'merge' })
    expect(merged.project.roles.length).toBeGreaterThan(replaced.project.roles.length)
    expect(merged.project.roles.filter((r) => r.reportsTo === null)).toHaveLength(1)
  })

  it('rolesForNewProject and forRun accept them', () => {
    const svc = service()
    const p = make('New', { roles: engagementRoles(contexts.anthropic).slice(0, 1) })
    expect(svc.rolesForNewProject(p, 'builtin:code').roles.map((r) => r.slug).sort()).toEqual(CODE_SLUGS)
    const run = svc.forRun('builtin:engagement', p)
    expect(run?.name).toBe('Engagement team')
    expect(run?.roles.length).toBe(engagementRoles().length)
    expect(svc.forRun('builtin:nope', p)).toBeNull()
  })

  it('are not offered to the practice kit (readForKit has no file for them)', () => {
    expect(service().readForKit('builtin:code')).toBeNull()
  })
})

describe('template id arguments at the host boundary', () => {
  it('accept the two built-in ids exactly, besides saved ids', () => {
    for (const id of ['builtin:code', 'builtin:engagement', 'tpl_abc123']) expect(templateEngagementArgs.templateId(id)).toBe(id)
    expect(templateEngagementArgs.applyTemplate({ projectId: 'proj_1', templateId: 'builtin:code', mode: 'replace' })).toEqual({ projectId: 'proj_1', templateId: 'builtin:code', mode: 'replace' })
    for (const bad of ['builtin:', 'builtin:other', 'builtin:code ', 'BUILTIN:CODE', 'x:code', '../x', '', 5, null]) {
      expect(() => templateEngagementArgs.templateId(bad)).toThrow('Template not found')
    }
  })
})

describe('TemplateService.duplicate', () => {
  it('copies a built-in as a saved template named "<name> copy", with no apply count', () => {
    const svc = service()
    const copy = svc.duplicate('builtin:code')
    expect(copy).toMatchObject({ name: 'Code team copy', kind: 'code', roleCount: svc.listWithBuiltIns()[0].roleCount })
    expect(copy.id).toMatch(/^tpl_/)
    expect(copy.builtIn).toBeUndefined()
    expect(copy.appliedCount).toBeUndefined()
    expect(svc.listWithBuiltIns().map((t) => t.id)).toEqual(['builtin:code', 'builtin:engagement', copy.id])
    // The copy is a real saved template: it applies and can be removed.
    const target = make('Target')
    stored.push(target)
    expect(svc.apply({ projectId: target.id, templateId: copy.id, mode: 'replace' }).project.roles.map((r) => r.slug).sort()).toEqual(CODE_SLUGS)
    expect(svc.remove(copy.id)).toEqual([])
  })

  it('copies a saved template, keeping description and kind, and cuts a long name to the limit', () => {
    const src = make('Study', { kind: 'engagement' })
    stored.push(src)
    const svc = service()
    const long = svc.saveFromProject({ projectId: src.id, name: 'n'.repeat(80), description: 'Why it exists' })
    const copy = svc.duplicate(long.id)
    expect(copy.name.length).toBeLessThanOrEqual(80)
    expect(copy.name.endsWith(' copy')).toBe(true)
    expect(copy).toMatchObject({ description: 'Why it exists', kind: 'engagement', roleCount: long.roleCount })
    expect(copy.id).not.toBe(long.id)
    expect(svc.duplicate(copy.id).name.length).toBeLessThanOrEqual(80)
  })

  it('refuses an unknown id and the cap, saving nothing', () => {
    const svc = service()
    expect(() => svc.duplicate('tpl_none')).toThrow('Template not found')
    expect(() => svc.duplicate('../x')).toThrow('Template not found')
    expect(() => svc.duplicate('builtin:nope')).toThrow('Template not found')
    mkdirSync(join(dataDir, 'org-templates'), { recursive: true })
    writeFileSync(indexFile(), JSON.stringify({ version: 1, templates: fullIndex() }))
    expect(() => svc.duplicate('builtin:code')).toThrow(/at most 100/)
    expect(svc.list().filter((t) => !t.builtIn)).toHaveLength(ORG_TEMPLATES_MAX)
  })
})

describe('TemplateService appliedCount', () => {
  it('starts missing (unknown), then counts every successful apply of a saved template', () => {
    const src = make('Source')
    const target = make('Target')
    stored.push(src, target)
    const svc = service()
    const { id } = svc.saveFromProject({ projectId: src.id, name: 'T' })
    expect(svc.list().find((t) => t.id === id)?.appliedCount).toBeUndefined()
    svc.apply({ projectId: target.id, templateId: id, mode: 'replace' })
    expect(svc.list().find((t) => t.id === id)?.appliedCount).toBe(1)
    svc.apply({ projectId: target.id, templateId: id, mode: 'merge' })
    expect(service().list().find((t) => t.id === id)?.appliedCount).toBe(2)
  })

  it('does not count a refused apply', () => {
    const src = make('Source')
    stored.push(src)
    const svc = service()
    const { id } = svc.saveFromProject({ projectId: src.id, name: 'T' })
    expect(() => svc.apply({ projectId: 'nope', templateId: id, mode: 'replace' })).toThrow()
    expect(() => svc.apply({ projectId: src.id, templateId: id, mode: 'add' as 'merge' })).toThrow()
    expect(() => svc.apply({ projectId: src.id, templateId: 'tpl_none', mode: 'replace' })).toThrow()
    expect(svc.list().find((t) => t.id === id)?.appliedCount).toBeUndefined()
  })

  it('counts built-in applies in the index and keeps them across saves and removals', () => {
    const src = make('Source')
    const target = make('Target')
    stored.push(src, target)
    const svc = service()
    svc.apply({ projectId: target.id, templateId: 'builtin:code', mode: 'replace' })
    svc.apply({ projectId: target.id, templateId: 'builtin:code', mode: 'replace' })
    const later = svc.saveFromProject({ projectId: src.id, name: 'Later' })
    svc.remove(later.id)
    const list = service().listWithBuiltIns()
    expect(list.find((t) => t.id === 'builtin:code')?.appliedCount).toBe(2)
    expect(list.find((t) => t.id === 'builtin:engagement')?.appliedCount).toBeUndefined()
    const index = JSON.parse(readFileSync(indexFile(), 'utf8')) as { builtInApplied: Record<string, number>; templates: unknown[] }
    expect(index.builtInApplied).toEqual({ 'builtin:code': 2 })
    expect(index.templates).toEqual([])
  })

  it('keeps a stored count through a kit replace and ignores junk counts', () => {
    const src = make('Source')
    const target = make('Target')
    stored.push(src, target)
    const svc = service()
    const { id } = svc.saveFromProject({ projectId: src.id, name: 'T' })
    svc.apply({ projectId: target.id, templateId: id, mode: 'replace' })
    const kit = svc.readForKit(id)!
    expect(svc.saveFromKit({ name: 'T2', description: '', kind: 'code', orgText: kit.orgText }, id).appliedCount).toBe(1)
    const index = JSON.parse(readFileSync(indexFile(), 'utf8')) as { templates: Record<string, unknown>[] }
    index.templates[0].appliedCount = -3
    ;(index as Record<string, unknown>).builtInApplied = { 'builtin:code': 'many', 'builtin:other': 4, 'builtin:engagement': 1.5 }
    writeFileSync(indexFile(), JSON.stringify(index))
    const list = service().listWithBuiltIns()
    expect(list.find((t) => t.id === id)?.appliedCount).toBeUndefined()
    expect(list.filter((t) => t.builtIn).every((t) => t.appliedCount === undefined)).toBe(true)
  })

  // Several orgai sessions on one data folder (docs/design/cli-sessions.md): the count is read, changed and rewritten
  // under the data folder's write lock, like every other change to the index.
  it('counts an apply under the write lock: it waits for a session that is writing, and never breaks the apply', () => {
    const target = make('Target')
    stored.push(target)
    const handle = registerSession(dataDir, { hostInstanceId: 'aaaaaaaaaaaa', pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: '/work/a', command: 'tui' })
    const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0, waitMs: 80 })
    const off = enableStoreSync(dataDir, sync)
    try {
      const svc = service()
      const other = trySyncLock(writeLockPath(dataDir))
      try {
        // The apply itself is saved; its count is skipped with a warning rather than written without the lock.
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(svc.apply({ projectId: target.id, templateId: 'builtin:code', mode: 'replace' }).project.id).toBe(target.id)
        expect(svc.listWithBuiltIns()[0].appliedCount).toBeUndefined()
      } finally {
        other?.release()
      }
      svc.apply({ projectId: target.id, templateId: 'builtin:code', mode: 'replace' })
      expect(svc.listWithBuiltIns()[0].appliedCount).toBe(1)
    } finally {
      off()
      sync.close()
      handle.release()
    }
  })

  it('duplicates under the write lock too (the source cannot go between its read and the copy)', () => {
    const handle = registerSession(dataDir, { hostInstanceId: 'bbbbbbbbbbbb', pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: '/work/b', command: 'tui' })
    const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0, waitMs: 80 })
    const off = enableStoreSync(dataDir, sync)
    try {
      const svc = service()
      const other = trySyncLock(writeLockPath(dataDir))
      try {
        expect(() => svc.duplicate('builtin:code')).toThrow(/stayed held/)
      } finally {
        other?.release()
      }
      expect(svc.duplicate('builtin:code').name).toBe('Code team copy')
    } finally {
      off()
      sync.close()
      handle.release()
    }
  })
})
