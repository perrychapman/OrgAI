// App identity for the OS shell: the AppUserModelID, the icon file on disk, and (Windows) the registry entry that gives
// toasts a name and logo when no installer shortcut exists (npm run dev, the portable build). No electron import, so it
// is unit-testable; every effect goes through injected functions.
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export type RegRunner = (file: string, args: string[], options: { windowsHide: true; timeout: number; env: NodeJS.ProcessEnv }) => Promise<unknown>

const defaultRunner: RegRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })

export const REG_TIMEOUT_MS = 5000

/** A drive-absolute path such as C:\Windows; anything else (relative, UNC, empty) is not trusted. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:\\/

/** The Windows directory: SystemRoot or windir only when drive-absolute, else C:\Windows. */
export function windowsRoot(env: NodeJS.ProcessEnv = process.env): string {
  for (const v of [env.SystemRoot, env.windir]) if (v && DRIVE_ABSOLUTE.test(v)) return v
  return 'C:\\Windows'
}

export function regExePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(windowsRoot(env), 'System32', 'reg.exe')
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
  /** Environment used to find the Windows root (default process.env); reg.exe itself gets only SystemRoot. */
  env?: NodeJS.ProcessEnv
}

/**
 * Windows: HKCU\Software\Classes\AppUserModelId\com.orgai.app gets DisplayName and IconUri so toasts show "OrgAI" and the
 * logo without a Start Menu shortcut. Asynchronous and fail-open: a failure logs one warning and resolves.
 */
export async function registerWindowsAppIdentity(options: RegisterOptions): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') return
  const run = options.run ?? defaultRunner
  const exe = options.regExe ?? regExePath(options.env)
  const childEnv: NodeJS.ProcessEnv = { SystemRoot: windowsRoot(options.env) }
  const values: [string, string][] = [['DisplayName', APP_DISPLAY_NAME]]
  if (options.iconPath) values.push(['IconUri', options.iconPath])
  try {
    for (const [name, value] of values) await run(exe, regAddArgs(name, value), { windowsHide: true, timeout: REG_TIMEOUT_MS, env: childEnv })
  } catch (err) {
    ;(options.warn ?? (() => {}))(`Could not register the OrgAI app identity for notifications: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** True for runs that must not touch the real registry: a data dir override (e2e, CI) or the mock adapter. */
export function skipIdentityRegistration(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORGAI_DATA_DIR?.trim()) || env.ORGAI_MOCK === '1'
}

/**
 * Write the registry key only where no installer shortcut carries the id: unpackaged runs and the portable build
 * (electron-builder's portable launcher sets PORTABLE_EXECUTABLE_FILE). The installed NSIS build never writes it.
 */
export function shouldRegisterIdentity(input: { isPackaged: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (skipIdentityRegistration(env)) return false
  return !input.isPackaged || Boolean(env.PORTABLE_EXECUTABLE_FILE?.trim())
}

export interface IconCopyFs {
  size: (p: string) => number | undefined
  mkdir: (p: string) => void
  copy: (from: string, to: string) => void
}

const realIconFs: IconCopyFs = {
  size: (p) => {
    try {
      return statSync(p).size
    } catch {
      return undefined
    }
  },
  mkdir: (p) => void mkdirSync(p, { recursive: true }),
  copy: (a, b) => copyFileSync(a, b)
}

/**
 * Portable builds run from a temp extraction folder that is deleted on exit, so the registry cannot point into it. Copy the
 * icon to <userData>/app-icon.ico (only when missing or a different size) and return that path. Fail-open: one warning and
 * undefined (the key then carries only DisplayName).
 */
export function stableIconPath(input: { iconPath: string | undefined; userDataDir: string; fs?: IconCopyFs; warn?: (m: string) => void }): string | undefined {
  if (!input.iconPath) return undefined
  const fs = input.fs ?? realIconFs
  const dest = join(input.userDataDir, 'app-icon.ico')
  try {
    const want = fs.size(input.iconPath)
    if (want !== undefined && fs.size(dest) === want) return dest
    fs.mkdir(dirname(dest))
    fs.copy(input.iconPath, dest)
    return dest
  } catch (err) {
    ;(input.warn ?? (() => {}))(`Could not copy the app icon for notifications: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Quote one command-line argument: drop quotes and trailing backslashes (they would escape the closing quote). */
export function quoteArg(s: string): string {
  return `"${s.replace(/"/g, '').replace(/\\+$/, '')}"`
}

/**
 * Arguments for BrowserWindow.setAppDetails (Windows taskbar). The installed packaged build passes only appId so a pinned
 * app keeps its shortcut's relaunch command and icon; unpackaged and portable get the full details (portable relaunches
 * through PORTABLE_EXECUTABLE_FILE because execPath is in a temp folder).
 */
export function appDetailsFor(input: {
  isPackaged: boolean
  execPath: string
  appPath: string
  iconPath: string | undefined
  portableFile?: string
}): Electron.AppDetailsOptions {
  const portable = input.portableFile?.trim()
  if (input.isPackaged && !portable) return { appId: APP_USER_MODEL_ID }
  return {
    appId: APP_USER_MODEL_ID,
    ...(input.iconPath ? { appIconPath: input.iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: portable ? quoteArg(portable) : input.isPackaged ? quoteArg(input.execPath) : `${quoteArg(input.execPath)} ${quoteArg(input.appPath)}`,
    relaunchDisplayName: APP_DISPLAY_NAME
  }
}
