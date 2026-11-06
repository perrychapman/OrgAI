import { describe, expect, it, vi } from 'vitest'
import { SPAWN_TOOL } from '@shared/types'
import { buildAgents, buildEnv } from './claude'
import { mcpCallDenial } from './mcpGrants'
import { buildRolePrompt } from './prompts'
import { fakeCtx, project, role, runSummary } from './testHelpers'

// buildRolePrompt is the real one, wrapped so tests can read the flags the adapter passes.
vi.mock('./prompts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./prompts')>()
  return { ...orig, buildRolePrompt: vi.fn(orig.buildRolePrompt) }
})

const assistant = () => role({ id: 'r-a', slug: 'assistant', name: 'Assistant', tools: ['Read', 'Edit', 'Bash'] })
const singleCtx = () => {
  const roles = [assistant()]
  return fakeCtx({ run: runSummary({ team: 'single' }), project: project({ roles }), roles })
}

describe('Claude adapter: single-agent work runs (team single)', () => {
  it('passes the team flag into the role prompt, and omits it on a team run', () => {
    vi.mocked(buildRolePrompt).mockClear()
    buildAgents(singleCtx(), [], false)
    expect(vi.mocked(buildRolePrompt).mock.calls.at(-1)![3]).toMatchObject({ team: 'single' })
    vi.mocked(buildRolePrompt).mockClear()
    buildAgents(fakeCtx(), [], false)
    for (const call of vi.mocked(buildRolePrompt).mock.calls) expect('team' in call[3]!).toBe(false)
  })

  it('gives the single root no Agent tool and no messaging tools; built-in agents stay disabled', () => {
    const ctx = singleCtx()
    const agents = buildAgents(ctx, [{ name: 'set_plan', audience: 'root' }, { name: 'engagement_context', audience: 'all' }], false)
    expect(Object.keys(agents)).toEqual(['assistant'])
    expect(agents.assistant.tools).not.toContain(SPAWN_TOOL)
    expect(agents.assistant.tools).not.toContain('SendMessage')
    expect(agents.assistant.tools).not.toContain('ListAgents')
    expect(agents.assistant.tools).toEqual(expect.arrayContaining(['mcp__orgai__set_plan', 'mcp__orgai__engagement_context']))
    expect(buildEnv(ctx, {}).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1')
  })

  it("exposes an 'all'-audience harness tool (engagement_context) to every report, and root-only tools to the root only", () => {
    const agents = buildAgents(fakeCtx(), [
      { name: 'set_plan', audience: 'root' },
      { name: 'engagement_context', audience: 'all' }
    ], false)
    for (const slug of ['lead', 'engineer', 'reviewer']) expect(agents[slug]!.tools).toContain('mcp__orgai__engagement_context')
    expect(agents.engineer.tools).not.toContain('mcp__orgai__set_plan')
    expect(agents.reviewer.tools).not.toContain('mcp__orgai__set_plan')
  })

  it('lets a report through the PreToolUse audience gate for an all-audience tool', () => {
    const audiences = new Map([['engagement_context', 'all' as const], ['set_plan', 'root' as const]])
    const engineer = fakeCtx().roles.find((r) => r.slug === 'engineer')
    expect(mcpCallDenial('mcp__orgai__engagement_context', { role: engineer, isRoot: false }, [], audiences, {})).toBeUndefined()
    expect(mcpCallDenial('mcp__orgai__set_plan', { role: engineer, isRoot: false }, [], audiences, {})).toContain('not available')
  })
})
