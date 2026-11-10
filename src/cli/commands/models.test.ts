import { afterEach, describe, expect, it } from 'vitest'
import { defaultConnections } from '../../shared/defaults'
import type { ConnectionInfo, HostScope, ModelPriceInfo, ProviderConnection, ProviderModel } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { contextText, parsePerMTok, perMTokText, priceForModel, priceText, runModels, tiersOf } from './models'

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
  const lite = { id: 'litellm', name: 'LiteLLM', kind: 'litellm', enabled: false, anthropicBaseUrl: '', hasApiKey: false, tierModels: {}, autoTiers: [] }
  const records: Record<string, unknown> = { anthropic: c.anthropic, openai: c.openai, litellm: lite }
  return (['anthropic', 'openai', 'litellm'] as const).map((id) => ({ connection: { ...(records[id] as object), ...(id === 'anthropic' ? { tierModels: { deep: 'opus-x', everyday: 'sonnet-x' } } : {}) } as ProviderConnection, status: { state: 'connected' }, modelCount: 1, isDefault: id === 'anthropic' }))
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
    expect(f.out()).toMatch(/opus-x\s+Anthropic\s+deep\s+builtin\s+unknown\s+\$15\.00 \/ \$75\.00/)
    expect(f.out()).toMatch(/mystery\s+Anthropic\s+builtin\s+unknown\s+unknown/)
    expect(f.out()).toContain('CONTEXT')
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

describe('models refresh', () => {
  it('calls models:refresh with no query (every connection) or { connection } and counts per connection', async () => {
    const { f, client } = setup({ 'models:refresh': () => [model('a'), model('b'), model('g', { connection: 'openai' })] })
    expect(await run(f, ['refresh'])).toBe(0)
    expect(client.callsOf('models:refresh')).toEqual([[]])
    expect(client.timeouts.find((t) => t.method === 'models:refresh')?.timeoutMs).toBe(120_000)
    expect(f.out()).toContain('Anthropic: 2 models')
    expect(f.out()).toContain('OpenAI: 1 model')
    const g = setup({ 'models:refresh': () => [] }, { globals: { outputFormat: 'json' } })
    expect(await run(g.f, ['refresh', '--connection', 'openai'])).toBe(0)
    expect(g.client.callsOf('models:refresh')).toEqual([[{ connection: 'openai' }]])
    expect(JSON.parse(g.f.out())).toMatchObject({ counts: {}, models: [] })
    expect(await run(setup({}).f, ['refresh', '--connection', 'bedrock'])).toBe(EXIT.usage)
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

describe('contextText', () => {
  it('formats tokens; unknown is never 0', () => {
    expect(contextText(200_000)).toBe('200k')
    expect(contextText(1_000_000)).toBe('1M')
    expect(contextText(undefined)).toBe('unknown')
    expect(contextText(0)).toBe('unknown')
  })
})

describe('models resolve', () => {
  const rp = project('p1', '/work', {
    name: 'App',
    provider: { id: 'claude', connection: 'anthropic' } as never,
    roles: [
      { id: 'r1', name: 'Lead', reportsTo: null, model: 'opus-x', tier: 'deep' },
      { id: 'r2', name: 'Scout', reportsTo: 'r1', model: 'haiku-y', tier: 'fast' },
      { id: 'r3', name: 'Inh', reportsTo: 'r1', model: 'inherit' }
    ] as never
  })
  const catalog = [model('opus-x', { source: 'discovered', contextWindow: 1_000_000, tier: 'deep' }), model('sonnet-x', { source: 'builtin', tier: 'everyday' })]

  it('shows each tier with fallback, source and context, then each role', async () => {
    const { f, client } = setup({ 'projects:list': () => [rp], 'connections:list': conns, 'models:list': () => catalog })
    expect(await run(f, ['resolve'])).toBe(0)
    const out = f.out()
    expect(out).toMatch(/deep\s+opus-x\s+none\s+discovered\s+1M/)
    expect(out).toMatch(/everyday\s+sonnet-x\s+none\s+builtin/)
    expect(out).toMatch(/top\s+opus-x\s+deep \(unmapped\)/)
    expect(out).toMatch(/fast\s+sonnet-x\s+everyday \(unmapped\)/)
    expect(out).toMatch(/Lead\s+Anthropic\s+deep\s+opus-x/)
    expect(out).toMatch(/Inh\s+Anthropic\s+inherit/)
    expect(client.callsOf('connections:list')).toHaveLength(1)
    expect(f.connectCalls[0].scopes).toEqual(['read'])
  })

  it('json carries the same facts', async () => {
    const { f } = setup({ 'projects:list': () => [rp], 'connections:list': conns, 'models:list': () => catalog }, { globals: { outputFormat: 'json' } })
    expect(await run(f, ['resolve'])).toBe(0)
    const j = JSON.parse(f.out())
    expect(j.tiers.find((t: { tier: string }) => t.tier === 'top')).toMatchObject({ model: 'opus-x', fallbackTier: 'deep', via: 'mapped', source: 'discovered', contextWindow: 1_000_000 })
    expect(j.roles.find((r: { roleId: string }) => r.roleId === 'r2')).toMatchObject({ model: 'sonnet-x', fallbackTier: 'everyday', via: 'mapped' })
  })
})

describe('models prices set / unset', () => {
  it('parsePerMTok validates', () => {
    expect(parsePerMTok('3', 'input')).toBe(3e-6)
    expect(parsePerMTok(undefined, 'input')).toBeUndefined()
    for (const bad of ['-1', 'abc', '1e3', '', '999999']) expect(() => parsePerMTok(bad, 'input')).toThrow(CliError)
  })

  it('set writes the override through settings:set (configure) and replaces a same-key entry', async () => {
    const existing = [{ model: 'gpt-x', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } }, { model: 'other', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } }]
    const { f, client } = setup({ 'settings:get': () => ({ modelPrices: existing }), 'settings:set': () => ({}) })
    expect(await run(f, ['prices', 'set', 'GPT-X-20250101', '--input', '3', '--output', '15', '--cache-read', '0.3'])).toBe(0)
    const [patch] = client.callsOf('settings:set')[0] as [{ modelPrices: unknown[] }]
    expect(patch.modelPrices).toHaveLength(2)
    expect(patch.modelPrices[1]).toEqual({ model: 'GPT-X-20250101', price: { inputPerToken: 3e-6, outputPerToken: 15e-6, cacheReadPerToken: 3e-7 } })
    expect(f.out()).toContain('Updated the price of GPT-X-20250101 on every connection: $3.00 / $15.00')
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('set --connection scopes it; missing or bad numbers are usage errors and write nothing', async () => {
    const { f, client } = setup({ 'settings:get': () => ({}), 'settings:set': () => ({}) })
    expect(await run(f, ['prices', 'set', 'm', '--input', '1', '--output', '2', '--connection', 'openai'])).toBe(0)
    expect((client.callsOf('settings:set')[0] as [{ modelPrices: unknown[] }])[0].modelPrices).toEqual([{ model: 'm', connection: 'openai', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } }])
    for (const args of [['prices', 'set', 'm', '--input', '1'], ['prices', 'set', '--input', '1', '--output', '2'], ['prices', 'set', 'm', '--input', 'x', '--output', '2']]) {
      const g = setup({})
      expect(await run(g.f, args)).toBe(EXIT.usage)
      expect(g.client.callsOf('settings:set')).toEqual([])
    }
  })

  it('unset removes the matching override; none matching is exit 1 and writes nothing', async () => {
    const list = [{ model: 'm', connection: 'openai', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } }, { model: 'm', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 } }]
    const { f, client } = setup({ 'settings:get': () => ({ modelPrices: list }), 'settings:set': () => ({}) })
    expect(await run(f, ['prices', 'unset', 'm', '--connection', 'openai'])).toBe(0)
    expect((client.callsOf('settings:set')[0] as [{ modelPrices: unknown[] }])[0].modelPrices).toEqual([list[1]])
    const g = setup({ 'settings:get': () => ({ modelPrices: [] }), 'settings:set': () => ({}) })
    expect(await run(g.f, ['prices', 'unset', 'm'])).toBe(1)
    expect(g.client.callsOf('settings:set')).toEqual([])
  })
})

describe('connection display names', () => {
  it('nameFrom uses a proxy\'s own name and the built-in labels otherwise', async () => {
    const { nameFrom } = await import('./models')
    const label = nameFrom([{ connection: { id: 'proxy-1a2b3c4d', name: 'Corp\x1b[31m Gateway' } }, { connection: { id: 'anthropic' } }])
    expect(label('proxy-1a2b3c4d')).toBe('Corp Gateway')
    expect(label('anthropic')).toBe('Anthropic')
    expect(label('openai')).toBe('OpenAI')
    expect(label('mystery')).toBe('mystery')
    expect(nameFrom(undefined)('litellm')).toBe('LiteLLM')
  })
})
