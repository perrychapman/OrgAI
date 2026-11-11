/**
 * The run detail tabs (Transcript or Conversation, Plan, Usage, Outputs, Knowledge, Logs): which ones a run gets and
 * which one shows. Pure: no store, no IPC. One rule for both places the tabs appear: the run side panel
 * (TranscriptPanel) and the tab strip above an assistant session's conversation (RunStageTabs).
 */
import type { ProjectKind, RunSummary } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import type { SideTab } from '../store/useAppStore'

export interface RunTabFlags {
  /** Work runs always have the Plan tab; other kinds only once a plan exists. */
  plan: boolean
  outputs: boolean
  knowledge: boolean
}

/**
 * Plan: every work run in the side panel (the orchestrator writes one), else only a run that has a plan. The stage
 * strip of an assistant session (`stage`) follows the "only with a plan" rule for every kind, a Chat included.
 */
export function showsPlanTab(i: { kind: RunSummary['kind']; hasPlan: boolean; stage?: boolean }): boolean {
  return (i.kind === 'work' && !i.stage) || i.hasPlan
}

/** What the new-reply cue watches: assistant text rows so far, and whether the session waits for the user. */
export interface ReplyMark {
  replies: number
  idle: boolean
}

/** Assistant text rows (not the user's, not harness lines) in a transcript. */
export function countReplies(entries: readonly { block: { kind: string }; source?: string }[]): number {
  let n = 0
  for (const e of entries) if (e.block.kind === 'text' && e.source !== 'harness') n++
  return n
}

/** A reply landed, or the session reached "your turn", since `prev`. Only moves forward: a shorter list is not a reply. */
export function replyArrived(prev: ReplyMark, next: ReplyMark): boolean {
  return next.replies > prev.replies || (next.idle && !prev.idle)
}

/** Outputs: work runs of stored projects, never setup runs, quick runs or the assistants. */
export function showsOutputsTab(summary: Pick<RunSummary, 'kind' | 'quick' | 'projectId'> | undefined): boolean {
  return !!summary && summary.kind === 'work' && !summary.quick && !isVirtualProjectId(summary.projectId)
}

/** Knowledge: work runs of engagements (Ask runs too), never setup runs or the assistants. */
export function showsKnowledgeTab(summary: Pick<RunSummary, 'kind' | 'quick' | 'projectId'> | undefined, projectKind: ProjectKind | undefined): boolean {
  return showsOutputsTab(summary) && projectKind === 'engagement'
}

/** The tabs in their fixed order; 'transcript' is always first (the side panel's Transcript, the stage's Conversation). */
export function runTabIds(f: RunTabFlags): SideTab[] {
  return ['transcript', ...(f.plan ? (['plan'] as const) : []), 'usage', ...(f.outputs ? (['outputs'] as const) : []), ...(f.knowledge ? (['knowledge'] as const) : []), 'logs']
}

/** The tab to show: the stored one while the run still has it, else 'transcript' (the stored value is left as it is). */
export function resolveRunTab(selected: SideTab | undefined, ids: readonly SideTab[]): SideTab {
  return selected && ids.includes(selected) ? selected : 'transcript'
}
