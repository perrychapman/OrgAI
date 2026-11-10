import { describe, expect, it } from 'vitest'
import type { RunStaffing, StaffingAssignment, StaffingSource } from '@shared/types'
import { STAFFING_SOURCES } from '@shared/types'
import { agentStaffingView, assignmentOf, latestAssignments, stepRanLabel, stepStaffLabel, staffingReason, tierEffortLabel } from './runStaffing'

const a = (over: Partial<StaffingAssignment>): StaffingAssignment => ({ roleId: 'r', model: 'claude-sonnet', source: 'role', at: 1, ...over })

describe('staffingReason', () => {
  const words: Record<StaffingSource, string> = {
    orchestrator: 'chosen by the orchestrator',
    profile: "from this project's history",
    role: "the role's setting",
    clamped: 'capped by the role',
    'plan-guard': 'moved down by the plan guard',
    escalated: 'raised after a failed attempt'
  }
  it('words every source', () => {
    for (const s of STAFFING_SOURCES) expect(staffingReason({ source: s })).toBe(words[s])
  })
  it('adds the note when there is one', () => {
    expect(staffingReason({ source: 'clamped', note: 'the role allows up to everyday' })).toBe('capped by the role: the role allows up to everyday')
    expect(staffingReason({ source: 'role', note: '   ' })).toBe("the role's setting")
    expect(staffingReason({ source: 'role', note: "The role's setting" })).toBe("The role's setting")
  })
})

describe('tierEffortLabel', () => {
  it('joins tier and effort, never the model', () => {
    expect(tierEffortLabel({ tier: 'everyday', effort: 'medium' })).toBe('everyday / medium')
    expect(tierEffortLabel({ tier: 'fast' })).toBe('fast')
    expect(tierEffortLabel({ effort: 'low' })).toBe('low')
    expect(tierEffortLabel({})).toBe('')
  })
})

describe('newest assignment per agent', () => {
  const staffing: RunStaffing = {
    goal: 'balanced',
    assignments: [
      a({ agentId: 'x', tier: 'fast', at: 1 }),
      a({ agentId: 'y', tier: 'deep', at: 2 }),
      a({ agentId: 'x', tier: 'everyday', source: 'escalated', at: 5 }),
      a({ tier: 'top', at: 9 }),
      a({ agentId: 'y', tier: 'fast', at: 2 })
    ]
  }
  it('picks the newest, the later one on a tie, and skips agentless rows', () => {
    const m = latestAssignments(staffing)
    expect(m.size).toBe(2)
    expect(m.get('x')?.tier).toBe('everyday')
    expect(m.get('y')?.tier).toBe('fast')
    expect(assignmentOf(staffing, 'x')?.source).toBe('escalated')
    expect(assignmentOf(staffing, 'root')).toBeUndefined()
    expect(assignmentOf(undefined, 'x')).toBeUndefined()
    expect(latestAssignments(undefined).size).toBe(0)
  })
})

describe('agentStaffingView', () => {
  it('shows nothing without an assignment or without tier and effort', () => {
    expect(agentStaffingView(undefined)).toBeNull()
    expect(agentStaffingView(a({}))).toBeNull()
  })
  it('keeps the model out of the label', () => {
    const v = agentStaffingView(a({ tier: 'everyday', effort: 'medium', source: 'orchestrator', model: 'claude-sonnet-x' }))
    expect(v).toEqual({ label: 'everyday / medium', reason: 'chosen by the orchestrator', model: 'claude-sonnet-x' })
    expect(v?.label).not.toContain('sonnet')
  })
})

describe('stepStaffLabel', () => {
  it('names the role and the pick', () => {
    expect(stepStaffLabel({ role: 'reviewer', tier: 'everyday', effort: 'medium' })).toBe('reviewer, everyday / medium')
    expect(stepStaffLabel({ role: 'reviewer' })).toBe('reviewer')
  })
})

describe('stepRanLabel', () => {
  // roleId is a Role.id (opaque): the line keeps the step's own role name.
  const row = (o: object) => ({ roleId: 'r_8f2c', model: 'm', source: 'orchestrator' as const, at: 1, ...o })
  const ask = { role: 'reviewer', tier: 'top' as const, effort: 'max' as const }
  it('keeps the request with no assignment', () => {
    expect(stepRanLabel(ask, undefined, 's1')).toBe('reviewer, top / max')
    expect(stepRanLabel(ask, { goal: '', assignments: [row({ stepId: 's2', tier: 'fast' })] } as never, 's1')).toBe('reviewer, top / max')
  })
  it('says what ran when it matches', () => {
    const st = { goal: '', assignments: [row({ stepId: 's1', tier: 'top', effort: 'max' })] } as never
    expect(stepRanLabel(ask, st, 's1')).toBe('reviewer, top / max')
  })
  it('adds what was asked when it differs, and uses the newest row', () => {
    const one = row({ stepId: 's1', tier: 'everyday', effort: 'high', at: 1 })
    expect(stepRanLabel(ask, { goal: '', assignments: [one] } as never, 's1')).toBe('reviewer, everyday / high (asked for top / max)')
    const two = row({ stepId: 's1', tier: 'top', effort: 'high', at: 2, source: 'escalated' })
    expect(stepRanLabel(ask, { goal: '', assignments: [two, one] } as never, 's1')).toBe('reviewer, top / high (asked for top / max)')
  })
})
