import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, McpServerSpec, PermissionMode, Project, ProviderId, ProviderModel, RunEvent, RunSummary } from '@shared/types'
import { PERMISSION_MODES, PERMISSION_MODE_OPTIONS, QUICK_PROJECT_ID } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { RunManager, checkStartChoice, checkStartEffort, type RunManagerOptions } from './runManager'
import { canNarrowPermissionMode } from './runOverrides'
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
  const control: { setMode?: RuntimeSession['setPermissionMode'] } = {}
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

const labelOf = (mode: PermissionMode): string => PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)!.label

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

  it('L3: a widening reaches ctx.project only after the session applied it, and nothing changes when it says no', async () => {
    const r = rig()
    let seen: PermissionMode | undefined
    let answer = false
    r.control.setMode = vi.fn(async () => {
      seen = r.ctx().project.permissionMode
      return answer
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go' })
    const before = r.m.summary(run.id)
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'bypassPermissions' })
    expect(seen).toBe('default')
    expect(result).toMatchObject({ applied: false, reason: 'The session could not change its permission mode now.' })
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)).toEqual(before)
    expect(r.m.summary(run.id)?.permissionModeChosen).toBeUndefined()
    expect(logsOf(run.id).some((l) => l.startsWith('Permission mode set'))).toBe(false)
    answer = true
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'bypassPermissions' })).applied).toBe(true)
    expect(seen).toBe('default')
    expect(r.ctx().project.permissionMode).toBe('bypassPermissions')
    await r.m.stopAll()
  })

  it('L3: a narrowing is on ctx.project before the session answers', async () => {
    const r = rig()
    let seen: PermissionMode | undefined
    r.control.setMode = vi.fn(async () => {
      seen = r.ctx().project.permissionMode
      return true
    })
    const run = await r.m.start({ project: team({ permissionMode: 'acceptEdits' }), prompt: 'go' })
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })).applied).toBe(true)
    expect(seen).toBe('plan')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true })
    await r.m.stopAll()
  })

  it('L2: restores the earlier choice when a session throws, with a fixed reason instead of its message', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => {
      throw new Error('SDK internal: control request failed at /tmp/x')
    })
    const run = await r.m.start({ project: team(), prompt: 'go', userChoice: { permissionMode: 'plan' } })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })
    expect(result).toEqual({ run: expect.anything(), applied: false, reason: 'The session could not change its permission mode now.' })
    expect(r.ctx().project.permissionMode).toBe('plan')
    expect(r.m.summary(run.id)?.permissionMode).toBe('plan')
    expect(events.some((e) => JSON.stringify(e).includes('SDK internal'))).toBe(false)
    await r.m.stopAll()
  })

  it('M2: a second change while one is pending is refused; the first failing restores the mode in force', async () => {
    const r = rig()
    let release: (v: boolean) => void = () => {}
    r.control.setMode = vi.fn(() => new Promise<boolean>((res) => (release = res)))
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go' })
    const first = r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    await vi.waitFor(() => expect(r.control.setMode).toHaveBeenCalledTimes(1))
    const second = await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })
    expect(second).toMatchObject({ applied: false, reason: 'Another permission mode change for this run is still in progress. Try again in a moment.' })
    expect(r.control.setMode).toHaveBeenCalledTimes(1)
    // The narrowing was in force while the session decided.
    expect(r.ctx().project.permissionMode).toBe('plan')
    release(false)
    expect((await first).applied).toBe(false)
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)?.permissionMode).toBe('default')
    expect(r.store.get(run.id)?.permissionMode).toBe('default')
    expect(r.m.summary(run.id)?.permissionModeChosen).toBeUndefined()
    // The flag is cleared: a later change goes through.
    const third = r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })
    await vi.waitFor(() => expect(r.control.setMode).toHaveBeenCalledTimes(2))
    release(true)
    expect((await third).applied).toBe(true)
    expect(r.ctx().project.permissionMode).toBe('dontAsk')
    await r.m.stopAll()
  })

  it('M2: a refusal re-derives from the live project when an approval landed during the await', async () => {
    const project: Project = { ...team(), permissionMode: 'default' }
    const saveProjectPermissions = vi.fn((): Project => ({ ...project, permissionMode: 'acceptEdits' }))
    const r = rig({ saveProjectPermissions } as Partial<RunManagerOptions>)
    let release: (v: boolean) => void = () => {}
    r.control.setMode = vi.fn(() => new Promise<boolean>((res) => (release = res)))
    const run = await r.m.start({ project, prompt: 'go' })
    const pending = r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    await vi.waitFor(() => expect(r.control.setMode).toHaveBeenCalledTimes(1))
    // "Accept edits for project" approved while the session decides: the project now says acceptEdits.
    expect(r.ctx().acceptEditsForProject!()).toBe(true)
    release(false)
    expect((await pending).applied).toBe(false)
    // Not the stale 'default' captured before the await: the live project's acceptEdits.
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)?.permissionMode).toBe('acceptEdits')
    expect(r.store.get(run.id)?.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)?.permissionModeChosen).toBeUndefined()
    await r.m.stopAll()
  })

  it('M3: the object answer counts as applied and says how many reports keep their mode', async () => {
    const r = rig()
    let answer: Awaited<ReturnType<NonNullable<RuntimeSession['setPermissionMode']>>> = { applied: true, reportsUnchanged: 2 }
    r.control.setMode = vi.fn(async () => answer)
    const run = await r.m.start({ project: team({ permissionMode: 'acceptEdits' }), prompt: 'go' })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(result).toMatchObject({ applied: true, reportsUnchanged: 2, reason: '2 running reports keep the earlier mode until they finish.' })
    expect(result.run).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true })
    expect(logsOf(run.id, 'info')).toContain(`Permission mode set to ${labelOf('plan')} for this run. 2 running reports keep the earlier mode until they finish.`)
    answer = { applied: true, reportsUnchanged: 1 }
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })).reason).toBe('1 running report keeps the earlier mode until it finishes.')
    answer = { applied: true, reportsUnchanged: 0 }
    const none = await r.m.setPermissionMode({ runId: run.id, mode: 'default' })
    expect(none.applied).toBe(true)
    expect('reportsUnchanged' in none).toBe(false)
    expect(none.reason).toBeUndefined()
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

describe('M1: an "accept edits" allow follows the run past a narrower mode', () => {
  const ACCEPT_EDITS = [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }]
  /** An Edit card with the setMode acceptEdits suggestion, answered with `scope`. Resolves with the decision the adapter got. */
  const askAndAllow = async (r: ReturnType<typeof rig>, runId: string, scope: 'once' | 'session' | 'project', i = 0) => {
    const before = events.filter((e) => e.type === 'permission.request').length
    const decision = r.ctx(i).requestPermission!({ agentId: 'root', toolName: 'Edit', input: { file_path: 'a.ts' }, summary: 'Edit a.ts', suggestions: ACCEPT_EDITS })
    const req = await vi.waitFor(() => {
      const list = events.filter((e) => e.type === 'permission.request')
      const e = list[before]
      if (!e || e.type !== 'permission.request') throw new Error('no request yet')
      return e.request
    })
    r.m.decide(runId, req.id, { behavior: 'allow', scope })
    return decision
  }

  const modeEvents = (runId: string) => events.filter((e) => e.type === 'run.permissionMode' && e.runId === runId)

  it('M-b: a card decision alone changes nothing; only the adapter hook does', async () => {
    const r = rig()
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'plan' } })
    expect(await askAndAllow(r, run.id, 'session')).toMatchObject({ behavior: 'allow', scope: 'session' })
    expect(r.ctx().project.permissionMode).toBe('plan')
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined()
    await r.m.stopAll()
  })

  it('session grant: ctx.project and sessionPermissionMode follow, the run\'s own chosen mode and the carry stay', async () => {
    const r = rig()
    const project = team({ permissionMode: 'default' })
    const run = await r.m.start({ project, prompt: 'go', userChoice: { permissionMode: 'plan' } })
    r.ctx().acceptEditsGranted!()
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' })
    // M-c: the renderer hears it.
    expect(modeEvents(run.id).at(-1)).toEqual({ type: 'run.permissionMode', runId: run.id, permissionMode: 'plan', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' })
    expect(logsOf(run.id, 'info')).toContain(`${labelOf('acceptEdits')} is on for the rest of this session.`)
    // M-a: the session ends; the grant goes with it and a desktop continuation carries plan, not acceptEdits.
    finish(r.ctx())
    await vi.waitFor(() => expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined())
    expect(modeEvents(run.id).at(-1)).toEqual({ type: 'run.permissionMode', runId: run.id, permissionMode: 'plan', permissionModeChosen: true })
    const next = await r.m.continueRun(project, run.id, 'more', undefined, { desktop: true })
    expect(r.ctx(1).project.permissionMode).toBe('plan')
    expect(next).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true })
    await r.m.stopAll()
  })

  it('project grant: the saved project change does not lay the narrower choice back over the grant (setLive)', async () => {
    const project: Project = { ...team(), permissionMode: 'default' }
    const saveProjectPermissions = vi.fn((): Project => ({ ...project, permissionMode: 'acceptEdits' }))
    const r = rig({ saveProjectPermissions } as Partial<RunManagerOptions>)
    const run = await r.m.start({ project, prompt: 'go', userChoice: { permissionMode: 'dontAsk' } })
    // What an adapter does for a project grant: applies it (hook) and saves the project's mode (applyAllowScope).
    r.ctx().acceptEditsGranted!()
    expect(r.ctx().acceptEditsForProject!()).toBe(true)
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'dontAsk', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' })
    await r.m.stopAll()
  })

  it('H1: an applied narrowing after a grant drops the overlay; a refused one keeps it', async () => {
    const r = rig()
    let answer = false
    r.control.setMode = vi.fn(async () => answer)
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go' })
    r.ctx().acceptEditsGranted!()
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'default' })).applied).toBe(false)
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBe('acceptEdits')
    answer = true
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'default' })).applied).toBe(true)
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'default', permissionModeChosen: true })
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined()
    await r.m.stopAll()
  })

  it('L-a: a grant landing while a narrowing awaits sends the narrowing once more', async () => {
    const r = rig()
    const calls: PermissionMode[] = []
    r.control.setMode = vi.fn(async (mode: PermissionMode) => {
      calls.push(mode)
      if (calls.length === 1) r.ctx().acceptEditsGranted!()
      return true
    })
    const run = await r.m.start({ project: team({ permissionMode: 'acceptEdits' }), prompt: 'go' })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(calls).toEqual(['plan', 'plan'])
    expect(result.applied).toBe(true)
    expect(r.ctx().project.permissionMode).toBe('plan')
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined()
    await r.m.stopAll()
  })

  it('Low 1a/1c: a grant in each attempt (the second while the flag is already set) refuses, keeping the applied mode under the overlay', async () => {
    const r = rig()
    const calls: PermissionMode[] = []
    r.control.setMode = vi.fn(async (mode: PermissionMode) => {
      calls.push(mode)
      r.ctx().acceptEditsGranted!()
      return true
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'bypassPermissions' } })
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(calls).toEqual(['plan', 'plan'])
    expect(result).toMatchObject({ applied: false, reason: 'An "accept edits" permission was granted during the change. Choose the mode again.' })
    // Never back to the wider bypassPermissions the session no longer runs in.
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' })
    await r.m.stopAll()
  })

  it('Low 1b: a change from plan to default (below acceptEdits) also resends when a grant lands', async () => {
    const r = rig()
    const calls: PermissionMode[] = []
    r.control.setMode = vi.fn(async (mode: PermissionMode) => {
      calls.push(mode)
      if (calls.length === 1) r.ctx().acceptEditsGranted!()
      return true
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'plan' } })
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'default' })).applied).toBe(true)
    expect(calls).toEqual(['default', 'default'])
    expect(r.ctx().project.permissionMode).toBe('default')
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined()
    await r.m.stopAll()
  })

  it('L-a: a refused widening keeps a grant that landed during the await', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => {
      r.ctx().acceptEditsGranted!()
      return false
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'plan' } })
    expect((await r.m.setPermissionMode({ runId: run.id, mode: 'acceptEdits' })).applied).toBe(false)
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.m.summary(run.id)).toMatchObject({ permissionMode: 'plan', sessionPermissionMode: 'acceptEdits' })
    await r.m.stopAll()
  })

  it('no hook on Chat runs or setup-like runs; a grant over a wider mode changes nothing', async () => {
    const r = rig()
    const wide = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'bypassPermissions' } })
    const before = modeEvents(wide.id).length
    r.ctx(0).acceptEditsGranted!()
    expect(r.ctx(0).project.permissionMode).toBe('bypassPermissions')
    expect(r.m.summary(wide.id)?.sessionPermissionMode).toBeUndefined()
    expect(modeEvents(wide.id).length).toBe(before)
    const quickProject = makeProject({ id: QUICK_PROJECT_ID, path: folder('chat') })
    await r.m.start({ project: quickProject, prompt: 'go', quick: { folder: folder('chat'), team: 'default', allowEdits: true, gitRepo: false } })
    expect(r.ctx(1).acceptEditsGranted).toBeUndefined()
    await r.m.start({ project: team({ id: 'p2', path: folder('two') }), prompt: 'go', kind: 'setup' })
    expect(r.ctx(2).acceptEditsGranted).toBeUndefined()
    await r.m.stopAll()
  })

  it('an adapter-emitted run.permissionMode is dropped', async () => {
    const r = rig()
    const run = await r.m.start({ project: team(), prompt: 'go' })
    r.ctx().emit({ type: 'run.permissionMode', runId: run.id, permissionMode: 'bypassPermissions' })
    expect(modeEvents(run.id).some((e) => e.type === 'run.permissionMode' && e.permissionMode === 'bypassPermissions')).toBe(false)
    await r.m.stopAll()
  })
})

describe('bridged children on a narrowing (coordinator High)', () => {
  it('adds live bridged children wider than the new mode to reportsUnchanged, never a plain applied', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const run = await r.m.start({ project: team({ permissionMode: 'acceptEdits' }), prompt: 'go' })
    const active = r.runsMap().get(run.id) as { bridge?: unknown }
    const liveWiderThan = vi.fn((mode: PermissionMode) => (mode === 'plan' ? 2 : 0))
    active.bridge = { liveWiderThan, hasActive: () => false }
    const narrowed = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(narrowed).toMatchObject({ applied: true, reportsUnchanged: 2, reason: '2 running reports keep the earlier mode until they finish.' })
    expect(liveWiderThan).toHaveBeenCalledWith('plan')
    // A widening asks too (M2) and the child count is 0 here, so a plain applied.
    liveWiderThan.mockClear()
    const widened = await r.m.setPermissionMode({ runId: run.id, mode: 'bypassPermissions' })
    expect(widened.applied).toBe(true)
    expect(widened.reportsUnchanged).toBeUndefined()
    expect(liveWiderThan).toHaveBeenCalledWith('bypassPermissions')
    expect(liveWiderThan.mock.results.at(-1)?.value).toBe(0)
    delete active.bridge
    await r.m.stopAll()
  })

  it('M2: a change the matrix cannot compare (Don\'t ask to Default) still reports a child that runs wider than the new mode', async () => {
    const r = rig()
    r.control.setMode = vi.fn(async () => true)
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'auto' } })
    const active = r.runsMap().get(run.id) as { bridge?: unknown }
    // A bridged child that started in Auto, counted the way BridgedSessions.liveWiderThan does.
    const liveWiderThan = vi.fn((mode: PermissionMode) => (mode !== 'auto' && canNarrowPermissionMode('auto', mode) ? 1 : 0))
    active.bridge = { liveWiderThan, hasActive: () => true }
    expect(await r.m.setPermissionMode({ runId: run.id, mode: 'dontAsk' })).toMatchObject({ applied: true, reportsUnchanged: 1 })
    // dontAsk -> default is not a narrowing in the matrix; the child still runs Auto, wider than Default.
    expect(canNarrowPermissionMode('dontAsk', 'default')).toBe(false)
    const toDefault = await r.m.setPermissionMode({ runId: run.id, mode: 'default' })
    expect(toDefault).toMatchObject({ applied: true, reportsUnchanged: 1, reason: '1 running report keeps the earlier mode until it finishes.' })
    expect(logsOf(run.id, 'info').at(-1)).toContain('1 running report keeps the earlier mode until it finishes.')
    delete active.bridge
    await r.m.stopAll()
  })
})

describe('L1: the doubly raced refusal', () => {
  it('re-derives before one broadcast and carries the adapter and bridged counts', async () => {
    const r = rig()
    const modeEventCount = (): number => events.filter((e) => e.type === 'run.permissionMode').length
    let afterLastCall = 0
    r.control.setMode = vi.fn(async () => {
      r.ctx().acceptEditsGranted!()
      afterLastCall = modeEventCount()
      return { applied: true as const, reportsUnchanged: 2 }
    })
    const run = await r.m.start({ project: team({ permissionMode: 'default' }), prompt: 'go', userChoice: { permissionMode: 'bypassPermissions' } })
    const active = r.runsMap().get(run.id) as { bridge?: unknown }
    active.bridge = { liveWiderThan: vi.fn(() => 1), hasActive: () => true }
    const result = await r.m.setPermissionMode({ runId: run.id, mode: 'plan' })
    expect(result).toMatchObject({ applied: false, reportsUnchanged: 3 })
    expect(result.reason).toContain('Choose the mode again.')
    expect(result.reason).toContain('3 running reports keep the earlier mode until they finish.')
    // After the last session call the refusal sends exactly one snapshot, already re-derived: own mode plan, chosen, accept edits on top.
    const sent = events.filter((e) => e.type === 'run.permissionMode').slice(afterLastCall)
    expect(sent).toEqual([{ type: 'run.permissionMode', runId: run.id, permissionMode: 'plan', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' }])
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.store.get(run.id)).toMatchObject({ permissionMode: 'plan', permissionModeChosen: true, sessionPermissionMode: 'acceptEdits' })
    delete active.bridge
    await r.m.stopAll()
  })
})

describe('L3: a project change that narrows the run to Plan / Don\'t ask drops the accept-edits overlay', () => {
  const grantThenSave = async (savedMode: PermissionMode, userChoice?: { permissionMode: PermissionMode }) => {
    const project: Project = { ...team(), permissionMode: 'default' }
    const saveProjectPermissions = vi.fn((): Project => ({ ...project, permissionMode: savedMode }))
    const r = rig({ saveProjectPermissions } as Partial<RunManagerOptions>)
    const run = await r.m.start({ project, prompt: 'go', ...(userChoice ? { userChoice } : {}) })
    r.ctx().acceptEditsGranted!()
    return { r, run }
  }

  it('Plan from the project: the overlay goes, ctx.project and the summary say Plan, one warning is logged', async () => {
    const { r, run } = await grantThenSave('plan')
    expect(r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(r.ctx().acceptEditsForProject!()).toBe(false)
    expect(r.ctx().project.permissionMode).toBe('plan')
    expect(r.m.summary(run.id)?.sessionPermissionMode).toBeUndefined()
    expect(r.m.summary(run.id)?.permissionMode).toBe('plan')
    expect(events.filter((e) => e.type === 'run.permissionMode' && e.runId === run.id).at(-1)).toEqual({ type: 'run.permissionMode', runId: run.id, permissionMode: 'plan' })
    expect(logsOf(run.id, 'warn').filter((m) => m.startsWith('The project mode is now'))).toHaveLength(1)
    await r.m.stopAll()
  })

  it('Don\'t ask from the project drops it too; a project change to Default keeps the overlay; a mode the user chose is not moved by the project', async () => {
    const dont = await grantThenSave('dontAsk')
    dont.r.ctx().acceptEditsForProject!()
    expect(dont.r.ctx().project.permissionMode).toBe('dontAsk')
    expect(dont.r.m.summary(dont.run.id)?.sessionPermissionMode).toBeUndefined()
    await dont.r.m.stopAll()
    const same = await grantThenSave('default')
    same.r.ctx().acceptEditsForProject!()
    expect(same.r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(same.r.m.summary(same.run.id)?.sessionPermissionMode).toBe('acceptEdits')
    await same.r.m.stopAll()
    const chosen = await grantThenSave('plan', { permissionMode: 'dontAsk' })
    chosen.r.ctx().acceptEditsForProject!()
    expect(chosen.r.ctx().project.permissionMode).toBe('acceptEdits')
    expect(chosen.r.m.summary(chosen.run.id)).toMatchObject({ permissionMode: 'dontAsk', sessionPermissionMode: 'acceptEdits' })
    await chosen.r.m.stopAll()
  })
})

describe('L1: RunSummary.permissionMode only on runs that take a per-run mode', () => {
  it('is absent on setup-like runs and asks-only on a Chat run over a wider project mode', async () => {
    const r = rig()
    const setupRun = await r.m.start({ project: team({ permissionMode: 'bypassPermissions' }), prompt: 'go', kind: 'setup' })
    expect(setupRun.permissionMode).toBeUndefined()
    expect(r.store.get(setupRun.id)?.permissionMode).toBeUndefined()
    const quickProject = makeProject({ id: QUICK_PROJECT_ID, path: folder('chat'), permissionMode: 'acceptEdits' })
    const chat = await r.m.start({ project: quickProject, prompt: 'go', quick: { folder: folder('chat'), team: 'default', allowEdits: true, gitRepo: false } })
    expect(chat.permissionMode).toBe('default')
    await r.m.stopAll()
  })
})
