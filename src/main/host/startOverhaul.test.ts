import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { HostScope, Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { startRunArgs } = await import('./args')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (surface: 'socket' | 'inproc'): RpcInvokeContext => ({ surface, grantedScopes: ['read', 'operate', 'decide', 'configure'] as HostScope[] })
const base = { projectId: 'proj_a', prompt: 'go' }

function setup() {
  const stored = [makeProject({ id: 'proj_a' })]
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/tmp/orgai-test', set: vi.fn() }
  const runs = { start: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'run_new' }) as RunSummary) }
  const services: HostServices = {
    projects: { get: (id: string) => stored.find((p: Project) => p.id === id) ?? null, list: () => stored } as never,
    runs: runs as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: {} as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    importer: {} as never,
    skills: {} as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: {} as never,
    templates: { list: () => [] } as never
  }
  return { d: new HostDispatcher(services), runs }
}

function badMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    expect(e).toMatchObject({ code: 'bad_request' })
    return (e as Error).message
  }
  throw new Error('expected a bad_request refusal')
}

describe('startRunArgs: roles left out and the per-run spending limit', () => {
  it('without them the output has neither', () => {
    expect(startRunArgs(base)).toEqual(base)
    expect(startRunArgs({ ...base, excludeRoleIds: null, maxBudgetUsd: null })).toEqual(base)
  })

  it('rebuilds a list of ids and a positive number', () => {
    expect(startRunArgs({ ...base, excludeRoleIds: ['r-a', 'r-b'], maxBudgetUsd: 2.5, extra: 1 })).toEqual({ ...base, excludeRoleIds: ['r-a', 'r-b'], maxBudgetUsd: 2.5 })
    expect(startRunArgs({ ...base, excludeRoleIds: [] }).excludeRoleIds).toEqual([])
  })

  it('refuses a malformed list or number as bad_request', () => {
    for (const v of ['r-a', 5, {}, [1], [''], ['a\nb'], ['x'.repeat(201)], Array.from({ length: 201 }, (_, i) => `r${i}`)]) {
      expect(badMessage(() => startRunArgs({ ...base, excludeRoleIds: v })), JSON.stringify(v).slice(0, 30)).toBe('excludeRoleIds must be a list of role ids.')
    }
    for (const v of [0, -1, NaN, Infinity, '5', true, {}]) {
      expect(badMessage(() => startRunArgs({ ...base, maxBudgetUsd: v })), String(v)).toBe('maxBudgetUsd must be a number above 0.')
    }
  })
})

describe('runs:start and the overhaul start choices', () => {
  it('the desktop passes both on to RunManager as the start choices', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ ...base, excludeRoleIds: ['r-rev'], maxBudgetUsd: 3 }], DESKTOP)
    expect(runs.start).toHaveBeenCalledTimes(1)
    expect(runs.start.mock.calls[0][0]).toMatchObject({ userChoice: { excludeRoleIds: ['r-rev'], maxBudgetUsd: 3 } })
  })

  it('a plain desktop start carries no choice, and the existing choices still flow', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [base], DESKTOP)
    expect(runs.start.mock.calls[0][0]).not.toHaveProperty('userChoice')
    await d.invoke(IPC.runsStart, [{ ...base, effort: 'high' }], DESKTOP)
    expect(runs.start.mock.calls[1][0]).toMatchObject({ userChoice: { effort: 'high' } })
  })

  it.each(['socket', 'inproc'] as const)('a %s client is refused both, even with every scope, and nothing starts', async (surface) => {
    const { d, runs } = setup()
    for (const extra of [{ maxBudgetUsd: 3 }, { excludeRoleIds: ['r-rev'] }, { excludeRoleIds: [] }]) {
      await expect(d.invoke(IPC.runsStart, [{ ...base, ...extra }], rpc(surface)), JSON.stringify(extra)).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('desktop app only') })
    }
    expect(runs.start).not.toHaveBeenCalled()
    // the same client may still start a plain run
    await d.invoke(IPC.runsStart, [base], rpc(surface))
    expect(runs.start).toHaveBeenCalledTimes(1)
  })

  it('a malformed choice is bad_request on every surface, desktop included', async () => {
    const { d, runs } = setup()
    await expect(d.invoke(IPC.runsStart, [{ ...base, maxBudgetUsd: 0 }], DESKTOP)).rejects.toThrow('maxBudgetUsd must be a number above 0.')
    await expect(d.invoke(IPC.runsStart, [{ ...base, excludeRoleIds: 'r' }], rpc('socket'))).rejects.toThrow('excludeRoleIds must be a list of role ids.')
    expect(runs.start).not.toHaveBeenCalled()
  })
})
