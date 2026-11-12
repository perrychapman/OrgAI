import { describe, expect, it } from 'vitest'
import { GOAL_LABEL, GOAL_OPTIONS, goalToSend, selectedGoal, showsGoalChoice } from './runGoal'

describe('run goal choice', () => {
  it('names the goals by what the run is optimised for', () => {
    expect(GOAL_LABEL).toEqual({ balanced: 'Balanced', speed: 'Faster', cost: 'Cheaper' })
    expect(GOAL_OPTIONS.map((o) => o.label)).toEqual(['Balanced', 'Faster', 'Cheaper'])
  })
  it('shows only for team runs of an automatic-staffing project', () => {
    expect(showsGoalChoice({}, false)).toBe(true)
    expect(showsGoalChoice({ staffing: 'auto' }, false)).toBe(true)
    expect(showsGoalChoice({ staffing: 'fixed' }, false)).toBe(false)
    expect(showsGoalChoice({}, true)).toBe(false)
  })
  it('defaults to the project goal', () => {
    expect(selectedGoal({}, null)).toBe('balanced')
    expect(selectedGoal({ staffingGoal: 'cost' }, null)).toBe('cost')
    expect(selectedGoal({ staffingGoal: 'cost' }, 'speed')).toBe('speed')
  })
  it('sends nothing at the default, the pick otherwise', () => {
    expect(goalToSend({}, false, null)).toBeUndefined()
    expect(goalToSend({}, false, 'balanced')).toBeUndefined()
    expect(goalToSend({ staffingGoal: 'cost' }, false, 'cost')).toBeUndefined()
    expect(goalToSend({ staffingGoal: 'cost' }, false, 'speed')).toBe('speed')
    expect(goalToSend({}, false, 'speed')).toBe('speed')
  })
  it('sends nothing when the control is hidden', () => {
    expect(goalToSend({ staffing: 'fixed' }, false, 'speed')).toBeUndefined()
    expect(goalToSend({}, true, 'speed')).toBeUndefined()
  })
})
