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
    setProjectOverrides: vi.fn(() => ({ project: store[0], servers: [] }))
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
  const call = (channel: string, input: unknown, ctx: typeof DESKTOP | typeof INPROC = DESKTOP): Promise<any> => Promise.resolve(d.invoke(channel, [input], ctx))
  return { call, runs, calls, store, projects, mcp, skillsSvc, reads, current }
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

  it('mcp:upsert names the saved server', async () => {
    const r = rig()
    const out = await r.call(IPC.mcpUpsert, { projectId: P, spec: server('mcp_a', 'alpha') })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].change).toEqual({ kind: 'mcp', ids: ['mcp_a'], names: ['alpha'], label: 'the MCP server alpha' })
    expect(r.calls[0].saved.mcpServers?.map((s) => s.id)).toContain('mcp_a')
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('mcp:remove takes the name from the project as it was before', async () => {
    const r = rig()
    const out = await r.call(IPC.mcpRemove, { projectId: P, serverId: 'mcp_old' })
    expect(r.calls[0].change).toEqual({ kind: 'mcp', ids: ['mcp_old'], names: ['old-srv'], label: 'the MCP server old-srv' })
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
    expect(r.calls[0].change).toEqual({ kind: 'mcp', ids: ['mcp_new', 'lib_1'], names: ['linked-srv'], label: 'the MCP server linked-srv' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('mcp:setProjectOverrides names the server from the saved project', async () => {
    const r = rig()
    const out = await r.call(MCP_SCOPE_IPC.mcpSetProjectOverrides, { projectId: P, serverId: 'mcp_old', env: { A: 'b' } })
    expect(r.calls[0].change).toEqual({ kind: 'mcp', ids: ['mcp_old'], names: ['old-srv'], label: 'the MCP server old-srv' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:create names the new skill', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsCreate, { projectId: P, draft: { name: 'fresh', description: 'd', body: 'b' } })
    expect(r.calls[0].change).toEqual({ kind: 'skills', ids: ['sk_new'], names: ['fresh'], label: 'the skill fresh' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:update names the skill before and after', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsUpdate, { projectId: P, skillId: 'sk_old', enabled: false })
    expect(r.calls[0].change).toEqual({ kind: 'skills', ids: ['sk_old'], names: ['old-skill', 'renamed'], label: 'the skill old-skill' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:remove takes the name from before', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsRemove, { projectId: P, skillId: 'sk_old' })
    expect(r.calls[0].change).toEqual({ kind: 'skills', ids: ['sk_old'], names: ['old-skill'], label: 'the skill old-skill' })
    expect(out.liveRuns).toEqual(CANNED)
  })

  it('skills:linkLibrary names the library id and the new skill', async () => {
    const r = rig()
    const out = await r.call(IPC.skillsLinkLibrary, { projectId: P, libraryId: 'lib_9' })
    expect(r.calls[0].change).toEqual({ kind: 'skills', ids: ['lib_9', 'sk_lib'], names: ['lib-skill'], label: 'the skill lib-skill' })
    expect(out.liveRuns).toEqual(CANNED)
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

describe('other surfaces never call applyProjectChange', () => {
  it.each([
    [IPC.projectsSave, (r: ReturnType<typeof rig>) => ({ ...r.store[0], brief: 'x' })],
    [IPC.mcpUpsert, () => ({ projectId: P, spec: server('mcp_a', 'alpha') })],
    [IPC.mcpRemove, () => ({ projectId: P, serverId: 'mcp_old' })],
    [IPC.mcpLinkLibrary, () => ({ projectId: P, libraryId: 'lib_1' })],
    [MCP_SCOPE_IPC.mcpSetProjectOverrides, () => ({ projectId: P, serverId: 'mcp_old', env: { A: 'b' } })],
    [IPC.skillsCreate, () => ({ projectId: P, draft: { name: 'fresh', description: 'd', body: 'b' } })],
    [IPC.skillsUpdate, () => ({ projectId: P, skillId: 'sk_old', enabled: false })],
    [IPC.skillsRemove, () => ({ projectId: P, skillId: 'sk_old' })],
    [IPC.skillsLinkLibrary, () => ({ projectId: P, libraryId: 'lib_9' })]
  ] as const)('%s on the inproc surface is synchronous and adds nothing', (channel, input) => {
    const r = rig()
    const out = r.call(channel, input(r), INPROC)
    return out.then((value) => {
      expect(r.runs.applyProjectChange).not.toHaveBeenCalled()
      expect(value && typeof value === 'object' && 'liveRuns' in value).toBe(false)
    })
  })
})
