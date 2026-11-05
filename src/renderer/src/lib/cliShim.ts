import type { CliShimResult, CliShimStatus } from '@shared/types'
import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'

/** What the App settings "orgai command" row shows for a CliShimStatus (cli-spec 7(3)). Pure. */
export interface CliShimView {
  line: string
  primary?: { action: 'install' | 'update'; label: string }
  remove: boolean
  /** How to put the shim's folder on PATH; only for an installed or outdated shim whose folder is not on PATH. */
  pathHint?: string
}

export const CLI_SHIM_UNAVAILABLE = 'Available in the installed OrgAI app.'
export const CLI_SHIM_INSTALL_LABEL = 'Install orgai command'
export const CLI_SHIM_UPDATE_LABEL = 'Update orgai command'
/** Said when main answers with a state this renderer does not know or with no reason for a foreign file. */
export const CLI_SHIM_FOREIGN = 'Another program already has a file named orgai there. OrgAI leaves it alone.'
const MAX_SHOWN = 400

/** Drops control, zero-width and bidi characters so a path can never disguise itself; keeps the text one line. */
export function cleanShown(s: string | undefined | null): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(HIDDEN_OR_CONTROL_RUN, '').trim()
  return t.length > MAX_SHOWN ? `${t.slice(0, MAX_SHOWN - 1)}…` : t
}

/** The home folder a POSIX path starts with (/Users/<name>, /home/<name>, /root), or '' when none. */
export function posixHomeOf(path: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(path)
  return m ? m[1] : ''
}

/**
 * A path as shown: hidden characters removed and, on POSIX, the home prefix shortened to '~'. `home` overrides the
 * guessed home folder. Windows paths are shown as they are.
 */
export function displayPath(path: string, platform: string, home?: string): string {
  const p = cleanShown(path)
  if (!p || platform === 'win32') return p
  const h = (home ?? posixHomeOf(p)).replace(/\/+$/, '')
  if (!h) return p
  if (p === h) return '~'
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

function pathHint(binDir: string, platform: string): string {
  if (platform === 'win32') return `Add ${binDir} to your user Path in Windows settings.`
  return `${binDir} is not on your PATH. Add this line to your shell profile: export PATH="${binDir}:$PATH"`
}

export function cliShimView(status: CliShimStatus, platform: string, home?: string): CliShimView {
  const path = displayPath(status.path, platform, home) || 'its folder'
  const binDir = displayPath(status.binDir, platform, home)
  const hint = status.onPath === false && binDir ? { pathHint: pathHint(binDir, platform) } : {}
  switch (status.state) {
    case 'not-installed':
      return {
        line: binDir ? `Not installed. Adds a small orgai command in ${binDir}.` : 'Not installed. Adds a small orgai command.',
        primary: { action: 'install', label: CLI_SHIM_INSTALL_LABEL },
        remove: false
      }
    case 'installed':
      return { line: `Installed at ${path}.`, remove: true, ...hint }
    case 'outdated':
      return {
        line: `Installed at ${path}, but it runs another copy of OrgAI.`,
        primary: { action: 'update', label: CLI_SHIM_UPDATE_LABEL },
        remove: true,
        ...hint
      }
    case 'foreign':
      return { line: cleanShown(status.reason) || CLI_SHIM_FOREIGN, remove: false }
    default:
      return { line: cleanShown(status.reason) || CLI_SHIM_UNAVAILABLE, remove: false }
  }
}

/** Where focus goes after an action: the opposite button, else the status line when that button is not shown. */
export function cliShimFocusAfter(action: 'install' | 'update' | 'remove', after: CliShimView): 'remove' | 'install' | 'status' {
  if (action === 'remove') return after.primary ? 'install' : 'status'
  return after.remove ? 'remove' : 'status'
}

/** The notice after an action; a failure without a message still says something. */
export function cliShimNotice(result: CliShimResult | null | undefined): string {
  const m = cleanShown(result?.message)
  if (m) return m
  return result?.ok ? 'Done.' : 'OrgAI could not change the orgai command.'
}

/** True when the preload exposes the shim API (older builds and tests may not). */
export function hasCliShimApi(app: unknown): boolean {
  const a = app as Record<string, unknown> | null | undefined
  return !!a && typeof a.cliShimStatus === 'function' && typeof a.installCliShim === 'function' && typeof a.uninstallCliShim === 'function'
}

/**
 * One action at a time: `run` returns null while an action is in flight (a double click), else the action's promise.
 * Pure apart from its own flag, so the row's double-click rule is unit-tested here.
 */
export function singleFlight<T>(): { run: (fn: () => Promise<T>) => Promise<T> | null; busy: () => boolean } {
  let inFlight = false
  return {
    busy: () => inFlight,
    run: (fn) => {
      if (inFlight) return null
      inFlight = true
      let p: Promise<T>
      try {
        p = fn()
      } catch (e) {
        inFlight = false
        return Promise.reject(e)
      }
      return p.finally(() => {
        inFlight = false
      })
    }
  }
}
