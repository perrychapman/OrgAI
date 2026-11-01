import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Project, RunSummary, ProjectPeek, Proposal, QuickRunInfo, RunEvent, SkillsProposalPayload } from '@shared/types'
import { DEFAULT_APP_SETTINGS, defaultConnections } from '@shared/defaults'
import { harnessProject } from '../mcp/assist'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import { addRules, listRules } from './permissionRules'
import { skillAssistContext } from '../skills/assist'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext, SkillAssistCatalog } from './types'
import { project as makeProject } from './testHelpers'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rma-'))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeSetup() {
  const raw = {
    applyProposal: vi.fn((_id: string, _p: Proposal) => makeProject({ id: 'real' })),
    applySkillsLibraryProposal: vi.fn(),
    applyLibraryProposal: vi.fn(),
    markScaffolded: vi.fn(),
    markArchitectureUpdated: vi.fn(),
    hiddenContext: vi.fn(() => 'profile')
  }
  return { service: raw as unknown as SetupService, raw }
}

/** An adapter that records every context and ends its session at once (or stays live). */
function rig(options: RunManagerOptions = {}, opts: { live?: boolean; id?: 'mock' | 'claude' } = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: opts.id ?? 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      if (!opts.live) ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: opts.live ? new Promise<void>(() => {}) : Promise.resolve() }
    }
  }
  const setup = fakeSetup()
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ [opts.id ?? 'mock']: adapter }, (e) => void events.push(e), store, setup.service, () => 100, options)
  return { m, ctxs, store, setup }
}

const folder = (): string => {
  const p = join(dir, 'work')
  mkdirSync(p, { recursive: true })
  return p
}

function quickInfo(over: Partial<QuickRunInfo> = {}): QuickRunInfo {
  return { folder: folder(), team: 'default', allowEdits: false, gitRepo: false, ...over }
}

function quickProj(over: Partial<Project> = {}): Project {
  return makeProject({ id: 'quick', name: 'Chat', path: folder(), runMessaging: false, ...over })
}

describe('virtual project start guards', () => {
  it('lets each virtual project run only its own kind', async () => {
    const { m } = rig()
    const harness = makeProject({ id: 'harness', roles: [] })
    const skillsP = makeProject({ id: 'skills', roles: [], path: folder() })
    await expect(m.start({ project: harness, prompt: 'x' })).rejects.toThrow(/MCP assistant/)
    await expect(m.start({ project: harness, prompt: 'x', kind: 'skill-assist' })).rejects.toThrow(/MCP assistant/)
    await expect(m.start({ project: skillsP, prompt: 'x' })).rejects.toThrow(/Skill assistant/)
    await expect(m.start({ project: skillsP, prompt: 'x', kind: 'mcp-assist' })).rejects.toThrow(/Skill assistant/)
    await expect(m.start({ project: quickProj(), prompt: 'x' })).rejects.toThrow(/quick run/)
    await expect(m.start({ project: quickProj(), prompt: 'x', kind: 'setup', quick: quickInfo() })).rejects.toThrow(/quick run/)
    await expect(m.start({ project: makeProject({ path: folder() }), prompt: 'x', quick: quickInfo() })).rejects.toThrow(/quick project only/)
    await expect(m.start({ project: makeProject({ path: folder() }), prompt: 'x', buildWorkspace: folder() })).rejects.toThrow(/MCP assistant/)
    expect((await m.start({ project: skillsP, prompt: 'x', kind: 'skill-assist' })).projectId).toBe('skills')
    expect((await m.start({ project: quickProj(), prompt: 'x', quick: quickInfo() })).projectId).toBe('quick')
  })

  it('refuses completions for every virtual project', async () => {
    const { m } = rig()
    for (const id of ['harness', 'quick', 'skills']) {
      await expect(m.completeForProject(makeProject({ id }), { system: 's', prompt: 'p', kind: 'skills', tier: 'fast' })).rejects.toThrow(/no model connection/)
    }
  })
})

describe('quick runs', () => {
  it('stores the quick info on the summary and keeps project extras out of the run', async () => {
    const listProjects = vi.fn((): ProjectPeek[] => [])
    const skills = { forRun: vi.fn(() => [{ id: 's', name: 's', description: 'd', dir: '/x', files: [], roleIds: [] }]) }
    const mcp = {
      enabledServers: vi.fn(() => [{ id: 'm' }] as never),
      resolve: vi.fn(),
      persistInstall: vi.fn(),
      searchRegistry: vi.fn()
    }
    const { m, ctxs, store } = rig({ listProjects, skills: skills as never, mcp: mcp as never })
    const info = quickInfo()
    const p = quickProj({ mcpServers: [{ id: 'm' } as never], plugins: [{ id: 'pl', enabled: true } as never] })
    const run = await m.start({ project: p, prompt: 'look around', quick: info })
    expect(run.quick).toEqual(info)
    expect(store.get(run.id)?.quick).toEqual(info)
    const ctx = ctxs[0]
    expect(ctx.mcpServers?.()).toEqual([])
    expect(ctx.plugins?.()).toEqual([])
    expect(ctx.skills?.()).toEqual([])
    expect(skills.forRun).not.toHaveBeenCalled()
    expect(ctx.requestMcpInstall).toBeUndefined()
    expect(ctx.listRuns?.()).toEqual([])
    expect(await ctx.messageRun?.('run-x', 'hi')).toMatchObject({ result: 'refused', refusal: 'not-work' })
    expect(ctx.listProjects).toBeTypeOf('function')
    expect(ctx.listProjects?.()).toEqual([])
    expect(listProjects).toHaveBeenCalled()
  })

  it('provides list_projects to quick runs only', async () => {
    const { m, ctxs } = rig({ listProjects: () => [] })
    await m.start({ project: makeProject({ path: folder() }), prompt: 'plain' })
    await m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
    expect(ctxs[0].listProjects).toBeUndefined()
    expect(ctxs[1].listProjects).toBeUndefined()
  })

  it('does not recreate a quick run folder that has gone', async () => {
    const { m } = rig()
    const gone = join(dir, 'gone-folder')
    const run = await m.start({ project: quickProj({ path: gone }), prompt: 'x', quick: quickInfo({ folder: gone }) })
    expect(m.summary(run.id)?.status).toBe('error')
    expect(m.summary(run.id)?.error).toMatch(/no longer exists/)
  })

  it('uses only the run grants as allowed rules and never writes a project-scope grant into the folder', async () => {
    const f = folder()
    addRules(f, ['Bash(ls:*)'])
    let asked: Promise<unknown> | undefined
    const { m, ctxs } = rig({}, { live: true })
    const run = await m.start({ project: quickProj({ path: f }), prompt: 'x', quick: quickInfo({ folder: f }) })
    expect(ctxs[0].allowedRules?.()).toEqual([]) // the folder's own rules file is untrusted
    asked = ctxs[0].requestPermissionRules?.({ agentId: 'root', rules: ['Bash(git status:*)'], reason: 'status' })
    const req = events.find((e): e is Extract<RunEvent, { type: 'rules.request' }> => e.type === 'rules.request')!
    m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
    expect(await asked).toEqual({ behavior: 'grant', scope: 'run' })
    expect(ctxs[0].allowedRules?.()).toEqual(['Bash(git status:*)'])
    expect(listRules(f)).toEqual(['Bash(ls:*)']) // untouched
  })

  it('still reads saved rules and saves project grants on a stored project', async () => {
    const f = folder()
    addRules(f, ['Bash(ls:*)'])
    const { m, ctxs } = rig({}, { live: true })
    const run = await m.start({ project: makeProject({ path: f }), prompt: 'x' })
    expect(ctxs[0].allowedRules?.()).toEqual(['Bash(ls:*)'])
    const asked = ctxs[0].requestPermissionRules?.({ agentId: 'root', rules: ['Bash(git status:*)'], reason: 'status' })
    const req = events.find((e): e is Extract<RunEvent, { type: 'rules.request' }> => e.type === 'rules.request')!
    m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
    expect(await asked).toEqual({ behavior: 'grant', scope: 'project' })
    expect(listRules(f)).toContain('Bash(git status:*)')
  })

  it('carries the quick info into continueRun and resumeNow', async () => {
    const info = quickInfo({ team: 'single', allowEdits: true })
    const p = quickProj()
    const quickProject = vi.fn(() => p)
    const { m, ctxs, store } = rig({ quickProject, resolveProject: () => undefined })
    const run = await m.start({ project: p, prompt: 'first', quick: info })
    const next = await m.continueRun(p, run.id, 'more')
    expect(next.quick).toEqual(info)
    expect(ctxs[1].resumeSessionId).toBe('s-1')
    // A paused quick run resumes through the quickProject option (resolveProject does not know the virtual id).
    store.upsert({ ...next, id: 'paused-1', status: 'paused', sessionId: 's-p', startedAt: next.startedAt + 1 })
    const resumed = await m.resumeNow('paused-1')
    expect(quickProject).toHaveBeenCalled()
    expect(resumed.quick).toEqual(info)
    expect(resumed.projectId).toBe('quick')
  })

  it('resolves the single assistant model with the everyday fallback and one warning', async () => {
    const connections = defaultConnections()
    connections.anthropic.tierModels = { everyday: 'claude-everyday-1', deep: 'claude-deep-1' }
    const settings = (quickRunModel: string) => ({ setupModel: 'deep', mcpAssistModel: 'deep', connections, quickRunModel }) as Pick<AppSettings, 'setupModel' | 'mcpAssistModel' | 'connections' | 'quickRunModel'>
    const single = (): Project =>
      quickProj({
        provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
        roles: [{ ...makeProject().roles[0], slug: 'assistant', name: 'Assistant', model: 'everyday', reportsTo: null, tools: ['Read'] }]
      })
    let current = 'everyday'
    const { m, ctxs } = rig({ appSettings: () => settings(current) }, { id: 'claude' })
    await m.start({ project: single(), prompt: 'a', quick: quickInfo({ team: 'single' }) })
    expect(ctxs[0].roles[0].model).toBe('claude-everyday-1')
    expect(events.some((e) => e.type === 'log' && e.level === 'warn')).toBe(false)
    current = 'gpt-5'
    const p2 = single()
    p2.roles[0] = { ...p2.roles[0], model: 'gpt-5' }
    await m.start({ project: p2, prompt: 'b', quick: quickInfo({ team: 'single' }) })
    expect(ctxs[1].roles[0].model).toBe('claude-everyday-1')
    const warns = events.filter((e) => e.type === 'log' && e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ message: expect.stringContaining('Chat model') })
  })

  it('leaves the default team and the mock adapter alone', async () => {
    const { m, ctxs } = rig({ appSettings: () => ({ setupModel: 'deep', mcpAssistModel: 'deep', connections: defaultConnections() }) })
    const p = quickProj()
    await m.start({ project: p, prompt: 'a', quick: quickInfo({ team: 'default' }) })
    expect(ctxs[0].roles.map((r) => r.model)).toEqual(p.roles.map((r) => r.model))
  })
})

describe('skill assistant runs', () => {
  const catalog: SkillAssistCatalog = { library: [], project: [] }

  it('runs the built-in role with the catalog as hidden context and library scope as null', async () => {
    const cat = vi.fn(() => catalog)
    const read = vi.fn(() => null)
    const { m, ctxs } = rig({ skillAssist: { catalog: cat, read } })
    const skillsP = makeProject({ id: 'skills', roles: [], path: folder() })
    const run = await m.start({ project: skillsP, prompt: 'review', kind: 'skill-assist' })
    expect(run.kind).toBe('skill-assist')
    const ctx = ctxs[0]
    expect(ctx.roles.map((r) => r.slug)).toEqual(['skill-assistant'])
    expect(cat).toHaveBeenCalledWith(null)
    expect(ctx.hiddenContext).toBe(skillAssistContext(skillsP, catalog))
    expect(ctx.skillCatalog?.()).toBe(catalog)
    ctx.readSkill?.({ libraryId: 'lib1' })
    expect(read).toHaveBeenCalledWith(null, { libraryId: 'lib1' })
    expect(ctx.mcpServers?.()).toEqual([])
    expect(ctx.requestMcpInstall).toBeUndefined()
  })

  it('scopes a project session to the project id and keeps an explicit hiddenContext', async () => {
    const cat = vi.fn(() => catalog)
    const { m, ctxs } = rig({ skillAssist: { catalog: cat, read: () => null } })
    const p = makeProject({ id: 'real', path: folder() })
    await m.start({ project: p, prompt: 'review', kind: 'skill-assist' })
    expect(cat).toHaveBeenCalledWith('real')
    await m.start({ project: p, prompt: 'review', kind: 'skill-assist', hiddenContext: 'mine' })
    expect(ctxs[1].hiddenContext).toBe('mine')
  })

  it('survives a failing catalog', async () => {
    const { m, ctxs } = rig({ skillAssist: { catalog: () => { throw new Error('boom') }, read: () => null } })
    await m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
    expect(ctxs[0].hiddenContext).toBeTypeOf('string')
  })

  const proposal = (): Omit<Proposal, 'id' | 'runId' | 'createdAt'> =>
    ({ agentId: 'root', title: 'Add one', kind: 'skills', payload: { items: [], rationale: 'r' } as SkillsProposalPayload }) as never

  it('applies library-scope skill proposals to the library and project-scope ones to the project', async () => {
    const { m, ctxs, setup } = rig({}, { live: true })
    const lib = await m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
    const pending = ctxs[0].requestProposal(proposal())
    const req = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request' && e.runId === lib.id)!
    m.decideProposal(lib.id, req.proposal.id, { behavior: 'approve' })
    expect(await pending).toEqual({ behavior: 'approve' })
    expect(setup.raw.applySkillsLibraryProposal).toHaveBeenCalledTimes(1)
    expect(setup.raw.applyProposal).not.toHaveBeenCalled()

    const proj = await m.start({ project: makeProject({ id: 'real', path: folder() }), prompt: 'x', kind: 'skill-assist' })
    const pending2 = ctxs[1].requestProposal(proposal())
    const req2 = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request' && e.runId === proj.id)!
    m.decideProposal(proj.id, req2.proposal.id, { behavior: 'approve' })
    expect(await pending2).toEqual({ behavior: 'approve' })
    expect(setup.raw.applyProposal).toHaveBeenCalledWith('real', expect.objectContaining({ kind: 'skills' }))
    expect(events.some((e) => e.type === 'project.updated' && e.runId === proj.id)).toBe(true)
  })

  it('answers REVISE when a proposal cannot be applied or is the wrong kind', async () => {
    const { m, ctxs, setup } = rig({}, { live: true })
    setup.raw.applySkillsLibraryProposal.mockImplementation(() => {
      throw new Error('nope')
    })
    const lib = await m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
    const pending = ctxs[0].requestProposal(proposal())
    const req = events.find((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request' && e.runId === lib.id)!
    m.decideProposal(lib.id, req.proposal.id, { behavior: 'approve' })
    expect(await pending).toMatchObject({ behavior: 'revise', feedback: expect.stringContaining('nope') })

    const other = ctxs[0].requestProposal({ agentId: 'root', title: 'x', kind: 'orgChart', payload: {} } as never)
    const req2 = events.filter((e): e is Extract<RunEvent, { type: 'proposal.request' }> => e.type === 'proposal.request').at(-1)!
    m.decideProposal(lib.id, req2.proposal.id, { behavior: 'approve' })
    expect(await other).toMatchObject({ behavior: 'revise' })
  })
})

describe('MCP assistant build workspace', () => {
  it('stores buildWorkspace and keeps it on continuations', async () => {
    const ws = folder()
    const { m, store } = rig()
    const harness = makeProject({ id: 'harness', roles: [], path: ws })
    const run = await m.start({ project: harness, prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(run.buildWorkspace).toBe(ws)
    expect(store.get(run.id)?.buildWorkspace).toBe(ws)
    const next = await m.continueRun(harness, run.id, 'more')
    expect(next.buildWorkspace).toBe(ws)
    const plain = await m.start({ project: harness, prompt: 'x', kind: 'mcp-assist' })
    expect(plain.buildWorkspace).toBeUndefined()
  })

  it('gives the MCP assistant Edit, Write and Bash only in an allowBuild harness project', async () => {
    const { m, ctxs } = rig()
    const settings = { ...DEFAULT_APP_SETTINGS, connections: defaultConnections() } as AppSettings
    const ws = join(dir, 'data', 'quick', 'quick_build1')
    mkdirSync(ws, { recursive: true })
    const build = harnessProject(settings, join(dir, 'data'), { mock: true, allowBuild: true, workspace: ws })
    expect(build.permissionMode).toBe('default')
    await m.start({ project: build, prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(ctxs[0].roles[0].tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']))
    const plain = harnessProject(settings, join(dir, 'data'), { mock: true })
    await m.start({ project: plain, prompt: 'x', kind: 'mcp-assist' })
    expect(ctxs[1].roles[0].tools).not.toContain('Bash')
    expect(ctxs[1].roles[0].tools).not.toContain('Edit')
  })
})

describe('cross-run messaging and virtual projects', () => {
  it('never lists or reaches a quick run from a project run', async () => {
    const { m, ctxs } = rig({ resolveProject: () => makeProject({ runMessaging: true }) }, { live: true })
    const a = await m.start({ project: makeProject({ path: folder(), runMessaging: true }), prompt: 'a' })
    const q = await m.start({ project: quickProj(), prompt: 'q', quick: quickInfo() })
    expect(ctxs[0].listRuns?.()).toEqual([])
    expect(await ctxs[0].messageRun?.(q.id, 'hi')).toMatchObject({ result: 'refused', refusal: 'not-work' })
    expect(a.id).not.toBe(q.id)
  })
})

describe('trust-restricted runs (quick runs and build sessions)', () => {
  async function restrictedRuns(m: ReturnType<typeof rig>['m']) {
    const ws = join(dir, 'data', 'quick', 'quick_build1')
    mkdirSync(ws, { recursive: true })
    const build = await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    const qf = folder()
    const q = await m.start({ project: quickProj({ path: qf }), prompt: 'q', quick: quickInfo({ folder: qf }) })
    return { build, q, ws, qf }
  }

  it('narrows a project-scope permission decision to the session and writes nothing', async () => {
    const { m, ctxs } = rig({}, { live: true })
    const { build, q, ws, qf } = await restrictedRuns(m)
    for (const [i, run, path] of [[0, build, ws], [1, q, qf]] as const) {
      const pending = ctxs[i].requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'x' })
      const req = events.filter((e) => e.type === 'permission.request' && e.runId === run.id).at(-1) as Extract<RunEvent, { type: 'permission.request' }>
      m.decide(run.id, req.request.id, { behavior: 'allow', scope: 'project' })
      expect(await pending).toEqual({ behavior: 'allow', scope: 'session' })
      expect(existsSync(join(path, '.claude', 'settings.local.json'))).toBe(false)
    }
  })

  it('keeps a project grant for an ordinary project run', async () => {
    const { m, ctxs } = rig({}, { live: true })
    await m.start({ project: makeProject({ path: folder() }), prompt: 'x' })
    const pending = ctxs[0].requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'x' })
    const req = events.find((e) => e.type === 'permission.request') as Extract<RunEvent, { type: 'permission.request' }>
    m.decide(req.runId, req.request.id, { behavior: 'allow', scope: 'project' })
    expect(await pending).toEqual({ behavior: 'allow', scope: 'project' })
  })

  it('allowedRules never reads the workspace rules file of a build session', async () => {
    const { m, ctxs } = rig({}, { live: true })
    const ws = join(dir, 'data', 'quick', 'quick_build2')
    mkdirSync(join(ws, '.claude'), { recursive: true })
    writeFileSync(join(ws, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }))
    expect(listRules(ws)).toContain('Bash')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(ctxs[0].allowedRules?.()).not.toContain('Bash')
  })

  it('a build session project-scope rule grant stays on the run', async () => {
    const { m, ctxs } = rig({}, { live: true })
    const { build, ws } = await restrictedRuns(m)
    void ctxs[0].requestPermissionRules?.({ agentId: 'root', rules: ['Bash(ls:*)'], reason: 'r' })
    const req = events.find((e) => e.type === 'rules.request' && e.runId === build.id) as Extract<RunEvent, { type: 'rules.request' }>
    m.decideRules(build.id, req.request.id, { behavior: 'grant', scope: 'project' })
    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(false)
    expect(ctxs[0].allowedRules?.()).toContain('Bash(ls:*)')
  })

  it('auto-resume rebuilds a build session through buildProject and fails when it throws', async () => {
    const ws = folder()
    const buildProject = vi.fn((): Project => {
      throw new Error("This build session's workspace is gone; start a new one.")
    })
    const { m, store } = rig({ buildProject })
    const run = await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    await vi.waitFor(() => expect(m.summaryOf(run.id)?.status ?? store.get(run.id)?.status).toBe('finished'))
    store.upsert({ ...(store.get(run.id) as RunSummary), status: 'paused' })
    await expect(m.resumeNow(run.id)).rejects.toThrow(/workspace is gone/)
    expect(buildProject).toHaveBeenCalled()
  })
})
