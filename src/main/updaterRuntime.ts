/**
 * electron-updater behind the UpdaterLike seam (updater.ts). Loaded with a dynamic import, and only for capability
 * 'auto' or 'manual' in a packaged app, so a dev or e2e launch never loads the module and never makes a request.
 *
 * The feed is the app-update.yml electron-builder embedded (publish: github perrychapman/OrgAI): setFeedURL is never
 * called, and no request header, channel or token is set. Settings: no automatic download, no prerelease, no
 * downgrade; a downloaded update installs on the next normal quit (autoInstallOnAppQuit, from the app's 'quit' event,
 * after desktopQuit.ts's shutdown). electron-updater's own checks (the sha512 from latest.yml over TLS; Authenticode
 * only when the app is signed, which ours is not) are left as they are.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UpdateController, resolveUpdaterSetup, type UpdateControllerDeps, type UpdaterCheckResult, type UpdaterLike, type UpdaterProgressInfo } from './updater'
import { createMockUpdater } from './updaterMock'

/** The NSIS installer's uninstaller beside the executable (app-builder-lib templates/nsis/common.nsh UNINSTALL_FILENAME). */
export const NSIS_UNINSTALLER = 'Uninstall OrgAI.exe'

export interface DesktopUpdatesInput extends Omit<UpdateControllerDeps, 'setup' | 'updater' | 'dryInstall'> {
  packaged: boolean
  platform: string
  execPath: string
  env: NodeJS.ProcessEnv
}

/**
 * The desktop's controller: decides the capability (updater.ts resolveUpdaterSetup), then loads electron-updater
 * (packaged 'auto' / 'manual' only), the ORGAI_UPDATE_MOCK fake (unpackaged only) or nothing. A failed load leaves
 * the capability as decided with no updater: checks answer the state as is.
 */
export async function createDesktopUpdates(input: DesktopUpdatesInput): Promise<UpdateController> {
  const { packaged, platform, execPath, env, ...deps } = input
  const setup = resolveUpdaterSetup(
    {
      packaged,
      platform,
      testRun: env.ORGAI_MOCK === '1',
      portable: typeof env.PORTABLE_EXECUTABLE_DIR === 'string' && env.PORTABLE_EXECUTABLE_DIR.length > 0,
      nsisInstalled: platform === 'win32' && packaged && existsSync(join(dirname(execPath), NSIS_UNINSTALLER))
    },
    env.ORGAI_UPDATE_MOCK
  )
  let updater: UpdaterLike | null = null
  if (setup.source.kind === 'mock') updater = createMockUpdater(setup.source.mode)
  else if (setup.source.kind === 'electron') {
    try {
      updater = await loadElectronUpdater(deps.log)
    } catch (e) {
      deps.log.warn(`The updater could not load: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  deps.log.info(`Updater: capability ${setup.capability}${setup.reason ? ` (${setup.reason})` : ''}, source ${setup.source.kind}.`)
  const { source: _source, ...decision } = setup
  return new UpdateController({ ...deps, setup: decision, updater, dryInstall: setup.source.kind === 'mock' })
}

interface ElectronUpdaterApi {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  fullChangelog: boolean
  logger: { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void } | null
  checkForUpdates(): Promise<UpdaterCheckResult | null>
  downloadUpdate(): Promise<string[]>
  install?: (isSilent?: boolean, isForceRunAfter?: boolean) => boolean
  on(event: 'error', cb: (e: Error) => void): unknown
  on(event: 'download-progress', cb: (p: UpdaterProgressInfo) => void): unknown
}

export async function loadElectronUpdater(log: { info(m: string): void; warn(m: string): void }): Promise<UpdaterLike> {
  const mod = (await import('electron-updater')) as unknown as { autoUpdater?: ElectronUpdaterApi; default?: { autoUpdater?: ElectronUpdaterApi } }
  const u = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!u) throw new Error('electron-updater did not load')
  u.autoDownload = false
  u.allowPrerelease = false
  u.allowDowngrade = false
  u.fullChangelog = false
  u.autoInstallOnAppQuit = true
  const line = (m: unknown): string => (typeof m === 'string' ? m : m instanceof Error ? m.message : String(m))
  u.logger = {
    info: (m) => log.info(`[updater] ${line(m)}`),
    warn: (m) => log.warn(`[updater] ${line(m)}`),
    error: (m) => log.warn(`[updater] ${line(m)}`)
  }
  // An 'error' emit without a listener would throw; the controller reports failures from the promises.
  u.on('error', (e) => log.warn(`[updater] error event: ${line(e)}`))
  return {
    checkForUpdates: () => u.checkForUpdates(),
    downloadUpdate: () => u.downloadUpdate(),
    install: (isSilent, isForceRunAfter) => (typeof u.install === 'function' ? u.install(isSilent, isForceRunAfter) : false),
    onProgress: (cb) => {
      u.on('download-progress', (p) => cb(p))
    }
  }
}
