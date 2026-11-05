/**
 * Where the CLI finds OrgAI's data (cli-spec 3.2(1), 7(3)). `--data-dir` and ORGAI_DATA_DIR name the application
 * userDataDir; the data dir is always `<userDataDir>/data`. Precedence: --data-dir > ORGAI_DATA_DIR > the platform
 * default Electron uses for productName 'OrgAI' (macOS ~/Library/Application Support/OrgAI, Windows %APPDATA%\OrgAI,
 * Linux ${XDG_CONFIG_HOME:-~/.config}/OrgAI). Relative values resolve against cwd. Read paths never create anything.
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

/** Electron's default userData for productName 'OrgAI' on `platform`. */
export function platformUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = pathFor(platform)
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'OrgAI')
  if (platform === 'win32') return p.join(nonEmpty(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming'), 'OrgAI')
  return p.join(nonEmpty(env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), 'OrgAI')
}

/** True when the user picked the data folder (--data-dir or ORGAI_DATA_DIR): only then a spawned host gets ORGAI_DATA_DIR. */
export function userChoseDataDir(input: Pick<DataDirInput, 'flag' | 'env'>): boolean {
  return nonEmpty(input.flag) !== undefined || nonEmpty((input.env ?? process.env).ORGAI_DATA_DIR) !== undefined
}

function realOrSame(p: string): string {
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
  const chosen = nonEmpty(input.flag) ?? nonEmpty(env.ORGAI_DATA_DIR)
  const raw = chosen !== undefined ? p.resolve(cwd, chosen) : platformUserDataDir(platform, env, input.home ?? homedir())
  // Only the running platform's file system can be asked for a real path.
  const userDataDir = platform === process.platform ? realOrSame(raw) : raw
  return { userDataDir, dataDir: p.join(userDataDir, 'data') }
}
