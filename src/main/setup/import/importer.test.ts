import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, OPENAI_PLACEHOLDER_MODELS, defaultTierModels, newProject } from '@shared/defaults'
import type { ConnectionId, Project } from '@shared/types'
import { HARNESS_PROJECT_ID } from '@shared/types'
import { forgetAgentFolders, isPickedAgentFolder, rememberAgentFolder } from '../../agentFolderPicks'
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
    const s = service([p])
    const { digest } = s.preview({ projectId: p.id, mode: 'replace' })
    expect(() => s.apply({ projectId: p.id, mode: 'replace', digest })).toThrow(/nothing to import/)
  })

  it('apply refuses without a digest', () => {
    put('.claude/agents/designer.md', claude('designer'))
    const p = make()
    const s = service([p])
    expect(() => s.apply({ projectId: p.id, mode: 'replace' } as never)).toThrow(/Preview the import/)
    expect(() => s.apply({ projectId: p.id, mode: 'replace', digest: '' })).toThrow(/Preview the import/)
    expect(() => s.apply({ projectId: p.id, mode: 'replace', digest: 42 } as never)).toThrow(/Preview the import/)
    expect(saved).toEqual([])
  })

  it('scan and pathCheckExtras ignore relative paths', () => {
    put('.claude/agents/a.md', claude('a'))
    const s = service([])
    const check = { exists: true, isDirectory: true, isGitRepo: false, suggestedName: 'repo', empty: false }
    const prev = process.cwd()
    process.chdir(base)
    try {
      expect(s.scan('repo')).toEqual({ sources: [], instructionFiles: [], warnings: [] })
      expect(s.pathCheckExtras('repo', check)).toEqual({})
    } finally {
      process.chdir(prev)
    }
  })

  it('maps models to the project connection and sets the adapter', () => {
    put('.claude/agents/orchestrator.md', claude('orchestrator', 'opus'))
    put('.claude/agents/helper.md', claude('helper', 'claude-haiku-4-5'))
    const p = make()
    p.provider = { ...p.provider, connection: 'openai' }
    const s = service([p])
    const { digest } = s.preview({ projectId: p.id, mode: 'replace' })
    const out = s.apply({ projectId: p.id, mode: 'replace', digest })
    expect(out.project.provider.id).toBe('codex')
    expect(out.project.roles.map((r) => r.model).sort()).toEqual(['gpt-5', 'gpt-5-nano'])
  })

  it('validates project ids and refuses the harness project and relative paths', () => {
    const p = make()
    const rel = make({ path: 'relative/dir' })
    const s = service([p, rel])
    expect(() => s.preview({ projectId: '../x', mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: HARNESS_PROJECT_ID, mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: 'quick', mode: 'merge' })).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: 'skills', mode: 'merge' })).toThrow(/Project not found/)
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

describe('AgentImportService: another folder or project (UI overhaul)', () => {
  const PICK = /Choose the folder with the folder picker first\./
  let other: string
  beforeEach(() => {
    other = join(base, 'other')
    mkdirSync(join(other, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(other, '.claude', 'agents', 'designer.md'), claude('designer', 'opus'))
  })
  const desktop = (picked: string[] = []) => ({ surface: 'desktop' as const, isPickedFolder: (p: string) => picked.includes(p) })

  it('refuses a sourcePath the window did not pick', () => {
    const p = make()
    const s = service([p])
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, desktop())).toThrow(PICK)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, desktop([join(base, 'elsewhere')]))).toThrow(PICK)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: '' }, desktop(['']))).toThrow(PICK)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: 7 as never }, desktop(['7']))).toThrow(PICK)
    expect(() => s.apply({ projectId: p.id, mode: 'merge', sourcePath: other, digest: 'd' }, desktop())).toThrow(PICK)
    expect(saved).toEqual([])
  })

  it('refuses a sourcePath picked by another window (the check is per sender)', () => {
    const p = make()
    const s = service([p])
    rememberAgentFolder(101, other)
    const access = (senderId: number) => ({ surface: 'desktop' as const, isPickedFolder: (path: string) => isPickedAgentFolder(senderId, path) })
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, access(202))).toThrow(PICK)
    expect(s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, access(101)).items).toHaveLength(1)
    forgetAgentFolders(101)
  })

  it('scans a picked folder instead of the project folder, with the digest, choices and undo flow', () => {
    put('.claude/agents/own.md', claude('own'))
    const p = make()
    const s = service([p])
    const access = desktop([other])
    const preview = s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, access)
    expect(preview.items.map((i) => i.name)).toEqual(['designer'])
    expect(saved).toEqual([])
    const out = s.apply({ projectId: p.id, mode: 'merge', sourcePath: other, digest: preview.digest }, access)
    expect(out.previousRoles).toBe(p.roles)
    expect(out.project.roles.map((r) => r.slug)).toContain('designer')
    expect(out.project.roles.map((r) => r.slug)).not.toContain('own')
    // The folder changed after the preview: refused.
    writeFileSync(join(other, '.claude', 'agents', 'designer.md'), claude('designer', 'opus', 'Different.'))
    expect(() => s.apply({ projectId: p.id, mode: 'merge', sourcePath: other, digest: preview.digest }, access)).toThrow(/changed since the preview/)
    // A picked folder needs no folder on the target project.
    const bare = make({ id: 'p_bare', path: '' })
    expect(service([bare]).preview({ projectId: bare.id, mode: 'merge', sourcePath: other }, access).items).toHaveLength(1)
  })

  it('refuses sourcePath and fromProjectId on the socket and inproc surfaces, and when no access is given', () => {
    const p = make()
    const from = make({ id: 'p_from', name: 'From' })
    const s = service([p, from])
    for (const surface of ['socket', 'inproc'] as const) {
      const access = { surface, isPickedFolder: () => true }
      expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other }, access)).toThrow(/desktop app only/)
      expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: from.id }, access)).toThrow(/desktop app only/)
      expect(() => s.apply({ projectId: p.id, mode: 'merge', fromProjectId: from.id, digest: 'd' }, access)).toThrow(/desktop app only/)
    }
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other })).toThrow(/desktop app only/)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: from.id })).toThrow(/desktop app only/)
  })

  it('refuses both fields together, even on the desktop', () => {
    const p = make()
    const from = make({ id: 'p_from', name: 'From' })
    const s = service([p, from])
    expect(() => s.preview({ projectId: p.id, mode: 'merge', sourcePath: other, fromProjectId: from.id }, desktop([other]))).toThrow(/not both/)
    expect(() => s.apply({ projectId: p.id, mode: 'merge', sourcePath: other, fromProjectId: from.id, digest: 'd' }, desktop([other]))).toThrow(/not both/)
  })

  it('refuses fromProjectId that is the target, unknown or virtual', () => {
    const p = make()
    const s = service([p])
    expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: p.id }, desktop())).toThrow(/different project/)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: 'p_nope' }, desktop())).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: HARNESS_PROJECT_ID }, desktop())).toThrow(/Project not found/)
    expect(() => s.preview({ projectId: p.id, mode: 'merge', fromProjectId: 42 as never }, desktop())).toThrow(/Project not found/)
  })

  it("imports another project's roles as source orgai without MCP or skill grants, mapped to the target connection", () => {
    const src = make({ id: 'p_from', name: 'Source team', path: join(base, 'nowhere') })
    const roles = src.roles.map((r, i) => (i === 1 ? { ...r, name: 'Granted', slug: 'granted', mcpServers: ['mcp_1'], skills: ['sk_1'], knowledgeWrite: false, maxConcurrent: 3 } : r))
    const from: Project = { ...src, roles }
    const target = make({ id: 'p_to', provider: { ...make().provider, connection: 'openai', id: 'codex' } })
    const s = service([target, from])
    const preview = s.preview({ projectId: target.id, mode: 'replace', fromProjectId: from.id }, desktop())
    expect(preview.items.length).toBe(from.roles.length)
    expect(preview.items.every((i) => i.source === 'orgai')).toBe(true)
    expect(preview.items.some((i) => i.name === 'Granted')).toBe(true)
    expect(preview.roles.every((r) => !r.mcpServers?.length && !r.skills?.length)).toBe(true)
    // Models are the target connection's (its catalog, or inherit), not the source's Claude ids.
    const catalog = new Set(OPENAI_PLACEHOLDER_MODELS.map((m) => m.id))
    expect(preview.roles.every((r) => r.model === 'inherit' || catalog.has(r.model))).toBe(true)
    expect(saved).toEqual([])
    const out = s.apply({ projectId: target.id, mode: 'replace', fromProjectId: from.id, digest: preview.digest }, desktop())
    expect(out.project.roles).toHaveLength(from.roles.length)
    expect(out.project.id).toBe(target.id)
    expect(out.project.roles.every((r) => !r.mcpServers?.length && !r.skills?.length)).toBe(true)
    expect(out.previousRoles).toBe(target.roles)
    // Only the target is saved; the source project is untouched.
    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe(target.id)
  })

  it('a stale digest after the source project changed is refused', () => {
    const p = make()
    const from = make({ id: 'p_from', name: 'From' })
    const s = service([p, from])
    const { digest } = s.preview({ projectId: p.id, mode: 'merge', fromProjectId: from.id }, desktop())
    from.roles = from.roles.map((r) => ({ ...r, prompt: `${r.prompt} changed` }))
    expect(() => s.apply({ projectId: p.id, mode: 'merge', fromProjectId: from.id, digest }, desktop())).toThrow(/changed since the preview/)
  })
})
