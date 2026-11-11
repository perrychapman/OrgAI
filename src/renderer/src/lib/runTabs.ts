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

/** Plan: every work run (the orchestrator writes one), else only a run that has a plan. */
export function showsPlanTab(i: { kind: RunSummary['kind']; hasPlan: boolean }): boolean {
  return i.kind === 'work' || i.hasPlan
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
