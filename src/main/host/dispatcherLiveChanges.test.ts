import { describe, expect, it, vi } from 'vitest'
import { IPC, MCP_SCOPE_IPC } from '@shared/types'
import type { LiveRunChange, McpServerSpec, Project, SkillSpec } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices

const DESKTOP = { surface: 'desktop' as const, senderId: 1 }
const INPROC = { surface: 'inproc' as const }
const SOCKET = { surface: 'socket' as const }

const server = (id: string, name: string, over: Partial<McpServerSpec> = {}): McpServerSpec => ({ id, name, transport: 'stdio', command: 'x', ...over }) as McpServerSpec
const skill = (id: string, name: string, over: Partial<SkillSpec> = {}): SkillSpec => ({ id, name, description: 'd', enabled: true, source: 'local', ...over }) as SkillSpec

const CANNED: LiveRunChange[] = [{ runId: 'run_1', outcome: 'now' } as unknown as LiveRunChange]

interface Call {
  projectId: string
  saved: Project
  change: unknown
  opts: unknown
  /** The stored project when the call happened (shows when it ran relative to the save). */
  storedAtCall: Project | undefined
}

function rig(answer: () => Promise<LiveRunChange[]> = async () => CANNED) {
  const store: Project[] = [makeProject({ id: 'proj_a', mcpServers: [server('mcp_old', 'old-srv')], skills: [skill('sk_old', 'old-skill')] })]
  const calls: Call[] = []
  const reads: Array<{ id: string; at: string }> = []
  let step = 'start'
  /** What ProjectStore.baseOf answers: the version the request was made from, or null when it is not remembered. */
  let baseAnswer: Project | null = null
  const setBase = (p: Project | null): void => void (baseAnswer = p)
  const current = (): Project => store[0]
  const set = (patch: Partial<Project>): Project => {
    store[0] = { ...store[0], ...patch }
    return store[0]
  }
  const runs = {
    applyProjectChange: vi.fn(async (projectId: string, saved: Project, change: unknown, opts: unknown) => {
      calls.push({ projectId, saved, change, opts, storedAtCall: store[0] })
      return answer()
    })
  }
  const projects = {
    get: (id: string) => {
      reads.push({ id, at: step })
      return store.find((p) => p.id === id) ?? null
    },
    list: () => store,
    baseOf: vi.fn((_p: Project): Project | null => baseAnswer),
    // The save ingests team files inside the service: the stored project gains a grant the request never named.
    saveFromRenderer: vi.fn((p: Project) => {
      step = 'saved'
      return set({ ...p, mcpServers: store[0].mcpServers, skills: store[0].skills, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: [...(r.mcpServers ?? []), 'mcp_ingested'] } : r)) })
    })
  }
  const mcp = {
    upsert: vi.fn((i: { spec: McpServerSpec }) => ({ project: set({ mcpServers: [...store[0].mcpServers!.filter((s) => s.id !== i.spec.id), i.spec] }), servers: [] })),
    remove: vi.fn((i: { serverId: string }) => ({ project: set({ mcpServers: store[0].mcpServers!.filter((s) => s.id !== i.serverId) }), servers: [] })),
    linkLibrary: vi.fn((i: { libraryId: string }) => ({ project: set({ mcpServers: [...store[0].mcpServers!, server('mcp_new', 'linked-srv', { libraryId: i.libraryId })] }), servers: [] })),
    setProjectOverrides: vi.fn(() => ({ project: store[0], servers: [] })),
    libraryEntries: vi.fn((): unknown[] => [])
  }
  const skillsSvc = {
    list: vi.fn(() => []),
    create: vi.fn((i: { draft: { name: string } }) => ({ project: set({ skills: [...store[0].skills!, skill('sk_new', i.draft.name)] }), skills: [] })),
    update: vi.fn((i: { skillId: string }) => ({ project: set({ skills: store[0].skills!.map((s) => (s.id === i.skillId ? { ...s, name: 'renamed' } : s)) }), skills: [] })),
    remove: vi.fn((i: { skillId: string }) => ({ project: set({ skills: store[0].skills!.filter((s) => s.id !== i.skillId) }), skills: [] })),
    linkLibrary: vi.fn((i: { libraryId: string }) => ({ project: set({ skills: [...store[0].skills!, skill('sk_lib', 'lib-skill', { libraryId: i.libraryId })] }), skills: [] }))
  }
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/tmp/orgai-live-changes', set: vi.fn() }
  const services: HostServices = {
    projects: projects as never,
    runs: runs as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: mcp as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    importer: {} as never,
    skills: skillsSvc as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: { displayProject: () => makeProject({ id: 'quick', roles: [] }) } as never,
    templates: { list: () => [] } as never
  }
  const d = new HostDispatcher(services)
  const call = (channel: string, input: unknown, ctx: typeof DESKTOP | typeof INPROC | typeof SOCKET = DESKTOP): Promise<any> => Promise.resolve(d.invoke(channel, [input], ctx))
  /** The handler's own return value (a promise only when the handler is asynchronous). */
  const raw = (channel: string, input: unknown, ctx: typeof DESKTOP | typeof INPROC | typeof SOCKET): unknown => d.invoke(channel, [input], ctx)
  return { call, raw, setBase, runs, calls, store, projects, mcp, skillsSvc, reads, current, services }
}

const P = 'proj_a'

describe('desktop saves reach live runs (applyProjectChange)', () => {
  it('projects:save reads the stored project before the save and passes it with the request', async () => {
    const r = rig()
    const request = { ...r.store[0], brief: 'edited' }
    const out = await r.call(IPC.projectsSave, request)
    expect(out.brief).toBe('edited')
    expect(out.liveRuns).toBeUndefined()
    expect(r.calls).toHaveLength(1)
    const c = r.calls[0]
    expect(c.projectId).toBe(P)
    expect(c.opts).toEqual({ source: 'user' })
    const change = c.change as { kind: string; before: Project; request: Project }
    expect(change.kind).toBe('projectSave')
    expect(change.request).toBe(request)
    // The ingest added a grant during the save; `before` is the pre-save project, `saved` carries it.
    expect(change.before.roles[0].mcpServers ?? []).not.toContain('mcp_ingested')
    expect(c.saved.roles[0].mcpServers).toContain('mcp_ingested')
    expect(r.reads.some((x) => x.id === P && x.at === 'start')).toBe(true)
  })

  it('third review: projects:save returns the saved project, with a rename\'s server roles and the new id grants (the renderer can replace its copy)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ProjectStore } = await import('../store/projects')
    const dir = mkdtempSync(join(tmpdir(), 'orgai-save-return-'))
    try {
      const real = new ProjectStore(join(dir, 'data'))
      real.save(makeProject({ id: P, mcpServers: [server('m-docs', 'docs', { roles: ['engineer', 'reviewer'] })] }))
      const r = rig()
      const d = new HostDispatcher({ ...r.services, projects: real as never })
      const request = { ...real.get(P)!, roles: real.get(P)!.roles.map((x) => (x.id === 'r-eng' ? { ...x, name: 'Builder', slug: 'builder' } : x)) }
      const out = (await d.invoke(IPC.projectsSave, [request], DESKTOP)) as Project
      expect(out.mcpServers![0].roles).toEqual(['reviewer'])
      expect(out.roles.find((x) => x.id === 'r-eng')!.mcpServers).toEqual(['m-docs'])
      expect(out).toEqual(real.get(P))
      // The live-run route gets the same saved project.
      expect(r.calls[0].saved).toEqual(out)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("third review: a stale whole-spec mcp:upsert drops exactly the renamed role's old slug, keeps other unheld slugs, and ends the carry", async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ProjectStore } = await import('../store/projects')
    const dir = mkdtempSync(join(tmpdir(), 'orgai-stale-upsert-'))
    try {
      const real = new ProjectStore(join(dir, 'data'))
      real.save(makeProject({ id: P, mcpServers: [server('m-docs', 'docs', { roles: ['engineer', 'ghost'] })] }))
      const stale = structuredClone(real.get(P)!.mcpServers![0])
      const r = rig()
      const mcp = { ...r.services.mcp, upsert: (i: { spec: McpServerSpec }) => ({ project: real.save({ ...real.get(P)!, mcpServers: real.get(P)!.mcpServers!.map((s) => (s.id === i.spec.id ? i.spec : s)) }), servers: [] }) }
      const d = new HostDispatcher({ ...r.services, projects: real as never, mcp: mcp as never })
      const renamed = { ...real.get(P)!, roles: real.get(P)!.roles.map((x) => (x.id === 'r-eng' ? { ...x, name: 'Builder', slug: 'builder' } : x)) }
      await d.invoke(IPC.projectsSave, [renamed], DESKTOP)
      expect(real.get(P)!.mcpServers![0].roles).toEqual(['ghost'])
      // The renderer's copy from before the rename revokes Builder (revokePlan: roles minus "builder", then the id grant).
      await d.invoke(IPC.mcpUpsert, [{ projectId: P, spec: { ...stale, roles: ['engineer', 'ghost'] } }], DESKTOP)
      expect(real.get(P)!.mcpServers![0].roles).toEqual(['ghost'])
      const cur = real.get(P)!
      await d.invoke(IPC.projectsSave, [{ ...cur, roles: cur.roles.map((x) => (x.id === 'r-eng' ? { ...x, mcpServers: [] } : x)) }], DESKTOP)
      expect(real.get(P)!.roles.find((x) => x.id === 'r-eng')!.mcpServers).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('projects:save does not fail when applyProjectChange rejects', async () => {
    const r = rig(async () => {
      throw new Error('boom')
    })
    const out = await r.call(IPC.projectsSave, { ...r.store[0], brief: 'kept' })
    expect(out.brief).toBe('kept')
    expect(r.projects.saveFromRenderer).toHaveBeenCalledTimes(1)
  })

  it('a save error stays the save error and applyProjectChange is not called', async () => {
    const r = rig()
    r.projects.saveFromRenderer.mockImplementation(() => {
      throw new Error('bad project')
    })
    // A sync throw stays sync (the desktop path keeps sync semantics).
    expect(() => r.call(IPC.projectsSave, { ...r.store[0] })).toThrow('bad project')
    expect(r.runs.applyProjectChange).not.toHaveBeenCalled()
  })

  /** The change's `before`: a copy of the stored project as it was before the save (review M1). */
  const beforeOf = (r: ReturnType<typeof rig>, i = 0): Project => (r.calls[i].change as { before: Project }).before
  const startProject = (r: ReturnType<typeof rig>): Project => r.calls[0].storedAtCall!

  it('mcp:upsert names the saved server, passes a copy of the project read before the save, and names no grants', async () => {
    const r = rig()
    const original = r.store[0]
    const out = await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_a', 'alpha') })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].change).toEqual({ kind: 'mcp', ids: ['mcp_a'], names: ['alpha'], label: 'the MCP server alpha', before: original, fields: ['id', 'name', 'transport', 'command'] })
    expect(beforeOf(r)).not.toBe(original)
    expect(beforeOf(r).mcpServers?.map((s) => s.id)).toEqual(['mcp_old'])
    expect(startProject(r).mcpServers?.map((s) => s.id)).toContain('mcp_a')
    expect('grants' in (r.calls[0].change as object)).toBe(false)
    expect(r.calls[0].saved.mcpServers?.map((s) => s.id)).toContain('mcp_a')
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('mcp:upsert of a stored server limits fields to the spec and the stored keys (a key left out is cleared)', async () => {
    const r = rig()
    r.store[0] = { ...r.store[0], mcpServers: [server('mcp_old', 'old-srv', { args: ['a'] })] }
    await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_old', 'old-srv', { env: { A: 'b' } }) })
    expect((r.calls[0].change as { fields: string[] }).fields.sort()).toEqual(['args', 'command', 'env', 'id', 'name', 'transport'])
  })

  it('review L4: mcp:upsert of a library-linked server leaves out library fields the input did not change against the entry', async () => {
    const r = rig()
    r.store[0] = { ...r.store[0], mcpServers: [server('mcp_old', 'old-srv', { args: ['v1'], libraryId: 'lib1', source: 'library', enabled: true })] }
    r.mcp.libraryEntries.mockReturnValue([{ id: 'lib1', name: 'old-srv', transport: 'stdio', command: 'x', args: ['v2'] }])
    // The Settings form sends the linked server back with the library's values and a new enabled flag.
    await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_old', 'old-srv', { args: ['v2'], libraryId: 'lib1', source: 'library', enabled: false }) })
    expect((r.calls[0].change as { fields: string[] }).fields.sort()).toEqual(['enabled', 'id', 'libraryId', 'source'])
    // A library field the input really changed still counts.
    await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_old', 'old-srv', { args: ['mine'], libraryId: 'lib1', source: 'library', enabled: false }) })
    expect((r.calls[1].change as { fields: string[] }).fields).toContain('args')
  })

  it('mcp:remove takes the name from the project as it was before', async () => {
    const r = rig()
    const out = await r.call(IPC.mcpRemove, { projectId: P, serverId: 'mcp_old' })
    expect(r.calls[0].change).toMatchObject({ kind: 'mcp', ids: ['mcp_old'], names: ['old-srv'], label: 'the MCP server old-srv', fields: [] })
    expect(beforeOf(r).mcpServers?.map((s) => s.id)).toEqual(['mcp_old'])
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('mcp:remove falls back to the id when the server was unknown', async () => {
    const r = rig()
    await r.call(IPC.mcpRemove, { projectId: P, serverId: 'mcp_zzz' })
    expect(r.calls[0].change).toMatchObject({ ids: ['mcp_zzz'], names: ['mcp_zzz'] })
  })

  it('mcp:linkLibrary names the new server and the library id', async () => {
    const r = rig()
    const out = await r.call(IPC.mcpLinkLibrary, { projectId: P, libraryId: 'lib_1' })
    expect(r.calls[0].change).toMatchObject({ kind: 'mcp', ids: ['mcp_new', 'lib_1'], names: ['linked-srv'], label: 'the MCP server linked-srv' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('L1: mcp:linkLibrary names its own link, never another new server the same save brought in', async () => {
    const r = rig()
    r.mcp.linkLibrary.mockImplementation((i: { libraryId: string }) => ({
      project: (r.store[0] = { ...r.store[0], mcpServers: [...r.store[0].mcpServers!, server('mcp_other', 'gate-approved', { libraryId: 'lib_other' }), server('mcp_new', 'linked-srv', { libraryId: i.libraryId })] }),
      servers: []
    }))
    await r.call(IPC.mcpLinkLibrary, { projectId: P, libraryId: 'lib_1' })
    expect(r.calls[0].change).toMatchObject({ ids: ['mcp_new', 'lib_1'], names: ['linked-srv'] })
  })

  it('mcp:setProjectOverrides names the server and only the override maps the input gave', async () => {
    const r = rig()
    const out = await r.call(MCP_SCOPE_IPC.mcpSetProjectOverrides, { projectId: P, serverId: 'mcp_old', env: { A: 'b' } })
    expect(r.calls[0].change).toMatchObject({ kind: 'mcp', ids: ['mcp_old'], names: ['old-srv'], label: 'the MCP server old-srv', fields: ['envOverrides'] })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:create names the new skill and its roleIds as the complete grant set', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsCreate, { projectId: P, draft: { name: 'fresh', description: 'd', body: 'b' }, roleIds: ['r1'] })
    expect(r.calls[0].change).toMatchObject({ kind: 'skills', ids: ['sk_new'], names: ['fresh'], label: 'the skill fresh', grants: [{ item: 'sk_new', roleIds: ['r1'] }] })
    expect(beforeOf(r).skills?.map((s) => s.id)).toEqual(['sk_old'])
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('L1: skills:create names the skill it created, never another new skill the same save brought in first', async () => {
    const r = rig()
    r.skillsSvc.create.mockImplementation((i: { draft: { name: string } }) => ({
      project: (r.store[0] = { ...r.store[0], skills: [...r.store[0].skills!, skill('sk_pulled', 'pulled'), skill('sk_new', i.draft.name)] }),
      skills: []
    }))
    await r.call(IPC.skillsCreate, { projectId: P, draft: { name: 'fresh', description: 'd', body: 'b' } })
    expect(r.calls[0].change).toMatchObject({ ids: ['sk_new'], names: ['fresh'] })
  })

  it('skills:update names the skill before and after; enabled only = fields enabled; roleIds = grants', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsUpdate, { projectId: P, skillId: 'sk_old', enabled: false })
    expect(r.calls[0].change).toMatchObject({ kind: 'skills', ids: ['sk_old'], names: ['old-skill', 'renamed'], label: 'the skill old-skill', fields: ['enabled'] })
    expect('grants' in (r.calls[0].change as object)).toBe(false)
    expect(out.liveRuns).toEqual(CANNED)
    await r.call(IPC.skillsUpdate, { projectId: P, skillId: 'sk_old', roleIds: ['r2'] })
    expect(r.calls[1].change).toMatchObject({ fields: [], grants: [{ item: 'sk_old', roleIds: ['r2'] }] })
    await r.call(IPC.skillsUpdate, { projectId: P, skillId: 'sk_old', draft: { name: 'old-skill', description: 'x', body: 'b' } })
    expect('fields' in (r.calls[2].change as object)).toBe(false)
  })

  it('skills:remove takes the name from before', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsRemove, { projectId: P, skillId: 'sk_old' })
    expect(r.calls[0].change).toMatchObject({ kind: 'skills', ids: ['sk_old'], names: ['old-skill'], label: 'the skill old-skill', fields: [] })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:linkLibrary names the library id and the new skill', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsLinkLibrary, { projectId: P, libraryId: 'lib_9', roleIds: ['r1'] })
    expect(r.calls[0].change).toMatchObject({ kind: 'skills', ids: ['lib_9', 'sk_lib'], names: ['lib-skill'], label: 'the skill lib-skill', grants: [{ item: 'sk_lib', roleIds: ['r1'] }] })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('L1: skills:linkLibrary names its own link, never another new linked skill of the same save', async () => {
    const r = rig()
    r.skillsSvc.linkLibrary.mockImplementation((i: { libraryId: string }) => ({
      project: (r.store[0] = { ...r.store[0], skills: [...r.store[0].skills!, skill('sk_x', 'other', { libraryId: 'lib_x' }), skill('sk_lib', 'lib-skill', { libraryId: i.libraryId })] }),
      skills: []
    }))
    await r.call(IPC.skillsLinkLibrary, { projectId: P, libraryId: 'lib_9' })
    expect(r.calls[0].change).toMatchObject({ ids: ['lib_9', 'sk_lib'], names: ['lib-skill'] })
  })

  it('clamps long names in the label to 80 characters', async () => {
    const r = rig()
    const long = 'n'.repeat(120)
    await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_long', long) })
    const label = (r.calls[0].change as { label: string }).label
    expect(label.length).toBeLessThanOrEqual('the MCP server '.length + 80)
    expect(label.startsWith('the MCP server nnn')).toBe(true)
  })

  it('adds no liveRuns field when the answer is empty', async () => {
    const r = rig(async () => [])
    const out = await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_a', 'alpha') })
    expect(r.calls).toHaveLength(1)
    expect('liveRuns' in out).toBe(false)
  })

  it('a rejecting applyProjectChange leaves the mutation result intact', async () => {
    const r = rig(async () => {
      throw new Error('boom')
    })
    const out = await r.call(IPC.skillsRemove, { projectId: P, skillId: 'sk_old' })
    expect(out.project.skills.map((s: SkillSpec) => s.id)).not.toContain('sk_old')
    expect('liveRuns' in out).toBe(false)
  })
})

const CHANNELS = [
  [IPC.projectsSave, (r: ReturnType<typeof rig>) => ({ ...r.store[0], brief: 'x' })],
  [IPC.mcpUpsert, () => ({ projectId: P, spec: server('mcp_a', 'alpha') })],
  [IPC.mcpRemove, () => ({ projectId: P, serverId: 'mcp_old' })],
  [IPC.mcpLinkLibrary, () => ({ projectId: P, libraryId: 'lib_1' })],
  [MCP_SCOPE_IPC.mcpSetProjectOverrides, () => ({ projectId: P, serverId: 'mcp_old', env: { A: 'b' } })],
  [IPC.skillsCreate, () => ({ projectId: P, draft: { name: 'fresh', description: 'd', body: 'b' } })],
  [IPC.skillsUpdate, () => ({ projectId: P, skillId: 'sk_old', enabled: false })],
  [IPC.skillsRemove, () => ({ projectId: P, skillId: 'sk_old' })],
  [IPC.skillsLinkLibrary, () => ({ projectId: P, libraryId: 'lib_9' })]
] as const
const ITEM_CHANNELS = CHANNELS.filter(([channel]) => channel !== IPC.projectsSave)
const isPromise = (v: unknown): boolean => typeof (v as { then?: unknown } | null)?.then === 'function'

describe('other surfaces never call applyProjectChange', () => {
  it.each(CHANNELS)('%s on a socket surface answers synchronously and adds nothing', (channel, input) => {
    const r = rig()
    const value = r.raw(channel, input(r), SOCKET)
    // The handler's own value: wrapping it in Promise.resolve would hide a handler that became asynchronous.
    expect(isPromise(value)).toBe(false)
    expect(r.runs.applyProjectChange).not.toHaveBeenCalled()
    expect(!!value && typeof value === 'object' && 'liveRuns' in value).toBe(false)
  })

  it.each(ITEM_CHANNELS)("%s on the terminal's own surface answers synchronously and adds nothing", (channel, input) => {
    const r = rig()
    const value = r.raw(channel, input(r), INPROC)
    expect(isPromise(value)).toBe(false)
    expect(r.runs.applyProjectChange).not.toHaveBeenCalled()
    expect(!!value && typeof value === 'object' && 'liveRuns' in value).toBe(false)
  })
})

describe("the terminal's own orgai process: a project save the user typed", () => {
  it('passes the change with the version the request was made from, never the stored project', async () => {
    const r = rig()
    const base = { ...structuredClone(r.store[0]), brief: 'the version the user edited' }
    r.setBase(base)
    const request = { ...r.store[0], brief: 'x' }
    await r.call(IPC.projectsSave, request, INPROC)
    expect(r.projects.baseOf).toHaveBeenCalledTimes(1)
    expect(r.calls).toHaveLength(1)
    const change = r.calls[0].change as { kind: string; before: Project; request: Project }
    expect(change.kind).toBe('projectSave')
    expect(change.before).toBe(base)
    expect(change.request).toEqual(request)
    expect(r.calls[0].opts).toEqual({ source: 'user' })
    // The stored project is never read for the comparison on this surface.
    expect(r.reads.filter((x) => x.at === 'start')).toEqual([])
  })

  it('a copy whose version this process no longer remembers reaches no live run', () => {
    const r = rig()
    r.setBase(null)
    const value = r.raw(IPC.projectsSave, { ...r.store[0], brief: 'x' }, INPROC)
    expect(isPromise(value)).toBe(false)
    expect(r.runs.applyProjectChange).not.toHaveBeenCalled()
  })
})
