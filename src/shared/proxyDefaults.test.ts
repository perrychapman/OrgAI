import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_SETTINGS,
  adapterForProject,
  builtinModels,
  connectionConfigured,
  connectionIds,
  connectionName,
  connectionProviderLabel,
  connectionRecord,
  defaultConnections,
  defaultProxies,
  effectiveDefaultConnection,
  isConnectionId,
  isKnownConnection,
  mixedFamilyRefusal,
  proxyModelFamily,
  proxyModelsUrl,
  proxyOf,
  proxyOpenAIBase
} from './defaults'
import type { ProxyConnection } from './types'

const proxyRec = (over: Partial<ProxyConnection> = {}): ProxyConnection => ({
  id: 'litellm',
  name: 'Gateway',
  kind: 'litellm',
  anthropicBaseUrl: 'http://localhost:4000',
  enabled: true,
  hasApiKey: true,
  tierModels: {},
  ...over
})

describe('proxy helpers', () => {
  it('fresh settings have the two built-ins and no proxies', () => {
    expect(Object.keys(defaultConnections())).toEqual(['anthropic', 'openai'])
    expect(defaultProxies()).toEqual([])
    expect(DEFAULT_APP_SETTINGS.proxies).toEqual([])
    expect(builtinModels('litellm')).toEqual([])
    expect(builtinModels('proxy-0a1b2c3d')).toEqual([])
  })

  it('connectionIds lists built-ins first, then proxies in order', () => {
    expect(connectionIds()).toEqual(['anthropic', 'openai'])
    expect(connectionIds({ proxies: [proxyRec({ id: 'litellm' }), proxyRec({ id: 'proxy-0a1b2c3d' })] })).toEqual(['anthropic', 'openai', 'litellm', 'proxy-0a1b2c3d'])
  })

  it('proxyOf / connectionRecord / isKnownConnection never match prototype keys or missing proxies', () => {
    const v = { ...DEFAULT_APP_SETTINGS, proxies: [proxyRec()] }
    expect(proxyOf(v, 'litellm')?.name).toBe('Gateway')
    expect(proxyOf(v, 'anthropic')).toBeUndefined()
    expect(proxyOf(v, '__proto__')).toBeUndefined()
    expect(proxyOf(v, 'constructor')).toBeUndefined()
    expect(connectionRecord(v, 'openai')?.id).toBe('openai')
    expect(connectionRecord(v, 'proxy-00000000')).toBeUndefined()
    expect(isKnownConnection(v, 'litellm')).toBe(true)
    expect(isKnownConnection(v, 'proxy-00000000')).toBe(false)
    expect(isKnownConnection(v, 'toString')).toBe(false)
    expect(isKnownConnection(undefined, 'anthropic')).toBe(true)
    expect(isConnectionId('proxy-00000000')).toBe(true)
    expect(isConnectionId('proxy-xyz')).toBe(false)
    expect(isConnectionId('constructor')).toBe(false)
  })

  it('names connections and labels providers', () => {
    const v = { proxies: [proxyRec({ name: 'Team gateway' })] }
    expect(connectionName('anthropic')).toBe('Anthropic')
    expect(connectionName('openai')).toBe('OpenAI')
    expect(connectionName('litellm', v)).toBe('Team gateway')
    expect(connectionName('proxy-00000000', v)).toBe('Proxy')
    expect(connectionProviderLabel('litellm', { kind: 'subscription' }, v)).toBe('Team gateway')
    expect(connectionProviderLabel('openai', { kind: 'subscription' })).toBe('Codex (ChatGPT)')
  })

  it('derives the OpenAI base and models URL', () => {
    expect(proxyOpenAIBase({ anthropicBaseUrl: 'https://p.example.com' })).toBe('https://p.example.com/v1')
    expect(proxyOpenAIBase({ anthropicBaseUrl: 'https://p.example.com/' })).toBe('https://p.example.com/v1')
    expect(proxyOpenAIBase({ anthropicBaseUrl: 'https://p.example.com/v1' })).toBe('https://p.example.com/v1')
    expect(proxyOpenAIBase({ anthropicBaseUrl: 'https://p.example.com', openaiBaseUrl: 'https://o.example.com/openai/' })).toBe('https://o.example.com/openai')
    expect(proxyOpenAIBase({ anthropicBaseUrl: '' })).toBe('')
    expect(proxyModelsUrl({ anthropicBaseUrl: 'https://p.example.com' })).toBe('https://p.example.com/v1/models')
    expect(proxyModelsUrl({ anthropicBaseUrl: 'https://p.example.com/v1' })).toBe('https://p.example.com/v1/models')
    expect(proxyModelsUrl({ anthropicBaseUrl: 'https://p.example.com', modelsUrl: 'https://m.example.com/list' })).toBe('https://m.example.com/list')
    expect(proxyModelsUrl({ anthropicBaseUrl: '' })).toBe('')
  })

  it('proxyModelFamily lets the id win, then owned_by', () => {
    expect(proxyModelFamily('claude-opus-5-high', 'antigravity')).toBe('claude')
    expect(proxyModelFamily('gpt-6-sol', 'openai')).toBe('openai')
    expect(proxyModelFamily('gpt-6-sol')).toBe('openai')
    expect(proxyModelFamily('gemini-3.5-flash-lite', 'antigravity')).toBe('other')
    expect(proxyModelFamily('muse-spark-1.3', 'meta')).toBe('other')
    expect(proxyModelFamily('custom-a', 'anthropic')).toBe('claude')
    expect(proxyModelFamily('custom-b', ' OpenAI ')).toBe('openai')
  })

  it('a proxy is configured only when it exists, is enabled and has a base URL and a key', () => {
    expect(connectionConfigured('litellm', { proxies: [proxyRec()] })).toBe(true)
    expect(connectionConfigured('litellm', { proxies: [proxyRec({ hasApiKey: false })] })).toBe(false)
    expect(connectionConfigured('litellm', { proxies: [] })).toBe(false)
    expect(connectionConfigured('litellm', undefined)).toBe(false)
  })
})

describe('effectiveDefaultConnection with proxies', () => {
  const proxies = [{ id: 'litellm' }, { id: 'proxy-0a1b2c3d' }]
  it('picks a built-in before any proxy', () => {
    expect(effectiveDefaultConnection({ stored: 'anthropic', proxies, states: { anthropic: 'disconnected', litellm: 'connected', openai: 'connected' } })).toBe('openai')
  })
  it('picks a proxy only when exactly one is connected and no built-in is', () => {
    expect(effectiveDefaultConnection({ stored: 'anthropic', proxies, states: { anthropic: 'disconnected', 'proxy-0a1b2c3d': 'connected' } })).toBe('proxy-0a1b2c3d')
    // Two connected proxies and no built-in: undecided, the stored (disconnected) value stands.
    expect(effectiveDefaultConnection({ stored: 'anthropic', proxies, states: { anthropic: 'disconnected', litellm: 'connected', 'proxy-0a1b2c3d': 'connected' } })).toBe('anthropic')
  })
  it('keeps a stored proxy on error and survives an unknown stored proxy', () => {
    expect(effectiveDefaultConnection({ stored: 'proxy-0a1b2c3d', proxies, states: { anthropic: 'connected', 'proxy-0a1b2c3d': 'error' } })).toBe('proxy-0a1b2c3d')
    expect(effectiveDefaultConnection({ stored: 'proxy-ffffffff', proxies, states: { anthropic: 'connected' } })).toBe('anthropic')
  })
})

describe('adapterForProject and mixedFamilyRefusal with a proxy id', () => {
  it('a refusal applies to every proxy, not only litellm', () => {
    expect(mixedFamilyRefusal({ connection: 'proxy-0a1b2c3d', family: undefined, mismatched: ['r'] })).toBe('no-root-family')
    expect(mixedFamilyRefusal({ connection: 'proxy-0a1b2c3d', family: 'claude', mismatched: ['r'] })).toBeNull()
    expect(mixedFamilyRefusal({ connection: 'openai', family: 'openai', mismatched: ['r'] })).toBe('single-family-connection')
  })
  it('picks the adapter from the root model family on a proxy', () => {
    const provider = { id: 'claude' as const, label: 'x', auth: { kind: 'subscription' as const }, connection: 'proxy-0a1b2c3d' }
    const root = { id: 'r', reportsTo: null, model: 'gpt-6-sol' } as never
    const choice = adapterForProject({ provider, roles: [root] }, [])
    expect(choice).toMatchObject({ adapter: 'codex', connection: 'proxy-0a1b2c3d', family: 'openai' })
  })
})
