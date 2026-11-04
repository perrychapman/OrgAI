import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS } from '@shared/types'
import { isSafeId, projectDocumentPath, projectRulesLocation } from '@shared/defaults'
import { settingsLocalPath } from '../runtime/permissionRules'

/**
 * Per-project files OrgAI keeps in its own data folder instead of the project folder (engagements write nothing into
 * their working folder). The one place these paths are built:
 *   <data>/projects/<projectId>/ENGAGEMENT.md          the approved engagement document
 *   <data>/projects/<projectId>/permission-rules.json  saved "always allow" rules ({ permissions: { allow: [] } })
 * Project ids are checked with isSafeId, so an id can never climb out of the folder.
 */

/** `<data>/projects/<projectId>`. Throws on an unsafe id. */
export function projectDataDir(dataDir: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error('Invalid project id')
  return join(dataDir, 'projects', projectId)
}

/** Delete `<data>/projects/<projectId>` (a missing dir or an unsafe id is ignored; a link is removed, never followed). */
export function removeProjectData(dataDir: string, projectId: string): void {
  try {
    rmSync(projectDataDir(dataDir, projectId), { recursive: true, force: true })
  } catch {
    /* unsafe id or not removable: nothing to clean */
  }
}

/** `<data>/projects/<projectId>/ENGAGEMENT.md`. */
export function engagementDocumentFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), projectDocumentPath('engagement'))
}

/** `<data>/projects/<projectId>/permission-rules.json`. */
export function appRulesFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'permission-rules.json')
}

/**
 * The file holding a project's saved allow rules: `<project>/.claude/settings.local.json` for code projects,
 * appRulesFile for engagements (defaults.ts projectRulesLocation). Both use the same JSON shape, so
 * permissionRules.ts reads and writes either through its file-path functions.
 */
export function projectRulesFile(project: Pick<Project, 'id' | 'path' | 'kind'>, dataDir: string): string {
  return projectRulesLocation(project) === 'app' ? appRulesFile(dataDir, project.id) : settingsLocalPath(project.path)
}

/**
 * The engagement document's text for the prompt, at most `max` characters followed by a truncation note; undefined
 * when there is none (not an engagement document yet, unreadable, not a regular file, or empty).
 */
export function readEngagementDocument(dataDir: string, projectId: string, max = ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS): string | undefined {
  try {
    const file = engagementDocumentFile(dataDir, projectId)
    if (!existsSync(file) || !lstatSync(file).isFile()) return undefined
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    if (!text.trim()) return undefined
    return text.length > max ? `${text.slice(0, max)}\n\n… (truncated: the engagement document is longer than ${max} characters)` : text
  } catch {
    return undefined
  }
}
