import { afterEach, describe, expect, it } from 'vitest'
import { defaultConnections } from '../../shared/defaults'
import type { ConnectionInfo, HostScope, Project, ProviderConnection, ProviderModel } from '../../shared/types'
import { fakeContext, FakeHostClient, project } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { affectedRoles, closeModelIds, parseTierPairs, runConnections, tierDeps, tierRows } from './connections'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realSuggest = tierDeps.suggest
afterEach(() => {
  tierDeps.suggest = realSuggest
})

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source: 'discovered', ...extra })
const CATALOG = [model('claude-opus-4-1', { contextWindow: 200_000 }), model('claude-sonnet-4-5', { contextWindow: 1_000_000 }), model('opus', { source: 'builtin' }), model('haiku', { source: 'builtin' })]

function anthropic(tierModels: ProviderConnection['tierModels'], autoTiers?: ProviderConnection['autoTiers']): ProviderConnection {
  return { ...defaultConnections().anthropic, tierModels, ...(autoTiers ? { autoTiers } : {}) } as ProviderConnection
}
const info = (c: ProviderConnection): ConnectionInfo => ({ connection: c, status: { state: 'connected' }, modelCount: CATALOG.length, isDefault: true })

const APP: Project = project('p1', '/w/app', {
  name: 'App',
  roles: [
    { id: 'r1', name: 'Lead', tier: 'deep', model: 'opus', reportsTo: null },
    { id: 'r2', name: 'Coder', tier: 'deep', model: 'claude-sonnet-4-5', reportsTo: 'r1' },
    { id: 'r3', name: 'Helper', tier: 'fast', model: 'haiku', reportsTo: 'r1' }
  ] as unknown as Project['roles']
})

function setup(conn: ProviderConnection, opts: { json?: boolean; onUpdate?: (client: FakeHostClient, c: ProviderConnection) => void } = {}) {
  const client: FakeHostClient = new FakeHostClient(
    {
      'host.subscribe': (p) => ({ topics: (p as [{ topics: string[] }])[0].topics }),
      'connections:list': () => [info(conn)],
      'models:list': () => CATALOG,
      'projects:list': () => [APP],
      'connections:update': (p) => {
        const c = (p as [ProviderConnection])[0]
        opts.onUpdate?.(client, c)
        return info(c)
      }
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], ...(opts.json ? { globals: { outputFormat: 'json' } } : {}) })
  return { client, f }
}

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  try {
    return await runConnections(f.ctx, ['tier', ...args])
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('connections tier: helpers', () => {
  it('parses <tier>=<model> pairs and refuses junk', () => {
    expect(parseTierPairs(['deep=claude-opus-4-1', 'fast=haiku'])).toEqual({ deep: 'claude-opus-4-1', fast: 'haiku' })
    expect(() => parseTierPairs(['huge=opus'])).toThrow(/tiers are top, deep, everyday, fast/)
    expect(() => parseTierPairs(['deep'])).toThrow(/Give the model for deep/)
    expect(() => parseTierPairs(['deep=a b'])).toThrow(/not a model id/)
    expect(() => parseTierPairs(['deep=a', 'deep=b'])).toThrow(/given twice/)
  })

  it('lists close matches, substrings first', () => {
    expect(closeModelIds('opus-4-1', CATALOG.map((m) => m.id))).toEqual(['claude-opus-4-1', 'opus'])
    expect(closeModelIds('claude-sonet-4-5', CATALOG.map((m) => m.id))[0]).toBe('claude-sonnet-4-5')
    expect(closeModelIds('gpt-9', CATALOG.map((m) => m.id))).toEqual([])
  })

  it('tierRows marks unmapped tiers and catalog facts', () => {
    const rows = tierRows(anthropic({ deep: 'claude-opus-4-1', fast: 'gone-model' }, ['deep']), CATALOG)
    expect(rows.map((r) => [r.tier, r.model])).toEqual([['top', null], ['deep', 'claude-opus-4-1'], ['everyday', null], ['fast', 'gone-model']])
    expect(rows[1]).toMatchObject({ automatic: true, inCatalog: true, source: 'discovered', contextWindow: 200_000 })
    expect(rows[3]).toMatchObject({ inCatalog: false, source: null })
  })

  it('affectedRoles: only roles on the connection whose tier changed; remapped or kept', () => {
    const rows = affectedRoles([APP], 'anthropic', ['deep'], new Map([['p1', [{ roleId: 'r1', from: 'opus', to: 'claude-opus-4-1' }]]]))
    expect(rows.map((r) => [r.roleName, r.outcome, r.to])).toEqual([['Lead', 'remapped', 'claude-opus-4-1'], ['Coder', 'kept', 'claude-sonnet-4-5']])
    expect(affectedRoles([APP], 'openai', ['deep'], new Map())).toEqual([])
  })
})

describe('connections tier <id>', () => {
  it('shows every tier, unmapped ones included, under read scope', async () => {
    const { f } = setup(anthropic({ deep: 'claude-opus-4-1', everyday: 'claude-sonnet-4-5' }, ['deep']))
    expect(await run(f, ['anthropic'])).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read'])
    const out = f.out()
    expect(out).toMatch(/top\s+unmapped/)
    expect(out).toMatch(/deep\s+claude-opus-4-1\s+\(discovered, 200k context, automatic\)/)
    expect(out).toMatch(/everyday\s+claude-sonnet-4-5\s+\(discovered, 1M context\)/)
    expect(out).toMatch(/fast\s+unmapped/)
  })

  it('JSON carries four rows', async () => {
    const { f } = setup(anthropic({ fast: 'haiku' }), { json: true })
    expect(await run(f, ['anthropic'])).toBe(0)
    const j = JSON.parse(f.out())
    expect(j.tiers).toHaveLength(4)
    expect(j.tiers[3]).toMatchObject({ tier: 'fast', model: 'haiku', source: 'builtin', contextWindow: null })
    expect(j.tiers[0]).toMatchObject({ tier: 'top', model: null })
  })

  it('refuses a model not in the catalog with close matches, before any update', async () => {
    const { f, client } = setup(anthropic({}))
    expect(await run(f, ['anthropic', 'deep=claude-opus-4'])).toBe(EXIT.usage)
    expect(f.err()).toContain("claude-opus-4 (deep) is not in Anthropic's catalog. Close matches: claude-opus-4-1")
    expect(client.callsOf('connections:update')).toEqual([])
  })

  it('sets tiers through connections:update and prints the roles the host remapped', async () => {
    const { f, client } = setup(anthropic({ deep: 'opus', fast: 'haiku' }), {
      onUpdate: (c) => {
        void c
        client.push('connections:event', { type: 'projects.remapped', results: [{ projectId: 'p1', connection: 'anthropic', reason: 'tierModels', changes: [{ roleId: 'r1', from: 'opus', to: 'claude-opus-4-1' }] }] })
      }
    })
    expect(await run(f, ['anthropic', 'deep=claude-opus-4-1'])).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    const sent = client.callsOf('connections:update')[0] as [ProviderConnection]
    expect(sent[0].tierModels).toEqual({ deep: 'claude-opus-4-1', fast: 'haiku' })
    expect(client.calls.findIndex((c) => c.method === 'host.subscribe')).toBeLessThan(client.calls.findIndex((c) => c.method === 'connections:update'))
    const out = f.out()
    expect(out).toContain('deep: opus -> claude-opus-4-1')
    expect(out).toContain('App / Lead (deep): opus -> claude-opus-4-1')
    expect(out).toContain('App / Coder (deep): kept claude-sonnet-4-5 (picked by hand)')
    expect(out).not.toContain('Helper')
  })

  it('--force sends an id outside the catalog and says so', async () => {
    const { f, client } = setup(anthropic({}), { json: true })
    expect(await run(f, ['anthropic', 'top=claude-next', '--force'])).toBe(0)
    expect((client.callsOf('connections:update')[0] as [ProviderConnection])[0].tierModels).toEqual({ top: 'claude-next' })
    const j = JSON.parse(f.out())
    expect(j.applied).toBe(true)
    expect(j.notes[0]).toContain('claude-next')
    expect(j.changes).toEqual([{ tier: 'top', from: null, to: 'claude-next' }])
  })

  it("--reset puts a tier back on discovery's choice", async () => {
    tierDeps.suggest = () => ({ deep: 'claude-opus-4-1', fast: 'haiku' })
    const { f, client } = setup(anthropic({ deep: 'opus', fast: 'claude-sonnet-4-5' }))
    expect(await run(f, ['anthropic', '--reset', 'fast'])).toBe(0)
    expect((client.callsOf('connections:update')[0] as [ProviderConnection])[0].tierModels).toEqual({ deep: 'opus', fast: 'haiku' })
    expect(f.out()).toContain('fast: claude-sonnet-4-5 -> haiku')
  })

  it('--reset of a tier discovery leaves empty unmaps it and says so', async () => {
    tierDeps.suggest = () => ({})
    const { f, client } = setup(anthropic({ top: 'opus' }))
    expect(await run(f, ['anthropic', '--reset', 'top'])).toBe(0)
    expect((client.callsOf('connections:update')[0] as [ProviderConnection])[0].tierModels).toEqual({})
    expect(f.out()).toContain('Discovery has no model for top; it is left unmapped.')
  })

  it('no change sends nothing', async () => {
    const { f, client } = setup(anthropic({ deep: 'opus' }))
    expect(await run(f, ['anthropic', 'deep=opus'])).toBe(0)
    expect(client.callsOf('connections:update')).toEqual([])
    expect(f.out()).toContain('no tier changes')
  })

  it('--dry-run previews with the host remap function under read scope and saves nothing', async () => {
    const { f, client } = setup(anthropic({ deep: 'opus' }))
    expect(await run(f, ['anthropic', 'deep=claude-opus-4-1', '--dry-run'])).toBe(0)
    expect(f.connectCalls[0].scopes).toEqual(['read'])
    expect(client.callsOf('connections:update')).toEqual([])
    expect(f.out()).toContain('App / Lead (deep): opus -> claude-opus-4-1')
    expect(f.out()).toContain('App / Coder (deep): kept claude-sonnet-4-5')
    expect(f.out()).toContain('Nothing was saved.')
  })

  it('usage errors: bad connection, set and reset of one tier, --force alone', async () => {
    const a = setup(anthropic({}))
    expect(await run(a.f, ['nope'])).toBe(EXIT.usage)
    expect(await run(a.f, ['anthropic', 'deep=opus', '--reset', 'deep'])).toBe(EXIT.usage)
    expect(await run(a.f, ['anthropic', '--reset', 'huge'])).toBe(EXIT.usage)
    expect(await run(a.f, ['anthropic', '--force'])).toBe(EXIT.usage)
    expect(a.f.connectCalls).toEqual([])
  })
})
