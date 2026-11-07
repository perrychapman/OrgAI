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
import { hostKindWord } from './hostWords'
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
  /** terminalAccessLevelChosen, or a stored 'full' (only ever stored by a user's pick). */
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
    // A stored 'full' without the marker comes from a build before Wave 7, which stored 'full' only when the user picked
    // it in App settings (the default was unset = 'operate'): a choice, never asked again (review round 2).
    levelChosen: s.terminalAccessLevelChosen === true || s.terminalAccessLevel === 'full',
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

/** readRaw, or the CliError a write refuses with (exit 1) when settings.json exists but is junk. */
function readRawForWrite(dataDir: string): ReturnType<typeof readRaw> {
  try {
    return readRaw(dataDir)
  } catch (e) {
    throw new CliError(
      `${join(dataDir, SETTINGS_FILE)} could not be read (${e instanceof Error ? e.message : String(e)}); it was left as it is. Fix it, or open OrgAI once to rewrite it.`,
      EXIT.failure
    )
  }
}

/**
 * Throws the CliError {@link writeTerminalAccessNow} would refuse with when settings.json is junk. `orgai daemon
 * restart` checks it before it stops the running host, so a write that cannot succeed never leaves no host (review
 * round 2). Reads only.
 */
export function assertSettingsWritable(dataDir: string): void {
  readRawForWrite(dataDir)
}

/** Apply `change` to settings.json now (the caller holds the startup mutex). Returns the new stored access. */
export function writeTerminalAccessNow(dataDir: string, change: TerminalAccessChange): StoredTerminalAccess {
  const raw = readRawForWrite(dataDir)
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
  return `${hostKindWord(d.hostKind)} host, pid ${d.pid}`
}

/** The refusal when a host owns the data folder (4.2.1). */
export function hostOwnsFolderMessage(d: DaemonInfo): string {
  if (d.hostKind === 'desktop') {
    return `The OrgAI app is running for this data folder (${hostWords(d)}). Change Terminal access there: App settings > General > Advanced settings > Terminal access.`
  }
  if (d.hostKind === 'inproc') {
    // The user's own `orgai --host inproc` command (TUI, exec, daemon start --foreground), not a background host.
    return `An orgai command (pid ${d.pid}) is running its own host for this data folder. Let it finish, then try again.`
  }
  return `A background host (pid ${d.pid}) is running for this data folder. Stop it with \`orgai daemon stop\`, then change Terminal access.`
}

/**
 * The refusal while a live process has held startup.mkdir past the wait (a host still starting). Never the "delete the
 * run folder" advice of HostStartingOrBusyError: that process is confirmed live, and removing its mutex could break its
 * ownership (review round 2).
 */
export function hostStartingMessage(pid: number | undefined): string {
  return `Another OrgAI process${pid ? ` (pid ${pid})` : ''} is starting for this data folder; try again in a moment.`
}

/**
 * Write `change` while no host owns the data folder: under startup.mkdir, daemon.json re-checked inside it. A live host
 * is exit 1 with {@link hostOwnsFolderMessage}; a mutex held past the wait is exit 6 with {@link hostStartingMessage}.
 */
export async function writeTerminalAccess(dataDir: string, change: TerminalAccessChange, opts: Omit<StartupMutexOptions, 'dataDir'> = {}): Promise<StoredTerminalAccess> {
  try {
    return await withStartupMutex({ dataDir, ...opts }, () => writeTerminalAccessNow(dataDir, change))
  } catch (e) {
    if (e instanceof HostAlreadyRunningError) throw new CliError(hostOwnsFolderMessage(e.info), EXIT.failure)
    if (e instanceof HostStartingOrBusyError) throw new CliError(hostStartingMessage(e.ownerPid), EXIT.hostBusy)
    throw e
  }
}

/** What each level lets a terminal do, for status lines. */
export const LEVEL_WORDS: Record<TerminalAccessLevel, string> = {
  operate: 'terminals may watch and run work',
  full: 'terminals may also approve decisions and change configuration'
}

/** The question `orgai daemon start --runtime node` asks once (4.2.1). */
export const LEVEL_QUESTION = 'What may terminals do? full = also answer decisions and change settings, operate = start, follow and stop runs [full/operate]'

/** {@link LEVEL_QUESTION} naming what an empty answer (Enter) keeps: the level stored now (review round 2). */
export function levelQuestion(current: TerminalAccessLevel): string {
  return `${LEVEL_QUESTION} (Enter keeps ${current}) `
}

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
