import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROXY_NAME_MAX } from '@shared/types'
import { fetchProxyModels, parseProxyModelList } from './litellm'
import {
  MOCK_BAD_KEY,
  MOCK_PROXY_HOST,
  cleanProxyKey,
  cleanProxyName,
  isLocalOrPrivateHost,
  isMockProxyUrl,
  mockProxyModels,
  newProxyId,
  normalizeProxyUrl,
  readableProxyName
} from './proxy'

afterEach(() => {
  vi.unstubAllEnvs()
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

describe('normalizeProxyUrl', () => {
  it('accepts https and drops trailing slashes', () => {
    expect(normalizeProxyUrl('https://p.example.com/', 'Base URL')).toBe('https://p.example.com')
    expect(normalizeProxyUrl(' https://p.example.com/gw// ')).toBe('https://p.example.com/gw')
    expect(normalizeProxyUrl('https://p.example.com:8443/v1')).toBe('https://p.example.com:8443/v1')
  })

  it('allows http only for localhost and private-network hosts', () => {
    for (const ok of ['http://localhost:4000', 'http://127.0.0.1:4000/', 'http://[::1]:4000', 'http://10.1.2.3', 'http://192.168.0.5:8080', 'http://172.20.0.1', 'http://app.localhost']) {
      expect(() => normalizeProxyUrl(ok)).not.toThrow()
    }
    for (const bad of ['http://p.example.com', 'http://172.32.0.1', 'http://11.0.0.1', 'http://8.8.8.8']) {
      expect(() => normalizeProxyUrl(bad, 'Base URL')).toThrow(/only allowed for localhost/)
    }
  })

  it('refuses credentials, query, fragment, other schemes, junk and over-long text', () => {
    expect(() => normalizeProxyUrl('https://user:pw@p.example.com', 'Base URL')).toThrow(/user name or password/)
    expect(() => normalizeProxyUrl('https://user@p.example.com')).toThrow(/user name or password/)
    expect(() => normalizeProxyUrl('https://p.example.com/v1?key=abc')).toThrow(/query/)
    expect(() => normalizeProxyUrl('https://p.example.com/v1?')).toThrow(/query/)
    expect(() => normalizeProxyUrl('https://p.example.com/#x')).toThrow(/fragment/)
    expect(() => normalizeProxyUrl('ftp://p.example.com')).toThrow(/https/)
    expect(() => normalizeProxyUrl('file:///etc/passwd')).toThrow(/https/)
    expect(() => normalizeProxyUrl('nope', 'Base URL')).toThrow(/Base URL is not a valid URL/)
    expect(() => normalizeProxyUrl('  ', 'Base URL')).toThrow(/empty/)
    expect(() => normalizeProxyUrl(42)).toThrow(/text/)
    expect(() => normalizeProxyUrl(`https://p.example.com/${'a'.repeat(2048)}`)).toThrow(/longer than 2048/)
    expect(() => normalizeProxyUrl('https://p.example.com/a b')).toThrow(/space or hidden/)
    expect(() => normalizeProxyUrl('https://p.example.com/‮a')).toThrow(/space or hidden/)
    expect(() => normalizeProxyUrl('https://p.example.com/\u0007')).toThrow(/space or hidden/)
  })

  it('never echoes credentials in an error', () => {
    try {
      normalizeProxyUrl('https://admin:hunter2@p.example.com')
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2')
      expect((e as Error).message).not.toContain('admin')
    }
  })

  it('isLocalOrPrivateHost', () => {
    expect(isLocalOrPrivateHost('fd12:3456::1')).toBe(true)
    expect(isLocalOrPrivateHost('169.254.1.1')).toBe(true)
    expect(isLocalOrPrivateHost('999.1.1.1')).toBe(false)
    expect(isLocalOrPrivateHost('example.com')).toBe(false)
    expect(isLocalOrPrivateHost('')).toBe(false)
  })
})

describe('names, ids and keys', () => {
  it('cleanProxyName collapses whitespace and refuses empty, long, hidden and duplicate names', () => {
    expect(cleanProxyName('  Team   gateway ')).toBe('Team gateway')
    expect(() => cleanProxyName('')).toThrow(/name/)
    expect(() => cleanProxyName('x'.repeat(PROXY_NAME_MAX + 1))).toThrow(/at most/)
    expect(cleanProxyName('x'.repeat(PROXY_NAME_MAX))).toHaveLength(PROXY_NAME_MAX)
    expect(() => cleanProxyName('a​b')).toThrow(/hidden/)
    expect(() => cleanProxyName('a\u0000b')).toThrow(/hidden/)
    expect(() => cleanProxyName('Team', ['team'])).toThrow(/already exists/)
    expect(() => cleanProxyName(7)).toThrow(/text/)
  })

  it('readableProxyName suffixes a clash within the limit and returns undefined for junk', () => {
    expect(readableProxyName('Gateway', ['gateway'])).toBe('Gateway 2')
    expect(readableProxyName('Gateway', ['gateway', 'Gateway 2'])).toBe('Gateway 3')
    const long = 'x'.repeat(PROXY_NAME_MAX)
    expect(readableProxyName(long, [long])!.length).toBeLessThanOrEqual(PROXY_NAME_MAX)
    expect(readableProxyName('a‮b')).toBeUndefined()
    expect(readableProxyName(null)).toBeUndefined()
  })

  it('newProxyId is proxy- plus 8 hex and avoids the given ids', () => {
    const id = newProxyId()
    expect(id).toMatch(/^proxy-[0-9a-f]{8}$/)
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(newProxyId(seen))
    expect(seen.size).toBe(200)
  })

  it('cleanProxyKey trims, clears on empty and refuses control characters and over-long keys', () => {
    expect(cleanProxyKey('  sk-abc  ')).toBe('sk-abc')
    expect(cleanProxyKey('')).toBeNull()
    expect(cleanProxyKey(null)).toBeNull()
    expect(() => cleanProxyKey('a\nb')).toThrow(/control or hidden/)
    expect(() => cleanProxyKey('x'.repeat(4001))).toThrow(/too long/)
    expect(() => cleanProxyKey(5)).toThrow(/text/)
  })
})

describe('mock proxy host', () => {
  it('is recognised only with ORGAI_MOCK=1 and the exact host', () => {
    const url = `https://${MOCK_PROXY_HOST}/v1/models`
    expect(isMockProxyUrl(url)).toBe(false)
    vi.stubEnv('ORGAI_MOCK', '1')
    expect(isMockProxyUrl(url)).toBe(true)
    expect(isMockProxyUrl(`https://sub.${MOCK_PROXY_HOST}/v1/models`)).toBe(false)
    expect(isMockProxyUrl(`https://${MOCK_PROXY_HOST}.evil.example.com/v1/models`)).toBe(false)
    expect(isMockProxyUrl(undefined)).toBe(false)
    expect(isMockProxyUrl('nope')).toBe(false)
  })

  it('lists nine mixed-family models with no prices', () => {
    const models = mockProxyModels('proxy-0a1b2c3d')
    expect(models).toHaveLength(9)
    const by = Object.fromEntries(models.map((m) => [m.id, m]))
    expect(by['claude-opus-5']).toMatchObject({ family: 'claude', adapter: 'claude', ownedBy: 'anthropic', connection: 'proxy-0a1b2c3d' })
    expect(by['claude-opus-5-high']).toMatchObject({ family: 'claude', ownedBy: 'antigravity' })
    expect(by['gpt-6-sol']).toMatchObject({ family: 'openai', adapter: 'codex' })
    expect(by['gemini-3.5-flash-lite']).toMatchObject({ family: 'other', adapter: 'codex' })
    expect(by['muse-spark-1.3']).toMatchObject({ family: 'other', ownedBy: 'meta' })
    for (const m of models) expect(m).not.toHaveProperty('price')
  })

  it('fetchProxyModels answers without network, connects with any key and refuses mock-bad-key', async () => {
    vi.stubEnv('ORGAI_MOCK', '1')
    const f = vi.fn()
    const url = `https://${MOCK_PROXY_HOST}/v1/models`
    const models = await fetchProxyModels(url, 'anything', f as unknown as typeof fetch, { kind: 'openai-compatible', connection: 'proxy-0a1b2c3d' })
    expect(models).toHaveLength(9)
    await expect(fetchProxyModels(url, MOCK_BAD_KEY, f as unknown as typeof fetch, { kind: 'litellm', connection: 'litellm' })).rejects.toThrow('The key was refused (401).')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('fetchProxyModels', () => {
  const connection = 'proxy-0a1b2c3d'
  const list = { data: [{ id: 'claude-opus-5', owned_by: 'anthropic' }, { id: 'gpt-6-sol', owned_by: 'openai' }, { id: 'qwen38', owned_by: 'vllm-mock' }, { id: 'claude-opus-5-high', owned_by: 'antigravity' }] }

  it("openai-compatible reads only the models URL: no /model/info, no /key/info, Bearer and redirect 'error'", async () => {
    const f = vi.fn(async () => json(list))
    const models = await fetchProxyModels('https://p.example.com/v1/models', 'sk-k', f as unknown as typeof fetch, { kind: 'openai-compatible', connection, baseUrl: 'https://p.example.com' })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://p.example.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-k')
    expect(init.redirect).toBe('error')
    expect(models.map((m) => [m.id, m.family, m.ownedBy, m.connection])).toEqual([
      ['claude-opus-5', 'claude', 'anthropic', connection],
      ['gpt-6-sol', 'openai', 'openai', connection],
      ['qwen38', 'other', 'vllm-mock', connection],
      ['claude-opus-5-high', 'claude', 'antigravity', connection]
    ])
    expect(models[0].adapter).toBe('claude')
    expect(models[2].adapter).toBe('codex')
  })

  it('litellm adds prices from /model/info, and a 404 there does not fail discovery', async () => {
    const priced = vi.fn(async (u: string | URL | Request) =>
      String(u).endsWith('/model/info')
        ? json({ data: [{ model_name: 'claude-opus-5', model_info: { mode: 'chat', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }] })
        : json(list)
    )
    const withPrices = await fetchProxyModels('https://p.example.com/v1/models', 'k', priced as unknown as typeof fetch, { kind: 'litellm', connection, baseUrl: 'https://p.example.com' })
    expect(withPrices[0].price).toEqual({ inputPerToken: 5e-6, outputPerToken: 2.5e-5 })
    const noInfo = vi.fn(async (u: string | URL | Request) => (String(u).endsWith('/model/info') ? json({}, 404) : json(list)))
    const plain = await fetchProxyModels('https://p.example.com/v1/models', 'k', noInfo as unknown as typeof fetch, { kind: 'litellm', connection, baseUrl: 'https://p.example.com' })
    expect(plain).toHaveLength(4)
    expect(plain[0]).not.toHaveProperty('price')
    expect(noInfo.mock.calls.map(([u]) => String(u))).toEqual(['https://p.example.com/v1/models', 'https://p.example.com/model/info'])
    // A status probe (listOnly) skips /model/info.
    const only = vi.fn(async () => json(list))
    await fetchProxyModels('https://p.example.com/v1/models', 'k', only as unknown as typeof fetch, { kind: 'litellm', connection, baseUrl: 'https://p.example.com', listOnly: true })
    expect(only).toHaveBeenCalledTimes(1)
  })

  it('sanitizes owned_by (printable, at most 64) and drops invalid ids and non-chat litellm modes', async () => {
    const body = { data: [{ id: 'a-model', owned_by: 'x'.repeat(65) }, { id: 'b-model', owned_by: 'bad‮' }, { id: 'c-model', owned_by: ' meta ' }, { id: 'has space' }, { id: '-flag' }, { id: 'a-model' }, 'd-model'] }
    const models = await fetchProxyModels('https://p.example.com/v1/models', 'k', (async () => json(body)) as unknown as typeof fetch, { kind: 'openai-compatible', connection })
    expect(models.map((m) => [m.id, m.ownedBy])).toEqual([['a-model', undefined], ['b-model', undefined], ['c-model', 'meta'], ['d-model', undefined]])
  })

  it('caps at 2000 models and reads a bare array', () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: `m-${i}` }))
    expect(parseProxyModelList({ data: many })).toHaveLength(2000)
    expect(parseProxyModelList([{ id: 'x' }, 'y'])).toHaveLength(2)
    expect(parseProxyModelList(null)).toEqual([])
  })

  it('uses a custom models URL as given and never puts the key in an error', async () => {
    const f = vi.fn(async () => json({ error: { message: 'bad sk-leak-key here' } }, 500))
    const err = await fetchProxyModels('https://m.example.com/catalog/list', 'sk-leak-key', f as unknown as typeof fetch, { kind: 'openai-compatible', connection }).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('sk-leak-key')
    expect((err as Error).message).toContain('500')
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://m.example.com/catalog/list')
    const down = await fetchProxyModels('https://m.example.com/x', 'sk-leak-key', (async () => {
      throw new TypeError('down sk-leak-key')
    }) as unknown as typeof fetch, { kind: 'openai-compatible', connection }).catch((e: Error) => e)
    expect((down as Error).message).not.toContain('sk-leak-key')
  })

  it('refuses an invalid models URL before any request', async () => {
    const f = vi.fn()
    await expect(fetchProxyModels('http://p.example.com/v1/models', 'k', f as unknown as typeof fetch, { kind: 'openai-compatible', connection })).rejects.toThrow(/Models URL/)
    expect(f).not.toHaveBeenCalled()
  })
})
