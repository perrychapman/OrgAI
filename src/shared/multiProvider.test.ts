import { describe, expect, it } from 'vitest'
import { adapterForProject, defaultConnections, mixedFamilyRefusal, roleConnection, roleConnectionProblems, roleTierContext, type ConnectionsView } from './defaults'
import type { ProviderModel, Role, Project, ProxyConnection } from './types'

const role = (id: string, over: Partial<Role> = {}): Role => ({
  id,
  slug: id,
  name: id,
  description: '',
  responsibilities: [],
  prompt: '',
  tools: ['Read'],
  model: 'inherit',
  canSpawn: false,
  spawnable: [],
  reportsTo: 'root',
  position: { x: 0, y: 0 },
  color: '#fff',
  ...over
})
const root = (over: Partial<Role> = {}): Role => role('root', { reportsTo: null, ...over })
const PROXY = 'proxy-0123abcd'
const prov = (connection: string, id: 'claude' | 'codex' | 'mock' = 'claude'): Project['provider'] => ({ id, label: 'x', auth: { kind: 'subscription' }, connection })
const model = (id: string, connection: string, family: ProviderModel['family']): ProviderModel => ({ id, label: id, connection, family, adapter: family === 'claude' ? 'claude' : 'codex', source: 'discovered' })
const proxy = (over: Partial<ProxyConnection> = {}): ProxyConnection => ({ id: PROXY, name: 'Gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://gw.example.com', enabled: true, hasApiKey: true, tierModels: { everyday: 'gw/mid' }, ...over })
const view = (proxies: ProxyConnection[] = [proxy()], openai = true): ConnectionsView => {
  const connections = defaultConnections()
  connections.openai = { ...connections.openai, enabled: openai }
  return { connections, proxies }
}

describe('roleConnection', () => {
  it('uses the role connection, ignores it on the root and falls back to the project', () => {
    const p = { provider: prov('anthropic') }
    expect(roleConnection(role('a', { connection: 'openai' }), p)).toBe('openai')
    expect(roleConnection(role('b'), p)).toBe('anthropic')
    expect(roleConnection(root({ connection: 'openai' }), p)).toBe('anthropic')
    expect(roleConnection(role('c', { connection: '--x' as never }), p)).toBe('anthropic')
  })
})

describe('adapterForProject with bridged roles', () => {
  const catalog = [model('team-claude', PROXY, 'claude'), model('team-gpt', PROXY, 'openai'), model('gpt-5', 'openai', 'openai')]

  it('bridges a role on another connection with that connection adapter', () => {
    const choice = adapterForProject({ provider: prov('anthropic'), roles: [root({ model: 'sonnet' }), role('a', { model: 'gpt-5', connection: 'openai' })] }, catalog)
    expect(choice.adapter).toBe('claude')
    expect(choice.mismatched).toEqual([])
    expect(choice.bridged).toEqual([{ roleId: 'a', connection: 'openai', adapter: 'codex' }])
  })

  it('a proxy role of the other family is mismatched and bridged on its own connection', () => {
    const choice = adapterForProject({ provider: prov(PROXY, 'codex'), roles: [root({ model: 'team-gpt' }), role('a', { model: 'team-claude' })] }, catalog)
    expect(choice).toMatchObject({ adapter: 'codex', family: 'openai', mismatched: ['a'], bridged: [{ roleId: 'a', connection: PROXY, adapter: 'claude' }] })
    expect(mixedFamilyRefusal(choice)).toBeNull()
  })

  it('a built-in connection with a role of another family stays refused', () => {
    const choice = adapterForProject({ provider: prov('anthropic'), roles: [root({ model: 'sonnet' }), role('a', { model: 'team-gpt' })] }, [model('team-gpt', 'anthropic', 'openai')])
    expect(choice.mismatched).toEqual(['a'])
    expect(choice.bridged).toEqual([])
    expect(mixedFamilyRefusal(choice)).toBe('single-family-connection')
  })

  it('a proxy root with no family and mismatched roles is refused', () => {
    const choice = adapterForProject({ provider: prov(PROXY), roles: [root(), role('a', { model: 'team-gpt' })] }, catalog)
    expect(mixedFamilyRefusal(choice)).toBe('no-root-family')
  })

  it('a mock project runs on mock with nothing mismatched and bridges roles on other connections', () => {
    const choice = adapterForProject({ provider: prov('anthropic', 'mock'), roles: [root({ model: 'sonnet' }), role('a', { model: 'gpt-5', connection: 'openai' }), role('b', { model: 'sonnet' })] }, catalog)
    expect(choice).toMatchObject({ adapter: 'mock', mismatched: [], bridged: [{ roleId: 'a', connection: 'openai', adapter: 'mock' }] })
  })

  it('no bridged roles on a plain project', () => {
    expect(adapterForProject({ provider: prov('anthropic'), roles: [root({ model: 'sonnet' }), role('a', { model: 'haiku' })] }, []).bridged).toEqual([])
  })
})

describe('roleConnectionProblems', () => {
  const p = (connection: string | undefined): Pick<Project, 'provider' | 'roles'> => ({ provider: prov('anthropic'), roles: [root(), role('a', { connection })] })

  it('lists nothing for roles on the project connection and for mock projects', () => {
    expect(roleConnectionProblems(p(undefined), view())).toEqual([])
    expect(roleConnectionProblems({ provider: prov('anthropic', 'mock'), roles: [root(), role('a', { connection: 'openai' })] }, view())).toEqual([])
  })

  it('reports unknown, not-configured and disconnected connections', () => {
    expect(roleConnectionProblems(p('proxy-ffffffff'), view())).toMatchObject([{ roleId: 'a', connection: 'proxy-ffffffff', problem: 'unknown' }])
    expect(roleConnectionProblems(p('openai'), view([], false))).toMatchObject([{ problem: 'not-configured' }])
    expect(roleConnectionProblems(p(PROXY), view([proxy({ hasApiKey: false })]))).toMatchObject([{ problem: 'not-configured' }])
    expect(roleConnectionProblems(p(PROXY), view(), { [PROXY]: 'disconnected' })).toMatchObject([{ problem: 'disconnected', roleName: 'a' }])
    expect(roleConnectionProblems(p(PROXY), view(), { [PROXY]: 'connected' })).toEqual([])
  })
})

describe('roleTierContext', () => {
  it('uses the role connection tier mapping and optional catalog', () => {
    const cat = [model('gw/mid', PROXY, 'claude')]
    const ctx = roleTierContext(role('a', { connection: PROXY }), { provider: prov('anthropic') }, view(), cat)
    expect(ctx).toMatchObject({ connection: PROXY, tierModels: { everyday: 'gw/mid' }, catalog: cat })
    const own = roleTierContext(root({ connection: PROXY }), { provider: prov('anthropic') }, view())
    expect(own.connection).toBe('anthropic')
    expect('catalog' in own).toBe(false)
  })
})
