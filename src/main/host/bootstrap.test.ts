import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsInfo, DaemonInfo, RunEvent } from '../../shared/types'
import { ACTIVITY_LEASE_KINDS, IPC } from '../../shared/types'

// bootOrgAIHost must boot in plain Node (cli-spec 3.1): any electron import fails the whole file.
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host bootstrap')
})

// Record every child process started, so a boot without background work can be shown to spawn nothing.
const spawned: string[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const wrap =
    <F extends (...args: never[]) => unknown>(name: string, fn: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      spawned.push(`${name} ${String(args[0])}`)
      return fn(...args) as ReturnType<F>
    }
  return {
    ...real,
    default: real,
    spawn: wrap('spawn', real.spawn),
    execFile: wrap('execFile', real.execFile),
    execFileSync: wrap('execFileSync', real.execFileSync),
    exec: wrap('exec', real.exec),
    execSync: wrap('execSync', real.execSync)
  }
})

const { bootOrgAIHost, defaultHousekeeping } = await import('./bootstrap')
const { HostDispatcher } = await import('./dispatcher')
const { HostEventBus } = await import('./events')
const { HostActivityTracker } = await import('./activity')
type OrgAIHost = import('./bootstrap').OrgAIHost
type BootOrgAIHostOptions = import('./bootstrap').BootOrgAIHostOptions

let root: string
let dataDir: string
let hosts: OrgAIHost[] = []

const info: DaemonInfo = { hostInstanceId: 'abcdef012345', pid: 4242, endpoint: '/tmp/x.sock', state: 'starting', startedAt: 1_700_000_000_000, hostKind: 'desktop' }

function fakeOwnership() {
  return { info, markReady: vi.fn(() => true), markDraining: vi.fn(() => true), release: vi.fn() }
}

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString()
}

const noopHousekeeping = { sweepStaleSkillDirs: () => {} }

function boot(over: Partial<BootOrgAIHostOptions> = {}): OrgAIHost {
  const h = bootOrgAIHost({
    env: { userDataDir: root, logsDir: join(root, 'logs'), appVersion: '9.9.9-test', isPackaged: false },
    dataDir,
    hostKind: 'desktop',
    ownership: fakeOwnership(),
    safeStorage,
    openExternal: () => {},
    mock: true,
    startBackground: false,
    housekeeping: noopHousekeeping,
    processEnv: {},
    homeDir: join(root, 'home'),
    ...over
  })
  hosts.push(h)
  return h
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-boot-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  spawned.length = 0
})

afterEach(async () => {
  for (const h of hosts) {
    await h.runs.stopAll({ reason: 'quit' }).catch(() => {})
    h.dispose()
  }
  hosts = []
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('bootOrgAIHost', () => {
  it('returns every host service, a HostDispatcher, a HostEventBus and the mock adapter', () => {
    const h = boot()
    const required = ['projects', 'runs', 'setup', 'maintenance', 'settings', 'connections', 'mcp', 'adapterIds', 'harnessProject', 'importer', 'skills', 'skillEvaluation', 'capabilities', 'quick', 'templates'] as const
    for (const k of required) expect(h.services[k], k).toBeDefined()
    for (const k of ['kit', 'events', 'activity', 'usage', 'env', 'host'] as const) expect(h.services[k], k).toBeDefined()
    expect(h.services.desktop).toBeUndefined()
    expect(h.dispatcher).toBeInstanceOf(HostDispatcher)
    expect(h.events).toBeInstanceOf(HostEventBus)
    expect(h.services.events).toBe(h.events)
    expect(h.activity).toBeInstanceOf(HostActivityTracker)
    expect(h.services.adapterIds).toEqual(expect.arrayContaining(['claude', 'codex', 'mock']))
    expect(h.runs).toBe(h.services.runs)
    expect(h.settings).toBe(h.services.settings)
    expect(h.services.env?.app.getVersion()).toBe('9.9.9-test')
    expect(h.services.env?.app.getPath('userData')).toBe(root)
    expect(h.services.env?.logsDir()).toBe(join(root, 'logs'))
    expect(h.services.env?.hostKind).toBe('desktop')
    expect(h.projectOrHarness('harness')?.id).toBe('harness')
    expect(h.projectOrHarness('quick')?.id).toBe('quick')
    expect(h.projectOrHarness('p_nope')).toBeNull()
  })

  it('passes the desktop hooks through when given', () => {
    const openRunWindow = vi.fn()
    const h = boot({ desktop: { openRunWindow } })
    expect(h.services.desktop?.openRunWindow).toBe(openRunWindow)
  })

  it('runs housekeeping in order, drops runs of unknown projects, then marks the host ready once', () => {
    const now = Date.now()
    const summary = (id: string, projectId: string) => ({ id, projectId, prompt: 'x', status: 'finished', startedAt: now, endedAt: now, kind: 'work' })
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ version: 1, runs: [summary('r_orphan', 'p_gone'), summary('r_chat', 'quick')] }))
    const order: string[] = []
    const ownership = fakeOwnership()
    ownership.markReady.mockImplementation(() => {
      order.push('markReady')
      return true
    })
    const housekeeping = {
      orphanRunProjects: vi.fn((ctx: Parameters<typeof defaultHousekeeping.orphanRunProjects>[0]) => {
        order.push('orphanRunProjects')
        return defaultHousekeeping.orphanRunProjects(ctx)
      }),
      removeProject: vi.fn((ctx: Parameters<typeof defaultHousekeeping.removeProject>[0], id: string) => {
        order.push(`removeProject:${id}`)
        return defaultHousekeeping.removeProject(ctx, id)
      }),
      prune: vi.fn((ctx: Parameters<typeof defaultHousekeeping.prune>[0]) => {
        order.push('prune')
        return defaultHousekeeping.prune(ctx)
      }),
      sweepOrphans: vi.fn((ctx: Parameters<typeof defaultHousekeeping.sweepOrphans>[0]) => {
        order.push('sweepOrphans')
        return defaultHousekeeping.sweepOrphans(ctx)
      }),
      sweepScratchDirs: vi.fn((ctx: Parameters<typeof defaultHousekeeping.sweepScratchDirs>[0]) => {
        order.push('sweepScratchDirs')
        return defaultHousekeeping.sweepScratchDirs(ctx)
      }),
      sweepStaleSkillDirs: vi.fn(() => {
        order.push('sweepStaleSkillDirs')
      })
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const h = boot({ ownership, housekeeping })
    expect(order).toEqual(['orphanRunProjects', 'removeProject:p_gone', 'prune', 'sweepOrphans', 'sweepScratchDirs', 'sweepStaleSkillDirs', 'markReady'])
    expect(ownership.markReady).toHaveBeenCalledTimes(1)
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8')) as { runs: { id: string }[] }
    expect(onDisk.runs.map((r) => r.id)).toEqual(['r_chat'])
    expect(h.runs.get('r_orphan')).toBeFalsy()
    expect(log).toHaveBeenCalledWith('Housekeeping removed 1 stale run(s) or record file(s).')
  })

  it('emits settings:changed on the bus with the effective default connection and the app version', () => {
    const h = boot()
    const seen: AppSettingsInfo[] = []
    h.events.on((channel, payload) => {
      if (channel === IPC.settingsChanged) seen.push(payload as AppSettingsInfo)
    })
    h.settings.set({ notifications: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ notifications: false, appVersion: '9.9.9-test', dataDir, defaultConnection: h.services.connections.effectiveDefault() })
  })

  it('emits connections:event mcp.authorize on the bus for an mcp:authorize with announceUrl (mock, no network)', async () => {
    // Secrets need encryption: the mock authorize stores a fake token.
    const h = boot({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) } })
    const seen: unknown[] = []
    h.events.on((channel, payload) => {
      if (channel === IPC.connectionsEvent) seen.push(payload)
    })
    const info = h.services.mcp.connectorsAdd({ connectorId: 'linear' })
    const status = await h.services.mcp.authorize({ libraryId: info.entry.id, announceUrl: true, openBrowser: false })
    expect(status).toMatchObject({ state: 'authorized' })
    const ev = seen.find((e) => (e as { type?: string }).type === 'mcp.authorize') as { authorize: { target: unknown; url: string; openedBrowser: boolean } } | undefined
    expect(ev?.authorize).toMatchObject({ target: { libraryId: info.entry.id }, openedBrowser: false })
    expect(ev?.authorize.url).toMatch(/^https:\/\/mock\.invalid\//)
  })

  it('emits runs:event on the bus for a mock work run (no tokens)', async () => {
    const h = boot()
    const events: RunEvent[] = []
    h.events.on((channel, payload) => {
      if (channel === IPC.runEvent) events.push(payload as RunEvent)
    })
    const folder = join(root, 'repo')
    mkdirSync(folder)
    const project = h.services.projects.create({ name: 'Mock', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    expect(project.provider.id).toBe('mock')
    const run = await h.runs.start({ project, prompt: 'hello' })
    await vi.waitFor(() => expect(events.some((e) => e.runId === run.id)).toBe(true))
    await h.runs.stopAll({ reason: 'quit' })
  })

  it('serves runs:start and runs:list over invokeRpc through the real gate on a booted host (mock, no tokens)', async () => {
    const h = boot()
    const folder = join(root, 'repo-rpc')
    mkdirSync(folder)
    const project = h.services.projects.create({ name: 'Rpc', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    const ctx = { surface: 'inproc' as const, grantedScopes: ['read', 'operate'] as const }
    const leases: number[] = []
    h.activity.onChange((snap) => leases.push(snap.counts.inFlightRpcMutations))
    const run = (await h.dispatcher.invokeRpc(IPC.runsStart, [{ projectId: project.id, prompt: 'hello over rpc' }], ctx)) as { id: string; projectId: string }
    expect(run.projectId).toBe(project.id)
    // The mutation held an inFlightRpcMutations lease and released it.
    expect(leases).toContain(1)
    expect(h.activity.snapshot().counts.inFlightRpcMutations).toBe(0)
    const listed = (await h.dispatcher.invokeRpc(IPC.runsList, [project.id], ctx)) as { id: string }[]
    expect(listed.map((r) => r.id)).toContain(run.id)
    // The real gate: scopes are explicit, params are shape-checked, unknown channels are refused.
    await expect(h.dispatcher.invokeRpc(IPC.runsStart, [{ projectId: project.id, prompt: 'x' }], { surface: 'inproc', grantedScopes: ['read'] })).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(h.dispatcher.invokeRpc(IPC.runsList, [{ not: 'an id' }], ctx)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(h.dispatcher.invokeRpc('runs:nothing', [], ctx)).rejects.toMatchObject({ code: 'unknown_channel' })
    // Deep validators: a decision that is not a PermissionDecision, or a prompt that is not text, is bad_request.
    const decide = { surface: 'inproc' as const, grantedScopes: ['read', 'operate', 'decide'] as const }
    await expect(h.dispatcher.invokeRpc(IPC.runsDecide, [{ runId: run.id, requestId: 'p1', decision: 'yes' }], decide)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(h.dispatcher.invokeRpc(IPC.mergesDecide, [{ runId: run.id, reviewId: 'm1', decision: { behavior: 'push' } }], decide)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(h.dispatcher.invokeRpc(IPC.runsStart, [{ projectId: project.id, prompt: { text: 'x' } }], ctx)).rejects.toMatchObject({ code: 'bad_request' })
    await h.runs.stopAll({ reason: 'quit' })
  })

  it('serves host.status from ownership info and the activity snapshot', async () => {
    const h = boot()
    const status = h.hostControl.status()
    expect(status).toMatchObject({
      protocolVersion: 1,
      hostInstanceId: 'abcdef012345',
      pid: 4242,
      startedAt: 1_700_000_000_000,
      hostKind: 'desktop',
      appVersion: '9.9.9-test',
      dataDir,
      mock: true
    })
    expect(typeof status.state).toBe('string')
    expect(status.activity).toHaveProperty('counts')
    expect(h.services.host).toBe(h.hostControl)
    const drain = vi.spyOn(h.activity, 'requestDrain')
    await h.hostControl.stop({ force: false })
    expect(drain).toHaveBeenCalledWith({ force: false })
  })

  it('host.stop over invokeRpc drains an idle host: its own call holds no lease, a later mutation gets host_draining', async () => {
    const own = fakeOwnership()
    const onDrained = vi.fn()
    const h = boot({ ownership: own, onDrained })
    expect(h.activity.snapshot().total).toBe(0)
    const ctx = { surface: 'inproc' as const, grantedScopes: ['read', 'operate', 'decide', 'configure'] as const }
    await expect(h.dispatcher.invokeRpc('host.stop', [{}], ctx)).resolves.toEqual({ stopping: true })
    expect(own.markDraining).toHaveBeenCalledTimes(1)
    expect(own.release).toHaveBeenCalledTimes(1)
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(h.activity.state()).toBe('draining')
    // A second stop joins the drain instead of being refused as a mutation.
    await expect(h.dispatcher.invokeRpc('host.stop', [{}], ctx)).resolves.toEqual({ stopping: true })
    await expect(h.dispatcher.invokeRpc(IPC.settingsSet, [{}], ctx)).rejects.toMatchObject({ code: 'host_draining' })
    expect(h.activity.snapshot().counts.inFlightRpcMutations).toBe(0)
  })

  it('host.stop without force over invokeRpc is refused while a run is live, naming liveRuns only', async () => {
    const h = boot()
    const folder = join(root, 'repo-stop')
    mkdirSync(folder)
    const project = h.services.projects.create({ name: 'Stop', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    const ctx = { surface: 'inproc' as const, grantedScopes: ['read', 'operate', 'configure'] as const }
    await h.dispatcher.invokeRpc(IPC.runsStart, [{ projectId: project.id, prompt: 'keep me live' }], ctx)
    const res = (await h.dispatcher.invokeRpc('host.stop', [{}], ctx)) as { stopping: boolean; refusedBecause?: Record<string, number> }
    expect(res.stopping).toBe(false)
    expect(res.refusedBecause?.inFlightRpcMutations).toBeUndefined()
    expect(h.activity.state()).toBe('ready')
    await h.runs.stopAll({ reason: 'quit' })
  })

  it('a forced host.stop with a live work run schedules no Team review, waits on none and refuses model calls after', async () => {
    const releasedWith: number[] = []
    const own = fakeOwnership()
    const h = boot({ ownership: own })
    own.release.mockImplementation(() => {
      releasedWith.push(h.activity.snapshot().counts.backgroundTasks)
    })
    const folder = join(root, 'repo-force')
    mkdirSync(folder)
    const project = h.services.projects.create({ name: 'Force', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    const runEnded = vi.spyOn(h.services.capabilities, 'runEnded')
    const ctx = { surface: 'inproc' as const, grantedScopes: ['read', 'operate', 'configure'] as const }
    await h.dispatcher.invokeRpc(IPC.runsStart, [{ projectId: project.id, prompt: 'keep me live' }], ctx)
    expect(h.runs.liveRuns().length).toBe(1)
    const started = Date.now()
    await expect(h.dispatcher.invokeRpc('host.stop', [{ force: true }], ctx)).resolves.toEqual({ stopping: true })
    // The run's end reached the Team assistant after it was disposed: nothing armed, nothing waited on.
    expect(runEnded).toHaveBeenCalled()
    expect(releasedWith).toEqual([0])
    expect(h.activity.snapshot().counts.backgroundTasks).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.runs.liveRuns().length).toBe(0)
    await expect(h.runs.completeForProject(project, { system: 's', prompt: 'p', kind: 'recommend', tier: 'everyday' })).rejects.toThrow(/quitting/)
  })

  it('registers polled activity sources for the five host-owned kinds', () => {
    const addSource = vi.spyOn(HostActivityTracker.prototype, 'addSource')
    const armIdle = vi.spyOn(HostActivityTracker.prototype, 'armIdleExit')
    boot()
    const kinds = addSource.mock.calls.map((c) => c[0])
    expect(kinds.sort()).toEqual(['activeOAuthFlows', 'activeWorktreeOps', 'backgroundTasks', 'liveRuns', 'pausedAutoResumes'])
    for (const kind of kinds) expect(ACTIVITY_LEASE_KINDS).toContain(kind)
    // Every source reads a number from the live services.
    for (const [, count] of addSource.mock.calls) expect(count()).toBe(0)
    // The desktop host never arms idle exit in Wave 1.
    expect(armIdle).not.toHaveBeenCalled()
  })

  it('arms idle exit for a non-desktop host', () => {
    const armIdle = vi.spyOn(HostActivityTracker.prototype, 'armIdleExit')
    boot({ hostKind: 'headless-host' })
    expect(armIdle).toHaveBeenCalledTimes(1)
  })

  it('a headless boot turns Terminal access on only while the user has not chosen a value', () => {
    const fresh = boot({ hostKind: 'headless-host' })
    expect(fresh.settings.get().terminalServer).toBe(true)
    expect(fresh.settings.get().terminalServerChosen).toBeUndefined()
    // The user turns it off in App settings (settings:set marks the choice), then a later headless boot keeps it off.
    fresh.settings.set({ ...fresh.settings.get(), terminalServer: false, terminalServerChosen: true })
    fresh.dispose()
    for (const hostKind of ['headless-host', 'inproc'] as const) {
      const later = boot({ hostKind })
      expect(later.settings.get().terminalServer, hostKind).toBe(false)
      expect(later.settings.get().terminalServerChosen).toBe(true)
      later.dispose()
    }
  })

  it('dispose() is idempotent and leaves no timers behind', () => {
    vi.useFakeTimers()
    const h = boot()
    const stop = vi.spyOn(h.services.capabilities, 'dispose')
    h.dispose()
    h.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('touches no network and spawns no process when background work is off', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    boot()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(spawned).toEqual([])
  })
})
