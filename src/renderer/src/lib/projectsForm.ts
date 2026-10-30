import type { ProjectPathCheck, SetupKind } from '@shared/types'

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

/** What to tell the user about the folder they typed, or null while there is nothing to say. */
export function pathStatus(kind: SetupKind, path: string, check: ProjectPathCheck | null): PathStatus | null {
  const p = path.trim()
  if (!p || !check) return null
  if (check.exists && !check.isDirectory) return { tone: 'error', text: 'This is a file, not a folder.', blocking: true }
  if (kind === 'new') {
    if (!check.exists) return { tone: 'info', text: `A new folder will be created at ${p}`, blocking: false }
    if (check.empty) return { tone: 'ok', text: 'Empty folder. A good place to start.', blocking: false }
    return { tone: 'warn', text: 'This folder already has files. An empty folder is best for a new idea.', blocking: false }
  }
  if (!check.exists) return { tone: 'error', text: 'No folder at this path.', blocking: true }
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

/** The name to create with: the typed one, else the folder's name. */
export function effectiveName(name: string, path: string, check: ProjectPathCheck | null): string {
  return name.trim() || check?.suggestedName || pathLeaf(path.trim())
}
