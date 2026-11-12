/**
 * Words for run staffing (orchestration-efficiency 4.7), shared by exec and the TUI. Pure. Every string that comes
 * from a run (role id, model, note) goes through safeLine (sanitizeTty) before it is returned.
 */
import type { AgentInstance, ConnectionId, PlanStepStaff, RunStaffing, RunSummary, StaffingAssignment, StaffingSource } from '../shared/types'
import { safeLine } from './output'

const REASON: Record<StaffingSource, string> = {
  orchestrator: 'chosen by the orchestrator',
  role: "the role's setting",
  profile: "from this project's history",
  clamped: 'capped by the role',
  'plan-guard': 'moved down by the plan guard',
  escalated: 'raised after a failed attempt'
}

/**
 * "everyday (claude-sonnet-5-5) / medium": the tier with the concrete model id when both are known and differ; the
 * model id alone when the assignment has no tier; just the tier when the model is unknown; " / effort" when set.
 * `modelMax` (columns, default unlimited) cuts the model id first with `ell`; below 4 columns the id is left out.
 */
export function staffingLabel(a: Pick<StaffingAssignment, 'tier' | 'model' | 'effort'>, modelMax = Infinity, ell = '…'): string {
  const tier = a.tier ? safeLine(a.tier) : ''
  const model = a.model ? safeLine(a.model) : ''
  const effort = a.effort ? safeLine(a.effort) : ''
  let head = tier
  if (model && model !== tier) {
    const id = cutModel(model, modelMax, ell)
    head = tier ? (id ? `${tier} (${id})` : tier) : id
  }
  return head && effort ? `${head} / ${effort}` : head || effort
}

/** A model id cut to `max` characters with `ell` at the end; '' when fewer than 4 characters would be left. */
export function cutModel(model: string, max: number, ell = '…'): string {
  const cs = [...model]
  if (cs.length <= max) return model
  const room = max - [...ell].length
  return room >= 4 ? `${cs.slice(0, room).join('')}${ell}` : ''
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

/** The model an agent runs on now: AgentInstance.model, else the last model its usage reports; '' when unknown. Sanitized. */
export function liveModelOf(a: Pick<AgentInstance, 'model' | 'usage'> | undefined): string {
  const own = a?.model ? safeLine(a.model) : ''
  if (own) return own
  const models = a?.usage?.models
  return Array.isArray(models) && models.length > 0 ? safeLine(models[models.length - 1]?.model ?? '') : ''
}

/** Every model an agent's usage reports (AgentUsage.models), in order, plus AgentInstance.model when not among them. Sanitized, unique. */
export function modelsUsedBy(a: Pick<AgentInstance, 'model' | 'usage'>): string[] {
  const out: string[] = []
  const add = (m: string | undefined): void => {
    const id = m ? safeLine(m) : ''
    if (id && !out.includes(id)) out.push(id)
  }
  for (const m of Array.isArray(a.usage?.models) ? a.usage!.models : []) add(m?.model)
  add(a.model)
  return out
}

/**
 * What an agent row says about its model: the staffing label when the agent has an assignment ("everyday
 * (claude-sonnet-5-5) / medium"), else its live model id; '' when neither is known. `modelMax` cuts the id first.
 */
export function agentModelText(a: Pick<AgentInstance, 'model' | 'usage'> | undefined, pick: StaffingAssignment | undefined, modelMax = Infinity, ell = '…'): string {
  if (pick) return staffingLabel(pick, modelMax, ell)
  return cutModel(liveModelOf(a), modelMax, ell)
}

/** The root's live model: the run's model selection (run.model / RunSummary.modelSelection), else the root agent's model. */
export function rootModelOf(summary: Pick<RunSummary, 'modelSelection'>, agents: Record<string, Pick<AgentInstance, 'parentId' | 'model' | 'usage'>> | undefined): string {
  const chosen = summary.modelSelection?.model ? safeLine(summary.modelSelection.model) : ''
  if (chosen) return chosen
  const root = Object.values(agents ?? {}).find((a) => a.parentId === null)
  return liveModelOf(root)
}

/** The connections a run's agents ran on (AgentInstance.connection, else the run's), when there is more than one; else []. */
export function runConnections(summary: Pick<RunSummary, 'connection'>, agents: Record<string, Pick<AgentInstance, 'connection'>> | undefined): ConnectionId[] {
  const set = new Set<ConnectionId>()
  for (const a of Object.values(agents ?? {})) {
    const on = a.connection ?? summary.connection
    if (on) set.add(on)
  }
  return set.size > 1 ? [...set] : []
}
