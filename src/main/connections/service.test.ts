import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForProject, newProject } from '@shared/defaults'
import type { ConnectionEvent, Project, ProxyConnection } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { ConnectionService, type ConnectionServiceDeps } from './service'
import { SPEND_PERIOD_NOTES, keyHash } from './litellm'
import { asCodexServer, fakeRpc, type FakeRpc } from './testHelpers'

const KEY = 'sk-super-secret-key'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const proxyFetch = (async (url: string | URL | Request) =>
  String(url).endsWith('/v1/models')
    ? json({ data: [{ id: 'claude-opus-4-5' }, { id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }, { id: 'gpt-5' }, { id: 'gpt-5-mini' }] })
    : json({ data: [] })) as unknown as typeof fetch

function setup(over: Partial<ConnectionServiceDeps> = {}, dir?: string) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'orgai-conn-'))
  if (!dir) dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  if (!settings.get().proxies.length) settings.setProxies([{ id: 'litellm', name: 'LiteLLM', kind: 'litellm', anthropicBaseUrl: '', enabled: false, hasApiKey: false, tierModels: {} }])
  const projects = new ProjectStore(dataDir)
  const secrets = new SecretStore(dataDir, {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(p, 'utf8'),
    decryptString: (b) => b.toString('utf8')
  })
  const events: ConnectionEvent[] = []
  const openExternal = vi.fn(async () => {})
  const service = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets,
    broadcast: (e) => events.push(e),
    openExternal,
    fetch: proxyFetch,
    anthropicProbe: async () => ({ state: 'connected', detail: 'Claude Code login' }),
    // Never look for or run a real codex (cli-standalone 6.2 runtime check).
    codexRuntime: async () => ({ ok: true, binary: { path: '/fake/codex' } }),
    now: () => 1000,
    ...over
  })
  return { dataDir, settings, projects, secrets, events, service, openExternal }
}

function litellmProject(models: [string, 'top' | 'deep' | 'everyday' | 'fast' | undefined][]): Project {
  return project({
    provider: { id: 'claude', label: 'LiteLLM', auth: { kind: 'subscription' }, connection: 'litellm' },
    roles: models.map(([model, tier], i) => role({ id: `r${i}`, slug: `r${i}`, model, tier, reportsTo: i === 0 ? null : 'r0' }))
  })
}

async function configureLiteLLM(ctx: ReturnType<typeof setup>): Promise<void> {
  const conn = ctx.settings.get().proxies[0]
  await ctx.service.update({ ...conn, anthropicBaseUrl: 'http://localhost:4000/' })
  await ctx.service.setSecret({ id: 'litellm', apiKey: KEY })
}

describe('ConnectionService litellm', () => {
  it('connect discovers models, fills tierModels and remaps the connection\'s projects', async () => {
    const ctx = setup()
    ctx.projects.save(litellmProject([['sonnet', 'everyday'], ['haiku', 'fast'], ['claude-opus-4-5', 'deep']]))
    ctx.projects.save({ ...litellmProject([['sonnet', 'everyday']]), id: 'other', provider: { id: 'claude', label: 'x', auth: { kind: 'subscription' }, connection: 'anthropic' } })
    await configureLiteLLM(ctx)
    ctx.events.length = 0

    const info = await ctx.service.connect('litellm')
    expect(info.status).toMatchObject({ state: 'connected' })
    expect(info.connection.enabled).toBe(true)
    expect(info.modelCount).toBe(5)
    expect(info.connection.tierModels).toEqual({ deep: 'claude-opus-4-5', everyday: 'claude-sonnet-4-5', fast: 'claude-haiku-4-5' })

    const p = ctx.projects.get('p1')!
    expect(p.roles.map((r) => r.model)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'])
    expect(ctx.projects.get('other')!.roles[0].model).toBe('sonnet')
    const remap = ctx.events.find((e) => e.type === 'projects.remapped')
    expect(remap && remap.type === 'projects.remapped' && remap.results).toMatchObject([{ projectId: 'p1', connection: 'litellm', reason: 'connected' }])
    expect(ctx.events.map((e) => e.type)).toEqual(expect.arrayContaining(['connection.status', 'models.updated', 'projects.remapped']))
    expect(ctx.service.models({ connection: 'litellm' }).map((m) => m.id)).toContain('gpt-5')
  })

  it('persists discovered models across a restart', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const again = setup({}, ctx.dataDir)
    expect(again.service.models({ connection: 'litellm' })).toHaveLength(5)
    expect(again.service.catalog().some((m) => m.id === 'gpt-5' && m.connection === 'litellm')).toBe(true)
  })

  it('keeps proxy prices across a restart, drops a stored bad price, and lists them in prices()', async () => {
    const priceFetch = (async (url: string | URL | Request) =>
      String(url).endsWith('/v1/models')
        ? json({ data: [{ id: 'claude-opus-4-5' }, { id: 'gpt-5' }] })
        : json({ data: [{ model_name: 'claude-opus-4-5', model_info: { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } }] })) as unknown as typeof fetch
    const ctx = setup({ fetch: priceFetch })
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const again = setup({}, ctx.dataDir)
    expect(again.service.models({ connection: 'litellm' }).find((m) => m.id === 'claude-opus-4-5')?.price).toEqual({ inputPerToken: 5e-6, outputPerToken: 2.5e-5 })
    expect(again.service.models({ connection: 'litellm' }).find((m) => m.id === 'gpt-5')).not.toHaveProperty('price')
    expect(again.service.prices({ connection: 'litellm' }).filter((r) => r.source === 'proxy')).toEqual([
      { model: 'claude-opus-4-5', connection: 'litellm', price: { inputPerToken: 5e-6, outputPerToken: 2.5e-5 }, source: 'proxy' }
    ])

    const file = join(ctx.dataDir, 'models.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.models.litellm[0].price = { inputPerToken: -4, outputPerToken: 1e9 }
    writeFileSync(file, JSON.stringify(stored))
    const bad = setup({}, ctx.dataDir)
    expect(bad.service.models({ connection: 'litellm' }).find((m) => m.id === 'claude-opus-4-5')).not.toHaveProperty('price')
  })

  it('updating tierModels remaps that connection\'s projects, keeping explicit picks', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.projects.save(litellmProject([['claude-sonnet-4-5', 'everyday'], ['claude-haiku-4-5', 'everyday'], ['claude-opus-4-5', 'deep']]))
    ctx.events.length = 0
    const conn = ctx.settings.get().proxies[0]
    await ctx.service.update({ ...conn, tierModels: { ...conn.tierModels, everyday: 'claude-haiku-4-5' } })
    // r0 was on the old everyday default -> follows; r1 already is the new value; r2 is deep -> untouched.
    expect(ctx.projects.get('p1')!.roles.map((r) => r.model)).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'])
    const ev = ctx.events.find((e) => e.type === 'projects.remapped')
    expect(ev && ev.type === 'projects.remapped' && ev.results[0]).toMatchObject({ reason: 'tierModels', changes: [{ roleId: 'r0', from: 'claude-sonnet-4-5', to: 'claude-haiku-4-5' }] })
  })

  it('a base URL change resets the status, and hasApiKey from the renderer is ignored', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const conn = ctx.settings.get().proxies[0]
    const info = await ctx.service.update({ ...conn, anthropicBaseUrl: `${conn.anthropicBaseUrl}/v2`, hasApiKey: false })
    expect(info.status).toMatchObject({ state: 'disconnected', detail: 'Changed. Test and connect to apply.' })
    expect((info.connection as ProxyConnection).hasApiKey).toBe(true)
  })

  it('test() probes without enabling or changing the catalog', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    const status = await ctx.service.test('litellm')
    expect(status.state).toBe('connected')
    expect(ctx.settings.get().proxies[0].enabled).toBe(false)
    expect(ctx.service.models({ connection: 'litellm' })).toEqual([])
  })

  it('reports probe failures as short errors', async () => {
    const ctx = setup({ fetch: (async () => json({}, 401)) as unknown as typeof fetch })
    await configureLiteLLM(ctx)
    const status = await ctx.service.test('litellm')
    expect(status).toMatchObject({ state: 'error', detail: '401 from /v1/models: invalid key' })
  })

  it('never exposes the key in infos, statuses or events, and logout removes it', async () => {
    const ctx = setup({ fetch: (async () => { throw new TypeError(`fetch failed ${KEY}`) }) as unknown as typeof fetch })
    await configureLiteLLM(ctx)
    const infos = [await ctx.service.connect('litellm'), ...(await ctx.service.list())]
    await ctx.service.test('litellm')
    expect(JSON.stringify([infos, ctx.events])).not.toContain(KEY)
    expect(ctx.settings.get().proxies[0].hasApiKey).toBe(true)
    const out = await ctx.service.logout('litellm')
    expect((out.connection as ProxyConnection).hasApiKey).toBe(false)
    expect(ctx.secrets.get('connection:litellm:apiKey')).toBeUndefined()
  })
})

describe('fastModel', () => {
  it('uses each connection\'s fast tier, haiku on Anthropic and Claude, nothing for the mock', () => {
    const ctx = setup()
    expect(ctx.service.fastModel({ adapter: 'claude', connection: 'anthropic' })).toBe('haiku')
    expect(ctx.service.fastModel({ adapter: 'codex', connection: 'openai' })).toBe('gpt-5-nano')
    expect(ctx.service.fastModel({ adapter: 'mock', connection: 'anthropic' })).toBeUndefined()
    // LiteLLM without any catalog or mapping: the adapter's default model.
    expect(ctx.service.fastModel({ adapter: 'claude', connection: 'litellm' })).toBeUndefined()
    expect(ctx.service.fastModel({ adapter: 'codex', connection: 'litellm' })).toBeUndefined()
    ctx.settings.setProxies(ctx.settings.get().proxies.map((p) => ({ ...p, tierModels: { fast: 'claude-haiku-4-5' } })))
    expect(ctx.service.fastModel({ adapter: 'claude', connection: 'litellm' })).toBe('claude-haiku-4-5')
    expect(ctx.service.fastModel({ adapter: 'codex', connection: 'litellm' })).toBe('claude-haiku-4-5')
  })
})

describe('runConnection', () => {
  it('builds the litellm env for the claude adapter and the codex config for codex', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const p = litellmProject([['claude-opus-4-5', 'deep']])
    const claude = ctx.service.runConnection(p, adapterForProject(p, ctx.service.catalog()))
    expect(claude).toMatchObject({ connection: 'litellm', adapter: 'claude' })
    expect(claude.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5'
    })
    const g = litellmProject([['gpt-5', 'deep']])
    const codex = ctx.service.runConnection(g, adapterForProject(g, ctx.service.catalog()))
    expect(codex).toMatchObject({ adapter: 'codex', codexAuth: 'apiKey', apiKey: KEY, openaiBaseUrl: 'http://localhost:4000/v1' })
    expect(codex.env?.CODEX_HOME).toContain('codex')
  })

  it('throws clear errors for a missing key, and returns empty env for anthropic', () => {
    const ctx = setup()
    const p = litellmProject([['gpt-5', 'deep']])
    ctx.settings.setProxies(ctx.settings.get().proxies.map((p) => ({ ...p, anthropicBaseUrl: 'http://localhost:4000' })))
    expect(() => ctx.service.runConnection(p, { adapter: 'codex', connection: 'litellm', mismatched: [] })).toThrow('LiteLLM has no API key. Set it in Settings > Connections.')
    expect(ctx.service.runConnection(p, { adapter: 'claude', connection: 'anthropic', mismatched: [] })).toMatchObject({ connection: 'anthropic', adapter: 'claude', env: {}, tierModels: { fast: 'haiku' }, models: ['fable', 'opus', 'sonnet', 'haiku'] })
  })

  it('openai: chatgpt uses CODEX_HOME, apiKey reads the env var', () => {
    const ctx = setup()
    const p = project()
    const choice = { adapter: 'codex' as const, connection: 'openai' as const, mismatched: [] }
    expect(ctx.service.runConnection(p, choice)).toMatchObject({ codexAuth: 'chatgpt' })
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, auth: { kind: 'apiKey', envVar: 'ORGAI_TEST_OPENAI_KEY' } } } })
    expect(() => ctx.service.runConnection(p, choice)).toThrow(/ORGAI_TEST_OPENAI_KEY/)
    vi.stubEnv('ORGAI_TEST_OPENAI_KEY', 'sk-openai')
    expect(ctx.service.runConnection(p, choice)).toMatchObject({ codexAuth: 'apiKey', apiKey: 'sk-openai' })
    vi.unstubAllEnvs()
  })
})

describe('prepareNewProject', () => {
  const fresh = (settings: ReturnType<typeof setup>['settings']): Project => newProject({ name: 'N', path: '/x', brief: '' }, settings.get())

  it('puts a project on a usable litellm default with that connection\'s tier models', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'litellm' })
    const out = ctx.service.prepareNewProject(fresh(ctx.settings))
    expect(out.provider).toMatchObject({ id: 'claude', connection: 'litellm', label: 'LiteLLM' })
    const models = out.roles.map((r) => r.model)
    expect(models.every((m) => m.startsWith('claude-'))).toBe(true)
  })

  it('a litellm default whose models are gpt picks the codex adapter', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.settings.setProxies(ctx.settings.get().proxies.map((p) => ({ ...p, tierModels: { top: 'gpt-5', deep: 'gpt-5', everyday: 'gpt-5-mini', fast: 'gpt-5-mini' } })))
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'litellm' })
    const out = ctx.service.prepareNewProject(fresh(ctx.settings))
    expect(out.provider).toMatchObject({ id: 'codex', connection: 'litellm' })
  })

  it('stays on anthropic when litellm has no model for a tier the roles use', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const { everyday: _everyday, ...partial } = ctx.settings.get().proxies[0].tierModels
    void _everyday
    ctx.settings.setProxies(ctx.settings.get().proxies.map((p) => ({ ...p, tierModels: partial })))
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'litellm' })
    const p = fresh(ctx.settings)
    expect(ctx.service.prepareNewProject(p)).toEqual(p)
  })

  it('falls back to anthropic when litellm is not usable', () => {
    const ctx = setup()
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'litellm' })
    const p = fresh(ctx.settings)
    expect(ctx.service.prepareNewProject(p)).toEqual(p)
    expect(p.provider).toMatchObject({ id: 'claude', connection: 'anthropic' })
  })

  it('an enabled openai default gives codex', () => {
    const ctx = setup()
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, defaultConnection: 'openai', connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true } } })
    const out = ctx.service.prepareNewProject(fresh(ctx.settings))
    expect(out.provider).toMatchObject({ id: 'codex', connection: 'openai', label: 'Codex (ChatGPT)' })
  })
})

describe('runConnection anthropic key', () => {
  it('passes ANTHROPIC_API_KEY from the project\'s apiKey env var, else nothing', () => {
    const ctx = setup()
    const choice = { adapter: 'claude' as const, connection: 'anthropic' as const, mismatched: [] }
    const p = project({ provider: { id: 'claude', label: 'x', auth: { kind: 'apiKey', envVar: 'ORGAI_TEST_ANTH_KEY' }, connection: 'anthropic' } })
    expect(ctx.service.runConnection(p, choice).env).toEqual({})
    vi.stubEnv('ORGAI_TEST_ANTH_KEY', 'sk-ant-x')
    expect(ctx.service.runConnection(p, choice).env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    expect(ctx.service.runConnection(project(), choice).env).toEqual({})
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, anthropic: { ...s.connections.anthropic, auth: { kind: 'apiKey', envVar: 'ORGAI_TEST_ANTH_KEY' } } } })
    expect(ctx.service.runConnection(undefined, choice).env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    vi.unstubAllEnvs()
  })
})

describe('remapModels', () => {
  it('previewRemap returns the same result as remapModels and saves nothing', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.projects.save(project({
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
      roles: [role({ id: 'r0', slug: 'lead', model: 'opus', tier: 'deep' })]
    }))
    const before = JSON.stringify(ctx.projects.get('p1'))
    const preview = ctx.service.previewRemap({ projectId: 'p1', connection: 'litellm' })
    expect(preview).toMatchObject({ reason: 'switched', connection: 'litellm', changes: [{ roleId: 'r0', from: 'opus', to: 'claude-opus-4-5' }] })
    expect(JSON.stringify(ctx.projects.get('p1'))).toBe(before)
    expect(ctx.service.remapModels({ projectId: 'p1', connection: 'litellm' }).result).toEqual(preview)
    expect(() => ctx.service.previewRemap({ projectId: 'nope' })).toThrow('Project not found')
  })

  it('switching connection remaps every tiered role and fixes provider.id', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.projects.save(project({
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
      roles: [role({ id: 'r0', slug: 'lead', model: 'opus', tier: 'deep' }), role({ id: 'r1', slug: 'x', model: 'haiku', tier: 'fast', reportsTo: 'r0' })]
    }))
    const out = ctx.service.remapModels({ projectId: 'p1', connection: 'litellm' })
    expect(out.result).toMatchObject({ reason: 'switched', connection: 'litellm' })
    expect(out.project.provider.connection).toBe('litellm')
    expect(out.project.roles.map((r) => r.model)).toEqual(['claude-opus-4-5', 'claude-haiku-4-5'])
    expect(ctx.projects.get('p1')!.roles[0].model).toBe('claude-opus-4-5')
    expect(() => ctx.service.remapModels({ projectId: 'nope' })).toThrow('Project not found')
  })

  it('manual remap without a connection keeps valid picks', () => {
    const ctx = setup()
    ctx.projects.save(project({
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
      roles: [role({ id: 'r0', slug: 'lead', model: 'haiku', tier: 'deep' })]
    }))
    const out = ctx.service.remapModels({ projectId: 'p1' })
    expect(out.result).toMatchObject({ reason: 'manual', changes: [] })
  })
})

describe('anthropic connect', () => {
  it('enables and reports the probe status without discovery', async () => {
    const ctx = setup()
    const info = await ctx.service.connect('anthropic')
    expect(info.status).toMatchObject({ state: 'connected', checkedAt: 1000 })
    expect(info.modelCount).toBe(4)
    const list = await ctx.service.list()
    expect(list.map((i) => i.connection.id)).toEqual(['anthropic', 'openai', 'litellm'])
  })
})

describe('openai ChatGPT login', () => {
  function codexSetup() {
    let account: unknown = { account: null, requiresOpenaiAuth: true }
    const rpc = fakeRpc({
      'account/read': () => account,
      'account/login/start': (p: unknown) =>
        (p as { type: string }).type === 'chatgpt'
          ? { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.example/login' }
          : { type: 'chatgptDeviceCode', loginId: 'L2', verificationUrl: 'https://auth.example/device', userCode: 'WXYZ' },
      'account/login/cancel': {},
      'account/logout': () => {
        account = { account: null, requiresOpenaiAuth: true }
        return {}
      },
      'model/list': { data: [{ model: 'gpt-5.1', displayName: 'GPT-5.1' }, { model: 'gpt-5.1-mini', displayName: 'GPT-5.1 mini' }], nextCursor: null },
      'account/rateLimits/read': { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1793305200 }, secondary: null, planType: 'plus' } }
    })
    const signIn = (): void => {
      account = { account: { type: 'chatgpt', email: 'me@x.io', planType: 'plus' }, requiresOpenaiAuth: true }
    }
    ;(rpc as FakeRpc & { signIn: () => void }).signIn = signIn
    const factory = vi.fn<NonNullable<ConnectionServiceDeps['codexFactory']>>(() => asCodexServer(rpc))
    return { ctx: setup({ codexFactory: factory }), rpc, factory }
  }

  it('the probe checks the Codex runtime for every auth kind: missing or unsupported is an error, never a disconnect (cli-standalone 6.2)', async () => {
    const refused = { ok: false as const, reason: 'Codex 0.170.0 is not supported; install @openai/codex@0.166.0' }
    const { factory } = codexSetup()
    const ctx = setup({ codexFactory: factory, codexRuntime: async () => refused })
    expect(await ctx.service.test('openai')).toMatchObject({ state: 'error', detail: refused.reason })
    expect(factory).not.toHaveBeenCalled()
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, auth: { kind: 'apiKey', envVar: 'ORGAI_TEST_OPENAI_KEY' } } } })
    vi.stubEnv('ORGAI_TEST_OPENAI_KEY', 'sk-openai')
    expect(await ctx.service.test('openai')).toMatchObject({ state: 'error', detail: refused.reason })
    // Codex chosen through ORGAI_CODEX_PATH outside the tested range: connected, with the warning in the detail.
    const warned = setup({ codexRuntime: async () => ({ ok: true, binary: { path: '/x/codex', source: 'env' }, version: '0.170.0', warning: 'Codex 0.170.0 is not a tested version.' }) })
    const w = warned.settings.get()
    warned.settings.set({ ...w, connections: { ...w.connections, openai: { ...w.connections.openai, auth: { kind: 'apiKey', envVar: 'ORGAI_TEST_OPENAI_KEY' } } } })
    expect(await warned.service.test('openai')).toMatchObject({ state: 'connected', detail: 'Using ORGAI_TEST_OPENAI_KEY. Codex 0.170.0 is not a tested version.' })
    vi.unstubAllEnvs()
  })

  it('test() reports signed out, then connect after login discovers models and keeps the server until done', async () => {
    const { ctx, rpc } = codexSetup()
    expect(await ctx.service.test('openai')).toMatchObject({ state: 'disconnected' })
    expect(rpc.closed).toBe(true) // transient probe closes the process

    const start = await ctx.service.login('openai')
    expect(start).toEqual({ loginId: 'L1', connection: 'openai', method: 'browser', authUrl: 'https://auth.example/login' })
    expect(ctx.openExternal).toHaveBeenCalledWith('https://auth.example/login')
    expect(ctx.events).toContainEqual({ type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'pending' } })

    // The same fake object is reused by the factory; reopen it to simulate the live process.
    rpc.closed = false
    ;(rpc as unknown as { signIn: () => void }).signIn()
    rpc.emit('account/login/completed', { loginId: 'L1', success: true, error: null })
    await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'connection.login' && e.login.state === 'success')).toBe(true))
    const success = ctx.events.find((e) => e.type === 'connection.login' && e.login.state === 'success')
    expect(success && success.type === 'connection.login' && success.login.account).toBe('me@x.io · plus')
    expect(ctx.service.models({ connection: 'openai' }).map((m) => m.id)).toEqual(['gpt-5.1', 'gpt-5.1-mini'])
    expect(ctx.settings.get().connections.openai).toMatchObject({ enabled: true, tierModels: { deep: 'gpt-5.1', everyday: 'gpt-5.1-mini' } })
    expect(rpc.closed).toBe(true)
  })

  it('reports a failed login and supports cancel and device codes', async () => {
    const { ctx, rpc } = codexSetup()
    await ctx.service.login('openai')
    rpc.emit('account/login/completed', { loginId: 'L1', success: false, error: 'denied' })
    await vi.waitFor(() => expect(ctx.events).toContainEqual({ type: 'connection.login', login: { loginId: 'L1', connection: 'openai', state: 'error', detail: 'denied' } }))

    rpc.closed = false
    const device = await ctx.service.login('openai', 'deviceCode')
    expect(device).toMatchObject({ method: 'deviceCode', userCode: 'WXYZ' })
    await ctx.service.cancelLogin(device.loginId)
    expect(rpc.calls.some(([m]) => m === 'account/login/cancel')).toBe(true)
    expect(ctx.events).toContainEqual({ type: 'connection.login', login: { loginId: 'L2', connection: 'openai', state: 'cancelled' } })
    expect(rpc.closed).toBe(true)
  })

  it('probeCodexUsage maps rate limits only when signed in', async () => {
    const { ctx, rpc } = codexSetup()
    expect(await ctx.service.probeCodexUsage()).toBeNull() // openai not enabled
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, defaultConnection: 'openai', connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true } } })
    expect(await ctx.service.probeCodexUsage()).toBeNull() // signed out
    rpc.closed = false
    ;(rpc as unknown as { signIn: () => void }).signIn()
    const usage = await ctx.service.probeCodexUsage()
    expect(usage).toMatchObject({ provider: 'codex', connection: 'openai', subscriptionType: 'plus' })
    expect(usage?.windows.fiveHour?.utilization).toBe(10)
  })

  it('probeCodexUsage never spawns Codex while openai is not in use', async () => {
    const { ctx, rpc, factory } = codexSetup()
    ;(rpc as unknown as { signIn: () => void }).signIn()
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, defaultConnection: 'anthropic', connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true, auth: { kind: 'chatgpt' } } } })
    ctx.projects.save(project({ id: 'a1', provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' } }))
    expect(await ctx.service.probeCodexUsage()).toBeNull()
    expect(factory).not.toHaveBeenCalled()

    ctx.projects.save(project({ id: 'o1', provider: { id: 'codex', label: 'Codex', auth: { kind: 'subscription' }, connection: 'openai' } }))
    expect(await ctx.service.probeCodexUsage()).toMatchObject({ provider: 'codex', connection: 'openai' })
    expect(factory).toHaveBeenCalledTimes(1)

    ctx.projects.remove('o1')
    rpc.closed = false
    expect(await ctx.service.probeCodexUsage()).toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'openai' })
    expect(await ctx.service.probeCodexUsage()).toMatchObject({ provider: 'codex', connection: 'openai' })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('logout signs out of ChatGPT', async () => {
    const { ctx, rpc } = codexSetup()
    const info = await ctx.service.logout('openai')
    expect(rpc.calls.some(([m]) => m === 'account/logout')).toBe(true)
    expect(info.status).toMatchObject({ state: 'disconnected', detail: 'Signed out' })
  })
})

describe('LiteLLM spend and pricing', () => {
  /** Wednesday 2026-11-04 15:00 UTC; the daily fixture has rows 10-31..11-05 (see litellm-daily-activity.json). */
  const SPEND_NOW = Date.parse('2026-11-04T15:00:00Z')
  /** The fixture is keyed by the hash of 'sk-secret'; the service's key is KEY, so its breakdown entries are rekeyed (the cross-check would count 0 otherwise). */
  const dailyFixture = (): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'litellm-daily-activity.json'), 'utf8').replaceAll(keyHash('sk-secret'), keyHash(KEY)))
  const pricedFetch = (keyInfo: () => Response, daily: () => Response = () => json(dailyFixture())) =>
    (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/models')) return json({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'gpt-5' }] })
      if (u.endsWith('/model/info'))
        return json({
          data: [
            { model_name: 'claude-sonnet-4-5', litellm_params: { model: 'anthropic/claude-sonnet-4-5-20250929' }, model_info: { mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7 } },
            { model_name: 'gpt-5', litellm_params: { model: 'openai/gpt-5' }, model_info: { mode: 'chat' } }
          ]
        })
      if (u.endsWith('/key/info')) return keyInfo()
      if (u.includes('/user/daily/activity/aggregated?')) return daily()
      return json({}, 404)
    }) as unknown as typeof fetch

  it('probeProxyUsages is gated on enabled, base URL and key, and maps /key/info plus the daily periods', async () => {
    const fetchImpl = vi.fn(pricedFetch(() => json({ key: 'hashed', info: { spend: 1.25, max_budget: 10, budget_duration: '30d', budget_reset_at: '2026-11-01T00:00:00Z', key_alias: 'team-a', total_spend: 42 } })))
    const ctx = setup({ fetch: fetchImpl, now: () => SPEND_NOW })
    expect(await ctx.service.probeProxyUsages()).toEqual([]) // nothing configured
    await configureLiteLLM(ctx)
    expect(await ctx.service.probeProxyUsages()).toEqual([]) // not enabled
    expect(fetchImpl).not.toHaveBeenCalled()
    await ctx.service.connect('litellm')
    const keyInfoCalls = (): number => fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/key/info')).length
    const afterConnect = keyInfoCalls() // connect's own probe asks /key/info once (status checks.reportsSpend)
    expect(afterConnect).toBe(1)
    expect(await ctx.service.probeProxyUsages()).toEqual([]) // not in use: no default, no project
    expect(keyInfoCalls()).toBe(afterConnect)
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'litellm' })
    expect(await ctx.service.probeProxyUsages()).toHaveLength(1) // in use as the default connection
    ctx.settings.set({ ...ctx.settings.get(), defaultConnection: 'anthropic' })
    ctx.projects.save(litellmProject([['claude-sonnet-4-5', 'everyday']]))
    const [usage] = await ctx.service.probeProxyUsages() // in use by a project
    expect(usage).toEqual({
      connection: 'litellm',
      authMode: 'apiKey',
      subscriptionType: null,
      available: true,
      windows: {},
      spend: {
        usd: 1.25,
        budgetUsd: 10,
        resetsAt: Date.parse('2026-11-01T00:00:00Z'),
        budgetDuration: '30d',
        keyAlias: 'team-a',
        totalUsd: 42,
        // UTC calendar periods of updatedAt: 11-04 / 11-02..11-04 / 11-01..11-04 (10-31 and the future 11-05 excluded).
        periods: { day: { usd: 0.5, since: Date.UTC(2026, 10, 4) }, week: { usd: 6.75, since: Date.UTC(2026, 10, 2) }, month: { usd: 8.25, since: Date.UTC(2026, 10, 1) } }
      },
      updatedAt: SPEND_NOW
    })
    expect(JSON.stringify(usage)).not.toContain(KEY)
    expect(JSON.stringify(usage)).not.toContain(keyHash(KEY)) // the hash is a LiteLLM credential too
    expect(structuredClone(usage)).toEqual(usage)
    const call = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/key/info'))!
    expect(String(call[0])).toBe('http://localhost:4000/key/info') // no key in the URL
    const daily = fetchImpl.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/user/daily/activity'))
    expect(daily.length).toBeGreaterThan(0)
    expect(daily[0]).toBe(`http://localhost:4000/user/daily/activity/aggregated?start_date=2026-11-01&end_date=2026-11-04&api_key=${keyHash(KEY)}`)
    for (const [u] of fetchImpl.mock.calls) expect(String(u)).not.toContain(KEY) // only the hash travels in a URL
  })

  it('probeProxyUsages keeps the /key/info spend with a note when the daily route refuses (403)', async () => {
    const fetchImpl = vi.fn(pricedFetch(() => json({ info: { spend: 2 } }), () => json({ detail: 'User not found' }, 403)))
    const ctx = setup({ fetch: fetchImpl, now: () => SPEND_NOW })
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.projects.save(litellmProject([['claude-sonnet-4-5', 'everyday']]))
    const [usage] = await ctx.service.probeProxyUsages()
    expect(usage?.spend).toEqual({ usd: 2, budgetUsd: null, resetsAt: null, budgetDuration: null, keyAlias: null, totalUsd: null, periodsNote: SPEND_PERIOD_NOTES.noUser })
    expect(usage?.updatedAt).toBe(SPEND_NOW)
    expect(structuredClone(usage)).toEqual(usage)
    for (const [u] of fetchImpl.mock.calls) expect(String(u)).not.toContain(KEY)
  })

  it('probeProxyUsages returns null on 500 (no DB), 403, junk and network errors', async () => {
    const answers: (() => Response)[] = [
      () => json({ error: 'no db' }, 500),
      () => json({}, 403),
      () => json({ info: { spend: 'lots' } }),
      () => {
        throw new TypeError(`down ${KEY}`)
      }
    ]
    for (const answer of answers) {
      const ctx = setup({ fetch: pricedFetch(answer) })
      await configureLiteLLM(ctx)
      await ctx.service.connect('litellm')
      ctx.projects.save(litellmProject([['claude-sonnet-4-5', 'everyday']]))
      expect(await ctx.service.probeProxyUsages()).toEqual([])
    }
  })

  it('persists /model/info prices and passes them on litellm run connections only', async () => {
    const ctx = setup({ fetch: pricedFetch(() => json({}, 404)) })
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    const again = setup({}, ctx.dataDir)
    const sonnet = again.service.models({ connection: 'litellm' }).find((m) => m.id === 'claude-sonnet-4-5')
    const price = { inputPerToken: 3e-6, outputPerToken: 1.5e-5, cacheReadPerToken: 3e-7 }
    expect(sonnet).toMatchObject({ price, upstream: 'anthropic/claude-sonnet-4-5-20250929' })
    const p = litellmProject([['claude-sonnet-4-5', 'everyday']])
    const rc = ctx.service.runConnection(p, adapterForProject(p, ctx.service.catalog()))
    expect(rc.pricing).toEqual({ 'claude-sonnet-4-5': price, 'claude-sonnet-4-5-20250929': price })
    expect(ctx.service.runConnection(p, { adapter: 'claude', connection: 'anthropic', mismatched: [] }).pricing).toBeUndefined()
  })
})
