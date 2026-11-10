/**
 * The host calls behind the TUI's Team and Settings views (cli-parity 3.7). They are the channels the commands use
 * (`team role ...`, `projects set`, `permissions mode`, `connections tier`, `settings set`): reads on the session's
 * shared read connection, writes on a separate one-call 'configure' connection (TuiConnection.callConfigured), so the
 * host stays the authority and validates every save. Also the "first time here" record behind the /team and /settings
 * hint (one small file in the CLI's user-data folder, never read by the host).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, ConnectionId, ConnectionInfo, Project, ProviderConnection, ProviderModel } from '../../shared/types'

/** A value settings:set receives for one key (null clears an optional number). */
export type ConfigSettingValue = string | number | boolean | null

export interface TuiConfigApi {
  /** projects:get (read): a fresh copy of the project. */
  project(id: string): Promise<Project>
  /** projects:save (configure): the host cleans and stores it; the session's project follows. */
  saveProject(project: Project): Promise<Project>
  /** projects:list (read): every project (a tier change may touch roles of other projects). */
  projects(): Promise<Project[]>
  /** connections:list (read). */
  connections(): Promise<ConnectionInfo[]>
  /** models:list (read), of one connection when given. */
  models(connection?: ConnectionId): Promise<ProviderModel[]>
  /** settings:get (read). */
  settings(): Promise<Partial<AppSettings>>
  /** settings:set (configure) with exactly one key. */
  setSetting(patch: Record<string, ConfigSettingValue>): Promise<Partial<AppSettings>>
  /** connections:update (configure): a tier change; the host remaps the roles on that connection. */
  updateConnection(connection: ProviderConnection): Promise<ConnectionInfo>
  /** True the first time this terminal opens the project (and records it, so the hint shows once). */
  firstOpen?(projectId: string): Promise<boolean>
}

/** The record of projects this terminal has opened (for the one-time /team and /settings hint). */
export const HINTS_FILE = 'tui-hints.json'
const HINTS_MAX = 500

/**
 * `firstOpen` over `<userDataDir>/tui-hints.json`: `{ "projects": [ids] }`. A missing or unreadable file counts as
 * empty; a failed write is ignored (the hint may then show again, nothing else depends on it).
 */
export function hintStore(userDataDir: string): (projectId: string) => Promise<boolean> {
  const file = join(userDataDir, HINTS_FILE)
  return async (projectId: string): Promise<boolean> => {
    let seen: string[] = []
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
      if (Array.isArray(raw.projects)) seen = raw.projects.filter((x): x is string => typeof x === 'string')
    } catch {
      seen = []
    }
    if (seen.includes(projectId)) return false
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ projects: [...seen, projectId].slice(-HINTS_MAX) }), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // The hint is a convenience: a read-only folder only means it may show again.
    }
    return true
  }
}

/** The one-time notice on opening a project this terminal has never opened. */
export const CONFIG_HINT = 'New here? /team shows the roles and models, /settings the settings.'
