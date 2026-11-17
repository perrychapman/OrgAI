import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// A stand-in for electron-updater's autoUpdater: records what loadElectronUpdater sets.
const fake = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: false,
  allowPrerelease: true,
  allowDowngrade: true,
  fullChangelog: true,
  disableWebInstaller: false,
  logger: null as unknown,
  stagingUserIdPromise: undefined as undefined | { value: Promise<string> },
  listeners: {} as Record<string, unknown>,
  setFeedURL: undefined as unknown,
  checkForUpdates: async () => null,
  downloadUpdate: async () => [],
  on(event: string, cb: unknown) {
    this.listeners[event] = cb
    return this
  }
}))
vi.mock('electron-updater', () => {
  fake.setFeedURL = vi.fn()
  return { autoUpdater: fake }
})

const { loadElectronUpdater, UPDATER_STAGING_ID } = await import('./updaterRuntime')

describe('loadElectronUpdater', () => {
  it('applies the consent settings, a constant staging id, no web installer and an error listener; never sets a feed', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    const u = await loadElectronUpdater(log)
    expect(fake).toMatchObject({
      autoDownload: false,
      allowPrerelease: false,
      allowDowngrade: false,
      fullChangelog: false,
      autoInstallOnAppQuit: true,
      disableWebInstaller: true
    })
    await expect(fake.stagingUserIdPromise!.value).resolves.toBe(UPDATER_STAGING_ID)
    expect(UPDATER_STAGING_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(typeof fake.listeners.error).toBe('function')
    expect(fake.setFeedURL).not.toHaveBeenCalled()
    u.setAutoInstallOnQuit(false)
    expect(fake.autoInstallOnAppQuit).toBe(false)
  })
})

describe('the installed electron-updater (pinned 6.8.11) still reads the fields we override', () => {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('electron-updater/package.json')
  const source = readFileSync(join(dirname(pkgPath), 'out', 'AppUpdater.js'), 'utf8')

  it('is the pinned version', () => {
    expect(JSON.parse(readFileSync(pkgPath, 'utf8')).version).toBe('6.8.11')
  })

  it('takes the x-user-staging-id header and the .updaterId file only through stagingUserIdPromise', () => {
    // Both readers go through the lazy we replace; the file is written only by getOrCreateStagingUserId.
    expect(source).toContain('this.stagingUserIdPromise = new lazy_val_1.Lazy(() => this.getOrCreateStagingUserId());')
    expect(source.match(/await this\.stagingUserIdPromise\.value/g)).toHaveLength(2)
    expect(source).toContain('"x-user-staging-id": stagingUserId')
    expect(source.match(/getOrCreateStagingUserId\(\)/g)).toHaveLength(2) // the lazy and the definition
    expect(source.match(/\.updaterId/g)).toHaveLength(1)
  })

  it('passes disableWebInstaller to the download options', () => {
    expect(source).toContain('disableWebInstaller: this.disableWebInstaller')
  })
})
