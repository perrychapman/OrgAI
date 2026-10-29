import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fetchLiteLLMModels, normalizeBaseUrl, parseModelIds, parseModelInfo } from './litellm'

const fx = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('normalizeBaseUrl', () => {
  it('accepts https and localhost http, strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://llm.example.com/')).toBe('https://llm.example.com')
    expect(normalizeBaseUrl('http://localhost:4000//')).toBe('http://localhost:4000')
    expect(normalizeBaseUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000')
    expect(normalizeBaseUrl('http://[::1]:4000')).toBe('http://[::1]:4000')
    expect(normalizeBaseUrl('https://x.com/litellm')).toBe('https://x.com/litellm')
  })
  it('rejects other schemes, remote http and junk', () => {
    expect(() => normalizeBaseUrl('http://llm.example.com')).toThrow(/localhost/)
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(/scheme/)
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(/scheme/)
    expect(() => normalizeBaseUrl('nope')).toThrow(/not a valid URL/)
    expect(() => normalizeBaseUrl('  ')).toThrow(/empty/)
  })
})

describe('parsing', () => {
  it('parses ids tolerantly', () => {
    expect(parseModelIds(fx('litellm-models.json'))).toHaveLength(7)
    expect(parseModelIds(['a', { id: 'b' }, { model_name: 'c' }, 4, null, 'a'])).toEqual(['a', 'b', 'c'])
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ data: 'x' })).toEqual([])
  })
  it('parses model info with provider fallbacks', () => {
    const info = parseModelInfo(fx('litellm-model-info.json'))
    expect(info.get('claude-opus-4-5')).toMatchObject({ litellmProvider: 'anthropic', contextWindow: 200000, mode: 'chat' })
    expect(info.get('claude-haiku-4-5')?.contextWindow).toBe(64000)
    expect(info.get('gpt-5-mini')?.litellmProvider).toBe('openai') // from litellm_params.model prefix
    expect(parseModelInfo({})).toEqual(new Map())
  })
})

describe('fetchLiteLLMModels', () => {
  it('merges both endpoints, sends both auth headers and drops non-chat models', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/models') ? json(fx('litellm-models.json')) : json(fx('litellm-model-info.json'))
    )
    const models = await fetchLiteLLMModels('http://localhost:4000/', 'sk-secret', fetchImpl as unknown as typeof fetch)
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-mini', 'llama-3-8b'])
    expect(models.find((m) => m.id === 'claude-sonnet-4-5')).toMatchObject({ family: 'claude', adapter: 'claude', tier: 'everyday', contextWindow: 200000, connection: 'litellm' })
    expect(models.find((m) => m.id === 'gpt-5')).toMatchObject({ family: 'openai', adapter: 'codex', tier: 'deep' })
    expect(models.find((m) => m.id === 'llama-3-8b')).toMatchObject({ family: 'other', tier: 'fast' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:4000/v1/models')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-secret', 'x-api-key': 'sk-secret' })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('still works when /model/info fails', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/v1/models') ? json({ data: [{ id: 'claude-opus-4-5' }, { id: 'gpt-5' }] }) : json({ error: 'nope' }, 403)
    )
    const models = await fetchLiteLLMModels('https://p.example.com', 'k', fetchImpl as unknown as typeof fetch)
    expect(models.map((m) => [m.id, m.family])).toEqual([['claude-opus-4-5', 'claude'], ['gpt-5', 'openai']])
  })

  it('reports short errors without the key', async () => {
    const f401 = (async () => json({ error: { message: 'Authentication Error sk-secret' } }, 401)) as unknown as typeof fetch
    await expect(fetchLiteLLMModels('http://localhost:4000', 'sk-secret', f401)).rejects.toThrow('401 from /v1/models: invalid key')
    const f500 = (async () => json({ error: { message: 'boom sk-secret' } }, 500)) as unknown as typeof fetch
    const err = await fetchLiteLLMModels('http://localhost:4000', 'sk-secret', f500).catch((e: Error) => e)
    expect((err as Error).message).toBe('500 from /v1/models: boom ***')
    const down = (async () => {
      throw new TypeError('fetch failed sk-secret')
    }) as unknown as typeof fetch
    const e2 = await fetchLiteLLMModels('http://localhost:4000', 'sk-secret', down).catch((e: Error) => e)
    expect((e2 as Error).message).toBe('Could not reach localhost:4000')
  })

  it('rejects bad URLs before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchLiteLLMModels('http://evil.example.com', 'k', fetchImpl as unknown as typeof fetch)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
