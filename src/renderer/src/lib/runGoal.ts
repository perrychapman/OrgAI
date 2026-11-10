import type { Project, StaffingGoal } from '@shared/types'
import { STAFFING_GOALS } from '@shared/types'
import { staffingGoalOf, staffingModeOf } from '@shared/defaults'

export const GOAL_LABEL: Record<StaffingGoal, string> = { balanced: 'Balanced', speed: 'Speed', cost: 'Cost' }

/** One line per goal, in plain words (docs/design/orchestration-efficiency.md 4.3). */
export const GOAL_HELP: Record<StaffingGoal, string> = {
  balanced: 'Weighs speed and cost together.',
  speed: 'Treats every step as urgent and may spend more on side work.',
  cost: 'Prefers the cheaper tier everywhere and accepts a slower run.'
}

export const GOAL_OPTIONS: { value: StaffingGoal; label: string; title: string }[] = STAFFING_GOALS.map((g) => ({ value: g, label: GOAL_LABEL[g], title: GOAL_HELP[g] }))

/** The goal choice applies to team work runs of a project whose staffing is automatic; nowhere else does it do anything. */
export function showsGoalChoice(project: Pick<Project, 'staffing'>, ask: boolean): boolean {
  return !ask && staffingModeOf(project) === 'auto'
}

/** The goal shown selected: the user's pick, else the project's own goal. */
export function selectedGoal(project: Pick<Project, 'staffingGoal'>, picked: StaffingGoal | null): StaffingGoal {
  return picked ?? staffingGoalOf(project)
}

/** What a start sends: nothing unless the user chose a goal other than the project's (and the control applies). */
export function goalToSend(project: Pick<Project, 'staffing' | 'staffingGoal'>, ask: boolean, picked: StaffingGoal | null): StaffingGoal | undefined {
  if (!showsGoalChoice(project, ask) || !picked) return undefined
  return picked === staffingGoalOf(project) ? undefined : picked
}
