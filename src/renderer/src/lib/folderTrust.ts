import type { FolderConfigReview, FolderConfigState, Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { formatDate } from './dates'

/**
 * Pure logic of the folder config trust UI (Settings > Permissions section, the New run notice, the repo start line).
 * Main decides the state and the digest; these helpers only decide what the screens say and when the notice shows.
 */

export const FOLDER_TRUST_FRAMING =
  'This folder came with its own agent settings. Some of them run commands on your computer. Agents ignore them until you allow them.'

export const FOLDER_TRUST_STALE = 'The files changed while you were reading. Read the review again before allowing.'

export const FOLDER_TRUST_NOTICE_TEXT = "Agents are ignoring this folder's own settings."

/** Only a code project that carries the stored field is gated; everything else never fetches a review. */
export function hasFolderTrustField(project: Pick<Project, 'kind' | 'folderConfigTrust'> | null | undefined): boolean {
  return !!project && !!project.folderConfigTrust && projectKindOf(project as Project) === 'code'
}

/** The state to show: the fetched review wins (only it can say 'changed'), else the stored field, else 'none'. */
export function folderTrustState(project: Pick<Project, 'folderConfigTrust'> | null | undefined, review: Pick<FolderConfigReview, 'state'> | null): FolderConfigState {
  if (review) return review.state
  return project?.folderConfigTrust?.state ?? 'none'
}

/** "Allowed 4 Nov 2026." part, or '' when the time is missing or junk. */
function allowedOn(decidedAt: string | undefined): string {
  if (!decidedAt) return ''
  const ms = Date.parse(decidedAt)
  const d = formatDate(Number.isFinite(ms) ? ms : undefined)
  return d ? ` Allowed ${d}.` : ''
}

/** The status sentence of a state; '' for 'none'. */
export function folderTrustSentence(state: FolderConfigState, decidedAt?: string): string {
  switch (state) {
    case 'untrusted':
      return "Agents are ignoring this folder's own settings until you allow them."
    case 'changed':
      return 'These settings changed since you allowed them. Agents are ignoring them until you review them again.'
    case 'trusted':
      return `Agents use this folder's own settings.${allowedOn(decidedAt)}`
    default:
      return ''
  }
}

/** The short phrase for the Permissions summary line; '' for 'none'. */
export function folderTrustSummary(state: FolderConfigState): string {
  switch (state) {
    case 'untrusted':
      return "This folder's own settings are not allowed yet."
    case 'changed':
      return "This folder's own settings changed and need a new look."
    case 'trusted':
      return "This folder's own settings are allowed."
    default:
      return ''
  }
}

/** The notice shows while agents ignore the folder's settings and the user has not dismissed this digest. */
export function showFolderTrustNotice(state: FolderConfigState, digest: string | undefined, dismissedDigest: string | null): boolean {
  if (state !== 'untrusted' && state !== 'changed') return false
  return !digest || digest !== dismissedDigest
}

export const FOLDER_TRUST_DISMISS_PREFIX = 'orgai.folderTrustDismissed.'

/** Dismissal is per project and per digest: a changed folder asks again. */
export function folderTrustDismissKey(projectId: string): string {
  return `${FOLDER_TRUST_DISMISS_PREFIX}${projectId}`
}

type KV = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const DIGEST_RE = /^[0-9a-f]{64}$/

/** The digest the user dismissed for this project, or null. */
export function readDismissedDigest(projectId: string, storage: KV | null = defaultStorage()): string | null {
  try {
    const v = storage?.getItem(folderTrustDismissKey(projectId))
    return typeof v === 'string' && DIGEST_RE.test(v) ? v : null
  } catch {
    return null
  }
}

export function writeDismissedDigest(projectId: string, digest: string, storage: KV | null = defaultStorage()): void {
  if (!DIGEST_RE.test(digest)) return
  try {
    storage?.setItem(folderTrustDismissKey(projectId), digest)
  } catch {
    /* dismissing is a convenience */
  }
}

// ---- Review parts ----

export type ReviewSectionKey = 'commands' | 'mcpServers' | 'env' | 'allowRules' | 'otherSettings' | 'files'

/** Most dangerous first: what runs, what launches, what redirects, what grants, the rest, then the file list. */
export const REVIEW_SECTION_ORDER: readonly ReviewSectionKey[] = ['commands', 'mcpServers', 'env', 'otherSettings', 'allowRules', 'files']

export const REVIEW_SECTION_TITLE: Record<ReviewSectionKey, string> = {
  commands: 'Commands that would run',
  mcpServers: 'MCP servers it would start',
  env: 'Environment values it would set',
  otherSettings: 'Other settings that change behavior',
  allowRules: 'Permission rules it would add',
  files: 'Files'
}

export function reviewSectionCount(review: FolderConfigReview, key: ReviewSectionKey): number {
  return review[key].length
}

export function hasContent(review: FolderConfigReview, key: ReviewSectionKey): boolean {
  return reviewSectionCount(review, key) > 0
}

/** Sections to draw, in order, with their counts; empty ones are left out (files stay when listed). */
export function reviewSections(review: FolderConfigReview): { key: ReviewSectionKey; title: string; count: number }[] {
  return REVIEW_SECTION_ORDER.filter((k) => hasContent(review, k)).map((key) => ({ key, title: REVIEW_SECTION_TITLE[key], count: reviewSectionCount(review, key) }))
}

export interface ItemBadges {
  masked: boolean
  /** "U+202E" or null. */
  hidden: string | null
}

export function itemBadges(item: { masked?: boolean; hiddenChar?: string }): ItemBadges {
  return { masked: item.masked === true, hidden: item.hiddenChar ? item.hiddenChar : null }
}

export const MASKED_BADGE = 'Masked'
export const MASKED_BADGE_TITLE = 'A secret-looking part is hidden here and stays hidden. Everything around it is shown.'

export function hiddenBadgeText(hiddenChar: string): string {
  return `Hidden character ${hiddenChar}`
}

/** Whether Accept is offered: never for an unreviewable config, never when already allowed. */
export function canAccept(review: FolderConfigReview | null): boolean {
  return !!review && !review.unreviewable && review.state !== 'trusted' && review.state !== 'none' && !!review.digest
}

export function canRevoke(review: FolderConfigReview | null): boolean {
  return !!review && review.state === 'trusted'
}

/** The files line: how many are covered by the digest and how many can change while trusted. */
export function filesSummary(review: Pick<FolderConfigReview, 'files'>): string {
  const total = review.files.length
  const digested = review.files.filter((f) => f.digested).length
  const free = total - digested
  const base = `${total} ${total === 1 ? 'file' : 'files'}, ${digested} checked for changes.`
  return free > 0
    ? `${base} The other ${free} (instruction files) are shown but not checked: they can change while you trust this folder.`
    : base
}

/** A long block is cut behind "Show all". */
export const CLAMP_CHARS = 600
export const CLAMP_LINES = 10
export function isLongText(text: string): boolean {
  return text.length > CLAMP_CHARS || text.split('\n').length > CLAMP_LINES
}

// ---- Opening the review from elsewhere ----

export const FOLDER_TRUST_OPEN_EVENT = 'orgai:folder-trust-review'
const OPEN_KEY = 'orgai.pendingFolderTrust'

/** Ask the Permissions pane to open the review dialog for a project, now (mounted) or when it mounts. */
export function requestFolderTrustReview(projectId: string): void {
  try {
    sessionStorage.setItem(OPEN_KEY, projectId)
  } catch {
    /* the pane just opens without the dialog */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FOLDER_TRUST_OPEN_EVENT))
}

/** True once when a request for this project is waiting; clears it. */
export function takeFolderTrustRequest(projectId: string): boolean {
  try {
    if (sessionStorage.getItem(OPEN_KEY) !== projectId) return false
    sessionStorage.removeItem(OPEN_KEY)
    return true
  } catch {
    return false
  }
}
