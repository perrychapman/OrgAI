import { describe, expect, it, vi } from 'vitest'
import { AGENT_BRIEF_MAX_CHARS, type AgentInstance, type RunEvent } from '@shared/types'
import { BUDGET_STOP_TOKEN, MOCK_PROVIDER_ERROR_MESSAGE, MockAdapter, PROVIDER_ERROR_TOKEN, type MockSession, type MockStep } from './mock'
import { ROOT_AGENT_ID, type RootTurnEnd, type RuntimeContext } from './types'
import { fakeCtx, project, role } from './testHelpers'

// The mock as the reference adapter for the UI overhaul: spawn caps, AgentInstance.brief, stopAgent and the RunHold
// markers [mock:budget-stop] / [mock:provider-error]. Token-free.

const chart = (eng: Record<string, unknown> = {}) => [
  role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-eng', 'r-help'] }),
  role({ id: 'r-eng', slug: 'engineer', canSpawn: true, spawnable: ['r-help'], reportsTo: 'r-lead', ...eng }),
  role({ id: 'r-help', slug: 'helper', reportsTo: 'r-lead' })
]

function start(work: MockStep[] | undefined, over: Partial<RuntimeContext> = {}, roles = chart(), projectOver: Record<string, unknown> = {}) {
  const ends: RootTurnEnd[] = []
  const base = fakeCtx({ project: project({ roles, maxConcurrentSubagents: 8, ...projectOver }), roles, autoContinue: false, continuationDelayMs: 5, ...over })
  const ctx = Object.assign(base, { onRootTurnEnded: (e: RootTurnEnd) => void ends.push(e) })
  const sessionP = new MockAdapter({ script: { delayMs: 0, ...(work ? { work } : {}) } }).start(ctx) as Promise<MockSession>
  return { ctx, sessionP, ends }
}
const lastOf = (events: RunEvent[], id: string): AgentInstance | undefined =>
  events.filter((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === id).at(-1)?.agent
const spawnResults = (events: RunEvent[]): { content: string; isError: boolean }[] =>
  events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'tool_result' ? [{ content: e.entry.block.content, isError: !!e.entry.block.isError }] : []))
const spawn = (id: string, role = 'engineer', brief?: string): MockStep => ({ type: 'spawn', id, role, description: `Work ${id}`, ...(brief ? { brief } : {}) })

describe('mock: spawn caps', () => {
  it('a role cap refuses the N+1th live spawn, skips its later steps, and allows after one finished', async () => {
    const { ctx, sessionP, ends } = start(
      [spawn('e1'), spawn('e2'), { type: 'text', agent: 'e2', text: 'must not run' }, spawn('h1', 'helper'), { type: 'finish', id: 'e1', result: 'done' }, spawn('e3')],
      {},
      chart({ maxConcurrent: 1 })
    )
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'e1')?.state).toBe('done')
    expect(lastOf(ctx.events, 'e2')).toBeUndefined()
    expect(lastOf(ctx.events, 'h1')).toBeDefined()
    expect(lastOf(ctx.events, 'e3')).toBeDefined()
    const refusals = spawnResults(ctx.events).filter((r) => r.isError)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.content).toContain('Concurrent limit for engineer reached (1 running at once)')
    expect(ctx.events.some((e) => e.type === 'transcript' && e.entry.block.kind === 'text' && e.entry.block.text === 'must not run')).toBe(false)
    await session.stop()
  })

  it('the run total refuses the N+1th agent even when earlier ones ended', async () => {
    const { ctx, sessionP, ends } = start([spawn('e1'), { type: 'finish', id: 'e1', result: 'ok' }, spawn('h1', 'helper'), { type: 'finish', id: 'h1', result: 'ok' }, spawn('h2', 'helper')], {}, chart(), { maxAgentsPerRun: 2 })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'h2')).toBeUndefined()
    const refusal = spawnResults(ctx.events).find((r) => r.isError)
    expect(refusal?.content).toContain('Agent limit reached (this run may start 2 agents in total and 2 have started)')
    await session.stop()
  })

  it('both caps are read from ctx at each spawn (a cap changed mid-run applies to the next one)', async () => {
    const { ctx, sessionP, ends } = start([spawn('e1'), { type: 'wait', ms: 1 }], {}, chart(), { maxAgentsPerRun: 1 })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'e1')).toBeDefined()
    // The next turn spawns more: raised, it now passes.
    ctx.project = { ...ctx.project, maxAgentsPerRun: 3 }
    // A direct step call: the spawn gate is the same one a scripted turn reaches.
    await (session as unknown as { spawnStep(s: MockStep): Promise<void> }).spawnStep(spawn('h1', 'helper'))
    expect(lastOf(ctx.events, 'h1')).toBeDefined()
    ctx.project = { ...ctx.project, maxAgentsPerRun: 2 }
    await (session as unknown as { spawnStep(s: MockStep): Promise<void> }).spawnStep(spawn('h2', 'helper'))
    expect(lastOf(ctx.events, 'h2')).toBeUndefined()
    await session.stop()
  })

  it('counts the run\'s bridged agents (ctx.spawnCapAgents, read live) toward the total and a role cap', async () => {
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = [
      { id: 'ag_b', state: 'thinking', roleId: 'r-oa' },
      { id: 'ag_b:h1', state: 'thinking', roleId: 'r-eng' }
    ]
    // maxAgentsPerRun 3 with two bridged agents: the first native spawn fits, the second is refused by the total.
    const { ctx, sessionP, ends } = start([spawn('e1'), spawn('h1', 'helper'), { type: 'finish', id: 'e1', result: 'ok' }], { spawnCapAgents: () => bridged }, chart({ maxConcurrent: 2 }), { maxAgentsPerRun: 3 })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'e1')).toBeDefined()
    expect(lastOf(ctx.events, 'h1')).toBeUndefined()
    expect(spawnResults(ctx.events).find((r) => r.isError)?.content).toContain('Agent limit reached (this run may start 3 agents in total and 3 have started)')
    // Live: with one bridged agent gone the helper now fits.
    bridged.pop()
    await (session as unknown as { spawnStep(s: MockStep): Promise<void> }).spawnStep(spawn('h2', 'helper'))
    expect(lastOf(ctx.events, 'h2')).toBeDefined()
    await session.stop()
  })

  it('a live bridged agent of a capped role refuses a native spawn of that role', async () => {
    const bridged: { id: string; state: AgentInstance['state']; roleId: string | null }[] = [{ id: 'ag_b:e', state: 'thinking', roleId: 'r-eng' }]
    const { ctx, sessionP, ends } = start([spawn('e1')], { spawnCapAgents: () => bridged }, chart({ maxConcurrent: 1 }))
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'e1')).toBeUndefined()
    expect(spawnResults(ctx.events).find((r) => r.isError)?.content).toContain('Concurrent limit for engineer reached (1 running at once)')
    await session.stop()
  })

  it('without caps every spawn goes through', async () => {
    const { ctx, sessionP, ends } = start([spawn('e1'), spawn('e2'), spawn('e3')])
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    for (const id of ['e1', 'e2', 'e3']) expect(lastOf(ctx.events, id)).toBeDefined()
    expect(spawnResults(ctx.events).filter((r) => r.isError)).toEqual([])
    await session.stop()
  })
})

describe('mock: AgentInstance.brief', () => {
  it('is the spawn brief (else its description), cut to AGENT_BRIEF_MAX_CHARS, set on the first upsert, absent on the root', async () => {
    const long = 'z'.repeat(AGENT_BRIEF_MAX_CHARS + 100)
    const { ctx, sessionP, ends } = start([spawn('e1', 'engineer', 'Build the parser.'), spawn('h1', 'helper', long), { type: 'spawn', id: 'h2', role: 'helper', description: 'Only a description' }])
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    const firstUpsert = ctx.events.find((e): e is Extract<RunEvent, { type: 'agent.upsert' }> => e.type === 'agent.upsert' && e.agent.id === 'e1')!.agent
    expect(firstUpsert.brief).toBe('Build the parser.')
    expect(lastOf(ctx.events, 'h1')?.brief).toHaveLength(AGENT_BRIEF_MAX_CHARS)
    expect(lastOf(ctx.events, 'h2')?.brief).toBe('Only a description')
    expect(lastOf(ctx.events, ROOT_AGENT_ID)?.brief).toBeUndefined()
    await session.stop()
  })
})

describe('mock: stopAgent', () => {
  it('never the root; false for an unknown agent', async () => {
    const { sessionP, ends } = start([spawn('e1')])
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(await session.stopAgent(ROOT_AGENT_ID)).toBe(false)
    expect(await session.stopAgent('nope')).toBe(false)
    await session.stop()
  })

  it('stops a running report and the ones under it, ends them as done, and a second stop is false', async () => {
    const { ctx, sessionP, ends } = start([spawn('e1'), { type: 'spawn', id: 'h1', role: 'helper', description: 'Sub', parent: 'e1' }, spawn('h2', 'helper')])
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(lastOf(ctx.events, 'h1')?.parentId).toBe('e1')
    expect(await session.stopAgent('e1')).toBe(true)
    expect(lastOf(ctx.events, 'e1')).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    expect(lastOf(ctx.events, 'h1')).toMatchObject({ state: 'done', activity: 'Stopped by you' })
    expect(lastOf(ctx.events, 'e1')?.endedAt).toBeTypeOf('number')
    // The sibling and the root go on.
    expect(lastOf(ctx.events, 'h2')?.state).not.toBe('done')
    expect(lastOf(ctx.events, ROOT_AGENT_ID)?.state).not.toBe('done')
    expect(await session.stopAgent('e1')).toBe(false)
    // The parent's spawn call is answered, so its transcript stays whole.
    expect(spawnResults(ctx.events).filter((r) => r.isError).map((r) => r.content)).toContain('The user stopped this agent before it reported.')
    await session.stop()
  })

  it('a stopped report\'s remaining scripted steps are skipped', async () => {
    const { ctx, sessionP, ends } = start([spawn('e1'), { type: 'text', agent: 'e1', text: 'first words' }])
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    await session.stopAgent('e1')
    await (session as unknown as { step(s: MockStep): Promise<void> }).step({ type: 'text', agent: 'e1', text: 'after the stop' })
    const texts = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
    expect(texts).toContain('first words')
    expect(texts).not.toContain('after the stop')
    await session.stop()
  })
})

describe('mock: RunHold markers', () => {
  it('[mock:budget-stop]: one text, then the root turn ends on the spending limit; the session stays open', async () => {
    const { ctx, sessionP, ends } = start(undefined, { prompt: `Do it ${BUDGET_STOP_TOKEN}` })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]).toEqual({ turnGen: 1, ok: false, errorSubtype: 'error_max_budget_usd' })
    expect(lastOf(ctx.events, ROOT_AGENT_ID)).toMatchObject({ state: 'error', activity: 'max budget usd' })
    expect(ctx.events.filter((e) => e.type === 'run.status').map((e) => (e as { status: string }).status)).toEqual(['running', 'idle'])
    await session.stop()
  })

  it('[mock:budget-stop] does nothing on a continuation (resume id), so the held run can go on', async () => {
    const { ends, sessionP } = start(undefined, { prompt: `Do it ${BUDGET_STOP_TOKEN}`, resumeSessionId: 'mock-prev' })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]).toMatchObject({ ok: true })
    await session.stop()
  })

  it('[mock:provider-error]: one text, then run.status error with the provider message, session open (no turn-end failure, no auth flag)', async () => {
    const { ctx, sessionP, ends } = start(undefined, { prompt: `Do it ${PROVIDER_ERROR_TOKEN}` })
    const session = await sessionP
    await session.finished
    const statuses = ctx.events.filter((e): e is Extract<RunEvent, { type: 'run.status' }> => e.type === 'run.status')
    expect(statuses.at(-1)).toMatchObject({ status: 'error', error: MOCK_PROVIDER_ERROR_MESSAGE })
    expect(lastOf(ctx.events, ROOT_AGENT_ID)?.state).toBe('error')
    // The first turn itself ended fine; the failure came after it, outside any turn, and is not an auth failure.
    expect(ends).toEqual([{ turnGen: 1, ok: true }])
    expect(MOCK_PROVIDER_ERROR_MESSAGE).not.toMatch(/auth|key|login/i)
  })

  it('[mock:provider-error] does nothing on a continuation', async () => {
    const { ctx, sessionP, ends } = start(undefined, { prompt: `Do it ${PROVIDER_ERROR_TOKEN}`, resumeSessionId: 'mock-prev' })
    const session = await sessionP
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'error')).toBe(false)
    await session.stop()
  })
})
