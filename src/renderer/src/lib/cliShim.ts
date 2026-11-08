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

export const CLI_SHIM_UNAVAILABLE = 'Available in the installed OrgAI app, not in a development build.'
/** Said while this install ships no orgai launcher (every packaged app now): the command comes from npm. */
export const CLI_SHIM_NPM = 'The OrgAI app no longer installs the orgai command. Install it with `npm i -g orgai-cli`.'
export const CLI_SHIM_CHECKING = 'Checking…'
/** Said when the status could not be read and no earlier status is known. */
export const CLI_SHIM_LOAD_FAILED = 'OrgAI could not check the orgai command. Open App settings again to retry.'
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

/** A version as shown: a short printable token, else nothing. */
function shownVersion(v: string | undefined): string {
  const t = cleanShown(v)
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(t) ? t : ''
}

/**
 * The sentence for another orgai on PATH (cli-standalone.md 8.2): "The orgai command from npm (0.2.0) is on your
 * PATH." `also` after the app's own shim line.
 */
export function otherCliLine(other: NonNullable<CliShimStatus['otherCli']>, platform: string, home?: string, also = false): string {
  const v = shownVersion(other.version)
  const ver = v ? ` (${v})` : ''
  const where = also ? 'also on your PATH' : 'on your PATH'
  switch (other.channel) {
    case 'npm':
      return `The orgai command from npm${ver} is ${where}.`
    case 'archive':
      return `The orgai command from the portable archive${ver} is ${where}.`
    case 'app':
      return `The orgai command of another OrgAI app${ver} is ${where}.`
    default:
      return `Another orgai command${ver} is ${where}: ${displayPath(other.path, platform, home) || 'its folder unknown'}.`
  }
}

/** True for an orgai the user installed on purpose (npm, the portable archive): the app then offers no Install (8.2). */
export function otherCliBlocksInstall(other: NonNullable<CliShimStatus['otherCli']>): boolean {
  return other.channel === 'npm' || other.channel === 'archive'
}

export function cliShimView(status: CliShimStatus, platform: string, home?: string): CliShimView {
  const path = displayPath(status.path, platform, home) || 'its folder'
  const binDir = displayPath(status.binDir, platform, home)
  const hint = status.onPath === false && binDir ? { pathHint: pathHint(binDir, platform) } : {}
  // Another orgai on PATH: always named. Only an npm or archive install blocks Install / Update (8.2: the user chose
  // that command); an unknown file, a dev checkout or another app's shim keeps the buttons (main never refuses either).
  const other = status.otherCli && typeof status.otherCli.path === 'string' ? status.otherCli : undefined
  const blocking = other !== undefined && otherCliBlocksInstall(other)
  const also = other ? ` ${otherCliLine(other, platform, home, true)}` : ''
  switch (status.state) {
    case 'not-installed':
      if (status.installable === false) return { line: other ? otherCliLine(other, platform, home) : CLI_SHIM_NPM, remove: false }
      if (other && blocking) return { line: otherCliLine(other, platform, home), remove: false }
      return {
        line: `${binDir ? `Not installed. Adds a small orgai command in ${binDir}.` : 'Not installed. Adds a small orgai command.'}${also}`,
        primary: { action: 'install', label: CLI_SHIM_INSTALL_LABEL },
        remove: false
      }
    case 'installed':
      return { line: `Installed at ${path}.${also}`, remove: true, ...hint }
    case 'outdated':
      // No launcher ships with this app: an old shim can only be removed, never updated.
      if (status.installable === false) {
        return { line: `An older OrgAI app put an orgai command at ${path}. It runs a launcher this app no longer ships. Remove it, then install orgai with \`npm i -g orgai-cli\`.${also}`, remove: true, ...hint }
      }
      if (blocking) return { line: `Installed at ${path}, but it runs another copy of OrgAI.${also}`, remove: true, ...hint }
      return {
        line: `Installed at ${path}, but it runs another copy of OrgAI.${also}`,
        primary: { action: 'update', label: CLI_SHIM_UPDATE_LABEL },
        remove: true,
        ...hint
      }
    case 'foreign': {
      // An npm or archive orgai (often npm's own link at the shim path, npm prefix ~/.local) is named as 8.2 says,
      // never as a file to remove. Any other other orgai is added after the reason unless it is that same file.
      if (other && blocking) return { line: otherCliLine(other, platform, home), remove: false }
      const reason = cleanShown(status.reason) || CLI_SHIM_FOREIGN
      const sameFile = other !== undefined && other.path === status.path
      return { line: `${reason}${other && !sameFile ? also : ''}`, remove: false }
    }
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

/** DOM id of the PATH hint, named by the row's buttons through aria-describedby. */
export const CLI_SHIM_PATH_HINT_ID = 'cli-shim-path-hint'

/** The buttons' aria-describedby: the row description, plus the PATH hint while it is shown. */
export function cliShimDescribedBy(descId: string, view: CliShimView | null): string {
  return view?.pathHint ? `${descId} ${CLI_SHIM_PATH_HINT_ID}` : descId
}

/**
 * The status line: the view's line, else "Checking…" while the first status is loading, else the load failure (review
 * Low: the row announces it through its live region).
 */
export function cliShimLine(view: CliShimView | null, loadFailed: boolean): string {
  if (view) return view.line
  return loadFailed ? CLI_SHIM_LOAD_FAILED : CLI_SHIM_CHECKING
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
