import { afterEach, describe, expect, it } from 'vitest'
import { defaultConnections } from '../../shared/defaults'
import type { ConnectionInfo, HostScope, ModelPriceInfo, ProviderConnection, ProviderModel } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { perMTokText, priceForModel, priceText, runModels, tiersOf } from './models'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => Object.assign(manageDeps, realDeps))

const clients = new WeakMap<object, FakeHostClient>()
function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient(answers, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  clients.set(f, client)
  return { client, f }
}
async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  const c = clients.get(f)
  if (c) c.closed = false
  try {
    return await runModels(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'builtin', ...extra })
const conns = (): ConnectionInfo[] => {
  const c = defaultConnections()
  return (['anthropic', 'openai', 'litellm'] as const).map((id) => ({ connection: { ...c[id], ...(id === 'anthropic' ? { tierModels: { deep: 'opus-x', everyday: 'sonnet-x' } } : {}) } as ProviderConnection, status: { state: 'connected' }, modelCount: 1, isDefault: id === 'anthropic' }))
}

describe('price formatting', () => {
  it('unknown is never $0; a free model is a known $0.00', () => {
    expect(perMTokText(undefined)).toBe('unknown')
    expect(perMTokText(null)).toBe('unknown')
    expect(perMTokText(0)).toBe('$0.00')
    expect(perMTokText(3e-6)).toBe('$3.00')
    expect(priceText(undefined)).toBe('unknown')
    expect(priceText({ inputPerToken: 3e-6, outputPerToken: 15e-6 })).toBe('$3.00 / $15.00')
  })

  it('priceForModel: override beats the proxy price, which beats builtin rows', () => {
    const rows: ModelPriceInfo[] = [
      { model: 'm', source: 'builtin', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } },
      { model: 'm', source: 'override', connection: 'openai', price: { inputPerToken: 9e-6, outputPerToken: 9e-6 } }
    ]
    expect(priceForModel(model('m'), rows).source).toBe('builtin')
    expect(priceForModel(model('m', { price: { inputPerToken: 5e-6, outputPerToken: 5e-6 } }), rows).source).toBe('proxy')
    expect(priceForModel(model('m', { connection: 'openai' }), rows).source).toBe('override')
    expect(priceForModel(model('other'), rows)).toEqual({})
    expect(tiersOf('opus-x', { deep: 'opus-x', top: 'opus-x' })).toEqual(['top', 'deep'])
  })
})

describe('models list', () => {
  it('shows tiers and prices; unknown price reads unknown', async () => {
    const { f, client } = setup({
      'models:list': () => [model('opus-x'), model('mystery')],
      'connections:list': conns,
      'models:prices': () => [{ model: 'opus-x', source: 'builtin', price: { inputPerToken: 15e-6, outputPerToken: 75e-6 } }]
    })
    expect(await run(f, ['list'])).toBe(0)
    expect(f.out()).toMatch(/opus-x\s+anthropic\s+deep\s+\$15\.00 \/ \$75\.00/)
    expect(f.out()).toMatch(/mystery\s+anthropic\s+unknown/)
    expect(f.out()).not.toContain('$0')
    expect(client.callsOf('models:list')).toEqual([[]])
  })

  it('--connection passes the query; json carries price null for unknown', async () => {
    const { f, client } = setup({ 'models:list': () => [model('gpt-x', { connection: 'openai' })], 'connections:list': conns, 'models:prices': () => [] }, { globals: { outputFormat: 'json' } })
    expect(await run(f, ['list', '--connection', 'openai'])).toBe(0)
    expect(client.callsOf('models:list')).toEqual([[{ connection: 'openai' }]])
    expect(JSON.parse(f.out()).models[0]).toMatchObject({ id: 'gpt-x', price: null, tiers: [] })
    const g = setup({})
    expect(await run(g.f, ['list', '--connection', 'gemini'])).toBe(EXIT.usage)
  })
})

describe('models prices', () => {
  it('formats every row per MTok and says when no overrides exist', async () => {
    const { f } = setup({ 'models:prices': () => [{ model: 'opus-x', source: 'builtin', price: { inputPerToken: 15e-6, outputPerToken: 75e-6, cacheReadPerToken: 1.5e-6 } }] })
    expect(await run(f, ['prices'])).toBe(0)
    expect(f.out()).toMatch(/opus-x\s+all\s+builtin\s+\$15\.00\s+\$75\.00\s+\$1\.50\s+\$15\.00/)
    expect(f.out()).toContain('No price overrides are set.')
  })

  it('--model with no row: the cost reads unknown', async () => {
    const { f } = setup({ 'models:prices': () => [] })
    expect(await run(f, ['prices', '--model', 'local-llm'])).toBe(0)
    expect(f.out()).toContain('No price is known for local-llm; its cost reads unknown.')
  })
})

describe('models remap', () => {
  const p = project('p1', '/work', { name: 'App', roles: [{ id: 'r1', name: 'Coder' }] as never })
  const preview = { projectId: 'p1', connection: 'openai', reason: 'switched', changes: [{ roleId: 'r1', from: 'sonnet', to: 'gpt-5' }] }

  it('previews without --apply (read scope, nothing saved)', async () => {
    const { f, client } = setup({ 'projects:list': () => [p], 'projects:previewRemap': () => preview })
    expect(await run(f, ['remap', '--to', 'openai'])).toBe(0)
    expect(f.out()).toContain('Coder: sonnet -> gpt-5')
    expect(f.out()).toContain('--apply')
    expect(client.callsOf('projects:previewRemap')).toEqual([[{ projectId: 'p1', connection: 'openai' }]])
    expect(client.callsOf('projects:remapModels')).toEqual([])
    expect(f.connectCalls[0].scopes).toEqual(['read'])
  })

  it('--apply asks, then saves (configure); a no is exit 1', async () => {
    const answers = { 'projects:list': () => [p], 'projects:previewRemap': () => preview, 'projects:remapModels': () => ({ result: preview, project: p }) }
    manageDeps.ttyConfirm = async () => false
    const no = setup(answers, { stdinIsTTY: true })
    ;(no.f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
    expect(await run(no.f, ['remap', '--to', 'openai', '--apply'])).toBe(1)
    expect(no.client.callsOf('projects:remapModels')).toEqual([])

    manageDeps.ttyConfirm = async () => true
    const yes = setup(answers, { stdinIsTTY: true })
    ;(yes.f.ctx.io.stdout as { isTTY?: boolean }).isTTY = true
    expect(await run(yes.f, ['remap', '--to', 'openai', '--apply'])).toBe(0)
    expect(yes.client.callsOf('projects:remapModels')).toEqual([[{ projectId: 'p1', connection: 'openai' }]])
    expect(yes.f.connectCalls[0].scopes).toEqual(['read', 'configure'])

    const flag = setup(answers)
    expect(await run(flag.f, ['remap', '--apply', '--yes'])).toBe(0)
    expect(flag.client.callsOf('projects:remapModels')).toEqual([[{ projectId: 'p1' }]])
    expect(await run(flag.f, ['remap', '--yes'])).toBe(EXIT.usage)
  })
})
