/**
 * Test helpers for the Team and Settings views (never imported by app code): a project with a small chart, two
 * connections and their catalog, and an in-memory fake of TuiConfigApi that records every save.
 */
import { render as inkRender } from 'ink'
import { EventEmitter } from 'node:events'
import type { ReactElement } from 'react'
import type { AppSettings, ConnectionInfo, Project, ProviderConnection, ProviderModel, Role } from '../../shared/types'
import { project } from '../testing/fakeContext'
import type { ConfigSettingValue, TuiConfigApi } from './configApi'
import { InputBus } from './context'
import { env, Providers } from './panes/testUtil'
import type { InputEvent, TuiEnv } from './types'

export const TIERS = { top: 'claude-fable-5', deep: 'claude-opus-5', everyday: 'claude-sonnet-5', fast: 'claude-haiku-5' }
export const PROXY = 'proxy-0123abcd'
const model = (id: string, connection: string, contextWindow?: number): ProviderModel =>
  ({ id, label: id, connection, family: 'claude', adapter: 'claude', source: 'discovered', ...(contextWindow ? { contextWindow } : {}) }) as ProviderModel
export const CATALOG: ProviderModel[] = [
  model(TIERS.top, 'anthropic', 1_000_000),
  model(TIERS.deep, 'anthropic', 200_000),
  model(TIERS.everyday, 'anthropic', 200_000),
  model(TIERS.fast, 'anthropic', 200_000),
  model('claude-legacy-1', 'anthropic', 100_000),
  model('gw-mid', PROXY)
]
export const connections = (): ConnectionInfo[] =>
  [
    { connection: { id: 'anthropic', tierModels: { ...TIERS } }, status: { state: 'connected' }, modelCount: 5 },
    { connection: { id: PROXY, name: 'Gateway', tierModels: { everyday: 'gw-mid' } }, status: { state: 'connected' }, modelCount: 1 }
  ] as unknown as ConnectionInfo[]

export const role = (over: Partial<Role> & Pick<Role, 'id'>): Role => ({
  slug: over.id,
  name: over.id[0].toUpperCase() + over.id.slice(1),
  description: `Does the ${over.id} work.`,
  responsibilities: [],
  prompt: `You are ${over.id}.\nWork carefully.`,
  tools: ['Read'],
  model: TIERS.everyday,
  tier: 'everyday',
  effort: 'medium',
  canSpawn: false,
  spawnable: [],
  reportsTo: 'lead',
  position: { x: 0, y: 0 },
  color: '#000',
  ...over
})

export function fixtureProject(over: Partial<Project> = {}): Project {
  return project('p1', '/work', {
    name: 'App',
    provider: { id: 'claude', label: 'Claude', auth: { mode: 'subscription' }, connection: 'anthropic' },
    staffing: 'fixed',
    roles: [
      role({ id: 'lead', model: TIERS.deep, tier: 'deep', effort: 'high', canSpawn: true, spawnable: ['dev', 'qa'], reportsTo: null, tools: ['Read', 'Edit'] }),
      role({ id: 'dev', canSpawn: true, spawnable: ['intern'], connection: PROXY, model: 'gw-mid' }),
      role({ id: 'qa', effort: 'low' }),
      role({ id: 'intern', reportsTo: 'dev', model: TIERS.fast, tier: 'fast' })
    ],
    ...over
  } as Partial<Project>)
}

export interface FakeConfig extends TuiConfigApi {
  stored: Project
  conns: ConnectionInfo[]
  appSettings: Partial<AppSettings>
  saves: Project[]
  settingSets: Record<string, ConfigSettingValue>[]
  connectionUpdates: ProviderConnection[]
  failSave?: string
}

export function fakeConfig(p: Project = fixtureProject(), settings: Partial<AppSettings> = { communityPrices: false, defaultKeepRuns: 100 }): FakeConfig {
  const api: FakeConfig = {
    stored: structuredClone(p),
    conns: connections(),
    appSettings: { ...settings },
    saves: [],
    settingSets: [],
    connectionUpdates: [],
    project: async () => structuredClone(api.stored),
    saveProject: async (next) => {
      if (api.failSave) throw new Error(api.failSave)
      // JSON over the wire: an own undefined is dropped (a cleared field).
      const saved = JSON.parse(JSON.stringify(next)) as Project
      api.saves.push(saved)
      api.stored = saved
      return structuredClone(saved)
    },
    projects: async () => [structuredClone(api.stored)],
    connections: async () => structuredClone(api.conns),
    models: async (c) => CATALOG.filter((m) => !c || m.connection === c),
    settings: async () => ({ ...api.appSettings }),
    setSetting: async (patch) => {
      api.settingSets.push(patch)
      api.appSettings = { ...api.appSettings, ...(patch as Partial<AppSettings>) }
      return { ...api.appSettings }
    },
    updateConnection: async (c) => {
      api.connectionUpdates.push(c)
      api.conns = api.conns.map((i) => (i.connection.id === c.id ? { ...i, connection: structuredClone(c) } : i))
      return api.conns.find((i) => i.connection.id === c.id)!
    }
  }
  return api
}

export const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
// eslint-disable-next-line no-control-regex
export const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Ink's render on fake streams `columns` wide (ink-testing-library's stdout is fixed at 100 columns). */
export function renderWide(tree: ReactElement, columns: number): { lastFrame(): string | undefined; unmount(): void } {
  class Out extends EventEmitter {
    frames: string[] = []
    get columns(): number {
      return columns
    }
    rows = 60
    write = (f: string): boolean => {
      this.frames.push(f)
      return true
    }
  }
  class In extends EventEmitter {
    isTTY = true
    setEncoding(): void {}
    setRawMode(): void {}
    resume(): void {}
    pause(): void {}
    ref(): void {}
    unref(): void {}
    read = (): null => null
  }
  const stdout = new Out()
  const instance = inkRender(tree, { stdout: stdout as never, stderr: new Out() as never, stdin: new In() as never, debug: true, exitOnCtrlC: false, patchConsole: false })
  return { lastFrame: () => stdout.frames.at(-1), unmount: () => instance.unmount() }
}

/** Renders a view with the providers; `keys` dispatches to the 'config' target and lets the view settle. */
export function mountView(node: (bus: InputBus) => ReactElement, e: TuiEnv = env({ color: false }), columns = 160) {
  const bus = new InputBus()
  const r = renderWide(<Providers env={e} bus={bus}>{node(bus)}</Providers>, columns)
  const keys = async (...events: InputEvent[]): Promise<void> => {
    for (const ev of events) {
      bus.dispatch(ev, 'config')
      await tick()
    }
    await tick()
  }
  return { r, bus, keys, frame: () => plain(r.lastFrame() ?? '') }
}
