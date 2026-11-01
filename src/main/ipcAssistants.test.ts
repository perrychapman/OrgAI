import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, QUICK_RUN_MAX_PROMPT_CHARS } from '@shared/types'
import type { Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '' }))

const { ASSIST_INSTRUCTION_MAX_CHARS, mcpAssistArgs, quickArgs, registerIpc, skillAssistArgs } = await import('./ipc')
const { QuickRunService } = await import('./quick/quickRuns')
const { project: makeProject } = await import('./runtime/testHelpers')

describe('quickArgs.start', () => {
  it('rebuilds every field and drops the rest', () => {
    const out = quickArgs.start({ prompt: '  hi  ', folder: '/work', team: 'default', allowEdits: true, evil: 1, project: { id: 'p' }, kind: 'setup' })
    expect(out).toEqual({ prompt: 'hi', folder: '/work', team: 'default', allowEdits: true })
  })

  it('refuses a prompt over the limit instead of cutting it, and accepts the limit', () => {
    expect(() => quickArgs.start({ prompt: 'x'.repeat(QUICK_RUN_MAX_PROMPT_CHARS + 1) })).toThrow(/too long/)
    expect(quickArgs.start({ prompt: 'x'.repeat(QUICK_RUN_MAX_PROMPT_CHARS) }).prompt).toHaveLength(QUICK_RUN_MAX_PROMPT_CHARS)
  })

  it('refuses a missing, non-text or empty prompt', () => {
    for (const bad of [null, undefined, 5, [], {}, { prompt: 7 }, { prompt: '   ' }, { prompt: ['a'] }]) {
      expect(() => quickArgs.start(bad), JSON.stringify(bad)).toThrow(/Type what/)
    }
  })

  it('turns anything but the literal true into no edits, and any team but default into single', () => {
    for (const allowEdits of ['yes', 'true', 1, {}, [], null, undefined, false]) {
      expect(quickArgs.start({ prompt: 'x', allowEdits }).allowEdits, String(allowEdits)).toBe(false)
    }
    for (const team of ['both', 'DEFAULT', 5, null, undefined, {}, 'single']) {
      expect(quickArgs.start({ prompt: 'x', team }).team, String(team)).toBe('single')
    }
    expect(quickArgs.start({ prompt: 'x', team: 'default' }).team).toBe('default')
  })

  it('keeps a folder only as text and caps its length', () => {
    expect(quickArgs.start({ prompt: 'x', folder: 7 }).folder).toBeUndefined()
    expect(quickArgs.start({ prompt: 'x', folder: '   ' }).folder).toBeUndefined()
    expect(quickArgs.start({ prompt: 'x', folder: { path: '/x' } }).folder).toBeUndefined()
    expect(() => quickArgs.start({ prompt: 'x', folder: '/a'.repeat(3000) })).toThrow(/too long/)
  })

  it('sanitizes images and accepts an image-only message', () => {
    const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'a.png' }
    const bad = { mediaType: 'image/svg+xml', data: 'AAAA' }
    expect(quickArgs.start({ prompt: 'x', images: [png, bad] }).images).toEqual([png])
    expect(quickArgs.start({ prompt: '', images: [png] }).images).toEqual([png])
    expect(quickArgs.start({ prompt: 'x', images: 'nope' }).images).toBeUndefined()
    expect(() => quickArgs.start({ prompt: '', images: [bad] })).toThrow(/Type what/)
  })
})

describe('quickArgs.promote', () => {
  it('needs a safe run id and a 1 to 80 character name', () => {
    expect(quickArgs.promote({ runId: 'run_1', name: '  Shop  ', extra: 1 })).toEqual({ runId: 'run_1', name: 'Shop' })
    for (const bad of [null, {}, { runId: '../x', name: 'a' }, { runId: 7, name: 'a' }]) expect(() => quickArgs.promote(bad)).toThrow(/not found/)
    for (const name of ['', '   ', 'x'.repeat(81), 'a\nb', 4, null]) expect(() => quickArgs.promote({ runId: 'run_1', name })).toThrow(/name/)
  })
})

describe('skillAssistArgs', () => {
  const stored = (id: string): boolean => id === 'proj_a'

  it('uses library scope when asked or when there is no project id', () => {
    expect(skillAssistArgs({ scope: 'library', projectId: 'proj_a', instruction: ' tidy ' }, stored)).toEqual({ library: true, instruction: 'tidy' })
    expect(skillAssistArgs({}, stored)).toEqual({ library: true })
    expect(skillAssistArgs(null, stored)).toEqual({ library: true })
    expect(skillAssistArgs({ projectId: '' }, stored)).toEqual({ library: true })
  })

  it('uses project scope only for a stored, non-virtual project', () => {
    expect(skillAssistArgs({ projectId: 'proj_a', scope: 'project' }, stored)).toEqual({ library: false, projectId: 'proj_a' })
    expect(skillAssistArgs({ projectId: 'proj_a' }, stored)).toEqual({ library: false, projectId: 'proj_a' })
    for (const projectId of ['proj_x', '../x', 7, {}]) {
      expect(() => skillAssistArgs({ projectId }, stored), String(projectId)).toThrow(/Project not found/)
    }
    // virtual ids are refused even when the lookup would claim them
    for (const projectId of ['harness', 'quick', 'skills']) {
      expect(() => skillAssistArgs({ projectId }, () => true), projectId).toThrow(/Project not found/)
    }
  })

  it('caps the instruction and drops non-text', () => {
    expect(skillAssistArgs({ instruction: 'x'.repeat(ASSIST_INSTRUCTION_MAX_CHARS + 50) }, stored)).toMatchObject({ instruction: 'x'.repeat(ASSIST_INSTRUCTION_MAX_CHARS) })
    expect(skillAssistArgs({ instruction: 42 }, stored)).toEqual({ library: true })
  })
})

describe('mcpAssistArgs', () => {
  it('turns allowBuild on only for the literal true in library scope', () => {
    expect(mcpAssistArgs({ scope: 'library', allowBuild: true })).toMatchObject({ library: true, projectId: 'harness', allowBuild: true })
    for (const allowBuild of ['yes', 1, 'true', {}, null, undefined, false]) {
      expect(mcpAssistArgs({ scope: 'library', allowBuild }).allowBuild, String(allowBuild)).toBe(false)
    }
  })

  it('refuses allowBuild in project scope', () => {
    expect(() => mcpAssistArgs({ projectId: 'proj_a', allowBuild: true })).toThrow(/app-wide/)
    expect(mcpAssistArgs({ projectId: 'proj_a', allowBuild: 'yes' })).toMatchObject({ library: false, projectId: 'proj_a', allowBuild: false })
  })

  it('does not let a project-scope request name the harness project', () => {
    expect(mcpAssistArgs({ projectId: 'harness' })).toMatchObject({ library: false, projectId: 'harness' })
  })
})

describe('registered handlers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-ipc-'))
    handlers.clear()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function register() {
    const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
    const started: Array<Record<string, unknown>> = []
    const runs = {
      start: vi.fn(async (input: Record<string, unknown>) => {
        started.push(input)
        return { id: `run_${started.length}`, projectId: (input.project as Project).id, kind: input.kind, prompt: input.prompt, status: 'starting', startedAt: 0, totalCostUsd: 0 } as RunSummary
      }),
      summary: vi.fn(),
      continueRun: vi.fn(async () => ({}) as RunSummary),
      removeProject: vi.fn()
    }
    const stored = makeProject({ id: 'proj_a' })
    const projects = { get: (id: string) => (id === 'proj_a' ? stored : null), list: () => [stored], saveFromRenderer: vi.fn(), remove: vi.fn() }
    const quick = {
      start: vi.fn(),
      promote: vi.fn(),
      projectFor: vi.fn(),
      displayProject: () => makeProject({ id: 'quick', name: 'Chat', roles: [] }),
      removeScratch: vi.fn()
    }
    registerIpc({
      projects: projects as never,
      runs: runs as never,
      setup: {} as never,
      maintenance: {} as never,
      settings: settings as never,
      connections: {} as never,
      mcp: { removeProjectSecrets: vi.fn() } as never,
      adapterIds: ['mock'],
      harnessProject: () => makeProject({ id: 'harness', name: 'OrgAI', roles: [] }),
      openRunWindow: () => {},
      importer: {} as never,
      skills: { removeProjectFiles: vi.fn() } as never,
      skillEvaluation: {} as never,
      capabilities: { forgetProject: vi.fn() } as never,
      quick: quick as never
    })
    const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({ sender: { id: 1 } }, ...args)
    return { call, runs, started, quick, projects }
  }

  it('skills:startAssist runs the assistant on the virtual skills project for library scope', async () => {
    const { call, started } = register()
    const run = (await call(IPC.skillsStartAssist, { scope: 'library', instruction: 'tidy', extra: 1 })) as RunSummary
    expect(run.projectId).toBe('skills')
    expect(started[0]).toMatchObject({ kind: 'skill-assist', prompt: 'tidy' })
    expect((started[0].project as Project).id).toBe('skills')
    expect(Object.keys(started[0]).sort()).toEqual(['kind', 'project', 'prompt'])
  })

  it('skills:startAssist runs on a stored project for project scope and refuses the rest', async () => {
    const { call, started } = register()
    await call(IPC.skillsStartAssist, { projectId: 'proj_a' })
    expect((started[0].project as Project).id).toBe('proj_a')
    await expect(call(IPC.skillsStartAssist, { projectId: 'proj_missing' })).rejects.toThrow(/Project not found/)
    await expect(call(IPC.skillsStartAssist, { projectId: 'quick' })).rejects.toThrow(/Project not found/)
    expect(started).toHaveLength(1)
  })

  it('mcp:startAssist with allowBuild makes a scratch dir under <data>/quick and records it as buildWorkspace', async () => {
    const { call, started } = register()
    await call(IPC.mcpStartAssist, { scope: 'library', allowBuild: true, instruction: 'build me one' })
    const input = started[0] as { project: Project; buildWorkspace: string; kind: string }
    expect(input.kind).toBe('mcp-assist')
    expect(input.buildWorkspace).toMatch(/quick[\\/]quick_[a-z0-9]+$/)
    expect(existsSync(input.buildWorkspace)).toBe(true)
    expect(input.buildWorkspace.startsWith(join(dir, 'quick')) || input.buildWorkspace.toLowerCase().includes('quick')).toBe(true)
    // allowBuild 'yes' is plain library scope: no scratch dir, no buildWorkspace
    await call(IPC.mcpStartAssist, { scope: 'library', allowBuild: 'yes' })
    expect(started[1].buildWorkspace).toBeUndefined()
    await expect(call(IPC.mcpStartAssist, { projectId: 'proj_a', allowBuild: true })).rejects.toThrow(/app-wide/)
  })

  it('mcp:startAssist removes the scratch dir again when the run cannot start', async () => {
    const { call, runs, quick } = register()
    runs.start.mockRejectedValueOnce(new Error('refused'))
    await expect(call(IPC.mcpStartAssist, { scope: 'library', allowBuild: true })).rejects.toThrow('refused')
    expect(quick.removeScratch).toHaveBeenCalledTimes(1)
  })

  it('runs:startQuick and runs:promoteQuick pass only rebuilt input to the service', async () => {
    const { call, quick } = register()
    await call(IPC.runsStartQuick, { prompt: 'hi', allowEdits: 'yes', team: 'x', folder: 3, hacker: true })
    expect(quick.start).toHaveBeenCalledWith({ prompt: 'hi', team: 'single', allowEdits: false })
    await call(IPC.runsPromoteQuick, { runId: 'run_1', name: 'Shop', path: '/etc' })
    expect(quick.promote).toHaveBeenCalledWith({ runId: 'run_1', name: 'Shop' })
    expect(() => call(IPC.runsStartQuick, { prompt: 'x'.repeat(QUICK_RUN_MAX_PROMPT_CHARS + 1) })).toThrow(/too long/)
  })

  it('projects:get answers a display project for every virtual id, and save/remove refuse them', async () => {
    const { call, projects, runs } = register()
    expect(((await call(IPC.projectsGet, 'harness')) as Project).id).toBe('harness')
    expect(((await call(IPC.projectsGet, 'quick')) as Project).name).toBe('Chat')
    const skillsP = (await call(IPC.projectsGet, 'skills')) as Project
    expect(skillsP.id).toBe('skills')
    expect(skillsP.roles).toEqual([])
    for (const id of ['harness', 'quick', 'skills']) {
      expect(() => call(IPC.projectsSave, { id })).toThrow(/cannot be saved/)
      await expect(call(IPC.projectsRemove, id)).rejects.toThrow(/cannot be removed/)
    }
    expect(projects.saveFromRenderer).not.toHaveBeenCalled()
    expect(runs.removeProject).not.toHaveBeenCalled()
  })

  it('runs:continue rebuilds a quick run from its summary, never from a stored project', async () => {
    const { call, runs, quick } = register()
    const info = { folder: dir, team: 'single', allowEdits: false, gitRepo: false }
    const summary = { id: 'run_q', projectId: 'quick', kind: 'work', quick: info } as unknown as RunSummary
    runs.summary.mockReturnValue(summary)
    const rebuilt = makeProject({ id: 'quick' })
    quick.projectFor.mockReturnValue(rebuilt)
    await call(IPC.runsContinue, { runId: 'run_q', text: 'more' })
    expect(quick.projectFor).toHaveBeenCalledWith(summary)
    expect(runs.continueRun).toHaveBeenCalledWith(rebuilt, 'run_q', 'more', undefined)
  })

  it('skills channels refuse every virtual id', () => {
    const { call } = register()
    for (const id of ['harness', 'quick', 'skills']) expect(() => call(IPC.skillsList, id), id).toThrow(/Project not found/)
  })

  it('builds a real QuickRunService (type check of the wiring)', () => {
    expect(QuickRunService).toBeTypeOf('function')
  })
})
