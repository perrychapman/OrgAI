import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForProject, newProject } from '@shared/defaults'
import type { ConnectionEvent, LiteLLMConnection, Project } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { ConnectionService, type ConnectionServiceDeps } from './service'
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
  const conn = ctx.settings.get().connections.litellm
  await ctx.service.update({ ...conn, baseUrl: 'http://localhost:4000/' })
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

  it('updating tierModels remaps that connection\'s projects, keeping explicit picks', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    await ctx.service.connect('litellm')
    ctx.projects.save(litellmProject([['claude-sonnet-4-5', 'everyday'], ['claude-haiku-4-5', 'everyday'], ['claude-opus-4-5', 'deep']]))
    ctx.events.length = 0
    const conn = ctx.settings.get().connections.litellm as LiteLLMConnection
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
    const conn = ctx.settings.get().connections.litellm
    const info = await ctx.service.update({ ...conn, baseUrl: 'http://localhost:5000', hasApiKey: false })
    expect(info.status).toMatchObject({ state: 'disconnected', detail: 'Changed. Test and connect to apply.' })
    expect((info.connection as LiteLLMConnection).hasApiKey).toBe(true)
  })

  it('test() probes without enabling or changing the catalog', async () => {
    const ctx = setup()
    await configureLiteLLM(ctx)
    const status = await ctx.service.test('litellm')
    expect(status.state).toBe('connected')
    expect(ctx.settings.get().connections.litellm.enabled).toBe(false)
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
    expect(ctx.settings.get().connections.litellm.hasApiKey).toBe(true)
    const out = await ctx.service.logout('litellm')
    expect((out.connection as LiteLLMConnection).hasApiKey).toBe(false)
    expect(ctx.secrets.get('connection:litellm:apiKey')).toBeUndefined()
  })
})

describe('fastModel', () => {
  it('uses each connection\'s fast tier, haiku on Anthropic and Claude, nothing for the mock', () => {
    const ctx = setup()
    expect(ctx.service.fastModel({ adapter: 'claude', connection: 'anthropic' })).toBe('haiku')
    expect(ctx.service.fastModel({ adapter: 'codex', connection: 'openai' })).toBe('gpt-5-nano')
    expect(ctx.service.fastModel({ adapter: 'mock', connection: 'anthropic' })).toBeUndefined()
    // LiteLLM without a fast tier: the Claude adapter falls back to the haiku alias, Codex to its default.
    expect(ctx.service.fastModel({ adapter: 'claude', connection: 'litellm' })).toBe('haiku')
    expect(ctx.service.fastModel({ adapter: 'codex', connection: 'litellm' })).toBeUndefined()
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, litellm: { ...s.connections.litellm, tierModels: { fast: 'claude-haiku-4-5' } } } })
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
    ctx.settings.set({ ...ctx.settings.get(), connections: { ...ctx.settings.get().connections, litellm: { ...ctx.settings.get().connections.litellm, baseUrl: 'http://localhost:4000' } } })
    expect(() => ctx.service.runConnection(p, { adapter: 'codex', connection: 'litellm', mismatched: [] })).toThrow('LiteLLM has no API key. Set it in Settings > Connections.')
    expect(ctx.service.runConnection(p, { adapter: 'claude', connection: 'anthropic', mismatched: [] })).toEqual({ connection: 'anthropic', adapter: 'claude', env: {} })
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
    const s = ctx.settings.get()
    ctx.settings.set({
      ...s,
      defaultConnection: 'litellm',
      connections: { ...s.connections, litellm: { ...s.connections.litellm, tierModels: { top: 'gpt-5', deep: 'gpt-5', everyday: 'gpt-5-mini', fast: 'gpt-5-mini' } } }
    })
    const out = ctx.service.prepareNewProject(fresh(ctx.settings))
    expect(out.provider).toMatchObject({ id: 'codex', connection: 'litellm' })
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
  function codexSetup(): { ctx: ReturnType<typeof setup>; rpc: FakeRpc } {
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
    return { ctx: setup({ codexFactory: () => asCodexServer(rpc) }), rpc }
  }

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
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true } } })
    expect(await ctx.service.probeCodexUsage()).toBeNull() // signed out
    rpc.closed = false
    ;(rpc as unknown as { signIn: () => void }).signIn()
    const usage = await ctx.service.probeCodexUsage()
    expect(usage).toMatchObject({ provider: 'codex', connection: 'openai', subscriptionType: 'plus' })
    expect(usage?.windows.fiveHour?.utilization).toBe(10)
  })

  it('logout signs out of ChatGPT', async () => {
    const { ctx, rpc } = codexSetup()
    const info = await ctx.service.logout('openai')
    expect(rpc.calls.some(([m]) => m === 'account/logout')).toBe(true)
    expect(info.status).toMatchObject({ state: 'disconnected', detail: 'Signed out' })
  })
})
