import { describe, expect, it, vi } from 'vitest'
import { buildAgents } from './claude'
import { todosText } from './prompts'
import { fakeCtx } from './testHelpers'

const todos = { scope: 'chat' as const, list: () => [], add: vi.fn(), setStatus: vi.fn(), update: vi.fn() }

describe('to-dos prompt paragraph (buildAgents)', () => {
  it('the root definition carries todosText() with ctx.todos; reports never do', () => {
    const agents = buildAgents(fakeCtx({ todos }), [], false)
    const roots = Object.values(agents).filter((a) => a.prompt.includes(todosText()))
    expect(roots).toHaveLength(1)
    expect(agents.lead!.prompt).toContain(todosText())
    expect(Object.keys(agents).length).toBeGreaterThan(1)
  })

  it('no paragraph without ctx.todos', () => {
    for (const a of Object.values(buildAgents(fakeCtx({}), [], false))) expect(a.prompt).not.toContain(todosText())
  })

  it('a bridged child session gets no paragraph', () => {
    const ctx = fakeCtx({ todos, bridgedChild: { parentRunId: 'r0', parentRole: 'lead' } as never })
    for (const a of Object.values(buildAgents(ctx, [], false))) expect(a.prompt).not.toContain(todosText())
  })
})
