/**
 * Terminal access as stored in `<data>/settings.json`, read and written by the CLI without a host (Wave 7,
 * docs/design/cli-standalone.md 4.2.1 and round 6 item 11). Used by `orgai terminal-access` and by
 * `orgai daemon start --runtime node` (the "off" refusal and the one level question).
 *
 * - Reads never write, never migrate and never print (normalizeSettings only; an unreadable file reads as the defaults,
 *   as SettingsStore does).
 * - Writes happen only while no host owns the data folder, under `<data>/run/startup.mkdir` after daemon.json was
 *   re-checked inside it (ownership.ts withStartupMutex). They change only the four Terminal access fields of the raw
 *   file and keep everything else as it is (fields a newer OrgAI wrote included), temp file + rename. A settings.json
 *   that exists but does not parse is refused, never overwritten.
 *
 * Plain Node, no electron; relative imports only.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, DaemonInfo, TerminalAccessLevel } from '../shared/types'
import { HostAlreadyRunningError, HostStartingOrBusyError, withStartupMutex, type StartupMutexOptions } from '../main/host/ownership'
import { normalizeSettings } from '../main/store/settings'
import { CliError, EXIT } from './types'

export const SETTINGS_FILE = 'settings.json'

/** What a host would make of the stored Terminal access. */
export interface StoredTerminalAccess {
  /** AppSettings.terminalServer as stored (true only with terminalServerChosen; see `enabledForBackground`). */
  terminalServer: boolean
  terminalServerChosen: boolean
  /** The level a Node or headless host grants (missing = 'operate'). */
  level: TerminalAccessLevel
  levelChosen: boolean
  /**
   * Whether a background (headless or Node) host would accept terminal clients: on unless the user chose off
   * (bootstrap.ts terminalAccess: no stored choice opens it for that host's session).
   */
  enabledForBackground: boolean
}

/** The raw `{ version, settings }` object, or undefined when the file is missing. Throws when it exists but is junk. */
function readRaw(dataDir: string): { version?: unknown; settings?: Record<string, unknown> } | undefined {
  const file = join(dataDir, SETTINGS_FILE)
  if (!existsSync(file)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${SETTINGS_FILE} is not an object`)
  const obj = parsed as { version?: unknown; settings?: unknown }
  if (obj.settings !== undefined && (!obj.settings || typeof obj.settings !== 'object' || Array.isArray(obj.settings))) throw new Error(`${SETTINGS_FILE} has no settings object`)
  return { version: obj.version, settings: (obj.settings as Record<string, unknown> | undefined) ?? {} }
}

/** Terminal access of normalized settings. */
export function terminalAccessOf(s: Pick<AppSettings, 'terminalServer' | 'terminalServerChosen' | 'terminalAccessLevel' | 'terminalAccessLevelChosen'>): StoredTerminalAccess {
  const chosen = s.terminalServerChosen === true
  // As SettingsStore.load (withoutUnchosenTerminalAccess): saved on without a choice reads as off.
  const terminalServer = s.terminalServer === true && chosen
  return {
    terminalServer,
    terminalServerChosen: chosen,
    level: s.terminalAccessLevel === 'full' ? 'full' : 'operate',
    levelChosen: s.terminalAccessLevelChosen === true,
    enabledForBackground: !chosen || terminalServer
  }
}

/** The stored Terminal access; a missing or unreadable settings.json reads as the defaults. Never writes. */
export function readStoredTerminalAccess(dataDir: string): StoredTerminalAccess {
  let raw: Partial<AppSettings> | undefined
  try {
    raw = readRaw(dataDir)?.settings as Partial<AppSettings> | undefined
  } catch {
    raw = undefined
  }
  return terminalAccessOf(normalizeSettings(raw))
}

/** A change: `on` sets terminalServer (+ terminalServerChosen), `level` sets terminalAccessLevel (+ its marker). */
export interface TerminalAccessChange {
  on?: boolean
  level?: TerminalAccessLevel
}

/** Apply `change` to settings.json now (the caller holds the startup mutex). Returns the new stored access. */
export function writeTerminalAccessNow(dataDir: string, change: TerminalAccessChange): StoredTerminalAccess {
  let raw: ReturnType<typeof readRaw>
  try {
    raw = readRaw(dataDir)
  } catch (e) {
    throw new CliError(
      `${join(dataDir, SETTINGS_FILE)} could not be read (${e instanceof Error ? e.message : String(e)}); it was left as it is. Fix it, or open OrgAI once to rewrite it.`,
      EXIT.failure
    )
  }
  const settings: Record<string, unknown> = { ...(raw?.settings ?? {}) }
  if (change.on !== undefined) {
    settings.terminalServer = change.on
    settings.terminalServerChosen = true
  }
  if (change.level !== undefined) {
    settings.terminalAccessLevel = change.level
    settings.terminalAccessLevelChosen = true
  }
  const file = join(dataDir, SETTINGS_FILE)
  const tmp = `${file}.tmp-cli-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: raw?.version ?? 1, settings }, null, 2), 'utf8')
  renameSync(tmp, file)
  return terminalAccessOf(normalizeSettings(settings as Partial<AppSettings>))
}

/** Words for a host kind in a refusal. */
function hostWords(d: DaemonInfo): string {
  return `${d.hostKind ?? 'OrgAI'} host, pid ${d.pid}`
}

/** The refusal when a host owns the data folder (4.2.1). */
export function hostOwnsFolderMessage(d: DaemonInfo): string {
  if (d.hostKind === 'desktop') {
    return `The OrgAI app is running for this data folder (${hostWords(d)}). Change Terminal access there: App settings > General > Advanced settings > Terminal access.`
  }
  if (d.hostKind === 'inproc') {
    // The user's own `orgai --host inproc` command (TUI, exec, daemon start --foreground), not a background host.
    return `An orgai command (pid ${d.pid}) is running its own host for this data folder; finish it, then try again.`
  }
  return `An OrgAI host owns this data folder (${hostWords(d)}). Stop the background host first: orgai daemon stop (or change Terminal access in the OrgAI app).`
}

/**
 * Write `change` while no host owns the data folder: under startup.mkdir, daemon.json re-checked inside it. A live host
 * is exit 1 with {@link hostOwnsFolderMessage}; a mutex held past the wait is exit 6.
 */
export async function writeTerminalAccess(dataDir: string, change: TerminalAccessChange, opts: Omit<StartupMutexOptions, 'dataDir'> = {}): Promise<StoredTerminalAccess> {
  try {
    return await withStartupMutex({ dataDir, ...opts }, () => writeTerminalAccessNow(dataDir, change))
  } catch (e) {
    if (e instanceof HostAlreadyRunningError) throw new CliError(hostOwnsFolderMessage(e.info), EXIT.failure)
    if (e instanceof HostStartingOrBusyError) throw new CliError(e.message, EXIT.hostBusy)
    throw e
  }
}

/** What each level lets a terminal do, for status lines. */
export const LEVEL_WORDS: Record<TerminalAccessLevel, string> = {
  operate: 'terminals may watch and run work',
  full: 'terminals may also approve decisions and change configuration'
}

/** The question `orgai daemon start --runtime node` asks once (4.2.1). */
export const LEVEL_QUESTION = 'Let terminal sessions approve decisions and change configuration? [full/operate] '

/** The answer to {@link LEVEL_QUESTION}: 'full' / 'f' / 'operate' / 'o' (any case), else undefined. */
export function parseLevelAnswer(answer: string): TerminalAccessLevel | undefined {
  const a = answer.trim().toLowerCase()
  if (a === 'full' || a === 'f') return 'full'
  if (a === 'operate' || a === 'o') return 'operate'
  return undefined
}

/** The note without a terminal (or with the level not chosen yet): the level in use and how to change it. */
export function levelNote(level: TerminalAccessLevel): string {
  return level === 'full'
    ? 'Terminal access: full (terminals may also approve decisions and change configuration). Lower it with: orgai terminal-access --level operate'
    : 'Terminal access: operate (terminals may watch and run work, not approve decisions or change configuration). Allow more with: orgai terminal-access --level full'
}
