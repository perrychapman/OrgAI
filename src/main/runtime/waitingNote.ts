import type { RunPlan, StaffingAssignment } from '@shared/types'
import { readySteps } from '@shared/planGraph'

/**
 * One report and a waiting lead (docs/design/split-execution.md 3.6). Pure: the adapter gathers the facts at the end of
 * a successful spawn and appends the line to the spawn tool's result (Codex spawn_report, the mock). Never a refusal.
 * Claude delivers it as the Agent call's PostToolUse additional context, only on a background spawn's launch result
 * (a foreground spawn's PostToolUse fires when the report is back, when waiting is over; claude.ts waitingNoteFor).
 */

export const WAITING_NOTE = 'You are waiting on one report. Take a ready step yourself, or hand out the rest; waiting is slower than doing this alone.'

export interface WaitingNoteInput {
  /** The spawning agent is the run's root. */
  callerIsRoot: boolean
  /** The root's own reports still working after this spawn (the new one included). */
  callerRunningReports: number
  /** Role id of the report just spawned. */
  spawnedRoleId: string
  /** The root's required reports (delegation.ts obligationsFor(...)[root.id]). */
  requiredRoleIds: readonly string[]
  /** RuntimeContext.getPlan() now. */
  plan: RunPlan | null | undefined
  /** RunStaffing.assignments now (RuntimeContext.getStaffing). */
  assignments: readonly StaffingAssignment[]
  /** Agent ids of every report still working in the run (any parent). */
  runningAgentIds: ReadonlySet<string>
  /** The note was already given in this run. */
  shown: boolean
  /** A setup-like, quick (Chat) or single (Ask) run: never. */
  excludedRun: boolean
}

/**
 * WAITING_NOTE when this spawn leaves the root waiting on exactly one report: the root spawned it, it is the root's only
 * running report, its role is not one the root must delegate to, the plan is active and has a ready step (something the
 * root could take or hand out; with none, waiting is all there is), and no step is in_progress without a running report
 * bound to it (nothing the root itself is doing). At most once per run. Otherwise undefined.
 */
export function waitingNote(i: WaitingNoteInput): string | undefined {
  if (i.shown || i.excludedRun || !i.callerIsRoot || i.callerRunningReports !== 1) return undefined
  if (i.requiredRoleIds.includes(i.spawnedRoleId)) return undefined
  const plan = i.plan
  if (!plan || plan.status !== 'active' || !plan.steps.length) return undefined
  const bound = new Set(i.assignments.flatMap((a) => (a.stepId && a.agentId && i.runningAgentIds.has(a.agentId) ? [a.stepId] : [])))
  if (plan.steps.some((s) => s.status === 'in_progress' && !bound.has(s.id))) return undefined
  if (!readySteps(plan).length) return undefined
  return WAITING_NOTE
}

/** Whether a run never gets the note: setup-like, a Chat (quick) run or a single (Ask) run. */
export function waitingNoteExcluded(run: { kind?: string; quick?: unknown; team?: string }, setupLike: boolean): boolean {
  return setupLike || !!run.quick || (run.kind === 'work' && run.team === 'single')
}
