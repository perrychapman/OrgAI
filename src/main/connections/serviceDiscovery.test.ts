import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionEvent } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { ConnectionService, type ConnectionServiceDeps } from './service'
import { asCodexServer, fakeRpc } from './testHelpers'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(over: Partial<ConnectionServiceDeps> = {}, dir?: string) {
  const dataDir = dir ?? mkdtempSync(join(tmpdir(), 'orgai-disc-'))
  if (!dir) dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  const projects = new ProjectStore(dataDir)
  const secrets = new SecretStore(dataDir, {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from(p, 'utf8'),
    decryptString: (b) => b.toString('utf8')
  })
  const events: ConnectionEvent[] = []
  const service = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets,
    broadcast: (e) => events.push(e),
    openExternal: async () => {},
    anthropicProbe: async () => ({ state: 'connected', detail: 'Claude Code login' }),
    // Never look for or run a real codex (cli-standalone 6.2 runtime check).
    codexRuntime: async () => ({ ok: true, binary: { path: '/fake/codex' } }),
    now: () => 1000,
    ...over
  })
  return { dataDir, settings, projects, events, service }
}

type Listed = { id: string; label?: string; description?: string }
const MODEL_LIST: Listed[] = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M' },
  { id: 'haiku', label: 'Haiku' }
]

describe('anthropic discovery', () => {
  it('connect discovers the list, keeps builtin aliases the list lacks, and broadcasts models.updated', async () => {
    const list: Listed[] = [{ id: 'mythos', label: 'Mythos', description: 'Our most capable model' }, { id: 'opus' }, { id: 'sonnet[1m]' }]
    const ctx = setup({ anthropicModels: async () => list })
    const info = await ctx.service.connect('anthropic')
    expect(info.modelsRefreshedAt).toBe(1000)
    expect(ctx.service.models({ connection: 'anthropic' }).map((m) => m.id)).toEqual(['mythos', 'opus', 'sonnet[1m]', 'fable', 'sonnet', 'haiku'])
    // The new family floats into the top tier; the others keep their alias.
    expect(ctx.settings.get().connections.anthropic.tierModels).toEqual({ top: 'mythos', deep: 'opus', everyday: 'sonnet', fast: 'haiku' })
    expect(ctx.events.find((e) => e.type === 'models.updated')).toMatchObject({ connection: 'anthropic', changed: true, refreshedAt: 1000 })
  })

  it('null from the dep keeps the catalog and records no refresh', async () => {
    const ctx = setup({ anthropicModels: async () => null })
    await ctx.service.refresh({ connection: 'anthropic' })
    expect(ctx.service.models({ connection: 'anthropic' })).toHaveLength(4)
    expect((await ctx.service.list())[0].modelsRefreshedAt).toBeUndefined()
  })

  it('auto tiers follow newer models, user tiers stay while listed and fall back when gone', async () => {
    let list: Listed[] = MODEL_LIST
    const ctx = setup({ anthropicModels: async () => list })
    await ctx.service.refresh({ connection: 'anthropic' })
    expect(ctx.settings.get().connections.anthropic.autoTiers).toEqual(['top', 'deep', 'everyday', 'fast'])
    // The user pins everyday to a concrete id: no longer auto.
    const conn = ctx.settings.get().connections.anthropic
    await ctx.service.update({ ...conn, tierModels: { ...conn.tierModels, everyday: 'claude-sonnet-pinned' } })
    expect(ctx.settings.get().connections.anthropic.autoTiers).toEqual(['top', 'deep', 'fast'])
    list = [{ id: 'claude-sonnet-pinned' }, { id: 'zeta', description: 'Fastest, cheap' }, { id: 'opus' }]
    await ctx.service.refresh({ connection: 'anthropic' })
    const t = ctx.settings.get().connections.anthropic
    expect(t.tierModels.everyday).toBe('claude-sonnet-pinned')
    expect(t.tierModels.fast).toBe('zeta')
    // The pinned model disappears: replaced by the suggestion and auto again.
    list = [{ id: 'opus' }]
    await ctx.service.refresh({ connection: 'anthropic' })
    const after = ctx.settings.get().connections.anthropic
    expect(after.tierModels.everyday).toBe('sonnet')
    expect(after.autoTiers).toContain('everyday')
  })

  it('remaps the connection\'s projects when an auto tier moves', async () => {
    let list: Listed[] = MODEL_LIST
    const ctx = setup({ anthropicModels: async () => list })
    await ctx.service.refresh({ connection: 'anthropic' })
    ctx.projects.save(
      project({
        provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
        roles: [role({ id: 'r0', slug: 'lead', model: 'opus', tier: 'deep' })]
      })
    )
    list = [{ id: 'oracle', description: 'Best for complex reasoning' }, ...MODEL_LIST.filter((m) => m.id !== 'opus')]
    await ctx.service.refresh({ connection: 'anthropic' })
    expect(ctx.settings.get().connections.anthropic.tierModels.deep).toBe('oracle')
    expect(ctx.projects.get('p1')!.roles[0].model).toBe('oracle')
  })

  it('persists refreshedAt in models.json and reloads it', async () => {
    const ctx = setup({ anthropicModels: async () => MODEL_LIST })
    await ctx.service.refresh({ connection: 'anthropic' })
    const file = JSON.parse(readFileSync(join(ctx.dataDir, 'models.json'), 'utf8'))
    expect(file).toMatchObject({ version: 1, refreshedAt: { anthropic: 1000 } })
    const again = setup({}, ctx.dataDir)
    expect((await again.service.list())[0].modelsRefreshedAt).toBe(1000)
  })

  it('drops stored models with a bad id and caps stored label and hint', async () => {
    const ctx = setup()
    const m = (id: string, extra: object = {}) => ({ id, label: id, connection: 'anthropic', family: 'claude', ...extra })
    writeFileSync(
      join(ctx.dataDir, 'models.json'),
      JSON.stringify({ version: 1, models: { anthropic: [m('ok', { label: 'L'.repeat(900), hint: 'h'.repeat(900) }), m('has space'), m('x'.repeat(201)), m('café')] } })
    )
    const again = setup({}, ctx.dataDir)
    const models = again.service.models({ connection: 'anthropic' }).filter((x) => ['ok', 'has space', 'café'].includes(x.id) || x.id.length > 200)
    expect(models.map((x) => x.id)).toEqual(['ok'])
    expect(models[0].label).toHaveLength(300)
    expect(models[0].hint).toHaveLength(300)
  })

  it('records "No models returned" for an empty scheduled result and clears it on success', async () => {
    let list: Listed[] | null = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = setup({ anthropicModels: async () => list })
    await ctx.service.discoverStale(100)
    expect((await ctx.service.list())[0].modelsError).toBe('No models returned')
    expect((await ctx.service.list())[0].modelsRefreshedAt).toBeUndefined()
    list = MODEL_LIST
    await ctx.service.discoverStale(100)
    expect((await ctx.service.list())[0].modelsError).toBeUndefined()
  })

  it('treats a refreshedAt in the future as stale', async () => {
    const ctx = setup({ anthropicModels: async () => MODEL_LIST })
    await ctx.service.refresh({ connection: 'anthropic' })
    const file = JSON.parse(readFileSync(join(ctx.dataDir, 'models.json'), 'utf8'))
    file.refreshedAt.anthropic = 9_000_000
    writeFileSync(join(ctx.dataDir, 'models.json'), JSON.stringify(file))
    const calls: number[] = []
    const again = setup({ anthropicModels: async () => (calls.push(1), MODEL_LIST) }, ctx.dataDir)
    await again.service.discoverStale(100)
    expect(calls).toHaveLength(1)
  })

  it('ignores an autoTiers value sent by the renderer', async () => {
    const ctx = setup()
    const conn = ctx.settings.get().connections.anthropic
    await ctx.service.update({ ...conn, autoTiers: [] })
    expect(ctx.settings.get().connections.anthropic.autoTiers).toEqual(['top', 'deep', 'everyday', 'fast'])
  })
})

describe('scheduled discovery', () => {
  it('refreshes only stale, configured connections; failures keep the catalog and the status', async () => {
    let now = 1000
    let fail = false
    const calls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = setup({
      now: () => now,
      anthropicModels: async () => {
        calls.push('a')
        if (fail) throw new Error('boom')
        return MODEL_LIST
      }
    })
    await ctx.service.discoverStale(100)
    expect(calls).toEqual(['a'])
    expect((await ctx.service.list())[0].modelsRefreshedAt).toBe(1000)
    // Fresh: skipped. openai (no chatgpt login) and litellm (no key) never run.
    now = 1050
    await ctx.service.discoverStale(100)
    expect(calls).toEqual(['a'])
    // Stale and failing: error recorded, status untouched, one warning.
    now = 2000
    fail = true
    ctx.events.length = 0
    await ctx.service.discoverStale(100)
    await ctx.service.discoverStale(100)
    const info = (await ctx.service.list())[0]
    expect(info.modelsError).toBe('boom')
    expect(info.modelsRefreshedAt).toBe(1000)
    expect(info.modelCount).toBe(5)
    expect(ctx.events.some((e) => e.type === 'connection.status')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    fail = false
    await ctx.service.discoverStale(100)
    expect((await ctx.service.list())[0].modelsError).toBeUndefined()
    warn.mockRestore()
  })

  it('never overlaps runs, waits for the boot delay and stops on dispose', async () => {
    vi.useFakeTimers()
    try {
      let running = 0
      let max = 0
      let n = 0
      const ctx = setup({
        anthropicModels: async () => {
          n++
          running++
          max = Math.max(max, running)
          await new Promise((r) => setTimeout(r, 70))
          running--
          return null
        }
      })
      ctx.service.startDiscovery({ bootDelayMs: 100, checkEveryMs: 50, staleAfterMs: 1 })
      await vi.advanceTimersByTimeAsync(99)
      expect(n).toBe(0)
      await vi.advanceTimersByTimeAsync(400)
      expect(n).toBeGreaterThan(1)
      expect(max).toBe(1)
      ctx.service.dispose()
      const seen = n
      await vi.advanceTimersByTimeAsync(500)
      expect(n).toBe(seen)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips disabled connections', async () => {
    let calls = 0
    const ctx = setup({
      anthropicModels: async () => {
        calls++
        return null
      }
    })
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, anthropic: { ...s.connections.anthropic, enabled: false } } })
    await ctx.service.discoverStale()
    expect(calls).toBe(0)
  })
})

describe('discovered id validation', () => {
  it('anthropic: invalid discovered ids never reach the catalog or the tier mapping', async () => {
    const list: Listed[] = [{ id: '--help', description: 'Our most capable model' }, { id: 'bad id' }, { id: 'ctl\u0007' }, { id: 'x'.repeat(201) }, ...MODEL_LIST]
    const ctx = setup({ anthropicModels: async () => list })
    await ctx.service.refresh({ connection: 'anthropic' })
    const ids = ctx.service.models({ connection: 'anthropic' }).map((m) => m.id)
    expect(ids).toEqual(['fable', 'opus', 'sonnet', 'sonnet[1m]', 'haiku'])
    expect(Object.values(ctx.settings.get().connections.anthropic.tierModels)).not.toContain('--help')
  })

  it('openai: model/list ids with a leading dash are dropped', async () => {
    const rpc = fakeRpc({
      'account/read': { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: false },
      'model/list': { data: [{ model: '-c', isDefault: true }, { model: 'gpt-9', displayName: 'Nine' }] }
    })
    const ctx = setup({ codexFactory: () => asCodexServer(rpc) })
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true, auth: { kind: 'chatgpt' } } } })
    await ctx.service.refresh({ connection: 'openai' })
    expect(ctx.service.models({ connection: 'openai' }).map((m) => m.id)).toEqual(['gpt-9'])
  })
})

describe('signed-out ChatGPT discovery', () => {
  it('skips model/list and records no error when there is no account', async () => {
    const rpc = fakeRpc({ 'account/read': { account: null, requiresOpenaiAuth: true }, 'model/list': { data: [{ model: 'gpt-9' }] } })
    const ctx = setup({ codexFactory: () => asCodexServer(rpc), anthropicModels: async () => MODEL_LIST })
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true, auth: { kind: 'chatgpt' } } } })
    await ctx.service.discoverStale(100)
    await ctx.service.discoverStale(100)
    const openai = (await ctx.service.list()).find((i) => i.connection.id === 'openai')!
    expect(openai.modelsError).toBeUndefined()
    expect(openai.modelsRefreshedAt).toBeUndefined()
    expect(rpc.calls.some(([m]) => m === 'model/list')).toBe(false)
    // The placeholders stay.
    expect(ctx.service.models({ connection: 'openai' }).length).toBeGreaterThan(0)
  })
})

describe('openai recommended and tiers', () => {
  it('passes isDefault as recommended, reads descriptions, and gives a recommended tierless model deep', async () => {
    const rpc = fakeRpc({
      'account/read': { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: false },
      'model/list': {
        data: [
          { model: 'orbit-1', displayName: 'Orbit', description: 'Our most capable model', isDefault: false },
          { model: 'zen-2', displayName: 'Zen', isDefault: true },
          { model: 'gpt-9-mini', displayName: 'Mini' },
          { model: 'secret', hidden: true }
        ]
      }
    })
    const ctx = setup({ codexFactory: () => asCodexServer(rpc) })
    const s = ctx.settings.get()
    ctx.settings.set({ ...s, connections: { ...s.connections, openai: { ...s.connections.openai, enabled: true, auth: { kind: 'chatgpt' } } } })
    await ctx.service.connect('openai')
    const models = ctx.service.models({ connection: 'openai' })
    expect(models.map((m) => m.id)).toEqual(['orbit-1', 'zen-2', 'gpt-9-mini'])
    expect(models.find((m) => m.id === 'zen-2')).toMatchObject({ recommended: true, tier: 'deep' })
    expect(models.find((m) => m.id === 'orbit-1')?.tier).toBe('top')
    expect(models.find((m) => m.id === 'gpt-9-mini')?.tier).toBe('everyday')
    expect(ctx.settings.get().connections.openai.tierModels.deep).toBe('zen-2')
  })
})

describe('runConnection tiers and models', () => {
  it('carries a copy of tierModels and the catalog ids on non-mock runs only', () => {
    const ctx = setup()
    const rc = ctx.service.runConnection(undefined, { adapter: 'claude', connection: 'anthropic', mismatched: [] })
    expect(rc.tierModels).toEqual({ top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' })
    rc.tierModels!.deep = 'x'
    expect(ctx.settings.get().connections.anthropic.tierModels.deep).toBe('opus')
    expect(rc.models).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(ctx.service.runConnection(undefined, { adapter: 'mock', connection: 'anthropic', mismatched: [] }).tierModels).toBeUndefined()
  })
})
