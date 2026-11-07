import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTPUT_ID_RE, OUTPUTS_IPC, QUICK_PROJECT_ID } from '../../shared/types'
import type { OutputNote, OutputsChangedEvent, Project, RunOutput } from '../../shared/types'
import type { OutputScope, OutputsServiceApi } from '../outputs/api'
import type { OutputWatcher } from '../outputs/watch'
import { project as makeProject } from '../runtime/testHelpers'
import { outputArgs } from './args'
import { HostEventBus } from './events'
import { registerOutputsHandlers, watchOwnerOf } from './outputsHandlers'

const OID = 'out_0123456789abcdef'
const NID = 'note_0123456789abcdef'

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
const note = (over: Partial<OutputNote> = {}): OutputNote => ({ id: NID, outputId: OID, version: 1, anchor: { type: 'whole' }, text: 'n', status: 'open', createdAt: 1, ...over })

function fakeService(scopes: OutputScope[] = []): OutputsServiceApi {
  return {
    produce: vi.fn(),
    register: vi.fn(),
    list: vi.fn(() => [entry()]),
    get: vi.fn(() => entry()),
    preview: vi.fn(async (scope: OutputScope) => {
      scopes.push(scope)
      return { kind: 'text' as const, text: 'hi' }
    }),
    checkedPath: vi.fn(),
    forget: vi.fn(() => []),
    delete: vi.fn(async (scope: OutputScope) => {
      scopes.push(scope)
      return []
    }),
    deletePreview: vi.fn(() => ({ path: '/w/outputs/a.docx', relPath: 'outputs/a.docx', outsideOutputsFolder: false, versions: 2, trash: true, missing: false })),
    versions: vi.fn(() => []),
    readSource: vi.fn(async () => ({ text: 'x', digest: 'd' })),
    thumb: vi.fn(async () => ({ kind: 'lines' as const, lines: ['a'] })),
    compare: vi.fn(async () => ({ kind: 'none' as const, reason: 'no' })),
    saveEdit: vi.fn(async () => ({ ok: true as const, output: entry(), version: 3 })),
    restore: vi.fn(async () => ({ ok: true as const, output: entry(), version: 4 })),
    update: vi.fn(() => entry({ title: 'New' })),
    captureExternal: vi.fn(async () => null),
    statCurrent: vi.fn(() => null),
    notes: vi.fn(() => [note()]),
    noteAdd: vi.fn(() => note()),
    noteUpdate: vi.fn(() => note({ status: 'resolved' })),
    noteRemove: vi.fn(() => []),
    revisions: vi.fn(() => []),
    recordRevision: vi.fn((r) => ({ ...r })),
    runEnded: vi.fn(() => []),
    readForAgent: vi.fn()
  } as unknown as OutputsServiceApi
}

function fakeWatcher(): OutputWatcher & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    watch: vi.fn((owner: string) => {
      calls.push(`watch ${owner}`)
      return { watched: true as const }
    }),
    unwatch: vi.fn((owner: string) => {
      calls.push(`unwatch ${owner}`)
      return { watched: false as const }
    }),
    touch: vi.fn(),
    noteOpened: vi.fn(() => void calls.push('noteOpened')),
    dropOwner: vi.fn(),
    release: vi.fn(() => void calls.push('release')),
    checkProjects: vi.fn(),
    openedProjectIds: vi.fn(() => []),
    tick: vi.fn(async () => {}),
    size: vi.fn(() => 0),
    dispose: vi.fn()
  }
}

function setup(opts: { withService?: boolean; runs?: unknown; watcher?: OutputWatcher } = {}) {
  const proj = makeProject({ id: 'p1', path: dir })
  const scopes: OutputScope[] = []
  const service = fakeService(scopes)
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
    events,
    ...(opts.runs ? { runs: opts.runs as never } : {}),
    ...(opts.watcher ? { watcher: opts.watcher } : {})
  })
  const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({ surface: 'desktop', senderId: 7 }, ...args)
  return { call, service, scopes, pushed, handlers, setStored: (p: Project | null) => void (stored = p) }
}

const ref = { projectId: 'p1', outputId: OID }

describe('outputs handlers', () => {
  it('registers every dispatcher channel (the desktop-only ones are served by outputsIpc.ts)', () => {
    const expected = Object.values(OUTPUTS_IPC)
      .filter((c) => ![OUTPUTS_IPC.outputsOpen, OUTPUTS_IPC.outputsReveal, OUTPUTS_IPC.outputsSaveAs, OUTPUTS_IPC.outputsSaveImage, OUTPUTS_IPC.outputsChanged].includes(c as never))
      .sort()
    expect([...setup().handlers.keys()].sort()).toEqual(expected)
    expect(expected).toHaveLength(21)
  })

  it('list returns the service list for a stored project, [] for a virtual one, rejects an unknown project', () => {
    const s = setup()
    expect(s.call(OUTPUTS_IPC.outputsList, 'p1')).toEqual([entry()])
    expect(s.call(OUTPUTS_IPC.outputsList, QUICK_PROJECT_ID)).toEqual([])
    expect(s.service.list).toHaveBeenCalledTimes(1)
    expect(() => s.call(OUTPUTS_IPC.outputsList, 'p_nope')).toThrow('Project not found')
    expect(() => s.call(OUTPUTS_IPC.outputsList, '../x')).toThrow('Project not found')
  })

  it('preview reads the scope from the stored project at call time, passes the version and never rejects for a bad output', async () => {
    const s = setup()
    await expect(s.call(OUTPUTS_IPC.outputsPreview, ref)).resolves.toEqual({ kind: 'text', text: 'hi' })
    // An allowed folder beside the project (one inside it would be dropped as already free).
    const extra = mkdtempSync(join(tmpdir(), 'orgai-outputs-extra-'))
    try {
      s.setStored(makeProject({ id: 'p1', path: dir, allowedDirectories: [extra] }))
      await s.call(OUTPUTS_IPC.outputsPreview, { ...ref, version: 2 })
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
    expect(s.scopes[0]).toMatchObject({ projectId: 'p1', projectPath: dir, allowedDirectories: [] })
    expect(s.scopes[1].allowedDirectories).toHaveLength(1)
    expect(vi.mocked(s.service.preview).mock.calls[1][2]).toBe(2)
    await expect(s.call(OUTPUTS_IPC.outputsPreview, { projectId: QUICK_PROJECT_ID, outputId: OID })).resolves.toMatchObject({ kind: 'none' })
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsPreview, { projectId: 'p1', outputId: 'nope' }))).rejects.toThrow('Output not found')
  })

  it('preview tells the watcher the output was opened this session', async () => {
    const w = fakeWatcher()
    const s = setup({ watcher: w })
    await s.call(OUTPUTS_IPC.outputsPreview, ref)
    expect(w.noteOpened).toHaveBeenCalledWith({ projectId: 'p1', outputId: OID })
  })

  it('forget and delete push outputs:changed removed, release the watcher and return the list afterwards', async () => {
    const w = fakeWatcher()
    const s = setup({ watcher: w })
    expect(s.call(OUTPUTS_IPC.outputsForget, { ...ref, extra: 1 })).toEqual([])
    expect(s.service.forget).toHaveBeenCalledWith('p1', OID)
    await expect(s.call(OUTPUTS_IPC.outputsDelete, { ...ref, expectedVersionCount: 2 })).resolves.toEqual([])
    expect(vi.mocked(s.service.delete).mock.calls[0][1]).toEqual({ outputId: OID, expectedVersionCount: 2 })
    // Back-compat: an OutputRef alone (no count).
    await s.call(OUTPUTS_IPC.outputsDelete, ref)
    expect(vi.mocked(s.service.delete).mock.calls[1][1]).toEqual({ outputId: OID })
    expect(s.pushed).toEqual([
      { projectId: 'p1', ids: [OID], what: 'removed' },
      { projectId: 'p1', ids: [OID], what: 'removed' },
      { projectId: 'p1', ids: [OID], what: 'removed' }
    ])
    expect(w.release).toHaveBeenCalledTimes(3)
    expect(s.scopes[0].projectPath).toBe(dir)
  })

  it('a refused delete (stale count) propagates and pushes nothing', async () => {
    const s = setup()
    vi.mocked(s.service.delete).mockRejectedValue(new Error('This output changed. Check it and delete again.'))
    await expect(s.call(OUTPUTS_IPC.outputsDelete, { ...ref, expectedVersionCount: 1 })).rejects.toThrow('This output changed')
    expect(s.pushed).toEqual([])
  })

  it('forget and delete reject a virtual or unknown project and push nothing', async () => {
    const s = setup()
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: QUICK_PROJECT_ID, outputId: OID })).toThrow('Assistants have no outputs.')
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsDelete, { projectId: QUICK_PROJECT_ID, outputId: OID }))).rejects.toThrow('Assistants have no outputs.')
    expect(() => s.call(OUTPUTS_IPC.outputsForget, { projectId: 'p_nope', outputId: OID })).toThrow('Project not found')
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsDelete, { projectId: 'p_nope', outputId: OID }))).rejects.toThrow('Project not found')
    expect(s.pushed).toEqual([])
    expect(s.service.forget).not.toHaveBeenCalled()
  })

  it('a failing service call propagates and pushes nothing', () => {
    const s = setup()
    vi.mocked(s.service.forget).mockImplementation(() => {
      throw new Error('Output not found')
    })
    expect(() => s.call(OUTPUTS_IPC.outputsForget, ref)).toThrow('Output not found')
    expect(s.pushed).toEqual([])
  })

  it('without a service: list [], preview none, writes reject', async () => {
    const s = setup({ withService: false })
    expect(s.call(OUTPUTS_IPC.outputsList, 'p1')).toEqual([])
    await expect(s.call(OUTPUTS_IPC.outputsPreview, ref)).resolves.toEqual({ kind: 'none', reason: 'Outputs are not available.' })
    expect(() => s.call(OUTPUTS_IPC.outputsForget, ref)).toThrow('Outputs are not available.')
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsDelete, ref))).rejects.toThrow('Outputs are not available.')
    expect(s.call(OUTPUTS_IPC.outputsVersions, ref)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsNotes, ref)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsRevisions, ref)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsReviseOptions, ref)).toEqual({ runs: [], newRunAllowed: false })
    expect(s.call(OUTPUTS_IPC.outputsWatch, ref)).toEqual({ refused: 'Outputs are not available.' })
  })
})

describe('outputs handlers: versions and reads', () => {
  it('deletePreview, versions, readSource, thumb, compare, notes and revisions go to the service with the stored scope', async () => {
    const s = setup()
    expect(s.call(OUTPUTS_IPC.outputsDeletePreview, ref)).toMatchObject({ versions: 2, trash: true })
    expect(s.call(OUTPUTS_IPC.outputsVersions, ref)).toEqual([])
    await expect(s.call(OUTPUTS_IPC.outputsReadSource, { ...ref, version: 2 })).resolves.toEqual({ text: 'x', digest: 'd' })
    expect(vi.mocked(s.service.readSource).mock.calls[0].slice(1)).toEqual([OID, 2])
    await expect(s.call(OUTPUTS_IPC.outputsThumb, { ...ref, version: 1 })).resolves.toMatchObject({ kind: 'lines' })
    await expect(s.call(OUTPUTS_IPC.outputsCompare, { ...ref, a: 1, b: 2, junk: true })).resolves.toMatchObject({ kind: 'none' })
    expect(vi.mocked(s.service.compare).mock.calls[0][1]).toEqual({ outputId: OID, a: 1, b: 2 })
    expect(s.call(OUTPUTS_IPC.outputsNotes, ref)).toEqual([note()])
    expect(s.call(OUTPUTS_IPC.outputsRevisions, ref)).toEqual([])
    expect(s.scopes).toEqual([])
    expect(vi.mocked(s.service.readSource).mock.calls[0][0]).toMatchObject({ projectPath: dir })
    expect(s.pushed).toEqual([])
  })

  it('virtual project ids: reads answer empty or none, deletePreview rejects', async () => {
    const s = setup()
    const v = { projectId: QUICK_PROJECT_ID, outputId: OID }
    expect(s.call(OUTPUTS_IPC.outputsVersions, v)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsNotes, v)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsRevisions, v)).toEqual([])
    expect(s.call(OUTPUTS_IPC.outputsReviseOptions, v)).toEqual({ runs: [], newRunAllowed: false })
    await expect(s.call(OUTPUTS_IPC.outputsThumb, { ...v, version: 1 })).resolves.toEqual({ kind: 'none' })
    await expect(s.call(OUTPUTS_IPC.outputsCompare, { ...v, a: 1, b: 2 })).resolves.toMatchObject({ kind: 'none' })
    await expect(s.call(OUTPUTS_IPC.outputsReadSource, { ...v, version: 1 })).resolves.toEqual({ refused: 'Assistants have no outputs.' })
    expect(() => s.call(OUTPUTS_IPC.outputsDeletePreview, v)).toThrow('Assistants have no outputs.')
    expect(s.service.versions).not.toHaveBeenCalled()
  })

  it('bad shapes are refused before the service is called', async () => {
    const s = setup()
    expect(() => s.call(OUTPUTS_IPC.outputsVersions, { projectId: 'p1', outputId: '../x' })).toThrow('Output not found')
    await expect(Promise.resolve().then(() => s.call(OUTPUTS_IPC.outputsReadSource, { ...ref, version: 0 }))).rejects.toThrow()
    expect(s.service.readSource).not.toHaveBeenCalled()
  })
})

describe('outputs handlers: writes push the right `what`', () => {
  it('saveEdit and restore push version only on success; stale and refused push nothing', async () => {
    const s = setup()
    await expect(s.call(OUTPUTS_IPC.outputsSaveEdit, { ...ref, baseVersion: 2, text: 'new', forceNew: true, extra: 1 })).resolves.toEqual({ ok: true, output: entry(), version: 3 })
    expect(vi.mocked(s.service.saveEdit).mock.calls[0][1]).toEqual({ outputId: OID, baseVersion: 2, text: 'new', forceNew: true })
    await s.call(OUTPUTS_IPC.outputsRestore, { ...ref, version: 1 })
    expect(s.pushed).toEqual([
      { projectId: 'p1', ids: [OID], what: 'version' },
      { projectId: 'p1', ids: [OID], what: 'version' }
    ])
    s.pushed.length = 0
    vi.mocked(s.service.saveEdit).mockResolvedValueOnce({ stale: true, currentVersion: 5 })
    vi.mocked(s.service.restore).mockResolvedValueOnce({ refused: 'No.' })
    await expect(s.call(OUTPUTS_IPC.outputsSaveEdit, { ...ref, baseVersion: 2, text: 'x' })).resolves.toEqual({ stale: true, currentVersion: 5 })
    await expect(s.call(OUTPUTS_IPC.outputsRestore, { ...ref, version: 1 })).resolves.toEqual({ refused: 'No.' })
    expect(s.pushed).toEqual([])
  })

  it('update pushes updated; note writes push notes', () => {
    const s = setup()
    expect(s.call(OUTPUTS_IPC.outputsUpdate, { ...ref, title: 'New', versionLabel: { n: 1, label: 'Final' } })).toMatchObject({ title: 'New' })
    expect(vi.mocked(s.service.update).mock.calls[0]).toEqual(['p1', { outputId: OID, title: 'New', versionLabel: { n: 1, label: 'Final' } }])
    s.call(OUTPUTS_IPC.outputsNoteAdd, { ...ref, version: 1, anchor: { type: 'whole' }, text: 'hello' })
    s.call(OUTPUTS_IPC.outputsNoteUpdate, { ...ref, noteId: NID, status: 'resolved' })
    s.call(OUTPUTS_IPC.outputsNoteRemove, { ...ref, noteId: NID })
    expect(s.pushed.map((p) => p.what)).toEqual(['updated', 'notes', 'notes', 'notes'])
    expect(vi.mocked(s.service.noteAdd).mock.calls[0]).toEqual(['p1', { outputId: OID, version: 1, anchor: { type: 'whole' }, text: 'hello' }])
  })

  it('every write rejects a virtual project', async () => {
    const s = setup()
    const v = { projectId: QUICK_PROJECT_ID, outputId: OID }
    const calls: [string, unknown][] = [
      [OUTPUTS_IPC.outputsSaveEdit, { ...v, baseVersion: 1, text: 'x' }],
      [OUTPUTS_IPC.outputsRestore, { ...v, version: 1 }],
      [OUTPUTS_IPC.outputsUpdate, { ...v, title: 'x' }],
      [OUTPUTS_IPC.outputsNoteAdd, { ...v, version: 1, anchor: { type: 'whole' }, text: 'x' }],
      [OUTPUTS_IPC.outputsNoteUpdate, { ...v, noteId: NID, text: 'x' }],
      [OUTPUTS_IPC.outputsNoteRemove, { ...v, noteId: NID }],
      [OUTPUTS_IPC.outputsRevise, { ...v, version: 1, scope: 'whole', instruction: 'x', target: { type: 'new' } }]
    ]
    for (const [channel, input] of calls) await expect(Promise.resolve().then(() => s.call(channel, input)), channel).rejects.toThrow('Assistants have no outputs.')
    expect(s.pushed).toEqual([])
  })
})

describe('outputs handlers: revise', () => {
  const runsFake = () => ({
    summary: vi.fn(() => null),
    liveRuns: vi.fn(() => []),
    list: vi.fn(() => []),
    liveRunFacts: vi.fn(() => null),
    isQuitting: vi.fn(() => false),
    send: vi.fn(),
    continueRun: vi.fn(),
    start: vi.fn(async () => ({ id: 'run_new' }))
  })

  it('a new run: routes through the runs object, records the request and pushes revision', async () => {
    const runs = runsFake()
    const s = setup({ runs })
    vi.mocked(s.service.versions).mockReturnValue([{ n: 1 } as never])
    const r = (await s.call(OUTPUTS_IPC.outputsRevise, { ...ref, version: 1, scope: 'whole', instruction: 'Tighten it', target: { type: 'new' } })) as { requestId: string; runId: string; mode: string }
    expect(r).toMatchObject({ runId: 'run_new', mode: 'started' })
    expect(r.requestId).toMatch(/^rev_[0-9a-f]{16}$/)
    expect(s.service.recordRevision).toHaveBeenCalledTimes(1)
    expect(s.pushed).toEqual([{ projectId: 'p1', ids: [OID], what: 'revision' }])
  })

  it('a refusal comes back as { refused } and pushes nothing; notes scope also pushes notes', async () => {
    const runs = runsFake()
    runs.start.mockRejectedValueOnce(new Error('OrgAI is quitting.'))
    const s = setup({ runs })
    vi.mocked(s.service.versions).mockReturnValue([{ n: 1 } as never])
    await expect(s.call(OUTPUTS_IPC.outputsRevise, { ...ref, version: 1, scope: 'whole', instruction: 'x', target: { type: 'new' } })).resolves.toEqual({ refused: 'OrgAI is quitting.' })
    expect(s.pushed).toEqual([])
    vi.mocked(s.service.notes).mockReturnValue([note()])
    await s.call(OUTPUTS_IPC.outputsRevise, { ...ref, version: 1, scope: 'notes', noteIds: [NID], instruction: '', target: { type: 'new' } })
    expect(s.pushed.map((p) => p.what)).toEqual(['revision', 'notes'])
  })

  it('reviseOptions reads the output and the runs; without runs it offers nothing', () => {
    const runs = runsFake()
    const s = setup({ runs })
    expect(s.call(OUTPUTS_IPC.outputsReviseOptions, ref)).toEqual({ runs: [], newRunAllowed: true })
    vi.mocked(s.service.get).mockReturnValue(undefined)
    expect(() => s.call(OUTPUTS_IPC.outputsReviseOptions, ref)).toThrow('Output not found')
  })

  it('without a runs object a revise is refused as a result, never a throw', async () => {
    const s = setup()
    await expect(s.call(OUTPUTS_IPC.outputsRevise, { ...ref, version: 1, scope: 'whole', instruction: 'x', target: { type: 'new' } })).resolves.toEqual({ refused: 'Outputs are not available.' })
  })
})

describe('outputs handlers: watch', () => {
  it('watch and unwatch go to the watcher with the caller as owner; a virtual project is refused', () => {
    const w = fakeWatcher()
    const s = setup({ watcher: w })
    expect(s.call(OUTPUTS_IPC.outputsWatch, ref)).toEqual({ watched: true })
    expect(s.call(OUTPUTS_IPC.outputsUnwatch, ref)).toEqual({ watched: false })
    expect(w.calls).toEqual(['watch window:7', 'unwatch window:7'])
    expect(s.call(OUTPUTS_IPC.outputsWatch, { projectId: QUICK_PROJECT_ID, outputId: OID })).toEqual({ refused: 'Assistants have no outputs.' })
  })

  it('owners: a window by web contents id, a socket client by its connection id (never the reported pid), distinct per surface', () => {
    expect(watchOwnerOf({ surface: 'desktop', senderId: 3 })).toBe('window:3')
    expect(watchOwnerOf({ surface: 'socket', connectionId: '7' })).toBe('socket:7')
    expect(watchOwnerOf({ surface: 'socket', connectionId: '8', pid: 4242 } as never)).toBe('socket:8')
    expect(watchOwnerOf({ surface: 'inproc', clientKind: 'cli' })).toBe('inproc:cli')
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

  it('preview keeps an optional integer version >= 1 and refuses anything else', () => {
    expect(outputArgs.preview(ref)).toEqual(ref)
    expect(outputArgs.preview({ ...ref, version: null })).toEqual(ref)
    expect(outputArgs.preview({ ...ref, version: 3, path: '/x' })).toEqual({ ...ref, version: 3 })
    for (const v of [0, -1, 1.5, '2', NaN, Infinity, 2e9, {}]) expect(() => outputArgs.preview({ ...ref, version: v }), String(v)).toThrow()
  })

  it('versionRef and compare need integers >= 1', () => {
    expect(outputArgs.versionRef({ ...ref, version: 2, x: 1 })).toEqual({ ...ref, version: 2 })
    expect(() => outputArgs.versionRef(ref)).toThrow()
    expect(outputArgs.compare({ ...ref, a: 1, b: 2 })).toEqual({ ...ref, a: 1, b: 2 })
    expect(() => outputArgs.compare({ ...ref, a: 1 })).toThrow()
    expect(() => outputArgs.compare({ ...ref, a: 0, b: 2 })).toThrow()
  })

  it('saveEdit takes text and an optional boolean forceNew', () => {
    expect(outputArgs.saveEdit({ ...ref, baseVersion: 1, text: 't' })).toEqual({ ...ref, baseVersion: 1, text: 't' })
    expect(outputArgs.saveEdit({ ...ref, baseVersion: 1, text: '', forceNew: false })).toEqual({ ...ref, baseVersion: 1, text: '', forceNew: false })
    expect(() => outputArgs.saveEdit({ ...ref, baseVersion: 1, text: 5 })).toThrow()
    expect(() => outputArgs.saveEdit({ ...ref, baseVersion: 1, text: 't', forceNew: 'yes' })).toThrow()
    expect(() => outputArgs.saveEdit({ ...ref, baseVersion: 1, text: 'x'.repeat(2 * 1024 * 1024) })).toThrow('too long')
  })

  it('update rebuilds title, description and versionLabel and drops paths', () => {
    expect(outputArgs.update({ ...ref, title: 'T', description: '', versionLabel: { n: 2, label: '', extra: 1 }, path: '/etc/passwd' })).toEqual({ ...ref, title: 'T', description: '', versionLabel: { n: 2, label: '' } })
    expect(outputArgs.update(ref)).toEqual(ref)
    expect(() => outputArgs.update({ ...ref, title: 5 })).toThrow()
    expect(() => outputArgs.update({ ...ref, versionLabel: { n: 0, label: 'x' } })).toThrow()
    expect(() => outputArgs.update({ ...ref, versionLabel: 'x' })).toThrow()
  })

  it('delete accepts an OutputRef (back-compat) or one with an expectedVersionCount integer', () => {
    expect(outputArgs.delete(ref)).toEqual(ref)
    expect(outputArgs.delete({ ...ref, expectedVersionCount: 3 })).toEqual({ ...ref, expectedVersionCount: 3 })
    for (const v of [-1, 1.5, '3', NaN]) expect(() => outputArgs.delete({ ...ref, expectedVersionCount: v })).toThrow()
  })

  it('noteAdd rebuilds the anchor field by field per type and refuses unknown types and junk numbers', () => {
    const add = (anchor: unknown) => outputArgs.noteAdd({ ...ref, version: 1, anchor, text: 'hi' })
    expect(add({ type: 'text', start: 1, end: 4, quote: 'abc', path: '/x' }).anchor).toEqual({ type: 'text', start: 1, end: 4, quote: 'abc' })
    expect(add({ type: 'block', index: 0, start: 0, end: 2, quote: 'ab' }).anchor).toEqual({ type: 'block', index: 0, start: 0, end: 2, quote: 'ab' })
    expect(add({ type: 'cells', sheet: 'S', r1: 0, c1: 0, r2: 1, c2: 2 }).anchor).toEqual({ type: 'cells', sheet: 'S', r1: 0, c1: 0, r2: 1, c2: 2 })
    expect(add({ type: 'region', slide: 2, shape: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.4, labels: ['A'] }).anchor).toEqual({ type: 'region', slide: 2, shape: 'box', x: 0.1, y: 0.2, w: 0.3, h: 0.4, labels: ['A'] })
    expect(add({ type: 'slide', slide: 3 }).anchor).toEqual({ type: 'slide', slide: 3 })
    expect(add({ type: 'whole', junk: 1 }).anchor).toEqual({ type: 'whole' })
    for (const bad of [null, 'x', [], { type: 'file', path: '/etc/passwd' }, { type: 'text', start: -1, end: 2, quote: '' }, { type: 'text', start: 1, end: NaN, quote: '' }, { type: 'region', shape: 'star', x: 0, y: 0, w: 1, h: 1 }, { type: 'region', shape: 'box', x: Infinity, y: 0, w: 1, h: 1 }, { type: 'text', start: 0, end: 1, quote: 5 }]) {
      expect(() => add(bad), JSON.stringify(bad)).toThrow()
    }
    expect(() => outputArgs.noteAdd({ ...ref, version: 1, anchor: { type: 'whole' }, text: 5 })).toThrow()
    expect(() => add({ type: 'region', shape: 'box', x: 0, y: 0, w: 1, h: 1, labels: new Array(300).fill('a') })).toThrow()
  })

  it('noteUpdate and noteRemove need a note id; noteUpdate never accepts status sent', () => {
    expect(outputArgs.noteUpdate({ ...ref, noteId: NID, text: 't', status: 'resolved', x: 1 })).toEqual({ ...ref, noteId: NID, text: 't', status: 'resolved' })
    expect(() => outputArgs.noteUpdate({ ...ref, noteId: NID, status: 'sent' })).toThrow('open or resolved')
    expect(() => outputArgs.noteUpdate({ ...ref, noteId: 'note_x' })).toThrow('Note not found')
    expect(outputArgs.noteRemove({ ...ref, noteId: NID })).toEqual({ ...ref, noteId: NID })
    expect(() => outputArgs.noteRemove({ ...ref, noteId: '../note_0123456789abcdef' })).toThrow('Note not found')
  })

  it('revise rebuilds scope, target, anchor and note ids', () => {
    const base = { ...ref, version: 2, scope: 'whole', instruction: 'Do it', target: { type: 'run', runId: 'run_1', extra: 1 } }
    expect(outputArgs.revise({ ...base, path: '/x' })).toEqual({ ...ref, version: 2, scope: 'whole', instruction: 'Do it', target: { type: 'run', runId: 'run_1' } })
    expect(outputArgs.revise({ ...base, target: { type: 'new' }, scope: 'selection', anchor: { type: 'slide', slide: 1 } })).toMatchObject({ target: { type: 'new' }, anchor: { type: 'slide', slide: 1 } })
    expect(outputArgs.revise({ ...base, scope: 'notes', noteIds: [NID] })).toMatchObject({ noteIds: [NID] })
    for (const bad of [{ scope: 'all' }, { target: { type: 'run', runId: '../x' } }, { target: { type: 'file' } }, { target: null }, { noteIds: ['n1'] }, { noteIds: 'x' }, { instruction: 5 }, { version: 0 }]) {
      expect(() => outputArgs.revise({ ...base, ...bad }), JSON.stringify(bad)).toThrow()
    }
  })

  it('saveImage takes a mime of png or svg, base64 text and a name; never a path field', () => {
    const r = outputArgs.saveImage({ ...ref, suggestedName: 'a', mime: 'image/png', dataBase64: 'AAAA', path: '/etc/passwd' })
    expect(r).toEqual({ ...ref, suggestedName: 'a', mime: 'image/png', dataBase64: 'AAAA' })
    expect(() => outputArgs.saveImage({ ...ref, suggestedName: 'a', mime: 'image/gif', dataBase64: 'AAAA' })).toThrow()
    expect(() => outputArgs.saveImage({ ...ref, suggestedName: 'a', mime: 'image/png', dataBase64: 5 })).toThrow()
    expect(() => outputArgs.saveImage({ ...ref, suggestedName: 'a'.repeat(300), mime: 'image/png', dataBase64: 'AAAA' })).toThrow()
    expect(() => outputArgs.saveImage({ ...ref, suggestedName: 'a', mime: 'image/png', dataBase64: 'A'.repeat(40 * 1024 * 1024) })).toThrow('too long')
  })
})
