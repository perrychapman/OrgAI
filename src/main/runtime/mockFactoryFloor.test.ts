import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, AgentMessage, PermissionDecision, RunEvent, RunPlan } from '@shared/types'
import { defaultRoles } from '@shared/defaults'
import { FACTORY_FLOOR_IDS, FACTORY_FLOOR_PAUSE_TOKEN, FACTORY_FLOOR_TOKEN, MOCK_FACTORY_FLOOR_READY, MockAdapter, factoryFloorSteps } from './mock'
import { ROOT_AGENT_ID } from './types'
import { fakeCtx, project } from './testHelpers'

function latest(events: RunEvent[]): Map<string, AgentInstance> {
  const m = new Map<string, AgentInstance>()
  for (const e of events) {
    if (e.type === 'agent.upsert') m.set(e.agent.id, e.agent)
    if (e.type === 'agent.remove') m.delete(e.agentId)
  }
  return m
}

async function start(prompt: string, over: Parameters<typeof fakeCtx>[0] = {}) {
  let answer: (() => void) | undefined
  const ctx = fakeCtx({
    autoContinue: false,
    prompt,
    project: project({ roles: defaultRoles() }),
    // The background card stays pending until the test answers it.
    requestPermission: vi.fn(() => new Promise<PermissionDecision>((resolve) => { answer = () => resolve({ behavior: 'allow' as const }) })),
    ...over
  })
  const session = await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)
  return { ctx, session, answer: () => answer?.() }
}

describe('mock [mock:factory-floor]', () => {
  it('spawns 39 agents to depth 3 and leaves every state, worktree status, message and the plan standing', async () => {
    const { ctx, session, answer } = await start(`Run the floor ${FACTORY_FLOOR_TOKEN}`)
    // The held tool step: ff-w111 is in state 'tool' after READY, and stays there while the hold runs.
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === MOCK_FACTORY_FLOOR_READY)).toBe(true))
    await vi.waitFor(() => expect(latest(ctx.events).get('ff-w111')?.state).toBe('tool'))
    await new Promise((r) => setTimeout(r, 100))
    expect(latest(ctx.events).get('ff-w111')?.state).toBe('tool')

    const agents = latest(ctx.events)
    const ids = [...FACTORY_FLOOR_IDS.leads, ...FACTORY_FLOOR_IDS.subs, ...FACTORY_FLOOR_IDS.workers]
    expect(ids).toHaveLength(39)
    // ff-w333 was removed: 40 agents with the root minus one.
    expect(agents.size).toBe(39)
    expect(agents.has('ff-w333')).toBe(false)
    expect(ctx.events.filter((e) => e.type === 'agent.remove')).toEqual([{ type: 'agent.remove', runId: ctx.run.id, agentId: 'ff-w333' }])
    const depth = (a: AgentInstance): number => (a.parentId === null ? 0 : 1 + depth(agents.get(a.parentId)!))
    expect(Math.max(...[...agents.values()].map(depth))).toBe(3)
    expect(agents.get('ff-s23')?.parentId).toBe('ff-l2')
    expect(agents.get('ff-w231')?.parentId).toBe('ff-s23')
    expect(agents.get('ff-l1')?.parentId).toBe(ROOT_AGENT_ID)

    const state = (id: string): string | undefined => agents.get(id)?.state
    expect(state('ff-w121')).toBe('starting')
    expect(state('ff-w122')).toBe('idle')
    expect(state('ff-w123')).toBe('error')
    for (const id of ['ff-w131', 'ff-w132', 'ff-w133', 'ff-s13']) expect(state(id)).toBe('done')
    expect(state('ff-w211')).toBe('waiting')
    expect(state('ff-l2')).toBe('delegating')
    expect(state('ff-s21')).toBe('delegating')
    expect(state(ROOT_AGENT_ID)).toBe('thinking')
    expect(state('ff-w111')).toBe('tool')
    expect(state('ff-w211')).toBe('waiting')

    // toolCalls: one per Read on ff-w111 (3 + the held one), counted at the step start.
    const counts = ctx.events.flatMap((e) => (e.type === 'agent.upsert' && e.agent.id === 'ff-w111' ? [e.agent.usage?.toolCalls ?? 0] : []))
    expect(counts.at(-1)).toBe(4)
    expect(counts.every((n, i) => i === 0 || n >= counts[i - 1]!)).toBe(true)

    const wt = (id: string) => agents.get(id)?.worktree
    expect(wt('ff-w111')?.status).toBe('active')
    expect(wt('ff-w112')?.status).toBe('merging')
    expect(wt('ff-w113')).toMatchObject({ status: 'merged', mergeTarget: 'main' })
    expect(wt('ff-w131')).toMatchObject({ status: 'merged', mergeTarget: 'parent', parentAgentId: 'ff-s13' })
    expect(wt('ff-w132')?.status).toBe('review')
    expect(wt('ff-w133')?.status).toBe('held')
    expect(wt('ff-w211')?.status).toBe('empty')
    expect(wt('ff-w212')?.status).toBe('conflict')
    expect(wt('ff-w213')?.status).toBe('removed')
    expect(wt('ff-s13')?.status).toBe('waiting-children')

    const messages = ctx.events.flatMap((e) => (e.type === 'agent.message' ? [e as unknown as AgentMessage & { type: string }] : []))
    expect(messages.map((m) => [m.from, m.to, m.toHandle])).toEqual([
      ['ff-l1', 'ff-s11', 'ff-s11'],
      ['ff-w111', null, 'user'],
      ['ff-w112', null, 'nobody-here']
    ])

    // RunManager owns plan.updated; here the context's stored plan is what the plan tools wrote.
    const plan = ctx.getPlan() as RunPlan
    expect(plan.steps.map((s) => [s.id, s.status, s.owner])).toEqual([
      ['p1', 'in_progress', 'ff-l1'],
      ['p2', 'blocked', 'ff-w111'],
      ['p3', 'pending', undefined]
    ])

    // The pending card names the waiting worker.
    expect(ctx.requestPermission).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'ff-w211' }))
    answer()
    await vi.waitFor(() => expect(latest(ctx.events).get('ff-w211')?.state).toBe('thinking'))
    await session.stop()
    await session.finished
  })

  it('-pause ends the turn at a usage limit', async () => {
    const steps = factoryFloorSteps('a', 'b', true)
    expect(steps.at(-1)).toMatchObject({ type: 'rateLimit' })
    expect(factoryFloorSteps('a', 'b').some((s) => s.type === 'rateLimit')).toBe(false)
    expect(FACTORY_FLOOR_PAUSE_TOKEN).not.toContain(FACTORY_FLOOR_TOKEN)
  })

  it('a tool step with holdMs keeps the agent in state tool until the hold ends', async () => {
    const ctx = fakeCtx({ autoContinue: false, prompt: 'x' })
    const session = await new MockAdapter({ script: { delayMs: 0, work: [{ type: 'tool', name: 'Read', input: { file_path: 'a' }, holdMs: 150 }] } }).start(ctx)
    await vi.waitFor(() => expect(latest(ctx.events).get(ROOT_AGENT_ID)?.state).toBe('tool'))
    await new Promise((r) => setTimeout(r, 60))
    expect(latest(ctx.events).get(ROOT_AGENT_ID)?.state).toBe('tool')
    await vi.waitFor(() => expect(latest(ctx.events).get(ROOT_AGENT_ID)?.state).not.toBe('tool'))
    await session.stop()
    await session.finished
  })
})
