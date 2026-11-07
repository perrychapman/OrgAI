import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROXIES_MAX } from '@shared/types'
import type { ConnectionEvent, ProxyConnection, UsageStatus } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { LITELLM_KEY, SecretStore, proxySecretKey } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { ConnectionService, type ConnectionServiceDeps } from './service'
import { MOCK_BAD_KEY, MOCK_PROXY_HOST } from './proxy'

const KEY_A = 'sk-alpha-secret-1'
const KEY_B = 'sk-bravo-secret-2'
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** A fetch that answers per host: each proxy lists its own models; every URL is recorded. */
function hostFetch(lists: Record<string, string[]>, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url))
    calls.push(String(url))
    const ids = lists[u.host]
    if (!ids) throw new TypeError('down')
    if (u.pathname.endsWith('/models')) return json({ data: ids.map((id) => ({ id, owned_by: id.startsWith('gpt') ? 'openai' : 'x' })) })
    return json({}, 404)
  }) as unknown as typeof fetch
}

function setup(over: Partial<ConnectionServiceDeps> = {}, dir?: string) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'orgai-proxies-'))
  if (!dir) dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  const projects = new ProjectStore(dataDir)
  const secrets = new SecretStore(dataDir, {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(p, 'utf8'),
    decryptString: (b) => b.toString('utf8')
  })
  const events: ConnectionEvent[] = []
  const logs: string[] = []
  const service = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets,
    broadcast: (e) => events.push(e),
    openExternal: vi.fn(async () => {}),
    fetch: hostFetch({}),
    anthropicProbe: async () => ({ state: 'disconnected', detail: 'x' }),
    logInfo: (m) => logs.push(m),
    now: () => 1000,
    ...over
  })
  return { dataDir, settings, projects, secrets, events, logs, service }
}

const projectOn = (id: string, connection: string, name = id) =>
  project({ id, name, provider: { id: 'claude', label: 'x', auth: { kind: 'subscription' }, connection }, roles: [role({ id: 'r0', slug: 'r0', model: 'm', reportsTo: null })] })

describe('createProxy', () => {
  it('adds a named, enabled, not-yet-connected proxy and announces it', async () => {
    const ctx = setup()
    ctx.events.length = 0
    const info = await ctx.service.createProxy({ name: ' Team   gateway ', anthropicBaseUrl: 'https://gw.example.com/', apiKey: KEY_A })
    const c = info.connection as ProxyConnection
    expect(c).toMatchObject({ name: 'Team gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://gw.example.com', enabled: true, hasApiKey: true, tierModels: {} })
    expect(c.id).toMatch(/^proxy-[0-9a-f]{8}$/)
    expect(info.status).toMatchObject({ state: 'disconnected', detail: 'Not connected yet. Test and connect.' })
    expect(ctx.settings.get().proxies).toHaveLength(1)
    expect(ctx.secrets.get(proxySecretKey(c.id))).toBe(KEY_A)
    expect(ctx.events.some((e) => e.type === 'connections.changed')).toBe(true)
    expect((await ctx.service.list()).map((i) => i.connection.id)).toEqual(['anthropic', 'openai', c.id])
    // A new proxy is tentative: it never becomes the automatic default before a definite answer.
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    expect(JSON.stringify([info, ctx.events])).not.toContain(KEY_A)
  })

  it('refuses a duplicate name (any case), an invalid name or URL, an unknown kind and a bad key', async () => {
    const ctx = setup()
    await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com' })
    await expect(ctx.service.createProxy({ name: 'gateway', anthropicBaseUrl: 'https://other.example.com' })).rejects.toThrow(/already exists/)
    await expect(ctx.service.createProxy({ name: '', anthropicBaseUrl: 'https://x.example.com' })).rejects.toThrow(/name/)
    await expect(ctx.service.createProxy({ name: 'A', anthropicBaseUrl: 'http://x.example.com' })).rejects.toThrow(/https/)
    await expect(ctx.service.createProxy({ name: 'B', anthropicBaseUrl: 'https://u:p@x.example.com' })).rejects.toThrow(/user name or password/)
    await expect(ctx.service.createProxy({ name: 'C', anthropicBaseUrl: 'https://x.example.com', modelsUrl: 'https://x.example.com/m?k=1' })).rejects.toThrow(/Models URL/)
    await expect(ctx.service.createProxy({ name: 'D', anthropicBaseUrl: 'https://x.example.com', kind: 'bogus' as never })).rejects.toThrow(/kind/)
    await expect(ctx.service.createProxy({ name: 'E', anthropicBaseUrl: 'https://x.example.com', apiKey: 'a\nb' })).rejects.toThrow(/control or hidden/)
    expect(ctx.settings.get().proxies).toHaveLength(1)
    expect(ctx.secrets.keys('connection:')).toEqual([])
  })

  it('stops at PROXIES_MAX', async () => {
    const ctx = setup()
    for (let i = 0; i < PROXIES_MAX; i++) await ctx.service.createProxy({ name: `P${i}`, anthropicBaseUrl: `https://p${i}.example.com` })
    await expect(ctx.service.createProxy({ name: 'one more', anthropicBaseUrl: 'https://more.example.com' })).rejects.toThrow(/at most 20/)
    expect(ctx.settings.get().proxies).toHaveLength(PROXIES_MAX)
  })

  it('generates distinct ids and never reuses a removed one in this session', async () => {
    const ctx = setup()
    const a = (await ctx.service.createProxy({ name: 'A', anthropicBaseUrl: 'https://a.example.com' })).connection.id
    await ctx.service.removeProxy(a)
    const b = (await ctx.service.createProxy({ name: 'B', anthropicBaseUrl: 'https://b.example.com' })).connection.id
    expect(b).not.toBe(a)
  })
})

describe('two proxies are independent', () => {
  it('discovers and tracks catalogs, statuses, keys and defaults per proxy', async () => {
    const calls: string[] = []
    const ctx = setup({ fetch: hostFetch({ 'a.example.com': ['claude-opus-5', 'gpt-6-sol'], 'b.example.com': ['qwen38'] }, calls) })
    const a = (await ctx.service.createProxy({ name: 'Alpha', anthropicBaseUrl: 'https://a.example.com', apiKey: KEY_A })).connection.id
    const b = (await ctx.service.createProxy({ name: 'Bravo', anthropicBaseUrl: 'https://b.example.com', apiKey: KEY_B })).connection.id
    expect((await ctx.service.connect(a)).status.state).toBe('connected')
    expect((await ctx.service.connect(b)).status.state).toBe('connected')
    expect(ctx.service.models({ connection: a }).map((m) => m.id)).toEqual(['claude-opus-5', 'gpt-6-sol'])
    expect(ctx.service.models({ connection: b }).map((m) => m.id)).toEqual(['qwen38'])
    expect(ctx.service.models({ connection: a }).every((m) => m.connection === a)).toBe(true)
    // Two connected proxies, Anthropic disconnected: still the stored default (undecided), never an arbitrary proxy.
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    // Each key went only to its own host.
    expect(calls.filter((u) => u.includes('a.example.com')).length).toBeGreaterThan(0)
    // Tier mapping is per proxy.
    expect(ctx.settings.get().proxies.find((p) => p.id === a)!.tierModels).toMatchObject({ deep: 'claude-opus-5' })
    // One proxy failing leaves the other alone.
    const down = setup({ fetch: hostFetch({ 'b.example.com': ['qwen38'] }) }, ctx.dataDir)
    expect((await down.service.test(a)).state).toBe('error')
    expect((await down.service.test(b)).state).toBe('connected')
    // The catalog survives a restart per connection.
    expect(down.service.models({ connection: b }).map((m) => m.id)).toEqual(['qwen38'])
    expect(down.service.catalog().filter((m) => m.connection === a).map((m) => m.id)).toEqual(['claude-opus-5', 'gpt-6-sol'])
  })

  it('scheduled discovery refreshes every configured proxy', async () => {
    const ctx = setup({ fetch: hostFetch({ 'a.example.com': ['m-a'], 'b.example.com': ['m-b'] }) })
    const a = (await ctx.service.createProxy({ name: 'Alpha', anthropicBaseUrl: 'https://a.example.com', apiKey: KEY_A })).connection.id
    const b = (await ctx.service.createProxy({ name: 'Bravo', anthropicBaseUrl: 'https://b.example.com', apiKey: KEY_B })).connection.id
    await ctx.service.discoverStale()
    expect(ctx.service.models({ connection: a }).map((m) => m.id)).toEqual(['m-a'])
    expect(ctx.service.models({ connection: b }).map((m) => m.id)).toEqual(['m-b'])
  })

  it('run connections use each proxy\'s own URLs and key', async () => {
    const ctx = setup({ fetch: hostFetch({ 'a.example.com': ['claude-opus-5', 'gpt-6-sol'], 'b.example.com': ['qwen38'] }) })
    const a = (await ctx.service.createProxy({ name: 'Alpha', anthropicBaseUrl: 'https://a.example.com/', openaiBaseUrl: 'https://a.example.com/openai/v1', apiKey: KEY_A })).connection.id
    const b = (await ctx.service.createProxy({ name: 'Bravo', anthropicBaseUrl: 'https://b.example.com', apiKey: KEY_B })).connection.id
    await ctx.service.connect(a)
    await ctx.service.connect(b)
    const p = projectOn('p1', a)
    const claude = ctx.service.runConnection(p, { adapter: 'claude', connection: a, mismatched: [] })
    expect(claude.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://a.example.com', ANTHROPIC_AUTH_TOKEN: KEY_A, ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5' })
    expect(claude.pricing).toBeUndefined()
    const codex = ctx.service.runConnection(p, { adapter: 'codex', connection: a, mismatched: [] })
    expect(codex).toMatchObject({ codexAuth: 'apiKey', apiKey: KEY_A, openaiBaseUrl: 'https://a.example.com/openai/v1' })
    const codexB = ctx.service.runConnection(projectOn('p2', b), { adapter: 'codex', connection: b, mismatched: [] })
    expect(codexB).toMatchObject({ apiKey: KEY_B, openaiBaseUrl: 'https://b.example.com/v1' })
  })
})

describe('openai-compatible proxies never call LiteLLM routes', () => {
  it('probe, connect and refresh only GET the models URL; no spend probe', async () => {
    const calls: string[] = []
    const ctx = setup({ fetch: hostFetch({ 'gw.example.com': ['claude-opus-5'] }, calls), now: () => Date.UTC(2026, 10, 4, 15) })
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection.id
    await ctx.service.connect(id)
    await ctx.service.refresh({ connection: id })
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: id })
    expect(await ctx.service.probeProxyUsages()).toEqual([])
    expect(calls.length).toBeGreaterThan(0)
    for (const u of calls) expect(new URL(u).pathname).toBe('/v1/models')
  })

  it('a litellm-kind proxy gets a UsageStatus keyed by its own id', async () => {
    const f = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/key/info')) return json({ info: { spend: 3, max_budget: 10 } })
      if (u.includes('/user/daily/activity')) return json({ results: [] })
      return json({ data: [{ id: 'claude-opus-5' }] })
    }) as unknown as typeof fetch
    const ctx = setup({ fetch: f, now: () => Date.UTC(2026, 10, 4, 15) })
    const id = (await ctx.service.createProxy({ name: 'Lite', kind: 'litellm', anthropicBaseUrl: 'https://lite.example.com', apiKey: KEY_A })).connection.id
    await ctx.service.connect(id)
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: id })
    const out: UsageStatus[] = await ctx.service.probeProxyUsages()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ connection: id, authMode: 'apiKey', spend: { usd: 3, budgetUsd: 10 } })
  })
})

describe('secrets', () => {
  it("keeps the secret key name of the migrated 'litellm' proxy", () => {
    expect(proxySecretKey('litellm')).toBe(LITELLM_KEY)
    expect(proxySecretKey('proxy-0a1b2c3d')).toBe('connection:proxy-0a1b2c3d:apiKey')
  })

  it('a migrated litellm proxy finds the key stored before proxies existed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orgai-proxies-'))
    dirs.push(dataDir)
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { defaultConnection: 'litellm', defaultConnectionChosen: true, connections: { litellm: { id: 'litellm', enabled: true, baseUrl: 'https://llm.example.com', hasApiKey: true, tierModels: {} } } } })
    )
    const cipher = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p, 'utf8'), decryptString: (b: Buffer) => b.toString('utf8') }
    new SecretStore(dataDir, cipher).set(LITELLM_KEY, KEY_A)
    const ctx = setup({ fetch: hostFetch({ 'llm.example.com': ['claude-opus-5'] }) }, dataDir)
    expect(ctx.settings.get().proxies[0]).toMatchObject({ id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: 'https://llm.example.com', hasApiKey: true })
    expect((await ctx.service.test('litellm')).state).toBe('connected')
    expect(ctx.service.effectiveDefault()).toBe('litellm')
  })

  it('setSecret validates, stores under the proxy id, clears, and refuses non-proxies', async () => {
    const ctx = setup()
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com' })).connection.id
    const set = await ctx.service.setSecret({ id, apiKey: ` ${KEY_A} ` })
    expect((set.connection as ProxyConnection).hasApiKey).toBe(true)
    expect(set.status.detail).toBe('Key saved. Test and connect to apply.')
    expect(ctx.secrets.get(proxySecretKey(id))).toBe(KEY_A)
    await expect(ctx.service.setSecret({ id, apiKey: 'x'.repeat(4001) })).rejects.toThrow(/too long/)
    await expect(ctx.service.setSecret({ id, apiKey: 'a​b' })).rejects.toThrow(/hidden/)
    expect(ctx.secrets.get(proxySecretKey(id))).toBe(KEY_A)
    await expect(ctx.service.setSecret({ id: 'anthropic', apiKey: 'k' })).rejects.toThrow(/Only proxy connections/)
    for (const bad of ['proxy-ffffffff', '__proto__', 'constructor', 'toString']) {
      await expect(ctx.service.setSecret({ id: bad, apiKey: 'k' })).rejects.toThrow('Unknown connection')
    }
    const cleared = await ctx.service.setSecret({ id, apiKey: null })
    expect((cleared.connection as ProxyConnection).hasApiKey).toBe(false)
    expect(ctx.secrets.get(proxySecretKey(id))).toBeUndefined()
  })

  it('says Unknown connection for anything that is not built-in or an existing proxy, prototype keys included', async () => {
    const ctx = setup()
    for (const bad of ['proxy-ffffffff', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'litellm']) {
      await expect(ctx.service.test(bad)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.connect(bad)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.logout(bad)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.setDefault(bad)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.removeProxy(bad)).rejects.toThrow('Unknown connection')
      await expect(ctx.service.refresh({ connection: bad })).rejects.toThrow('Unknown connection')
      expect(() => ctx.service.models({ connection: bad })).toThrow('Unknown connection')
    }
    await expect(ctx.service.removeProxy('anthropic')).rejects.toThrow('Unknown connection')
  })

  it('no key reaches an error, a status, an event, the log or settings.json', async () => {
    const f = (async () => {
      throw new TypeError(`connect failed with ${KEY_A}`)
    }) as unknown as typeof fetch
    const ctx = setup({ fetch: f })
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection.id
    const status = await ctx.service.test(id)
    expect(status.state).toBe('error')
    const info = await ctx.service.connect(id)
    ctx.settings.set({ ...ctx.settings.get(), notifications: false })
    const blob = JSON.stringify([status, info, ctx.events, ctx.logs, await ctx.service.list(), readFileSync(join(ctx.dataDir, 'settings.json'), 'utf8')])
    expect(blob).not.toContain(KEY_A)
  })

  it('an unreadable stored key probes as error, not a definite disconnect', async () => {
    const ctx = setup()
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection.id
    ctx.secrets.delete(proxySecretKey(id))
    expect(ctx.settings.get().proxies[0].hasApiKey).toBe(true)
    const status = await ctx.service.test(id)
    expect(status).toMatchObject({ state: 'error', detail: 'The stored key could not be read. Set the API key again.' })
  })
})

describe('update of a proxy', () => {
  it('validates name and URLs, ignores id / kind / hasApiKey, and resets the status on a URL or name change', async () => {
    const ctx = setup({ fetch: hostFetch({ 'gw.example.com': ['claude-opus-5'] }) })
    const created = await ctx.service.createProxy({ name: 'Gateway', kind: 'litellm', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })
    const c = created.connection as ProxyConnection
    await ctx.service.connect(c.id)
    const edited = await ctx.service.update({ ...c, kind: 'openai-compatible', hasApiKey: false, name: 'Gateway', enabled: true } as ProxyConnection)
    expect(edited.connection).toMatchObject({ id: c.id, kind: 'litellm', hasApiKey: true })
    expect(edited.status.state).toBe('connected') // nothing that matters changed
    const renamed = await ctx.service.update({ ...c, name: 'Renamed', modelsUrl: 'https://gw.example.com/catalog/models/' })
    expect(renamed.connection).toMatchObject({ name: 'Renamed', modelsUrl: 'https://gw.example.com/catalog/models' })
    expect(renamed.status).toMatchObject({ state: 'disconnected', detail: 'Changed. Test and connect to apply.' })
    await expect(ctx.service.update({ ...c, anthropicBaseUrl: 'http://gw.example.com' })).rejects.toThrow(/Base URL/)
    await expect(ctx.service.update({ ...c, openaiBaseUrl: 'https://x.example.com/?a=1' })).rejects.toThrow(/OpenAI base URL/)
    await ctx.service.createProxy({ name: 'Second', anthropicBaseUrl: 'https://two.example.com' })
    await expect(ctx.service.update({ ...c, name: 'second' })).rejects.toThrow(/already exists/)
    await expect(ctx.service.update({ ...c, id: 'proxy-ffffffff' })).rejects.toThrow('Unknown connection') // the id picks the record; it must exist
  })

  it('clearing the base URL is allowed and leaves the proxy unconfigured', async () => {
    const ctx = setup()
    const c = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection as ProxyConnection
    const out = await ctx.service.update({ ...c, anthropicBaseUrl: '' })
    expect((out.connection as ProxyConnection).anthropicBaseUrl).toBe('')
  })
})

describe('removeProxy', () => {
  it('refuses while a project uses it, naming up to 5 projects', async () => {
    const ctx = setup()
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com' })).connection.id
    for (const n of ['Aa', 'Bb', 'Cc', 'Dd', 'Ee', 'Ff', 'Gg']) ctx.projects.save(projectOn(`p-${n}`, id, n))
    ctx.projects.save(projectOn('p-other', 'anthropic', 'Other'))
    const err = await ctx.service.removeProxy(id).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/^Gateway is used by /)
    expect((err as Error).message).toMatch(/ and 2 more\. Move those projects to another connection first\.$/)
    expect((err as Error).message).not.toContain('Other')
    expect(ctx.settings.get().proxies).toHaveLength(1)
    for (const n of ['Ff', 'Gg']) ctx.projects.remove(`p-${n}`)
    for (const n of ['Dd', 'Ee']) ctx.projects.remove(`p-${n}`)
    const three = await ctx.service.removeProxy(id).catch((e: Error) => e)
    expect((three as Error).message).toMatch(/^Gateway is used by (Aa|Bb|Cc), (Aa|Bb|Cc), (Aa|Bb|Cc)\. Move those projects to another connection first\.$/)
  })

  it('deletes the record, key, catalog entries and status; the other proxy is untouched', async () => {
    const ctx = setup({ fetch: hostFetch({ 'a.example.com': ['m-a'], 'b.example.com': ['m-b'] }) })
    const a = (await ctx.service.createProxy({ name: 'Alpha', anthropicBaseUrl: 'https://a.example.com', apiKey: KEY_A })).connection.id
    const b = (await ctx.service.createProxy({ name: 'Bravo', anthropicBaseUrl: 'https://b.example.com', apiKey: KEY_B })).connection.id
    await ctx.service.connect(a)
    await ctx.service.connect(b)
    ctx.events.length = 0
    const out = await ctx.service.removeProxy(a)
    expect(out.connections.map((i) => i.connection.id)).toEqual(['anthropic', 'openai', b])
    expect(ctx.settings.get().proxies.map((p) => p.id)).toEqual([b])
    expect(ctx.secrets.get(proxySecretKey(a))).toBeUndefined()
    expect(ctx.secrets.get(proxySecretKey(b))).toBe(KEY_B)
    expect(ctx.service.catalog().some((m) => m.connection === a)).toBe(false)
    expect(ctx.service.models({ connection: b }).map((m) => m.id)).toEqual(['m-b'])
    expect(ctx.events.some((e) => e.type === 'connections.changed')).toBe(true)
    const stored = JSON.parse(readFileSync(join(ctx.dataDir, 'models.json'), 'utf8')) as { models: Record<string, unknown>; refreshedAt: Record<string, unknown> }
    expect(Object.keys(stored.models)).not.toContain(a)
    expect(Object.keys(stored.refreshedAt)).not.toContain(a)
    await expect(ctx.service.test(a)).rejects.toThrow('Unknown connection')
  })

  it('a chosen default pointing at it returns to automatic, and a replaced pointer is cleared', async () => {
    const ctx = setup({ fetch: hostFetch({ 'gw.example.com': ['claude-opus-5'] }), anthropicProbe: async () => ({ state: 'connected' }) })
    const id = (await ctx.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection.id
    await ctx.service.test('anthropic')
    await ctx.service.connect(id)
    await ctx.service.setDefault(id)
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: id, defaultConnectionChosen: true })
    await ctx.service.removeProxy(id)
    expect(ctx.settings.get()).toMatchObject({ defaultConnection: 'anthropic', defaultConnectionChosen: false })
    expect(ctx.service.effectiveDefault()).toBe('anthropic')
    // Replaced pointer: automatic default moved to the proxy, then the proxy goes.
    const probe = { state: 'connected' as 'connected' | 'disconnected' }
    const ctx2 = setup({ fetch: hostFetch({ 'gw.example.com': ['claude-opus-5'] }), anthropicProbe: async () => ({ ...probe }) })
    const id2 = (await ctx2.service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com', apiKey: KEY_A })).connection.id
    probe.state = 'disconnected'
    await ctx2.service.test('anthropic')
    await ctx2.service.connect(id2)
    expect(ctx2.settings.get()).toMatchObject({ defaultConnection: id2, defaultConnectionReplaced: 'anthropic' })
    await ctx2.service.removeProxy(id2)
    expect(ctx2.settings.get().defaultConnection).toBe('anthropic')
    expect(ctx2.settings.get().defaultConnectionReplaced).toBeUndefined()
  })
})

describe('models.json and old files', () => {
  it('tolerates entries of unknown ids and junk in an old models.json', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'orgai-proxies-'))
    dirs.push(dataDir)
    writeFileSync(
      join(dataDir, 'models.json'),
      JSON.stringify({ version: 1, models: { 'proxy-ffffffff': [{ id: 'm', connection: 'proxy-ffffffff' }], __proto__: 5, litellm: 'nope', junk: [] }, refreshedAt: { 'proxy-ffffffff': 5, litellm: 'x' } })
    )
    const ctx = setup({}, dataDir)
    expect(ctx.service.catalog().some((m) => m.connection === 'proxy-ffffffff')).toBe(false)
  })
})

describe('mock proxy host (ORGAI_MOCK=1)', () => {
  it('connects with any key without network, lists mixed families and answers the bad key with a 401 text', async () => {
    vi.stubEnv('ORGAI_MOCK', '1')
    const f = vi.fn(async () => {
      throw new Error('network must not be used')
    })
    const ctx = setup({ fetch: f as unknown as typeof fetch })
    const id = (await ctx.service.createProxy({ name: 'Mock proxy', anthropicBaseUrl: `https://${MOCK_PROXY_HOST}`, apiKey: 'whatever' })).connection.id
    const info = await ctx.service.connect(id)
    expect(info.status).toMatchObject({ state: 'connected', detail: '9 models available' })
    expect(info.modelCount).toBe(9)
    const families = new Set(ctx.service.models({ connection: id }).map((m) => m.family))
    expect(families).toEqual(new Set(['claude', 'openai', 'other']))
    // Tiers fill from the list (claude ids carry tiers).
    expect(ctx.settings.get().proxies[0].tierModels).toMatchObject({ deep: 'claude-opus-5' })
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: id })
    expect(await ctx.service.probeProxyUsages()).toEqual([])
    expect(f).not.toHaveBeenCalled()

    await ctx.service.setSecret({ id, apiKey: MOCK_BAD_KEY })
    const bad = await ctx.service.connect(id)
    expect(bad.status).toMatchObject({ state: 'error', detail: 'The key was refused (401).' })
  })

  it('is an ordinary unreachable host without ORGAI_MOCK', async () => {
    const ctx = setup({ fetch: hostFetch({}) })
    const id = (await ctx.service.createProxy({ name: 'Mock proxy', anthropicBaseUrl: `https://${MOCK_PROXY_HOST}`, apiKey: 'whatever' })).connection.id
    expect((await ctx.service.test(id)).state).toBe('error')
  })
})
