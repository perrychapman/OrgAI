/**
 * The run detail tabs (Transcript or Conversation, Plan, Usage, Outputs, Knowledge, Logs): which ones a run gets and
 * which one shows. Pure: no store, no IPC. One rule for both places the tabs appear: the run side panel
 * (TranscriptPanel, only while the stage is the org chart) and the tab strip above the conversation (RunStageTabs, the
 * conversation layout of every run kind).
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
 * strip (`stage`) shows it early only for team work runs (work, not Chat/quick, not single-agent: the runs the plan
 * guard applies to), so the "No plan yet" note signals a plan is coming; every other kind needs a plan.
 */
export function showsPlanTab(i: {
  kind: RunSummary['kind']
  hasPlan: boolean
  stage?: boolean
  quick?: RunSummary['quick']
  team?: RunSummary['team']
}): boolean {
  if (i.hasPlan) return true
  if (i.kind !== 'work') return false
  if (!i.stage) return true
  return !i.quick && i.team !== 'single'
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
