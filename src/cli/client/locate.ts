/**
 * Where the CLI keeps its own data (standalone spec 3.1). `--data-dir` and ORGAI_CLI_DATA_DIR name the CLI's
 * userDataDir; the data dir is always `<userDataDir>/data`. Precedence: --data-dir > ORGAI_CLI_DATA_DIR > the platform
 * default (macOS ~/Library/Application Support/orgai-cli, Windows %APPDATA%\orgai-cli, Linux
 * ${XDG_CONFIG_HOME:-~/.config}/orgai-cli). ORGAI_DATA_DIR is the desktop app's setting and is ignored here. Relative
 * values resolve against cwd. Resolving creates nothing; productMarker.ts decides whether the folder may be used.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface DataDirInput {
  /** --data-dir. */
  flag?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  cwd?: string
}

export interface DataDirs {
  userDataDir: string
  dataDir: string
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix)

const nonEmpty = (v: string | undefined): string | undefined => {
  const t = v?.trim()
  return t ? t : undefined
}

function appDataDir(folder: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = pathFor(platform)
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', folder)
  if (platform === 'win32') return p.join(nonEmpty(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming'), folder)
  return p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), folder)
}

/** Electron's default userData for the desktop app (productName 'OrgAI') on `platform`: the CLI refuses it. */
export function platformUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return appDataDir('OrgAI', platform, env, home)
}

/** The CLI's default userDataDir on `platform` (`orgai-cli` beside the app's `OrgAI`). */
export function cliUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return appDataDir('orgai-cli', platform, env, home)
}

/** True when the user picked the CLI's data folder (--data-dir or ORGAI_CLI_DATA_DIR). */
export function userChoseDataDir(input: Pick<DataDirInput, 'flag' | 'env'>): boolean {
  return nonEmpty(input.flag) !== undefined || nonEmpty((input.env ?? process.env).ORGAI_CLI_DATA_DIR) !== undefined
}

/** The one-time note when the desktop app's ORGAI_DATA_DIR is set and the CLI has its own override missing. */
export const DESKTOP_DATA_DIR_NOTE = 'ORGAI_DATA_DIR is the OrgAI app\'s setting; orgai uses ORGAI_CLI_DATA_DIR.'

/** True when ORGAI_DATA_DIR is set but neither --data-dir nor ORGAI_CLI_DATA_DIR is, so the note is due. */
export function ignoresDesktopDataDir(input: Pick<DataDirInput, 'flag' | 'env'>): boolean {
  const env = input.env ?? process.env
  return nonEmpty(env.ORGAI_DATA_DIR) !== undefined && !userChoseDataDir(input)
}

export function realOrSame(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** The resolved, absolute (and, when it exists, real) userDataDir and its data dir. */
export function resolveDataDirs(input: DataDirInput = {}): DataDirs {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const p = pathFor(platform)
  const cwd = input.cwd ?? process.cwd()
  const chosen = nonEmpty(input.flag) ?? nonEmpty(env.ORGAI_CLI_DATA_DIR)
  const raw = chosen !== undefined ? p.resolve(cwd, chosen) : cliUserDataDir(platform, env, input.home ?? homedir())
  // Only the running platform's file system can be asked for a real path.
  const userDataDir = platform === process.platform ? realOrSame(raw) : raw
  return { userDataDir, dataDir: p.join(userDataDir, 'data') }
}
