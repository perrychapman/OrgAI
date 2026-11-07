import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Project, RunSummary, ProjectPeek, Proposal, QuickRunInfo, RunEvent, SkillsProposalPayload } from '@shared/types'
import { DEFAULT_APP_SETTINGS, defaultConnections } from '@shared/defaults'
import { harnessProject } from '../mcp/assist'
import { RunManager, resolveAllowedDirectories, type RunManagerOptions } from './runManager'
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
  // Real path: macOS /var -> /private/var and the Windows 8.3 temp spelling differ from the lexical one,
  // and RunManager reports real paths.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-rma-')))
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
    // Chat may ask for a run-only server (see "Chat asks instead of being unable"); it never gets the MCP library.
    expect(ctx.requestMcpInstall).toBeTypeOf('function')
    // Quick runs never get the library (skill reads need the skillAssist option, tested below).
    expect(ctx.mcpLibrary).toBeUndefined()
    expect(ctx.skillCatalog).toBeUndefined()
    expect(ctx.readSkill).toBeUndefined()
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

  it('turns plan nudges off for a single-assistant Chat and keeps them for the default team (UX M5)', async () => {
    const { m, ctxs } = rig()
    await m.start({ project: quickProj({ autoContinue: true }), prompt: 'a', quick: quickInfo({ team: 'single' }) })
    await m.start({ project: quickProj({ autoContinue: true }), prompt: 'b', quick: quickInfo({ team: 'default' }) })
    await m.start({ project: makeProject({ path: folder(), autoContinue: true }), prompt: 'c' })
    expect(ctxs.map((c) => c.autoContinue)).toEqual([false, true, true])
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
    expect(setup.raw.applyProposal).toHaveBeenCalledWith('real', expect.objectContaining({ kind: 'skills' }), { projectOnly: false })
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
      const resolved = events.filter((e) => e.type === 'permission.resolved' && e.runId === run.id).at(-1)
      expect(resolved).toEqual({ type: 'permission.resolved', runId: run.id, requestId: req.request.id, scope: 'session' })
      expect(req.request.maxScope).toBe('session')
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
    writeFileSync(join(ws, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }))
    expect(listRules(ws)).toContain('Bash(npm test:*)')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(ctxs[0].allowedRules?.()).not.toContain('Bash(npm test:*)')
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

describe('Chat asks instead of being unable', () => {
  const SESSION_EDIT = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const
  type PermReq = Extract<RunEvent, { type: 'permission.request' }>
  const lastReq = (runId: string): PermReq => events.filter((e) => e.type === 'permission.request' && e.runId === runId).at(-1) as PermReq
  const harnessRows = (runId: string): string[] =>
    events.flatMap((e) => (e.type === 'transcript' && e.runId === runId && e.entry.source === 'harness' && e.entry.block.kind === 'system' ? [e.entry.block.text] : []))

  async function quickRun(opts: { allowEdits?: boolean; rigOptions?: RunManagerOptions } = {}) {
    const r = rig(opts.rigOptions ?? {}, { live: true })
    const qf = folder()
    const run = await r.m.start({ project: quickProj({ path: qf }), prompt: 'q', quick: quickInfo({ folder: qf, allowEdits: opts.allowEdits === true }) })
    return { ...r, run, qf, ctx: r.ctxs[0] }
  }

  describe('quickReadOnly, maxScope and workingFolder on permission requests', () => {
    it('flags an edit or command on a read-only-start quick run, not a read', async () => {
      const { ctx, run, qf } = await quickRun()
      void ctx.requestPermission({ agentId: 'root', toolName: 'Edit', input: {}, summary: 'e' })
      expect(lastReq(run.id).request).toMatchObject({ quickReadOnly: true, maxScope: 'session', workingFolder: qf })
      expect(lastReq(run.id).request.workingFolderScratch).toBeUndefined()
      void ctx.requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'b' })
      expect(lastReq(run.id).request.quickReadOnly).toBe(true)
      void ctx.requestPermission({ agentId: 'root', toolName: 'Read', input: {}, summary: 'r' })
      expect(lastReq(run.id).request.quickReadOnly).toBeUndefined()
    })

    it('does not flag with allowEdits true, and marks a scratch folder', async () => {
      const r = rig({}, { live: true })
      const qf = folder()
      const run = await r.m.start({ project: quickProj({ path: qf }), prompt: 'q', quick: quickInfo({ folder: qf, allowEdits: true, scratch: true }) })
      void r.ctxs[0].requestPermission({ agentId: 'root', toolName: 'Edit', input: {}, summary: 'e' })
      const req = lastReq(run.id).request
      expect(req.quickReadOnly).toBeUndefined()
      expect(req.workingFolderScratch).toBe(true)
    })

    it('drops adapter-sent values on a normal run and sets maxScope once for a reference folder', async () => {
      const r = rig({}, { live: true })
      const run = await r.m.start({ project: makeProject({ path: folder() }), prompt: 'x' })
      void r.ctxs[0].requestPermission({ agentId: 'root', toolName: 'Edit', input: {}, summary: 'e', quickReadOnly: true, maxScope: 'once', workingFolder: '/x', workingFolderScratch: true })
      const req = lastReq(run.id).request
      expect(req.quickReadOnly).toBeUndefined()
      expect(req.maxScope).toBeUndefined()
      expect(req.workingFolder).toBeUndefined()
      expect(req.workingFolderScratch).toBeUndefined()
      void r.ctxs[0].requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'b', referenceFolder: '/ref' })
      expect(lastReq(run.id).request.maxScope).toBe('once')
    })
  })

  describe('session edit grant', () => {
    const editReq = (qf: string, over: Record<string, unknown> = {}) => ({ agentId: 'root', toolName: 'Edit', input: { file_path: join(qf, 'a.txt') }, summary: 'e', suggestions: [SESSION_EDIT], ...over })

    it('sets quickSessionEdits after a session allow of a covered edit, with one harness row', async () => {
      const { m, ctx, run, qf } = await quickRun()
      expect(ctx.quickSessionEdits?.()).toBe(false)
      const p = ctx.requestPermission(editReq(qf) as never)
      m.decide(run.id, lastReq(run.id).request.id, { behavior: 'allow', scope: 'session' })
      await p
      expect(ctx.quickSessionEdits?.()).toBe(true)
      expect(harnessRows(run.id)).toEqual(["You allowed edits in this chat's folder for this chat."])
    })

    it('a project answer is resolved as session and saves nothing', async () => {
      const { m, ctx, run, qf } = await quickRun()
      const p = ctx.requestPermission(editReq(qf) as never)
      const id = lastReq(run.id).request.id
      m.decide(run.id, id, { behavior: 'allow', scope: 'project' })
      expect(await p).toEqual({ behavior: 'allow', scope: 'session' })
      expect(events.filter((e) => e.type === 'permission.resolved').at(-1)).toEqual({ type: 'permission.resolved', runId: run.id, requestId: id, scope: 'session' })
      expect(existsSync(join(qf, '.claude', 'settings.local.json'))).toBe(false)
      expect(ctx.quickSessionEdits?.()).toBe(true)
    })

    it('stays off after once, deny, an outside path or a card without the suggestion', async () => {
      const { m, ctx, run, qf } = await quickRun()
      const answer = async (req: ReturnType<typeof editReq>, d: Parameters<typeof m.decide>[2]) => {
        const p = ctx.requestPermission(req as never)
        m.decide(run.id, lastReq(run.id).request.id, d)
        await p
      }
      await answer(editReq(qf), { behavior: 'allow', scope: 'once' })
      await answer(editReq(qf), { behavior: 'deny', message: 'no' })
      await answer(editReq(qf, { input: { file_path: join(dir, 'elsewhere.txt') } }), { behavior: 'allow', scope: 'session' })
      await answer(editReq(qf, { suggestions: undefined }), { behavior: 'allow', scope: 'session' })
      expect(ctx.quickSessionEdits?.()).toBe(false)
    })

    it('writes a harness row naming the rule labels, else the tool, for another session allow', async () => {
      const { m, ctx, run } = await quickRun()
      const p1 = ctx.requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'b', ruleLabels: ['npm test', 'npm run lint'] })
      m.decide(run.id, lastReq(run.id).request.id, { behavior: 'allow', scope: 'session' })
      await p1
      const p2 = ctx.requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'b' })
      m.decide(run.id, lastReq(run.id).request.id, { behavior: 'allow', scope: 'session' })
      await p2
      expect(harnessRows(run.id)).toEqual(['You allowed npm test, npm run lint for this chat.', 'You allowed Bash for this chat.'])
      expect(ctx.quickSessionEdits?.()).toBe(false)
    })

    it('strips hidden characters from adapter rule labels in the harness row', async () => {
      const { m, ctx, run } = await quickRun()
      const p = ctx.requestPermission({ agentId: 'root', toolName: 'Bash', input: {}, summary: 'b', ruleLabels: ['npm‮ test​'] })
      m.decide(run.id, lastReq(run.id).request.id, { behavior: 'allow', scope: 'session' })
      await p
      const rows = harnessRows(run.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).not.toMatch(/[‮​]/)
      expect(rows[0]).toContain('npm')
    })

    it('has no flag on a normal run and the flag does not carry to a continuation', async () => {
      const r = rig({}, { live: true })
      await r.m.start({ project: makeProject({ path: folder() }), prompt: 'x' })
      expect(r.ctxs[0].quickSessionEdits).toBeUndefined()
    })
  })

  describe('MCP installs on a quick run', () => {
    const spec = () => ({ id: 'mcp-q', name: 'docs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg@1.2.3'], enabled: true, source: 'agent' as const, addedAt: '2026-01-01T00:00:00.000Z' })
    const mcpOptions = () => {
      const persistInstall = vi.fn()
      return { persistInstall, mcp: { enabledServers: vi.fn(() => []), resolve: vi.fn(), persistInstall, searchRegistry: vi.fn() } as never }
    }
    type InstallReq = Extract<RunEvent, { type: 'mcpInstall.request' }>
    const lastInstall = (runId: string): InstallReq => events.filter((e) => e.type === 'mcpInstall.request' && e.runId === runId).at(-1) as InstallReq

    it.each(['project', 'library'] as const)('marks the card runOnly with the caller role and lands a %s approval as run', async (scope) => {
      const { persistInstall, mcp } = mcpOptions()
      const { m, ctx, run } = await quickRun({ rigOptions: { mcp } })
      expect(ctx.requestMcpInstall).toBeTypeOf('function')
      const rootSlug = ctx.roles.find((r) => r.reportsTo === null)!.slug
      ctx.emit({ type: 'agent.upsert', runId: run.id, agent: { id: 'root', roleId: null, roleSlug: rootSlug, name: 'Root', parentId: null, spawnToolUseId: null, state: 'working', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0 } as never })
      const pending = ctx.requestMcpInstall!({ agentId: 'root', reason: 'need docs', spec: { ...spec(), roles: ['everything'] }, requiredSecrets: [] })
      const card = lastInstall(run.id).request
      expect(card.runOnly).toBe(true)
      expect(card.spec.roles).toEqual([rootSlug])
      m.answerMcpInstall(run.id, card.id, { approved: true, scope, spec: { ...card.spec, roles: ['someone-else'] } })
      expect(await pending).toMatchObject({ approved: true, scope: 'run' })
      expect(persistInstall).not.toHaveBeenCalled()
      expect(ctx.mcpServers?.().map((s) => s.name)).toEqual(['docs'])
      expect(ctx.mcpServers?.()[0].roles).toEqual([rootSlug])
    })

    it('an unknown caller gets nobody, never the root role', async () => {
      const { mcp } = mcpOptions()
      const { m, ctx, run } = await quickRun({ rigOptions: { mcp } })
      const pending = ctx.requestMcpInstall!({ agentId: 'ghost-agent', reason: 'r', spec: { ...spec(), roles: ['everything'] }, requiredSecrets: [] })
      const card = lastInstall(run.id).request
      expect(card.spec.roles).toEqual([])
      m.answerMcpInstall(run.id, card.id, { approved: true, scope: 'run', spec: { ...card.spec, roles: ['someone-else'] } })
      await pending
      expect(ctx.mcpServers?.()[0].roles).toEqual([])
    })

    it('an adapter-sent runOnly is dropped on a normal run', async () => {
      const { mcp } = mcpOptions()
      const r = rig({ mcp }, { live: true })
      const run = await r.m.start({ project: makeProject({ path: folder() }), prompt: 'x' })
      void r.ctxs[0].requestMcpInstall!({ agentId: 'root', reason: 'r', spec: spec(), requiredSecrets: [], runOnly: true })
      expect(lastInstall(run.id).request.runOnly).toBeUndefined()
    })

    it('harness and skills sessions still have no install hook', async () => {
      const { mcp } = mcpOptions()
      const r = rig({ mcp, skillAssist: { catalog: () => ({ library: [], project: [] }), read: () => null } }, { live: true })
      await r.m.start({ project: makeProject({ id: 'skills', roles: [], path: folder() }), prompt: 'x', kind: 'skill-assist' })
      const ws = join(dir, 'data', 'quick', 'quick_build2')
      mkdirSync(ws, { recursive: true })
      await r.m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
      expect(r.ctxs[0].requestMcpInstall).toBeUndefined()
      expect(r.ctxs[1].requestMcpInstall).toBeUndefined()
    })
  })

  it('gives quick runs library-only skill reads and others none', async () => {
    const cat = vi.fn(() => ({ library: [], project: [] }))
    const read = vi.fn(() => null)
    const { ctx } = await quickRun({ rigOptions: { skillAssist: { catalog: cat, read } } })
    ctx.skillCatalog?.()
    expect(cat).toHaveBeenCalledWith(null)
    ctx.readSkill?.({ libraryId: 'lib1' })
    expect(read).toHaveBeenCalledWith(null, { libraryId: 'lib1' })
  })
})

describe('allowed folders and permission hooks', () => {
  const mk = (name: string): string => {
    const p = join(dir, name)
    mkdirSync(p, { recursive: true })
    return p
  }
  const warnings = (): string[] => events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.level === 'warn').map((e) => e.message)
  /** A fake save option over one in-memory project (mirrors ProjectStore.update: appends, never drops). */
  function saver(p: Project) {
    let stored = p
    const save = vi.fn((_id: string, patch: { addDirectories?: string[]; acceptEdits?: true }) => {
      stored = {
        ...stored,
        ...(patch.addDirectories ? { allowedDirectories: [...(stored.allowedDirectories ?? []), ...patch.addDirectories] } : {}),
        ...(patch.acceptEdits ? { permissionMode: 'acceptEdits' as const } : {})
      }
      return stored
    })
    return { save, get: () => stored }
  }

  it('resolves existing folders at start, warns once for a missing one, keeps the project and data dir out', async () => {
    const repo = mk('repo')
    const shared = mk('shared')
    const data = join(dir, 'data')
    mkdirSync(join(data, 'inner'), { recursive: true })
    const gone = join(dir, 'gone')
    const p = makeProject({ path: repo, allowedDirectories: [shared, shared, gone, join(repo, 'sub'), data, join(data, 'inner'), dir] })
    mkdirSync(join(repo, 'sub'), { recursive: true })
    const { m, ctxs } = rig({ dataDir: data }, { live: true })
    await m.start({ project: p, prompt: 'go' })
    const dirs = ctxs[0].allowedDirectories!()
    expect(dirs).toHaveLength(1)
    expect(dirs[0].toLowerCase()).toBe(shared.toLowerCase())
    expect(warnings().filter((w) => w.includes('does not exist'))).toEqual([`Allowed folder ${gone} does not exist; agents cannot use it in this run.`])
    // the list is a copy
    dirs.push('x')
    expect(ctxs[0].allowedDirectories!()).toHaveLength(1)
    await m.stopAll()
  })

  it('allowDirectories saves through the option, updates the list at once and broadcasts the project', async () => {
    const repo = mk('repo')
    const extra = mk('extra')
    const p = makeProject({ path: repo })
    const s = saver(p)
    const { m, ctxs } = rig({ dataDir: join(dir, 'data'), saveProjectPermissions: s.save }, { live: true })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    expect(ctx.allowedDirectories!()).toEqual([])
    const inForce = ctx.allowDirectories!([extra, join(dir, 'nope')])
    expect(s.save).toHaveBeenCalledWith(p.id, { addDirectories: [extra, join(dir, 'nope')] })
    expect(inForce).toHaveLength(1)
    expect(inForce[0].toLowerCase()).toBe(extra.toLowerCase())
    expect(ctx.allowedDirectories!().map((d) => d.toLowerCase())).toEqual([extra.toLowerCase()])
    expect(events.some((e) => e.type === 'project.updated')).toBe(true)
    expect(events.some((e) => e.type === 'log' && e.level === 'info' && e.message.startsWith('Allowed folders for this project:'))).toBe(true)
    // the live project follows, with the run's canonical path kept
    expect(ctx.project.allowedDirectories).toEqual([extra, join(dir, 'nope')])
    await m.stopAll()
  })

  it('acceptEditsForProject switches only from default', async () => {
    for (const mode of ['auto', 'plan', 'dontAsk', 'bypassPermissions', 'acceptEdits'] as const) {
      const p = makeProject({ path: mk('repo'), permissionMode: mode })
      const s = saver(p)
      const { m, ctxs } = rig({ saveProjectPermissions: s.save }, { live: true })
      await m.start({ project: p, prompt: 'go' })
      expect(ctxs[0].acceptEditsForProject!()).toBe(false)
      expect(s.save).not.toHaveBeenCalled()
      await m.stopAll()
    }
    const p = makeProject({ path: mk('repo2'), permissionMode: 'default' })
    const s = saver(p)
    const { m, ctxs } = rig({ saveProjectPermissions: s.save }, { live: true })
    await m.start({ project: p, prompt: 'go' })
    expect(ctxs[0].acceptEditsForProject!()).toBe(true)
    expect(ctxs[0].project.permissionMode).toBe('acceptEdits')
    expect(ctxs[0].acceptEditsForProject!()).toBe(false)
    expect(s.save).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'log' && e.message === 'Permission mode set to Accept edits for this project.')).toBe(true)
    await m.stopAll()
  })

  it('acceptEditsForProject returns false and stays quiet when the store declined the switch', async () => {
    const p = makeProject({ path: mk('repo'), permissionMode: 'default' })
    const save = vi.fn(() => p)
    const { m, ctxs } = rig({ saveProjectPermissions: save }, { live: true })
    await m.start({ project: p, prompt: 'go' })
    expect(ctxs[0].acceptEditsForProject!()).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'project.updated')).toBe(false)
    expect(events.some((e) => e.type === 'log' && e.message === 'Permission mode set to Accept edits for this project.')).toBe(false)
    await m.stopAll()
  })

  it('exposes the data folder (both spellings, deduped) as protectedDirectories on every run, restricted included', async () => {
    const data = join(dir, 'data')
    mkdirSync(data, { recursive: true })
    const { m, ctxs } = rig({ dataDir: data }, { live: true })
    await m.start({ project: makeProject({ path: mk('repo') }), prompt: 'go' })
    await m.start({ project: quickProj({}), prompt: 'q', quick: quickInfo() })
    expect(ctxs).toHaveLength(2)
    for (const c of ctxs) {
      const prot = c.protectedDirectories!()
      expect(prot.length).toBeGreaterThanOrEqual(1)
      expect(prot.length).toBeLessThanOrEqual(2)
      expect(new Set(prot).size).toBe(prot.length)
      expect(prot[0]).toBe(data)
    }
    const none = rig({}, { live: true })
    await none.m.start({ project: makeProject({ path: mk('repo3') }), prompt: 'go' })
    expect(none.ctxs[0].protectedDirectories!()).toEqual([])
    await none.m.stopAll()
    await m.stopAll()
  })

  it('drops too-broad folders (home, one holding the project, inside home config) with one warning each', async () => {
    const home = mk('home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const repo = join(home, 'work', 'repo')
    mkdirSync(repo, { recursive: true })
    const fine = mk('fine')
    const direct = resolveAllowedDirectories([home, join(home, 'work'), join(home, '.ssh'), fine], { projectPath: repo, home })
    expect(direct.dirs).toHaveLength(1)
    expect(direct.unsafe).toEqual([home, join(home, 'work'), join(home, '.ssh')])
    expect(direct.dropped).toEqual(direct.unsafe)
    const { m } = rig({}, { live: true })
    await m.start({ project: makeProject({ path: repo, allowedDirectories: [dir, join(dir, 'home', 'work')] }), prompt: 'go' })
    const broad = warnings().filter((w) => w.includes('too broad or sensitive'))
    expect(broad).toHaveLength(2)
    expect(broad[0]).toContain(dir)
    await m.stopAll()
  })

  it('has no hooks without the save option, but still lists folders', async () => {
    const shared = mk('shared')
    const { m, ctxs } = rig({}, { live: true })
    await m.start({ project: makeProject({ path: mk('repo'), allowedDirectories: [shared] }), prompt: 'go' })
    expect(ctxs[0].allowedDirectories!()).toHaveLength(1)
    expect(ctxs[0].allowDirectories).toBeUndefined()
    expect(ctxs[0].acceptEditsForProject).toBeUndefined()
    await m.stopAll()
  })

  it('gives quick runs and build sessions no folders and no hooks', async () => {
    const shared = mk('shared')
    const s = saver(makeProject())
    const { m, ctxs } = rig({ saveProjectPermissions: s.save }, { live: true })
    await m.start({ project: quickProj({ allowedDirectories: [shared] }), prompt: 'q', quick: quickInfo() })
    const ws = mk('ws')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws, allowedDirectories: [shared] }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    expect(ctxs).toHaveLength(2)
    for (const c of ctxs) {
      expect(c.allowedDirectories).toBeUndefined()
      expect(c.allowDirectories).toBeUndefined()
      expect(c.acceptEditsForProject).toBeUndefined()
    }
    await m.stopAll()
  })
})
