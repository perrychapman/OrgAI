import type { PlanStepStaff, RunStaffing, StaffingAssignment, StaffingSource } from '@shared/types'

/**
 * How the run view words a run's staffing (docs/design/orchestration-efficiency.md 4.7). Pure. The main process words
 * the same decisions in src/main/runtime/staffing.ts (`staffingLabel`); the renderer cannot import it, so this table
 * is the renderer's copy, written for the run view (short, sentence case).
 */

const SOURCE_REASON: Record<StaffingSource, string> = {
  orchestrator: 'chosen by the orchestrator',
  profile: "from this project's history",
  role: "the role's setting",
  clamped: 'capped by the role',
  'plan-guard': 'moved down by the plan guard',
  escalated: 'raised after a failed attempt'
}

/** The compact form: "everyday / medium", "everyday" or "medium". Never the model id. Empty when neither is known. */
export function tierEffortLabel(x: { tier?: string; effort?: string }): string {
  return [x.tier, x.effort].filter(Boolean).join(' / ')
}

/** Why an assignment came out as it did: the source in plain words, then the note when there is one. */
export function staffingReason(a: Pick<StaffingAssignment, 'source' | 'note'>): string {
  const base = SOURCE_REASON[a.source] ?? ''
  const note = a.note?.trim()
  if (!note) return base
  if (!base || note.toLowerCase() === base) return note
  return `${base}: ${note}`
}

/** The newest assignment of each agent (by `at`; of equal times the later one in the list). Assignments without an agent are skipped. */
export function latestAssignments(staffing: RunStaffing | undefined): Map<string, StaffingAssignment> {
  const out = new Map<string, StaffingAssignment>()
  for (const a of staffing?.assignments ?? []) {
    if (!a.agentId) continue
    const prev = out.get(a.agentId)
    if (!prev || a.at >= prev.at) out.set(a.agentId, a)
  }
  return out
}

/** The newest assignment of one agent, or undefined (the orchestrator itself, older runs). */
export function assignmentOf(staffing: RunStaffing | undefined, agentId: string): StaffingAssignment | undefined {
  let best: StaffingAssignment | undefined
  for (const a of staffing?.assignments ?? []) if (a.agentId === agentId && (!best || a.at >= best.at)) best = a
  return best
}

export interface AgentStaffingView {
  /** "everyday / medium". Empty when the assignment has neither a tier nor an effort. */
  label: string
  /** "chosen by the orchestrator", with the note when there is one. */
  reason: string
  /** The model actually used: expanded detail only. */
  model: string
}

/** What an agent row shows, or null when there is nothing to show (no assignment, or no tier or effort in it). */
export function agentStaffingView(a: StaffingAssignment | undefined): AgentStaffingView | null {
  if (!a) return null
  const label = tierEffortLabel(a)
  if (!label) return null
  return { label, reason: staffingReason(a), model: a.model }
}

/** A plan step's pick: "reviewer, everyday / medium" or just the role. */
export function stepStaffLabel(staff: PlanStepStaff): string {
  const pick = tierEffortLabel(staff)
  return pick ? `${staff.role}, ${pick}` : staff.role
}

/** The newest assignment bound to a plan step (a retry or escalation adds rows; the last one is what ran). */
export function assignmentOfStep(staffing: RunStaffing | undefined, stepId: string): StaffingAssignment | undefined {
  let best: StaffingAssignment | undefined
  for (const a of staffing?.assignments ?? []) if (a.stepId === stepId && (!best || a.at >= best.at)) best = a
  return best
}

/**
 * The plan step's staffing line. No assignment yet: the request ("reviewer, top / max"). Once a report started for the
 * step: what ran ("reviewer, everyday / high"), plus "(asked for top / max)" when the tier or effort differs from the request.
 */
export function stepRanLabel(staff: PlanStepStaff, staffing: RunStaffing | undefined, stepId: string): string {
  const ran = assignmentOfStep(staffing, stepId)
  if (!ran) return stepStaffLabel(staff)
  // The row's roleId is a Role.id, not a name a reader knows: keep the name the orchestrator wrote on the step.
  const pick = tierEffortLabel(ran)
  const head = pick ? `${staff.role}, ${pick}` : staff.role
  const differs = (!!staff.tier && staff.tier !== ran.tier) || (!!staff.effort && staff.effort !== ran.effort)
  const asked = tierEffortLabel(staff)
  return differs && asked ? `${head} (asked for ${asked})` : head
}
