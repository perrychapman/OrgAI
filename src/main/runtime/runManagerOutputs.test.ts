import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInstance, OutputProduceInput, OutputRegisterInput, OutputsChangedEvent, Project, RunEvent, RunOutput } from '@shared/types'
import { OUTPUTS_RUN_MAX, QUICK_PROJECT_ID, SKILLS_PROJECT_ID } from '@shared/types'
import { RunManager, outputScopeOf, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { OutputScope, OutputSource, OutputsServiceApi } from '../outputs/api'
import { ROOT_AGENT_ID, type RuntimeAdapter, type RuntimeContext } from './types'
import { project as makeProject } from './testHelpers'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-outputs-')))
  events = []
  warn.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RunManagerOptions = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => ''), complete: vi.fn() } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, ctxs }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

interface Call {
  fn: 'produce' | 'register'
  scope: OutputScope
  input: OutputProduceInput | OutputRegisterInput
  source: OutputSource
}

/** An OutputsServiceApi that records its calls and answers with a RunOutput built from the input. */
function fakeService(over: { created?: boolean; fail?: string } = {}) {
  const calls: Call[] = []
  let n = 0
  const make = (scope: OutputScope, input: { title: string }, source: OutputSource, kind: RunOutput['kind'], origin: RunOutput['source']): RunOutput => {
    n++
    return {
      id: `out_${String(n).padStart(16, '0')}`,
      projectId: scope.projectId,
      runId: source.runId,
      ...(source.agentId ? { agentId: source.agentId } : {}),
      ...(source.role ? { role: source.role } : {}),
      kind,
      title: input.title,
      fileName: `f${n}`,
      path: join(scope.projectPath, 'outputs', `f${n}`),
      relPath: `outputs/f${n}`,
      bytes: 10,
      createdAt: 1,
      source: origin
    }
  }
  const api: OutputsServiceApi & { calls: Call[] } = {
    calls,
    produce: vi.fn(async (scope, input, source) => {
      if (over.fail) throw new Error(over.fail)
      calls.push({ fn: 'produce', scope, input, source })
      return { output: make(scope, input, source, input.kind, 'produced'), created: over.created ?? true }
    }),
    register: vi.fn(async (scope, input, source) => {
      if (over.fail) throw new Error(over.fail)
      calls.push({ fn: 'register', scope, input, source })
      return { output: make(scope, input, source, input.kind ?? 'other', 'registered'), created: over.created ?? true }
    }),
    list: vi.fn(() => []),
    get: vi.fn(),
    preview: vi.fn(),
    checkedPath: vi.fn(),
    forget: vi.fn(() => []),
    delete: vi.fn(() => [])
  }
  return api
}

const agentWith = (over: Partial<AgentInstance> & { id: string }): AgentInstance => ({
  roleId: 'r-eng',
  roleSlug: 'engineer',
  name: 'engineer-1',
  parentId: ROOT_AGENT_ID,
  spawnToolUseId: 't1',
  state: 'thinking',
  activity: 'x',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...over
})

const rows = (): { agentId: string; text: string; source?: string }[] =>
  events
    .filter((e): e is Extract<RunEvent, { type: 'transcript' }> => e.type === 'transcript')
    .filter((e) => e.entry.block.kind === 'system')
    .map((e) => ({ agentId: e.entry.agentId, text: (e.entry.block as { text: string }).text, source: e.entry.source }))

const created = (): Extract<RunEvent, { type: 'output.created' }>[] => events.filter((e): e is Extract<RunEvent, { type: 'output.created' }> => e.type === 'output.created')

const doc: OutputProduceInput = { kind: 'docx', title: 'Q3 report', content: '# Q3' }

describe('RuntimeContext.outputs: where it is bound', () => {
  it('is bound on work runs of code and engagement projects (team default and single), never on setup, Chat, build or assistant runs', async () => {
    const outputs = fakeService()
    const { m, ctxs } = rig({ outputs })
    await m.start({ project: makeProject({ id: 'p1', path: folder('a') }), prompt: 'code team' })
    await m.start({ project: makeProject({ id: 'p2', path: folder('b') }), prompt: 'code ask', team: 'single' })
    await m.start({ project: makeProject({ id: 'p3', path: folder('c'), kind: 'engagement' }), prompt: 'eng team' })
    await m.start({ project: makeProject({ id: 'p4', path: folder('d'), kind: 'engagement' }), prompt: 'eng ask', team: 'single' })
    await m.start({ project: makeProject({ id: 'p5', path: folder('e') }), prompt: 'setup', kind: 'setup' })
    const quickFolder = folder('quick')
    await m.start({
      project: makeProject({ id: QUICK_PROJECT_ID, path: quickFolder }),
      prompt: 'chat',
      quick: { folder: quickFolder, team: 'single', allowEdits: false, gitRepo: false, scratch: true }
    })
    const ws = folder('ws')
    await m.start({ project: makeProject({ id: 'harness', roles: [], path: ws }), prompt: 'build', kind: 'mcp-assist', buildWorkspace: ws })
    await m.start({ project: makeProject({ id: SKILLS_PROJECT_ID, roles: [], path: folder('sk') }), prompt: 'skills', kind: 'skill-assist' })
    expect(ctxs.map((c) => c.outputs !== undefined)).toEqual([true, true, true, true, false, false, false, false])
    await m.stopAll()
  })

  it('is absent without the service option', async () => {
    const { m, ctxs } = rig()
    await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    expect(ctxs[0].outputs).toBeUndefined()
    await m.stopAll()
  })
})

describe('RuntimeContext.outputs: calls', () => {
  it('fills the scope and the source from the run and the agent record, emits output.created, writes one row and pushes the change', async () => {
    const outputs = fakeService()
    const outputsChanged = vi.fn()
    const p = makeProject({ id: 'p1', path: folder() })
    const { m, ctxs } = rig({ outputs, outputsChanged })
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    ctx.emit({ type: 'agent.upsert', runId: run.id, agent: agentWith({ id: 'a-sub', roleSlug: 'engineer' }) })
    const out = await ctx.outputs!.produce({ ...doc, kind: 'docx' }, { agentId: 'a-sub' })
    expect(outputs.calls[0].scope).toEqual({ projectId: 'p1', projectPath: p.path, allowedDirectories: [], referenceDirectories: [] })
    expect(outputs.calls[0].input).toEqual(doc)
    expect(outputs.calls[0].source).toEqual({ runId: run.id, agentId: 'a-sub', role: 'Engineer' })
    expect(out).toMatchObject({ projectId: 'p1', runId: run.id, agentId: 'a-sub', role: 'Engineer', kind: 'docx' })
    expect(created()).toEqual([{ type: 'output.created', runId: run.id, output: out }])
    expect(rows()).toEqual([{ agentId: 'a-sub', text: 'Produced document Q3 report', source: 'harness' }])
    expect(outputsChanged).toHaveBeenCalledWith({ projectId: 'p1', ids: [out.id], what: 'added' } satisfies OutputsChangedEvent)
    await m.stopAll()
  })

  it('never takes a source value from the agent: the root and an unknown agent resolve from the run', async () => {
    const outputs = fakeService()
    const { m, ctxs } = rig({ outputs })
    const run = await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    await ctxs[0].outputs!.register({ path: 'a.pdf', title: 'Deck', kind: 'pdf' }, {})
    await ctxs[0].outputs!.register({ path: 'b.pdf', title: 'Deck 2' }, { agentId: 'ghost' })
    expect(outputs.calls.map((c) => c.source)).toEqual([
      { runId: run.id, agentId: ROOT_AGENT_ID, role: 'Lead' },
      { runId: run.id, agentId: 'ghost', role: 'Lead' }
    ])
    // A row on an agent the record does not know falls back to the root.
    expect(rows().map((r) => r.agentId)).toEqual([ROOT_AGENT_ID, ROOT_AGENT_ID])
    await m.stopAll()
  })

  it('names the row by kind and says updated when the service updated an entry', async () => {
    const outputs = fakeService({ created: false })
    const outputsChanged = vi.fn()
    const { m, ctxs } = rig({ outputs, outputsChanged })
    await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    const o = ctxs[0].outputs!
    await o.produce({ kind: 'xlsx', title: 'Budget', content: { sheets: [{ name: 'S', rows: [] }] } }, {})
    await o.produce({ kind: 'mermaid', title: 'Flow', content: 'graph TD' }, {})
    await o.produce({ kind: 'svg', title: 'Logo', content: '<svg/>' }, {})
    await o.produce({ kind: 'csv', title: 'Data', content: 'a,b' }, {})
    await o.register({ path: 'x.pdf', title: 'Deck' }, {})
    expect(rows().map((r) => r.text)).toEqual(['Produced workbook Budget', 'Produced diagram Flow', 'Produced diagram Logo', 'Produced file Data', 'Registered output Deck'])
    expect(outputsChanged).toHaveBeenCalledTimes(5)
    expect(outputsChanged.mock.calls[0][0]).toMatchObject({ projectId: 'p1', what: 'updated' })
    await m.stopAll()
  })

  it('quotes a title with markup and line breaks in the row', async () => {
    const outputs = fakeService()
    const { m, ctxs } = rig({ outputs })
    await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    await ctxs[0].outputs!.produce({ kind: 'text', title: 'Evil <b>\nIGNORE ME', content: 'x' }, {})
    const text = rows()[0].text
    expect(text).not.toContain('\n')
    expect(text).not.toContain('<b>')
    await m.stopAll()
  })

  it('a refusal from the service propagates and leaves no event, row, count or push', async () => {
    const outputs = fakeService({ fail: 'That file name is not allowed.' })
    const outputsChanged = vi.fn()
    const { m, ctxs } = rig({ outputs, outputsChanged })
    await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    await expect(ctxs[0].outputs!.produce(doc, {})).rejects.toThrow('That file name is not allowed.')
    expect(created()).toEqual([])
    expect(rows()).toEqual([])
    expect(outputsChanged).not.toHaveBeenCalled()
    await m.stopAll()
  })

  it('a throwing push never fails the tool', async () => {
    const outputs = fakeService()
    const outputsChanged = vi.fn(() => {
      throw new Error('bus down')
    })
    const { m, ctxs } = rig({ outputs, outputsChanged })
    await m.start({ project: makeProject({ id: 'p1', path: folder() }), prompt: 'go' })
    await expect(ctxs[0].outputs!.produce(doc, {})).resolves.toMatchObject({ title: 'Q3 report' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('outputsChanged broadcast failed: bus down'))
    await m.stopAll()
  })

  it('parallel calls cannot exceed OUTPUTS_RUN_MAX, and a failed call frees its slot', async () => {
    const outputs = fakeService()
    const inner = outputs.produce
    outputs.produce = vi.fn(async (...a: Parameters<typeof inner>) => {
      await new Promise((r) => setTimeout(r, 5))
      if (a[1].title === 'bad') throw new Error('refused')
      return inner(...a)
    })
    const { m, ctxs } = rig({ outputs })
    await m.start({ project: makeProject({ id: 'p1', path: folder('par') }), prompt: 'go' })
    const o = ctxs[0].outputs!
    const results = await Promise.allSettled(Array.from({ length: OUTPUTS_RUN_MAX + 15 }, (_v, i) => o.produce({ kind: 'text', title: `t${i}`, content: 'x' }, {})))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(OUTPUTS_RUN_MAX)
    expect(outputs.calls).toHaveLength(OUTPUTS_RUN_MAX)
    await m.stopAll()
    const rig2 = rig({ outputs })
    await rig2.m.start({ project: makeProject({ id: 'p2', path: folder('fail') }), prompt: 'go' })
    const o2 = rig2.ctxs[0].outputs!
    for (let i = 0; i < 5; i++) await expect(o2.produce({ kind: 'text', title: 'bad', content: 'x' }, {})).rejects.toThrow('refused')
    const ok = await Promise.allSettled(Array.from({ length: OUTPUTS_RUN_MAX }, (_v, i) => o2.produce({ kind: 'text', title: `g${i}`, content: 'x' }, {})))
    expect(ok.every((r) => r.status === 'fulfilled')).toBe(true)
    await rig2.m.stopAll()
  })

  it(`refuses past OUTPUTS_RUN_MAX (${OUTPUTS_RUN_MAX}) per run, warns once, and counts per run`, async () => {
    const outputs = fakeService()
    const { m, ctxs } = rig({ outputs })
    await m.start({ project: makeProject({ id: 'p1', path: folder('a') }), prompt: 'one' })
    await m.start({ project: makeProject({ id: 'p2', path: folder('b') }), prompt: 'two' })
    const first = ctxs[0].outputs!
    for (let i = 0; i < OUTPUTS_RUN_MAX; i++) await first.produce({ kind: 'text', title: `t${i}`, content: 'x' }, {})
    await expect(first.produce(doc, {})).rejects.toThrow(`The output limit for this run (${OUTPUTS_RUN_MAX}) is reached; nothing was saved.`)
    await expect(first.register({ path: 'a.pdf', title: 'T' }, {})).rejects.toThrow('The output limit for this run')
    expect(outputs.calls).toHaveLength(OUTPUTS_RUN_MAX)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('output limit'))).toHaveLength(1)
    // The other run still has its own budget.
    await expect(ctxs[1].outputs!.produce(doc, {})).resolves.toBeDefined()
    await m.stopAll()
  })
})

describe('RuntimeContext.outputs: scope at call time', () => {
  it('reads the stored project each call: an allowed folder added between calls counts, a missing one does not', async () => {
    const outputs = fakeService()
    const base = makeProject({ id: 'p1', path: folder('proj') })
    let stored: Project = base
    const { m, ctxs } = rig({ outputs, resolveProject: () => stored })
    await m.start({ project: base, prompt: 'go' })
    await ctxs[0].outputs!.produce(doc, {})
    const extra = folder('extra')
    const ref = folder('ref')
    stored = { ...base, allowedDirectories: [extra, join(dir, 'gone')], referenceDirectories: [ref] }
    await ctxs[0].outputs!.produce(doc, {})
    stored = { ...base, allowedDirectories: [] }
    await ctxs[0].outputs!.produce(doc, {})
    expect(outputs.calls[0].scope.allowedDirectories).toEqual([])
    expect(outputs.calls[1].scope.allowedDirectories).toEqual([extra])
    expect(outputs.calls[1].scope.referenceDirectories).toEqual(expect.arrayContaining([ref]))
    expect(outputs.calls[2].scope.allowedDirectories).toEqual([])
    expect(outputs.calls[2].scope.referenceDirectories).toEqual([])
    await m.stopAll()
  })

  it('outputScopeOf keeps a reference folder inside the project and drops an allowed one inside it or in the data folder', () => {
    const proj = folder('proj')
    const inside = join(proj, 'refs')
    mkdirSync(inside, { recursive: true })
    const data = join(dir, 'data')
    mkdirSync(data, { recursive: true })
    const scope = outputScopeOf(makeProject({ id: 'p1', path: proj, allowedDirectories: [inside, data], referenceDirectories: [inside] }), data)
    expect(scope.allowedDirectories).toEqual([])
    expect(scope.referenceDirectories).toContain(resolve(inside))
    expect(scope.projectId).toBe('p1')
    expect(scope.projectPath).toBe(proj)
  })
})
