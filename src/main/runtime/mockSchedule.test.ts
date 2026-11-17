import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SchedulesProposalPayload, TranscriptBlock } from '@shared/types'
import {
  MOCK_SCHEDULE_APPROVED,
  MOCK_SCHEDULE_DECLINED,
  MOCK_SCHEDULE_NAME,
  MOCK_SCHEDULE_ONCE_DELAY_MS,
  MOCK_SCHEDULE_PROMPT,
  MOCK_SCHEDULE_REVISE,
  MockAdapter,
  SCHEDULE_ONCE_TOKEN,
  SCHEDULE_TOKEN,
  type MockSession
} from './mock'
import type { RuntimeContext } from './types'
import { fakeCtx, project as projectOf, runSummary } from './testHelpers'
import { fakeEnv, type FakeEnv } from '../schedules/testkit'

const quick = { folder: '/some/folder', team: 'single' as const, allowEdits: false, gitRepo: false }
let env: FakeEnv | undefined
afterEach(() => env?.cleanup())

type Outcome = { behavior: 'approve' } | { behavior: 'decline' } | { behavior: 'revise'; feedback: string }

/** A run context whose schedules access is a real ScheduleService; an approved card goes through applyProposal like RunManager. */
function ctxFor(token: string, where: 'chat' | 'work', outcome: Outcome = { behavior: 'approve' }, over: Partial<RuntimeContext> = {}) {
  env = fakeEnv()
  const e = env
  // The run's own project (with roles, as the mock needs); the service knows p1 as its stored project.
  const project = projectOf({ id: 'p1', name: 'Project p1' })
  const run = where === 'chat' ? runSummary({ projectId: 'quick', quick, prompt: token }) : runSummary({ projectId: 'p1', prompt: token })
  const requestProposal = vi.fn(async (p: { kind: string; payload: unknown }) => {
    if (outcome.behavior === 'approve') e.service.applyProposal(p.payload as SchedulesProposalPayload, { projectId: where === 'chat' ? null : 'p1' })
    return outcome
  })
  return fakeCtx({ ...(where === 'work' ? { project } : {}), run, prompt: token, autoContinue: false, schedules: e.service.access(), requestProposal, ...over } as Partial<RuntimeContext>)
}

async function runToIdle(ctx: ReturnType<typeof fakeCtx>): Promise<MockSession> {
  const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
  await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true), { timeout: 3000 })
  return session
}

const blocks = (ctx: ReturnType<typeof fakeCtx>): TranscriptBlock[] => ctx.events.flatMap((e) => (e.type === 'transcript' ? [e.entry.block] : []))
const texts = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'text' ? [b.text] : []))
const proposeCalls = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'tool_use' && b.name === 'propose_schedule' ? [b.input as { items: { schedule: Record<string, unknown> }[] }] : []))
const stopAll = async (s: MockSession): Promise<void> => {
  await s.stop()
  await s.finished
}

describe('mock [mock:schedule] / [mock:schedule-once]', () => {
  it.each([
    ['chat', SCHEDULE_TOKEN],
    ['work', SCHEDULE_TOKEN],
    ['chat', SCHEDULE_ONCE_TOKEN],
    ['work', SCHEDULE_ONCE_TOKEN]
  ] as const)('%s run with %s: one schedules card with main-written summary and next runs; approval saves it', async (where, token) => {
    const ctx = ctxFor(`please ${token}`, where)
    const now = env!.clock.now
    const session = await runToIdle(ctx)
    const calls = proposeCalls(ctx)
    expect(calls).toHaveLength(1)
    const body = calls[0]!.items[0]!.schedule
    expect(body).toEqual({
      name: MOCK_SCHEDULE_NAME,
      prompt: MOCK_SCHEDULE_PROMPT,
      target: where === 'chat' ? { kind: 'ask' } : { kind: 'team', projectId: 'p1' },
      timing: token === SCHEDULE_ONCE_TOKEN ? { kind: 'once', at: now + MOCK_SCHEDULE_ONCE_DELAY_MS } : { kind: 'daily', time: '00:00' },
      missed: 'run-once'
    })
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
    const card = vi.mocked(ctx.requestProposal).mock.calls[0]![0] as { kind: string; payload: SchedulesProposalPayload }
    expect(card.kind).toBe('schedules')
    const item = card.payload.items[0]!
    expect(item.summary).toContain(`Create "${MOCK_SCHEDULE_NAME}"`)
    expect(item.summary).toContain(where === 'chat' ? 'Ask in Chat' : 'Team run on Project p1')
    expect(item.nextRuns.length).toBe(token === SCHEDULE_ONCE_TOKEN ? 1 : 3)
    if (token === SCHEDULE_ONCE_TOKEN) expect(item.nextRuns[0]).toBe(now + MOCK_SCHEDULE_ONCE_DELAY_MS)
    const saved = env!.service.list()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: MOCK_SCHEDULE_NAME, prompt: MOCK_SCHEDULE_PROMPT, enabled: true, missed: 'run-once' })
    expect(saved[0]!.target.kind).toBe(where === 'chat' ? 'ask' : 'team')
    expect(texts(ctx)).toEqual([MOCK_SCHEDULE_APPROVED])
    await stopAll(session)
  })

  it.each([
    [{ behavior: 'revise', feedback: 'later' } as const, MOCK_SCHEDULE_REVISE],
    [{ behavior: 'decline' } as const, MOCK_SCHEDULE_DECLINED]
  ])('answers %o with a line starting with its first word and saves nothing', async (outcome, line) => {
    const ctx = ctxFor(SCHEDULE_TOKEN, 'chat', outcome)
    const session = await runToIdle(ctx)
    expect(env!.service.list()).toHaveLength(0)
    expect(texts(ctx)).toEqual([line])
    await stopAll(session)
  })

  it('on a scheduled run the tool refuses, no card is shown, and the mock says the refusal', async () => {
    const ctx = ctxFor(SCHEDULE_TOKEN, 'chat', { behavior: 'approve' }, { run: runSummary({ projectId: 'quick', quick, prompt: SCHEDULE_TOKEN, scheduleId: 'sch_aa11', scheduleName: 'x' }) })
    const session = await runToIdle(ctx)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
    expect(texts(ctx)).toEqual(['REFUSED: A scheduled run cannot create or change schedules.'])
    await stopAll(session)
  })
})
