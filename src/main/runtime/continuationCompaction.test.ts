import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanStep, RunPlan } from '@shared/types'
import {
  COMPACTION_STATE_MAX_CHARS,
  COMPACTION_THRASH_LIMIT,
  ContinuationDriver,
  compactionStateText,
  compactionThrash,
  compactionThrashText,
  nextNudge,
  noteCompaction,
  type ContinuationHost,
  type NudgeInput
} from './continuation'

// The compaction thrash guard and the state block after a compaction (compaction investigation, 2026-11-10). Pure and
// with fake timers; no tokens.

const step = (id: string, title: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ id, title, status })
const plan = (steps: PlanStep[], over: Partial<RunPlan> = {}): RunPlan => ({ goal: 'Ship the feature', steps, status: 'active', autoContinues: 0, updatedAt: 0, ...over })

describe('compaction thrash: pure decision', () => {
  it('counts compactions since the plan last progressed; a finished step resets the count', () => {
    let t = noteCompaction(undefined, 1)
    expect(t).toEqual({ since: 1, mark: 1 })
    t = noteCompaction(t, 1)
    expect(compactionThrash(t)).toBe(false)
    t = noteCompaction(t, 1)
    expect(t.since).toBe(COMPACTION_THRASH_LIMIT + 1)
    expect(compactionThrash(t)).toBe(true)
    // A step finished since: a fresh count.
    expect(noteCompaction(t, 2)).toEqual({ since: 1, mark: 2 })
    expect(compactionThrash(undefined)).toBe(false)
  })

  it('blocks every nudge, the ready nudge included', () => {
    const base: NudgeInput = { plan: plan([step('p1', 'A'), step('p2', 'B')]), kind: 'work', autoContinue: true, maxAutoContinues: 10, liveReports: 0, pendingInteractions: 0, rateLimited: false, stopping: false, turnsWithoutPlan: 0 }
    expect(nextNudge(base).kind).toBe('continue')
    expect(nextNudge({ ...base, compactionThrash: true }).kind).toBe('none')
    const ready = { ...base, plan: plan([step('p1', 'A')].map((s) => ({ ...s, staff: { role: 'engineer' } }))), liveReports: 1, slots: { free: 2, limit: 3 } }
    expect(nextNudge(ready).kind).toBe('ready')
    expect(nextNudge({ ...ready, compactionThrash: true }).kind).toBe('none')
  })

  it('names the agent, its model and window, and the remedy', () => {
    const t = compactionThrashText({ agentId: 'root', name: 'Lead', model: 'claude-opus-4-5', contextWindow: 200_000 }, 3)
    expect(t.warn).toBe('Lead compacted its context 3 times (claude-opus-4-5, 200k-token context) without finishing a plan step; automatic continues are stopped. Use a model with a larger context for its tier (orgai connections tier, orgai models resolve), or split the work so one agent reads less.')
    expect(t.user).toContain('Reply to continue.')
    expect(compactionThrashText({ agentId: 'w', name: 'Writer' }, 4).warn).toContain('(context window unknown)')
  })
})

describe('compaction thrash: ContinuationDriver', () => {
  let current: RunPlan | undefined
  let host: ContinuationHost & { nudges: string[]; told: string[]; logs: [string, string][] }
  beforeEach(() => {
    vi.useFakeTimers()
    current = plan([step('p1', 'Read', 'done'), step('p2', 'Change', 'in_progress'), step('p3', 'Verify')])
    const nudges: string[] = []
    const told: string[] = []
    const logs: [string, string][] = []
    host = {
      kind: 'work', autoContinue: true, maxAutoContinues: 40, delayMs: 100,
      getPlan: () => current,
      updatePlan: vi.fn(async (p: RunPlan) => { current = p }),
      liveReports: () => 0, pendingInteractions: () => 0, rateLimited: () => false, stopping: () => false, orchestratorBusy: () => false,
      nudge: (text) => nudges.push(text), log: (level, message) => logs.push([level, message]), tellUser: (text) => told.push(text),
      nudges, told, logs
    }
  })
  afterEach(() => vi.useRealTimers())
  const lead = { agentId: 'root', name: 'Lead', model: 'claude-opus-4-5', contextWindow: 200_000 }

  it('a compaction never nudges by itself, and one or two in a run keep the continues going', async () => {
    const d = new ContinuationDriver(host)
    expect(d.compacted(lead)).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(host.nudges).toHaveLength(0)
    expect(d.compacted(lead)).toBe(false)
    d.turnEnded()
    await vi.advanceTimersByTimeAsync(200)
    expect(host.nudges).toHaveLength(1)
    expect(host.logs.some(([l]) => l === 'warn')).toBe(false)
  })

  it('a long healthy run: compactions far apart with steps finished in between never stop it', async () => {
    const d = new ContinuationDriver(host)
    for (let i = 0; i < 6; i++) {
      d.compacted(lead)
      d.compacted(lead)
      // A step finishes between every pair.
      current = { ...current!, steps: [...current!.steps, step(`x${i}`, 'Extra', 'done')] }
    }
    expect(d.compactionStopped).toBe(false)
    expect(host.told).toEqual([])
  })

  it('the third compaction with no step finished stops the continues once, with one warning; the user lifts it', async () => {
    const d = new ContinuationDriver(host)
    d.compacted(lead)
    d.compacted(lead)
    expect(d.compacted(lead)).toBe(true)
    expect(d.compacted(lead)).toBe(true)
    expect(host.logs.filter(([l]) => l === 'warn')).toHaveLength(1)
    expect(host.logs.find(([l]) => l === 'warn')![1]).toContain('Lead compacted its context 3 times (claude-opus-4-5, 200k-token context)')
    expect(host.told).toHaveLength(1)
    d.turnEnded()
    await vi.advanceTimersByTimeAsync(500)
    expect(host.nudges).toHaveLength(0)
    expect(d.isSettledForTurn(1)).toBe(true)
    // The user's message lifts it and starts the count afresh.
    d.userMessage()
    expect(d.compactionStopped).toBe(false)
    d.turnEnded()
    await vi.advanceTimersByTimeAsync(200)
    expect(host.nudges).toHaveLength(1)
  })

  it('counts per agent: two agents compacting twice each do not stop the run', () => {
    const d = new ContinuationDriver(host)
    d.compacted(lead)
    d.compacted({ agentId: 'w', name: 'Writer' })
    d.compacted(lead)
    d.compacted({ agentId: 'w', name: 'Writer' })
    expect(d.compactionStopped).toBe(false)
  })

  it('never on a run without automatic continues', () => {
    const d = new ContinuationDriver({ ...host, autoContinue: false })
    for (let i = 0; i < 5; i++) d.compacted(lead)
    expect(host.logs.some(([l]) => l === 'warn')).toBe(false)
  })
})

describe('compactionStateText', () => {
  it('plan with step states, live reports and required reports owed, in one block', () => {
    const text = compactionStateText({
      plan: plan([step('p1', 'Read', 'done'), { ...step('p2', 'Change', 'in_progress'), note: 'half way' }, step('p3', 'Verify')]),
      live: [{ name: 'implementer-1 (Implementer)', activity: 'Editing runUsage.ts' }],
      owed: ['Reviewer']
    })
    expect(text).toBe([
      '[OrgAI harness] Your conversation was just compacted. Where the run stands now:',
      'Plan (active, 1 of 3 steps done): Ship the feature',
      '- p1 [done] Read',
      '- p2 [in progress] Change (half way)',
      '- p3 [pending] Verify',
      'Reports working now (their reports reach you when they finish; do not redo their work):',
      '- implementer-1 (Implementer): Editing runUsage.ts',
      'Required reports not delivered yet: Reviewer.',
      'Continue from here; mark steps with update_plan as you go.'
    ].join('\n'))
  })

  it('empty without anything to say; bounded with many long steps', () => {
    expect(compactionStateText({ live: [], owed: [] })).toBe('')
    const many = plan(Array.from({ length: 80 }, (_, i) => step(`p${i}`, 'x'.repeat(500))))
    const text = compactionStateText({ plan: many, live: Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, activity: 'y'.repeat(300) })), owed: [] })
    expect(text.length).toBeLessThanOrEqual(COMPACTION_STATE_MAX_CHARS)
    expect(text).toContain('- p0 [pending] ')
  })
})
