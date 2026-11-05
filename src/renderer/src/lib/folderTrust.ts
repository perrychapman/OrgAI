import type { FolderConfigFile, FolderConfigReview, FolderConfigState, Project } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { formatDate } from './dates'

/**
 * Pure logic of the folder config trust UI (Settings > Permissions section, the New run notice, the repo start line).
 * Main decides the state and the digest; these helpers only decide what the screens say and when the notice shows.
 */

export const FOLDER_TRUST_FRAMING =
  'This folder came with its own agent settings. Some of them run commands on your computer. Agents ignore them until you allow them.'

export const FOLDER_TRUST_STALE = 'The files changed while you were reading. Read the review again before allowing.'

/** The permission card's quiet line while the folder's settings are ignored (a Review link follows it). */
export const FOLDER_TRUST_CARD_LINE = "This folder's own settings are ignored right now."

/** Agents ignore the folder's settings in these two states. */
export function folderTrustIgnored(state: FolderConfigState): boolean {
  return state === 'untrusted' || state === 'changed'
}

/** OrgAI's own team files; the Team tab's team files gate reviews them, not this one. */
export function isTeamFilePath(path: string): boolean {
  return path === '.orgai' || path.startsWith('.orgai/')
}

/** Plain count phrases for what the folder's own settings hold, without OrgAI's team files. Empty when nothing counts. */
export function settingsCounts(review: Pick<FolderConfigReview, 'allowRules' | 'commands' | 'mcpServers' | 'env' | 'files'>): string[] {
  const n = (count: number, one: string, many: string): string => (count === 0 ? '' : `${count} ${count === 1 ? one : many}`)
  const agentFiles = review.files.filter((f) => !isTeamFilePath(f.path) && /(^|\/)agents\//.test(f.path)).length
  return [
    n(review.allowRules.length, 'command rule', 'command rules'),
    n(review.commands.length, 'hook or helper', 'hooks and helpers'),
    n(review.mcpServers.length, 'server', 'servers'),
    n(review.env.length, 'environment value', 'environment values'),
    n(agentFiles, 'agent file', 'agent files')
  ].filter(Boolean)
}

/** The New run notice: why agents ignore the folder's settings and what Allow does, in one line. */
export function folderTrustNoticeText(state: FolderConfigState, review: Parameters<typeof settingsCounts>[0] | null): string {
  if (state === 'changed') return "This folder's own agent settings changed since you allowed them. Agents ignore them until you review and allow them again."
  const counts = review ? settingsCounts(review) : []
  return `This folder came with its own agent settings${counts.length ? ` (${counts.join(', ')})` : ''}. Agents ignore them until you review and allow them.`
}

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
      return "Agents ignore this folder's own settings until you review and allow them. Allow lets agents use them from the next run."
    case 'changed':
      return 'These settings changed since you allowed them. Agents ignore them until you review and allow them again.'
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

export type ReviewSectionKey = 'commands' | 'mcpServers' | 'env' | 'allowRules' | 'otherSettings' | 'files' | 'teamFiles'

/** Most dangerous first: what runs, what launches, what redirects, what grants, the rest, then the file lists. */
export const REVIEW_SECTION_ORDER: readonly ReviewSectionKey[] = ['commands', 'mcpServers', 'env', 'otherSettings', 'allowRules', 'files', 'teamFiles']

/** Titles say "would" before the user allows and the plain present after: Allow adds, it does not "would add". */
export const REVIEW_SECTION_TITLE: Record<ReviewSectionKey, { before: string; after: string }> = {
  commands: { before: 'Commands that would run', after: 'Commands that run' },
  mcpServers: { before: 'MCP servers it would start', after: 'MCP servers it starts' },
  env: { before: 'Environment values it would set', after: 'Environment values it sets' },
  otherSettings: { before: 'Other settings that would change behavior', after: 'Other settings that change behavior' },
  allowRules: { before: 'Permission rules it would add', after: 'Permission rules it adds' },
  files: { before: 'Files', after: 'Files' },
  teamFiles: { before: 'OrgAI team files (reviewed in Team)', after: 'OrgAI team files (reviewed in Team)' }
}

/** One plain line under each section's title, so the list reads without opening any file text. */
export const REVIEW_SECTION_SUMMARY: Record<ReviewSectionKey, string> = {
  commands: 'Programs on your computer that start by themselves, such as hooks and helpers.',
  mcpServers: 'Extra tools for agents. Each one starts a program or connects to an address.',
  env: 'Values set in the environment of every agent run.',
  otherSettings: 'Settings that change what agents may do or where their requests go.',
  allowRules: 'Commands and tools agents may use without asking you first.',
  files: 'The files these settings come from: rules, servers, helper agents and instructions.',
  teamFiles: "OrgAI's own team files. The Team tab asks you about them separately; they are not part of this allow."
}

function filesOf(review: Pick<FolderConfigReview, 'files'>, team: boolean): FolderConfigFile[] {
  return review.files.filter((f) => isTeamFilePath(f.path) === team)
}

export function reviewSectionCount(review: FolderConfigReview, key: ReviewSectionKey): number {
  if (key === 'files') return filesOf(review, false).length
  if (key === 'teamFiles') return filesOf(review, true).length
  return review[key].length
}

export function hasContent(review: FolderConfigReview, key: ReviewSectionKey): boolean {
  return reviewSectionCount(review, key) > 0
}

/** Sections to draw, in order, with their counts; empty ones are left out (files stay when listed). */
export function reviewSections(review: FolderConfigReview): { key: ReviewSectionKey; title: string; summary: string; count: number }[] {
  const tense = review.state === 'trusted' ? 'after' : 'before'
  return REVIEW_SECTION_ORDER.filter((k) => hasContent(review, k)).map((key) => ({
    key,
    title: REVIEW_SECTION_TITLE[key][tense],
    summary: REVIEW_SECTION_SUMMARY[key],
    count: reviewSectionCount(review, key)
  }))
}

/** The files shown in a files section (the folder's own, or OrgAI's team files). */
export function sectionFiles(review: Pick<FolderConfigReview, 'files'>, key: 'files' | 'teamFiles'): FolderConfigFile[] {
  return filesOf(review, key === 'teamFiles')
}

/** What the per-file badge says: whether a change to this file asks again. */
export const FILE_CHECKED_TEXT = 'Allow covers this file; a change asks again'
export const FILE_UNCHECKED_TEXT = "Instructions only; changes don't ask again"

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

/** The files line: how many files a change to asks again, and how many are instructions only. */
export function filesSummary(review: Pick<FolderConfigReview, 'files'>): string {
  const files = review.files.filter((f) => !isTeamFilePath(f.path))
  const total = files.length
  const covered = files.filter((f) => f.digested).length
  const free = total - covered
  const count = `${total} ${total === 1 ? 'file' : 'files'}.`
  const base = covered === 0 ? count : `${count} A change to ${covered === total ? (total === 1 ? 'it' : 'any of them') : `${covered} of them`} asks you again.`
  return free > 0 ? `${base} The other ${free} ${free === 1 ? 'is' : 'are'} instructions only: changes to ${free === 1 ? 'it' : 'them'} don't ask again.` : base
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
