import type { ConnectionId, ConnectionInfo, ProjectPathCheck, SetupKind } from '@shared/types'
import { CONNECTION_NAME } from './settingsCopy'

export type PathTone = 'error' | 'warn' | 'ok' | 'info'
export interface PathStatus {
  tone: PathTone
  text: string
  /** The problem makes creating the project pointless. */
  blocking: boolean
}

/** Last non-empty path segment, used until checkPath answers. */
export function pathLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/** A drive letter, a UNC share or a leading slash: the path names one folder wherever the app runs. */
export function isFullPath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path.trim())
}

function fullPathExample(): string {
  const win = typeof navigator !== 'undefined' && /win/i.test(navigator.platform ?? '')
  return win ? 'C:\\Projects\\shop' : '/Users/you/projects/shop'
}

/** What to tell the user about the folder they typed, or null while there is nothing to say. */
export function pathStatus(kind: SetupKind, path: string, check: ProjectPathCheck | null): PathStatus | null {
  const p = path.trim()
  if (!p) return null
  // A relative path would resolve against the app's own folder, so it is refused before anything is checked.
  if (!isFullPath(p)) return { tone: 'error', text: `Use a full path, for example ${fullPathExample()}`, blocking: true }
  if (!check) return null
  // A folder that is not there never counts as empty, whatever else the check says.
  if (!check.exists && kind === 'existing') return { tone: 'error', text: 'No folder at this path.', blocking: true }
  if (check.exists && !check.isDirectory) return { tone: 'error', text: 'This is a file, not a folder.', blocking: true }
  if (kind === 'new') {
    if (!check.exists) return { tone: 'info', text: `A new folder will be created at ${p}`, blocking: false }
    if (check.empty) return { tone: 'ok', text: 'Empty folder. A good place to start.', blocking: false }
    return { tone: 'warn', text: 'This folder already has files. An empty folder is best for a new idea.', blocking: false }
  }
  if (check.empty) return { tone: 'warn', text: 'Empty folder. Choose "New idea" if there is no code yet.', blocking: false }
  if (!check.isGitRepo) return { tone: 'warn', text: "Not a git repository yet (that's fine).", blocking: false }
  return { tone: 'ok', text: 'Git repository found.', blocking: false }
}

/** Why Create is disabled, or null when it can be submitted. */
export function submitBlocker(input: { kind: SetupKind; name: string; path: string; brief: string; status: PathStatus | null }): string | null {
  if (!input.path.trim()) return input.kind === 'new' ? 'Choose a folder to create the project in.' : 'Choose the repository folder.'
  if (input.status?.blocking) return input.status.text
  if (input.kind === 'new') {
    if (!input.name.trim()) return 'Give the project a name.'
    if (!input.brief.trim()) return 'Describe what you want to build.'
  }
  return null
}

/** Same rule as projects:create: LiteLLM needs a proxy URL and key, OpenAI needs to be enabled, Anthropic always works. */
export function connectionUsable(info: ConnectionInfo | undefined): boolean {
  if (!info) return false
  const c = info.connection
  if (c.id === 'litellm') return !!c.baseUrl && c.hasApiKey
  if (c.id === 'openai') return c.enabled
  return true
}

/** The connection a new project will get: the default when usable, else Anthropic. */
export function newProjectConnection(def: ConnectionId | null | undefined, connections: ConnectionInfo[] | null | undefined): ConnectionId {
  if (!def || def === 'anthropic') return 'anthropic'
  return connectionUsable(connections?.find((c) => c.connection.id === def)) ? def : 'anthropic'
}

/** The lead sentence of the new-project line (the "Change in App settings > Defaults" tail is added by the view). */
export function newProjectConnectionNote(def: ConnectionId | null | undefined, connections: ConnectionInfo[] | null | undefined, mock = false): string {
  if (mock) return 'Runs on the mock adapter (no tokens).'
  const used = newProjectConnection(def, connections)
  if (def && def !== used) return `${CONNECTION_NAME[def]} is not connected, so this project runs on ${CONNECTION_NAME[used]}.`
  return `Runs on ${CONNECTION_NAME[used]}.`
}

export function newProjectConnectionLine(def: ConnectionId | null | undefined, connections: ConnectionInfo[] | null | undefined, mock = false): string {
  const note = newProjectConnectionNote(def, connections, mock)
  return mock ? note : `${note} Change in App settings > Defaults.`
}

/** The name to create with: the typed one, else the folder's name. */
export function effectiveName(name: string, path: string, check: ProjectPathCheck | null): string {
  return name.trim() || check?.suggestedName || pathLeaf(path.trim())
}
