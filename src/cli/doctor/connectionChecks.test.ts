import { describe, expect, it } from 'vitest'
import { defaultConnections } from '../../shared/defaults'
import type { ConnectionInfo, ModelTier, Project, ProviderConnection, ProviderModel } from '../../shared/types'
import { FakeHostClient, project } from '../testing/fakeContext'
import { connectionChecks, connectionFindings } from './connectionChecks'

const m = (id: string, tier: ModelTier | undefined, source: ProviderModel['source'] = 'discovered'): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source, ...(tier ? { tier } : {}) })
const info = (tierModels: Partial<Record<ModelTier, string>>, extra: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  connection: { ...defaultConnections().anthropic, enabled: true, tierModels } as ProviderConnection,
  status: { state: 'connected' },
  modelCount: 4,
  isDefault: true,
  modelsRefreshedAt: Date.parse('2026-11-01T12:00:00Z'),
  ...extra
})
const full = { top: 'claude-opus-5-5', deep: 'claude-opus-5-5', everyday: 'claude-sonnet-5-5', fast: 'claude-haiku-5' }
const catalog = [m('claude-opus-5-5', 'top'), m('claude-sonnet-5-5', 'everyday'), m('claude-haiku-5', 'fast')]
const byId = (cs: ReturnType<typeof connectionFindings>, id: string) => cs.find((c) => c.id === id)

describe('connectionFindings', () => {
  it('is all ok for a discovered, fully mapped, current connection', () => {
    const cs = connectionFindings([info(full)], catalog, [])
    expect(cs.map((c) => c.status)).toEqual(['ok', 'ok'])
    expect(byId(cs, 'models-anthropic')?.detail).toContain('2026-11-01')
  })

  it('skips disabled connections', () => {
    const i = info(full)
    ;(i.connection as { enabled: boolean }).enabled = false
    expect(connectionFindings([i], catalog, [])).toEqual([])
  })

  it('warns with the remedy on a discovery error and on never having discovered', () => {
    const err = connectionFindings([info(full, { modelsError: 'HTTP 401' })], catalog, [])
    expect(byId(err, 'models-anthropic')).toMatchObject({ status: 'warn' })
    expect(byId(err, 'models-anthropic')?.detail).toMatch(/HTTP 401.*orgai models refresh --connection anthropic/)
    const never = connectionFindings([info(full, { modelsRefreshedAt: undefined })], catalog, [])
    expect(byId(never, 'models-anthropic')?.detail).toContain('never discovered')
  })

  it('warns on an unmapped tier and names the tier command', () => {
    const cs = connectionFindings([info({ top: 'claude-opus-5-5', everyday: 'claude-sonnet-5-5' })], catalog, [])
    expect(byId(cs, 'tiers-anthropic')?.status).toBe('warn')
    expect(byId(cs, 'tiers-anthropic')?.detail).toContain('orgai connections tier anthropic deep=<model>')
  })

  it('warns on a built-in fallback model and on an older family member, but not when it cannot tell', () => {
    const old = connectionFindings([info({ ...full, deep: 'claude-opus-4-1-20250805' })], [...catalog, m('claude-opus-4-1-20250805', 'deep')], [])
    expect(byId(old, 'tiers-anthropic')?.detail).toContain('deep runs on claude-opus-4-1-20250805, older than claude-opus-5-5')
    expect(byId(old, 'tiers-anthropic')?.detail).toContain('deep=claude-opus-5-5')
    const builtin = connectionFindings([info(full)], [m('claude-opus-5-5', 'top', 'builtin'), ...catalog.slice(1)], [])
    expect(byId(builtin, 'tiers-anthropic')?.detail).toContain('top runs on built-in claude-opus-5-5')
    const alias = connectionFindings([info({ ...full, deep: 'opus' })], catalog, [])
    expect(byId(alias, 'tiers-anthropic')?.status).toBe('ok')
  })

  it('judges only the tiers the projects use when any are in use', () => {
    const p: Project = project('p', '/w', { roles: [{ id: 'r', name: 'R', reportsTo: null, model: 'x', tier: 'everyday' }] as never })
    const cs = connectionFindings([info({ ...full, deep: 'claude-opus-4-1-20250805' })], [...catalog, m('claude-opus-4-1-20250805', 'deep')], [p])
    expect(byId(cs, 'tiers-anthropic')?.status).toBe('ok')
  })
})

describe('connectionChecks group', () => {
  it('says so without a client, warns with none enabled, and never throws', async () => {
    expect((await connectionChecks({ ctx: {} as never }))[0].status).toBe('ok')
    const none = new FakeHostClient({ 'connections:list': () => [], 'models:list': () => [], 'projects:list': () => [] })
    expect((await connectionChecks({ ctx: {} as never, client: none }))[0]).toMatchObject({ id: 'connections', status: 'warn' })
    const boom = new FakeHostClient({ 'connections:list': () => { throw new Error('down') } })
    expect((await connectionChecks({ ctx: {} as never, client: boom }))[0].detail).toContain('down')
  })
})
