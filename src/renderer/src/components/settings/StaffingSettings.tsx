import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project, ReviewPolicy, StaffingGoal, StaffingMode } from '@shared/types'
import {
  PROJECT_GOAL_OPTIONS,
  PROJECT_REVIEW_OPTIONS,
  PROJECT_STAFFING_OPTIONS,
  projectGoalText,
  projectReviewText,
  projectStaffingPatch,
  projectStaffingText,
  projectStaffingView
} from '../../lib/roleStaffing'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { SettingsCard } from './SettingsCard'
import { SettingsGroup } from './SettingsSection'

/**
 * Run staffing: whether the harness picks each report's tier and effort, what it optimizes for and when it asks for a
 * review. A default shows as selected while the field is unset; choosing the default clears the field. A group of the
 * Limits pane's Advanced settings: the pane keeps at most two tab stops at rest (e2e/permissions.mjs).
 */
export function StaffingSettings({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const view = projectStaffingView(project)
  const row = (name: string): string => `${uid}-${name}-row`
  return (
    <SettingsGroup id="settings-section-staffing" title="Run staffing">
      <SettingsCard>
        <SettingRow
          id={row('staffing')}
          title="Staffing"
          description={projectStaffingText(view.staffing)}
          width="select"
          control={
            <div data-testid="project-staffing">
              <SegmentedControl<StaffingMode> label="Staffing" value={view.staffing} options={PROJECT_STAFFING_OPTIONS} onChange={(v) => patch(projectStaffingPatch('staffing', v))} />
            </div>
          }
        />
        <SettingRow
          id={row('goal')}
          title="Goal"
          description={projectGoalText(view.goal)}
          width="select"
          control={
            <div data-testid="project-staffing-goal">
              <SegmentedControl<StaffingGoal> label="Goal" value={view.goal} options={PROJECT_GOAL_OPTIONS} onChange={(v) => patch(projectStaffingPatch('staffingGoal', v))} />
            </div>
          }
        />
        <SettingRow
          id={row('review')}
          title="Review"
          description={projectReviewText(view.review)}
          width="select"
          control={
            <div data-testid="project-review-policy" aria-describedby={settingDescId(row('review'))}>
              <SegmentedControl<ReviewPolicy> label="Review" value={view.review} options={PROJECT_REVIEW_OPTIONS} onChange={(v) => patch(projectStaffingPatch('reviewPolicy', v))} />
            </div>
          }
        />
      </SettingsCard>
    </SettingsGroup>
  )
}
