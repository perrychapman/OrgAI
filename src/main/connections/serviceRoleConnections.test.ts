import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { remapProject } from './remap'
import { ConnectionService } from './service'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'orgai-roleconn-'))
  dirs.push(dataDir)
  const settings = new SettingsStore(dataDir)
  const projects = new ProjectStore(dataDir)
  const service = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets: new SecretStore(dataDir, { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p, 'utf8'), decryptString: (b) => b.toString('utf8') }),
    broadcast: () => {},
    openExternal: vi.fn(async () => {}),
    fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
    anthropicProbe: async () => ({ state: 'connected' }),
    logInfo: () => {},
    now: () => 1000
  })
  const id = (await service.createProxy({ name: 'Gateway', anthropicBaseUrl: 'https://gw.example.com' })).connection.id
  settings.setProxies(settings.get().proxies.map((p) => (p.id === id ? { ...p, tierModels: { deep: 'gw/big', everyday: 'gw/mid', fast: 'gw/small' } } : p)))
  return { service, projects, settings, proxy: id }
}

const chart = (proxy: string): Role[] => [
  role({ id: 'r0', slug: 'lead', name: 'Lead', model: 'opus', tier: 'deep', canSpawn: true, spawnable: ['r1', 'r2'] }),
  role({ id: 'r1', slug: 'coder', name: 'Coder', model: 'old-model', tier: 'fast', reportsTo: 'r0', connection: proxy }),
  role({ id: 'r2', slug: 'qa', name: 'QA', model: 'haiku', tier: 'fast', reportsTo: 'r0' })
]
const onAnthropic = { id: 'claude' as const, label: 'Claude', auth: { kind: 'subscription' as const }, connection: 'anthropic' as const }

describe('remapProject include', () => {
  it('touches only included roles', () => {
    const p = project({ provider: onAnthropic, roles: chart('x') })
    const out = remapProject(p, { connection: 'anthropic', tierModels: { fast: 'haiku-new', deep: 'opus-new' }, catalog: [], reason: 'switched', include: (r) => r.id === 'r2' })
    expect(out.result.changes.map((c) => c.roleId)).toEqual(['r2'])
  })
})

describe('role connections in remaps', () => {
  it('a manual remap maps each role through its own connection', async () => {
    const ctx = await setup()
    ctx.projects.save(project({ provider: onAnthropic, roles: chart(ctx.proxy) }))
    const out = ctx.service.remapModels({ projectId: 'p1' })
    expect(out.project.roles.find((r) => r.id === 'r1')).toMatchObject({ model: 'gw/small', connection: ctx.proxy })
    expect(out.result.projectId).toBe('p1')
    expect(out.result.changes.some((c) => c.roleId === 'r1' && c.to === 'gw/small')).toBe(true)
    expect(out.project.roles.find((r) => r.id === 'r2')!.model).not.toMatch(/^gw\//)
  })

  it('a project switch remaps only roles without their own connection', async () => {
    const ctx = await setup()
    ctx.projects.save(project({ provider: onAnthropic, roles: chart(ctx.proxy) }))
    const out = ctx.service.remapModels({ projectId: 'p1', connection: ctx.proxy })
    const by = (id: string) => out.project.roles.find((r) => r.id === id)!
    expect(by('r0').model).toBe('gw/big')
    expect(by('r2').model).toBe('gw/small')
    expect(by('r1').model).toBe('old-model')
    expect(out.result.changes.map((c) => c.roleId).sort()).toEqual(['r0', 'r2'])
  })
})

describe('usedBy and removeProxy count role connections', () => {
  it('lists a project on another connection whose role names the proxy', async () => {
    const ctx = await setup()
    ctx.projects.save(project({ id: 'p1', name: 'Mixed', provider: onAnthropic, roles: chart(ctx.proxy) }))
    ctx.projects.save(project({ id: 'p2', name: 'Plain', provider: onAnthropic, roles: chart('anthropic') }))
    const info = (await ctx.service.list()).find((i) => i.connection.id === ctx.proxy)!
    expect(info.usedBy).toEqual([{ id: 'p1', name: 'Mixed' }])
    await expect(ctx.service.removeProxy(ctx.proxy)).rejects.toThrow(/Gateway is used by Mixed/)
    ctx.projects.remove('p1')
    await ctx.service.removeProxy(ctx.proxy)
  })
})
