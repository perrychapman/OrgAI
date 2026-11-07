import { describe, expect, it, vi } from 'vitest'
import type { Role } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { setupTools } from './harnessTools'
import { fakeCtx, project, role } from './testHelpers'
import { toRoles } from '../ai/draft'

const draft = (name: string, reportsTo: string | null, over: Record<string, unknown> = {}) => ({
  name,
  description: `${name} does things`,
  responsibilities: ['x'],
  prompt: `You are ${name}.`,
  tools: ['Read'],
  canSpawn: false,
  spawnable: [] as string[],
  reportsTo,
  ...over
})

const anthropic = { connection: 'anthropic' as const, name: 'Anthropic', tierModels: { deep: 'opus-x', everyday: 'sonnet-x', fast: 'haiku-x' }, models: ['opus-x', 'sonnet-x', 'haiku-x'] }
const openai = { connection: 'openai' as const, name: 'OpenAI', tierModels: { deep: 'gpt-big', everyday: 'gpt-mid', fast: 'gpt-mini' }, models: ['gpt-big', 'gpt-mid', 'gpt-mini'] }

async function propose(p: ReturnType<typeof project>, roles: unknown[]) {
  const ctx = fakeCtx({
    project: p,
    connection: { connection: 'anthropic', tierModels: anthropic.tierModels, models: anthropic.models } as never,
    connectionModels: () => [anthropic, openai]
  })
  const tool = setupTools(ctx).find((t) => t.name === PROPOSAL_TOOLS.orgChart)!
  const text = await tool.call({ title: 'T', rationale: 'r', roles })
  const calls = vi.mocked(ctx.requestProposal).mock.calls
  const out = calls.length ? ((calls[0][0] as { payload: { roles: Role[] } }).payload.roles) : undefined
  return { text, roles: out }
}

describe('propose_org_chart role connections', () => {
  it('maps a draft that names another connection through that connection and stores it', async () => {
    const { roles, text } = await propose(project({ roles: [], setup: { kind: 'new', state: 'in_progress' } as never }), [
      draft('Lead', null, { model: 'deep' }),
      draft('Coder', 'Lead', { model: 'everyday', connection: 'openai' }),
      draft('Scout', 'Lead', { model: 'fast' })
    ])
    expect(text).toMatch(/^APPROVED/)
    const by = (n: string) => roles!.find((r) => r.name === n)!
    expect(by('Lead')).toMatchObject({ model: 'opus-x' })
    expect(by('Lead').connection).toBeUndefined()
    expect(by('Coder')).toMatchObject({ model: 'gpt-mid', tier: 'everyday', connection: 'openai' })
    expect(by('Scout')).toMatchObject({ model: 'haiku-x' })
    expect(by('Scout').connection).toBeUndefined()
  })

  it('omits connection when it equals the run connection and never sets it on the root', async () => {
    const { roles } = await propose(project({ roles: [], setup: { kind: 'new', state: 'in_progress' } as never }), [
      draft('Lead', null, { model: 'deep', connection: 'openai' }),
      draft('Coder', 'Lead', { model: 'everyday', connection: 'anthropic' })
    ])
    expect(roles!.every((r) => r.connection === undefined)).toBe(true)
    expect(roles!.find((r) => r.name === 'Coder')!.model).toBe('sonnet-x')
  })

  it('answers REVISE naming the valid connections for an unknown one', async () => {
    const { text, roles } = await propose(project({ roles: [], setup: { kind: 'new', state: 'in_progress' } as never }), [
      draft('Lead', null),
      draft('Coder', 'Lead', { connection: 'proxy-nope' })
    ])
    expect(roles).toBeUndefined()
    expect(text).toMatch(/^REVISE/)
    expect(text).toContain('anthropic')
    expect(text).toContain('OpenAI')
  })

  it('a draft without connection behaves as before (no connection on any role)', async () => {
    const { roles } = await propose(project({ roles: [], setup: { kind: 'new', state: 'in_progress' } as never }), [draft('Lead', null), draft('Coder', 'Lead')])
    expect(roles!.every((r) => r.connection === undefined)).toBe(true)
  })

  it('revision: an edited role keeps its stored connection and model, or moves when the draft names another', async () => {
    const chart = [
      role({ id: 'r-lead', slug: 'lead', name: 'Lead', model: 'opus-x', tier: 'deep', canSpawn: true, spawnable: ['r-c'] }),
      role({ id: 'r-c', slug: 'coder', name: 'Coder', model: 'gpt-mid', tier: 'everyday', reportsTo: 'r-lead', connection: 'openai' })
    ]
    const p = project({ roles: chart, setup: { kind: 'existing', state: 'complete' } as never })
    const kept = await propose(p, [draft('Coder', 'Lead', { slug: 'coder', prompt: 'New prompt.' })])
    expect(kept.roles!.find((r) => r.slug === 'coder')).toMatchObject({ id: 'r-c', model: 'gpt-mid', tier: 'everyday', connection: 'openai', prompt: 'New prompt.' })
    const moved = await propose(p, [draft('Coder', 'Lead', { slug: 'coder', connection: 'anthropic', model: 'everyday' })])
    const c = moved.roles!.find((r) => r.slug === 'coder')!
    expect(c).toMatchObject({ id: 'r-c', model: 'sonnet-x' })
    expect(c.connection).toBeUndefined()
  })
})

describe('toRoles per-draft contexts', () => {
  it('uses the draft connection context and leaves others on the base', () => {
    const base = { connection: 'anthropic' as const, tierModels: anthropic.tierModels }
    const others = { openai: { connection: 'openai' as const, tierModels: openai.tierModels } }
    const roles = toRoles({ rationale: '', roles: [draft('Lead', null, { model: 'deep' }), draft('X', 'Lead', { model: 'fast', connection: 'openai' })] }, base, others)
    expect(roles[1]).toMatchObject({ model: 'gpt-mini', connection: 'openai' })
    expect(roles[0].model).toBe('opus-x')
  })
})
