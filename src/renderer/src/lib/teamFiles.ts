import type { TeamFileChange, TeamFilesStatus } from '@shared/types'
import { showHidden } from './hiddenChars'

/**
 * Team files, renderer side (spec docs/design/team-files.md). Pure helpers over the TeamFilesStatus main sends.
 * The status of each project lives in the store (`teamFilesByProject`), loaded by `listAttention` at boot, by
 * `teamFiles.status` when a project opens and kept fresh by the `teamFiles:changed` push.
 */

/** A team-files decision that needs the user and has no run: the bell, the Needs-you column and tile badges count it. */
export interface TeamAttentionItem {
  /** `team:<projectId>`: one per project. */
  key: string
  projectId: string
  projectName: string
  /** 'pending': changes to approve. 'problem': a file cannot be read. */
  state: 'pending' | 'problem'
  /** Plain words, "Team files: 3 changes need your approval". */
  label: string
}

export function pluralChanges(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`
}

// ---- The Team tab: status line, approval card, applied notice ----

export type TeamLineAction = 'commit' | 'enable' | 'review'

export interface TeamLine {
  /** 'quiet': nothing to do. 'attention': the user can act. 'danger': a file cannot be read. */
  tone: 'quiet' | 'attention' | 'danger'
  /** The state in one sentence, "Team files: in sync". */
  text: string
  /** A second sentence, if any. */
  detail?: string
  /** Longer text for the tooltip (the line stays one row). */
  title?: string
  action?: TeamLineAction
  /** Label of the action button. */
  actionLabel?: string
}

/** How many changes still need the user: the listed ones plus those past the list limit. */
export function approvalCount(s: TeamFilesStatus): number {
  return s.changes.filter((c) => c.needsApproval).length + (s.omittedChanges ?? 0)
}

/** The persistent status line for a project, or null when the project has no team files to talk about (engagement, assistants). */
export function teamFilesLine(s: TeamFilesStatus): TeamLine | null {
  switch (s.state) {
    case 'off': {
      if (s.offReason === 'engagement' || s.offReason === 'virtual') return null
      if (s.offReason === 'removed') {
        return { tone: 'attention', text: 'Team files: off', detail: 'The OrgAI files were removed from this folder, so the team lives in OrgAI only.', action: 'enable', actionLabel: 'Turn team files on' }
      }
      if (s.offReason === 'shared-folder') {
        const owner = s.sharedWith?.projectName
        return {
          tone: 'quiet',
          text: 'Team files: off',
          detail: owner
            ? `The team files of this folder belong to ${owner}; this project keeps its team in OrgAI's data folder.`
            : "Another project owns this folder's team files; this project keeps its team in OrgAI's data folder."
        }
      }
      if (s.offReason === 'no-folder') return { tone: 'quiet', text: 'Team files: off', detail: 'The project folder does not exist yet.' }
      return { tone: 'quiet', text: 'Team files: not written yet', detail: 'They are written when this project opens.' }
    }
    case 'pending': {
      const n = Math.max(1, approvalCount(s))
      return { tone: 'attention', text: `Team files: ${pluralChanges(n)} ${n === 1 ? 'needs' : 'need'} your approval`, action: 'review', actionLabel: 'Review changes' }
    }
    case 'problem': {
      const p = s.problems[0]
      return {
        tone: 'danger',
        text: p ? `Team files: ${p.file} cannot be read` : 'Team files: a file cannot be read',
        detail: p ? `${p.message} ${PROBLEM_NEXT} The last approved team stays in use.` : `${PROBLEM_NEXT} The last approved team stays in use.`,
        ...(s.changes.length > 0 ? { action: 'review' as const, actionLabel: 'See changes' } : {})
      }
    }
    case 'rejected':
      return {
        tone: 'quiet',
        text: 'Team files: differ from the team in use',
        detail: 'You rejected them. Runs keep the last approved team. OrgAI asks again when the files change.',
        ...(s.uncommitted && s.isGitRepo ? { action: 'commit' as const, actionLabel: 'Commit team files' } : {})
      }
    case 'in-sync':
    default:
      if (s.uncommitted) {
        return {
          tone: 'attention',
          text: 'Team files changed, not committed',
          // The file list is the tooltip, so the line stays one row.
          title: s.uncommittedFiles.length > 0 ? `Not in git yet: ${listFiles(s.uncommittedFiles, 8)}.` : undefined,
          ...(s.isGitRepo ? { action: 'commit' as const, actionLabel: 'Commit team files' } : {})
        }
      }
      return { tone: 'quiet', text: 'Team files: in sync', detail: s.isGitRepo ? '.orgai/ in this repository.' : '.orgai/ in this folder.' }
  }
}

/** What to do about a file OrgAI cannot read. Main's own problem text comes first; this is the next step. */
export const PROBLEM_NEXT = 'Fix or remove the problem in that file, then come back to OrgAI: it checks again.'

/**
 * Identity of what a status says. A message or error from an action belongs to the status it left behind; when this
 * changes (new files, another state, a new commit state) the message is gone.
 */
export function statusKey(s: TeamFilesStatus | undefined): string {
  if (!s) return ''
  return [s.state, s.digest ?? '', s.uncommitted ? 'u' : '', s.uncommittedFiles.join('\n'), s.undo?.at ?? '', s.lastUndo?.at ?? '', s.problems.map((p) => `${p.file}:${p.message}`).join('\n')].join('|')
}

/** Why Approve waits until the change list has been read to its end. */
export const APPROVE_UNLOCKED_TEXT = 'You have seen every change. Approve is available.'
export const READ_FIRST_TEXT = 'Scroll to the end of the changes to approve.'
export const READ_FIRST_COMPACT_TEXT = 'Open Details and scroll to the end of the changes to approve.'

/** "a, b and 2 more" for file lists (at most 3 named). */
export function listFiles(files: readonly string[], max = 3): string {
  if (files.length <= max) return files.join(', ')
  return `${files.slice(0, max).join(', ')} and ${files.length - max} more`
}

export const TEAM_FILES_STALE_TEXT = 'The files changed. Review them again.'

/** An approve or reject refused because the digest is no longer the current one. */
export function isStaleDecision(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return /review them again/i.test(raw)
}

/** Why Approve is not offered, or null when it is. Reject stays available in every case with a digest. */
export function approveBlockedReason(s: TeamFilesStatus): string | null {
  if ((s.omittedChanges ?? 0) > 0) return `${s.omittedChanges} more ${s.omittedChanges === 1 ? 'change is' : 'changes are'} not listed. Too many changes to review at once.`
  if (s.state === 'problem') {
    const p = s.problems[0]
    return p ? `${p.file} cannot be read. Fix it, then review again.` : 'A file cannot be read. Fix it, then review again.'
  }
  if (!s.digest) return 'These files cannot be reviewed right now.'
  return null
}

/** Whether the approval card shows: pending, or a problem that still lists changes. */
export function cardVisible(s: TeamFilesStatus | undefined): s is TeamFilesStatus {
  return !!s && (s.state === 'pending' || (s.state === 'problem' && s.changes.length > 0))
}

export const CHANGE_KIND_LABEL: Record<TeamFileChange['kind'], string> = { role: 'Role', skill: 'Skill', mcp: 'Server', settings: 'Setting' }
export const CHANGE_ACTION_LABEL: Record<TeamFileChange['action'], string> = { added: 'New', changed: 'Changed', removed: 'Removed' }

/** The Live pointer's words, or null when nothing waits on the user. */
export function teamPointerText(s: TeamFilesStatus | undefined): string | null {
  if (!s) return null
  if (s.state === 'pending') {
    const n = Math.max(1, approvalCount(s))
    return `Team files: ${pluralChanges(n)} ${n === 1 ? 'needs' : 'need'} your approval.`
  }
  if (s.state === 'problem') return 'Team files: a file cannot be read.'
  return null
}

/** The card's lead sentence. */
export function cardLead(s: TeamFilesStatus): string {
  return s.firstSeen
    ? "This is the first time this repository's team is seen on this computer. Review what it would take on."
    : 'The team files in this folder differ from the team in use. Review what would change.'
}

/** "New tools: Bash, Write." or null. */
export function toolsAddedLine(c: TeamFileChange): string | null {
  const added = c.toolsAdded ?? []
  return added.length > 0 ? `New tools: ${added.join(', ')}.` : null
}

/** Elevated tools in plain words, "Can now run commands, edit files and start other agents." or null. */
export function elevatedLine(c: TeamFileChange): string | null {
  const words: Record<string, string> = {
    Bash: 'run commands',
    Edit: 'edit files',
    Write: 'write files',
    NotebookEdit: 'edit notebooks',
    canSpawn: 'start other agents'
  }
  const list = (c.elevatedAdded ?? []).map((t) => words[t] ?? t)
  if (list.length === 0) return null
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `Can now ${joined}.`
}

/** Who can use a server once approved. */
export function reachLine(c: TeamFileChange): string | null {
  if (c.kind !== 'mcp' || c.action === 'removed') return null
  return c.reachesRoles && c.reachesRoles.length > 0 ? `Limited to: ${c.reachesRoles.join(', ')}.` : 'Every role can use it.'
}

export function secretsLine(c: TeamFileChange): string | null {
  const names = c.secretNames ?? []
  return names.length > 0 ? `Needs ${names.length === 1 ? 'this value' : 'these values'} on this computer: ${names.join(', ')}.` : null
}

/** True when any text of a change holds a hidden or control character (shown escaped, with a badge). */
export function changeHasHidden(c: TeamFileChange, has: (s: string) => boolean): boolean {
  const strings = [c.name, c.file, c.summary, c.reason, c.before, c.after, c.target, ...(c.toolsAdded ?? []), ...(c.toolsBefore ?? []), ...(c.toolsAfter ?? []), ...(c.elevatedAdded ?? []), ...(c.scripts ?? []), ...(c.secretNames ?? []), ...(c.reachesRoles ?? [])]
  return strings.some((s) => typeof s === 'string' && has(s))
}

/** Heading of the card: "Team files: 3 changes to review". */
export function cardTitle(s: TeamFilesStatus): string {
  const n = s.changes.length + (s.omittedChanges ?? 0)
  return `Team files: ${pluralChanges(Math.max(1, n))} to review`
}

// Applied-at-once notice.

export function appliedTitle(s: TeamFilesStatus): string {
  return `${pluralChanges(s.applied.length)} applied from the team files`
}

/** Summaries of what was applied, at most `max`, then "and N more". */
export function appliedSummaries(s: TeamFilesStatus, max = 4): string[] {
  const out = s.applied.slice(0, max).map((c) => c.summary)
  if (s.applied.length > max) out.push(`and ${s.applied.length - max} more.`)
  return out
}

/**
 * The words of the Undo notice. Main keeps `applied` (the last batch applied at once) and `undo` (the newest thing Undo
 * can revert) apart, and an Approve replaces `undo` but not `applied`. So the applied summaries belong to the notice only
 * when `undo.label` is the applied batch's; after an Approve it speaks for the approval, with the files `undo` names.
 */
export function undoNoticeLead(s: TeamFilesStatus): string {
  const label = s.undo?.label ?? ''
  const approving = /^Undo approving (.+)$/.exec(label)
  if (approving) return `Approved ${approving[1]}.`
  return `${appliedTitle(s)}.`
}

/** True when the undo is for the batch applied at once (so `applied` summaries describe it). */
export function undoIsApplied(s: TeamFilesStatus): boolean {
  return !!s.undo && !/^Undo approving /.test(s.undo.label)
}

export function undoRewritesLine(files: readonly string[]): string {
  return `Undo rewrites ${listFiles(files, 5)}. They then show as uncommitted.`
}

export function undoneLine(files: readonly string[]): string {
  return files.length > 0 ? `Undone. Rewrote ${listFiles(files, 5)}. They now show as uncommitted.` : 'Undone.'
}

const appliedDismissKey = (projectId: string): string => `orgai.teamFilesApplied.${projectId}`

/** The notice's identity: the time of the change it can revert. */
export function dismissedUndoAt(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): string | null {
  try {
    return storage?.getItem(appliedDismissKey(projectId)) ?? null
  } catch {
    return null
  }
}

export function rememberDismissedUndo(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, at: string): void {
  try {
    storage?.setItem(appliedDismissKey(projectId), at)
  } catch {
    /* the notice may return after a reload */
  }
}

/** Sources the "not imported" banner counts: `.orgai` agents are the team files' own when those are on. */
export function importSourcesFor<T extends { source: string }>(sources: readonly T[], filesOn: boolean): T[] {
  return filesOn ? sources.filter((s) => s.source !== 'orgai') : [...sources]
}

/** The Needs-you items for a set of statuses (pending and problem only), ordered by project name. */
export function teamAttentionItems(statuses: readonly TeamFilesStatus[]): TeamAttentionItem[] {
  const items: TeamAttentionItem[] = []
  for (const s0 of statuses) {
    // Names come from files and the folder: hidden characters are shown escaped wherever a consumer renders them.
    const s = { ...s0, projectName: showHidden(s0.projectName) }
    if (s.state === 'pending') {
      const n = s.changes.filter((c) => c.needsApproval).length + (s.omittedChanges ?? 0)
      items.push({
        key: `team:${s.projectId}`,
        projectId: s.projectId,
        projectName: s.projectName,
        state: 'pending',
        label: `Team files: ${pluralChanges(Math.max(1, n))} need${n === 1 ? 's' : ''} your approval`
      })
    } else if (s.state === 'problem') {
      const file = s.problems[0]?.file
      items.push({
        key: `team:${s.projectId}`,
        projectId: s.projectId,
        projectName: s.projectName,
        state: 'problem',
        label: file ? `Team files: ${showHidden(file)} cannot be read` : 'Team files: a file cannot be read'
      })
    }
  }
  return items.sort((a, b) => a.projectName.localeCompare(b.projectName))
}
