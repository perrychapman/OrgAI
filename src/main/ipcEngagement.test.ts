import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { EngagementChangedEvent, EngagementNote, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, Project, ProjectRemoveResult } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const fakeWindow = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) } }
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [fakeWindow] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '' }))

const { effectiveRemoveRuns, knowledgeArgs, projectRemoveArgs, registerIpc, removalFacts, templateEngagementArgs: args } = await import('./ipc')
const { project: makeProject } = await import('./runtime/testHelpers')
const { saveNote, readRetainedRunProjects, writeEngagementDocumentFromSetup, writeEngagementDocument } = await import('./store/projectData')
const { readKnowledge, upsertNode } = await import('./store/knowledge')
const AGENT = { by: 'agent', at: 1, runId: 'run_1' } as const

describe('projectRemoveArgs and effectiveRemoveRuns', () => {
  it('accepts a bare id or an object, drops extra fields, refuses junk', () => {
    expect(projectRemoveArgs('proj_a')).toEqual({ projectId: 'proj_a', removeRuns: undefined })
    expect(projectRemoveArgs({ projectId: 'proj_a', removeRuns: false, evil: 1 })).toEqual({ projectId: 'proj_a', removeRuns: false })
    expect(projectRemoveArgs({ projectId: 'proj_a' })).toEqual({ projectId: 'proj_a', removeRuns: undefined })
    for (const bad of [null, undefined, 5, {}, { projectId: 7 }, { projectId: '../x' }, '../x', '']) expect(() => projectRemoveArgs(bad), JSON.stringify(bad)).toThrow()
    for (const v of ['harness', 'quick', 'skills']) {
      expect(() => projectRemoveArgs(v)).toThrow(/cannot be removed/)
      expect(() => projectRemoveArgs({ projectId: v })).toThrow(/cannot be removed/)
    }
    expect(() => projectRemoveArgs({ projectId: 'proj_a', removeRuns: 'no' })).toThrow()
  })

  it('removes runs by default; an engagement always does', () => {
    expect(effectiveRemoveRuns('code', undefined)).toBe(true)
    expect(effectiveRemoveRuns('code', true)).toBe(true)
    expect(effectiveRemoveRuns('code', false)).toBe(false)
    expect(effectiveRemoveRuns('engagement', false)).toBe(true)
  })
})

describe('templateEngagementArgs', () => {
  it('rebuilds template inputs', () => {
    expect(args.saveTemplate({ projectId: 'proj_a', name: 'N', description: 'D', extra: 1 })).toEqual({ projectId: 'proj_a', name: 'N', description: 'D' })
    expect(args.saveTemplate({ projectId: 'proj_a', name: 'N' })).toEqual({ projectId: 'proj_a', name: 'N' })
    for (const bad of [null, {}, { projectId: 'quick', name: 'N' }, { projectId: 'proj_a', name: 5 }, { projectId: 'proj_a', name: 'N', description: 5 }, { projectId: '../x', name: 'N' }]) {
      expect(() => args.saveTemplate(bad), JSON.stringify(bad)).toThrow()
    }
    expect(args.applyTemplate({ projectId: 'proj_a', templateId: 'tpl_1', mode: 'merge', x: 1 })).toEqual({ projectId: 'proj_a', templateId: 'tpl_1', mode: 'merge' })
    for (const bad of [{ projectId: 'proj_a', templateId: 'tpl_1', mode: 'add' }, { projectId: 'proj_a', templateId: '../x', mode: 'replace' }, { projectId: 'harness', templateId: 'tpl_1', mode: 'replace' }, null]) {
      expect(() => args.applyTemplate(bad), JSON.stringify(bad)).toThrow()
    }
    expect(args.templateId('tpl_1')).toBe('tpl_1')
    for (const bad of ['../x', '', 5, null, {}]) expect(() => args.templateId(bad)).toThrow(/not found/)
  })

  it('rebuilds document and note inputs', () => {
    expect(args.updateDocument({ projectId: 'proj_a', text: 'hi', expectedUpdatedAt: 5, x: 1 })).toEqual({ projectId: 'proj_a', text: 'hi', expectedUpdatedAt: 5 })
    expect(args.updateDocument({ projectId: 'proj_a', text: '' })).toEqual({ projectId: 'proj_a', text: '' })
    for (const bad of [{ projectId: 'proj_a', text: 5 }, { projectId: 'proj_a', text: 'x', expectedUpdatedAt: 'now' }, { projectId: 'proj_a', text: 'x', expectedUpdatedAt: -1 }, { projectId: 'proj_a', text: 'x', expectedUpdatedAt: NaN }, { projectId: 'skills', text: 'x' }, null]) {
      expect(() => args.updateDocument(bad), JSON.stringify(bad)).toThrow()
    }
    expect(args.noteRef({ projectId: 'proj_a', noteId: 'note_ab12', x: 1 })).toEqual({ projectId: 'proj_a', noteId: 'note_ab12' })
    for (const bad of [{ projectId: 'proj_a', noteId: '../x' }, { projectId: 'proj_a', noteId: 'tpl_1' }, { projectId: 'proj_a' }, { projectId: 'quick', noteId: 'note_a' }, null]) {
      expect(() => args.noteRef(bad), JSON.stringify(bad)).toThrow()
    }
    expect(args.saveNote({ projectId: 'proj_a', title: 'T', text: 'x', extra: 1 })).toEqual({ projectId: 'proj_a', title: 'T', text: 'x' })
    expect(args.saveNote({ projectId: 'proj_a', noteId: 'note_a1', title: 'T', text: 'x' })).toEqual({ projectId: 'proj_a', noteId: 'note_a1', title: 'T', text: 'x' })
    expect(args.saveNote({ projectId: 'proj_a', noteId: null, title: 'T', text: 'x' })).toEqual({ projectId: 'proj_a', title: 'T', text: 'x' })
    expect(args.saveNote({ projectId: 'proj_a', title: 'T', text: 'x', retired: true })).toEqual({ projectId: 'proj_a', title: 'T', text: 'x', retired: true })
    expect(args.saveNote({ projectId: 'proj_a', title: 'T', text: 'x', retired: null })).toEqual({ projectId: 'proj_a', title: 'T', text: 'x' })
    for (const bad of [{ projectId: 'proj_a', title: 5, text: 'x' }, { projectId: 'proj_a', title: 'T', text: 5 }, { projectId: 'proj_a', noteId: 7, title: 'T', text: 'x' }, { projectId: 'proj_a', noteId: '../x', title: 'T', text: 'x' }, { projectId: 'proj_a', title: 'T', text: 'x', retired: 'yes' }]) {
      expect(() => args.saveNote(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('knowledgeArgs', () => {
  it('rebuilds saveNode field by field, dropping extras and refusing wrong types', () => {
    const full = { projectId: 'proj_a', nodeId: 'kn_ab12', kind: 'person', name: 'Ada', aliases: ['A'], summary: 'S', facts: [{ id: 'kf_1', text: 'F', retired: true, x: 1 }, { text: 'G' }], noteIds: ['note_1'], retired: false, extra: 1 }
    expect(knowledgeArgs.saveNode(full)).toEqual({ projectId: 'proj_a', nodeId: 'kn_ab12', kind: 'person', name: 'Ada', aliases: ['A'], summary: 'S', facts: [{ id: 'kf_1', text: 'F', retired: true }, { text: 'G' }], noteIds: ['note_1'], retired: false })
    expect(knowledgeArgs.saveNode({ projectId: 'proj_a', kind: 'k', name: 'n', nodeId: null, aliases: null, summary: null, facts: null, noteIds: null, retired: null })).toEqual({ projectId: 'proj_a', kind: 'k', name: 'n' })
    const base = { projectId: 'proj_a', kind: 'k', name: 'n' }
    const bad: Array<[unknown, RegExp]> = [
      [null, /not found/],
      [{ ...base, projectId: 'quick' }, /Project not found/],
      [{ ...base, projectId: '../x' }, /Project not found/],
      [{ ...base, nodeId: 'ke_1' }, /Entity not found/],
      [{ ...base, nodeId: 5 }, /Entity not found/],
      [{ ...base, kind: 5 }, /kind must be text/],
      [{ ...base, name: null }, /name must be text/],
      [{ ...base, aliases: 'A' }, /Aliases must be a list of text/],
      [{ ...base, aliases: [1] }, /Aliases must be a list of text/],
      [{ ...base, summary: 5 }, /summary must be text/],
      [{ ...base, noteIds: 'note_1' }, /Note links must be a list of text/],
      [{ ...base, retired: 'yes' }, /retired must be true or false/],
      [{ ...base, facts: 'F' }, /Facts must be a list/],
      [{ ...base, facts: [{ text: 5 }] }, /A fact must be text/],
      [{ ...base, facts: ['F'] }, /A fact must be text/],
      [{ ...base, facts: [{ id: 'kn_1', text: 'F' }] }, /Fact not found/],
      [{ ...base, facts: [{ text: 'F', retired: 1 }] }, /retired flag must be true or false/]
    ]
    for (const [input, re] of bad) expect(() => knowledgeArgs.saveNode(input), JSON.stringify(input)).toThrow(re)
  })

  it('rebuilds itemRef and saveEdge', () => {
    expect(knowledgeArgs.itemRef({ projectId: 'proj_a', nodeId: 'kn_1', x: 1 })).toEqual({ projectId: 'proj_a', nodeId: 'kn_1' })
    expect(knowledgeArgs.itemRef({ projectId: 'proj_a', edgeId: 'ke_1', nodeId: null })).toEqual({ projectId: 'proj_a', edgeId: 'ke_1' })
    for (const bad of [{ projectId: 'proj_a' }, { projectId: 'proj_a', nodeId: 'kn_1', edgeId: 'ke_1' }, { projectId: 'proj_a', nodeId: 'ke_1' }, { projectId: 'proj_a', edgeId: 'kn_1' }, { projectId: 'harness', nodeId: 'kn_1' }, { projectId: 'proj_a', nodeId: 'kn_../x' }, null]) {
      expect(() => knowledgeArgs.itemRef(bad), JSON.stringify(bad)).toThrow()
    }
    expect(knowledgeArgs.saveEdge({ projectId: 'proj_a', edgeId: 'ke_1', from: 'kn_1', to: 'kn_2', relation: 'r', note: 'n', retired: true, x: 1 })).toEqual({ projectId: 'proj_a', edgeId: 'ke_1', from: 'kn_1', to: 'kn_2', relation: 'r', note: 'n', retired: true })
    expect(knowledgeArgs.saveEdge({ projectId: 'proj_a', from: 'kn_1', to: 'kn_2', relation: 'r', edgeId: null, note: null, retired: null })).toEqual({ projectId: 'proj_a', from: 'kn_1', to: 'kn_2', relation: 'r' })
    const base = { projectId: 'proj_a', from: 'kn_1', to: 'kn_2', relation: 'r' }
    for (const bad of [null, { ...base, projectId: 'skills' }, { ...base, edgeId: 'kn_1' }, { ...base, from: 5 }, { ...base, to: null }, { ...base, relation: 5 }, { ...base, note: 5 }, { ...base, retired: 'yes' }]) {
      expect(() => knowledgeArgs.saveEdge(bad), JSON.stringify(bad)).toThrow()
    }
    expect(knowledgeArgs.projectId('proj_a')).toBe('proj_a')
    expect(() => knowledgeArgs.projectId('quick')).toThrow(/not found/)
  })
})

describe('registered engagement and removal handlers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-ipce-'))
    handlers.clear()
    sent.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function register(stored: Project[]) {
    const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
    const removed: string[] = []
    const runList = vi.fn((_id: string) => [{}, {}, {}])
    const runs = {
      list: runList,
      removeProject: vi.fn(async (_id: string, opts?: { removeRuns?: boolean }) => (opts?.removeRuns === false ? 0 : 3)),
      start: vi.fn(async (input: Record<string, unknown>) => input)
    }
    const projects = {
      get: (id: string) => stored.find((p) => p.id === id) ?? null,
      list: () => stored,
      remove: vi.fn((id: string) => void removed.push(id))
    }
    const mcp = { removeProjectSecrets: vi.fn() }
    registerIpc({
      projects: projects as never,
      runs: runs as never,
      setup: {} as never,
      maintenance: {} as never,
      settings: settings as never,
      connections: { effectiveSettings: () => settings.get() } as never,
      mcp: mcp as never,
      adapterIds: [],
      harnessProject: () => makeProject({ id: 'harness' }),
      openRunWindow: () => {},
      importer: {} as never,
      skills: { removeProjectFiles: vi.fn() } as never,
      skillEvaluation: {} as never,
      capabilities: { forgetProject: vi.fn() } as never,
      quick: { displayProject: () => makeProject({ id: 'quick' }) } as never,
      templates: { list: () => [] } as never
    })
    // Async so a handler that throws synchronously rejects like ipcMain.handle does for the renderer.
    const call = async (channel: string, ...a: unknown[]): Promise<unknown> => handlers.get(channel)!({ sender: { id: 1 } }, ...a)
    return { call, runs, removed }
  }

  it('engagement document: empty for code, stale refusal, broadcast on write', async () => {
    const eng = makeProject({ id: 'proj_e', kind: 'engagement' })
    const code = makeProject({ id: 'proj_c' })
    const { call } = register([eng, code])
    expect(await call(IPC.projectsEngagementDocument, 'proj_c')).toEqual({ text: '' })
    await expect(call(IPC.projectsUpdateEngagementDocument, { projectId: 'proj_c', text: 'x', expectedUpdatedAt: 0 })).rejects.toThrow('Only engagements keep their document in OrgAI.')
    await expect(call(IPC.projectsEngagementDocument, 'nope')).rejects.toThrow(/not found/)
    const first = (await call(IPC.projectsUpdateEngagementDocument, { projectId: 'proj_e', text: '# Plan' })) as { updatedAt: number; updatedBy: string }
    expect(first.updatedBy).toBe('user')
    expect(sent).toEqual([{ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_e', what: 'document' } satisfies EngagementChangedEvent }])
    await expect(call(IPC.projectsUpdateEngagementDocument, { projectId: 'proj_e', text: 'again' })).rejects.toThrow(/changed since you opened it/)
    await call(IPC.projectsUpdateEngagementDocument, { projectId: 'proj_e', text: 'again', expectedUpdatedAt: first.updatedAt })
    expect(((await call(IPC.projectsEngagementDocument, 'proj_e')) as { text: string }).text).toBe('again')
  })

  it('notes: save, list, get, remove, with broadcasts, for any stored project', async () => {
    const { call } = register([makeProject({ id: 'proj_c' })])
    const note = (await call(IPC.projectsSaveNote, { projectId: 'proj_c', title: 'Brief', text: 'body' })) as EngagementNote
    expect(sent.at(-1)).toEqual({ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_c', what: 'notes', ids: [note.id] } })
    expect(note).toMatchObject({ excerpt: 'body', createdAt: note.updatedAt })
    expect(((await call(IPC.projectsListNotes, 'proj_c')) as unknown[]).length).toBe(1)
    expect(await call(IPC.projectsGetNote, { projectId: 'proj_c', noteId: note.id })).toMatchObject({ title: 'Brief', text: 'body' })
    await expect(call(IPC.projectsGetNote, { projectId: 'proj_c', noteId: 'note_missing' })).rejects.toThrow('Note not found')
    const retired = (await call(IPC.projectsSaveNote, { projectId: 'proj_c', noteId: note.id, title: 'Brief', text: 'body', retired: true })) as EngagementNote
    expect(retired).toMatchObject({ id: note.id, retired: true, updatedBy: 'user' })
    expect(await call(IPC.projectsRemoveNote, { projectId: 'proj_c', noteId: note.id })).toEqual([])
    expect(sent.at(-1)).toEqual({ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_c', what: 'notes', ids: [note.id] } })
    await expect(call(IPC.projectsListNotes, 'harness')).rejects.toThrow(/not found/)
  })

  it('removal preview and remove report the same facts', async () => {
    const eng = makeProject({ id: 'proj_e', kind: 'engagement', skills: [{ id: 's1' }, { id: 's2' }] as never })
    const { call, runs, removed } = register([eng])
    writeEngagementDocumentFromSetup(dir, 'proj_e', '# Charter')
    writeFileSync(join(dir, 'projects', 'proj_e', 'permission-rules.json'), '{}')
    saveNote(dir, 'proj_e', { title: 'a', text: 'a' })
    saveNote(dir, 'proj_e', { title: 'b', text: 'b' })
    mkdirSync(join(dir, 'team-reviews'), { recursive: true })
    writeFileSync(join(dir, 'team-reviews', 'proj_e.json'), '{}')
    mkdirSync(join(dir, 'skill-evaluations'), { recursive: true })
    writeFileSync(join(dir, 'skill-evaluations', 'proj_e.json'), '{}')
    upsertNode(dir, 'proj_e', { kind: 'person', name: 'Ada' }, AGENT)
    upsertNode(dir, 'proj_e', { kind: 'person', name: 'Grace' }, AGENT)
    const preview = (await call(IPC.projectsRemovePreview, { projectId: 'proj_e', removeRuns: false })) as ProjectRemoveResult
    expect(preview).toEqual({
      projectId: 'proj_e',
      kind: 'engagement',
      runsRemoved: 3,
      runsKept: 0,
      notesRemoved: 2,
      skillsRemoved: 2,
      documentRemoved: true,
      rulesRemoved: true,
      teamReviewRemoved: true,
      skillEvaluationRemoved: true,
      knowledgeRemoved: 2
    })
    expect(runs.removeProject).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'skill-evaluations', 'proj_e.json'))).toBe(true)
    const result = (await call(IPC.projectsRemove, { projectId: 'proj_e', removeRuns: false })) as ProjectRemoveResult
    expect(result).toEqual(preview)
    expect(runs.removeProject).toHaveBeenCalledWith('proj_e', { removeRuns: true })
    expect(removed).toEqual(['proj_e'])
    expect(existsSync(join(dir, 'projects', 'proj_e'))).toBe(false)
    expect(existsSync(join(dir, 'skill-evaluations', 'proj_e.json'))).toBe(false)
  })

  it('a code project can keep its runs; a string id still works; unknown preview is refused', async () => {
    const code = makeProject({ id: 'proj_c' })
    const { call, runs } = register([code])
    const preview = (await call(IPC.projectsRemovePreview, { projectId: 'proj_c', removeRuns: false })) as ProjectRemoveResult
    expect(preview).toMatchObject({ kind: 'code', runsRemoved: 0, runsKept: 3, documentRemoved: false, notesRemoved: 0 })
    const result = (await call(IPC.projectsRemove, { projectId: 'proj_c', removeRuns: false })) as ProjectRemoveResult
    expect(result).toEqual(preview)
    expect(runs.removeProject).toHaveBeenCalledWith('proj_c', { removeRuns: false })
    expect(readRetainedRunProjects(dir).has('proj_c')).toBe(true)
    await expect(call(IPC.projectsRemovePreview, 'proj_zzz')).rejects.toThrow(/not found/)
    await expect(call(IPC.projectsRemove, 'proj_zzz')).rejects.toThrow(/not found/)
    expect(runs.removeProject).toHaveBeenCalledTimes(1)
    expect(readRetainedRunProjects(dir).has('proj_zzz')).toBe(false)
    await expect(call(IPC.projectsRemove, 'quick')).rejects.toThrow(/cannot be removed/)
    const again = register([makeProject({ id: 'proj_d' })])
    const r = (await again.call(IPC.projectsRemove, 'proj_d')) as ProjectRemoveResult
    expect(r).toMatchObject({ runsRemoved: 3, runsKept: 0 })
  })

  it('removalFacts is best effort: a failing run count counts as zero', () => {
    const facts = removalFacts({ dataDir: dir, project: null, runCount: () => { throw new Error('boom') } }, 'proj_x', true)
    expect(facts).toMatchObject({ kind: 'code', runsRemoved: 0, runsKept: 0, notesRemoved: 0, skillsRemoved: 0, documentRemoved: false, knowledgeRemoved: 0 })
    expect(removalFacts({ dataDir: dir, project: null, runCount: () => 0 }, '../x', true).knowledgeRemoved).toBe(0)
  })

  it('knowledge: empty reads and refused writes for a code project, reads and writes with one broadcast each for an engagement', async () => {
    const eng = makeProject({ id: 'proj_e', kind: 'engagement' })
    const code = makeProject({ id: 'proj_c' })
    const { call } = register([eng, code])
    upsertNode(dir, 'proj_c', { kind: 'person', name: 'Hidden' }, AGENT)
    expect(await call(IPC.knowledgeGet, 'proj_c')).toEqual({ version: 1, nodes: [], edges: [] })
    await expect(call(IPC.knowledgeGet, 'proj_zzz')).rejects.toThrow(/not found/)
    await expect(call(IPC.knowledgeGet, 'quick')).rejects.toThrow(/not found/)
    for (const [channel, input] of [
      [IPC.knowledgeSaveNode, { projectId: 'proj_c', kind: 'person', name: 'Ada' }],
      [IPC.knowledgeSaveEdge, { projectId: 'proj_c', from: 'kn_1', to: 'kn_2', relation: 'knows' }],
      [IPC.knowledgeRemoveNode, { projectId: 'proj_c', nodeId: 'kn_1' }],
      [IPC.knowledgeRemoveEdge, { projectId: 'proj_c', edgeId: 'ke_1' }],
      [IPC.knowledgeClear, 'proj_c']
    ] as const) {
      await expect(call(channel, input), channel).rejects.toThrow('Only engagements keep a knowledge graph.')
    }
    expect(readKnowledge(dir, 'proj_c').nodes).toHaveLength(1)
    expect(sent).toEqual([])

    expect(await call(IPC.knowledgeGet, 'proj_e')).toEqual({ version: 1, nodes: [], edges: [] })
    const ada = (await call(IPC.knowledgeSaveNode, { projectId: 'proj_e', kind: 'Person', name: 'Ada', facts: [{ text: 'F' }], extra: 1 })) as KnowledgeNode
    expect(ada).toMatchObject({ kind: 'person', name: 'Ada', source: { by: 'user' } })
    expect(ada.facts[0].source.by).toBe('user')
    expect(sent).toEqual([{ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_e', what: 'knowledge', ids: [ada.id] } satisfies EngagementChangedEvent }])
    await expect(call(IPC.knowledgeSaveNode, { projectId: 'proj_e', kind: 'person', name: 'ada' })).rejects.toThrow(/already exists; edit it instead/)
    await expect(call(IPC.knowledgeSaveNode, { projectId: 'proj_e', kind: 'person', name: `A${'​'}` })).rejects.toThrow(/hidden character/)
    expect(sent).toHaveLength(1)
    const acme = (await call(IPC.knowledgeSaveNode, { projectId: 'proj_e', kind: 'organisation', name: 'Acme' })) as KnowledgeNode
    const edited = (await call(IPC.knowledgeSaveNode, { projectId: 'proj_e', nodeId: ada.id, kind: 'person', name: 'Ada L', facts: [] })) as KnowledgeNode
    expect(edited).toMatchObject({ id: ada.id, name: 'Ada L', facts: [], updatedBy: { by: 'user' } })
    const edge = (await call(IPC.knowledgeSaveEdge, { projectId: 'proj_e', from: ada.id, to: acme.id, relation: 'Works at', note: 'n' })) as KnowledgeEdge
    expect(edge).toMatchObject({ from: ada.id, to: acme.id, relation: 'works-at', note: 'n', source: { by: 'user' } })
    expect(sent.at(-1)).toEqual({ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_e', what: 'knowledge', ids: [edge.id] } })
    const again = (await call(IPC.knowledgeSaveEdge, { projectId: 'proj_e', from: ada.id, to: acme.id, relation: 'works-at' })) as KnowledgeEdge
    expect(again.id).toBe(edge.id)
    await expect(call(IPC.knowledgeSaveEdge, { projectId: 'proj_e', from: ada.id, to: ada.id, relation: 'knows' })).rejects.toThrow('An entity cannot relate to itself.')
    const got = (await call(IPC.knowledgeGet, 'proj_e')) as KnowledgeGraph
    expect(got.nodes.map((n) => n.id)).toEqual([ada.id, acme.id])
    expect(got.edges.map((e) => e.id)).toEqual([edge.id])
    expect(sent).toHaveLength(5)
    const afterEdge = (await call(IPC.knowledgeRemoveEdge, { projectId: 'proj_e', edgeId: edge.id })) as KnowledgeGraph
    expect(afterEdge.edges).toEqual([])
    expect(sent.at(-1)!.payload).toEqual({ projectId: 'proj_e', what: 'knowledge', ids: [edge.id] })
    await expect(call(IPC.knowledgeRemoveEdge, { projectId: 'proj_e', edgeId: edge.id })).rejects.toThrow(/No relation with id/)
    await expect(call(IPC.knowledgeRemoveNode, { projectId: 'proj_e', edgeId: edge.id })).rejects.toThrow('Entity not found')
    await expect(call(IPC.knowledgeRemoveEdge, { projectId: 'proj_e', nodeId: ada.id })).rejects.toThrow('Relation not found')
    const edge2 = (await call(IPC.knowledgeSaveEdge, { projectId: 'proj_e', from: acme.id, to: ada.id, relation: 'employs' })) as KnowledgeEdge
    const afterNode = (await call(IPC.knowledgeRemoveNode, { projectId: 'proj_e', nodeId: ada.id })) as KnowledgeGraph
    expect(afterNode.nodes.map((n) => n.id)).toEqual([acme.id])
    expect(afterNode.edges).toEqual([])
    expect(sent.at(-1)!.payload).toEqual({ projectId: 'proj_e', what: 'knowledge', ids: [ada.id, edge2.id] })
    await expect(call(IPC.knowledgeRemoveNode, { projectId: 'proj_e', nodeId: ada.id })).rejects.toThrow(/No entity with id/)
    const sentBefore = sent.length
    expect(await call(IPC.knowledgeClear, 'proj_e')).toEqual({ version: 1, nodes: [], edges: [] })
    expect(sent.slice(sentBefore)).toEqual([{ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_e', what: 'knowledge' } }])
    expect(await call(IPC.knowledgeGet, 'proj_e')).toEqual({ version: 1, nodes: [], edges: [] })
    expect(readKnowledge(dir, 'proj_c').nodes).toHaveLength(1)
  })

  it('unused writer import is exercised', () => {
    expect(writeEngagementDocument(dir, 'proj_w', 'x').text).toBe('x')
  })
})
