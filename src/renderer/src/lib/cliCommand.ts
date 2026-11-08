import type { CliCommandResult, CliCommandStatus } from '@shared/types'
import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'

/** What the App settings > Terminal row shows for a CliCommandStatus (cli-standalone-default.md 5.3). Pure. */
export interface CliCommandView {
  /** The status sentence. */
  line: string
  /** The Install button label. */
  installLabel: 'Install' | 'Update'
  /** Install needs npm on PATH. */
  installBlockedReason?: string
  /** Offer "Remove the old orgai command". */
  removeOld: boolean
  /** Which orgai a terminal runs now, when known. */
  runs?: string
}

export const CLI_COMMAND_CHECKING = 'Checking…'
export const CLI_COMMAND_LOAD_FAILED = 'OrgAI could not check the orgai command. Open App settings again to retry.'
export const CLI_NO_NPM = 'npm was not found on your PATH. Install Node.js, or run the command below in a terminal.'
const MAX_SHOWN = 400

/** Drops control, zero-width and bidi characters so text from a path or from npm cannot disguise itself. */
export function cleanShown(s: string | undefined | null): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(HIDDEN_OR_CONTROL_RUN, '').trim()
  return t.length > MAX_SHOWN ? `${t.slice(0, MAX_SHOWN - 1)}…` : t
}

/** npm's output for the <pre>: control characters removed, line breaks kept, bounded. */
export function cleanBlock(s: string | undefined | null): string {
  if (typeof s !== 'string') return ''
  return s
    .split('\n')
    .map((l) => l.replace(HIDDEN_OR_CONTROL_RUN, ''))
    .join('\n')
    .slice(-64 * 1024)
}

function shownVersion(v: string | undefined): string {
  const t = cleanShown(v)
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(t) ? t : ''
}

export function cliCommandView(status: CliCommandStatus): CliCommandView {
  let line: string
  switch (status.state) {
    case 'npm': {
      const v = shownVersion(status.version)
      line = v ? `Installed (npm, ${v})` : 'Installed (npm)'
      break
    }
    case 'old-shim':
      line = 'Old OrgAI app command (no longer works)'
      break
    case 'other':
      line = 'Another program named orgai'
      break
    default:
      line = 'Not installed'
  }
  const runs = cleanShown(status.path)
  return {
    line,
    installLabel: status.state === 'npm' ? 'Update' : 'Install',
    ...(status.npmFound ? {} : { installBlockedReason: CLI_NO_NPM }),
    removeOld: status.oldShim,
    ...(runs && status.state !== 'not-installed' ? { runs } : {})
  }
}

/** The notice after an action; a failure without a message still says something. */
export function cliCommandNotice(result: CliCommandResult | null | undefined): string {
  const m = cleanShown(result?.message)
  if (m) return m
  return result?.ok ? 'Done.' : 'OrgAI could not change the orgai command.'
}

/** True when the preload exposes the install API (older builds and tests may not). */
export function hasCliCommandApi(app: unknown): boolean {
  const a = app as Record<string, unknown> | null | undefined
  return (
    !!a &&
    typeof a.cliCommandStatus === 'function' &&
    typeof a.installCliCommand === 'function' &&
    typeof a.cancelCliInstall === 'function' &&
    typeof a.removeOldCliShim === 'function'
  )
}

/** One action at a time: `run` returns null while an action is in flight (a double click), else the action's promise. */
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
