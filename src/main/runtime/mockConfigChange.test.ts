import { describe, expect, it, vi } from 'vitest'
import { MCP_HARNESS_TOOLS, SKILL_ASSIST_HARNESS_TOOLS, SKILL_HARNESS_TOOLS } from '@shared/types'
import { CONFIG_CHANGE_TOKEN, MOCK_CONFIG_SERVER, MOCK_CONFIG_SKILL, MockAdapter, configChangeSteps, type MockSession } from './mock'
import { ROOT_AGENT_ID, type RunSkill } from './types'
import { fakeCtx } from './testHelpers'

const toolNames = (s: MockSession) => (s as unknown as { tools: { name: string }[] }).tools.map((t) => t.name)

describe('mock configChanged hook', () => {
  it('records each change, answers now, and re-binds the skill tools to the live skills', async () => {
    let skills: RunSkill[] = []
    const ctx = fakeCtx({ autoContinue: false, skills: () => skills })
    const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
    // list_skills / load_skill are bound only when the run has skills; a skills change re-binds them below.
    expect(toolNames(session)).not.toContain(SKILL_HARNESS_TOOLS.load)
    await expect(session.configChanged({ mcp: { upserted: ['notes'], removed: ['old'] } })).resolves.toEqual({ availability: 'now' })
    skills = [{ id: 's1', name: 'alpha', description: 'd', dir: '/nowhere', files: [{ path: 'SKILL.md', bytes: 1 }], roleIds: ['r-lead'] }]
    await expect(session.configChanged({ skills: true })).resolves.toEqual({ availability: 'now' })
    expect(session.configChanges).toEqual([{ mcp: { upserted: ['notes'], removed: ['old'] } }, { skills: true }])
    expect(toolNames(session)).toEqual(expect.arrayContaining([SKILL_HARNESS_TOOLS.list, SKILL_HARNESS_TOOLS.load]))
    await session.stop()
    await session.finished
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
