import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePrice } from '../runtime/pricing'
import { COMMUNITY_MAX_BYTES, CommunityPrices, parseCommunityPrices } from './communityPrices'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orgai-cp-'))
  dirs.push(d)
  return d
}

const LIST = {
  sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1 },
  'gpt-6': { mode: 'chat', input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000005 },
  'openai/gpt-6-mini': { mode: 'responses', input_cost_per_token: 0.0000004, output_cost_per_token: 0.0000016 },
  'text-embedding-9': { mode: 'embedding', input_cost_per_token: 0.0000001, output_cost_per_token: 0 },
  'no-mode-model': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000003 },
  broken: { mode: 'chat', input_cost_per_token: 'free', output_cost_per_token: 1 },
  negative: { mode: 'chat', input_cost_per_token: -1, output_cost_per_token: 1 }
}

describe('parseCommunityPrices', () => {
  it('keeps chat and responses entries with valid prices only', () => {
    const out = parseCommunityPrices(LIST)
    expect(Object.keys(out).sort()).toEqual(['gpt-6', 'no-mode-model', 'openai/gpt-6-mini'])
    expect(out['gpt-6']).toEqual({ inputPerToken: 0.000002, outputPerToken: 0.00001, cacheReadPerToken: 0.0000005 })
  })

  it('skips prototype keys, long keys and junk, and returns a null-prototype object', () => {
    const raw = JSON.parse(
      `{"__proto__":{"input_cost_per_token":1,"output_cost_per_token":1},"constructor":{"input_cost_per_token":1,"output_cost_per_token":1},"prototype":{"input_cost_per_token":1,"output_cost_per_token":1},"${'k'.repeat(201)}":{"input_cost_per_token":1,"output_cost_per_token":1},"ok":{"input_cost_per_token":1e-6,"output_cost_per_token":2e-6},"arr":[1]}`
    )
    const out = parseCommunityPrices(raw)
    expect(Object.keys(out)).toEqual(['ok'])
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(parseCommunityPrices(null)).toEqual({})
    expect(parseCommunityPrices([1, 2])).toEqual({})
  })

  it('caps the entry count', () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 20_050; i++) big[`m${i}`] = { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 }
    expect(Object.keys(parseCommunityPrices(big))).toHaveLength(20_000)
  })
})

const okFetch = (body: unknown, init?: ResponseInit) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init)) as unknown as typeof fetch

describe('CommunityPrices', () => {
  it('fetches with redirect: error and a timeout signal, caches to disk, and reloads at boot', async () => {
    const dir = tmp()
    const fetchFn = vi.fn(okFetch(LIST))
    const cp = new CommunityPrices({ dataDir: dir, enabled: () => true, fetch: fetchFn as unknown as typeof fetch, now: () => 5000 })
    expect(cp.get()).toBeUndefined()
    expect(await cp.refresh()).toBe(true)
    const init = fetchFn.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(cp.get()?.['gpt-6']).toBeDefined()
    const file = JSON.parse(readFileSync(join(dir, 'model-prices.json'), 'utf8'))
    expect(file).toMatchObject({ version: 1, fetchedAt: 5000 })
    const again = new CommunityPrices({ dataDir: dir, enabled: () => true })
    expect(again.get()?.['no-mode-model']).toBeDefined()
    expect(again.lastFetchedAt).toBe(5000)
  })

  it('fetches at most once per staleness window', async () => {
    let now = 0
    const fetchFn = vi.fn(okFetch(LIST))
    const cp = new CommunityPrices({ dataDir: tmp(), enabled: () => true, fetch: fetchFn as unknown as typeof fetch, now: () => now })
    now = 1000
    expect(await cp.refresh()).toBe(true)
    now = 1000 + 23 * 3600_000
    expect(await cp.refresh()).toBe(false)
    now = 1000 + 25 * 3600_000
    expect(await cp.refresh()).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the setting is off, and hides cached prices', async () => {
    const dir = tmp()
    const on = new CommunityPrices({ dataDir: dir, enabled: () => true, fetch: okFetch(LIST) })
    await on.refresh()
    let enabled = false
    const fetchFn = vi.fn(okFetch(LIST))
    const off = new CommunityPrices({ dataDir: dir, enabled: () => enabled, fetch: fetchFn as unknown as typeof fetch, now: () => Date.now() + 10 * 24 * 3600_000 })
    expect(off.get()).toBeUndefined()
    expect(await off.refresh()).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    enabled = true
    expect(off.get()).toBeDefined()
  })

  it('keeps the last good cache on a redirect error, junk JSON, HTTP error and oversize bodies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = tmp()
    let now = 0
    let next: typeof fetch = okFetch(LIST)
    const cp = new CommunityPrices({ dataDir: dir, enabled: () => true, fetch: ((...a: Parameters<typeof fetch>) => next(...a)) as typeof fetch, now: () => now })
    now = 1
    await cp.refresh()
    const good = JSON.stringify(cp.get())
    const failures: typeof fetch[] = [
      (async () => {
        throw new TypeError('redirect mode is set to error')
      }) as unknown as typeof fetch,
      okFetch('{not json'),
      okFetch('[]'),
      okFetch('nope', { status: 500 }),
      okFetch('{}', { headers: { 'content-length': String(COMMUNITY_MAX_BYTES + 1) } }),
      okFetch(' '.repeat(COMMUNITY_MAX_BYTES + 10))
    ]
    for (const f of failures) {
      now += 48 * 3600_000
      next = f
      expect(await cp.refresh()).toBe(false)
      expect(JSON.stringify(cp.get())).toBe(good)
    }
    expect(JSON.parse(readFileSync(join(dir, 'model-prices.json'), 'utf8')).fetchedAt).toBe(1)
    expect(warn).toHaveBeenCalled()
  })

  it('sanitizes a tampered cache file at boot', () => {
    const dir = tmp()
    writeFileSync(
      join(dir, 'model-prices.json'),
      '{"version":1,"fetchedAt":1,"prices":{"__proto__":{"inputPerToken":1,"outputPerToken":1},"good":{"inputPerToken":0.000001,"outputPerToken":0.000002},"bad":{"inputPerToken":-5,"outputPerToken":1}}}'
    )
    const cp = new CommunityPrices({ dataDir: dir, enabled: () => true })
    expect(Object.keys(cp.get()!)).toEqual(['good'])
  })

  it('ignores an unreadable cache file', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = tmp()
    writeFileSync(join(dir, 'model-prices.json'), 'garbage')
    expect(new CommunityPrices({ dataDir: dir, enabled: () => true }).get()).toBeUndefined()
  })

  it('does not overlap refreshes and stops timers on dispose', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn(okFetch(LIST))
      const cp = new CommunityPrices({ dataDir: tmp(), enabled: () => true, fetch: fetchFn as unknown as typeof fetch })
      const [a, b] = await Promise.all([cp.refresh(), cp.refresh()])
      expect([a, b].filter(Boolean)).toHaveLength(1)
      const cp2 = new CommunityPrices({ dataDir: tmp(), enabled: () => true, fetch: fetchFn as unknown as typeof fetch })
      cp2.start({ bootDelayMs: 10, checkEveryMs: 10, staleAfterMs: 0 })
      cp2.dispose()
      const calls = fetchFn.mock.calls.length
      await vi.advanceTimersByTimeAsync(100)
      expect(fetchFn.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('community price resolution', () => {
  const community = parseCommunityPrices(LIST)
  it('is tried after the builtin table, tolerating prefixes and dates', () => {
    expect(resolvePrice('gpt-6', { overrides: [], community })).toMatchObject({ source: 'community', price: { inputPerToken: 0.000002 } })
    expect(resolvePrice('gpt-6-mini', { overrides: [], community })?.source).toBe('community')
    expect(resolvePrice('gpt-6-20260101', { overrides: [], community })?.source).toBe('community')
    expect(resolvePrice('unknown-model', { overrides: [], community })).toBeNull()
    expect(resolvePrice('gpt-6', { overrides: [] })).toBeNull()
  })

  it('never beats an override or the builtin table', () => {
    const shadow = { 'claude-sonnet-4-5': { inputPerToken: 9, outputPerToken: 9 }, 'my-model': { inputPerToken: 9, outputPerToken: 9 } }
    expect(resolvePrice('claude-sonnet-4-5', { overrides: [], community: shadow })?.source).toBe('builtin')
    expect(resolvePrice('my-model', { connection: 'litellm', overrides: [{ connection: 'litellm', model: 'my-model', price: { inputPerToken: 1, outputPerToken: 1 } }], community: shadow })?.source).toBe('override')
  })
})
