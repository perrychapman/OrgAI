import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProjectPeek, TranscriptBlock } from '@shared/types'
import {
  MOCK_SELF_CONFIG_DONE,
  MOCK_SELF_CONFIG_LEFT,
  MOCK_SELF_CONFIG_LOOKUP,
  MOCK_SELF_CONFIG_NO_PROJECT,
  MOCK_SELF_CONFIG_PROJECT_DONE,
  MOCK_SELF_CONFIG_PROJECT_LEFT,
  MOCK_SELF_CONFIG_SAME,
  MockAdapter,
  SELF_CONFIG_PROJECT_TOKEN,
  SELF_CONFIG_TOKEN,
  firstProjectId,
  type MockSession
} from './mock'
import type { RuntimeContext } from './types'
import { fakeCtx, project, runSummary } from './testHelpers'

const quick = { folder: '/some/folder', team: 'single' as const, allowEdits: false, gitRepo: false }
const peek = (id: string): ProjectPeek => ({ id, name: `Project ${id}`, path: `/${id}`, brief: '', roles: [], connection: 'anthropic' })
const settings = (theme: string) => ({ appearance: { theme } }) as unknown as AppSettings

/** A quick-run context with every self-knowledge hook a RunManager would bind; `over` replaces any of them. */
function quickCtx(prompt: string, over: Partial<RuntimeContext> = {}) {
  return fakeCtx({
    run: runSummary({ projectId: 'quick', quick, prompt }),
    prompt,
    // These tests are about the script's tools, not continuation: no harness nudge may add a turn after it goes idle.
    autoContinue: false,
    listProjects: () => [peek('p_first'), peek('p_second')],
    appReference: vi.fn(async () => ({ text: 'Theme: App settings > General > Appearance (app-settings-general-appearance).' })),
    navigate: vi.fn(() => ({ ok: true as const, path: 'App settings > General > Appearance' })),
    appSettings: () => settings('dark'),
    storedProject: (id: string) => (id === 'p_first' ? project({ id: 'p_first', name: 'Project p_first' }) : undefined),
    ...over
  })
}

async function runToIdle(ctx: ReturnType<typeof fakeCtx>, follow?: string): Promise<MockSession> {
  const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
  const idle = () => ctx.events.filter((e) => e.type === 'run.status' && e.status === 'idle').length
  await vi.waitFor(() => expect(idle()).toBeGreaterThanOrEqual(1), { timeout: 3000 })
  if (follow) {
    await session.send(follow)
    await vi.waitFor(() => expect(idle()).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  }
  return session
}

const blocks = (ctx: ReturnType<typeof fakeCtx>): TranscriptBlock[] => ctx.events.flatMap((e) => (e.type === 'transcript' ? [e.entry.block] : []))
const toolCalls = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'tool_use' ? [{ name: b.name, input: b.input }] : []))
const texts = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'text' ? [b.text] : []))
const stopAll = async (s: MockSession): Promise<void> => {
  await s.stop()
  await s.finished
}

describe('mock [mock:self-config]', () => {
  it('looks up the theme, opens Appearance and proposes the light theme through the real tools; APPROVED says done', async () => {
    const ctx = quickCtx(`Make it lighter ${SELF_CONFIG_TOKEN}`)
    const session = await runToIdle(ctx, 'thanks')
    expect(toolCalls(ctx)).toEqual([
      { name: 'app_reference', input: { action: 'locate', query: 'theme' } },
      { name: 'open_in_app', input: { surfaceId: 'app-settings-general-appearance' } },
      {
        name: 'propose_app_settings',
        input: { title: 'Switch to the light theme', rationale: 'You asked for a lighter look.', changes: [{ field: 'appearance.theme', value: 'light' }] }
      }
    ])
    expect(ctx.appReference).toHaveBeenCalledWith({ action: 'locate', query: 'theme' })
    expect(ctx.navigate).toHaveBeenCalledWith({ surfaceId: 'app-settings-general-appearance' }, { agentId: 'root' })
    const proposal = vi.mocked(ctx.requestProposal).mock.calls[0]![0] as { kind: string; payload: { changes: { field: string; from: unknown; to: unknown }[] } }
    expect(proposal.kind).toBe('appSettings')
    expect(proposal.payload.changes).toEqual([expect.objectContaining({ field: 'appearance.theme', from: 'dark', to: 'light' })])
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_LOOKUP, MOCK_SELF_CONFIG_DONE, 'Mock reply to: thanks'])
    expect(session.deliveredMessages[0]!.text).toContain(SELF_CONFIG_TOKEN)
    await stopAll(session)
  })

  it('says the theme is already light when the tool answers "Nothing to change" (no card)', async () => {
    const ctx = quickCtx(SELF_CONFIG_TOKEN, { appSettings: () => settings('light') })
    const session = await runToIdle(ctx)
    expect(ctx.requestProposal).not.toHaveBeenCalled()
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_LOOKUP, MOCK_SELF_CONFIG_SAME])
    await stopAll(session)
  })

  it('leaves the settings alone on REVISE and does not retry the proposal', async () => {
    const ctx = quickCtx(SELF_CONFIG_TOKEN, { requestProposal: vi.fn(async () => ({ behavior: 'revise' as const, feedback: 'not now' })) })
    const session = await runToIdle(ctx)
    expect(ctx.requestProposal).toHaveBeenCalledTimes(1)
    expect(toolCalls(ctx).filter((c) => c.name === 'propose_app_settings')).toHaveLength(1)
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_LOOKUP, MOCK_SELF_CONFIG_LEFT])
    await stopAll(session)
  })

  it('without the self-knowledge hooks the tools answer their unavailable text and the script still ends politely', async () => {
    const ctx = quickCtx(SELF_CONFIG_TOKEN, { appReference: undefined, navigate: undefined, appSettings: undefined })
    const session = await runToIdle(ctx)
    const results = blocks(ctx).flatMap((b) => (b.kind === 'tool_result' ? [b.content] : []))
    expect(results).toEqual(['The OrgAI reference is not available in this run.', 'This run cannot open places in the app.', 'App settings are not available in this run.'])
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_LOOKUP, MOCK_SELF_CONFIG_LEFT])
    expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'error')).toBe(false)
    await stopAll(session)
  })

  it('works on a default-team quick run too', async () => {
    const ctx = quickCtx(SELF_CONFIG_TOKEN, { run: runSummary({ projectId: 'quick', quick: { ...quick, team: 'default' }, prompt: SELF_CONFIG_TOKEN }) })
    const session = await runToIdle(ctx)
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_LOOKUP, MOCK_SELF_CONFIG_DONE])
    await stopAll(session)
  })
})

describe('mock [mock:self-config-project]', () => {
  it("lists projects and proposes a $5 cap for the first one's id; APPROVED says done", async () => {
    const ctx = quickCtx(`Cap it ${SELF_CONFIG_PROJECT_TOKEN}`)
    const session = await runToIdle(ctx)
    expect(toolCalls(ctx)).toEqual([
      { name: 'list_projects', input: {} },
      { name: 'propose_project_settings', input: { title: 'Cap the spend', rationale: 'A small cap for a test project.', maxBudgetUsd: 5, projectId: 'p_first' } }
    ])
    const proposal = vi.mocked(ctx.requestProposal).mock.calls[0]![0] as { kind: string; payload: { maxBudgetUsd?: number }; target?: { projectId: string } }
    expect(proposal.kind).toBe('settings')
    expect(proposal.payload.maxBudgetUsd).toBe(5)
    expect(proposal.target?.projectId).toBe('p_first')
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_PROJECT_DONE])
    await stopAll(session)
  })

  it('leaves the project alone when the user declines', async () => {
    const ctx = quickCtx(SELF_CONFIG_PROJECT_TOKEN, { requestProposal: vi.fn(async () => ({ behavior: 'decline' as const })) })
    const session = await runToIdle(ctx)
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_PROJECT_LEFT])
    await stopAll(session)
  })

  it('says there are no projects when list_projects names none (no proposal)', async () => {
    const ctx = quickCtx(SELF_CONFIG_PROJECT_TOKEN, { listProjects: () => [] })
    const session = await runToIdle(ctx)
    expect(toolCalls(ctx).map((c) => c.name)).toEqual(['list_projects'])
    expect(ctx.requestProposal).not.toHaveBeenCalled()
    expect(texts(ctx)).toEqual([MOCK_SELF_CONFIG_NO_PROJECT])
    await stopAll(session)
  })
})

describe('mock self-config markers on work runs', () => {
  it.each([SELF_CONFIG_TOKEN, SELF_CONFIG_PROJECT_TOKEN])('a work run ignores %s and plays the default script', async (token) => {
    const ctx = quickCtx(token, { run: runSummary({ prompt: token }), autoContinue: false })
    const session = await runToIdle(ctx)
    const names = toolCalls(ctx).map((c) => c.name)
    expect(names).not.toContain('app_reference')
    expect(names).not.toContain('propose_app_settings')
    expect(names).not.toContain('propose_project_settings')
    expect(names).not.toContain('list_projects')
    expect(texts(ctx).at(-1)).toBe('The report finished: src/example.ts was updated. Anything else?')
    await stopAll(session)
  })
})

describe('firstProjectId', () => {
  it('reads the id field of the first line inside <projects>', () => {
    const text = ['2 OrgAI projects.', '<projects>', 'name=A | id=p_a1 | folder=/a', 'name=B | id=p_b | folder=/b', '</projects>'].join('\n')
    expect(firstProjectId(text)).toBe('p_a1')
  })
  it('is undefined without a project line', () => {
    expect(firstProjectId('The user has no OrgAI projects yet.')).toBeUndefined()
    expect(firstProjectId('<projects>\n</projects>')).toBeUndefined()
  })
})
