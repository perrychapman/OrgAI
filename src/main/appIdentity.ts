// App identity for the OS shell: the AppUserModelID, the icon file on disk, and (Windows) the registry entry that gives
// toasts a name and logo when no installer shortcut exists (npm run dev, the portable build). No electron import, so it
// is unit-testable; every effect goes through injected functions.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The one AppUserModelID (electron-builder appId, NSIS shortcut, toasts, taskbar grouping). */
export const APP_USER_MODEL_ID = 'com.orgai.app'
export const APP_DISPLAY_NAME = 'OrgAI'

export interface IconPathInput {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** app.getAppPath() (unpackaged). */
  appPath: string
  /** process.resourcesPath (packaged; electron-builder extraResources puts icon.ico / icon.png there). */
  resourcesPath: string
  exists?: (p: string) => boolean
}

/** Absolute icon file (ico on Windows, png elsewhere), or undefined when it is not on disk. */
export function resolveIconPath(input: IconPathInput): string | undefined {
  const file = input.platform === 'win32' ? 'icon.ico' : 'icon.png'
  const p = input.isPackaged ? join(input.resourcesPath, file) : join(input.appPath, 'build', file)
  return (input.exists ?? existsSync)(p) ? p : undefined
}

export type RegRunner = (file: string, args: string[], options: { windowsHide: true; timeout: number }) => Promise<unknown>

const defaultRunner: RegRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

export const REG_TIMEOUT_MS = 5000

export function regExePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe')
}

export const appIdentityKey = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_USER_MODEL_ID}`

/** argv for one `reg add` (no shell; each value is its own argument). */
export function regAddArgs(name: string, value: string): string[] {
  return ['add', appIdentityKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']
}

export interface RegisterOptions {
  platform?: NodeJS.Platform
  /** Absolute icon path, or undefined when missing (then only DisplayName is written). */
  iconPath: string | undefined
  run?: RegRunner
  regExe?: string
  warn?: (message: string) => void
}

/**
 * Windows: HKCU\Software\Classes\AppUserModelId\com.orgai.app gets DisplayName and IconUri so toasts show "OrgAI" and the
 * logo without a Start Menu shortcut. Asynchronous and fail-open: a failure logs one warning and resolves.
 */
export async function registerWindowsAppIdentity(options: RegisterOptions): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') return
  const run = options.run ?? defaultRunner
  const exe = options.regExe ?? regExePath()
  const values: [string, string][] = [['DisplayName', APP_DISPLAY_NAME]]
  if (options.iconPath) values.push(['IconUri', options.iconPath])
  try {
    for (const [name, value] of values) await run(exe, regAddArgs(name, value), { windowsHide: true, timeout: REG_TIMEOUT_MS })
  } catch (err) {
    ;(options.warn ?? (() => {}))(`Could not register the OrgAI app identity for notifications: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** True for runs that must not touch the real registry: a data dir override (e2e, CI) or the mock adapter. */
export function skipIdentityRegistration(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORGAI_DATA_DIR?.trim()) || env.ORGAI_MOCK === '1'
}

/** Arguments for BrowserWindow.setAppDetails (Windows taskbar name, icon and relaunch command). */
export function appDetailsFor(input: { isPackaged: boolean; execPath: string; appPath: string; iconPath: string | undefined }): Electron.AppDetailsOptions {
  const q = (s: string): string => `"${s.replace(/"/g, '')}"`
  return {
    appId: APP_USER_MODEL_ID,
    ...(input.iconPath ? { appIconPath: input.iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: input.isPackaged ? q(input.execPath) : `${q(input.execPath)} ${q(input.appPath)}`,
    relaunchDisplayName: APP_DISPLAY_NAME
  }
}
