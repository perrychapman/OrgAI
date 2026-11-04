import type { ProjectKind } from '@shared/types'
import { allowedFolderDraftProblem, isInsidePath, pathKey } from './permissionCopy'

/** Which of the two folder lists on Project settings > Permissions a card edits. */
export type FolderListKind = 'reference' | 'allowed'

/** How a folder relates to the working folder. Main drops all three from both lists, so the UI refuses them up front. */
export type WorkingFolderRelation = 'same' | 'inside' | 'contains'

const folderWord = (kind: ProjectKind): string => (kind === 'engagement' ? 'working folder' : 'project folder')

/** The refusal for each relation, in the words of the project's kind. */
export function workingFolderRefusal(relation: WorkingFolderRelation, kind: ProjectKind = 'engagement'): string {
  const w = folderWord(kind)
  if (relation === 'same') return `This is the ${w}. Agents can already change files in it.`
  if (relation === 'inside') return `This folder is inside the ${w}. Reference folders must be outside it.`
  return `This folder contains the ${w}. Pick a folder outside it.`
}

/** The copy for the engagement default, kept for callers that have no kind. */
export const WORKING_FOLDER_REFUSAL = workingFolderRefusal('same')

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Equal to, inside or containing the working folder (case-insensitive on Windows paths, separators normalised); null otherwise. */
export function workingFolderRelation(draft: string, projectPath: string): WorkingFolderRelation | null {
  const d = draft.trim()
  const w = projectPath.trim()
  if (!d || !w) return null
  if (pathKey(d) === pathKey(w)) return 'same'
  if (isInsidePath(d, w)) return 'inside'
  if (isInsidePath(w, d)) return 'contains'
  return null
}

/** The working folder, anything inside it and anything containing it can be in neither list. Null for any other folder. */
export function workingFolderProblem(draft: string, projectPath: string, kind: ProjectKind = 'engagement'): string | null {
  const relation = workingFolderRelation(draft, projectPath)
  return relation ? workingFolderRefusal(relation, kind) : null
}

/** The first inline problem for a draft folder: empty, too long, listed already, list full, or the working folder. */
export function folderDraftProblem(draft: string, own: readonly string[], projectPath: string, kind: ProjectKind = 'engagement'): string | null {
  return allowedFolderDraftProblem(draft, own) ?? workingFolderProblem(draft, projectPath, kind)
}

/** The first reference folder in a list that main would drop for the working folder, with the reason; null when all stay. */
export function firstWorkingFolderConflict(list: readonly string[], projectPath: string, kind: ProjectKind = 'engagement'): { path: string; problem: string } | null {
  for (const p of list) {
    const problem = workingFolderProblem(p, projectPath, kind)
    if (problem) return { path: p, problem }
  }
  return null
}

/**
 * What to say when the saved project lacks something the form sent (main cleaned a folder away or dropped the client),
 * or null when everything was kept.
 */
export function droppedExtrasMessage(sentRefs: readonly string[], saved: { referenceDirectories?: string[]; client?: string }, sentClient?: string): string | null {
  const keep = new Set((saved.referenceDirectories ?? []).map(pathKey))
  const lost = sentRefs.filter((r) => !keep.has(pathKey(r)))
  const parts: string[] = []
  if (lost.length) parts.push(`OrgAI did not keep these folders: ${lost.join(', ')}. Folders must be absolute, and cannot be the working folder, inside it or contain it.`)
  if (sentClient && !(saved.client ?? '').trim()) parts.push('OrgAI did not keep the client name.')
  return parts.length ? parts.join(' ') : null
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
