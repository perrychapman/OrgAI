import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVOLVE_IPC, IPC } from '@shared/types'
import type { HostScope, Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher, isMutatingChannel } = await import('./dispatcher')
const { HostRpcFailure } = await import('./registry')
const { EVOLVE_AFTER_RUN_CHANNEL } = await import('./jsonCodec')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (scopes: HostScope[], surface: 'socket' | 'inproc' = 'socket'): RpcInvokeContext => ({ surface, grantedScopes: scopes })
const ALL: HostScope[] = ['read', 'operate', 'decide', 'configure']

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-dispatcher-evolve-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(withEvolve = true) {
  const stored = [makeProject({ id: 'proj_a' })]
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const summary: RunSummary = { id: 'run_1', projectId: 'proj_a', kind: 'work', prompt: 'p', status: 'finished', startedAt: 1, totalCostUsd: 0 }
  const runs = {
    summary: vi.fn(() => summary),
    start: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'run_new' }) as RunSummary),
    awaitEvolvePass: vi.fn(async (id: string) => (id === 'run_1' ? { projectId: 'proj_a', ratchet: 'none' } : undefined))
  }
  const evolve = {
    analyze: vi.fn(async (i: unknown) => ({ seen: i })),
    apply: vi.fn(async (i: unknown) => ({ seen: i })),
    history: vi.fn((id: string) => ({ projectId: id, generations: [], rejectedHypotheses: [] })),
    rollback: vi.fn(async (i: unknown) => ({ seen: i })),
    afterRun: vi.fn()
  }
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
    templates: { list: () => [] } as never,
    ...(withEvolve ? { evolve: evolve as never } : {})
  }
  return { d: new HostDispatcher(services), runs, evolve }
}

async function failure(p: Promise<unknown>): Promise<InstanceType<typeof HostRpcFailure>> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HostRpcFailure)
    return e as InstanceType<typeof HostRpcFailure>
  }
  throw new Error('expected a HostRpcFailure')
}

describe('org:evolve* channels', () => {
  it('are served only when the host has an evolve service', () => {
    expect(setup(false).d.has(EVOLVE_IPC.orgEvolveAnalyze)).toBe(false)
    const { d } = setup()
    for (const c of [...Object.values(EVOLVE_IPC), EVOLVE_AFTER_RUN_CHANNEL]) expect(d.has(c), c).toBe(true)
  })

  it('apply, rollback and the post-run pass are mutations; analyze and history are not', () => {
    expect(isMutatingChannel(EVOLVE_IPC.orgEvolveApply)).toBe(true)
    expect(isMutatingChannel(EVOLVE_IPC.orgEvolveRollback)).toBe(true)
    expect(isMutatingChannel(EVOLVE_AFTER_RUN_CHANNEL)).toBe(true)
    expect(isMutatingChannel(EVOLVE_IPC.orgEvolveAnalyze)).toBe(false)
    expect(isMutatingChannel(EVOLVE_IPC.orgEvolveHistory)).toBe(false)
  })

  it('analyze rebuilds its input: bounds and unknown fields', async () => {
    const { d, evolve } = setup()
    await d.invoke(EVOLVE_IPC.orgEvolveAnalyze, [{ projectId: 'proj_a', runs: 5, goal: 'cost', strategy: 'deterministic', minWaste: 30, evalWindowRuns: 4, snapshot: {}, extra: 1 }], rpc(['read']))
    expect(evolve.analyze).toHaveBeenCalledWith({ projectId: 'proj_a', runs: 5, goal: 'cost', strategy: 'deterministic', minWaste: 30 })
    for (const bad of [{ runs: 0 }, { runs: 51 }, { runs: 1.5 }, { goal: 'fast' }, { strategy: 'x' }, { minWaste: -1 }, { minWaste: 101 }]) {
      await expect(d.invoke(EVOLVE_IPC.orgEvolveAnalyze, [{ projectId: 'proj_a', ...bad }], rpc(['read'])), JSON.stringify(bad)).rejects.toThrow()
    }
    await expect(d.invoke(EVOLVE_IPC.orgEvolveAnalyze, [{ projectId: '../x' }], rpc(['read']))).rejects.toThrow('Project not found')
  })

  it('a hybrid analysis (one model call) needs configure on the desktop or in-process surface; others are refused, not downgraded', async () => {
    const { d, evolve } = setup()
    const hybrid = [{ projectId: 'proj_a', strategy: 'hybrid' }]
    for (const ctx of [rpc(['read'], 'inproc'), rpc(['read']), rpc(ALL)]) {
      const f = await failure(d.invoke(EVOLVE_IPC.orgEvolveAnalyze, hybrid, ctx) as Promise<unknown>)
      expect(f.code).toBe('scope_denied')
    }
    expect(evolve.analyze).not.toHaveBeenCalled()
    await d.invoke(EVOLVE_IPC.orgEvolveAnalyze, hybrid, rpc(['read', 'configure'], 'inproc'))
    await d.invoke(EVOLVE_IPC.orgEvolveAnalyze, hybrid, DESKTOP)
    expect(evolve.analyze).toHaveBeenCalledTimes(2)
    expect(evolve.analyze).toHaveBeenCalledWith({ projectId: 'proj_a', strategy: 'hybrid' })
    // Deterministic stays a plain read for everyone.
    await d.invoke(EVOLVE_IPC.orgEvolveAnalyze, [{ projectId: 'proj_a' }], rpc(['read']))
    expect(evolve.analyze).toHaveBeenCalledTimes(3)
  })

  it('apply keeps evalWindowRuns 1..10 and serves inproc and desktop', async () => {
    const { d, evolve } = setup()
    await d.invoke(EVOLVE_IPC.orgEvolveApply, [{ projectId: 'proj_a', evalWindowRuns: 2 }], rpc(ALL, 'inproc'))
    await d.invoke(EVOLVE_IPC.orgEvolveApply, [{ projectId: 'proj_a' }], DESKTOP)
    expect(evolve.apply).toHaveBeenNthCalledWith(1, { projectId: 'proj_a', evalWindowRuns: 2 })
    expect(evolve.apply).toHaveBeenNthCalledWith(2, { projectId: 'proj_a' })
    await expect(d.invoke(EVOLVE_IPC.orgEvolveApply, [{ projectId: 'proj_a', evalWindowRuns: 11 }], rpc(ALL, 'inproc'))).rejects.toThrow()
  })

  it('a socket client is refused apply, rollback and the post-run pass, whatever its scopes; reads are served', async () => {
    const { d, evolve } = setup()
    for (const [channel, input] of [
      [EVOLVE_IPC.orgEvolveApply, { projectId: 'proj_a' }],
      [EVOLVE_IPC.orgEvolveRollback, { projectId: 'proj_a' }],
      [EVOLVE_AFTER_RUN_CHANNEL, { runId: 'run_1' }]
    ] as const) {
      const f = await failure(d.invoke(channel, [input], rpc(ALL)) as Promise<unknown>)
      expect(f.code, channel).toBe('scope_denied')
    }
    expect(evolve.apply).not.toHaveBeenCalled()
    expect(evolve.rollback).not.toHaveBeenCalled()
    await d.invoke(EVOLVE_IPC.orgEvolveHistory, [{ projectId: 'proj_a' }], rpc(['read']))
    expect(evolve.history).toHaveBeenCalledWith('proj_a')
  })

  it('rollback validates the generation id and trims the reason', async () => {
    const { d, evolve } = setup()
    await d.invoke(EVOLVE_IPC.orgEvolveRollback, [{ projectId: 'proj_a', generationId: 'gen_2', reason: '  too\nslow  ' }], DESKTOP)
    expect(evolve.rollback).toHaveBeenCalledWith({ projectId: 'proj_a', generationId: 'gen_2', reason: 'too slow' })
    await expect(d.invoke(EVOLVE_IPC.orgEvolveRollback, [{ projectId: 'proj_a', generationId: '../gen' }], DESKTOP)).rejects.toThrow()
  })

  it('the post-run channel returns the awaited pass, else null', async () => {
    const { d } = setup()
    expect(await d.invoke(EVOLVE_AFTER_RUN_CHANNEL, [{ runId: 'run_1' }], DESKTOP)).toEqual({ projectId: 'proj_a', ratchet: 'none' })
    expect(await d.invoke(EVOLVE_AFTER_RUN_CHANNEL, [{ runId: 'run_9' }], DESKTOP)).toBeNull()
  })
})

describe('runs:start evolve', () => {
  it('passes evolve and its window from the desktop and the in-process CLI', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', evolve: 'hybrid', evolveWindowRuns: 4 }], DESKTOP)
    expect(runs.start.mock.calls[0][0]).toMatchObject({ evolve: 'hybrid', evolveWindowRuns: 4 })
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', evolve: true }], rpc(ALL, 'inproc'))
    expect(runs.start.mock.calls[1][0]).toMatchObject({ evolve: true })
    expect(runs.start.mock.calls[1][0]).not.toHaveProperty('evolveWindowRuns')
  })

  it('refuses a socket client that asks for evolve; false and absent pass', async () => {
    const { d, runs } = setup()
    const f = await failure(d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', evolve: true }], rpc(ALL)) as Promise<unknown>)
    expect(f.code).toBe('scope_denied')
    expect(runs.start).not.toHaveBeenCalled()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', evolve: false }], rpc(ALL))
    expect(runs.start.mock.calls[0][0]).not.toHaveProperty('evolve')
  })

  it('rejects a malformed evolve value', async () => {
    const { d } = setup()
    await expect(d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', evolve: 'maybe' }], DESKTOP)).rejects.toThrow('evolve must be')
  })
})
