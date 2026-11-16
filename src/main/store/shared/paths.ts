/**
 * Where parallel-session coordination lives (docs/design/parallel-sessions.md 4.1, 4.7): `<rootDataDir>/control/`
 * (locks, hosts, chains, journal, sessions, epoch.json; never copied or published) and the per-user cache tree
 * `<user cache>/orgai/` (locks and shared journal locators keyed by paths outside the data folder). `rootDataDir` is the
 * data folder itself; format-2 data lives in `<rootDataDir>/v2` (`storeDir`), which these helpers never touch.
 *
 * Electron-free; relative imports only.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ControlPaths {
  root: string
  locks: string
  hosts: string
  chains: string
  journal: string
  sessions: string
  epoch: string
}

export function controlPaths(rootDataDir: string): ControlPaths {
  const root = join(rootDataDir, 'control')
  return {
    root,
    locks: join(root, 'locks'),
    hosts: join(root, 'hosts'),
    chains: join(root, 'chains'),
    journal: join(root, 'journal'),
    sessions: join(root, 'sessions'),
    epoch: join(root, 'epoch.json')
  }
}

/** The per-user cache folder: ~/Library/Caches (macOS), %LOCALAPPDATA% (Windows), $XDG_CACHE_HOME or ~/.cache. */
export function userCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  if (platform === 'win32') return env.LOCALAPPDATA && env.LOCALAPPDATA.length > 0 ? env.LOCALAPPDATA : join(home, 'AppData', 'Local')
  const xdg = env.XDG_CACHE_HOME
  return xdg && xdg.startsWith('/') ? xdg : join(home, '.cache')
}

export interface CachePaths {
  root: string
  locks: string
  journal: string
}

/** `<user cache>/orgai/` and its parts. Tests pass an explicit root. */
export function cachePaths(root = join(userCacheDir(), 'orgai')): CachePaths {
  return { root, locks: join(root, 'locks'), journal: join(root, 'journal') }
}
