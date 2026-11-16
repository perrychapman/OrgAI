import { lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isSafeId } from '@shared/defaults'
import { canonicalDeep } from '../quick/scratch'
import { teamFilesDir } from './store'

/** Absolute team-files control roots for the current project ids, including lexical and canonical spellings. */
export function teamFilesProtectedPaths(dataDir: string, projectIds: readonly string[]): string[] {
  const out: string[] = []
  for (const id of projectIds) {
    const dir = resolve(teamFilesDir(dataDir, id))
    for (const spelling of [dir, canonicalDeep(dir)]) if (!out.includes(spelling)) out.push(spelling)
  }
  return out
}

/**
 * Existing project team-files roots in a sibling product data dir. The directory is re-read on every gate callback.
 * A missing projects dir means there are no existing projects. An unreadable or linked projects root fails closed at
 * the sibling data dir; an unsafe entry beneath a checked plain root fails closed at that projects root. No
 * project/team-files symlink target is canonicalized or followed.
 */
export function existingTeamFilesProtectedPaths(dataDir: string): string[] {
  const projectsRoot = resolve(join(dataDir, 'projects'))
  try {
    const rootInfo = lstatSync(projectsRoot)
    if (rootInfo.isSymbolicLink()) return dataRootFallback(dataDir)
    if (!rootInfo.isDirectory()) return projectRootFallback(projectsRoot)

    const ids: string[] = []
    for (const name of readdirSync(projectsRoot)) {
      if (!isSafeId(name)) continue
      try {
        const info = lstatSync(join(projectsRoot, name))
        if (info.isSymbolicLink() || !info.isDirectory()) return projectRootFallback(projectsRoot)
        const teamDir = teamFilesDir(dataDir, name)
        try {
          const teamInfo = lstatSync(teamDir)
          if (teamInfo.isSymbolicLink() || !teamInfo.isDirectory()) return projectRootFallback(projectsRoot)
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') return projectRootFallback(projectsRoot)
        }
        ids.push(name)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') return projectRootFallback(projectsRoot)
      }
    }
    return teamFilesProtectedPaths(dataDir, ids)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    return dataRootFallback(dataDir)
  }
}

function projectRootFallback(path: string): string[] {
  const resolved = resolve(path)
  return [...new Set([resolved, canonicalDeep(resolved)])]
}

function dataRootFallback(path: string): string[] {
  // This trusted ancestor blocks every lexical path through a linked/unreadable projects root without resolving it.
  return [resolve(path)]
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}
