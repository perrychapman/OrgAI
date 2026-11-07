import type { ConnectionId, ConnectionInfo, ProjectKind, ProjectPathCheck, SetupKind } from '@shared/types'
import { PROJECT_REFERENCE_DIRECTORIES_MAX, isProjectKind, isProxyConnection } from '@shared/types'
import { connectionKindLabel, connectionWithAuth, defaultConnectionInfo, isProxyId } from './connectionLabel'
import { workingFolderProblem } from './folderLists'

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
export function pathStatus(kind: SetupKind, path: string, check: ProjectPathCheck | null, projectKind: ProjectKind = 'code'): PathStatus | null {
  const p = path.trim()
  if (!p) return null
  // A relative path would resolve against the app's own folder, so it is refused before anything is checked.
  if (!isFullPath(p)) return { tone: 'error', text: `Use a full path, for example ${fullPathExample()}`, blocking: true }
  if (!check) return null
  if (projectKind === 'engagement') {
    // The working folder must exist; nothing about git, emptiness or code is said.
    if (!check.exists) return { tone: 'error', text: 'No folder at this path.', blocking: true }
    if (!check.isDirectory) return { tone: 'error', text: 'This is a file, not a folder.', blocking: true }
    return null
  }
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
export function submitBlocker(input: { kind: SetupKind; name: string; path: string; brief: string; status: PathStatus | null; projectKind?: ProjectKind }): string | null {
  if (input.projectKind === 'engagement') {
    if (!input.path.trim()) return 'Choose the working folder.'
    return input.status?.blocking ? input.status.text : null
  }
  if (!input.path.trim()) return input.kind === 'new' ? 'Choose a folder to create the project in.' : 'Choose the repository folder.'
  if (input.status?.blocking) return input.status.text
  if (input.kind === 'new') {
    if (!input.name.trim()) return 'Give the project a name.'
    if (!input.brief.trim()) return 'Describe what you want to build.'
  }
  return null
}

export interface NewProjectConnectionView {
  text: string
  /** The link button after the text ("Manage connections" or "Connect"); null when there is nothing to open (mock). */
  link: 'Manage connections' | 'Connect' | null
}

/**
 * The New project form's connection line, from the effective default (connections:list `isDefault`) only; the
 * renderer never works out a fallback. Before the list loads the line is empty.
 */
export function newProjectConnectionView(connections: readonly ConnectionInfo[] | null | undefined, mock = false): NewProjectConnectionView {
  if (mock) return { text: 'Runs on the mock adapter (no tokens).', link: null }
  if (!connections) return { text: '', link: null }
  const def = defaultConnectionInfo(connections)
  // "Nothing is connected" only when nothing is: a chosen default that dropped, or one still checking, is named instead.
  if (!connections.some((c) => c.status.state === 'connected')) return { text: 'Nothing is connected yet.', link: 'Connect' }
  if (!def) return { text: '', link: null }
  if (def.status.state !== 'connected') return { text: `Runs on ${connectionWithAuth(def)}, which is not connected.`, link: 'Manage connections' }
  return { text: `Runs on ${connectionWithAuth(def)}.`, link: 'Manage connections' }
}

export interface ConnectionChoice {
  id: ConnectionId
  /** "Anthropic", "OpenAI", or "Name (LiteLLM proxy)"; "· default" marks the app default. */
  label: string
  proxy: boolean
  isDefault: boolean
}

/**
 * The connections a new project can start on: the connected ones, Anthropic, OpenAI, then proxies by name. The
 * New project form shows a Select only when there are two or more.
 */
export function connectionChoices(connections: readonly ConnectionInfo[] | null | undefined): ConnectionChoice[] {
  const connected = (connections ?? []).filter((c) => c.status.state === 'connected')
  const proxy = (c: ConnectionInfo): boolean => isProxyId(c.connection.id)
  const rank = (c: ConnectionInfo): number => (c.connection.id === 'anthropic' ? 0 : c.connection.id === 'openai' ? 1 : 2)
  const name = (c: ConnectionInfo): string => (isProxyConnection(c.connection) ? c.connection.name : '')
  return [...connected]
    .sort((a, b) => rank(a) - rank(b) || (proxy(a) ? name(a).localeCompare(name(b)) : 0))
    .map((c) => {
      const label = proxy(c) ? `${connectionLabelOf(c)} (${connectionKindLabel(c.connection)})` : connectionLabelOf(c)
      return { id: c.connection.id, label: c.isDefault ? `${label} · default` : label, proxy: proxy(c), isDefault: c.isDefault }
    })
}

function connectionLabelOf(c: ConnectionInfo): string {
  return isProxyConnection(c.connection) ? c.connection.name : connectionKindLabel(c.connection)
}

/** The id the Select shows: the user's pick while it is still connected, else the default, else the first. */
export function chosenConnection(choices: readonly ConnectionChoice[], picked: ConnectionId | null): ConnectionId | null {
  if (picked && choices.some((c) => c.id === picked)) return picked
  return choices.find((c) => c.isDefault)?.id ?? choices[0]?.id ?? null
}

/** One line under the Select when the chosen connection is a proxy. */
export const PROXY_TIER_NOTE = "Roles start on this connection's tier models. You can change each role's model afterwards."

export const LAST_PROJECT_KIND_KEY = 'orgai.lastProjectKind'

type KindStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): KindStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The kind of the user's last created project, or null (first launch, junk, storage unavailable). */
export function readLastProjectKind(storage: KindStorage | null = defaultStorage()): ProjectKind | null {
  try {
    const v = storage?.getItem(LAST_PROJECT_KIND_KEY)
    return isProjectKind(v) ? v : null
  } catch {
    return null
  }
}

export function writeLastProjectKind(kind: ProjectKind, storage: KindStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAST_PROJECT_KIND_KEY, kind)
  } catch {
    /* remembering is a convenience */
  }
}

function folderKey(path: string): string {
  const p = path.trim().replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:|\\/.test(p) ? p.replace(/\//g, '\\').toLowerCase() : p
}

/** Adding one reference folder to the list: the new list, or the reason it was refused. */
export function addReferenceFolder(list: readonly string[], input: string, workingFolder: string, kind: ProjectKind = 'engagement'): { list: string[] } | { error: string } {
  const p = input.trim()
  if (!p) return { error: 'Enter a folder path or choose one with Browse.' }
  if (!isFullPath(p)) return { error: `Use a full path, for example ${fullPathExample()}` }
  const outside = workingFolderProblem(p, workingFolder, kind)
  if (outside) return { error: outside }
  if (list.some((x) => folderKey(x) === folderKey(p))) return { error: 'This folder is already in the list.' }
  if (list.length >= PROJECT_REFERENCE_DIRECTORIES_MAX) return { error: `At most ${PROJECT_REFERENCE_DIRECTORIES_MAX} folders.` }
  return { list: [...list, p] }
}

/** The name to create with: the typed one, else the folder's name. */
export function effectiveName(name: string, path: string, check: ProjectPathCheck | null): string {
  return name.trim() || check?.suggestedName || pathLeaf(path.trim())
}
