import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SPEND_PERIOD_DAYS } from '@shared/types'
import {
  LITELLM_MAX_BODY_BYTES,
  LITELLM_MAX_DAILY_ROWS,
  LITELLM_MAX_ID_CHARS,
  LITELLM_MAX_MODELS,
  SPEND_PERIOD_NOTES,
  buildLiteLLMModels,
  fetchLiteLLMKeyInfo,
  fetchLiteLLMModels,
  fetchLiteLLMSpend,
  keyHash,
  normalizeBaseUrl,
  parseDailyActivity,
  parseKeyInfo,
  parseModelIds,
  parseModelInfo,
  parsePrice,
  periodBounds,
  spendPeriods
} from './litellm'

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
  it('reads the four price fields and the upstream model', () => {
    const info = parseModelInfo({
      data: [
        { model_name: 'a', litellm_params: { model: 'anthropic/claude-x' }, model_info: { input_cost_per_token: 3e-6, output_cost_per_token: '1.5e-5', cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6 } },
        { model_name: 'b', model_info: { input_cost_per_token: null, output_cost_per_token: null } },
        { model_name: 'c', model_info: { input_cost_per_token: 0, output_cost_per_token: 0 } },
        { model_name: 'd', model_info: { input_cost_per_token: -1, output_cost_per_token: 'free' } },
        { model_name: 'e', model_info: { output_cost_per_token: 2e-6 } }
      ]
    })
    expect(info.get('a')).toMatchObject({
      upstream: 'anthropic/claude-x',
      price: { inputPerToken: 3e-6, outputPerToken: 1.5e-5, cacheReadPerToken: 3e-7, cacheCreationPerToken: 3.75e-6 }
    })
    expect(info.get('b')?.price).toBeUndefined()
    expect(info.get('c')?.price).toEqual({ inputPerToken: 0, outputPerToken: 0 })
    expect(info.get('d')?.price).toBeUndefined()
    expect(info.get('e')?.price).toEqual({ inputPerToken: 0, outputPerToken: 2e-6 })
    expect(parsePrice({})).toBeUndefined()
  })
  it('buildLiteLLMModels carries price and upstream into the catalog', () => {
    const [m] = buildLiteLLMModels(['a'], new Map([['a', { mode: 'chat', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 }, upstream: 'openai/a' }]]))
    expect(m).toMatchObject({ id: 'a', price: { inputPerToken: 1e-6, outputPerToken: 2e-6 }, upstream: 'openai/a' })
  })
})

describe('parseKeyInfo', () => {
  it('reads the wrapped /key/info shape', () => {
    expect(
      parseKeyInfo({ key: 'sk-hash', info: { spend: 4.5, max_budget: 20, budget_duration: '30d', budget_reset_at: '2026-11-30T00:00:00Z', key_alias: 'me', models: [] } })
    ).toEqual({ usd: 4.5, budgetUsd: 20, resetsAt: Date.parse('2026-11-30T00:00:00Z'), budgetDuration: '30d', keyAlias: 'me', totalUsd: null })
  })
  it('reads the lifetime total_spend into totalUsd, null when absent or invalid', () => {
    expect(parseKeyInfo({ info: { spend: 1, total_spend: 12.5 } })?.totalUsd).toBe(12.5)
    expect(parseKeyInfo({ info: { spend: 1, total_spend: '3.25' } })?.totalUsd).toBe(3.25)
    expect(parseKeyInfo({ info: { spend: 1, total_spend: 0 } })?.totalUsd).toBe(0)
    expect(parseKeyInfo({ info: { spend: 1 } })?.totalUsd).toBeNull()
    expect(parseKeyInfo({ info: { spend: 1, total_spend: -4 } })?.totalUsd).toBeNull()
    expect(parseKeyInfo({ info: { spend: 1, total_spend: 'lots' } })?.totalUsd).toBeNull()
    expect(parseKeyInfo({ info: { spend: 1, total_spend: null } })?.totalUsd).toBeNull()
  })
  it('accepts numeric strings, the bare shape, and a null or zero budget', () => {
    expect(parseKeyInfo({ spend: '0.75', max_budget: '5' })).toMatchObject({ usd: 0.75, budgetUsd: 5 })
    expect(parseKeyInfo({ info: { spend: 0, max_budget: null, budget_reset_at: null } })).toEqual({ usd: 0, budgetUsd: null, resetsAt: null, budgetDuration: null, keyAlias: null, totalUsd: null })
    expect(parseKeyInfo({ info: { spend: 1, max_budget: 0 } })?.budgetUsd).toBeNull()
    expect(parseKeyInfo({ info: { spend: 1, budget_reset_at: 1_900_000_000 } })?.resetsAt).toBe(1_900_000_000_000)
  })
  it('returns null for garbage', () => {
    for (const body of [null, undefined, 'x', 3, [], {}, { info: {} }, { info: { spend: 'NaN' } }, { info: { spend: -2 } }, { info: { spend: '1e' } }]) {
      expect(parseKeyInfo(body)).toBeNull()
    }
    expect(parseKeyInfo({ info: { spend: 1, budget_reset_at: 'not a date' } })?.resetsAt).toBeNull()
    expect(parseKeyInfo({ info: { spend: 1, budget_reset_at: 9e15 } })?.resetsAt).toBeNull() // beyond what a Date holds
    expect(parseKeyInfo({ info: { spend: 1, budget_reset_at: '+275760-09-14T00:00:00.000Z' } })?.resetsAt).toBeNull()
  })
  it('fetchLiteLLMKeyInfo sends the key only as auth headers and refuses redirects', async () => {
    const fetchImpl = vi.fn(async () => json({ info: { spend: 2 } }))
    expect(await fetchLiteLLMKeyInfo('http://localhost:4000/', 'sk-secret', fetchImpl as unknown as typeof fetch)).toMatchObject({ usd: 2 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:4000/key/info')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer sk-secret' } })
    const f404 = (async () => json({}, 404)) as unknown as typeof fetch
    const err = await fetchLiteLLMKeyInfo('http://localhost:4000', 'sk-secret', f404).catch((e: Error) => e)
    expect(String(err)).not.toContain('sk-secret')
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

  it('drops hidden and control characters from remote error text before the cut', async () => {
    const msg = `bad‮evil​\nline\u0007${'x'.repeat(200)}`
    const f = (async () => json({ error: { message: msg } }, 500)) as unknown as typeof fetch
    const err = (await fetchLiteLLMModels('http://localhost:4000', 'k', f).catch((e: Error) => e)) as Error
    const reason = err.message.replace('500 from /v1/models: ', '')
    expect(reason.startsWith('badevil line')).toBe(true)
    expect(reason).not.toMatch(/[‮​\u0007\n]/)
    expect(reason.length).toBe(120)
  })

  it('rejects credentials, query and link-local http in the base URL', () => {
    expect(() => normalizeBaseUrl('https://u:p@x.com')).toThrow(/user name or password/)
    expect(() => normalizeBaseUrl('https://x.com/?k=1')).toThrow(/query/)
    expect(() => normalizeBaseUrl('http://169.254.169.254')).toThrow(/localhost/)
  })

  it('rejects bad URLs before fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(fetchLiteLLMModels('http://evil.example.com', 'k', fetchImpl as unknown as typeof fetch)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('discovery bounds', () => {
  it('caps the models kept from a discovery and skips overlong ids', () => {
    const ids = Array.from({ length: LITELLM_MAX_MODELS + 5 }, (_, i) => `m${i}`)
    expect(buildLiteLLMModels(ids, new Map())).toHaveLength(LITELLM_MAX_MODELS)
    expect(buildLiteLLMModels(['x'.repeat(LITELLM_MAX_ID_CHARS + 1), 'ok'], new Map()).map((m) => m.id)).toEqual(['ok'])
  })

  it('drops ids with whitespace, control chars, non-ASCII or a leading dash', () => {
    expect(buildLiteLLMModels([...['has space', 'tab\there', 'bell\u0007', 'new\nline', '--help', '-m', 'caf\u00e9', 'x'.repeat(201), ''], 'openai/gpt-ok'], new Map()).map((m) => m.id)).toEqual(['openai/gpt-ok'])
  })

  it('runs /model/info prices through sanitizeModelPrice (ceiling applied)', () => {
    expect(parsePrice({ input_cost_per_token: 1e9, output_cost_per_token: 1e-6 })).toBeUndefined()
    expect(parsePrice({ input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 1e9 })).toEqual({ inputPerToken: 1e-6, outputPerToken: 2e-6 })
  })
})

describe('proxy output bounds', () => {
  it('drops out-of-range prices instead of passing them on', () => {
    expect(parsePrice({ input_cost_per_token: 1e300, output_cost_per_token: 0.000001 })).toBeUndefined()
    expect(parsePrice({ input_cost_per_token: '1e300', output_cost_per_token: 0.000001 })).toBeUndefined()
    expect(parsePrice({ input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 })).toEqual({ inputPerToken: 0.000001, outputPerToken: 0.000002 })
  })
  it('stops parsing at the model cap and ignores overlong ids', () => {
    const data = Array.from({ length: LITELLM_MAX_MODELS + 50 }, (_, i) => ({ id: `m${i}` }))
    expect(parseModelIds({ data })).toHaveLength(LITELLM_MAX_MODELS)
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'a' }, { id: 'x'.repeat(LITELLM_MAX_ID_CHARS + 1) }] })).toEqual(['a'])
    const info = parseModelInfo({ data: data.map((d) => ({ model_name: d.id })) })
    expect(info.size).toBe(LITELLM_MAX_MODELS)
  })
  it('refuses a response body over the byte cap', async () => {
    const big = (): Response => new Response('x'.repeat(LITELLM_MAX_BODY_BYTES + 10), { status: 200 })
    const fetchImpl = (async () => big()) as unknown as typeof fetch
    await expect(fetchLiteLLMModels('http://localhost:4000', 'k', fetchImpl)).rejects.toThrow(/too large/)
  })

  it('does not buffer a declared oversized error response', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x78]))
      },
      cancel() {
        cancelled = true
      }
    })
    const fetchImpl = (async () => new Response(body, {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-length': String(LITELLM_MAX_BODY_BYTES + 1) }
    })) as unknown as typeof fetch
    const error = await fetchLiteLLMModels('http://localhost:4000', 'k', fetchImpl).catch((e: Error) => e)
    expect((error as Error).message).toBe('500 from /v1/models: Internal Server Error')
    expect(cancelled).toBe(true)
  })

  it('cancels a chunked oversized error response', async () => {
    let cancelled = false
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LITELLM_MAX_BODY_BYTES))
        controller.enqueue(new Uint8Array([0x78]))
      },
      cancel() {
        cancelled = true
      }
    }), { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch
    const error = await fetchLiteLLMModels('http://localhost:4000', 'k', fetchImpl).catch((e: Error) => e)
    expect((error as Error).message).toBe('500 from /v1/models: Internal Server Error')
    expect(cancelled).toBe(true)
  })

  it('redacts the supplied key from a remote statusText when the error body is not JSON', async () => {
    const key = 'synthetic-proxy-key-1234567890'
    const fetchImpl = (async () => new Response('not json', {
      status: 500,
      statusText: `Proxy rejected ${key}`
    })) as unknown as typeof fetch
    const error = await fetchLiteLLMModels('http://localhost:4000', key, fetchImpl).catch((e: Error) => e)
    expect((error as Error).message).toContain('Proxy rejected ***')
    expect((error as Error).message).not.toContain(key)
  })

  it('redacts the supplied key from statusText when an error body is too large', async () => {
    const key = 'synthetic-proxy-key-1234567890'
    const fetchImpl = (async () => new Response('oversized', {
      status: 500,
      statusText: `Proxy rejected ${key}`,
      headers: { 'content-length': String(LITELLM_MAX_BODY_BYTES + 1) }
    })) as unknown as typeof fetch
    const error = await fetchLiteLLMModels('http://localhost:4000', key, fetchImpl).catch((e: Error) => e)
    expect((error as Error).message).toContain('Proxy rejected ***')
    expect((error as Error).message).not.toContain(key)
  })
})

// ---- Spend by period (daily activity routes; the proxy shape is UNVERIFIED live, tests use fixtures) ----

const RAW_KEY = 'sk-secret'
const HASH = '746b4ad1ca9129e1caf080bf9406d43531b8bbf97f42cc1597ee4f3d4663938e'
const OTHER_HASH = '0'.repeat(64)
/** Wednesday 2026-11-04 15:00 UTC: the fixture's week is 11-02..11-04, the month 11-01..11-04. */
const NOW = Date.parse('2026-11-04T15:00:00Z')
const DAY = 24 * 60 * 60 * 1000

describe('keyHash', () => {
  it('is the SHA-256 hex digest of the raw key (LiteLLM hash_token)', () => {
    expect(keyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(keyHash(RAW_KEY)).toBe(HASH)
    expect(keyHash(RAW_KEY)).not.toContain(RAW_KEY)
  })
})

describe('periodBounds', () => {
  it('starts the week on Monday 00:00 UTC, a Sunday month start included', () => {
    const b = periodBounds(Date.parse('2026-11-01T10:00:00Z')) // Sunday, 1st
    expect(b).toEqual({ day: Date.UTC(2026, 10, 1), week: Date.UTC(2026, 9, 26), month: Date.UTC(2026, 10, 1), startDate: '2026-10-26', endDate: '2026-11-01' })
  })
  it('crosses the year for the week start', () => {
    const b = periodBounds(Date.UTC(2026, 0, 1)) // Thursday
    expect(b).toEqual({ day: Date.UTC(2026, 0, 1), week: Date.UTC(2025, 11, 29), month: Date.UTC(2026, 0, 1), startDate: '2025-12-29', endDate: '2026-01-01' })
  })
  it('makes a Monday its own week start and takes the earlier of week and month', () => {
    const b = periodBounds(Date.parse('2026-11-02T23:59:59Z')) // Monday
    expect(b.week).toBe(Date.UTC(2026, 10, 2))
    expect(b.day).toBe(Date.UTC(2026, 10, 2))
    expect(b.startDate).toBe('2026-11-01') // the month start is earlier
    const w = periodBounds(NOW)
    expect(w).toMatchObject({ day: Date.UTC(2026, 10, 4), week: Date.UTC(2026, 10, 2), month: Date.UTC(2026, 10, 1), startDate: '2026-11-01', endDate: '2026-11-04' })
  })
  it('never asks further back than SPEND_PERIOD_DAYS before endDate', () => {
    for (const t of [NOW, Date.UTC(2024, 1, 29), Date.UTC(2026, 2, 31, 23, 59), Date.UTC(2026, 11, 31)]) {
      const b = periodBounds(t)
      const span = (Date.parse(`${b.endDate}T00:00:00Z`) - Date.parse(`${b.startDate}T00:00:00Z`)) / DAY
      expect(span).toBeGreaterThanOrEqual(0)
      expect(span).toBeLessThanOrEqual(SPEND_PERIOD_DAYS)
      expect(b.endDate).toBe(new Date(t).toISOString().slice(0, 10))
      expect(Date.parse(`${b.startDate}T00:00:00Z`)).toBe(Math.min(b.week, b.month))
    }
  })
})

describe('parseDailyActivity', () => {
  const row = (date: string, spend: unknown, breakdown?: unknown): unknown => ({ date, metrics: { spend }, ...(breakdown !== undefined ? { breakdown } : {}) })
  const keyed = (entries: Record<string, unknown>): unknown => ({ api_keys: entries })

  it('reads the fixture: the breakdown entry for our hash wins over metrics.spend', () => {
    const rows = parseDailyActivity(fx('litellm-daily-activity.json'), HASH)
    expect(rows).toEqual([
      { date: '2026-10-31', usd: 8 },
      { date: '2026-11-01', usd: 1.5 },
      { date: '2026-11-02', usd: 2.25 },
      { date: '2026-11-03', usd: 4 }, // metrics.spend is 103 and another key lists 99
      { date: '2026-11-04', usd: 0.5 },
      { date: '2026-11-05', usd: 100 }
    ])
  })
  it('cross-checks the api_key filter through the breakdown', () => {
    expect(parseDailyActivity({ results: [row('2026-11-03', 7, keyed({ [HASH]: { metrics: { spend: 4 } }, [OTHER_HASH]: { metrics: { spend: 3 } } }))] }, HASH)).toEqual([{ date: '2026-11-03', usd: 4 }])
    // Our hash absent while others are listed: the filter was ignored, the day counts 0 for this key.
    expect(parseDailyActivity({ results: [row('2026-11-03', 7, keyed({ [OTHER_HASH]: { metrics: { spend: 7 } } }))] }, HASH)).toEqual([{ date: '2026-11-03', usd: 0 }])
    // No breakdown, or an empty map, or a junk breakdown: metrics.spend.
    expect(parseDailyActivity({ results: [row('2026-11-03', 7)] }, HASH)).toEqual([{ date: '2026-11-03', usd: 7 }])
    expect(parseDailyActivity({ results: [row('2026-11-03', 7, keyed({}))] }, HASH)).toEqual([{ date: '2026-11-03', usd: 7 }])
    expect(parseDailyActivity({ results: [row('2026-11-03', 7, { api_keys: [] })] }, HASH)).toEqual([{ date: '2026-11-03', usd: 7 }])
    expect(parseDailyActivity({ results: [row('2026-11-03', '7.5', 'junk')] }, HASH)).toEqual([{ date: '2026-11-03', usd: 7.5 }])
    // Our entry present but without a usable spend: the row is dropped, never 0 or metrics.spend.
    expect(parseDailyActivity({ results: [row('2026-11-03', 7, keyed({ [HASH]: { metrics: { spend: 'x' } } }))] }, HASH)).toEqual([])
  })
  it('drops malformed rows and tolerates junk shapes', () => {
    const results = [
      row('2026-13-40', 1),
      row('2026-11-3', 1),
      row('20261103', 1),
      row('2026-02-30', 1),
      row('0026-11-03', 1),
      row('2026-11-03', -1),
      row('2026-11-03', 'lots'),
      row('2026-11-03', Number.POSITIVE_INFINITY),
      row('2026-11-03', null),
      { metrics: { spend: 1 } },
      'junk',
      null,
      42,
      ['2026-11-03'],
      row('2026-11-03', 2)
    ]
    expect(parseDailyActivity({ results }, HASH)).toEqual([{ date: '2026-11-03', usd: 2 }])
    for (const body of [null, undefined, 'x', 3, [], {}, { results: {} }, { results: 'x' }, { results: null }, { results: [] }]) {
      expect(parseDailyActivity(body, HASH)).toEqual([])
    }
  })
  it('counts a repeated date once (first row wins)', () => {
    expect(parseDailyActivity({ results: [row('2026-11-03', 2), row('2026-11-03', 5), row('2026-11-04', 1)] }, HASH)).toEqual([
      { date: '2026-11-03', usd: 2 },
      { date: '2026-11-04', usd: 1 }
    ])
  })
  it('keeps at most LITELLM_MAX_DAILY_ROWS rows', () => {
    const results = Array.from({ length: LITELLM_MAX_DAILY_ROWS + 25 }, (_, i) => row(new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10), 1))
    expect(parseDailyActivity({ results }, HASH)).toHaveLength(LITELLM_MAX_DAILY_ROWS)
  })
})

describe('spendPeriods', () => {
  it('sums UTC calendar periods, never rolling windows, and ignores future rows', () => {
    const rows = parseDailyActivity(fx('litellm-daily-activity.json'), HASH)
    const periods = spendPeriods(rows, NOW)
    expect(periods).toEqual({
      day: { usd: 0.5, since: Date.UTC(2026, 10, 4) },
      week: { usd: 6.75, since: Date.UTC(2026, 10, 2) }, // 11-02 + 11-03 + 11-04; 10-31 would be inside a rolling 7 days
      month: { usd: 8.25, since: Date.UTC(2026, 10, 1) } // 11-01..11-04; 11-05 is in the future
    })
  })
  it('counts a Sunday month start in the previous ISO week', () => {
    const rows = [
      { date: '2026-10-26', usd: 1 },
      { date: '2026-10-31', usd: 2 },
      { date: '2026-11-01', usd: 4 }
    ]
    expect(spendPeriods(rows, Date.parse('2026-11-01T10:00:00Z'))).toEqual({
      day: { usd: 4, since: Date.UTC(2026, 10, 1) },
      week: { usd: 7, since: Date.UTC(2026, 9, 26) },
      month: { usd: 4, since: Date.UTC(2026, 10, 1) }
    })
    expect(spendPeriods([], NOW)).toEqual({ day: { usd: 0, since: Date.UTC(2026, 10, 4) }, week: { usd: 0, since: Date.UTC(2026, 10, 2) }, month: { usd: 0, since: Date.UTC(2026, 10, 1) } })
  })
})

describe('fetchLiteLLMSpend', () => {
  const BASE = 'http://localhost:4000'
  const keyInfo = { key: 'hashed', info: { spend: 1.25, max_budget: 10, budget_duration: '30d', budget_reset_at: '2026-11-30T00:00:00Z', key_alias: 'team-a', total_spend: 42 } }
  const KEY_INFO = { usd: 1.25, budgetUsd: 10, resetsAt: Date.parse('2026-11-30T00:00:00Z'), budgetDuration: '30d', keyAlias: 'team-a', totalUsd: 42 }
  const FIXTURE_PERIODS = { day: { usd: 0.5, since: Date.UTC(2026, 10, 4) }, week: { usd: 6.75, since: Date.UTC(2026, 10, 2) }, month: { usd: 8.25, since: Date.UTC(2026, 10, 1) } }
  type Route = (url: string) => Response | Promise<Response>
  const proxy = (aggregated: Route, paginated: Route = () => json({}, 404), info: Route = () => json(keyInfo)) =>
    vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/key/info')) return info(u)
      if (u.includes('/user/daily/activity/aggregated?')) return aggregated(u)
      if (u.includes('/user/daily/activity?')) return paginated(u)
      return json({}, 404)
    })
  const run = (f: ReturnType<typeof proxy>, now = NOW) => fetchLiteLLMSpend(BASE, RAW_KEY, f as unknown as typeof fetch, now)
  const urls = (f: ReturnType<typeof proxy>): string[] => f.mock.calls.map(([u]) => String(u))
  const dailyCalls = (f: ReturnType<typeof proxy>): string[] => urls(f).filter((u) => u.includes('/user/daily/activity'))
  const oneOf = (spend: Awaited<ReturnType<typeof fetchLiteLLMSpend>>): void => {
    expect(spend).not.toBeNull()
    expect('periods' in spend! && 'periodsNote' in spend!).toBe(false)
    expect('periods' in spend! || 'periodsNote' in spend!).toBe(true)
  }

  it('reads /key/info and the aggregated route with the hash, never the key, in the URL', async () => {
    const f = proxy(() => json(fx('litellm-daily-activity.json')))
    const spend = await run(f)
    expect(spend).toEqual({ ...KEY_INFO, periods: FIXTURE_PERIODS })
    oneOf(spend)
    expect(dailyCalls(f)).toEqual([`${BASE}/user/daily/activity/aggregated?start_date=2026-11-01&end_date=2026-11-04&api_key=${HASH}`])
    for (const u of urls(f)) expect(u).not.toContain(RAW_KEY)
    const init = f.mock.calls[1]![1]!
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${RAW_KEY}`, 'x-api-key': RAW_KEY, Accept: 'application/json' } })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Neither the key nor its hash (which LiteLLM accepts as a credential) enters the record that crosses IPC.
    expect(JSON.stringify(spend)).not.toContain(RAW_KEY)
    expect(JSON.stringify(spend)).not.toContain(HASH)
  })
  it('absurd row values never sum to Infinity: the did-not-answer note instead', async () => {
    const huge = { results: [{ date: '2026-11-03', metrics: { spend: 1e308 } }, { date: '2026-11-04', metrics: { spend: 1e308 } }] }
    const spend = await run(proxy(() => json(huge)))
    expect(spend).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.failed })
    oneOf(spend)
  })
  it('falls back to the paginated route on 404 with the same query', async () => {
    const f = proxy(() => json({ detail: 'Not Found' }, 404), () => json({ ...(fx('litellm-daily-activity.json') as object), metadata: { page: 1, total_pages: 1, has_more: false } }))
    expect(await run(f)).toEqual({ ...KEY_INFO, periods: FIXTURE_PERIODS })
    const query = `?start_date=2026-11-01&end_date=2026-11-04&api_key=${HASH}`
    expect(dailyCalls(f)).toEqual([`${BASE}/user/daily/activity/aggregated${query}`, `${BASE}/user/daily/activity${query}`])
  })
  it('does not page: has_more true is the unsupported note', async () => {
    const f = proxy(() => json({}, 404), () => json({ results: [{ date: '2026-11-04', metrics: { spend: 1 } }], metadata: { page: 1, total_pages: 3, has_more: true } }))
    const spend = await run(f)
    expect(spend).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.unsupported })
    oneOf(spend)
    expect(dailyCalls(f)).toHaveLength(2)
  })
  it('403 on the aggregated route is the no-user note with no fallback', async () => {
    const paginated = vi.fn(() => json({}, 403))
    const f = proxy(() => json({ detail: 'User not found' }, 403), paginated)
    expect(await run(f)).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.noUser })
    expect(paginated).not.toHaveBeenCalled()
    expect(dailyCalls(f)).toHaveLength(1)
    // 403 on the paginated route after a 404 is the same note.
    expect(await run(proxy(() => json({}, 404), () => json({}, 403)))).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.noUser })
  })
  it('404 or 405 on both routes is the unsupported note', async () => {
    for (const status of [404, 405]) {
      const f = proxy(() => json({}, status), () => json({}, status))
      expect(await run(f)).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.unsupported })
      expect(dailyCalls(f)).toHaveLength(2)
    }
    expect(await run(proxy(() => json({}, 405), () => json({}, 404)))).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.unsupported })
  })
  it('other failures are the did-not-answer note and never carry the key', async () => {
    const failures: [string, Route][] = [
      ['500', () => json({ error: `no db for ${RAW_KEY}` }, 500),],
      ['401', () => json({}, 401)],
      ['network', () => { throw new TypeError(`down ${RAW_KEY}`) }],
      ['timeout', () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e }],
      ['redirect', () => { throw new TypeError('unexpected redirect') }],
      ['too large', () => new Response('x'.repeat(LITELLM_MAX_BODY_BYTES + 10), { status: 200 })],
      ['non-JSON', () => new Response('<html>', { status: 200 })],
      ['results not a list', () => json({ results: { '2026-11-04': 1 } })],
      ['bare array', () => json([])],
      ['null body', () => json(null)]
    ]
    for (const [name, aggregated] of failures) {
      const f = proxy(aggregated)
      const spend = await run(f)
      expect(spend, name).toEqual({ ...KEY_INFO, periodsNote: SPEND_PERIOD_NOTES.failed })
      expect(JSON.stringify(spend), name).not.toContain(RAW_KEY)
      expect(dailyCalls(f), name).toHaveLength(1)
    }
  })
  it('an empty results list is a success with zero periods', async () => {
    const spend = await run(proxy(() => json({ results: [], metadata: { total_spend: 0 } })))
    expect(spend).toEqual({ ...KEY_INFO, periods: { day: { usd: 0, since: Date.UTC(2026, 10, 4) }, week: { usd: 0, since: Date.UTC(2026, 10, 2) }, month: { usd: 0, since: Date.UTC(2026, 10, 1) } } })
    oneOf(spend)
    // Junk rows only: the same.
    expect((await run(proxy(() => json({ results: ['x', null, { date: 'bad' }] }))))?.periods).toEqual(spend!.periods)
  })
  it('computes the periods from the instant it is given', async () => {
    const spend = await run(proxy(() => json(fx('litellm-daily-activity.json'))), Date.parse('2026-11-01T10:00:00Z'))
    expect(spend?.periods).toEqual({ day: { usd: 1.5, since: Date.UTC(2026, 10, 1) }, week: { usd: 9.5, since: Date.UTC(2026, 9, 26) }, month: { usd: 1.5, since: Date.UTC(2026, 10, 1) } })
  })
  it('a /key/info failure still throws without the key, and no spend means null', async () => {
    const aggregated = vi.fn(() => json({ results: [] }))
    const err = await run(proxy(aggregated, undefined, () => json({ error: `bad ${RAW_KEY}` }, 500))).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toMatch(/500 from \/key\/info/)
    expect(String(err)).not.toContain(RAW_KEY)
    expect(aggregated).not.toHaveBeenCalled()
    const down = await run(proxy(aggregated, undefined, () => { throw new TypeError(`down ${RAW_KEY}`) })).catch((e: Error) => e)
    expect(String(down)).toBe('Error: Could not reach localhost:4000')
    expect(await run(proxy(aggregated, undefined, () => json({ info: { spend: 'lots' } })))).toBeNull()
    expect(aggregated).not.toHaveBeenCalled()
  })
})
