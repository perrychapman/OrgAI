import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTPUT_ID_RE, OUTPUTS_IPC, QUICK_PROJECT_ID } from '../../shared/types'
import type { OutputsChangedEvent, Project, RunOutput } from '../../shared/types'
import type { OutputScope, OutputsServiceApi } from '../outputs/api'
import { project as makeProject } from '../runtime/testHelpers'
import { outputArgs } from './args'
import { HostEventBus } from './events'
import { registerOutputsHandlers } from './outputsHandlers'

const OID = 'out_0123456789abcdef'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-outputs-handlers-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const entry = (over: Partial<RunOutput> = {}): RunOutput => ({
  id: OID,
  projectId: 'p1',
  runId: 'r1',
  kind: 'docx',
  title: 'T',
  fileName: 'a.docx',
  path: '/w/outputs/a.docx',
  relPath: 'outputs/a.docx',
  bytes: 1,
  createdAt: 1,
  source: 'produced',
  ...over
})

function setup(opts: { withService?: boolean } = {}) {
  const proj = makeProject({ id: 'p1', path: dir })
  const scopes: OutputScope[] = []
  const service: OutputsServiceApi = {
    produce: vi.fn(),
    register: vi.fn(),
    list: vi.fn(() => [entry()]),
    get: vi.fn(),
    preview: vi.fn(async (scope) => {
      scopes.push(scope)
      return { kind: 'text' as const, text: 'hi' }
    }),
    checkedPath: vi.fn(),
    forget: vi.fn(() => []),
    delete: vi.fn((scope) => {
      scopes.push(scope)
      return []
    })
  }
  const handlers = new Map<string, (ctx: unknown, ...a: unknown[]) => unknown>()
  const events = new HostEventBus()
  const pushed: OutputsChangedEvent[] = []
  events.on((channel, payload) => {
    if (channel === OUTPUTS_IPC.outputsChanged) pushed.push(payload as OutputsChangedEvent)
  })
  let stored: Project | null = proj
  registerOutputsHandlers((c, fn) => void handlers.set(c, fn), {
    outputs: opts.withService === false ? undefined : service,
    projects: { get: (id) => (id === 'p1' ? stored : null) },
    events
  })
  const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({}, ...args)
  return { call, service, scopes, pushed, handlers, setStored: (p: Project | null) => void (stored = p) }
}

describe('outputs handlers', () => {
  it('registers exactly the four dispatcher channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([OUTPUTS_IPC.outputsDelete, OUTPUTS_IPC.outputsForget, OUTPUTS_IPC.outputsList, OUTPUTS_IPC.outputsPreview])
  })

  it('list returns the service list for a stored project, [] for a virtual one, rejects an unknown project', () => {
    const s = setup()
    expect(s.call(OUTPUTS_IPC.outputsList, 'p1')).toEqual([entry()])
    expect(s.call(OUTPUTS_IPC.outputsList, QUICK_PROJECT_ID)).toEqual([])
    expect(s.service.list).toHaveBeenCalledTimes(1)
    expect(() => s.call(OUTPUTS_IPC.outputsList, 'p_nope')).toThrow('Project not found')
    expect(() => s.call(OUTPUTS_IPC.outputsList, '../x')).toThrow('Project not found')
  })

  it('preview reads the scope from the stored project at call time and never rejects for a bad output', async () => {
    const s = setup()
    await expect(s.call(OUTPUTS_IPC.outputsPreview, { projectId: 'p1', outputId: OID })).resolves.toEqual({ kind: 'text', text: 'hi' })
    // An allowed folder beside the project (one inside it would be dropped as already free).
    const extra = mkdtempSync(join(tmpdir(), 'orgai-outputs-extra-'))
    try {
      s.setStored(makeProject({ id: 'p1', path: dir, allowedDirectories: [extra] }))
      await s.call(OUTPUTS_IPC.outputsPreview, { projectId: 'p1', outputId: OID })
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
    expect(s.scopes[0]).toMatchObject({ projectId: 'p1', projectPath: dir, allowedDirectories: [] })
    expect(s.scopes[1].allowedDirectories).toHaveLength(1)
    await expect(s.call(OUTPUTS_IPC.outputsPreview, { projectId: QUICK_PROJECT_ID, outputId: OID })).resolves.toMatchObject({ kind: 'none' })
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsPreview, { projectId: 'p1', outputId: 'nope' }))).rejects.toThrow('Output not found')
  })

  it('forget and delete push outputs:changed removed and return the list afterwards', async () => {
    const s = setup()
    expect(s.call(OUTPUTS_IPC.outputsForget, { projectId: 'p1', outputId: OID, extra: 1 })).toEqual([])
    expect(s.service.forget).toHaveBeenCalledWith('p1', OID)
    expect(s.call(OUTPUTS_IPC.outputsDelete, { projectId: 'p1', outputId: OID })).toEqual([])
    expect(s.pushed).toEqual([
      { projectId: 'p1', ids: [OID], what: 'removed' },
      { projectId: 'p1', ids: [OID], what: 'removed' }
    ])
    expect(s.scopes[0].projectPath).toBe(dir)
  })

  it('forget and delete reject a virtual or unknown project and push nothing', () => {
    const s = setup()
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: QUICK_PROJECT_ID, outputId: OID })).toThrow('Assistants have no outputs.')
    expect(() => s.call(OUTPUTS_IPC.outputsDelete, { projectId: QUICK_PROJECT_ID, outputId: OID })).toThrow('Assistants have no outputs.')
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: 'p_nope', outputId: OID })).toThrow('Project not found')
    expect(() => s.call(OUTPUTS_IPC.outputsDelete, { projectId: 'p_nope', outputId: OID })).toThrow('Project not found')
    expect(s.pushed).toEqual([])
    expect(s.service.forget).not.toHaveBeenCalled()
  })

  it('a failing service call propagates and pushes nothing', () => {
    const s = setup()
    vi.mocked(s.service.forget).mockImplementation(() => {
      throw new Error('Output not found')
    })
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: 'p1', outputId: OID })).toThrow('Output not found')
    expect(s.pushed).toEqual([])
  })

  it('without a service: list [], preview none, forget and delete reject', async () => {
    const s = setup({ withService: false })
    expect(s.call(OUTPUTS_IPC.outputsList, 'p1')).toEqual([])
    await expect(s.call(OUTPUTS_IPC.outputsPreview, { projectId: 'p1', outputId: OID })).resolves.toEqual({ kind: 'none', reason: 'Outputs are not available.' })
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: 'p1', outputId: OID })).toThrow('Outputs are not available.')
    expect(() => s.call(OUTPUTS_IPC.outputsDelete, { projectId: 'p1', outputId: OID })).toThrow('Outputs are not available.')
  })
})

describe('outputArgs', () => {
  it('projectId takes a safe id (virtual ids pass for the handler to answer) and refuses the rest', () => {
    expect(outputArgs.projectId('p_abc-1')).toBe('p_abc-1')
    expect(outputArgs.projectId('quick')).toBe('quick')
    for (const bad of ['', '../x', 'a/b', 5, null, undefined, {}, 'x'.repeat(200)]) expect(() => outputArgs.projectId(bad)).toThrow('Project not found')
  })

  it('ref rebuilds { projectId, outputId } and drops extra fields', () => {
    const r = outputArgs.ref({ projectId: 'p1', outputId: OID, path: '/etc/passwd', __proto__: { x: 1 } })
    expect(r).toEqual({ projectId: 'p1', outputId: OID })
    expect(Object.keys(r)).toEqual(['projectId', 'outputId'])
    expect(OUTPUT_ID_RE.test(r.outputId)).toBe(true)
  })

  it('ref refuses other shapes and ids that do not match OUTPUT_ID_RE', () => {
    for (const bad of [null, undefined, 'p1', 7, [], ['p1', OID]]) expect(() => outputArgs.ref(bad)).toThrow('Project not found')
    for (const id of ['', 'out_', 'out_0123456789ABCDEF', 'out_0123456789abcde', 'out_0123456789abcdef0', '../out_0123456789abcdef', 5, null]) {
      expect(() => outputArgs.ref({ projectId: 'p1', outputId: id }), String(id)).toThrow('Output not found')
    }
    expect(() => outputArgs.ref({ projectId: '../p', outputId: OID })).toThrow('Project not found')
  })
})
