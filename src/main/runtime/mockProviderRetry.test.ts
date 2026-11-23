import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import { MOCK_PROVIDER_RETRY_DELAY_MS, MockAdapter, PROVIDER_RETRY_TOKEN, type MockSession, type MockStep } from './mock'
import { type RootTurnEnd, type RuntimeContext } from './types'
import { fakeCtx, project, role } from './testHelpers'

// The mock as the reference adapter for `provider.retry` ([mock:provider-retry]) and Project.askBeforeStrongerModel.

/* eslint-disable @typescript-eslint/no-explicit-any */
const chart = () => [
  role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-eng'] }),
  role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead', model: 'sonnet', tier: 'everyday', effort: 'high' })
]

function start(work: MockStep[] | undefined, over: Partial<RuntimeContext> = {}, projectOver: Record<string, unknown> = {}) {
  const ends: RootTurnEnd[] = []
  const roles = chart()
  const connection = { connection: 'anthropic' as const, adapter: 'mock' as const, tierModels: { top: 'm-top', deep: 'm-deep', everyday: 'm-everyday', fast: 'm-fast' } }
  const base = fakeCtx({ project: project({ roles, ...projectOver }), roles, autoContinue: false, continuationDelayMs: 5, connection, ...over })
  const ctx = Object.assign(base, { onRootTurnEnded: (e: RootTurnEnd) => void ends.push(e) })
  const sessionP = new MockAdapter({ script: { delayMs: 0, ...(work ? { work } : {}) } }).start(ctx) as Promise<MockSession>
  return { ctx, sessionP, ends }
}
const retries = (events: RunEvent[]) => events.filter((e) => e.type === 'provider.retry')

describe('mock: [mock:provider-retry]', () => {
  it('emits two retries (attempts 1 and 2, nextTryAt ahead) then one ok, with no provider text', async () => {
    const { ctx, sessionP, ends } = start(undefined, { prompt: `Do it ${PROVIDER_RETRY_TOKEN}` })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 10_000 })
    const got = retries(ctx.events) as Array<{ type: string; runId: string; attempt: number; nextTryAt?: number; ok?: true }>
    expect(got).toHaveLength(3)
    expect(got[0]).toMatchObject({ runId: ctx.run.id, attempt: 1 })
    expect(got[1]).toMatchObject({ runId: ctx.run.id, attempt: 2 })
    expect(got[0]!.nextTryAt).toBeGreaterThan(Date.now() - 10_000)
    expect(got[1]!.nextTryAt! - got[0]!.nextTryAt!).toBeGreaterThanOrEqual(MOCK_PROVIDER_RETRY_DELAY_MS - 50)
    expect(got[2]).toEqual({ type: 'provider.retry', runId: ctx.run.id, attempt: 2, ok: true })
    expect(ends[0]).toMatchObject({ ok: true })
    await session.stop()
  }, 15_000)

  it('does nothing on a continuation (resume id)', async () => {
    const { ctx, sessionP, ends } = start(undefined, { prompt: `Do it ${PROVIDER_RETRY_TOKEN}`, resumeSessionId: 'mock-prev' })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(retries(ctx.events)).toHaveLength(0)
    await session.stop()
  })
})

describe('mock: askBeforeStrongerModel', () => {
  const planStep: MockStep = {
    type: 'plan',
    goal: 'Ship',
    steps: [{ title: 'Build', staff: { role: 'engineer', tier: 'fast', effort: 'high' } }] as never
  }
  const spawn = (id: string): MockStep => ({ type: 'spawn', id, role: 'engineer', description: `Work ${id}` })

  /** Report e1 on fast / high fails, then e2 is spawned: the book escalates it to everyday. */
  async function escalate(answer: string[], projectOver: Record<string, unknown>) {
    const requestQuestion = vi.fn(async (_req: unknown) => ({ selected: answer }))
    const { ctx, sessionP, ends } = start([planStep, spawn('e1')], { requestQuestion }, projectOver)
    const session = (await sessionP) as any
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    session.staffing.ended('e1', { failed: true })
    await session.spawnStep(spawn('e2'))
    const rows = ctx.getStaffing()!.assignments
    await session.stop()
    return { ctx, requestQuestion, rows }
  }

  it('off: the escalated spawn needs no question', async () => {
    const { requestQuestion, rows } = await escalate(['Use it'], {})
    expect(requestQuestion).not.toHaveBeenCalled()
    expect(rows[1]).toMatchObject({ source: 'escalated', tier: 'everyday' })
  })

  it('on, "Use it": asks once, then spawns on the stronger tier', async () => {
    const { requestQuestion, rows } = await escalate(['Use it'], { askBeforeStrongerModel: true })
    expect(requestQuestion).toHaveBeenCalledTimes(1)
    expect(requestQuestion.mock.calls[0]![0]).toMatchObject({ agentId: 'root', question: 'Use a stronger model for Engineer? It may cost more.' })
    expect(rows[1]).toMatchObject({ source: 'escalated', tier: 'everyday' })
  })

  it('on, "Keep the role\'s model": spawns on the kept tier', async () => {
    const { requestQuestion, rows, ctx } = await escalate(["Keep the role's model"], { askBeforeStrongerModel: true })
    expect(requestQuestion).toHaveBeenCalledTimes(1)
    expect(rows[1]!.tier).toBe('fast')
    expect(ctx.events.some((e) => e.type === 'log' && e.message.includes('stronger model was not approved'))).toBe(true)
  })

  it('on, a spawn that is not above the role never asks', async () => {
    const requestQuestion = vi.fn(async () => ({ selected: ['Use it'] }))
    const { ctx, sessionP, ends } = start([planStep, spawn('e1')], { requestQuestion }, { askBeforeStrongerModel: true })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(requestQuestion).not.toHaveBeenCalled()
    expect(ctx.getStaffing()!.assignments[0]).toMatchObject({ tier: 'fast' })
    await session.stop()
  })
})
