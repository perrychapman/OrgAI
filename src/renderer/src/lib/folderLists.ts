import { allowedFolderDraftProblem, pathKey } from './permissionCopy'

/** Which of the two folder lists on Project settings > Permissions a card edits. */
export type FolderListKind = 'reference' | 'allowed'

export const WORKING_FOLDER_REFUSAL = 'This is the working folder. Pick a folder inside it or elsewhere.'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The working folder can be in neither list. Null when the draft is some other folder. */
export function workingFolderProblem(draft: string, projectPath: string): string | null {
  const d = draft.trim()
  if (!d || !projectPath) return null
  return pathKey(d) === pathKey(projectPath) ? WORKING_FOLDER_REFUSAL : null
}

/** The first inline problem for a draft folder: empty, too long, listed already, list full, or the working folder. */
export function folderDraftProblem(draft: string, own: readonly string[], projectPath: string): string | null {
  return allowedFolderDraftProblem(draft, own) ?? workingFolderProblem(draft, projectPath)
}

/** The entry of `other` that is the same folder as `draft` (the stored spelling), or null: the add needs a move. */
export function folderConflict(draft: string, other: readonly string[]): string | null {
  const key = pathKey(draft.trim())
  return other.find((o) => pathKey(o) === key) ?? null
}

/** Move one folder from a list to another in one step; the folder lands once, at the end of the target. */
export function moveFolder(from: readonly string[], to: readonly string[], path: string): { from: string[]; to: string[] } {
  const key = pathKey(path)
  return {
    from: from.filter((f) => pathKey(f) !== key),
    to: [...to.filter((t) => pathKey(t) !== key), path]
  }
}

/** The confirm text for adding a folder that is already in the other list. */
export function moveConfirmCopy(target: FolderListKind, path: string): { title: string; body: string; confirmLabel: string } {
  return target === 'reference'
    ? {
        title: 'Make it read only?',
        body: `${path} is an allowed folder now. Agents will only be able to read it.`,
        confirmLabel: 'Make read only'
      }
    : {
        title: 'Allow changes to it?',
        body: `${path} is a reference folder now. Agents will be able to read and change files in it.`,
        confirmLabel: 'Allow changes'
      }
}

/**
 * The summary line of "Rules and folders you allowed": "3 rules and 1 folder you allowed" without reference folders,
 * "2 reference folders, 1 folder you allowed" with them (rules first when there are some). Null while rules load.
 */
export function foldersSummary(rules: number | null, allowed: number, reference = 0): string | null {
  if (rules === null) return null
  if (rules === 0 && allowed === 0 && reference === 0) return 'None yet. Approval cards add them here.'
  if (reference === 0) {
    const parts = [rules > 0 ? plural(rules, 'rule', 'rules') : '', allowed > 0 ? plural(allowed, 'folder', 'folders') : ''].filter(Boolean)
    return `${parts.join(' and ')} you allowed`
  }
  return [
    rules > 0 ? plural(rules, 'rule', 'rules') : '',
    plural(reference, 'reference folder', 'reference folders'),
    allowed > 0 ? `${plural(allowed, 'folder', 'folders')} you allowed` : ''
  ]
    .filter(Boolean)
    .join(', ')
}
