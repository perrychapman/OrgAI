/**
 * The terminal UI's read-only /approvals (cli-parity 3.4 as built): what waits for a person, with the gate's summary of
 * each change ("May spend more" first), and for undo what would come back. Nothing here decides anything: approving is
 * done in the OrgAI desktop app for now, because a terminal cannot yet prove that a person, not an agent, is answering
 * (docs/agent-notes/cli-host.md "Approvals at the terminal"). Reads only: teamFiles:listAttention and
 * projects:folderConfig (read scope). Pure: no ink, no host.
 */
import type { FolderConfigReview, TeamFilesStatus } from '../../shared/types'
import { APPROVE_WHERE, folderTrustLines, pendingChanges, teamFilesDetailLines, visibleLine } from '../approvalText'

/** One thing that waits: a project's team files, or this project's folder config. */
export interface ApprovalItem {
  kind: 'teamFiles' | 'folderTrust'
  projectId: string
  projectName: string
  label: string
  teamFiles?: TeamFilesStatus
  folderConfig?: FolderConfigReview
}

/** The session reads /approvals uses (TuiSessionApi.approvals). */
export interface ApprovalsApi {
  list(): Promise<ApprovalItem[]>
  /** The notice on open (waitingNotice), undefined when nothing waits. */
  waiting(): Promise<string | undefined>
}

/** What waits: pending team files of every project, then this code project's folder config when it is not allowed. */
export function approvalItems(attention: readonly TeamFilesStatus[], current?: { id: string; name: string; folderConfig?: FolderConfigReview }): ApprovalItem[] {
  const out: ApprovalItem[] = []
  for (const s of attention) {
    if (s.state !== 'pending' && s.state !== 'problem') continue
    const n = pendingChanges(s).length
    const what = s.state === 'problem' ? 'a file has a problem' : `${n} change${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for approval`
    out.push({ kind: 'teamFiles', projectId: s.projectId, projectName: s.projectName, label: `Team files of ${visibleLine(s.projectName)}: ${what}`, teamFiles: s })
  }
  const fc = current?.folderConfig
  if (current && fc && (fc.state === 'untrusted' || fc.state === 'changed')) {
    const what = fc.state === 'changed' ? 'changed since it was allowed' : 'not allowed'
    out.push({ kind: 'folderTrust', projectId: current.id, projectName: current.name, label: `Folder config of ${visibleLine(current.name)}: ${what}`, folderConfig: fc })
  }
  return out
}

/** The notice the terminal UI shows on open while something waits; undefined when nothing does. */
export function waitingNotice(items: readonly ApprovalItem[]): string | undefined {
  const team = items.filter((i) => i.kind === 'teamFiles').length
  const trust = items.some((i) => i.kind === 'folderTrust')
  const parts = [...(team ? [`team files of ${team} project${team === 1 ? '' : 's'}`] : []), ...(trust ? ["this folder's own config"] : [])]
  return parts.length ? `Waiting for approval: ${parts.join(' and ')}. Type /approvals to read them.` : undefined
}

/** The /approvals text: every item in full, then where approving happens and why. */
export function approvalsText(items: readonly ApprovalItem[]): string {
  const out: string[] = []
  for (const item of items) {
    if (out.length) out.push('', '---', '')
    out.push(item.label, '')
    if (item.teamFiles) out.push(...teamFilesDetailLines(item.teamFiles))
    else if (item.folderConfig) out.push(...folderTrustLines(item.folderConfig, item.projectName))
  }
  out.push('', APPROVE_WHERE)
  return out.join('\n')
}
