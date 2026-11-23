import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent, RunSummary } from '@shared/types'
import { RunManager } from './runManager'
import { BUDGET_STOP_TOKEN, MockAdapter, PROVIDER_ERROR_TOKEN, STRONGER_MODEL_TOKEN } from './mock'
import { STRONGER_MODEL_ASK_TIMEOUT_MS } from './staffing'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, role } from './testHelpers'
import { defaultConnections } from '@shared/defaults'

/** A chart whose engineer runs on the everyday tier, so a retry of a fast-staffed step is an escalation. */
const strongerChart = () => [
  role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-eng'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead', model: 'sonnet', tier: 'everyday', effort: 'high' })
]

// The mock markers through the real RunManager: the holds a renderer's hold card is wired against, and the stronger-model
// card's bounded wait. Token-free (the mock adapter only).

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rm-hold-'))
  events = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function rig(p: Project) {
  const own = events
  const service = { applyProposal: vi.fn(() => p), complete: vi.fn(() => p), markScaffolded: vi.fn(() => p), markArchitectureUpdated: vi.fn(() => p), hiddenContext: vi.fn(() => 'profile'), prepare: vi.fn(async (x: Project) => x) } as unknown as SetupService
  const m = new RunManager({ mock: new MockAdapter({ script: { delayMs: 0 } }) }, (e) => void own.push(e), new RunStore(join(dir, 'data')), service, () => 100, { resolveConnection: () => ({ connection: 'anthropic' as const, adapter: 'mock' as const, tierModels: { top: 'm-top', deep: 'm-deep', everyday: 'm-everyday', fast: 'm-fast' } }), appSettings: () => ({ setupModel: 'opus', mcpAssistModel: 'opus', connections: defaultConnections({ kind: 'subscription' }) }) })
  return m
}
const holds = (runId: string) => events.filter((e): e is Extract<RunEvent, { type: 'run.hold' }> => e.type === 'run.hold' && e.runId === runId)
const reach = (m: RunManager, id: string, ok: (s: RunSummary) => boolean) => vi.waitFor(() => expect(ok(m.summary(id)!)).toBe(true), { timeout: 5000 })

describe('mock markers through RunManager: run.hold', () => {
  it('[mock:budget-stop] with a project cap: the run ends on its budget and holds on it (run.hold broadcast)', async () => {
    const p = makeProject({ path: join(dir, 'repo'), maxBudgetUsd: 5 })
    const m = rig(p)
    const run = await m.start({ project: p, prompt: `Do it ${BUDGET_STOP_TOKEN}` })
    await reach(m, run.id, (s) => s.hold?.kind === 'budget')
    expect(m.summary(run.id)).toMatchObject({ endedBy: 'budget', hold: { kind: 'budget', budget: { scope: 'run', limitUsd: 5 } } })
    expect(holds(run.id).at(-1)?.hold).toMatchObject({ kind: 'budget' })
    await m.stopAll()
  })

  it('[mock:budget-stop] without any cap makes no hold (as a real adapter: nothing to report)', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const m = rig(p)
    const run = await m.start({ project: p, prompt: `Do it ${BUDGET_STOP_TOKEN}` })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'run.status' && e.runId === run.id && e.status === 'idle')).toBe(true), { timeout: 5000 })
    expect(m.summary(run.id)?.hold).toBeUndefined()
    await m.stopAll()
  })

  it('[mock:provider-error]: the run errors with the session open and holds on the provider', async () => {
    const p = makeProject({ path: join(dir, 'repo') })
    const m = rig(p)
    const run = await m.start({ project: p, prompt: `Do it ${PROVIDER_ERROR_TOKEN}` })
    await reach(m, run.id, (s) => s.hold?.kind === 'provider')
    expect(holds(run.id).at(-1)?.hold).toMatchObject({ kind: 'provider' })
    await m.stopAll()
  })
})

describe('stronger-model card through RunManager', () => {
  it('[mock:stronger-model]: an unanswered card is cancelled after STRONGER_MODEL_ASK_TIMEOUT_MS, leaves the pending cards, and a late answer is refused', async () => {
    const p = makeProject({ path: join(dir, 'repo'), askBeforeStrongerModel: true, roles: strongerChart() })
    const m = rig(p)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = await m.start({ project: p, prompt: `Do it ${STRONGER_MODEL_TOKEN}` })
    const questionId = await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(50)
      const q = m.pendingCards(run.id).questions[0]
      expect(q).toBeDefined()
      return q!.id
    }, { timeout: 5000 })
    expect(events.some((e) => e.type === 'question.request' && e.question.id === questionId)).toBe(true)
    await vi.advanceTimersByTimeAsync(STRONGER_MODEL_ASK_TIMEOUT_MS)
    expect(m.pendingCards(run.id).questions).toEqual([])
    expect(events.some((e) => e.type === 'question.resolved' && e.questionId === questionId && e.cancelled === true)).toBe(true)
    // A late "Use it" finds no card: it never escalates.
    expect(m.answerQuestion(run.id, questionId, { selected: ['Use it'] }).status).not.toBe('applied')
    expect(events.filter((e) => e.type === 'question.resolved' && e.questionId === questionId)).toHaveLength(1)
    vi.useRealTimers()
    await m.stopAll()
  })

  it('an answer inside the wait still applies, and the timer does not cancel it afterwards', async () => {
    const p = makeProject({ path: join(dir, 'repo'), askBeforeStrongerModel: true, roles: strongerChart() })
    const m = rig(p)
    const run = await m.start({ project: p, prompt: `Do it ${STRONGER_MODEL_TOKEN}` })
    await vi.waitFor(() => expect(m.pendingCards(run.id).questions).toHaveLength(1), { timeout: 5000 })
    const q = m.pendingCards(run.id).questions[0]!
    expect(m.answerQuestion(run.id, q.id, { selected: ['Use it'] }).status).toBe('applied')
    await vi.waitFor(() => expect(m.summary(run.id)?.status).not.toBe('running'), { timeout: 5000 })
    expect(events.filter((e) => e.type === 'question.resolved' && e.questionId === q.id)).toMatchObject([{ answer: { selected: ['Use it'] } }])
    await m.stopAll()
  })
})
