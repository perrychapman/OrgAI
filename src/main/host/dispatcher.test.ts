import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_IPC, HOST_METHODS, IPC, KIT_IPC, SECRETS_IPC } from '@shared/types'
import type { ActivityLeaseKind, HostScope, HostState, Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { VAULT_MESSAGES } from '../store/vaultTypes'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher, isMutatingChannel } = await import('./dispatcher')
const { HostEventBus } = await import('./events')
const { HostRpcFailure, socketInvokableChannels, desktopOnlyChannels } = await import('./registry')
const { requestChannels } = await import('./jsonCodec')
const { project: makeProject } = await import('../runtime/testHelpers')
type GateFn = import('./registry').GateFn
type HostServices = import('./types').HostServices
type HostActivityTrackerApi = import('./types').HostActivityTrackerApi
type RpcInvokeContext = import('./types').RpcInvokeContext

/** cli-spec 3.3(3) `request: desktop_only`: served by ipc.ts only. */
const DESKTOP_ONLY = [
  'projects:pickDirectory',
  'skillLibrary:addFromFolder',
  'kit:pickExportPath',
  'kit:pickImportPath',
  'kit:export',
  'kit:previewImport',
  'kit:applyImport',
  'menu:setState',
  'app:openPath',
  'app:openLogs',
  'app:setNotifications',
  'app:cliCommandStatus',
  'app:installCliCommand',
  'app:cancelCliInstall',
  'app:removeOldCliShim',
  'projects:parseRepoSource',
  'projects:repoTools',
  'projects:cloneRepo',
  'projects:cancelClone',
  'projects:setFolderConfigTrust',
  'teamFiles:approve',
  'teamFiles:reject',
  'teamFiles:undo',
  'teamFiles:enable',
  'teamFiles:commit',
  'outputs:open',
  'outputs:reveal',
  'outputs:saveAs',
  'outputs:saveImage'
]

const DESKTOP = { surface: 'desktop' as const, senderId: 1 }
const RPC: RpcInvokeContext = { surface: 'socket', grantedScopes: ['read', 'operate', 'decide', 'configure'] satisfies HostScope[] }

describe('model switching dispatch', () => {
  it.each([DESKTOP, RPC])('forwards the guarded selection to the run manager over $surface', async (context) => {
    const switchModel = vi.fn().mockResolvedValue({ applied: true })
    const d = new HostDispatcher(services({ runs: { switchModel } as never }))
    const input = { runId: 'run_1', expectedRunId: 'run_1', model: 'model-a', connection: 'anthropic' }
    await d.invoke(IPC.runsSwitchModel, [input], context)
    expect(switchModel).toHaveBeenCalledWith(input)
  })
})

/** A gate that trusts its table: positional params, a scope per channel, transport and mutation flags. */
function fakeGate(opts: { mutations?: string[]; transport?: string[] } = {}): GateFn {
  return (channel, params) => ({
    channel,
    args: Array.isArray(params) ? params : params === undefined ? [] : [params],
    entry: { direction: 'request', scope: 'read', bulk: false, params: [], source: 'test', ...(opts.transport?.includes(channel) ? { transport: true as const } : {}) },
    mutation: !!opts.mutations?.includes(channel)
  })
}

function fakeActivity(): HostActivityTrackerApi & { held: number; acquired: Array<[ActivityLeaseKind, string | undefined]>; setState(s: HostState): void } {
  let state: HostState = 'ready'
  const out = {
    held: 0,
    acquired: [] as Array<[ActivityLeaseKind, string | undefined]>,
    setState: (s: HostState) => void (state = s),
    acquire(kind: ActivityLeaseKind, label?: string) {
      out.acquired.push([kind, label])
      out.held++
      let done = false
      return () => {
        if (done) return
        done = true
        out.held--
      }
    },
    track: <T,>(_k: ActivityLeaseKind, p: Promise<T>) => p,
    addSource: () => () => {},
    snapshot: () => ({ counts: {} as never, total: out.held, idle: out.held === 0, state }),
    isIdle: () => out.held === 0,
    state: () => state,
    requestDrain: () => Promise.resolve({ stopping: false }),
    onChange: () => () => {}
  }
  return out
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-dispatcher-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function services(over: Partial<HostServices> = {}, stored: Project[] = [makeProject({ id: 'proj_a' })]): HostServices {
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const runs = {
    list: vi.fn(() => [] as RunSummary[]),
    summary: vi.fn(() => undefined),
    start: vi.fn(async () => ({ id: 'run_1' }) as RunSummary),
    stop: vi.fn(async () => {}),
    send: vi.fn(() => {
      throw new Error('send failed')
    })
  }
  return {
    projects: { get: (id: string) => stored.find((p) => p.id === id) ?? null, list: () => stored, saveFromRenderer: vi.fn() } as never,
    runs: runs as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: {} as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    importer: {} as never,
    skills: { list: vi.fn(() => []), libraryAddFromBundle: vi.fn(() => []) } as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: { displayProject: () => makeProject({ id: 'quick', roles: [] }) } as never,
    templates: { list: () => [] } as never,
    ...over
  }
}

describe('HostDispatcher.invoke (desktop path)', () => {
  it('keeps sync semantics: a sync throw stays sync, a sync result is not a promise', () => {
    const d = new HostDispatcher(services())
    expect(() => d.invoke(IPC.projectsSave, [{ id: 'quick' }], DESKTOP)).toThrow(/cannot be saved/)
    expect(() => d.invoke(IPC.skillsList, ['quick'], DESKTOP)).toThrow(/Project not found/)
    const listed = d.invoke(IPC.runsList, ['proj_a'], DESKTOP)
    expect(listed).toEqual([])
    expect(listed).not.toBeInstanceOf(Promise)
  })

  it('Wave 7 (4.3): a mutating channel is refused with host_draining while draining and leased until it settles; reads take no lease', async () => {
    const activity = fakeActivity()
    let finish!: (v: unknown) => void
    const start = vi.fn(() => new Promise((r) => (finish = r)))
    const d = new HostDispatcher(services({ activity, runs: { list: vi.fn(() => []), start } as never }))
    // A read: no lease, sync result.
    expect(d.invoke(IPC.runsList, ['proj_a'], DESKTOP)).toEqual([])
    expect(activity.acquired).toEqual([])
    // A mutation with a promise: leased until it settles.
    const p = d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'x' }], DESKTOP) as Promise<unknown>
    expect(activity.acquired).toEqual([['inFlightRpcMutations', IPC.runsStart]])
    expect(activity.held).toBe(1)
    finish({ id: 'run_1' })
    await expect(p).resolves.toEqual({ id: 'run_1' })
    await Promise.resolve()
    expect(activity.held).toBe(0)
    // A synchronous mutation that throws: still a sync throw, lease released.
    expect(() => d.invoke(IPC.projectsSave, [{ id: 'quick' }], DESKTOP)).toThrow(/cannot be saved/)
    expect(activity.held).toBe(0)
    // Draining: mutations refused before their handler, reads still answered.
    activity.setState('draining')
    expect(() => d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'x' }], DESKTOP)).toThrow(expect.objectContaining({ code: 'host_draining' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(d.invoke(IPC.runsList, ['proj_a'], DESKTOP)).toEqual([])
  })

  it('isMutatingChannel: a request above read that is not a lifecycle call; desktop-only channels are ipc.ts\'s', () => {
    expect(isMutatingChannel(IPC.settingsSet)).toBe(true)
    expect(isMutatingChannel(IPC.runsStart)).toBe(true)
    expect(isMutatingChannel(IPC.mcpAuthorize)).toBe(true)
    expect(isMutatingChannel(IPC.settingsGet)).toBe(false)
    expect(isMutatingChannel(HOST_METHODS.hostStop)).toBe(false)
    expect(isMutatingChannel(KIT_IPC.kitApplyImport)).toBe(false)
    expect(isMutatingChannel(IPC.runEvent)).toBe(false)
    expect(isMutatingChannel('made:up')).toBe(false)
  })

  it('mcp:authorize over RPC is refused while draining but takes no lease for its browser wait (round 6 item 9)', async () => {
    const activity = fakeActivity()
    let finish!: (v: unknown) => void
    const authorize = vi.fn(() => new Promise((r) => (finish = r)))
    const d = new HostDispatcher(services({ activity, mcp: { authorize } as never }), { gate: fakeGate({ mutations: [IPC.mcpAuthorize] }) })
    const p = d.invokeRpc(IPC.mcpAuthorize, [{ libraryId: 'x' }], RPC)
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1))
    expect(activity.acquired).toEqual([])
    finish({ state: 'authorized' })
    await expect(p).resolves.toEqual({ state: 'authorized' })
    activity.setState('draining')
    await expect(d.invokeRpc(IPC.mcpAuthorize, [{ libraryId: 'x' }], RPC)).rejects.toMatchObject({ code: 'host_draining' })
    expect(() => d.invoke(IPC.mcpAuthorize, [{ libraryId: 'x' }], DESKTOP)).toThrow(expect.objectContaining({ code: 'host_draining' }))
  })

  it('quiesce aborts an org chart draft in flight, so its mutation lease ends and Quit does not wait on the model (review round 2)', async () => {
    const activity = fakeActivity()
    const seen: { signal?: AbortSignal }[] = []
    const adapter = {
      complete: vi.fn(
        (input: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            seen.push(input)
            input.signal?.addEventListener('abort', () => reject(new Error('Completion cancelled')), { once: true })
          })
      )
    }
    const d = new HostDispatcher(
      services({
        activity,
        runs: { adapterFor: () => adapter } as never,
        connections: { effectiveSettings: () => DEFAULT_APP_SETTINGS, importModelContext: () => undefined } as never
      })
    )
    const p = d.invoke(IPC.draftOrgChart, [{ projectId: 'proj_a', instruction: 'a team', mode: 'new' }], DESKTOP) as Promise<unknown>
    const settled = p.then(
      () => 'resolved',
      (e: Error) => e.message
    )
    await vi.waitFor(() => expect(adapter.complete).toHaveBeenCalledTimes(1))
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
    expect(seen[0].signal!.aborted).toBe(false)
    expect(activity.held).toBe(1)
    d.quiesce()
    await expect(settled).resolves.toBe('Completion cancelled')
    await Promise.resolve()
    expect(activity.held).toBe(0)
    // Idempotent; a later draft is refused while draining (before the model) and an aborted signal never reaches one.
    d.quiesce()
    activity.setState('draining')
    expect(() => d.invoke(IPC.draftOrgChart, [{ projectId: 'proj_a', instruction: 'x', mode: 'new' }], DESKTOP)).toThrow(
      expect.objectContaining({ code: 'host_draining' })
    )
    expect(adapter.complete).toHaveBeenCalledTimes(1)
  })

  it('async handlers reject', async () => {
    const d = new HostDispatcher(services())
    const p = d.invoke(IPC.runsStart, [{ projectId: 'nope', prompt: 'x' }], DESKTOP)
    expect(p).toBeInstanceOf(Promise)
    await expect(p).rejects.toThrow('Project not found')
  })

  it('agrees with the registry: serves exactly its socket-invokable channels (with a kit), none of its desktop-only ones', () => {
    const kit = { exportBundle: vi.fn(), previewBundle: vi.fn(), applyBundle: vi.fn() }
    const d = new HostDispatcher(services({ kit: kit as never, teamFiles: {} as never }))
    expect([...d.channels()].sort()).toEqual([...socketInvokableChannels()].sort())
    expect([...desktopOnlyChannels()].sort()).toEqual([...DESKTOP_ONLY].sort())
  })

  it('an unknown channel throws with code unknown_channel', () => {
    const d = new HostDispatcher(services())
    for (const ch of ['nope:nothing', '__proto__', 'toString', ...DESKTOP_ONLY]) {
      let caught: unknown
      try {
        d.invoke(ch, [], DESKTOP)
      } catch (e) {
        caught = e
      }
      expect((caught as { code?: string })?.code, ch).toBe('unknown_channel')
      expect(d.has(ch)).toBe(false)
    }
  })

  it('serves every request channel except the desktop-only ones and runs:subscribe, plus host.status and host.stop', () => {
    const kit = { exportBundle: vi.fn(), previewBundle: vi.fn(), applyBundle: vi.fn() }
    const d = new HostDispatcher(services({ kit: kit as never, teamFiles: {} as never }))
    const expected = requestChannels().filter((c) => !DESKTOP_ONLY.includes(c) && c !== 'runs:subscribe')
    expected.push('host.status', 'host.stop')
    expect([...d.channels()].sort()).toEqual([...new Set(expected)].sort())
    expect(d.channels()).toHaveLength(new Set(d.channels()).size)
    // Without a kit the three bundle channels are not served (like today's kit channels).
    const bare = new HostDispatcher(services())
    expect(bare.channels().filter((c) => c.startsWith('kit:'))).toEqual([])
    expect(bare.has(HOST_IPC.kitApplyBundle)).toBe(false)
    expect(bare.has(KIT_IPC.kitExport)).toBe(false)
    expect(bare.has(HOST_METHODS.hostSubscribe)).toBe(false)
    expect(bare.has(HOST_METHODS.hostHello)).toBe(false)
  })

  it('app:info and settings info read the env, not Electron', () => {
    const env = { app: { getVersion: () => '9.9.9', getPath: () => '', isPackaged: true }, platform: 'linux', logsDir: () => '/var/log/orgai' }
    const d = new HostDispatcher(services({ env }))
    expect(d.invoke(IPC.appInfo, [], DESKTOP)).toMatchObject({ version: '9.9.9', platform: 'linux', logsDir: '/var/log/orgai', mockAdapter: true })
    expect(d.invoke(IPC.settingsGet, [], DESKTOP)).toMatchObject({ appVersion: '9.9.9', defaultConnection: 'anthropic' })
    expect(d.invoke(IPC.appLogPath, [], DESKTOP)).toBe('/logs/main.log')
  })
})

describe('HostDispatcher.invokeRpc (wire path)', () => {
  it('holds an inFlightRpcMutations lease for mutations and releases it on success, sync throw and rejection', async () => {
    const activity = fakeActivity()
    const svc = services({ activity })
    const d = new HostDispatcher(svc, { gate: fakeGate({ mutations: [IPC.runsStop, IPC.runsSend, IPC.runsStart] }) })
    let seen = -1
    ;(svc.runs as unknown as { stop: ReturnType<typeof vi.fn> }).stop.mockImplementation(async () => {
      seen = activity.held
    })
    await d.invokeRpc(IPC.runsStop, ['run_1'], RPC)
    expect(seen).toBe(1)
    expect(activity.held).toBe(0)
    expect(activity.acquired).toEqual([['inFlightRpcMutations', IPC.runsStop]])
    await expect(d.invokeRpc(IPC.runsSend, [{ runId: 'run_1', text: 'x' }], RPC)).rejects.toThrow('send failed')
    expect(activity.held).toBe(0)
    await expect(d.invokeRpc(IPC.runsStart, [{ projectId: 'nope', prompt: 'x' }], RPC)).rejects.toThrow('Project not found')
    expect(activity.held).toBe(0)
    expect(activity.acquired).toHaveLength(3)
  })

  it('takes no lease for reads', async () => {
    const activity = fakeActivity()
    const d = new HostDispatcher(services({ activity }), { gate: fakeGate() })
    await expect(d.invokeRpc(IPC.runsList, ['proj_a'], RPC)).resolves.toEqual([])
    expect(activity.acquired).toEqual([])
  })

  it('refuses mutations with host_draining while draining; reads still run', async () => {
    const activity = fakeActivity()
    activity.setState('draining')
    const svc = services({ activity })
    const d = new HostDispatcher(svc, { gate: fakeGate({ mutations: [IPC.runsStop] }) })
    const err = await d.invokeRpc(IPC.runsStop, ['run_1'], RPC).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostRpcFailure)
    expect(err).toMatchObject({ code: 'host_draining', retryAfterMs: 1000 })
    expect((svc.runs as unknown as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled()
    expect(activity.acquired).toEqual([])
    await expect(d.invokeRpc(IPC.runsList, ['proj_a'], RPC)).resolves.toEqual([])
  })

  it('refuses transport entries and channels without a handler', async () => {
    const d = new HostDispatcher(services(), { gate: fakeGate({ transport: [HOST_IPC.runsSubscribe, HOST_METHODS.hostSubscribe] }) })
    await expect(d.invokeRpc(HOST_IPC.runsSubscribe, [{}], RPC)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(d.invokeRpc(HOST_METHODS.hostSubscribe, [{}], RPC)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(d.invokeRpc(HOST_IPC.kitApplyBundle, [{}], RPC)).rejects.toMatchObject({ code: 'unknown_channel' })
  })

  it('uses the real gate by default: known channels pass, unknown and out-of-scope ones are refused', async () => {
    const d = new HostDispatcher(services())
    await expect(d.invokeRpc(IPC.runsList, ['proj_a'], RPC)).resolves.toEqual([])
    await expect(d.invokeRpc('nope:nothing', [], RPC)).rejects.toMatchObject({ code: 'unknown_channel' })
    await expect(d.invokeRpc(IPC.runsStop, ['run_1'], { surface: 'socket', grantedScopes: ['read'] })).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(d.invokeRpc(IPC.runsList, [42], RPC)).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('maps coded errors to HostRpcFailure and passes other errors through', async () => {
    const coded = (code: string, message: string) => Object.assign(new Error(message), { code })
    const kit = {
      exportBundle: vi.fn(() => {
        throw new Error('plain failure')
      }),
      previewBundle: vi.fn(() => {
        throw coded('ENOENT', 'not a wire code')
      }),
      applyBundle: vi.fn(async () => {
        throw coded('stale_target_digest', 'The library changed.')
      })
    }
    const d = new HostDispatcher(services({ kit: kit as never, teamFiles: {} as never }), { gate: fakeGate({ mutations: [HOST_IPC.kitApplyBundle] }) })
    const digest = 'a'.repeat(64)
    const stale = await d.invokeRpc(HOST_IPC.kitApplyBundle, [{ rawBytesBase64: '', digest, targetDigest: digest, choices: [] }], RPC).catch((e: unknown) => e)
    expect(kit.applyBundle).toHaveBeenCalled()
    expect(stale).toBeInstanceOf(HostRpcFailure)
    expect(stale).toMatchObject({ code: 'stale_target_digest', message: 'The library changed.' })
    const plain = await d.invokeRpc(HOST_IPC.kitExportBundle, [{ include: {} }], RPC).catch((e: unknown) => e)
    expect(plain).not.toBeInstanceOf(HostRpcFailure)
    expect(plain).toMatchObject({ message: 'plain failure' })
    const enoent = await d.invokeRpc(HOST_IPC.kitPreviewBundle, [{ fileName: 'k.orgai-kit.json', rawBytesBase64: '' }], RPC).catch((e: unknown) => e)
    expect(enoent).not.toBeInstanceOf(HostRpcFailure)
    expect(enoent).toMatchObject({ code: 'ENOENT' })
    const failure = new HostRpcFailure('scope_denied', 'no')
    kit.exportBundle.mockImplementation(() => {
      throw failure
    })
    await expect(d.invokeRpc(HOST_IPC.kitExportBundle, [{ include: {} }], RPC)).rejects.toBe(failure)
  })

  it('maps the knowledge store stale_revision refusal', async () => {
    const eng = makeProject({ id: 'proj_e', kind: 'engagement' })
    const d = new HostDispatcher(services({}, [eng]), { gate: fakeGate({ mutations: [IPC.knowledgeSaveNode] }) })
    const node = (await d.invokeRpc(IPC.knowledgeSaveNode, [{ projectId: 'proj_e', kind: 'person', name: 'Ada' }], RPC)) as { id: string; updatedAt: number }
    const err = await d
      .invokeRpc(IPC.knowledgeSaveNode, [{ projectId: 'proj_e', nodeId: node.id, appendFacts: ['x'], expectedUpdatedAt: node.updatedAt - 1 }], RPC)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostRpcFailure)
    expect(err).toMatchObject({ code: 'stale_revision' })
  })
})

describe('host-specific handlers', () => {
  it('window:openRun without desktop hooks answers desktop_unavailable; with them it opens the window', async () => {
    const d = new HostDispatcher(services())
    const target = { projectId: 'proj_a', runId: 'run_1' }
    const svc = services()
    ;(svc.runs as unknown as { summary: ReturnType<typeof vi.fn> }).summary.mockReturnValue({ projectId: 'proj_a' })
    const bare = new HostDispatcher(svc)
    expect(() => bare.invoke(IPC.windowOpenRun, [target], DESKTOP)).toThrow(HostRpcFailure)
    try {
      bare.invoke(IPC.windowOpenRun, [target], DESKTOP)
    } catch (e) {
      expect(e).toMatchObject({ code: 'desktop_unavailable' })
    }
    const openRunWindow = vi.fn()
    const withHooks = new HostDispatcher({ ...svc, desktop: { openRunWindow } })
    withHooks.invoke(IPC.windowOpenRun, [target], DESKTOP)
    expect(openRunWindow).toHaveBeenCalledWith(target)
    // Validation runs first: an unknown project is refused before the hooks are asked.
    expect(() => d.invoke(IPC.windowOpenRun, [{ projectId: 'nope', runId: 'run_1' }], DESKTOP)).toThrow()
    expect(() => d.invoke(IPC.windowOpenRun, [{ projectId: 'nope', runId: 'run_1' }], DESKTOP)).not.toThrow(HostRpcFailure)
  })

  it('usage:refresh resolves null without a usage monitor and delegates with one', async () => {
    await expect(new HostDispatcher(services()).invoke(IPC.usageRefresh, [], DESKTOP)).resolves.toBeNull()
    const refresh = vi.fn(async () => ({ ok: 1 }))
    await expect(new HostDispatcher(services({ usage: { refresh } })).invoke(IPC.usageRefresh, [], DESKTOP)).resolves.toEqual({ ok: 1 })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('host.status and host.stop delegate to services.host; host.stop rebuilds force', async () => {
    const bare = new HostDispatcher(services(), { gate: fakeGate() })
    await expect(bare.invokeRpc(HOST_METHODS.hostStatus, [], RPC)).rejects.toMatchObject({ code: 'desktop_unavailable' })
    await expect(bare.invokeRpc(HOST_METHODS.hostStop, [{}], RPC)).rejects.toMatchObject({ code: 'desktop_unavailable' })
    const status = { state: 'ready' }
    const host = { status: vi.fn(() => status as never), stop: vi.fn(async () => ({ stopping: true })) }
    const d = new HostDispatcher(services({ host }), { gate: fakeGate({ mutations: [HOST_METHODS.hostStop] }) })
    await expect(d.invokeRpc(HOST_METHODS.hostStatus, [], RPC)).resolves.toBe(status)
    await d.invokeRpc(HOST_METHODS.hostStop, [{ force: true, evil: 1 }], RPC)
    await d.invokeRpc(HOST_METHODS.hostStop, [{ force: 'yes' }], RPC)
    await d.invokeRpc(HOST_METHODS.hostStop, [], RPC)
    // A handoff flag is not part of host.stop any more: it is dropped.
    await d.invokeRpc(HOST_METHODS.hostStop, [{ handoff: true }], RPC)
    expect(host.stop.mock.calls).toEqual([[{ force: true }], [{ force: false }], [{ force: false }], [{ force: false }]])
  })

  it('secrets:* (Wave 7): every channel goes to the store with its input rebuilt; bad input is bad_request; no store refuses all', async () => {
    const report = { state: 'absent' }
    const store = {
      statusReport: vi.fn(async () => report),
      initVault: vi.fn(async () => ({ action: 'created', status: report })),
      resetVault: vi.fn(async () => ({ movedTo: 'vault.json.reset-1', status: report })),
      undelete: vi.fn(() => ({ restored: true })),
      confirmDeletes: vi.fn(() => ({ confirmed: ['k1'] }))
    }
    const d = new HostDispatcher(services({ secrets: store as never }), { gate: fakeGate() })
    await expect(d.invokeRpc(SECRETS_IPC.secretsStatus, [], RPC)).resolves.toBe(report)
    await expect(d.invokeRpc(SECRETS_IPC.secretsStatus, [{ probe: true, extra: 1 }], RPC)).resolves.toBe(report)
    await d.invokeRpc(SECRETS_IPC.secretsStatus, [{ probe: 'yes' }], RPC)
    expect(store.statusReport.mock.calls).toEqual([[{}], [{ probe: true }], [{}]])

    const keyFile = join(dir, 'outside', 'vault.key')
    await d.invokeRpc(SECRETS_IPC.secretsInit, [], RPC)
    await d.invokeRpc(SECRETS_IPC.secretsInit, [{ keyFile, importKeyFile: true, evil: 1 }], RPC)
    expect(store.initVault.mock.calls).toEqual([[{}], [{ keyFile, importKeyFile: true }]])
    for (const bad of [{ keyFile: 'relative/key' }, { keyFile: 42 }, { importKeyFile: true }, { keyFile: `${keyFile}\u0000x` }, { keyFile, importKeyFile: 'yes' }, 'x']) {
      await expect(d.invokeRpc(SECRETS_IPC.secretsInit, [bad], RPC), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(store.initVault).toHaveBeenCalledTimes(2)

    await expect(d.invokeRpc(SECRETS_IPC.secretsReset, [{}], RPC)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(d.invokeRpc(SECRETS_IPC.secretsReset, [{ confirm: true }], RPC)).resolves.toMatchObject({ movedTo: 'vault.json.reset-1' })
    expect(store.resetVault.mock.calls).toEqual([[{ confirm: true }]])

    await expect(d.invokeRpc(SECRETS_IPC.secretsUndelete, [{ key: 'mcp:p:s:env:TOKEN' }], RPC)).resolves.toEqual({ restored: true })
    for (const bad of [{}, { key: '' }, { key: ' padded' }, { key: 'a\nb' }, { key: 'x'.repeat(513) }]) {
      await expect(d.invokeRpc(SECRETS_IPC.secretsUndelete, [bad], RPC), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(store.undelete.mock.calls).toEqual([[{ key: 'mcp:p:s:env:TOKEN' }]])

    await expect(d.invokeRpc(SECRETS_IPC.secretsConfirmDelete, [{ keys: ['k1', 'k1', 'k2'] }], RPC)).resolves.toEqual({ confirmed: ['k1'] })
    expect(store.confirmDeletes.mock.calls).toEqual([[{ keys: ['k1', 'k2'] }]])
    await expect(d.invokeRpc(SECRETS_IPC.secretsConfirmDelete, [{ keys: 'k1' }], RPC)).rejects.toMatchObject({ code: 'bad_request' })
    await expect(d.invokeRpc(SECRETS_IPC.secretsConfirmDelete, [{ keys: Array.from({ length: 1001 }, (_, i) => `k${i}`) }], RPC)).rejects.toMatchObject({ code: 'bad_request' })

    const bare = new HostDispatcher(services(), { gate: fakeGate() })
    for (const c of Object.values(SECRETS_IPC)) await expect(bare.invokeRpc(c, [{ confirm: true, key: 'k', keys: [] }], RPC), c).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('secrets:reset is refused while an MCP sign-in or a token refresh is in flight (5.6 Reset)', async () => {
    const resetVault = vi.fn(async () => ({ movedTo: null, status: { state: 'absent' } }))
    const counts = { auth: 1, refresh: 0 }
    const mcp = { activeAuthorizationCount: () => counts.auth, refreshingCount: () => counts.refresh }
    const d = new HostDispatcher(services({ secrets: { resetVault } as never, mcp: mcp as never }), { gate: fakeGate() })
    await expect(d.invokeRpc(SECRETS_IPC.secretsReset, [{ confirm: true }], RPC)).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    counts.auth = 0
    counts.refresh = 2
    await expect(d.invokeRpc(SECRETS_IPC.secretsReset, [{ confirm: true }], RPC)).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    expect(resetVault).not.toHaveBeenCalled()
    counts.refresh = 0
    await d.invokeRpc(SECRETS_IPC.secretsReset, [{ confirm: true }], RPC)
    expect(resetVault).toHaveBeenCalledTimes(1)
  })

  it('secrets:reset is refused while a predicate-prepared secret write is between its prepare and the end of its handler', async () => {
    // Round 2 review: a reset landing after `await prepareWrite()` and before the handler's set() moved secure storage aside
    // under it (VaultNotReady on a Node host).
    let finishPrepare!: () => void
    const prepareWrite = vi.fn(() => new Promise<void>((r) => (finishPrepare = r)))
    let finishHandler!: () => void
    const statusReport = vi.fn(() => new Promise((r) => (finishHandler = () => r({ state: 'open' }))))
    const resetVault = vi.fn(async () => ({ movedTo: 'vault.json.reset-1', status: { state: 'absent' } }))
    const gate: GateFn = (channel, params) => ({
      channel,
      args: Array.isArray(params) ? params : [],
      entry: { direction: 'request', scope: 'read', bulk: false, params: [], source: 'test', storesSecret: (args) => (args[0] as { store?: boolean } | undefined)?.store === true },
      mutation: false
    })
    const d = new HostDispatcher(services({ secrets: { prepareWrite, statusReport, resetVault } as never, mcp: { activeAuthorizationCount: () => 0, refreshingCount: () => 0 } as never }), { gate })
    const reset = () => d.invokeRpc(SECRETS_IPC.secretsReset, [{ confirm: true }], RPC)
    const write = d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: true }], RPC)
    await vi.waitFor(() => expect(prepareWrite).toHaveBeenCalledTimes(1))
    // Preparing (the custodian may take up to 10 s): busy.
    await expect(reset()).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    finishPrepare()
    await vi.waitFor(() => expect(statusReport).toHaveBeenCalledTimes(1))
    // Prepared, handler not settled yet: still busy.
    await expect(reset()).rejects.toThrow(VAULT_MESSAGES.resetBusy)
    expect(resetVault).not.toHaveBeenCalled()
    finishHandler()
    await write
    await reset()
    expect(resetVault).toHaveBeenCalledTimes(1)
    // A refused prepare or a throwing handler ends the write too; a call whose predicate is false never counts.
    prepareWrite.mockRejectedValueOnce(new Error('locked'))
    await expect(d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: true }], RPC)).rejects.toThrow('locked')
    statusReport.mockRejectedValueOnce(new Error('boom'))
    prepareWrite.mockResolvedValueOnce(undefined)
    await expect(d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: true }], RPC)).rejects.toThrow('boom')
    const plain = d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: false }], RPC)
    await reset()
    expect(resetVault).toHaveBeenCalledTimes(2)
    finishHandler()
    await plain
  })

  it('invokeRpc awaits secrets.prepareWrite() before the handler only when storesSecret is true (Wave 7)', async () => {
    const order: string[] = []
    const prepareWrite = vi.fn(async () => void order.push('prepare'))
    const statusReport = vi.fn(async () => (order.push('handler'), { state: 'absent' }))
    const keys = vi.fn(() => ['k'])
    const seen: unknown[] = []
    const gate: GateFn = (channel, params) => ({
      channel,
      args: Array.isArray(params) ? params : [],
      entry: {
        direction: 'request',
        scope: 'read',
        bulk: false,
        params: [],
        source: 'test',
        storesSecret: (args, view) => {
          seen.push(view.secretKeys('x'))
          return (args[0] as { store?: boolean } | undefined)?.store === true
        }
      },
      mutation: false
    })
    const d = new HostDispatcher(services({ secrets: { statusReport, prepareWrite, keys } as never }), { gate })
    await d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: false }], RPC)
    expect(prepareWrite).not.toHaveBeenCalled()
    await d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: true }], RPC)
    expect(order).toEqual(['handler', 'prepare', 'handler'])
    expect(seen).toEqual([['k'], ['k']])
    // A refused prepareWrite never reaches the handler.
    prepareWrite.mockRejectedValueOnce(new Error('locked'))
    await expect(d.invokeRpc(SECRETS_IPC.secretsStatus, [{ store: true }], RPC)).rejects.toThrow('locked')
    expect(statusReport).toHaveBeenCalledTimes(2)
  })

  it('skillLibrary:addFromBundle validates through bundleArgs', () => {
    const svc = services()
    const d = new HostDispatcher(svc)
    expect(() => d.invoke(HOST_IPC.skillLibraryAddFromBundle, [{ files: [] }], DESKTOP)).toThrow(/needs a name/)
    expect(() => d.invoke(HOST_IPC.skillLibraryAddFromBundle, [null], DESKTOP)).toThrow(/not valid/)
    d.invoke(HOST_IPC.skillLibraryAddFromBundle, [{ name: 'tidy', files: [{ relPath: 'SKILL.md', base64: 'eA==', extra: 1 }], evil: 1 }], DESKTOP)
    const add = (svc.skills as unknown as { libraryAddFromBundle: ReturnType<typeof vi.fn> }).libraryAddFromBundle
    expect(add.mock.calls).toEqual([[{ name: 'tidy', files: [{ relPath: 'SKILL.md', base64: 'eA==' }] }]])
  })

  it('kit:*Bundle call the KitService methods with rebuilt inputs', async () => {
    const kit = { exportBundle: vi.fn((_input: unknown) => ({ fileName: 'k' })), previewBundle: vi.fn(() => ({ items: [] })), applyBundle: vi.fn(async () => ({ applied: [] })) }
    const d = new HostDispatcher(services({ kit: kit as never, teamFiles: {} as never }))
    d.invoke(HOST_IPC.kitExportBundle, [{ include: {}, fileName: 'mine', x: 1 }], DESKTOP)
    expect(kit.exportBundle).toHaveBeenCalledOnce()
    expect(kit.exportBundle.mock.calls[0][0]).toMatchObject({ fileName: 'mine' })
    expect(kit.exportBundle.mock.calls[0][0]).not.toHaveProperty('x')
    d.invoke(HOST_IPC.kitPreviewBundle, [{ fileName: 'k.orgai-kit.json', rawBytesBase64: 'e30=', x: 1 }], DESKTOP)
    expect(kit.previewBundle.mock.calls).toEqual([[{ fileName: 'k.orgai-kit.json', rawBytesBase64: 'e30=' }]])
    expect(() => d.invoke(HOST_IPC.kitPreviewBundle, [{ rawBytesBase64: 5 }], DESKTOP)).toThrow()
    const digest = 'b'.repeat(64)
    await d.invoke(HOST_IPC.kitApplyBundle, [{ rawBytesBase64: 'e30=', digest, targetDigest: digest, choices: [] }], DESKTOP)
    expect(kit.applyBundle).toHaveBeenCalledOnce()
    expect(() => d.invoke(HOST_IPC.kitApplyBundle, [{ rawBytesBase64: 'e30=' }], DESKTOP)).toThrow()
    expect(kit.applyBundle).toHaveBeenCalledOnce()
  })

  it('knowledge, notes and document writes emit projects:engagementChanged on services.events', () => {
    const events = new HostEventBus()
    const seen: Array<[string, unknown]> = []
    events.on((channel, payload) => void seen.push([channel, payload]))
    const eng = makeProject({ id: 'proj_e', kind: 'engagement' })
    const d = new HostDispatcher(services({ events }, [eng]))
    expect(d.events).toBe(events)
    const node = d.invoke(IPC.knowledgeSaveNode, [{ projectId: 'proj_e', kind: 'person', name: 'Ada' }], DESKTOP) as { id: string }
    const note = d.invoke(IPC.projectsSaveNote, [{ projectId: 'proj_e', title: 'T', text: 'x' }], DESKTOP) as { id: string }
    d.invoke(IPC.projectsRemoveNote, [{ projectId: 'proj_e', noteId: note.id }], DESKTOP)
    d.invoke(IPC.projectsUpdateEngagementDocument, [{ projectId: 'proj_e', text: '# Plan' }], DESKTOP)
    d.invoke(IPC.knowledgeClear, ['proj_e'], DESKTOP)
    expect(seen).toEqual([
      [IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'knowledge', ids: [node.id] }],
      [IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'notes', ids: [note.id] }],
      [IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'notes', ids: [note.id] }],
      [IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'document' }],
      [IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'knowledge' }]
    ])
  })

  it('makes its own bus when none is given', () => {
    const d = new HostDispatcher(services())
    expect(d.events).toBeInstanceOf(HostEventBus)
  })
})
