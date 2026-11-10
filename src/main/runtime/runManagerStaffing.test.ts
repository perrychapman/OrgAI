import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent, RunRecord, RunStaffing, StaffingAssignment } from '@shared/types'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { RunManager } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, runSummary } from './testHelpers'

// The real logger writes under Electron's userData; tests have no Electron.
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-staffing-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const row = (over: Partial<StaffingAssignment> = {}): StaffingAssignment => ({ agentId: 'a1', stepId: 'p1', roleId: 'r-eng', tier: 'everyday', model: 'sonnet', effort: 'medium', source: 'orchestrator', at: 10, ...over })

const setupService = (p: Project): SetupService =>
  ({ hiddenContext: vi.fn(() => ''), markArchitectureUpdated: vi.fn(() => p), complete: vi.fn(() => p), applyProposal: vi.fn(() => p), markScaffolded: vi.fn(() => p) }) as unknown as SetupService

/** A RunManager on a fake adapter whose sessions stay open until `end(i)`; every RuntimeContext lands in `ctxs`. */
function harness(over: Partial<Project> = {}) {
  const ctxs: RuntimeContext[] = []
  const ends: (() => void)[] = []
  const events: RunEvent[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>((r) => ends.push(r)) }
    }
  }
  const p = makeProject({ path: join(dir, 'repo'), ...over })
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setupService(p), () => 100)
  const end = async (i: number): Promise<void> => {
    ctxs[i]!.emit({ type: 'run.status', runId: ctxs[i]!.run.id, status: 'finished' })
    ends[i]!()
    await sleep(5)
  }
  return { m, p, store, ctxs, events, end }
}

describe('RunManager run staffing', () => {
  it('updateStaffing cleans, stores, broadcasts and persists the record, and a reload carries it', async () => {
    const { m, p, store, ctxs, events, end } = harness()
    const run = await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]!
    expect(ctx.getStaffing()).toBeUndefined()
    await ctx.updateStaffing({ goal: 'speed', assignments: [row(), { roleId: 'broken' } as never, row({ note: '  capped by the role  ', source: 'clamped', at: 11 })] })
    const want: RunStaffing = { goal: 'speed', assignments: [row(), row({ note: 'capped by the role', source: 'clamped', at: 11 })] }
    const broadcast = events.filter((e): e is Extract<RunEvent, { type: 'staffing.updated' }> => e.type === 'staffing.updated')
    expect(broadcast).toEqual([{ type: 'staffing.updated', runId: run.id, staffing: want }])
    expect(ctx.getStaffing()).toEqual(want)
    expect(m.get(run.id)!.staffing).toEqual(want)
    // The whole record replaces the previous one, like plan.updated.
    await ctx.updateStaffing({ goal: 'speed', assignments: [row({ at: 12 })] })
    expect(ctx.getStaffing()).toEqual({ goal: 'speed', assignments: [row({ at: 12 })] })
    await end(0)
    expect(store.getRecord(run.id)!.staffing).toEqual({ goal: 'speed', assignments: [row({ at: 12 })] })
    // A fresh manager over the same data folder reads it back.
    const again = new RunManager({}, () => {}, new RunStore(join(dir, 'data')), setupService(p), () => 100)
    expect(again.get(run.id)!.staffing).toEqual({ goal: 'speed', assignments: [row({ at: 12 })] })
  })

  it('ignores a staffing update that is not an object', async () => {
    const { m, p, ctxs, events } = harness()
    const run = await m.start({ project: p, prompt: 'go' })
    await ctxs[0]!.updateStaffing('lots' as never)
    expect(events.some((e) => e.type === 'staffing.updated')).toBe(false)
    expect(ctxs[0]!.getStaffing()).toBeUndefined()
    expect('staffing' in m.get(run.id)!).toBe(false)
  })

  it('gives the context the run goal: the per-run override on top of the project goal, balanced by default', async () => {
    const plain = harness()
    await plain.m.start({ project: plain.p, prompt: 'go' })
    expect(plain.ctxs[0]!.staffingGoal).toBe('balanced')

    const costly = harness({ staffingGoal: 'cost' })
    await costly.m.start({ project: costly.p, prompt: 'go' })
    const run = await costly.m.start({ project: costly.p, prompt: 'go fast', overrides: { goal: 'speed' } })
    expect(costly.ctxs[0]!.staffingGoal).toBe('cost')
    expect(costly.ctxs[1]!.staffingGoal).toBe('speed')
    expect(costly.m.summaryOf(run.id)!.overrides).toEqual({ goal: 'speed' })
  })

  it('a continuation keeps the goal override but starts without the earlier run\'s staffing', async () => {
    const { m, p, ctxs, end } = harness()
    const run = await m.start({ project: p, prompt: 'go', overrides: { goal: 'cost' } })
    await ctxs[0]!.updateStaffing({ goal: 'cost', assignments: [row()] })
    await ctxs[0]!.updatePlan({ goal: 'g', steps: [{ id: 'p1', title: 'One', status: 'pending' }], status: 'active', autoContinues: 0, updatedAt: 1 })
    await end(0)
    const next = await m.continueRun(p, run.id, 'more')
    expect(ctxs[1]!.staffingGoal).toBe('cost')
    expect(m.summaryOf(next.id)!.overrides).toEqual({ goal: 'cost' })
    expect(ctxs[1]!.getStaffing()).toBeUndefined()
    // The plan carries over (unchanged behaviour); staffing has no analogue.
    expect(ctxs[1]!.getPlan()?.steps).toHaveLength(1)
  })

  it('drops malformed stored staffing on load and leaves the rest of the record alone', () => {
    const { m, p, store } = harness()
    const keep = (id: string, staffing: unknown): RunRecord => {
      const summary = runSummary({ id, projectId: p.id, status: 'finished', endedAt: 5 })
      const rec = {
        summary,
        agents: {},
        transcript: [{ id: 't1', agentId: 'root', at: 1, block: { kind: 'user', text: 'hello' } }],
        logs: [{ at: 1, level: 'info', message: 'kept' }],
        plan: { goal: 'g', steps: [{ id: 'p1', title: 'One', status: 'done' }], status: 'done', autoContinues: 1, updatedAt: 1 },
        staffing
      } as unknown as RunRecord
      store.upsert(summary)
      store.saveRecord(rec)
      return rec
    }
    const junkRows = keep('r-rows', { goal: 'warp', assignments: [row(), { roleId: 'x', model: 'm', source: 'nope', at: 1 }, null] })
    const junkWhole = keep('r-whole', 'everyone')
    const a = m.get('r-rows')!
    expect(a.staffing).toEqual({ goal: 'balanced', assignments: [row()] })
    expect(a.transcript).toEqual(junkRows.transcript)
    expect(a.logs).toEqual(junkRows.logs)
    expect(a.plan).toEqual(junkRows.plan)
    const b = m.get('r-whole')!
    expect('staffing' in b).toBe(false)
    expect(b.transcript).toEqual(junkWhole.transcript)
    expect(b.plan).toEqual(junkWhole.plan)
    // get() does not write the cleaned record back.
    expect(store.getRecord('r-whole')!.staffing).toBe('everyone')
  })

  it('cleans a stored plan graph on load (cycles, foreign ids, paths, staff)', () => {
    const { m, p, store } = harness()
    const summary = runSummary({ id: 'r-plan', projectId: p.id, status: 'finished', endedAt: 5 })
    store.upsert(summary)
    store.saveRecord({
      summary,
      agents: {},
      transcript: [],
      logs: [],
      plan: { goal: 'g', status: 'active', autoContinues: 0, updatedAt: 1, steps: [
        { id: 'p1', title: 'One', status: 'pending', after: ['p2', 'zz'], paths: ['src/a.ts', 'src/a.ts'] },
        { id: 'p2', title: 'Two', status: 'pending', after: ['p1'], staff: { role: 'implementer', tier: 'mega' as never } }
      ] }
    })
    expect(m.get('r-plan')!.plan!.steps).toEqual([
      { id: 'p1', title: 'One', status: 'pending', paths: ['src/a.ts'] },
      { id: 'p2', title: 'Two', status: 'pending', after: ['p1'], staff: { role: 'implementer' } }
    ])
  })
})
