import { describe, expect, it } from 'vitest'
import { ClaudeSession, buildAgents, buildCompletionOptions } from './claude'
import { fakeCtx, orgChart, project, role } from './testHelpers'

const BAD = ['--dangerous', 'a b', 'x'.repeat(201), '-m', 'a\nb']

describe('model id guard', () => {
  it('buildAgents falls back to inherit for an invalid role model', () => {
    for (const model of BAD) {
      const roles = [role({ id: 'r', slug: 'lead', model })]
      expect(buildAgents(fakeCtx({ project: project({ roles }), roles }), [], false).lead.model).toBe('inherit')
    }
    const roles = [role({ id: 'r', slug: 'lead', model: 'sonnet' })]
    expect(buildAgents(fakeCtx({ project: project({ roles }), roles }), [], false).lead.model).toBe('sonnet')
  })

  it('buildCompletionOptions drops an invalid model and keeps a valid one', () => {
    for (const model of BAD) expect(buildCompletionOptions({ model, system: 's', prompt: 'p', cwd: '/x' } as never).model).toBeUndefined()
    expect(buildCompletionOptions({ model: 'haiku', system: 's', prompt: 'p', cwd: '/x' } as never).model).toBe('haiku')
  })

  type Hook = (i: unknown, id: string, o: unknown) => Promise<Record<string, any>>
  function session() {
    const roles = orgChart()
    const ctx = fakeCtx({ project: project({ roles }), roles })
    return new ClaudeSession(ctx) as unknown as {
      root: { model?: string }
      buildOptions(): Promise<{ model?: string }>
      buildHooks(): { PreToolUse: Array<{ hooks: Hook[] }> }
    }
  }

  it('omits options.model for an invalid root model', async () => {
    const s = session()
    s.root.model = '--dangerous'
    expect((await s.buildOptions()).model).toBeUndefined()
    s.root.model = 'opus'
    expect((await s.buildOptions()).model).toBe('opus')
  })

  it('the spawn hook strips an invalid toolInput.model and keeps a valid one', async () => {
    const s = session()
    const hook = s.buildHooks().PreToolUse[0].hooks[0]
    const run = (model: unknown) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't' + String(model), tool_input: { subagent_type: 'engineer', prompt: 'x', model }, cwd: '/repo' }, 't', { signal: new AbortController().signal })
    for (const bad of ['--dangerous', 'a b', 42, '']) {
      const out = await run(bad)
      expect('model' in out.hookSpecificOutput.updatedInput).toBe(false)
      expect(out.hookSpecificOutput.updatedInput.subagent_type).toBe('engineer')
    }
    const ok = await run('haiku')
    expect(ok.hookSpecificOutput?.updatedInput?.model ?? 'haiku').toBe('haiku')
  })
})
