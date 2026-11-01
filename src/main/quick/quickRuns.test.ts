import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, QuickRunInfo, RunEvent, RunSummary } from '@shared/types'
import { PROJECT_PEEK_BRIEF_CHARS, QUICK_RUN_MAX_PROMPT_CHARS } from '@shared/types'
import { DEFAULT_APP_SETTINGS, defaultRoles, quickRunTools } from '@shared/defaults'
import { ProjectStore } from '../store/projects'
import { RunStore } from '../store/runs'
import { sessionChain } from '../runtime/runManager'
import { project as makeProject } from '../runtime/testHelpers'
import { QuickRunService, projectPeeks, quickDisplayProject, quickProject } from './quickRuns'
import { createScratchDir, isInside, referencedScratch, removeScratchDir, scratchDirFor, scratchRoot, sweepScratchDirs, validateQuickFolder } from './scratch'

let dir: string
let data: string
const settings = DEFAULT_APP_SETTINGS

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-quick-'))
  data = join(dir, 'data')
  mkdirSync(data, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const userFolder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, projectId: 'quick', kind: 'work', prompt: 'p', status: 'finished', startedAt: 1, totalCostUsd: 0, ...over })

describe('validateQuickFolder', () => {
  it('accepts a real folder and reports a git repository', () => {
    const f = userFolder()
    expect(validateQuickFolder(f, data)).toEqual({ folder: expect.any(String), gitRepo: false })
    mkdirSync(join(f, '.git'))
    expect(validateQuickFolder(f, data).gitRepo).toBe(true)
    expect(validateQuickFolder(`"${f}"`, data).folder).toBe(validateQuickFolder(f, data).folder)
  })

  it('refuses non-strings, empty, relative, UNC and device paths', () => {
    expect(() => validateQuickFolder(7, data)).toThrow(/as text/)
    expect(() => validateQuickFolder('   ', data)).toThrow(/Choose a folder/)
    expect(() => validateQuickFolder('relative/dir', data)).toThrow(/full path/)
    expect(() => validateQuickFolder('\\\\server\\share\\x', data)).toThrow(/Network shares/)
    expect(() => validateQuickFolder('//server/share/x', data)).toThrow(/Network shares/)
    expect(() => validateQuickFolder('\\\\?\\C:\\Users', data)).toThrow(/device paths/)
    expect(() => validateQuickFolder('\\\\.\\pipe\\x', data)).toThrow(/device paths/)
    expect(() => validateQuickFolder(`${userFolder()}\0x`, data)).toThrow(/not valid/)
  })

  it('refuses a missing folder and a file', () => {
    expect(() => validateQuickFolder(join(dir, 'nope'), data)).toThrow(/no folder at/)
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    expect(() => validateQuickFolder(file, data)).toThrow(/is a file/)
  })

  it('refuses the data dir and everything under it', () => {
    expect(() => validateQuickFolder(data, data)).toThrow(/data folder/)
    const inside = join(data, 'quick', 'x')
    mkdirSync(inside, { recursive: true })
    expect(() => validateQuickFolder(inside, data)).toThrow(/data folder/)
    expect(() => validateQuickFolder(join(data, 'quick', '..', 'quick', 'x'), data)).toThrow(/data folder/)
  })

  it('resolves a link to its real folder before checking it', () => {
    const real = join(data, 'secret')
    mkdirSync(real)
    const link = join(dir, 'link')
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return // links not permitted here
    }
    expect(() => validateQuickFolder(link, data)).toThrow(/data folder/)
  })
})

describe('scratch directories', () => {
  it('creates a private dir under <data>/quick', () => {
    const s = createScratchDir(data)
    expect(existsSync(s)).toBe(true)
    expect(statSync(s).isDirectory()).toBe(true)
    expect(isInside(scratchRoot(data), s)).toBe(true)
    expect(s).toMatch(/quick_[a-z0-9]+$/)
    expect(createScratchDir(data)).not.toBe(s)
    if (process.platform !== 'win32') expect(statSync(s).mode & 0o777).toBe(0o700)
  })

  it('removes a scratch dir only when no run points to it', () => {
    const s = createScratchDir(data)
    writeFileSync(join(s, 'f.txt'), 'x')
    expect(removeScratchDir(data, s, () => true)).toBe(false)
    expect(existsSync(s)).toBe(true)
    expect(removeScratchDir(data, s, () => false)).toBe(true)
    expect(existsSync(s)).toBe(false)
    expect(removeScratchDir(data, s, () => false)).toBe(false) // already gone
  })

  it('never removes anything that is not a direct quick_<id> child of <data>/quick', () => {
    const outside = userFolder('quick_abc123')
    writeFileSync(join(outside, 'keep.txt'), 'x')
    expect(removeScratchDir(data, outside, () => false)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    mkdirSync(join(scratchRoot(data), 'notes'), { recursive: true })
    expect(removeScratchDir(data, join(scratchRoot(data), 'notes'), () => false)).toBe(false)
    expect(removeScratchDir(data, scratchRoot(data), () => false)).toBe(false)
    expect(removeScratchDir(data, data, () => false)).toBe(false)
    expect(removeScratchDir(data, userFolder('Documents'), () => false)).toBe(false)
    expect(removeScratchDir(data, 'relative/quick_abc', () => false)).toBe(false)
    const s = createScratchDir(data)
    // A traversal spelling resolves to the same dir; anything else with that basename is refused.
    expect(scratchDirFor(data, join(s, '..', '..', '..', 'quick_zzz'))).toBeNull()
    expect(scratchDirFor(data, join(dir, 'other', 'quick_zzz'))).toBeNull()
  })

  it('collects the referenced dirs from quick.folder (scratch only) and buildWorkspace', () => {
    const a = createScratchDir(data)
    const b = createScratchDir(data)
    const user = userFolder()
    const refs = referencedScratch([
      run('1', { quick: { folder: a, scratch: true, team: 'single', allowEdits: false, gitRepo: false } }),
      run('2', { quick: { folder: user, team: 'single', allowEdits: false, gitRepo: false } }),
      run('3', { projectId: 'harness', kind: 'mcp-assist', buildWorkspace: b })
    ])
    expect(refs.size).toBe(2)
  })

  it('boot sweep removes unreferenced scratch dirs and keeps referenced ones and other entries', () => {
    const kept = createScratchDir(data)
    const keptBuild = createScratchDir(data)
    const gone = createScratchDir(data)
    const other = join(scratchRoot(data), 'readme')
    mkdirSync(other)
    const runs = [
      run('1', { quick: { folder: kept, scratch: true, team: 'single', allowEdits: false, gitRepo: false } }),
      run('2', { projectId: 'harness', kind: 'mcp-assist', buildWorkspace: keptBuild })
    ]
    expect(sweepScratchDirs(data, runs)).toBe(1)
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(keptBuild)).toBe(true)
    expect(existsSync(gone)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(readdirSync(scratchRoot(data)).sort()).toHaveLength(3)
    expect(sweepScratchDirs(join(dir, 'empty'), [])).toBe(0)
  })
})

describe('quickProject', () => {
  const info = (over: Partial<QuickRunInfo> = {}): QuickRunInfo => ({ folder: '/work', team: 'single', allowEdits: false, gitRepo: false, ...over })
  const toolsOf = (p: Project): Record<string, string[]> => Object.fromEntries(p.roles.map((r) => [r.slug, r.tools]))

  it('builds the single assistant with the unresolved Chat model and read-only tools', () => {
    const p = quickProject({ ...settings, quickRunModel: 'fast' }, info())
    expect(p).toMatchObject({ id: 'quick', name: 'Chat', path: '/work', permissionMode: 'default', isolateWriters: false, runMessaging: false, mcpServers: [], plugins: [], skills: [] })
    expect(p.roles).toHaveLength(1)
    expect(p.roles[0]).toMatchObject({ slug: 'assistant', name: 'Assistant', model: 'fast', canSpawn: false, reportsTo: null })
    expect(p.roles[0].tools).toEqual(quickRunTools('single', false).assistant)
    expect(p.roles[0].tools).not.toContain('Edit')
    expect(p.roles[0].tools).not.toContain('Bash')
  })

  it('gives the single assistant Edit, Write and Bash only with edits on, isolating writers in a git folder', () => {
    const p = quickProject(settings, info({ allowEdits: true, gitRepo: true }))
    expect(p.roles[0].tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']))
    expect(p.isolateWriters).toBe(true)
    expect(p.permissionMode).toBe('default')
    expect(quickProject(settings, info({ allowEdits: true, gitRepo: false })).isolateWriters).toBe(false)
    expect(quickProject(settings, info({ allowEdits: false, gitRepo: true })).isolateWriters).toBe(false)
    expect(quickProject({ ...settings, quickRunModel: undefined }, info()).roles[0].model).toBe('everyday')
  })

  it('keeps the default chart for team default and filters its tools', () => {
    const off = quickProject(settings, info({ team: 'default' }))
    expect(off.roles.map((r) => r.slug)).toEqual(defaultRoles().map((r) => r.slug))
    for (const tools of Object.values(toolsOf(off))) {
      for (const t of ['Edit', 'Write', 'Bash', 'NotebookEdit']) expect(tools).not.toContain(t)
    }
    const on = quickProject(settings, info({ team: 'default', allowEdits: true, gitRepo: true }))
    expect(toolsOf(on).implementer).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']))
    expect(on.isolateWriters).toBe(true)
    expect(on.roles.find((r) => r.reportsTo === null)?.slug).toBe('orchestrator')
  })

  it('takes the default connection through prepare, and runs on mock under ORGAI_MOCK', () => {
    const prepare = vi.fn((p: Project): Project => ({ ...p, provider: { ...p.provider, connection: 'openai', id: 'codex' } }))
    expect(quickProject(settings, info(), { prepare }).provider).toMatchObject({ connection: 'openai', id: 'codex' })
    expect(prepare).toHaveBeenCalledTimes(1)
    const mock = quickProject(settings, info(), { prepare, mock: true })
    expect(mock.provider.id).toBe('mock')
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('builds a roleless display project without creating any directory', () => {
    const before = readdirSync(data)
    const d = quickDisplayProject(settings, data)
    expect(d).toMatchObject({ id: 'quick', name: 'Chat', roles: [] })
    expect(readdirSync(data)).toEqual(before)
    expect(existsSync(scratchRoot(data))).toBe(false)
    expect(quickDisplayProject(settings, data, { mock: true }).provider.id).toBe('mock')
  })
})

describe('projectPeeks', () => {
  it('lists stored projects only, secret-free, with one-line cut briefs and the newest run', () => {
    const long = `${'word '.repeat(300)}\nsecond line`
    const stored = makeProject({ id: 'p1', name: 'Shop', path: '/shop', brief: long })
    const peeks = projectPeeks(
      [stored, makeProject({ id: 'harness' }), makeProject({ id: 'quick' }), makeProject({ id: 'skills' }), makeProject({ id: 'p2', name: 'Blog', provider: { id: 'codex', label: 'x', auth: { kind: 'apiKey', envVar: 'SECRET_ENV' }, connection: 'openai' } })],
      (id) => (id === 'p1' ? run('r1', { projectId: 'p1', status: 'running', title: 'Fix\nbug', startedAt: 9 }) : undefined)
    )
    expect(peeks.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(peeks[0].brief).not.toContain('\n')
    expect(peeks[0].brief.length).toBeLessThanOrEqual(PROJECT_PEEK_BRIEF_CHARS)
    expect(peeks[0].roles).toEqual(['lead: Lead', 'engineer: Engineer', 'reviewer: Reviewer'])
    expect(peeks[0].connection).toBe('anthropic')
    expect(peeks[0].lastRun).toEqual({ runId: 'r1', status: 'running', title: 'Fix bug', startedAt: 9 })
    expect(peeks[1].connection).toBe('openai')
    expect(peeks[1].lastRun).toBeUndefined()
    const json = JSON.stringify(peeks)
    expect(json).not.toContain('SECRET_ENV')
    expect(json).not.toContain('apiKey')
  })
})

describe('QuickRunService', () => {
  function make(opts: { startFails?: boolean; mock?: boolean } = {}) {
    const runStore = new RunStore(data)
    const projects = new ProjectStore(data)
    const events: RunEvent[] = []
    const started: Array<{ project: Project; prompt: string; quick: QuickRunInfo; images?: unknown }> = []
    const live = new Set<string>()
    const runs = {
      start: vi.fn(async (input: { project: Project; prompt: string; kind: 'work'; quick: QuickRunInfo; images?: unknown }) => {
        if (opts.startFails) throw new Error('refused')
        started.push(input)
        const summary: RunSummary = { id: `run_${started.length}`, projectId: input.project.id, kind: 'work', prompt: input.prompt, status: 'finished', startedAt: started.length, totalCostUsd: 0, quick: input.quick, sessionId: `s${started.length}` }
        runStore.upsert(summary)
        return summary
      }),
      summary: (id: string) => runStore.get(id),
      chain: (id: string) => {
        const from = runStore.get(id)
        if (!from) return []
        return sessionChain(runStore.list(from.projectId).map((r) => (live.has(r.id) ? { ...r, status: 'running' as const } : r)), from)
      }
    }
    const prepare = vi.fn((p: Project) => p)
    const svc = new QuickRunService({
      dataDir: data,
      settings: () => settings,
      runs,
      store: runStore,
      projects,
      prepare,
      broadcast: (e) => void events.push(e),
      ...(opts.mock ? { mock: true } : {})
    })
    runStore.onRunsRemoved = (removed) => svc.runsRemoved(removed)
    return { svc, runStore, projects, events, started, live, prepare, runs }
  }

  it('starts a run in a validated folder with the settings it was given', async () => {
    const { svc, started } = make()
    const f = userFolder()
    mkdirSync(join(f, '.git'))
    const summary = await svc.start({ prompt: '  Summarize this  ', folder: f, team: 'default', allowEdits: true })
    expect(summary.quick).toMatchObject({ team: 'default', allowEdits: true, gitRepo: true })
    expect(summary.quick?.scratch).toBeUndefined()
    expect(started[0].prompt).toBe('Summarize this')
    expect(started[0].project).toMatchObject({ id: 'quick', isolateWriters: true, permissionMode: 'default' })
    expect(started[0].project.path).toBe(summary.quick?.folder)
  })

  it('works in a fresh scratch dir without a folder, and removes it again when the start fails', async () => {
    const ok = make()
    const s = await ok.svc.start({ prompt: 'hi' })
    expect(s.quick).toMatchObject({ scratch: true, team: 'single', allowEdits: false, gitRepo: false })
    expect(isInside(scratchRoot(data), s.quick!.folder)).toBe(true)
    expect(existsSync(s.quick!.folder)).toBe(true)

    const bad = make({ startFails: true })
    const before = readdirSync(scratchRoot(data))
    await expect(bad.svc.start({ prompt: 'hi' })).rejects.toThrow('refused')
    expect(readdirSync(scratchRoot(data))).toEqual(before)
  })

  it('refuses a bad prompt or folder before any directory exists', async () => {
    const { svc } = make()
    await expect(svc.start({ prompt: '   ' })).rejects.toThrow(/Type what/)
    await expect(svc.start({ prompt: 'x'.repeat(QUICK_RUN_MAX_PROMPT_CHARS + 1) })).rejects.toThrow(/too long/)
    await expect(svc.start({ prompt: 'x', folder: join(dir, 'missing') })).rejects.toThrow(/no folder/)
    await expect(svc.start({ prompt: 'x', folder: data })).rejects.toThrow(/data folder/)
    expect(existsSync(scratchRoot(data))).toBe(false)
  })

  it('maps team junk to single and keeps edits off unless exactly true', async () => {
    const { svc } = make()
    const s = await svc.start({ prompt: 'x', team: 'bogus' as never, allowEdits: 'yes' as never })
    expect(s.quick).toMatchObject({ team: 'single', allowEdits: false })
  })

  it('rebuilds the project of a continued run from summary.quick', async () => {
    const { svc } = make()
    const s = await svc.start({ prompt: 'x', team: 'default' })
    const p = svc.projectFor(s)!
    expect(p).toMatchObject({ id: 'quick', path: s.quick!.folder })
    expect(p.roles.map((r) => r.slug)).toContain('orchestrator')
    expect(svc.projectFor(run('z'))).toBeNull()
  })

  it('removes the scratch dir with its last run, but not while a run still points to it', async () => {
    const { svc, runStore } = make()
    const a = await svc.start({ prompt: 'a' })
    const dirOf = a.quick!.folder
    // A continuation reuses the dir.
    runStore.upsert({ ...run('cont', { quick: a.quick, resumedFrom: a.id, startedAt: 5 }) })
    runStore.removeProject('quick') // everything gone at once: hook sees both
    expect(existsSync(dirOf)).toBe(false)

    const b = await svc.start({ prompt: 'b' })
    runStore.upsert({ ...run('cont2', { quick: b.quick, startedAt: 6 }) })
    svc.runsRemoved([runStore.get(b.id)!]) // run b "removed" but cont2 still references the dir
    expect(existsSync(b.quick!.folder)).toBe(true)
    svc.runsRemoved([run('x', { quick: b.quick }), run('y', { projectId: 'harness', kind: 'mcp-assist', buildWorkspace: join(dir, 'not-scratch') })])
    expect(existsSync(b.quick!.folder)).toBe(true)
  })

  describe('promote', () => {
    it('moves the whole chain, drops quick, and announces each run with run.moved', async () => {
      const { svc, runStore, projects, events, prepare } = make()
      const f = userFolder('repo')
      const first = await svc.start({ prompt: 'first', folder: f })
      runStore.upsert(run('second', { quick: first.quick, resumedFrom: first.id, sessionId: 's9', startedAt: 20 }))
      runStore.upsert(run('other', { quick: { folder: userFolder('else'), team: 'single', allowEdits: false, gitRepo: false }, startedAt: 30 }))
      const res = svc.promote({ runId: 'second', name: '  Repo  ' })
      expect(res.kind).toBe('created')
      if (res.kind !== 'created') return
      expect(res.project).toMatchObject({ name: 'Repo', path: first.quick!.folder })
      expect(projects.get(res.project.id)).toBeTruthy()
      expect(prepare).toHaveBeenCalled()
      expect(res.run).toMatchObject({ id: 'second', projectId: res.project.id })
      expect(res.run.quick).toBeUndefined()
      expect(runStore.list(res.project.id).map((r) => r.id).sort()).toEqual([first.id, 'second'].sort())
      expect(runStore.list('quick').map((r) => r.id)).toEqual(['other'])
      expect(runStore.get(first.id)?.quick).toBeUndefined()
      const moved = events.filter((e): e is Extract<RunEvent, { type: 'run.moved' }> => e.type === 'run.moved')
      expect(moved.map((e) => e.runId).sort()).toEqual([first.id, 'second'].sort())
      expect(moved.every((e) => e.fromProjectId === 'quick' && e.projectId === res.project.id)).toBe(true)
      expect(moved[0].runId).toBe('second') // the promoted run first
    })

    it('refuses while a run of the chain is live', async () => {
      const { svc, live, runStore } = make()
      const first = await svc.start({ prompt: 'first', folder: userFolder('repo') })
      runStore.upsert(run('second', { quick: first.quick, resumedFrom: first.id, startedAt: 20 }))
      live.add('second')
      expect(() => svc.promote({ runId: first.id, name: 'Repo' })).toThrow(/End the session/)
      expect(runStore.list('quick')).toHaveLength(2)
    })

    it('refuses scratch runs, unknown or non-quick runs and bad names', async () => {
      const { svc, runStore } = make()
      const scratch = await svc.start({ prompt: 'x' })
      expect(() => svc.promote({ runId: scratch.id, name: 'X' })).toThrow(/scratch/)
      expect(() => svc.promote({ runId: 'ghost', name: 'X' })).toThrow(/not found/)
      runStore.upsert(run('plain', { projectId: 'p1' }))
      expect(() => svc.promote({ runId: 'plain', name: 'X' })).toThrow(/not found/)
      const first = await svc.start({ prompt: 'x', folder: userFolder('repo') })
      expect(() => svc.promote({ runId: first.id, name: '   ' })).toThrow(/name/)
      expect(() => svc.promote({ runId: first.id, name: 'a\nb' })).toThrow(/name/)
      expect(() => svc.promote({ runId: first.id, name: 'x'.repeat(81) })).toThrow(/name/)
      expect(runStore.list('quick')).toHaveLength(2) // the scratch run and this one: nothing moved
    })

    it('answers existing, moving nothing, when the folder is already a project', async () => {
      const { svc, runStore, projects, events } = make()
      const f = userFolder('repo')
      const existing = projects.create({ name: 'Mine', path: f, brief: '' }, settings, {})
      const first = await svc.start({ prompt: 'x', folder: f })
      expect(svc.promote({ runId: first.id, name: 'Other' })).toEqual({ kind: 'existing', projectId: existing.id, name: 'Mine' })
      expect(runStore.list('quick')).toHaveLength(1)
      expect(events.some((e) => e.type === 'run.moved')).toBe(false)
      expect(projects.list()).toHaveLength(1)
    })

    it('creates the project on the mock adapter under ORGAI_MOCK', async () => {
      const { svc } = make({ mock: true })
      const first = await svc.start({ prompt: 'x', folder: userFolder('repo') })
      const res = svc.promote({ runId: first.id, name: 'Repo' })
      expect(res.kind === 'created' && res.project.provider.id).toBe('mock')
    })
  })
})
