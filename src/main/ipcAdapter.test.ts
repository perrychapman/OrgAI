import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_IPC, HOST_METHODS, IPC } from '@shared/types'
import type { EngagementChangedEvent } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const liveWindow = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) } }
const deadWindow = { isDestroyed: () => true, webContents: { send: () => void sent.push({ channel: 'dead', payload: null }) } }
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '1.2.3', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [liveWindow, deadWindow] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '/logs' }))

const { registerIpc, DESKTOP_ONLY_CHANNELS } = await import('./ipc')
const { HostDispatcher } = await import('./host/dispatcher')
const { HostEventBus } = await import('./host/events')
const { project: makeProject } = await import('./runtime/testHelpers')
const { CLI_SHIM_UNAVAILABLE } = await import('./host/shimInstaller')
const { desktopOnlyChannels } = await import('./host/registry')
type IpcServices = import('./ipc').IpcServices

const SOCKET_ONLY = new Set<string>([...Object.values(HOST_IPC), ...Object.values(HOST_METHODS)])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-ipc-adapter-'))
  handlers.clear()
  sent.length = 0
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function services(over: Partial<IpcServices> = {}): IpcServices {
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const eng = makeProject({ id: 'proj_e', kind: 'engagement' })
  return {
    projects: { get: (id: string) => (id === eng.id ? eng : null), list: () => [eng] } as never,
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
    ...over
  }
}

const kit = { exportBundle: vi.fn(), previewBundle: vi.fn(), applyBundle: vi.fn(), export: vi.fn(), previewImport: vi.fn(), applyImport: vi.fn() }
const REPO_CHANNELS: string[] = [IPC.projectsParseRepoSource, IPC.projectsRepoTools, IPC.projectsCloneRepo, IPC.projectsCancelClone]
const repoClone = { parse: vi.fn(), tools: vi.fn(async () => ({})), clone: vi.fn(), cancel: vi.fn() }
const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({ sender: { id: 7 } }, ...args)

describe('registerIpc (thin adapter)', () => {
  it.each([
    ['with a kit and repository clones', true],
    ['without either', false]
  ])('registers exactly the dispatcher channels that are not socket-only plus the desktop-only ones (%s)', (_label, withOptional) => {
    const svc = services(withOptional ? { kit: kit as never, repoClone: repoClone as never } : {})
    registerIpc(svc)
    const reference = new HostDispatcher({ ...svc, desktop: { openRunWindow: svc.openRunWindow } })
    const desktopOnly = withOptional ? DESKTOP_ONLY_CHANNELS : DESKTOP_ONLY_CHANNELS.filter((c) => !c.startsWith('kit:') && !REPO_CHANNELS.includes(c))
    const expected = [...reference.channels().filter((c) => !SOCKET_ONLY.has(c)), ...desktopOnly]
    expect([...handlers.keys()].sort()).toEqual([...expected].sort())
    for (const ch of handlers.keys()) expect(SOCKET_ONLY.has(ch), ch).toBe(false)
    expect(handlers.has(IPC.usageRefresh)).toBe(true)
    expect(DESKTOP_ONLY_CHANNELS).toHaveLength(18)
  })

  it('DESKTOP_ONLY_CHANNELS is exactly the registry desktop_only request set', () => {
    expect([...DESKTOP_ONLY_CHANNELS].sort()).toEqual([...desktopOnlyChannels()].sort())
  })

  it('serves the repository channels through the clone service, progress to the calling window only', async () => {
    registerIpc(services({ repoClone: repoClone as never }))
    const progress: unknown[] = []
    const sender = { id: 7, isDestroyed: () => false, send: (_c: string, p: unknown) => void progress.push(p), on: vi.fn(), removeListener: vi.fn() }
    repoClone.clone.mockImplementationOnce(async (_input: unknown, onProgress: (p: unknown) => void) => {
      onProgress({ requestId: 'req_1', step: 'cloning' })
      return { path: '/tmp/x' }
    })
    const input = { requestId: 'req_1', source: 'octo/repo', mode: 'clone', destination: '/tmp/x', extra: 1 }
    await expect(handlers.get(IPC.projectsCloneRepo)!({ sender }, input)).resolves.toEqual({ path: '/tmp/x' })
    expect(repoClone.clone.mock.calls[0][0]).toEqual({ requestId: 'req_1', source: 'octo/repo', mode: 'clone', destination: '/tmp/x' })
    expect(progress).toEqual([{ requestId: 'req_1', step: 'cloning' }])
    expect(sent.filter((s) => s.channel === IPC.projectsCloneProgress)).toEqual([])
    expect(sender.removeListener).toHaveBeenCalled()
    await expect(Promise.resolve(handlers.get(IPC.projectsCloneRepo)!({ sender }, { requestId: '../x' }))).rejects.toThrow('Invalid clone request.')
  })

  it('serves usage:refresh through the given monitor; without one the channel is not registered', async () => {
    const refresh = vi.fn(async () => ({ fresh: true }))
    registerIpc(services({ usage: { refresh } }))
    await expect(call(IPC.usageRefresh)).resolves.toEqual({ fresh: true })
    handlers.clear()
    registerIpc(services({ usage: undefined }))
    expect(handlers.has(IPC.usageRefresh)).toBe(false)
  })

  it('passes the electron env (app version, platform, logs dir) and the window opener to the dispatcher', () => {
    const svc = services()
    registerIpc(svc)
    expect(call(IPC.appInfo)).toMatchObject({ version: '1.2.3', platform: process.platform, logsDir: '/logs' })
    expect(call(IPC.settingsGet)).toMatchObject({ appVersion: '1.2.3' })
  })

  it('keeps sync throws sync through ipcMain (the dispatcher returns the handler result as is)', () => {
    registerIpc(services({ projects: { get: () => null, list: () => [], saveFromRenderer: vi.fn() } as never }))
    expect(() => call(IPC.projectsSave, { id: 'quick' })).toThrow(/cannot be saved/)
  })

  it('forwards bus emits to live windows when it made the bus itself', () => {
    registerIpc(services())
    call(IPC.projectsSaveNote, { projectId: 'proj_e', title: 'T', text: 'x' })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(IPC.projectsEngagementChanged)
    expect((sent[0].payload as EngagementChangedEvent).what).toBe('notes')
  })

  it('never forwards a bus the caller passed in (the caller forwards)', () => {
    const events = new HostEventBus()
    const seen: string[] = []
    events.on((channel) => void seen.push(channel))
    registerIpc(services({ events }))
    call(IPC.projectsSaveNote, { projectId: 'proj_e', title: 'T', text: 'x' })
    events.emit(IPC.projectsEngagementChanged, { projectId: 'proj_e', what: 'document' })
    expect(seen).toEqual([IPC.projectsEngagementChanged, IPC.projectsEngagementChanged])
    expect(sent).toEqual([])
  })

  it('uses a provided dispatcher instead of building one', () => {
    const svc = services()
    const dispatcher = new HostDispatcher({ ...svc, desktop: { openRunWindow: svc.openRunWindow } })
    const invoke = vi.spyOn(dispatcher, 'invoke').mockReturnValue('from the provided dispatcher')
    registerIpc({ ...svc, dispatcher })
    expect(call(IPC.runsList, 'proj_e')).toBe('from the provided dispatcher')
    expect(invoke).toHaveBeenCalledWith(IPC.runsList, ['proj_e'], { surface: 'desktop', senderId: 7 })
  })

  it('window:openRun reaches the openRunWindow hook after validation', () => {
    const svc = services({ runs: { list: () => [], summary: () => ({ projectId: 'proj_e' }) } as never })
    registerIpc(svc)
    call(IPC.windowOpenRun, { projectId: 'proj_e', runId: 'run_1' })
    expect(svc.openRunWindow).toHaveBeenCalledWith({ projectId: 'proj_e', runId: 'run_1' })
  })

  describe('orgai command shim channels (desktop only)', () => {
    it('answer the unavailable fallback without a service', async () => {
      registerIpc(services())
      expect(call(IPC.appCliShimStatus)).toEqual(CLI_SHIM_UNAVAILABLE)
      for (const ch of [IPC.appInstallCliShim, IPC.appUninstallCliShim]) {
        await expect(call(ch)).resolves.toEqual({ ok: false, message: CLI_SHIM_UNAVAILABLE.reason, status: CLI_SHIM_UNAVAILABLE })
      }
    })

    it('delegate to the given service', async () => {
      const status = { state: 'installed' as const, path: '/h/.local/bin/orgai', binDir: '/h/.local/bin', onPath: true }
      const cliShim = {
        status: vi.fn(() => status),
        install: vi.fn(async () => ({ ok: true, message: 'Installed.', status })),
        uninstall: vi.fn(async () => ({ ok: true, message: 'Removed.', status: { ...status, state: 'not-installed' as const } })),
        refreshOnLaunch: vi.fn(async () => 'unchanged' as const)
      }
      registerIpc({ ...services(), cliShim })
      expect(call(IPC.appCliShimStatus)).toEqual(status)
      await expect(call(IPC.appInstallCliShim)).resolves.toMatchObject({ ok: true, message: 'Installed.' })
      await expect(call(IPC.appUninstallCliShim)).resolves.toMatchObject({ ok: true, status: { state: 'not-installed' } })
      expect(cliShim.install).toHaveBeenCalledTimes(1)
      expect(cliShim.uninstall).toHaveBeenCalledTimes(1)
    })

    it('turn a throwing service into ok: false, never a rejection', async () => {
      const cliShim = {
        status: vi.fn(() => {
          throw new Error('stat failed')
        }),
        install: vi.fn(async () => {
          throw new Error('EACCES: permission denied')
        }),
        uninstall: vi.fn(() => {
          throw new Error('sync boom')
        }),
        refreshOnLaunch: vi.fn(async () => 'skipped' as const)
      }
      registerIpc({ ...services(), cliShim: cliShim as never })
      expect(call(IPC.appCliShimStatus)).toEqual(CLI_SHIM_UNAVAILABLE)
      await expect(call(IPC.appInstallCliShim)).resolves.toEqual({
        ok: false,
        message: 'OrgAI could not change the orgai command: EACCES: permission denied',
        status: CLI_SHIM_UNAVAILABLE
      })
      await expect(call(IPC.appUninstallCliShim)).resolves.toMatchObject({ ok: false, message: 'OrgAI could not change the orgai command: sync boom' })
    })
  })
})
