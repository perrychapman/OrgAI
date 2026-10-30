import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, OPENAI_PLACEHOLDER_MODELS, defaultTierModels, newProject } from '@shared/defaults'
import type { ConnectionId, Project } from '@shared/types'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { AgentImportService } from './importer'
import type { ModelContext } from './model'

let base: string
let root: string
let saved: Project[]
let changed: Project[]

function put(rel: string, text: string): void {
  const p = join(root, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
const claude = (name: string, model = 'sonnet', prompt = `You are ${name}.`): string => `---\nname: ${name}\ndescription: ${name} role\nmodel: ${model}\n---\n${prompt}`

const contexts: Record<ConnectionId, ModelContext> = {
  anthropic: { connection: 'anthropic', catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) },
  openai: { connection: 'openai', catalog: OPENAI_PLACEHOLDER_MODELS, tierModels: defaultTierModels(OPENAI_PLACEHOLDER_MODELS) },
  litellm: { connection: 'litellm', catalog: [], tierModels: {} }
}

function service(projects: Project[]): AgentImportService {
  return new AgentImportService({
    projects: {
      get: (id) => projects.find((p) => p.id === id) ?? null,
      list: () => projects,
      save: (p) => {
        saved.push(p)
        return p
      }
    },
    modelContext: (id) => contexts[id],
    withAdapter: (p) => (p.provider.connection === 'openai' ? { ...p, provider: { ...p.provider, id: 'codex' } } : p),
    onProjectChanged: (p) => changed.push(p)
  })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orgai-importer-'))
  root = join(base, 'repo')
  mkdirSync(root)
  saved = []
  changed = []
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const make = (over: Partial<Project> = {}): Project => ({ ...newProject({ name: 'Shop', path: root, brief: '' }), ...over })

describe('AgentImportService', () => {
  it('scan never throws and summarises sources and instruction files', () => {
    put('.claude/agents/a.md', claude('a'))
    put('AGENTS.md', '# rules')
    const s = service([])
    const scan = s.scan(`"${root}"`)
    expect(scan.sources).toEqual([{ source: 'claude', label: 'Claude Code', files: ['.claude/agents/a.md'], agentCount: 1 }])
    expect(scan.instructionFiles).toEqual(['AGENTS.md'])
    expect(s.scan(undefined)).toEqual({ sources: [], instructionFiles: [], warnings: [] })
    expect(s.scan({ evil: true })).toEqual({ sources: [], instructionFiles: [], warnings: [] })
  })

  it('pathCheckExtras reports agent sources and an existing project at the same folder', () => {
    put('.claude/agents/a.md', claude('a'))
    const existing = make()
    const s = service([existing])
    const check = { exists: true, isDirectory: true, isGitRepo: false, suggestedName: 'repo', empty: false }
    expect(s.pathCheckExtras(`${root}/`, check)).toEqual({
      existingProjectId: existing.id,
      existingProjectName: 'Shop',
      agentSources: [{ source: 'claude', label: 'Claude Code', agentCount: 1 }]
    })
    expect(s.pathCheckExtras(join(base, 'missing'), { ...check, exists: false, isDirectory: false })).toEqual({})
  })

  it('preview saves nothing; apply recomputes from disk, saves, broadcasts and returns the previous roles', () => {
    put('.claude/agents/designer.md', claude('designer', 'opus'))
    const p = make()
    const s = service([p])
    const preview = s.preview({ projectId: p.id, mode: 'merge' })
    expect(saved).toEqual([])
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0]).toMatchObject({ model: 'opus', modelReason: 'kept', reportsTo: 'orchestrator' })
    const out = s.apply({ projectId: p.id, mode: 'merge', digest: preview.digest })
    expect(out.previousRoles).toBe(p.roles)
    expect(out.project.roles).toHaveLength(5)
    expect(saved).toHaveLength(1)
    expect(changed).toHaveLength(1)
  })

  it('apply refuses a folder that changed since the preview', () => {
    put('.claude/agents/designer.md', claude('designer'))
    const p = make()
    const s = service([p])
    const { digest } = s.preview({ projectId: p.id, mode: 'replace' })
    put('.claude/agents/designer.md', claude('designer', 'sonnet', 'Now do something else.'))
    expect(() => s.apply({ projectId: p.id, mode: 'replace', digest })).toThrow(/changed since the preview/)
    expect(saved).toEqual([])
  })

  it('apply refuses when nothing would be imported', () => {
    const p = make()
    expect(() => service([p]).apply({ projectId: p.id, mode: 'replace' })).toThrow(/nothing to import/)
  })

  it('maps models to the project connection and sets the adapter', () => {
    put('.claude/agents/orchestrator.md', claude('orchestrator', 'opus'))
    put('.claude/agents/helper.md', claude('helper', 'claude-haiku-4-5'))
    const p = make()
    p.provider = { ...p.provider, connection: 'openai' }
    const out = service([p]).apply({ projectId: p.id, mode: 'replace' })
    expect(out.project.provider.id).toBe('codex')
    expect(out.project.roles.map((r) => r.model).sort()).toEqual(['gpt-5', 'gpt-5-nano'])
  })

  it('validates project ids and refuses the harness project and relative paths', () => {
    const p = make()
    const rel = make({ path: 'relative/dir' })
    const s = service([p, rel])
    expect(() => s.preview({ projectId: '../x', mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: HARNESS_PROJECT_ID, mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: 'proj_unknown', mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.exportOrg(42)).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: rel.id, mode: 'merge' })).toThrow(/no folder/)
  })

  it('filters sources and ignores unknown ones', () => {
    put('.claude/agents/a.md', claude('a'))
    put('.codex/agents/b.toml', 'name = "b"\ndeveloper_instructions = "B"')
    const p = make()
    const preview = service([p]).preview({ projectId: p.id, mode: 'merge', sources: ['codex', 'bogus' as never] })
    expect(preview.items.map((i) => i.name)).toEqual(['b'])
  })

  it('rolesForNewProject replaces the default chart, or keeps it when nothing is found', () => {
    const p = make()
    const s = service([])
    expect(s.rolesForNewProject(p, ['claude'])).toBe(p)
    put('.claude/agents/lead.md', claude('lead', 'opus'))
    put('.claude/agents/dev.md', claude('dev'))
    const next = s.rolesForNewProject(p, ['claude'])
    expect(next.roles.map((r) => r.slug).sort()).toEqual(['dev', 'lead'])
    expect(next.roles.find((r) => r.slug === 'lead')?.reportsTo).toBeNull()
    expect(s.rolesForNewProject(p, 'claude')).toBe(p)
    expect(saved).toEqual([])
  })

  it('exportOrg writes into the stored project folder', () => {
    const p = make()
    expect(service([p]).exportOrg(p.id).path).toBe(join(root, '.orgai', 'org.json'))
  })
})
