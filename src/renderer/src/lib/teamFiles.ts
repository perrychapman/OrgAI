import type { TeamFilesStatus } from '@shared/types'

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

/** The Needs-you items for a set of statuses (pending and problem only), ordered by project name. */
export function teamAttentionItems(statuses: readonly TeamFilesStatus[]): TeamAttentionItem[] {
  const items: TeamAttentionItem[] = []
  for (const s of statuses) {
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
        label: file ? `Team files: ${file} cannot be read` : 'Team files: a file cannot be read'
      })
    }
  }
  return items.sort((a, b) => a.projectName.localeCompare(b.projectName))
}
