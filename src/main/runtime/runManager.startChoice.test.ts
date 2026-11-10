import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, McpServerSpec, PermissionMode, Project, ProviderId, ProviderModel, RunEvent, RunSummary } from '@shared/types'
import { PERMISSION_MODES, QUICK_PROJECT_ID } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { RunManager, checkStartChoice, checkStartEffort, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { project as makeProject, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-startchoice-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const model = (id: string, connection: string, adapter: ProviderId, family: ProviderModel['family'] = adapter === 'codex' ? 'openai' : 'claude'): ProviderModel => ({
  id,
  label: id,
  connection,
  family,
  adapter,
  source: 'builtin'
})

const CATALOG: ProviderModel[] = [
  model('claude-opus-4-5', 'anthropic', 'claude'),
  model('claude-sonnet-4-5', 'anthropic', 'claude'),
  model('mystery-model', 'anthropic', 'claude'),
  model('gpt-5', 'openai', 'codex')
]

/** The recording adapters: one per provider id, each remembering the contexts it started and the sessions it made. */
function rig(options: RunManagerOptions = {}) {
  const started: { adapter: ProviderId; ctx: RuntimeContext; session: RuntimeSession }[] = []
  const control: { setMode?: (mode: PermissionMode) => Promise<boolean> } = {}
  const make = (id: ProviderId): RuntimeAdapter => ({
    id,
    complete: async () => '',
    start: async (ctx) => {
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${started.length + 1}` })
      const session: RuntimeSession = {
        send: async () => {},
        interrupt: async () => {},
        stop: async () => {},
        finished: new Promise<void>(() => {}),
        ...(control.setMode ? { setPermissionMode: control.setMode } : {})
      }
      started.push({ adapter: id, ctx, session })
      return session
    }
  })
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const own = events
  const m = new RunManager({ mock: make('mock'), claude: make('claude'), codex: make('codex') }, (e) => void own.push(e), store, setup, () => 100, {
    dataDir: join(dir, 'data'),
    catalog: () => CATALOG,
    ...options
  })
  const runsMap = (): Map<string, unknown> => Reflect.get(m, 'runs')
  return { m, store, started, control, runsMap, ctx: (i = 0) => started[i].ctx }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

/** A mock-provider team project: Lead -> Engineer / Reviewer, the engineer with its own low effort. */
const team = (over: Partial<Project> = {}): Project => {
  const base = makeProject({ id: 'p1', path: folder(), permissionMode: 'default' })
  return { ...base, roles: base.roles.map((r) => (r.id === 'r-eng' ? { ...r, effort: 'low' as const } : r)), ...over }
}

/** A single-assistant project on the Claude provider (so a chosen model can move it to Codex). */
const claudeProject = (over: Partial<Project> = {}): Project => ({
  ...team(),
  provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } },
  roles: [role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'claude-sonnet-4-5' })],
  ...over
})

const rootOf = (ctx: RuntimeContext) => ctx.roles.find((r) => r.reportsTo === null)!
const logsOf = (runId: string, level?: string): string[] => events.flatMap((e) => (e.type === 'log' && e.runId === runId && (!level || e.level === level) ? [e.message] : []))

const finish = (ctx: RuntimeContext): void => ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'finished' })

const noRunLeft = (r: ReturnType<typeof rig>, started = true): void => {
  expect(r.store.list('p1')).toEqual([])
  expect(r.runsMap().size).toBe(0)
  if (started) expect(r.started).toEqual([])
}

describe('checkStartChoice / checkStartEffort (pure)', () => {
  const run = { kind: 'work' as const, exec: false }
  it('keeps only known fields and trims nothing silently', () => {
    expect(checkStartChoice({ modelSelection: { model: 'gpt-5', connection: 'openai' }, effort: 'high', permissionMode: 'plan' }, run, CATALOG)).toEqual({
      modelSelection: { model: 'gpt-5', connection: 'openai' },
      effort: 'high',
      permissionMode: 'plan'
    })
    expect(checkStartChoice({}, run, CATALOG)).toEqual({})
  })

  it('rejects malformed model strings, models off the catalog and unknown values', () => {
    const bad = (modelSelection: unknown): unknown => () => checkStartChoice({ modelSelection } as never, run, CATALOG)
    for (const sel of [null, 'gpt-5', {}, { model: '', connection: 'openai' }, { model: ' gpt-5', connection: 'openai' }, { model: 'gpt-5\n', connection: 'openai' }, { model: 'x'.repeat(201), connection: 'openai' }, { model: 'gpt-5', connection: 5 }]) {
      expect(bad(sel)).toThrow('Invalid model selection')
    }
    expect(bad({ model: 'gpt-5', connection: 'anthropic' })).toThrow('This model is not available on that connection. Choose another model.')
    expect(() => checkStartChoice({ effort: 'huge' as never }, run, CATALOG)).toThrow('Invalid effort level')
    expect(() => checkStartChoice({ permissionMode: 'yolo' as never }, run, CATALOG)).toThrow('Invalid permission mode')
  })

  it('limits the permission mode by run kind, Chat and build sessions, and exec', () => {
    const refuse = 'This run cannot use that permission mode.'
    for (const mode of PERMISSION_MODES) expect(checkStartChoice({ permissionMode: mode }, run, CATALOG).permissionMode).toBe(mode)
    for (const kind of ['setup', 'mcp-assist', 'skill-assist'] as const) expect(() => checkStartChoice({ permissionMode: 'plan' }, { kind, exec: false }, CATALOG)).toThrow(refuse)
    const quick = { kind: 'work' as const, exec: false, quick: { folder: '/w', team: 'single' as const, allowEdits: false, gitRepo: false } }
    expect(() => checkStartChoice({ permissionMode: 'acceptEdits' }, quick, CATALOG)).toThrow(refuse)
    expect(checkStartChoice({ permissionMode: 'dontAsk' }, quick, CATALOG).permissionMode).toBe('dontAsk')
    expect(() => checkStartChoice({ permissionMode: 'bypassPermissions' }, { kind: 'work', exec: false, buildWorkspace: '/b' }, CATALOG)).toThrow(refuse)
    expect(() => checkStartChoice({ permissionMode: 'plan' }, { kind: 'work', exec: true }, CATALOG)).toThrow('Exec runs keep the mode they started with.')
  })

  it('checks the effort against the adapter', () => {
    expect(() => checkStartEffort('xhigh', 'codex')).toThrow('This model does not take the xhigh effort level.')
    expect(() => checkStartEffort('max', 'codex')).toThrow('does not take the max')
    expect(() => checkStartEffort('high', 'codex')).not.toThrow()
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(() => checkStartEffort(effort, 'claude')).not.toThrow()
      expect(() => checkStartEffort(effort, 'mock')).not.toThrow()
    }
  })
})

describe('start with a chosen model', () => {
  it('sets the root role model and connection, leaves reports alone and records the selection', async () => {
    const r = rig()
    const run = await r.m.start({ project: team(), prompt: 'go', userChoice: { modelSelection: { model: 'claude-opus-4-5', connection: 'anthropic' } } })
    const root = rootOf(r.ctx())
    expect(root.model).toBe('claude-opus-4-5')
    expect(r.ctx().roles.filter((x) => x.reportsTo !== null).map((x) => x.model)).toEqual(['sonnet', 'sonnet'])
    expect(run.modelSelection).toEqual({ model: 'claude-opus-4-5', connection: 'anthropic' })
    expect(r.store.get(run.id)?.modelSelection).toEqual({ model: 'claude-opus-4-5', connection: 'anthropic' })
    await r.m.stopAll()
  })

  it('beats quickRunModel on the single assistant', async () => {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, quickRunModel: 'sonnet' }
    const r = rig({ appSettings: () => settings })
    const run = await r.m.start({ project: team(), prompt: 'go', team: 'single', userChoice: { modelSelection: { model: 'claude-opus-4-5', connection: 'anthropic' } } })
    expect(r.ctx().roles).toHaveLength(1)
    expect(r.ctx().roles[0].model).toBe('claude-opus-4-5')
    expect(run.modelSelection?.model).toBe('claude-opus-4-5')
    await r.m.stopAll()
  })

  it('routes to the chosen model\'s adapter and connection', async () => {
    const r = rig()
    const run = await r.m.start({ project: claudeProject(), prompt: 'go', team: 'single', userChoice: { modelSelection: { model: 'gpt-5', connection: 'openai' } } })
    expect(r.started[0].adapter).toBe('codex')
    expect(run.connection).toBe('openai')
    expect(run.modelAdapter).toBe('codex')
    await r.m.stopAll()
  })

  it('refuses a model off the catalog or on another connection, leaving no run', async () => {
    const r = rig()
    const refuse = async (modelSelection: { model: string; connection: string }, message: string): Promise<void> => {
      await expect(r.m.start({ project: team(), prompt: 'go', userChoice: { modelSelection } })).rejects.toThrow(message)
      noRunLeft(r)
    }
    await refuse({ model: 'no-such-model', connection: 'anthropic' }, 'This model is not available on that connection. Choose another model.')
    await refuse({ model: 'gpt-5', connection: 'anthropic' }, 'This model is not available on that connection. Choose another model.')
    await refuse({ model: 'claude-opus-4-5', connection: 'openai' }, 'This model is not available on that connection. Choose another model.')
    await refuse({ model: ' claude-opus-4-5', connection: 'anthropic' }, 'Invalid model selection')
    expect(events).toEqual([])
  })

  it('refuses an unpriced model under a project cap before the run exists, but allows it without a cap', async () => {
    const r = rig()
    const choice = { modelSelection: { model: 'mystery-model', connection: 'anthropic' } }
    await expect(r.m.start({ project: team({ maxBudgetUsd: 5 }), prompt: 'go', userChoice: choice })).rejects.toThrow('This model has no known price, so the project budget cannot be enforced.')
    noRunLeft(r)
    // A priced model under the same cap starts; so does the unpriced one with no cap (0 means no cap).
    await r.m.start({ project: team({ maxBudgetUsd: 5 }), prompt: 'go', userChoice: { modelSelection: { model: 'claude-sonnet-4-5', connection: 'anthropic' } } })
    await r.m.start({ project: team({ id: 'p2', path: folder('two'), maxBudgetUsd: 0 }), prompt: 'go', userChoice: choice })
    expect(r.started).toHaveLength(2)
    await r.m.stopAll()
  })
})

describe('start with a chosen effort', () => {
  it('sets it on the root role only and records it on the summary', async () => {
    const r = rig()
    const project = team()
    const run = await r.m.start({ project, prompt: 'go', userChoice: { effort: 'xhigh' } })
    const ctx = r.ctx()
    expect(rootOf(ctx).effort).toBe('xhigh')
    // The engineer keeps its own effort, the reviewer has none; the project the adapter sees is untouched.
    expect(ctx.roles.find((x) => x.id === 'r-eng')?.effort).toBe('low')
    expect(ctx.roles.find((x) => x.id === 'r-rev')?.effort).toBeUndefined()
    expect(ctx.project.roles.every((x) => x.effort !== 'xhigh')).toBe(true)
    expect(project.roles.every((x) => x.effort !== 'xhigh')).toBe(true)
    expect(run.rootEffort).toBe('xhigh')
    expect(r.store.get(run.id)?.rootEffort).toBe('xhigh')
    await r.m.stopAll()
  })

  it('leaves the root effort and summary alone without a choice', async () => {
    const r = rig()
    const run = await r.m.start({ project: team(), prompt: 'go' })
    expect(rootOf(r.ctx()).effort).toBeUndefined()
    expect(run.rootEffort).toBeUndefined()
    await r.m.stopAll()
  })

  it('refuses an effort the chosen model\'s adapter does not take, and accepts one it does', async () => {
    const r = rig()
    const choice = { modelSelection: { model: 'gpt-5', connection: 'openai' } }
    await expect(r.m.start({ project: claudeProject(), prompt: 'go', team: 'single', userChoice: { ...choice, effort: 'xhigh' } })).rejects.toThrow('This model does not take the xhigh effort level.')
    noRunLeft(r)
    await expect(r.m.start({ project: claudeProject(), prompt: 'go', team: 'single', userChoice: { effort: 'nope' as never } })).rejects.toThrow('Invalid effort level')
    noRunLeft(r)
    const run = await r.m.start({ project: claudeProject(), prompt: 'go', team: 'single', userChoice: { ...choice, effort: 'high' } })
    expect(run.rootEffort).toBe('high')
    expect(rootOf(r.started[0].ctx).effort).toBe('high')
    await r.m.stopAll()
  })
})

describe('start with a chosen permission mode', () => {
  it('puts the mode on ctx.project, records it as chosen, and never touches the stored project', async () => {
    const r = rig()
    const project = team()
    const run = await r.m.start({ project, prompt: 'go', userChoice: { permissionMode: 'bypassPermissions' } })
    expect(r.ctx().project.permissionMode).toBe('bypassPermissions')
    expect(run.permissionMode).toBe('bypassPermissions')
    expect(run.permissionModeChosen).toBe(true)
    expect(r.store.get(run.id)).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeChosen: true })
    expect(project.permissionMode).toBe('default')
    await r.m.stopAll()
  })

  it('records the mode in force on every run, chosen only when the user chose', async () => {
    const r = rig()
    const plain = await r.m.start({ project: team({ permissionMode: 'acceptEdits' }), prompt: 'go' })
    expect(plain.permissionMode).toBe('acceptEdits')
    expect(plain.permissionModeChosen).toBeUndefined()
    // An override the project allows is the mode in force; the display follows it.
    const narrowed = await r.m.start({ project: team({ id: 'p2', path: folder('two'), permissionMode: 'acceptEdits' }), prompt: 'go', overrides: { permissionMode: 'plan' } })
    expect(narrowed.permissionMode).toBe('plan')
    expect(r.ctx(1).project.permissionMode).toBe('plan')
    expect(narrowed.permissionModeChosen).toBeUndefined()
    await r.m.stopAll()
  })

  it('refuses a mode the run cannot take, leaving no run', async () => {
    const r = rig()
    await expect(r.m.start({ project: team(), prompt: 'go', kind: 'setup', userChoice: { permissionMode: 'plan' } })).rejects.toThrow('This run cannot use that permission mode.')
    noRunLeft(r)
    await expect(r.m.start({ project: team(), prompt: 'go', userChoice: { permissionMode: 'yolo' as never } })).rejects.toThrow('Invalid permission mode')
    noRunLeft(r)
    await expect(r.m.start({ project: team(), prompt: 'go', overrides: { execMode: true }, userChoice: { permissionMode: 'plan' } })).rejects.toThrow('Exec runs keep the mode they started with.')
    noRunLeft(r)
    const quickProject = makeProject({ id: QUICK_PROJECT_ID, path: folder('chat') })
    const quick = { folder: folder('chat'), team: 'default' as const, allowEdits: false, gitRepo: false }
    await expect(r.m.start({ project: quickProject, prompt: 'go', quick, userChoice: { permissionMode: 'acceptEdits' } })).rejects.toThrow('This run cannot use that permission mode.')
    expect(r.store.list(QUICK_PROJECT_ID)).toEqual([])
    expect(r.runsMap().size).toBe(0)
  })

  it('keeps the chosen mode when an approved install re-derives ctx.project (setLive)', async () => {
    const spec: McpServerSpec = { id: 'mcp-new', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.2.3'], enabled: true, source: 'agent', addedAt: '' }
    const project = team()
    const saved: Project = { ...project, mcpServers: [spec], permissionMode: 'bypassPermissions' }
    const mcp = { enabledServers: (p: Project) => (p.mcpServers ?? []).filter((s) => s.enabled), resolve: (_id: string, s: McpServerSpec) => ({ spec: s, env: {}, headers: {} }), persistInstall: vi.fn((): Project => saved), searchRegistry: vi.fn(async () => ({ entries: [] })) }
    const r = rig({ mcp: mcp as unknown as RunManagerOptions['mcp'] })
    const run = await r.m.start({ project, prompt: 'go', userChoice: { permissionMode: 'plan' } })
    const pending = r.ctx().requestMcpInstall!({ agentId: 'root', reason: 'r', spec, requiredSecrets: [] })
    const req = await vi.waitFor(() => {
      const e = events.find((x) => x.type === 'mcpInstall.request')
      if (!e || e.type !== 'mcpInstall.request') throw new Error('no request yet')
      return e
    })
    r.m.answerMcpInstall(run.id, req.request.id, { approved: true, scope: 'project' })
    expect(await pending).toMatchObject({ approved: true })
    expect(r.ctx().mcpServers!().map((s) => s.name)).toEqual(['docs'])
    // The saved project says bypassPermissions; the user's choice for this run still wins.
    expect(r.ctx().project.permissionMode).toBe('plan')
    await r.m.stopAll()
  })

  it('moves the displayed mode when an approved project change switches the mode of a run without a choice', async () => {
    const project: Project = { ...team(), permissionMode: 'default' }
    const saveProjectPermissions = vi.fn((): Project => ({ ...project, permissionMode: 'acceptEdits' }))
    const r = rig({ saveProjectPermissions } as Partial<RunManagerOptions>)
    const run = await r.m.start({ project, prompt: 'go' })
    expect(r.store.get(run.id)?.permissionMode).toBe('default')
    expect(r.ctx().acceptEditsForProject!()).toBe(true)
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.store.get(run.id)?.permissionMode).toBe('acceptEdits')
    expect(r.store.get(run.id)?.permissionModeChosen).toBeUndefined()
    await r.m.stopAll()
  })
})

describe('continuations carry the per-run choices', () => {
  const finished = async (r: ReturnType<typeof rig>, project: Project, userChoice: NonNullable<Parameters<RunManager['start']>[0]['userChoice']>): Promise<RunSummary> => {
    const run = await r.m.start({ project, prompt: 'go', userChoice })
    finish(r.started[r.started.length - 1].ctx)
    return run
  }

  it('carries the root effort onto the continuation', async () => {
    const r = rig()
    const project = team()
    const first = await finished(r, project, { effort: 'max' })
    const next = await r.m.continueRun(project, first.id, 'more')
    expect(next.rootEffort).toBe('max')
    expect(rootOf(r.ctx(1)).effort).toBe('max')
    expect(r.ctx(1).roles.find((x) => x.id === 'r-eng')?.effort).toBe('low')
    expect(logsOf(next.id, 'warn')).toEqual([])
    await r.m.stopAll()
  })

  it('drops an effort the continuation\'s adapter does not take, with a warning, and still starts', async () => {
    const r = rig()
    const project = claudeProject()
    const first = await finished(r, project, { effort: 'xhigh' })
    expect(first.rootEffort).toBe('xhigh')
    await r.m.switchModel({ runId: first.id, model: 'gpt-5', connection: 'openai' })
    const next = await r.m.continueRun(project, first.id, 'more')
    expect(r.started[1].adapter).toBe('codex')
    expect(next.rootEffort).toBeUndefined()
    expect(rootOf(r.ctx(1)).effort).toBeUndefined()
    expect(logsOf(next.id, 'warn')).toEqual(['This model does not take the xhigh effort level, so the run uses its default effort.'])
    await r.m.stopAll()
  })

  it('carries a chosen mode that narrows the project, with no flag', async () => {
    const r = rig()
    const project = team({ permissionMode: 'acceptEdits' })
    const first = await finished(r, project, { permissionMode: 'plan' })
    const next = await r.m.continueRun(project, first.id, 'more')
    expect(r.ctx(1).project.permissionMode).toBe('plan')
    expect(next).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true })
    await r.m.stopAll()
  })

  it('drops a widening mode without the desktop flag, saying so, and follows the project', async () => {
    const r = rig()
    const project = team({ permissionMode: 'default' })
    const first = await finished(r, project, { permissionMode: 'bypassPermissions' })
    expect(r.ctx(0).project.permissionMode).toBe('bypassPermissions')
    const next = await r.m.continueRun(project, first.id, 'more')
    expect(r.ctx(1).project.permissionMode).toBe('default')
    expect(next.permissionMode).toBe('default')
    expect(next.permissionModeChosen).toBeUndefined()
    expect(logsOf(next.id, 'info')).toContain("The per-run permission mode was not carried; the project's mode applies.")
    await r.m.stopAll()
  })

  it('carries a widening mode for the desktop, for allowWidening and for the resume timer path', async () => {
    const project = team({ permissionMode: 'default' })
    for (const opts of [{ desktop: true as const }, { allowWidening: true }]) {
      const r = rig()
      const first = await finished(r, project, { permissionMode: 'bypassPermissions' })
      const next = await r.m.continueRun(project, first.id, 'more', undefined, opts)
      expect(r.ctx(1).project.permissionMode).toBe('bypassPermissions')
      expect(next).toMatchObject({ permissionMode: 'bypassPermissions', permissionModeChosen: true })
      await r.m.stopAll()
    }
  })

  const pause = (r: ReturnType<typeof rig>, id: string): void => {
    Reflect.apply(Reflect.get(r.m, 'patchSummary'), r.m, [id, { status: 'paused', pausedUntil: Date.now() + 1000, autoResume: false }])
  }

  it('Resume now from the desktop carries a widening mode', async () => {
    const project = team({ permissionMode: 'default' })
    const r = rig({ resolveProject: () => project })
    const first = await finished(r, project, { permissionMode: 'bypassPermissions' })
    pause(r, first.id)
    const next = await r.m.resumeNow(first.id, { desktop: true })
    expect(next.permissionModeChosen).toBe(true)
    expect(r.ctx(1).project.permissionMode).toBe('bypassPermissions')
    await r.m.stopAll()
  })

  it('the auto-resume timer path carries it too', async () => {
    const project = team({ permissionMode: 'default' })
    const r = rig({ resolveProject: () => project })
    const first = await finished(r, project, { permissionMode: 'bypassPermissions' })
    pause(r, first.id)
    const next = (await Reflect.apply(Reflect.get(r.m, 'resumeUnleased'), r.m, [first.id, { auto: true }])) as RunSummary
    expect(next.permissionModeChosen).toBe(true)
    expect(r.ctx(1).project.permissionMode).toBe('bypassPermissions')
    await r.m.stopAll()
  })

  it('resumeNow without the desktop flag does not carry a widening mode', async () => {
    const project = team({ permissionMode: 'default' })
    const r = rig({ resolveProject: () => project })
    const first = await finished(r, project, { permissionMode: 'bypassPermissions' })
    Reflect.apply(Reflect.get(r.m, 'patchSummary'), r.m, [first.id, { status: 'paused', pausedUntil: Date.now() + 1000, autoResume: false }])
    const next = await r.m.resumeNow(first.id)
    expect(next.permissionModeChosen).toBeUndefined()
    expect(r.ctx(1).project.permissionMode).toBe('default')
    await r.m.stopAll()
  })

  it('a mode saved on an ended run (setPermissionMode) is what the continuation uses', async () => {
    const r = rig()
    const project = team({ permissionMode: 'default' })
    const first = await finished(r, project, {})
    expect((await r.m.setPermissionMode({ runId: first.id, mode: 'acceptEdits' })).applied).toBe(false)
    const next = await r.m.continueRun(project, first.id, 'more', undefined, { desktop: true })
    expect(r.ctx(1).project.permissionMode).toBe('acceptEdits')
    expect(next.permissionModeChosen).toBe(true)
    await r.m.stopAll()
  })
})

describe('setPermissionMode', () => {
  it('applies on a live session that can switch: ctx.project, summary and an info line change', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const run = await r.m.start({ project: team(), prompt: 'go' })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'acceptEdits' })
    expect(result.applied).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.run).toMatchObject({ id: run.id, permissionMode: 'acceptEdits', permissionModeChosen: true })
    expect(r.control.setMode).toHaveBeenCalledWith('acceptEdits')
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.store.get(run.id)).toMatchObject({ permissionMode: 'acceptEdits', permissionModeChosen: true })
    expect(logsOf(run.id, 'info').some((l) => l.startsWith('Permission mode set to ') && l.endsWith(' for this run.'))).toBe(true)
    await r.m.stopAll()
  })

  it('sees the new ctx.project while the session is deciding, and restores everything when it says no', async () => {
    const r = rig()
    let seen: PermissionMode | undefined
    r.control.setMode = vi.fn(async () => {
      seen = r.ctx().project.permissionMode
      return false
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go' })
    const before = r.m.summary(run.id)
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'bypassPermissions' })
    expect(seen).toBe('bypassPermissions')
    expect(result).toMatchObject({ applied: false, reason: 'The session could not change its permission mode now.' })
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)).toEqual(before)
    expect(r.m.summary(run.id)?.permissionModeChosen).toBeUndefined()
    expect(logsOf(run.id).some((l) => l.startsWith('Permission mode set'))).toBe(false)
    await r.m.stopAll()
  })

  it('restores the earlier choice when a session throws, and reports its message', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => {
      throw new Error('mid-turn, try again')
    })
    const run = await r.m.start({ project: team(), prompt: 'go', userChoice: { permissionMode: 'plan' } })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })
    expect(result).toMatchObject({ applied: false, reason: 'mid-turn, try again' })
    expect(r.ctx().project.permissionMode).toBe('plan')
    expect(r.m.summary(run.id)?.permissionMode).toBe('plan')
    await r.m.stopAll()
  })

  it('changes nothing on a live session without the method', async () => {
    const r = rig()
    const run = await r.m.start({ project: team(), prompt: 'go' })
    const before = r.m.summary(run.id)
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('This session cannot change its permission mode while it runs. End the session, then choose the mode before you continue.')
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)).toEqual(before)
    await r.m.stopAll()
  })

  it('saves the mode on an ended run for its continuation without touching a session', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const run = await r.m.start({ project: team(), prompt: 'go' })
    finish(r.ctx())
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })
    expect(result).toMatchObject({ applied: false, reason: 'The mode will be used when the run continues.' })
    expect(result.run).toMatchObject({ permissionMode: 'dontAsk', permissionModeChosen: true })
    expect(r.control.setMode).not.toHaveBeenCalled()
    // A run that only exists in the store (an earlier app session) is saved the same way.
    r.store.upsert({ id: 'old', projectId: 'p1', kind: 'work', prompt: 'x', status: 'finished', startedAt: 1, totalCostUsd: 0, sessionId: 's' })
    const old = await r.m.setPermissionMode({ runId: 'old', mode: 'plan' })
    expect(old.applied).toBe(false)
    expect(r.store.get('old')).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true })
    await r.m.stopAll()
  })

  it('refuses setup-like runs, exec runs, modes outside the run\'s choices, unknown runs and bad input', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const setupRun = await r.m.start({ project: team(), prompt: 'go', kind: 'setup' })
    await expect(r.m.setPermissionMode({ runId: setupRun.id, mode: 'plan' })).rejects.toThrow('This run keeps its own permission mode.')
    const exec = await r.m.start({ project: team({ id: 'p2', path: folder('two') }), prompt: 'go', overrides: { execMode: true } })
    await expect(r.m.setPermissionMode({ runId: exec.id, mode: 'plan' })).rejects.toThrow('Exec runs keep the mode they started with.')
    await expect(r.m.setPermissionMode({ runId: 'ghost', mode: 'plan' })).rejects.toThrow('Run not found')
    await expect(r.m.setPermissionMode({ runId: setupRun.id, mode: 'nope' as never })).rejects.toThrow('Invalid permission mode')
    await expect(r.m.setPermissionMode(null as never)).rejects.toThrow('Invalid permission mode')
    await expect(r.m.setPermissionMode({ runId: 5 as never, mode: 'plan' })).rejects.toThrow('Invalid permission mode')
    expect(r.control.setMode).not.toHaveBeenCalled()
    expect(r.m.summary(setupRun.id)?.permissionModeChosen).toBeUndefined()
    await r.m.stopAll()
  })

  it('lands on the newest run of the conversation when given an older id', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const project = team()
    const first = await r.m.start({ project, prompt: 'go' })
    finish(r.ctx(0))
    const second = await r.m.continueRun(project, first.id, 'more')
    const result = await r.m.setPermissionMode({ runId: first.id, mode: 'plan' })
    expect(result.run.id).toBe(second.id)
    expect(result.applied).toBe(true)
    expect(r.m.summary(first.id)?.permissionModeChosen).toBeUndefined()
    await r.m.stopAll()
  })
})
