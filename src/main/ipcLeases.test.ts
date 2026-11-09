// Wave 7 (cli-standalone.md 4.3 "Every mutation is leased"): every ipcMain handler of a mutating channel, the
// dispatcher's (HostDispatcher.invoke) and the desktop-only ones (ipc.ts handleMutating), refuses new work with
// host_draining while the host drains and holds an inFlightRpcMutations lease until its result settles.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_IPC, HOST_METHODS, IPC, KIT_IPC } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '1.2.3', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '/logs' }))

const { registerIpc, DESKTOP_ONLY_CHANNELS, DESKTOP_CHANNEL_MUTATES, handleMutating } = await import('./ipc')
const { HostActivityTracker } = await import('./host/activity')
const { isMutatingChannel } = await import('./host/dispatcher')
const { COMMIT_LEASED_CHANNELS } = await import('./host/mutationLease')
const { project: makeProject } = await import('./runtime/testHelpers')
type IpcServices = import('./ipc').IpcServices
type Tracker = InstanceType<typeof HostActivityTracker>

const SOCKET_ONLY = new Set<string>([...Object.values(HOST_IPC), ...Object.values(HOST_METHODS)])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-ipc-lease-'))
  handlers.clear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const kit = { exportBundle: vi.fn(), previewBundle: vi.fn(), applyBundle: vi.fn(), export: vi.fn(), previewImport: vi.fn(), applyImport: vi.fn(() => ({ ok: true })) }
const repoClone = { parse: vi.fn(), tools: vi.fn(async () => ({})), clone: vi.fn(), cancel: vi.fn() }
const cliInstall = { status: vi.fn(), install: vi.fn(async () => ({ ok: true })), removeOldShim: vi.fn(async () => ({ ok: true })), cancel: vi.fn(() => false) }

function services(activity: Tracker, over: Partial<IpcServices> = {}): IpcServices {
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  return {
    projects: { get: () => null, list: () => [makeProject({ id: 'p1' })] } as never,
    runs: { list: () => [] } as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: {} as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    openRunWindow: vi.fn(),
    importer: {} as never,
    skills: {} as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: { displayProject: () => makeProject({ id: 'quick', roles: [] }) } as never,
    templates: {} as never,
    usage: { refresh: vi.fn(async () => null) },
    kit: kit as never,
    repoClone: repoClone as never,
    cliInstall: cliInstall as never,
    activity,
    ...over
  }
}

async function draining(): Promise<Tracker> {
  const a = new HostActivityTracker()
  await a.requestDrain({ force: true })
  expect(a.state()).toBe('draining')
  return a
}

/** Call a handler; the error code when it threw (sync or async), else undefined. */
async function refusalOf(channel: string): Promise<string | undefined> {
  const sender = { id: 7, isDestroyed: () => false, send: () => {}, on: () => {}, removeListener: () => {}, once: () => {} }
  try {
    await handlers.get(channel)!({ sender }, {})
    return undefined
  } catch (e) {
    return (e as { code?: string }).code ?? 'other'
  }
}

describe('desktop mutation leases (cli-standalone.md 4.3)', () => {
  it('every desktop-only channel is classified as mutating or not, and nothing else is', () => {
    expect(Object.keys(DESKTOP_CHANNEL_MUTATES).sort()).toEqual([...DESKTOP_ONLY_CHANNELS].sort())
    // The ones the spec names are mutating.
    for (const c of [KIT_IPC.kitApplyImport, IPC.skillLibraryAddFromFolder, IPC.appSetNotifications, IPC.projectsCloneRepo]) expect(DESKTOP_CHANNEL_MUTATES[c], c).toBe(true)
  })

  it('every mutating ipcMain handler (dispatcher and desktop-only) refuses with host_draining while draining; read-only ones never do', async () => {
    registerIpc(services(await draining()))
    const mutating: string[] = []
    for (const channel of handlers.keys()) {
      expect(SOCKET_ONLY.has(channel), channel).toBe(false)
      const mutates = channel in DESKTOP_CHANNEL_MUTATES ? DESKTOP_CHANNEL_MUTATES[channel] : isMutatingChannel(channel)
      const code = await refusalOf(channel)
      if (mutates) {
        mutating.push(channel)
        expect(code, channel).toBe('host_draining')
      } else {
        expect(code, channel).not.toBe('host_draining')
      }
    }
    expect(mutating.length).toBeGreaterThan(100)
    expect(mutating).toContain(IPC.mcpAuthorize)
    expect(kit.applyImport).not.toHaveBeenCalled()
    expect(repoClone.clone).not.toHaveBeenCalled()
    expect(cliInstall.install).not.toHaveBeenCalled()
  })

  it('a desktop-only mutation holds an inFlightRpcMutations lease until its promise settles', async () => {
    const a = new HostActivityTracker()
    let finish!: (v: unknown) => void
    repoClone.clone.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    registerIpc(services(a))
    const sender = { id: 7, isDestroyed: () => false, send: () => {}, on: vi.fn(), removeListener: vi.fn() }
    const p = handlers.get(IPC.projectsCloneRepo)!({ sender }, { requestId: 'req_1', source: 'octo/repo', mode: 'clone', destination: '/tmp/x' }) as Promise<unknown>
    await Promise.resolve()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(1)
    finish({ path: '/tmp/x' })
    await expect(p).resolves.toEqual({ path: '/tmp/x' })
    await Promise.resolve()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
  })

  it('a synchronous desktop-only mutation releases on return (and on a throw)', async () => {
    const a = new HostActivityTracker()
    registerIpc(services(a))
    expect(handlers.get(IPC.appSetNotifications)!({ sender: { id: 7 } }, true)).toBeUndefined()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
    expect(() => handlers.get(IPC.skillLibraryAddFromFolder)!({ sender: { id: 7 } }, { path: '/nope' })).toThrow('folder picker')
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
  })

  it('a dispatcher mutation from a window holds the lease until its promise settles; reads take none', async () => {
    const a = new HostActivityTracker()
    let finish!: (v: unknown) => void
    const refresh = vi.fn(() => new Promise((r) => (finish = r)))
    registerIpc(services(a, { usage: { refresh } }))
    const p = handlers.get(IPC.usageRefresh)!({ sender: { id: 7 } }) as Promise<unknown>
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(1)
    finish({ fresh: true })
    await expect(p).resolves.toEqual({ fresh: true })
    await Promise.resolve()
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
    handlers.get(IPC.appInfo)!({ sender: { id: 7 } })
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
  })

  it('mcp:authorize is refused while draining but holds no lease for its browser wait (round 6 item 9)', async () => {
    expect(COMMIT_LEASED_CHANNELS.has(IPC.mcpAuthorize)).toBe(true)
    const a = new HostActivityTracker()
    let finish!: (v: unknown) => void
    const authorize = vi.fn(() => new Promise((r) => (finish = r)))
    registerIpc(services(a, { mcp: { authorize } as never }))
    const p = handlers.get(IPC.mcpAuthorize)!({ sender: { id: 7 } }, { libraryId: 'x' }) as Promise<unknown>
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(a.snapshot().counts.inFlightRpcMutations).toBe(0)
    finish({ state: 'authorized' })
    await expect(p).resolves.toEqual({ state: 'authorized' })
  })

  it('handleMutating refuses to register a channel that is not classified as mutating', async () => {
    expect(() => handleMutating(new HostActivityTracker(), IPC.appOpenLogs, () => undefined)).toThrow('not a mutating desktop-only channel')
    expect(() => handleMutating(new HostActivityTracker(), 'made:up', () => undefined)).toThrow('not a mutating desktop-only channel')
  })
})
