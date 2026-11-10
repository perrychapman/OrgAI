/**
 * Words for run staffing (orchestration-efficiency 4.7), shared by exec and the TUI. Pure. Every string that comes
 * from a run (role id, model, note) goes through safeLine (sanitizeTty) before it is returned.
 */
import type { PlanStepStaff, RunStaffing, StaffingAssignment, StaffingSource } from '../shared/types'
import { safeLine } from './output'

const REASON: Record<StaffingSource, string> = {
  orchestrator: 'chosen by the orchestrator',
  role: "the role's setting",
  profile: "from this project's history",
  clamped: 'capped by the role',
  'plan-guard': 'moved down by the plan guard',
  escalated: 'raised after a failed attempt'
}

/** "everyday / medium"; the model id when the assignment has no tier; just the tier when there is no effort. */
export function staffingLabel(a: Pick<StaffingAssignment, 'tier' | 'model' | 'effort'>): string {
  const head = safeLine(a.tier ?? a.model)
  const effort = a.effort ? safeLine(a.effort) : ''
  return effort ? `${head} / ${effort}` : head
}

/** Why, in plain words from `source` and `note` ("capped by the role: only fast is allowed"). */
export function staffingReason(a: Pick<StaffingAssignment, 'source' | 'note'>): string {
  const base = REASON[a.source] ?? safeLine(a.source)
  const note = a.note ? safeLine(a.note) : ''
  return note && note.toLowerCase() !== base.toLowerCase() ? `${base}: ${note}` : base
}

/** The newest assignment (latest `at`, later list position on a tie) of each agent that has one. */
export function latestByAgent(staffing: Pick<RunStaffing, 'assignments'> | undefined): Map<string, StaffingAssignment> {
  const out = new Map<string, StaffingAssignment>()
  for (const a of staffing?.assignments ?? []) {
    if (!a.agentId) continue
    const prev = out.get(a.agentId)
    if (!prev || a.at >= prev.at) out.set(a.agentId, a)
  }
  return out
}

/** The exec line for one staffed report: "engineer-1 on everyday / medium (chosen by the orchestrator)". */
export function staffingLine(name: string, a: StaffingAssignment): string {
  return `${safeLine(name)} on ${staffingLabel(a)} (${staffingReason(a)})`
}

/** A plan step's pick: "engineer (everyday / medium)". */
export function stepStaffText(staff: PlanStepStaff): string {
  const pick = staffingLabel({ tier: staff.tier, model: '', effort: staff.effort })
  return pick ? `${safeLine(staff.role)} (${pick})` : safeLine(staff.role)
}

/** The newest assignment bound to a plan step (a retry or escalation adds rows; the last one is what ran). */
export function latestForStep(staffing: Pick<RunStaffing, 'assignments'> | undefined, stepId: string): StaffingAssignment | undefined {
  let best: StaffingAssignment | undefined
  for (const a of staffing?.assignments ?? []) if (a.stepId === stepId && (!best || a.at >= best.at)) best = a
  return best
}

/** A plan step's pick once a report ran for it: "reviewer (everyday / high, asked top / max)"; the plain request without a row. */
export function stepRanText(staff: PlanStepStaff, ran: StaffingAssignment | undefined): string {
  if (!ran) return stepStaffText(staff)
  const pick = staffingLabel({ tier: ran.tier, model: '', effort: ran.effort })
  const differs = (!!staff.tier && staff.tier !== ran.tier) || (!!staff.effort && staff.effort !== ran.effort)
  const asked = staffingLabel({ tier: staff.tier, model: '', effort: staff.effort })
  const inner = pick ? (differs && asked ? `${pick}, asked ${asked}` : pick) : ''
  // The row's roleId is a Role.id, not a name a reader knows: keep the name the orchestrator wrote on the step.
  const role = safeLine(staff.role)
  return inner ? `${role} (${inner})` : role
}
