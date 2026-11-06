import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import {
  EXEC_BLOCKED_REASON,
  EXEC_BLOCKED_TOKEN,
  EXEC_PLAN_TOKEN,
  EXEC_QUESTION_OPTIONS,
  EXEC_QUESTION_TOKEN,
  EXEC_SLOW_STEPS,
  EXEC_SLOW_TOKEN,
  RATE_LIMIT_TOKEN,
  TURN_FAIL_TOKEN,
  MockAdapter,
  execSlowSteps,
  type MockSession
} from './mock'
import { ROOT_AGENT_ID, type RootTurnEnd, type RuntimeContext } from './types'
import { fakeCtx } from './testHelpers'

// Headless exec markers and settlement on the mock adapter (cli-spec Wave 3). Token-free.

function start(prompt: string, over: Partial<RuntimeContext> = {}) {
  const log: string[] = []
  const ends: RootTurnEnd[] = []
  const activity: string[] = []
  const base = fakeCtx({ prompt, autoContinue: false, continuationDelayMs: 5, ...over })
  const emit = base.emit
  const ctx = Object.assign(base, {
    emit: (e: RunEvent) => {
      if (e.type === 'run.status') log.push(`status:${e.status}`)
      emit(e)
    },
    onRootTurnEnded: (e: RootTurnEnd) => {
      ends.push(e)
      log.push(`end:${e.turnGen}`)
    },
    noteActivity: (r: string) => activity.push(r)
  })
  const adapter = new MockAdapter({ script: { delayMs: 0 } })
  const sessionP = adapter.start(ctx) as Promise<MockSession>
  return { ctx, sessionP, log, ends, activity }
}

const rootTexts = (events: RunEvent[]) =>
  events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))

describe('mock exec markers', () => {
  it('[mock:exec-plan]: two steps done, the plan completed, a closing text; settled and quiescent', async () => {
    const { ctx, sessionP, ends, log } = start(`Do it ${EXEC_PLAN_TOKEN}`)
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    const plan = ctx.getPlan()!
    expect(plan.status).toBe('done')
    expect(plan.steps.map((s) => [s.id, s.status])).toEqual([
      ['p1', 'done'],
      ['p2', 'done']
    ])
    expect(rootTexts(ctx.events).at(-1)).toBe('All done: both plan steps are complete.')
    expect(ends[0]).toEqual({ turnGen: 1, ok: true })
    expect(log.indexOf('end:1')).toBeLessThan(log.lastIndexOf('status:idle'))
    expect(session.settlement()).toEqual({ rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false, quiescent: true })
    await session.stop()
    await session.finished
  })

  it('[mock:exec-plan] with the driver on settles after its evaluation (plan done: no nudge)', async () => {
    const { sessionP, ends, activity } = start(`Do it ${EXEC_PLAN_TOKEN}`, { autoContinue: true, continuationDelayMs: 300 })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1), { interval: 5 })
    // The evaluation timer is pending.
    expect(session.settlement().continuationSettled).toBe(false)
    await vi.waitFor(() => expect(session.settlement().continuationSettled).toBe(true))
    expect(session.harnessMessages).toEqual([])
    expect(activity).toContain('continuation')
    await session.stop()
  })

  it('[mock:exec-blocked]: a plan, then mark_blocked with the reason', async () => {
    const { ctx, sessionP, ends } = start(`Do it ${EXEC_BLOCKED_TOKEN}`)
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ctx.getPlan()).toMatchObject({ status: 'blocked', blockedReason: EXEC_BLOCKED_REASON })
    await session.stop()
  })

  it('[mock:exec-question]: ask_user with the two options, then a text echoing the answer', async () => {
    const { ctx, sessionP, ends } = start(`Do it ${EXEC_QUESTION_TOKEN}`)
    vi.mocked(ctx.requestQuestion).mockResolvedValue({ selected: [EXEC_QUESTION_OPTIONS[0]] })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    const asked = vi.mocked(ctx.requestQuestion).mock.calls[0]![0]
    expect(asked.options.map((o) => o.label)).toEqual(['(Recommended) Keep the default', 'Change it'])
    expect(rootTexts(ctx.events).at(-1)).toBe('You chose: (Recommended) Keep the default')
    await session.stop()
  })

  it('[mock:turn-fail]: one text, then a failed root turn (error_during_execution) before idle; the session stays open', async () => {
    const { ctx, sessionP, ends, log } = start(`Do it ${TURN_FAIL_TOKEN}`, { autoContinue: true })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]).toEqual({ turnGen: 1, ok: false, errorSubtype: 'error_during_execution' })
    expect(rootTexts(ctx.events)).toEqual(['Starting on the request.'])
    const root = ctx.events.filter((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === ROOT_AGENT_ID).at(-1)!.agent
    expect(root.state).toBe('error')
    expect(log.slice(log.indexOf('end:1'))).toEqual(['end:1', 'status:idle'])
    // Skipped by the driver: settled at once, no nudge.
    expect(session.settlement()).toMatchObject({ rootTurnGen: 1, rootIdle: true, continuationSettled: true, nudgeTurn1Sent: false })
    await new Promise((r) => setTimeout(r, 30))
    expect(session.harnessMessages).toEqual([])
    expect(log).not.toContain('status:finished')
    await session.stop()
    await session.finished
  })

  it('[mock:rate-limit]: reports the limit (reset in 1.5 s), a limited turn end, and the session ends', async () => {
    const { ctx, sessionP, ends, log } = start(`Do it ${RATE_LIMIT_TOKEN}`)
    const before = Date.now()
    const session = await sessionP
    await session.finished
    const arg = vi.mocked(ctx.rateLimited).mock.calls[0]![0]
    expect(arg.until! - before).toBeGreaterThanOrEqual(1400)
    expect(arg.until! - before).toBeLessThan(5000)
    expect(ends).toEqual([{ turnGen: 1, ok: true, limited: true }])
    expect(log.at(-1)).toBe('status:finished')
  })

  it('[mock:exec-slow]: about 30 one-second steps, cut short by interrupt', async () => {
    expect(execSlowSteps(400).filter((s) => s.type === 'text')).toHaveLength(EXEC_SLOW_STEPS)
    expect(execSlowSteps(400).find((s) => s.type === 'wait')).toEqual({ type: 'wait', ms: 600 })
    expect(execSlowSteps(2000).some((s) => s.type === 'wait')).toBe(false)
    const { ctx, sessionP, ends } = start(`Do it ${EXEC_SLOW_TOKEN}`)
    const session = await sessionP
    await vi.waitFor(() => expect(rootTexts(ctx.events).length).toBeGreaterThan(0), { timeout: 3000 })
    await session.interrupt()
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]).toEqual({ turnGen: 1, ok: true, interrupted: true })
    expect(rootTexts(ctx.events).length).toBeLessThan(EXEC_SLOW_STEPS)
    expect(session.settlement().continuationSettled).toBe(true)
    await session.stop()
    await session.finished
  })

  it('[mock:exec-slow] honours stop', async () => {
    const { ctx, sessionP } = start(`Do it ${EXEC_SLOW_TOKEN}`)
    const session = await sessionP
    await vi.waitFor(() => expect(rootTexts(ctx.events).length).toBeGreaterThan(0), { timeout: 3000 })
    await session.stop()
    await session.finished
    expect(rootTexts(ctx.events).length).toBeLessThan(EXEC_SLOW_STEPS)
  })

  it('the auth-fail marker reports ok false with isAuthError before the error status', async () => {
    const { sessionP, ends, log } = start('Do it [mock:auth-fail]')
    const session = await sessionP
    await session.finished
    expect(ends).toEqual([{ turnGen: 1, ok: false, isAuthError: true }])
    expect(log.indexOf('end:1')).toBeLessThan(log.indexOf('status:error'))
  })

  it('the default script: root turn ends before idle with increasing turnGen; subagent and report activity; follow-up turn', async () => {
    const { ctx, sessionP, ends, log, activity } = start('Do it')
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 3000 })
    expect(activity).toEqual(expect.arrayContaining(['subagent', 'report']))
    expect(session.settlement()).toMatchObject({ rootTurnGen: 1, rootIdle: true, continuationSettled: true, quiescent: true })
    await session.send('More')
    expect(session.settlement().quiescent).toBe(false)
    expect(session.settlement().continuationSettled).toBe(false)
    await vi.waitFor(() => expect(ends).toHaveLength(2))
    expect(ends.map((e) => e.turnGen)).toEqual([1, 2])
    const order = log.filter((l) => l.startsWith('end:') || l === 'status:idle')
    expect(order).toEqual(['end:1', 'status:idle', 'end:2', 'status:idle'])
    expect(session.settlement()).toMatchObject({ rootTurnGen: 2, continuationSettled: true, quiescent: true })
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'error')).toBe(false)
    await session.stop()
  })

  it('setup runs settle at once (driver off) after their turn', async () => {
    const { sessionP, ends } = start('Set it up', { run: { ...fakeCtx().run, kind: 'setup' } })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 5000 })
    expect(session.settlement()).toMatchObject({ rootTurnGen: 1, continuationSettled: true })
    await session.stop()
  })
})
