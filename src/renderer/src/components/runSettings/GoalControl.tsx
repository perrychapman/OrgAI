import type { ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { StaffingGoal } from '@shared/types'
import { useTriggerAttrs } from './triggerAttrs'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { SegmentedControl } from '../ui/SegmentedControl'
import { GOAL_HELP, GOAL_LABEL, GOAL_OPTIONS } from '../../lib/runGoal'
import '../../styles/run-settings.css'

/** Live run: the goal the run started with, as text. */
export function GoalReadOnly({ goal }: { goal: StaffingGoal }): ReactElement {
  return (
    <span className="run-chip run-chip--static" data-testid="run-goal-readonly" title={GOAL_HELP[goal]}>
      <span className="run-chip__label">Goal:</span>
      <span className="run-chip__value">{GOAL_LABEL[goal]}</span>
      <span className="sr-only">. Set when the run started; it cannot change during a run.</span>
    </span>
  )
}

/**
 * The New run page's goal chip: what the lead should optimise staffing for. The wrapper keeps `new-run-goal` and the help
 * line `new-run-goal-help` (existing e2e). `isDefault` is true while the shown goal is the project's own.
 */
export function GoalControl({ goal, isDefault, onChange }: { goal: StaffingGoal; isDefault: boolean; onChange: (next: StaffingGoal) => void }): ReactElement {
  const attrs = useTriggerAttrs({ 'data-default': isDefault ? 'true' : 'false' })
  return (
    <span ref={attrs} className="run-setting run-setting--goal" data-testid="new-run-goal">
      <Popover
        placement="bottom-start"
        label="Goal for this run"
        triggerTestId="run-goal-change"
        testId="run-goal-picker"
        className="run-goal-picker"
        triggerClassName="run-chip"
        triggerTitle={`${GOAL_HELP[goal]}${isDefault ? ' This is the project default.' : ''}`}
        trigger={
          <>
            <span className="run-chip__label">Goal:</span>
            <span className="run-chip__value" data-testid="run-goal-current">
              {GOAL_LABEL[goal]}
            </span>
            <span className="run-chip__state">{isDefault ? 'Default' : 'Changed'}</span>
            <Icon icon={ChevronDown} size="xs" />
          </>
        }
      >
        <div className="run-popover-stack">
          <span className="run-popover-legend" aria-hidden="true">
            Optimise for
          </span>
          <SegmentedControl<StaffingGoal> label="Optimise for" value={goal} options={GOAL_OPTIONS} onChange={onChange} />
          <p className="run-popover-help" data-testid="new-run-goal-help">
            {GOAL_HELP[goal]}
            {isDefault ? ' This is the project default.' : ''}
          </p>
        </div>
      </Popover>
    </span>
  )
}
