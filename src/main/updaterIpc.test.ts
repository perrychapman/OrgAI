import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UPDATES_IPC, UPDATE_RELEASES_URL } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const APP_SENDER = { id: 7 }
const appWindow = { isDestroyed: () => false }
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '1.2.3', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: (wc: unknown) => (wc === APP_SENDER ? appWindow : null), getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '/logs' }))
const electronUpdaterLoaded = vi.fn()
vi.mock('electron-updater', () => {
  electronUpdaterLoaded()
  return { autoUpdater: undefined }
})

const { registerUpdatesIpc } = await import('./ipc')
const { noopActivity } = await import('./host/activity')
const { createDesktopUpdates } = await import('./updaterRuntime')
const { normalizeSettings } = await import('./store/settings')

function fakeController() {
  return {
    state: vi.fn(() => ({ capability: 'auto', status: 'idle', currentVersion: '1.2.3', releaseUrl: UPDATE_RELEASES_URL })),
    check: vi.fn(async () => ({ capability: 'auto', status: 'up-to-date', currentVersion: '1.2.3', releaseUrl: UPDATE_RELEASES_URL })),
    download: vi.fn(() => ({ ok: true })),
    install: vi.fn(() => ({ ok: true })),
    openReleasePage: vi.fn()
  }
}

beforeEach(() => handlers.clear())

describe('registerUpdatesIpc', () => {
  it('serves the five request channels from an app window', async () => {
    const c = fakeController()
    registerUpdatesIpc(noopActivity(), c as never)
    expect([...handlers.keys()].sort()).toEqual(
      [UPDATES_IPC.updatesGet, UPDATES_IPC.updatesCheck, UPDATES_IPC.updatesDownload, UPDATES_IPC.updatesInstall, UPDATES_IPC.updatesOpenReleasePage].sort()
    )
    const e = { sender: APP_SENDER }
    expect(await handlers.get(UPDATES_IPC.updatesGet)!(e)).toMatchObject({ status: 'idle' })
    expect(await handlers.get(UPDATES_IPC.updatesCheck)!(e)).toMatchObject({ status: 'up-to-date' })
    expect(await handlers.get(UPDATES_IPC.updatesDownload)!(e, 'https://evil.example/x.exe')).toEqual({ ok: true })
    expect(c.download).toHaveBeenCalledWith()
    await handlers.get(UPDATES_IPC.updatesOpenReleasePage)!(e, 'https://evil.example')
    expect(c.openReleasePage).toHaveBeenCalledWith()
  })

  it('install passes only an exact force: true and refuses malformed input', async () => {
    const c = fakeController()
    registerUpdatesIpc(noopActivity(), c as never)
    const e = { sender: APP_SENDER }
    const install = handlers.get(UPDATES_IPC.updatesInstall)!
    await install(e, { force: true, path: 'C:/evil.exe', version: '9.9.9' })
    expect(c.install).toHaveBeenLastCalledWith({ force: true })
    await install(e, { force: 'yes' })
    expect(c.install).toHaveBeenLastCalledWith({ force: false })
    await install(e)
    expect(c.install).toHaveBeenLastCalledWith({ force: false })
    await expect(Promise.resolve().then(() => install(e, 'force'))).rejects.toThrow('Invalid install request.')
  })

  it('refuses a sender that is not an OrgAI window', async () => {
    const c = fakeController()
    registerUpdatesIpc(noopActivity(), c as never)
    for (const ch of Object.values(UPDATES_IPC)) {
      if (ch === UPDATES_IPC.updatesChanged) continue
      await expect(Promise.resolve().then(() => handlers.get(ch)!({ sender: { id: 99 } })), ch).rejects.toThrow('not an OrgAI window')
    }
    expect(c.check).not.toHaveBeenCalled()
    expect(c.install).not.toHaveBeenCalled()
  })
})

describe('createDesktopUpdates', () => {
  const base = {
    currentVersion: '1.2.3',
    autoCheck: () => true,
    liveRunCount: () => 0,
    quitting: () => false,
    requestQuit: vi.fn(),
    openExternal: vi.fn(),
    emit: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() }
  }

  it('an unpackaged or mock launch never loads electron-updater', async () => {
    electronUpdaterLoaded.mockClear()
    const dev = await createDesktopUpdates({ ...base, packaged: false, platform: 'win32', execPath: 'C:/x/OrgAI.exe', env: {} })
    expect(dev.state()).toMatchObject({ capability: 'none', reason: 'dev' })
    const test = await createDesktopUpdates({ ...base, packaged: true, platform: 'win32', execPath: 'C:/x/OrgAI.exe', env: { ORGAI_MOCK: '1' } })
    expect(test.state()).toMatchObject({ capability: 'none', reason: 'test' })
    const mock = await createDesktopUpdates({ ...base, packaged: false, platform: 'win32', execPath: 'C:/x/OrgAI.exe', env: { ORGAI_UPDATE_MOCK: 'manual' } })
    expect(mock.state()).toMatchObject({ capability: 'manual', reason: 'platform' })
    expect(electronUpdaterLoaded).not.toHaveBeenCalled()
  })

  it('a packaged app ignores ORGAI_UPDATE_MOCK; a failed load keeps the capability with no updater', async () => {
    const c = await createDesktopUpdates({ ...base, packaged: true, platform: 'darwin', execPath: '/Applications/OrgAI.app/x', env: { ORGAI_UPDATE_MOCK: 'available' } })
    expect(c.state()).toMatchObject({ capability: 'manual', reason: 'platform', status: 'idle' })
    expect(base.log.warn).toHaveBeenCalledWith(expect.stringContaining('could not load'))
    expect((await c.check()).status).toBe('idle')
  })

  it('a packaged Windows app without the NSIS uninstaller beside it is manual (unpacked); portable is manual (portable)', async () => {
    const unpacked = await createDesktopUpdates({ ...base, packaged: true, platform: 'win32', execPath: 'C:/nowhere-orgai-test/OrgAI.exe', env: {} })
    expect(unpacked.state()).toMatchObject({ capability: 'manual', reason: 'unpacked' })
    const portable = await createDesktopUpdates({ ...base, packaged: true, platform: 'win32', execPath: 'C:/x/OrgAI.exe', env: { PORTABLE_EXECUTABLE_DIR: 'C:/x' } })
    expect(portable.state()).toMatchObject({ capability: 'manual', reason: 'portable' })
  })
})

describe('AppSettings.autoUpdateCheck', () => {
  it('defaults to true and keeps an explicit boolean', () => {
    expect(DEFAULT_APP_SETTINGS.autoUpdateCheck).toBe(true)
    expect(normalizeSettings(null).autoUpdateCheck).toBe(true)
    expect(normalizeSettings({ autoUpdateCheck: false }).autoUpdateCheck).toBe(false)
    expect(normalizeSettings({ autoUpdateCheck: 'no' as never }).autoUpdateCheck).toBe(true)
  })
})
