import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { EngagementChangedEvent, Project, ProjectRemoveResult } from '@shared/types'
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

const { effectiveRemoveRuns, projectRemoveArgs, registerIpc, removalFacts, templateEngagementArgs: args } = await import('./ipc')
const { project: makeProject } = await import('./runtime/testHelpers')
const { saveNote, readRetainedRunProjects, writeEngagementDocumentFromSetup, writeEngagementDocument } = await import('./store/projectData')

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
    for (const bad of [{ projectId: 'proj_a', title: 5, text: 'x' }, { projectId: 'proj_a', title: 'T', text: 5 }, { projectId: 'proj_a', noteId: 7, title: 'T', text: 'x' }, { projectId: 'proj_a', noteId: '../x', title: 'T', text: 'x' }]) {
      expect(() => args.saveNote(bad), JSON.stringify(bad)).toThrow()
    }
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
    const note = (await call(IPC.projectsSaveNote, { projectId: 'proj_c', title: 'Brief', text: 'body' })) as { id: string }
    expect(sent.at(-1)).toEqual({ channel: IPC.projectsEngagementChanged, payload: { projectId: 'proj_c', what: 'notes' } })
    expect(((await call(IPC.projectsListNotes, 'proj_c')) as unknown[]).length).toBe(1)
    expect(await call(IPC.projectsGetNote, { projectId: 'proj_c', noteId: note.id })).toMatchObject({ title: 'Brief', text: 'body' })
    await expect(call(IPC.projectsGetNote, { projectId: 'proj_c', noteId: 'note_missing' })).rejects.toThrow('Note not found')
    expect(await call(IPC.projectsRemoveNote, { projectId: 'proj_c', noteId: note.id })).toEqual([])
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
      skillEvaluationRemoved: true
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
    expect(facts).toMatchObject({ kind: 'code', runsRemoved: 0, runsKept: 0, notesRemoved: 0, skillsRemoved: 0, documentRemoved: false })
  })

  it('unused writer import is exercised', () => {
    expect(writeEngagementDocument(dir, 'proj_w', 'x').text).toBe('x')
  })
})
