import { describe, expect, it, vi } from 'vitest'
import type { RunPlan } from '@shared/types'
import { ClaudeSession } from './claude'
import { fakeCtx, project, role } from './testHelpers'

// Two adapter behaviours of the UI overhaul, against the session's own handlers (no CLI, no tokens):
// 1. `provider.retry` from the SDK's `api_retry` system message (SDKAPIRetryMessage: attempt, max_retries, retry_delay_ms,
//    error_status, error), and one `ok` at the next successful answer; never the provider's error text.
// 2. Project.askBeforeStrongerModel in the spawn hook: the question is raised through ctx.requestQuestion before the spawn.

/* eslint-disable @typescript-eslint/no-explicit-any */
const lead = role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng'], model: 'opus', tier: 'deep' })
const engineer = role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read'], reportsTo: 'r-lead', model: 'sonnet', tier: 'everyday', effort: 'high' })

function session(over: Parameters<typeof fakeCtx>[0] = {}, projectOver: Record<string, unknown> = {}) {
  const roles = [lead, engineer]
  const ctx = fakeCtx({ project: project({ roles, ...projectOver }), roles, ...over })
  const s = new ClaudeSession(ctx) as any
  return { s, ctx }
}

const apiRetry = (attempt: number, delayMs: number) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt,
  max_retries: 10,
  retry_delay_ms: delayMs,
  error_status: 529,
  error: 'overloaded: secret-provider-text',
  uuid: `u-${attempt}`,
  session_id: 's1'
})
const assistant = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: `a-${id}`,
  session_id: 's1',
  parent_tool_use_id: null,
  message: { id, role: 'assistant', model: 'opus', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
  ...over
})

describe('Claude provider.retry', () => {
  const retries = (ctx: ReturnType<typeof fakeCtx>) => ctx.events.filter((e) => e.type === 'provider.retry')

  it('maps api_retry to provider.retry with a 1-based attempt and nextTryAt, then one ok at the next answer', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const { s, ctx } = session()
      s.handle(apiRetry(1, 2000))
      s.handle(apiRetry(2, 4000))
      expect(retries(ctx)).toEqual([
        { type: 'provider.retry', runId: ctx.run.id, attempt: 1, nextTryAt: 1_002_000 },
        { type: 'provider.retry', runId: ctx.run.id, attempt: 2, nextTryAt: 1_004_000 }
      ])
      // The retry counts in the usage like before.
      expect(ctx.events.some((e) => e.type === 'agent.upsert' && e.agent.usage?.retries === 2)).toBe(true)
      // A failed API answer (an assistant frame with `error`) is not the successful answer.
      s.handle(assistant('m0', { error: 'server_error' }))
      expect(retries(ctx)).toHaveLength(2)
      s.handle(assistant('m1'))
      s.handle(assistant('m2'))
      expect(retries(ctx).slice(2)).toEqual([{ type: 'provider.retry', runId: ctx.run.id, attempt: 2, ok: true }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('never carries the provider error text', () => {
    const { s, ctx } = session()
    s.handle(apiRetry(1, 500))
    s.handle(assistant('m1'))
    expect(JSON.stringify(retries(ctx))).not.toContain('secret-provider-text')
    expect(JSON.stringify(retries(ctx))).not.toContain('overloaded')
  })

  it('numbers a zero-based attempt from 1 and rising, and omits nextTryAt without a usable delay', () => {
    const { s, ctx } = session()
    s.handle({ ...apiRetry(0, 1000), retry_delay_ms: undefined })
    s.handle(apiRetry(0, 1000))
    expect(retries(ctx).map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2])
    expect(retries(ctx)[0]).not.toHaveProperty('nextTryAt')
  })

  it('emits nothing without a retry, and the ok is not repeated', () => {
    const { s, ctx } = session()
    s.handle(assistant('m1'))
    expect(retries(ctx)).toHaveLength(0)
    s.handle(apiRetry(1, 100))
    s.handle(assistant('m2'))
    s.handle(assistant('m3'))
    expect(retries(ctx).filter((e) => (e as { ok?: true }).ok)).toHaveLength(1)
  })
})

describe('Claude askBeforeStrongerModel', () => {
  type Hook = (i: unknown, id: string, o: unknown) => Promise<Record<string, any>>
  const spawnInput = (id: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: 'engineer', prompt: 'Do it' }, cwd: '/repo' })
  const opts = { signal: new AbortController().signal }

  /** A first report of step p1 (staffed fast / high) failed; the next spawn of the step is an escalation to everyday. */
  async function afterFailedAttempt(answer: string[] | undefined, projectOver: Record<string, unknown>) {
    const requestQuestion = vi.fn(async (_req: unknown) => ({ selected: answer ?? [] }))
    const { s, ctx } = session({ requestQuestion }, projectOver)
    const plan: RunPlan = {
      goal: 'Ship',
      status: 'active',
      autoContinues: 0,
      updatedAt: 0,
      steps: [{ id: 'p1', title: 'Build', status: 'pending', staff: { role: 'engineer', tier: 'fast', effort: 'high' } }]
    }
    await ctx.updatePlan(plan)
    const hook: Hook = s.buildHooks().PreToolUse[0].hooks[0]
    const first = await hook(spawnInput('t1'), 't1', opts)
    expect(first.hookSpecificOutput?.updatedInput?.model).toBe('haiku')
    s.staffingStarted('t1', 'a1')
    s.staffingBook.ended('a1', { failed: true })
    const second = await hook(spawnInput('t2'), 't2', opts)
    return { requestQuestion, second, s, ctx }
  }

  it('off: the escalated retry runs without a question', async () => {
    const { requestQuestion, second } = await afterFailedAttempt(['Use it'], {})
    expect(requestQuestion).not.toHaveBeenCalled()
    // everyday is the engineer's own tier, so the definition's model applies (no model written).
    expect(second.hookSpecificOutput?.updatedInput?.model).toBeUndefined()
  })

  it('on, "Use it": asks before the spawn goes ahead, then spawns on the stronger tier', async () => {
    const { requestQuestion, second } = await afterFailedAttempt(['Use it'], { askBeforeStrongerModel: true })
    expect(requestQuestion).toHaveBeenCalledTimes(1)
    expect(requestQuestion.mock.calls[0]![0]).toMatchObject({
      agentId: 'root',
      question: 'Use a stronger model for Engineer? It may cost more.',
      options: [{ label: 'Use it' }, { label: "Keep the role's model" }]
    })
    expect(second.hookSpecificOutput?.updatedInput?.model).toBeUndefined()
  })

  it('on, "Keep the role\'s model": spawns on the kept tier (haiku) and logs why', async () => {
    const { requestQuestion, second, ctx } = await afterFailedAttempt(["Keep the role's model"], { askBeforeStrongerModel: true })
    expect(requestQuestion).toHaveBeenCalledTimes(1)
    expect(second.hookSpecificOutput?.updatedInput?.model).toBe('haiku')
    expect(ctx.events.some((e) => e.type === 'log' && e.message.includes('stronger model was not approved'))).toBe(true)
  })

  it('on, an empty answer (the run ended) keeps', async () => {
    const { second } = await afterFailedAttempt(undefined, { askBeforeStrongerModel: true })
    expect(second.hookSpecificOutput?.updatedInput?.model).toBe('haiku')
  })

  it('on, a first attempt that is not above the role never asks', async () => {
    const requestQuestion = vi.fn(async () => ({ selected: ['Use it'] }))
    const { s } = session({ requestQuestion }, { askBeforeStrongerModel: true })
    const hook: Hook = s.buildHooks().PreToolUse[0].hooks[0]
    await hook(spawnInput('t1'), 't1', opts)
    expect(requestQuestion).not.toHaveBeenCalled()
  })

  it('raises the PreToolUse hook timeout only when the option is on', () => {
    expect(session({}, { askBeforeStrongerModel: true }).s.buildHooks().PreToolUse[0].timeout).toBeGreaterThanOrEqual(120)
    expect(session().s.buildHooks().PreToolUse[0]).not.toHaveProperty('timeout')
  })
})
