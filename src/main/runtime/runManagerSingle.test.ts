import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, EngagementNoteContent, RunEvent, RunKind, RunSummary } from '@shared/types'
import { QUICK_PROJECT_ID, USAGE_CSV_COLUMNS } from '@shared/types'
import { DEFAULT_APP_SETTINGS, QUICK_ASSISTANT_SLUG } from '@shared/defaults'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { mcpSpec, project as makeProject, runSummary } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-single-')))
  events = []
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
  return { m, ctxs, store }
}

const folder = (name = 'work'): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}

const stored = (over: Parameters<typeof makeProject>[0] = {}) =>
  makeProject({
    id: 'p1',
    path: folder(),
    mcpServers: [mcpSpec({ id: 'mcp-on', name: 'on', enabled: true }), mcpSpec({ id: 'mcp-off', name: 'off', enabled: false })],
    runMessaging: true,
    ...over
  })

describe('single-agent work runs', () => {
  it('runs one Assistant built from the project and records the team', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: stored(), prompt: 'go', team: 'single' })
    expect(run.team).toBe('single')
    expect(m.summaryOf(run.id)?.team).toBe('single')
    const ctx = ctxs[0]
    expect(ctx.roles).toHaveLength(1)
    expect(ctx.roles[0].slug).toBe(QUICK_ASSISTANT_SLUG)
    expect(ctx.roles[0].canSpawn).toBe(false)
    expect(ctx.roles[0].mcpServers).toEqual(['mcp-on'])
    expect(ctx.project.roles).toHaveLength(1)
    expect(ctx.project.runMessaging).toBe(false)
    expect(ctx.autoContinue).toBe(false)
    await m.stopAll()
  })

  it('resolves the Assistant model from the quickRunModel setting', async () => {
    const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, quickRunModel: 'fast' }
    const { m, ctxs } = rig({ appSettings: () => settings })
    await m.start({ project: stored(), prompt: 'go', team: 'single' })
    // On the mock adapter the setting is kept as the role's model hint (no connection to resolve against).
    expect(ctxs[0].roles[0].model).toBeTruthy()
    await m.stopAll()
  })

  it('a team run of the same project keeps its org chart, nudges and messaging', async () => {
    const { m, ctxs } = rig()
    const run = await m.start({ project: stored(), prompt: 'go' })
    expect(run.team).toBeUndefined()
    expect(ctxs[0].roles.length).toBeGreaterThan(1)
    expect(ctxs[0].autoContinue).toBe(true)
    await m.stopAll()
  })

  it('refuses setup, Chat and virtual projects', async () => {
    const { m } = rig()
    const refuse = async (input: Parameters<RunManager['start']>[0]): Promise<void> => {
      await expect(m.start(input)).rejects.toThrow(/single assistant/)
    }
    await refuse({ project: stored(), prompt: 'x', kind: 'setup', team: 'single' })
    await refuse({ project: stored({ id: QUICK_PROJECT_ID }), prompt: 'x', team: 'single' })
    await refuse({ project: stored(), prompt: 'x', team: 'single', quick: { folder: '/w', team: 'single', allowEdits: false, gitRepo: false } })
    await expect(m.start({ project: stored(), prompt: 'x', team: 'duo' as unknown as 'single' })).rejects.toThrow(/Unknown team/)
  })

  it('has no peer runs: list_runs is empty and message_run is refused both ways', async () => {
    const { m, ctxs } = rig()
    const a = await m.start({ project: stored({ id: 'p1' }), prompt: 'a', team: 'single' })
    const b = await m.start({ project: stored({ id: 'p2', path: folder('other') }), prompt: 'b' })
    expect(ctxs[0].listRuns?.()).toEqual([])
    expect(await ctxs[0].messageRun?.(b.id, 'hi')).toMatchObject({ result: 'refused', refusal: 'not-work' })
    // The team run sees the single run as unreachable, too.
    expect(await ctxs[1].messageRun?.(a.id, 'hi')).toMatchObject({ result: 'refused', refusal: 'not-work' })
    await m.stopAll()
  })

  it('a continuation keeps the team', async () => {
    const { m, ctxs } = rig({ resolveProject: () => stored() })
    const run = await m.start({ project: stored(), prompt: 'go', team: 'single' })
    ctxs[0].emit({ type: 'run.status', runId: run.id, status: 'finished' })
    const next = await m.continueRun(stored(), run.id, 'more')
    expect(next.team).toBe('single')
    expect(next.resumedFrom).toBe(run.id)
    expect(ctxs[1].roles).toHaveLength(1)
    expect(ctxs[1].autoContinue).toBe(false)
    await m.stopAll()
  })
})

describe('RuntimeContext.engagementNotes and orgTemplate', () => {
  const note: EngagementNoteContent = { id: 'n1', title: 'Facts', updatedAt: 1, chars: 3, text: 'abc' }
  const notes = () => ({
    list: vi.fn((projectId: string) => (projectId === 'p1' ? [{ id: 'n1', title: 'Facts', updatedAt: 1, chars: 3 }] : [])),
    read: vi.fn((projectId: string, id: string) => (projectId === 'p1' && id === 'n1' ? note : null))
  })

  it('is bound to the project on engagement work runs', async () => {
    const engagementNotes = notes()
    const { m, ctxs } = rig({ engagementNotes })
    await m.start({ project: stored({ kind: 'engagement' }), prompt: 'go' })
    expect(ctxs[0].engagementNotes?.list()).toEqual([{ id: 'n1', title: 'Facts', updatedAt: 1, chars: 3 }])
    expect(ctxs[0].engagementNotes?.read('n1')).toEqual(note)
    expect(engagementNotes.list).toHaveBeenCalledWith('p1')
    expect(engagementNotes.read).toHaveBeenCalledWith('p1', 'n1')
    await m.stopAll()
  })

  it('is offered on single-agent runs of a code project, not on its team runs', async () => {
    const { m, ctxs } = rig({ engagementNotes: notes() })
    await m.start({ project: stored(), prompt: 'a', team: 'single' })
    await m.start({ project: stored({ id: 'p2', path: folder('b') }), prompt: 'b' })
    expect(ctxs[0].engagementNotes).toBeDefined()
    expect(ctxs[1].engagementNotes).toBeUndefined()
    await m.stopAll()
  })

  it('is absent without the option, on setup runs and on Chat', async () => {
    const none = rig()
    await none.m.start({ project: stored({ kind: 'engagement' }), prompt: 'go' })
    expect(none.ctxs[0].engagementNotes).toBeUndefined()
    await none.m.stopAll()

    const { m, ctxs } = rig({ engagementNotes: notes() })
    await m.start({ project: stored({ kind: 'engagement' }), prompt: 'setup', kind: 'setup' })
    expect(ctxs[0].engagementNotes).toBeUndefined()
    const quickFolder = folder('quick')
    await m.start({
      project: makeProject({ id: QUICK_PROJECT_ID, path: quickFolder, kind: 'engagement' }),
      prompt: 'chat',
      quick: { folder: quickFolder, team: 'single', allowEdits: false, gitRepo: false, scratch: true }
    })
    expect(ctxs[1].engagementNotes).toBeUndefined()
    await m.stopAll()
  })

  it('orgTemplate is bound to the project on setup runs only', async () => {
    const orgTemplate = vi.fn((id: string, _project?: unknown) => (id === 't' ? { name: 'T', roles: [] } : null))
    const { m, ctxs } = rig({ orgTemplate })
    await m.start({ project: stored(), prompt: 'set up', kind: 'setup' })
    await m.start({ project: stored({ id: 'p2', path: folder('c') }), prompt: 'work' })
    expect(ctxs[0].orgTemplate?.('t')).toEqual({ name: 'T', roles: [] })
    expect(ctxs[0].orgTemplate?.('x')).toBeNull()
    expect(orgTemplate.mock.calls[0][1]).toMatchObject({ id: 'p1' })
    expect(ctxs[1].orgTemplate).toBeUndefined()
    await m.stopAll()
  })
})

describe('usage range and CSV export', () => {
  const at = (y: number, mo: number, d: number): number => new Date(y, mo, d, 12).getTime()
  function seed(store: RunStore, id: string, startedAt: number, kind: RunKind = 'work', over: Partial<RunSummary> = {}): void {
    store.upsert(runSummary({ id, projectId: 'p1', kind, startedAt, endedAt: startedAt + 1000, status: 'finished', ...over }))
  }

  it('range replaces since and until; a malformed month throws', () => {
    const { m, store } = rig()
    seed(store, 'oct', at(2026, 9, 30))
    seed(store, 'nov', at(2026, 10, 15))
    seed(store, 'dec', at(2026, 11, 1))
    const ids = (month: string) => m.usageStats({ projectId: 'p1', range: { month }, since: 0, until: 1 }).runs.map((r) => r.runId)
    expect(ids('2026-11')).toEqual(['nov'])
    expect(ids('2026-12')).toEqual(['dec'])
    expect(ids('2026-01')).toEqual([])
    expect(() => m.usageStats({ projectId: 'p1', range: { month: '2026-13' } })).toThrow('Invalid month')
    expect(() => m.usageStats({ projectId: 'p1', range: {} as { month: string } })).toThrow('Invalid month')
  })

  it('defaults to work runs; listing every kind counts setup runs in totals and trend', () => {
    const { m, store } = rig()
    seed(store, 'w', at(2026, 10, 3), 'work')
    seed(store, 's', at(2026, 10, 3), 'setup')
    seed(store, 'a', at(2026, 10, 4), 'mcp-assist')
    seed(store, 'k', at(2026, 10, 4), 'skill-assist')
    const work = m.usageStats({ projectId: 'p1' })
    expect(work.runs.map((r) => r.runId)).toEqual(['w'])
    const all = m.usageStats({ projectId: 'p1', kinds: ['work', 'setup', 'mcp-assist', 'skill-assist'] })
    expect(all.runs.map((r) => r.runId).sort()).toEqual(['a', 'k', 's', 'w'])
    expect(all.trend.reduce((n, p) => n + p.runs, 0)).toBe(4)
    expect(all.totals.agents).toBeGreaterThanOrEqual(work.totals.agents)
    expect(all.runs.some((r) => r.kind === 'setup')).toBe(true)
  })

  it('usageCsv writes the header and a row per run, newest first, over the month', () => {
    const { m, store } = rig()
    seed(store, 'nov1', at(2026, 10, 3), 'work', { title: 'First, "run"' })
    seed(store, 'nov2', at(2026, 10, 20), 'work', { title: '=HYPERLINK()' })
    seed(store, 'oct', at(2026, 9, 3))
    const csv = m.usageCsv({ projectId: 'p1', range: { month: '2026-11' } })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(','))
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("'=HYPERLINK()")
    expect(lines[2]).toContain('"First, ""run"""')
  })

  it('usageCsv ignores a caller limit and still refuses a bad month', () => {
    const { m, store } = rig()
    for (let i = 0; i < 3; i++) seed(store, `r${i}`, at(2026, 10, 1 + i))
    expect(m.usageCsv({ projectId: 'p1', limit: 1 }).split('\r\n')).toHaveLength(4)
    expect(() => m.usageCsv({ projectId: 'p1', range: { month: 'x' } })).toThrow('Invalid month')
  })
})
