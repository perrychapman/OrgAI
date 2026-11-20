import { describe, expect, it, vi } from 'vitest'
import { LIVE_RUN_CHANGE_WAIT_MS, MCP_HARNESS_TOOLS, SKILL_ASSIST_HARNESS_TOOLS, SKILL_HARNESS_TOOLS } from '@shared/types'
import {
  CONFIG_CHANGE_TOKEN,
  HOST_AFTER_IDLE_TOKEN,
  HOST_REJECT_TOKEN,
  HOST_SLOW_TOKEN,
  MOCK_CONFIG_SERVER,
  MOCK_CONFIG_SKILL,
  MOCK_HOST_REJECT_REASON,
  MOCK_HOST_SLOW_MS,
  MODEL_SWITCH_TOKEN,
  MockAdapter,
  configChangeSteps,
  type MockSession
} from './mock'
import { ROOT_AGENT_ID, type RunSkill } from './types'
import { HOST_CHANGE_LEAD } from './hostConfigNotice'
import { fakeCtx, mcpSpec, runSummary } from './testHelpers'

const toolNames = (s: MockSession) => (s as unknown as { tools: { name: string }[] }).tools.map((t) => t.name)

describe('mock configChanged hook', () => {
  it('records each change, answers now, and re-binds the skill tools to the live skills', async () => {
    let skills: RunSkill[] = []
    const ctx = fakeCtx({ autoContinue: false, skills: () => skills })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    // list_skills / load_skill are bound on every non-native work run, even with no skills at start.
    expect(toolNames(session)).toContain(SKILL_HARNESS_TOOLS.load)
    await expect(session.configChanged({ mcp: { upserted: ['notes'], removed: ['old'] } })).resolves.toEqual({ availability: 'now' })
    skills = [{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }]
    await expect(session.configChanged({ skills: true })).resolves.toEqual({ availability: 'now' })
    expect(session.configChanges).toEqual([{ mcp: { upserted: ['notes'], removed: ['old'] } }, { skills: true }])
    expect(toolNames(session)).toEqual(expect.arrayContaining([SKILL_HARNESS_TOOLS.list, SKILL_HARNESS_TOOLS.load]))
    await session.stop()
    await session.finished
  })
})

describe('mock hostConfigChanged (the user changed the project in OrgAI)', () => {
  const idle = (ctx: { events: { type: string; status?: string }[] }) => ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')

  it('idle root: applies now, records host: true, starts no turn, and the notice comes with the user\'s next message', async () => {
    let skills: RunSkill[] = []
    const ctx = fakeCtx({ autoContinue: false, skills: () => skills })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(idle(ctx)).toBe(true))
    const harnessBefore = session.harnessMessages.length
    skills = [{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }]
    await expect(session.hostConfigChanged({ skills: true })).resolves.toEqual({ availability: 'now' })
    expect(session.configChanges).toEqual([{ skills: true, host: true }])
    expect(session.hostNotices).toHaveLength(1)
    expect(session.hostNotices[0]!.delivery).toBe('next-message')
    expect(session.hostNotices[0]!.text).toContain(HOST_CHANGE_LEAD)
    expect(session.hostNotices[0]!.text).toContain('Skills granted now: alpha for Lead (lead). Load one with load_skill.')
    expect(session.harnessMessages.length).toBe(harnessBefore)
    expect(toolNames(session)).toContain(SKILL_HARNESS_TOOLS.load)
    await session.send('carry on')
    await vi.waitFor(() => expect(session.deliveredMessages.at(-1)?.text).toContain(HOST_CHANGE_LEAD))
    expect(session.deliveredMessages.at(-1)!.text).toContain('carry on')
    await session.stop()
    await session.finished
  })

  it('mid-turn: delivered in line as a harness message', async () => {
    const ctx = fakeCtx({ autoContinue: false, mcpServers: () => [mcpSpec({ name: 'notes', roles: ['engineer'] })] })
    const session = (await new MockAdapter({ script: { delayMs: 150 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect((session as unknown as { inTurn: boolean }).inTurn).toBe(true))
    await expect(session.hostConfigChanged({ mcp: { upserted: ['notes'], removed: ['old'] } })).resolves.toEqual({ availability: 'now' })
    expect(session.hostNotices[0]!.delivery).toBe('inline')
    const text = session.harnessMessages.at(-1)!
    expect(text).toContain('MCP server notes: Its tool names start with mcp__notes__. Roles that may use it: Engineer (engineer).')
    expect(text).toContain('MCP servers removed or turned off (their tools are refused): old.')
    await session.stop()
    await session.finished
  })

  it('held by an interrupt: kept for the user\'s next message; setup-like and stopped sessions reject', async () => {
    const ctx = fakeCtx({ autoContinue: false })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(idle(ctx)).toBe(true))
    await session.interrupt()
    await session.hostConfigChanged({ roles: { added: [], changed: [], removed: ['r-gone'] } })
    expect(session.hostNotices.at(-1)!.delivery).toBe('held')
    expect(session.hostNotices.at(-1)!.text).toContain('Removed from this run (no new agents of these): r-gone.')
    await session.stop()
    await session.finished
    await expect(session.hostConfigChanged({ skills: true })).rejects.toThrow('ending')
    const setup = (await new MockAdapter({ script: { delayMs: 0 } }).start(fakeCtx({ autoContinue: false, run: runSummary({ kind: 'setup' }) }))) as MockSession
    await expect(setup.hostConfigChanged({ skills: true })).rejects.toThrow('Setup-like')
    await setup.stop()
    await setup.finished
  })
})

describe('mock hostConfigChanged answer markers', () => {
  const idle = (ctx: { events: { type: string; status?: string }[] }) => ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')
  const started = async (prompt: string) => {
    const ctx = fakeCtx({ prompt, autoContinue: false })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(idle(ctx)).toBe(true))
    return { ctx, session }
  }
  const done = async (s: MockSession) => {
    await s.stop()
    await s.finished
  }

  it("[mock:host-after-idle] with [mock:model-switch]: the run idles, the answer is 'after-idle' and the notice waits for the next message", async () => {
    const { session } = await started(`Hi ${MODEL_SWITCH_TOKEN} ${HOST_AFTER_IDLE_TOKEN}`)
    const before = session.harnessMessages.length
    await expect(session.hostConfigChanged({ skills: true })).resolves.toEqual({ availability: 'after-idle' })
    expect(session.configChanges).toEqual([{ skills: true, host: true }])
    expect(session.hostNotices.at(-1)!.delivery).toBe('next-message')
    expect(session.harnessMessages.length).toBe(before)
    await done(session)
  })

  it('[mock:host-after-idle] mid-turn: never in line', async () => {
    const ctx = fakeCtx({ prompt: `Go ${HOST_AFTER_IDLE_TOKEN}`, autoContinue: false })
    const session = (await new MockAdapter({ script: { delayMs: 150 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect((session as unknown as { inTurn: boolean }).inTurn).toBe(true))
    await expect(session.hostConfigChanged({ skills: true })).resolves.toEqual({ availability: 'after-idle' })
    expect(session.hostNotices.at(-1)!.delivery).toBe('next-message')
    await done(session)
  })

  it('[mock:host-slow]: answers only after the host\'s wait (pending first), then the final answer; with after-idle it is after-idle', async () => {
    const { session } = await started(`Hi ${MODEL_SWITCH_TOKEN} ${HOST_SLOW_TOKEN}`)
    expect(MOCK_HOST_SLOW_MS).toBeGreaterThan(LIVE_RUN_CHANGE_WAIT_MS)
    vi.useFakeTimers()
    try {
      let answer: unknown
      const p = session.hostConfigChanged({ skills: true }).then((r) => (answer = r))
      await vi.advanceTimersByTimeAsync(LIVE_RUN_CHANGE_WAIT_MS)
      expect(answer).toBeUndefined()
      expect(session.configChanges).toEqual([])
      await vi.advanceTimersByTimeAsync(MOCK_HOST_SLOW_MS - LIVE_RUN_CHANGE_WAIT_MS)
      await p
      expect(answer).toEqual({ availability: 'now' })
      expect(session.configChanges).toEqual([{ skills: true, host: true }])
    } finally {
      vi.useRealTimers()
    }
    await done(session)
    const both = await started(`Hi ${MODEL_SWITCH_TOKEN} ${HOST_SLOW_TOKEN} ${HOST_AFTER_IDLE_TOKEN}`)
    vi.useFakeTimers()
    try {
      const p = both.session.hostConfigChanged({ skills: true })
      await vi.advanceTimersByTimeAsync(MOCK_HOST_SLOW_MS)
      await expect(p).resolves.toEqual({ availability: 'after-idle' })
    } finally {
      vi.useRealTimers()
    }
    await done(both.session)
  })

  it('[mock:host-reject]: rejects with a short reason and applies nothing', async () => {
    const { session } = await started(`Hi ${MODEL_SWITCH_TOKEN} ${HOST_REJECT_TOKEN}`)
    await expect(session.hostConfigChanged({ skills: true })).rejects.toThrow(MOCK_HOST_REJECT_REASON)
    expect(MOCK_HOST_REJECT_REASON.length).toBeLessThan(120)
    expect(session.configChanges).toEqual([])
    expect(session.hostNotices).toEqual([])
    await done(session)
  })

  it('without a marker the answer stays now', async () => {
    const { session } = await started(`Hi ${MODEL_SWITCH_TOKEN}`)
    await expect(session.hostConfigChanged({ skills: true })).resolves.toEqual({ availability: 'now' })
    await done(session)
  })
})

describe('[mock:config-change] script', () => {
  it('proposes the server and the skill for the root role, then loads the skill', () => {
    const steps = configChangeSteps('lead')
    expect(steps.map((s) => (s.type === 'harness' ? s.name : s.type))).toEqual([MCP_HARNESS_TOOLS.proposeServers, SKILL_ASSIST_HARNESS_TOOLS.propose, SKILL_HARNESS_TOOLS.load, 'text'])
    const [mcp, skill, load, done] = steps
    expect(mcp).toMatchObject({
      args: { title: 'Add mock notes server', rationale: 'Mock config change.', upsert: [{ name: MOCK_CONFIG_SERVER, transport: 'stdio', command: 'npx', args: ['-y', 'mock-fs-server@1.0.0'], roles: ['lead'] }] }
    })
    expect(skill).toMatchObject({
      args: {
        title: 'Add mock skill',
        rationale: 'Mock config change.',
        items: [{ action: 'create', scope: 'project', draft: { name: MOCK_CONFIG_SKILL, description: 'Use for the mock config change.', body: 'Say that the mock config change worked.' }, roles: ['lead'] }]
      }
    })
    expect(load).toMatchObject({ args: { name: MOCK_CONFIG_SKILL } })
    expect(done).toEqual({ type: 'text', text: 'Config change done.' })
  })

  it('runs every step through the work-run tools and finishes the turn', async () => {
    const skills = [{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }] as RunSkill[]
    const ctx = fakeCtx({ prompt: `Change the config ${CONFIG_CHANGE_TOKEN}`, autoContinue: false, skills: () => skills })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    const texts = () => ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
    await vi.waitFor(() => expect(texts()).toContain('Config change done.'))
    const tools = toolNames(session)
    // The work-run root now has every tool the script calls (no unknown-tool warning).
    expect(tools).toEqual(expect.arrayContaining([MCP_HARNESS_TOOLS.proposeServers, SKILL_ASSIST_HARNESS_TOOLS.propose, SKILL_HARNESS_TOOLS.load]))
    const logs = ctx.events.flatMap((e) => (e.type === 'log' && e.level === 'warn' ? [e.message] : []))
    expect(logs.some((m) => m.startsWith('Mock script calls unknown harness tool'))).toBe(false)
    // The default script did not run.
    expect(texts()).not.toContain('Planning the work: I will read the project, delegate the change and review the result.')
    await session.stop()
    await session.finished
  })

  it('leaves the default script alone without the marker', async () => {
    const ctx = fakeCtx({ autoContinue: false })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true))
    expect(session.configChanges).toEqual([])
    const texts = ctx.events.flatMap((e) => (e.type === 'transcript' && e.entry.block.kind === 'text' ? [e.entry.block.text] : []))
    expect(texts).not.toContain('Config change done.')
    await session.stop()
    await session.finished
  })
})
